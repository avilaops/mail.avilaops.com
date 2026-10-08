import { createServer as criarServidorTcp, type Server, type Socket } from "node:net";
import { createServer as criarServidorTls, TLSSocket, type TlsOptions } from "node:tls";
import { simpleParser } from "mailparser";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { readRaw } from "../lib/storage.js";
import { autenticarCaixa } from "../services/mailboxAuth.js";
import { moverParaPasta } from "../services/uid.js";
import { ouvirEntregas } from "./eventos.js";

const log = createLogger("imap");

/**
 * Servidor IMAP4rev1 (RFC 3501).
 *
 * E o que Outlook, Apple Mail, Thunderbird e os apps nativos de celular falam.
 * Diferente do POP3, ele sincroniza pastas e estado de leitura entre
 * dispositivos: marcar como lida no celular reflete no desktop.
 *
 * O subconjunto implementado e o que um cliente real precisa para funcionar,
 * nao o RFC inteiro. Comandos ausentes respondem BAD em vez de silenciar, para
 * que a falha apareca no log do cliente em vez de virar comportamento estranho.
 */

type Estado = "nao-autenticado" | "autenticado" | "selecionado";

interface PastaSelecionada {
  id: string;
  nome: string;
  kind: string;
  uidValidity: number;
  uidNext: number;
  somenteLeitura: boolean;
  /** Sequencia da sessao: posicao (1-based) → mensagem. Congela no SELECT. */
  sequencia: Array<{ id: string; uid: number }>;
}

interface Sessao {
  estado: Estado;
  caixaId: string | null;
  endereco: string | null;
  pasta: PastaSelecionada | null;
  seguro: boolean;
  ip: string;
  emIdle: string | null;
  /**
   * Preenchido pelo leitor: espera a proxima linha crua do cliente. Usado pelo
   * AUTHENTICATE, que pede a credencial num segundo tempo, depois do "+".
   */
  aguardarLinha: (() => Promise<string | null>) | null;
}

/** Literal grande so depois de autenticar — antes disso, 8 KB e de sobra. */
const LIMITE_LITERAL_ANONIMO = 8 * 1024;
/** Teto de uma mensagem enviada por APPEND. Acima disso a conexao cai. */
const LIMITE_LITERAL = 40 * 1024 * 1024;

async function pedirContinuacao(socket: Socket, sessao: Sessao): Promise<string | null> {
  if (!sessao.aguardarLinha) return null;
  socket.write("+ \r\n");
  return sessao.aguardarLinha();
}

// ---------------------------------------------------------------------------
// Serializacao
// ---------------------------------------------------------------------------

/**
 * String no formato do IMAP.
 *
 * Texto com aspas, barra invertida ou quebra de linha vira "literal"
 * ({tamanho} seguido do conteudo cru) porque o formato entre aspas nao tem
 * como escapar quebra de linha — e assunto de e-mail tem de tudo.
 */
function comoString(valor: string | null): string {
  if (valor === null) return "NIL";
  if (/[\r\n]/.test(valor)) return `{${Buffer.byteLength(valor)}}\r\n${valor}`;
  return `"${valor.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function comoLista(itens: string[]): string {
  return `(${itens.join(" ")})`;
}

/** Endereco no formato ENVELOPE: (nome adl caixa dominio). */
function enderecoImap(item: { address?: string; name?: string } | undefined): string {
  if (!item?.address) return "NIL";
  const [caixa = "", dominio = ""] = item.address.split("@");
  return `(${comoString(item.name || null)} NIL ${comoString(caixa)} ${comoString(dominio)})`;
}

function listaEnderecos(valor: unknown): string {
  const itens = Array.isArray(valor) ? (valor as Array<{ address?: string; name?: string }>) : [];
  const validos = itens.filter((i) => i?.address);
  return validos.length === 0 ? "NIL" : `(${validos.map(enderecoImap).join("")})`;
}

/** Data no formato do IMAP: "14-Aug-2026 05:30:00 +0000". */
const MESES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dataImap(data: Date): string {
  const dia = String(data.getUTCDate()).padStart(2, "0");
  const hora = data.toISOString().slice(11, 19);
  return `${dia}-${MESES[data.getUTCMonth()]}-${data.getUTCFullYear()} ${hora} +0000`;
}

function flags(m: {
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  deleted?: boolean;
}): string {
  const lista: string[] = [];
  if (m.seen) lista.push("\\Seen");
  if (m.flagged) lista.push("\\Flagged");
  if (m.answered) lista.push("\\Answered");
  if (m.draft) lista.push("\\Draft");
  // Sem devolver \Deleted, o cliente marca, nao ve a marca voltar e assume que
  // o servidor ignorou — alguns remarcam em laco.
  if (m.deleted) lista.push("\\Deleted");
  return comoLista(lista);
}

/** Nome especial da pasta, para o cliente saber qual e a Lixeira e os Enviados. */
const ATRIBUTO_ESPECIAL: Record<string, string> = {
  inbox: "",
  sent: "\\Sent",
  drafts: "\\Drafts",
  trash: "\\Trash",
  spam: "\\Junk",
  archive: "\\Archive",
};

/** A Caixa de Entrada se chama INBOX no protocolo, sempre em maiusculas. */
function nomeImap(pasta: { kind: string; name: string }): string {
  return pasta.kind === "inbox" ? "INBOX" : pasta.name;
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

async function acharPasta(caixaId: string, nome: string) {
  const alvo = nome.replace(/^"|"$/g, "");

  if (alvo.toUpperCase() === "INBOX") {
    return prisma.mailFolder.findFirst({ where: { mailboxId: caixaId, kind: "inbox" } });
  }
  return prisma.mailFolder.findFirst({ where: { mailboxId: caixaId, name: alvo } });
}

/**
 * Congela a sequencia da pasta no SELECT.
 *
 * O IMAP numera as mensagens de 1 a N dentro da sessao, e essa numeracao so
 * pode mudar por EXPUNGE anunciado. Reconsultar o banco a cada FETCH deixaria
 * a numeracao dancando embaixo do cliente.
 */
async function carregarSequencia(caixaId: string, folderId: string) {
  return prisma.message.findMany({
    where: { mailboxId: caixaId, folderId },
    orderBy: { uid: "asc" },
    select: { id: true, uid: true },
  });
}

/** Interpreta "1:5", "3", "1:*", "2,4:6" — em sequencia ou em UID. */
function expandirIntervalo(spec: string, sessao: Sessao, porUid: boolean): string[] {
  const pasta = sessao.pasta;
  if (!pasta) return [];

  const maximo = porUid
    ? (pasta.sequencia[pasta.sequencia.length - 1]?.uid ?? 0)
    : pasta.sequencia.length;

  const escolhidos = new Set<string>();

  for (const parte of spec.split(",")) {
    const [deBruto = "", ateBruto] = parte.split(":");
    const de = deBruto === "*" ? maximo : Number.parseInt(deBruto, 10);
    const ate = ateBruto === undefined ? de : ateBruto === "*" ? maximo : Number.parseInt(ateBruto, 10);
    if (!Number.isFinite(de)) continue;

    const menor = Math.min(de, ate);
    const maior = Math.max(de, ate);

    pasta.sequencia.forEach((item, indice) => {
      const numero = porUid ? item.uid : indice + 1;
      if (numero >= menor && numero <= maior) escolhidos.add(item.id);
    });
  }

  return [...escolhidos];
}

// ---------------------------------------------------------------------------
// FETCH
// ---------------------------------------------------------------------------

interface LinhaFetch {
  id: string;
  uid: number;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  draft: boolean;
  sizeBytes: number;
  receivedAt: Date;
  subject: string | null;
  fromAddress: string;
  fromName: string | null;
  toAddresses: unknown;
  ccAddresses: unknown;
  replyTo: unknown;
  rfcMessageId: string | null;
  inReplyTo: string | null;
  storageKey: string;
  deleted?: boolean;
  /** Usados para montar o BODYSTRUCTURE sem reparsear o .eml. */
  bodyText?: string | null;
  bodyHtml?: string | null;
}

function envelope(m: LinhaFetch): string {
  const de = `((${comoString(m.fromName)} NIL ${comoString(m.fromAddress.split("@")[0] ?? "")} ${comoString(
    m.fromAddress.split("@")[1] ?? "",
  )}))`;

  return comoLista([
    comoString(dataImap(m.receivedAt)),
    comoString(m.subject),
    de,
    de,
    listaEnderecos(m.replyTo) === "NIL" ? de : listaEnderecos(m.replyTo),
    listaEnderecos(m.toAddresses),
    listaEnderecos(m.ccAddresses),
    "NIL",
    comoString(m.inReplyTo),
    comoString(m.rfcMessageId),
  ]);
}

/**
 * Responde aos itens pedidos no FETCH. Devolve a linha inteira, em bytes.
 *
 * Bytes, e nao string, por causa dos literais: o conteudo de BODY[...] vai no
 * fio exatamente com o tamanho anunciado entre chaves. Montar tudo como
 * string e escrever no socket (que codifica em UTF-8) inflava cada byte acima
 * de 127 para dois — o .eml em quoted-printable raramente tem algum, mas o
 * texto puro de BODY[1] tem acento em toda frase, e o cliente ficava
 * esperando bytes que nunca chegavam (11/09/2026).
 */
async function montarFetch(m: LinhaFetch, itens: string, porUid: boolean, posicao: number): Promise<Buffer> {
  const pedido = itens.toUpperCase();
  const partes: Array<string | Buffer> = [];

  // UID FETCH precisa devolver UID mesmo sem o cliente pedir: e como ele
  // relaciona a resposta com o que pediu.
  if (porUid || pedido.includes("UID")) partes.push(`UID ${m.uid}`);
  if (pedido.includes("FLAGS")) partes.push(`FLAGS ${flags(m)}`);
  if (pedido.includes("INTERNALDATE")) partes.push(`INTERNALDATE ${comoString(dataImap(m.receivedAt))}`);
  if (pedido.includes("RFC822.SIZE")) partes.push(`RFC822.SIZE ${m.sizeBytes}`);
  if (pedido.includes("ENVELOPE")) partes.push(`ENVELOPE ${envelope(m)}`);

  if (pedido.includes("BODYSTRUCTURE") || /\bBODY\b(?!\.PEEK)(?!\s*\[)/.test(pedido)) {
    partes.push(`BODYSTRUCTURE ${await estruturaDoCorpo(m)}`);
  }

  // Todas as secoes BODY[...] do pedido, nao so a primeira. iPhone Mail e o
  // imapflow pedem varias na mesma linha (BODY.PEEK[2.MIME] BODY.PEEK[2]) e,
  // ate 11/09/2026, so a primeira voltava: o cliente ficava sem o conteudo e
  // desistia da parte em silencio.
  const pedidosDeBody = [...pedido.matchAll(/BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)(?:\.(\d+))?>)?/g)];
  if (pedidosDeBody.length > 0) {
    const bruto = await readRaw(m.storageKey);

    for (const pedidoDeBody of pedidosDeBody) {
      const secao = pedidoDeBody[1] ?? "";

      // Recorte em BYTES, nao em caracteres: cortar a string em UTF-16 parte
      // caractere acentuado ao meio e o tamanho anunciado deixa de bater com o
      // que sai no fio — o cliente trava esperando bytes que nunca chegam.
      let recorte = await recortarSecao(m, bruto, secao);

      // Parte que nao existe e NIL, nao a mensagem inteira. Antes, qualquer
      // secao que nao fosse HEADER ou TEXT (BODY[1], BODY[2], BODY[1.MIME])
      // devolvia o .eml completo: iPhone e o app do Gmail, que leem pelo
      // BODYSTRUCTURE e pedem a parte por numero, mostravam os cabecalhos
      // dentro do corpo da mensagem (11/09/2026).
      if (recorte === null) {
        partes.push(`BODY[${secao}] NIL`);
        continue;
      }

      /**
       * Download parcial: BODY[]<inicio.tamanho>.
       *
       * E como todo cliente de celular sincroniza caixa grande — ele puxa os
       * primeiros 64 KB para exibir a previa e so baixa o resto se a pessoa
       * abrir. Ignorar o recorte e mandar a mensagem inteira transforma uma
       * sincronia de 2 MB em 200 MB de trafego no plano de dados do cliente.
       */
      let rotulo = `BODY[${secao}]`;
      if (pedidoDeBody[2] !== undefined) {
        const inicio = Number(pedidoDeBody[2]);
        const tamanho = pedidoDeBody[3] === undefined ? recorte.byteLength : Number(pedidoDeBody[3]);
        recorte = recorte.subarray(inicio, inicio + tamanho);
        // O <inicio> volta na resposta; o tamanho pedido, nao — o cliente calcula
        // o fim pelo literal, e devolver o pedido mentiria quando o corpo acaba
        // antes.
        rotulo = `BODY[${secao}]<${inicio}>`;
      }

      partes.push(Buffer.concat([Buffer.from(`${rotulo} {${recorte.byteLength}}\r\n`, "latin1"), recorte]));
    }

    // BODY[] sem PEEK marca como lida; e assim que o cliente sinaliza leitura.
    if (!pedido.includes(".PEEK") && !m.seen) {
      /**
       * Se a gravacao falhar, a sessao NAO pode seguir dizendo que leu.
       *
       * Antes o erro era engolido e `m.seen` virava true assim mesmo: o cliente
       * recebia a mensagem como lida, marcava na tela, e no proximo SELECT ela
       * voltava a nao lida. O cliente conclui que o servidor esta perdendo
       * estado — e nao tem como saber que so o banco falhou.
       */
      try {
        await prisma.message.update({ where: { id: m.id }, data: { seen: true } });
        m.seen = true;
      } catch (error) {
        log.error("nao consegui marcar como lida", {
          messageId: m.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Junta texto e literais sem passar por string: o texto vai em UTF-8, o
  // literal vai como esta.
  const pedacos: Buffer[] = [Buffer.from(`* ${posicao} FETCH (`, "utf8")];
  partes.forEach((parte, i) => {
    if (i > 0) pedacos.push(Buffer.from(" "));
    pedacos.push(Buffer.isBuffer(parte) ? parte : Buffer.from(parte, "utf8"));
  });
  pedacos.push(Buffer.from(")"));
  return Buffer.concat(pedacos);
}

// ---------------------------------------------------------------------------
// Secoes do BODY[...]
// ---------------------------------------------------------------------------

/**
 * A arvore de partes que o BODYSTRUCTURE anuncia, com o conteudo de cada uma.
 *
 * O BODYSTRUCTURE nao e o do .eml: e montado dos metadados (texto, HTML,
 * anexos). Entao a numeracao que o cliente usa em BODY[1], BODY[1.2], BODY[3]
 * tem que ser resolvida contra ESSA arvore, e nao contra o MIME original — as
 * duas so coincidem por sorte. Quem responde a parte n devolve exatamente o
 * conteudo que a estrutura prometeu na posicao n, com o mesmo tamanho.
 */
interface ParteLogica {
  /** Cabecalhos MIME da parte, ja com a linha em branco no fim. */
  mime: string;
  /** Conteudo. Lazy porque anexo exige reparsear o .eml. */
  conteudo: () => Promise<Buffer>;
  filhos?: ParteLogica[];
}

const TAMANHO_LINHA_BASE64 = 76;

function base64Dobrado(bin: Buffer): Buffer {
  const b64 = bin.toString("base64");
  const linhas: string[] = [];
  for (let i = 0; i < b64.length; i += TAMANHO_LINHA_BASE64) {
    linhas.push(b64.slice(i, i + TAMANHO_LINHA_BASE64));
  }
  return Buffer.from(linhas.join("\r\n") + (linhas.length ? "\r\n" : ""), "latin1");
}

/** Tamanho que o base64 dobrado em 76 colunas vai ocupar no fio. */
function tamanhoBase64(bytes: number): number {
  const b64 = Math.ceil(bytes / 3) * 4;
  return b64 + Math.ceil(b64 / TAMANHO_LINHA_BASE64) * 2;
}

function parteDeTexto(subtipo: "plain" | "html", valor: string): ParteLogica {
  return {
    mime: `Content-Type: text/${subtipo}; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n`,
    conteudo: async () => Buffer.from(valor, "utf8"),
  };
}

async function arvoreDePartes(m: LinhaFetch): Promise<ParteLogica> {
  const anexos = await prisma.attachment.findMany({
    where: { messageId: m.id },
    orderBy: { partIndex: "asc" },
    select: { filename: true, contentType: true, contentId: true, partIndex: true },
  });

  const texto = m.bodyText ?? "";
  const html = m.bodyHtml ?? "";

  const corpo: ParteLogica =
    html !== "" && texto !== ""
      ? {
          mime: `Content-Type: multipart/alternative; boundary="avila-alt-${m.uid}"\r\n\r\n`,
          conteudo: async () => Buffer.alloc(0),
          filhos: [parteDeTexto("plain", texto), parteDeTexto("html", html)],
        }
      : html !== ""
        ? parteDeTexto("html", html)
        : parteDeTexto("plain", texto);

  if (anexos.length === 0) return corpo;

  // O binario nao esta no banco: sai do .eml, e uma vez so por FETCH mesmo
  // que o cliente peca varios anexos da mesma mensagem.
  let parseado: Promise<{ attachments: Array<{ content: Buffer }> }> | null = null;
  const anexoConteudo = (indice: number) => async () => {
    parseado ??= readRaw(m.storageKey).then((raw) => simpleParser(raw));
    const parte = (await parseado).attachments[indice];
    return parte ? base64Dobrado(parte.content) : Buffer.alloc(0);
  };

  const partesAnexo: ParteLogica[] = anexos.map((anexo) => {
    const nome = anexo.filename ? `; name="${anexo.filename.replace(/"/g, "")}"` : "";
    const disposicao = anexo.filename
      ? `Content-Disposition: attachment; filename="${anexo.filename.replace(/"/g, "")}"\r\n`
      : "";
    const cid = anexo.contentId ? `Content-ID: <${anexo.contentId}>\r\n` : "";
    return {
      mime: `Content-Type: ${anexo.contentType}${nome}\r\nContent-Transfer-Encoding: base64\r\n${disposicao}${cid}\r\n`,
      conteudo: anexoConteudo(anexo.partIndex),
    };
  });

  return {
    mime: `Content-Type: multipart/mixed; boundary="avila-mix-${m.uid}"\r\n\r\n`,
    conteudo: async () => Buffer.alloc(0),
    filhos: [corpo, ...partesAnexo],
  };
}

/** Serializa uma parte multipart com os filhos dentro, para BODY[n] de um no interno. */
async function serializarParte(parte: ParteLogica): Promise<Buffer> {
  if (!parte.filhos) return parte.conteudo();
  const limite = parte.mime.match(/boundary="([^"]+)"/)?.[1] ?? "avila";
  const pedacos: Buffer[] = [];
  for (const filho of parte.filhos) {
    pedacos.push(Buffer.from(`--${limite}\r\n${filho.mime}`, "latin1"), await serializarParte(filho), Buffer.from("\r\n", "latin1"));
  }
  pedacos.push(Buffer.from(`--${limite}--\r\n`, "latin1"));
  return Buffer.concat(pedacos);
}

/** Filtra o bloco de cabecalhos pelos nomes pedidos, respeitando linhas dobradas. */
function filtrarCabecalhos(bloco: Buffer, nomes: string[], negar: boolean): Buffer {
  const querido = new Set(nomes.map((n) => n.toLowerCase()));
  const linhas = bloco.toString("latin1").split("\r\n");
  const saida: string[] = [];
  let mantendo = false;
  for (const linha of linhas) {
    if (linha === "") continue;
    if (/^[ \t]/.test(linha)) {
      if (mantendo) saida.push(linha);
      continue;
    }
    const nome = linha.slice(0, linha.indexOf(":")).toLowerCase();
    mantendo = querido.has(nome) !== negar;
    if (mantendo) saida.push(linha);
  }
  return Buffer.from(saida.length ? saida.join("\r\n") + "\r\n\r\n" : "\r\n", "latin1");
}

/**
 * Resolve o que vai dentro de BODY[<secao>]. `null` quando a secao nao existe.
 *
 * Cobre o que os clientes de verdade pedem: vazio (tudo), HEADER, TEXT,
 * HEADER.FIELDS (...), HEADER.FIELDS.NOT (...), n, n.m, n.MIME, n.HEADER e
 * n.TEXT.
 */
async function recortarSecao(m: LinhaFetch, bruto: Buffer, secao: string): Promise<Buffer | null> {
  const corte = bruto.indexOf("\r\n\r\n");
  const cabecalhos = corte === -1 ? bruto : bruto.subarray(0, corte + 4);
  const corpoCru = corte === -1 ? Buffer.alloc(0) : bruto.subarray(corte + 4);

  if (secao === "") return bruto;
  if (secao === "HEADER") return cabecalhos;
  if (secao === "TEXT") return corpoCru;

  const campos = secao.match(/^HEADER\.FIELDS(\.NOT)?\s*\(([^)]*)\)$/);
  if (campos) return filtrarCabecalhos(cabecalhos, campos[2]!.trim().split(/\s+/).filter(Boolean), campos[1] !== undefined);

  const numerada = secao.match(/^(\d+(?:\.\d+)*)(?:\.(MIME|HEADER|TEXT))?$/);
  if (!numerada) return null;

  let parte: ParteLogica | undefined = await arvoreDePartes(m);
  // Mensagem de uma parte so: "1" e ela mesma, sem descer em filhos.
  const caminho = numerada[1]!.split(".").map(Number);
  if (!parte.filhos && caminho.length === 1 && caminho[0] === 1) {
    // fica em `parte`
  } else {
    for (const indice of caminho) {
      parte = parte?.filhos?.[indice - 1];
      if (!parte) return null;
    }
  }

  const sufixo = numerada[2];
  if (sufixo === "MIME") return Buffer.from(parte.mime, "latin1");
  // HEADER e TEXT so fazem sentido em message/rfc822 aninhado, que nao
  // reproduzimos: devolve o que temos em vez de mentir com o .eml inteiro.
  if (sufixo === "HEADER") return Buffer.from(parte.mime, "latin1");
  return serializarParte(parte);
}

/**
 * BODYSTRUCTURE de verdade, montado a partir do que ja esta no banco.
 *
 * Responder sempre TEXT/PLAIN, como estava antes, faz o cliente decidir errado
 * o que baixar: mensagem em HTML aparece como texto cru e, pior, ANEXO NENHUM
 * e exibido — o cliente nem sabe que existe parte para buscar. Quem le no
 * celular simplesmente nao ve o boleto que o fornecedor mandou.
 *
 * A arvore aqui e reconstruida dos metadados (corpo texto, corpo HTML, lista de
 * anexos), nao reparseando o .eml a cada FETCH. Nao reproduz aninhamento
 * exotico, mas descreve com fidelidade as tres formas que respondem por
 * praticamente todo e-mail real.
 */
async function estruturaDoCorpo(m: LinhaFetch): Promise<string> {
  const anexos = await prisma.attachment.findMany({
    where: { messageId: m.id },
    orderBy: { partIndex: "asc" },
    select: { filename: true, contentType: true, sizeBytes: true, contentId: true },
  });

  const texto = m.bodyText ?? "";
  const html = m.bodyHtml ?? "";

  const linhas = (valor: string) => (valor === "" ? 0 : valor.split("\n").length);

  const parteTexto = `("TEXT" "PLAIN" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${Buffer.byteLength(
    texto,
  )} ${linhas(texto)} NIL NIL NIL NIL)`;

  const parteHtml = `("TEXT" "HTML" ("CHARSET" "UTF-8") NIL NIL "8BIT" ${Buffer.byteLength(
    html,
  )} ${linhas(html)} NIL NIL NIL NIL)`;

  const corpo = html !== "" && texto !== ""
    ? `(${parteTexto}${parteHtml} "ALTERNATIVE" NIL NIL NIL)`
    : html !== ""
      ? parteHtml
      : parteTexto;

  if (anexos.length === 0) return corpo;

  const partesAnexo = anexos.map((anexo) => {
    const [tipo = "APPLICATION", sub = "OCTET-STREAM"] = anexo.contentType.toUpperCase().split("/");
    const nome = anexo.filename ? `("NAME" ${comoString(anexo.filename)})` : "NIL";
    const disposicao = anexo.filename
      ? `("attachment" ("FILENAME" ${comoString(anexo.filename)}))`
      : "NIL";
    // O tamanho e o do base64 no fio, que e o que BODY[n] entrega — o RFC
    // 3501 pede o tamanho codificado, e cliente que confia nele para a barra
    // de progresso trava se o literal vier maior.
    return `(${comoString(tipo)} ${comoString(sub)} ${nome} ${comoString(
      anexo.contentId,
    )} NIL "BASE64" ${tamanhoBase64(anexo.sizeBytes)} NIL ${disposicao} NIL NIL)`;
  });

  return `(${corpo}${partesAnexo.join("")} "MIXED" NIL NIL NIL)`;
}

/**
 * Traduz o criterio do SEARCH para condicoes do banco.
 *
 * Cobre o que cliente real usa no dia a dia. O que nao esta aqui volta como
 * BAD, de proposito: buscar e uma operacao em que o cliente CONFIA no
 * resultado — ele mostra a lista como sendo a resposta completa. Um servidor
 * que ignora o que nao entendeu devolve a pasta inteira e mente sem avisar.
 *
 * Fora de escopo hoje, e por isso recusado: OR, NOT, parenteses, HEADER e
 * CHARSET. Implementar de meia-boca seria repetir o erro anterior.
 */
function traduzirBusca(
  criterio: string,
  pasta: PastaSelecionada,
  sessao: Sessao,
  porUid: boolean,
):
  | { ok: true; condicoes: Array<Record<string, unknown>> }
  | { ok: false; termo: string } {
  const condicoes: Array<Record<string, unknown>> = [];

  // Quebra respeitando aspas: SUBJECT "nota fiscal" e um termo so.
  const termos = criterio.match(/"[^"]*"|\S+/g) ?? [];
  const semAspas = (valor: string) => valor.replace(/^"|"$/g, "");

  const DATAS: Record<string, "gte" | "lt"> = { SINCE: "gte", BEFORE: "lt" };
  const TEXTOS: Record<string, string> = {
    FROM: "fromAddress",
    SUBJECT: "subject",
    BODY: "bodyText",
    TEXT: "bodyText",
  };

  let i = 0;
  while (i < termos.length) {
    const termo = (termos[i] ?? "").toUpperCase();
    const proximo = termos[i + 1];

    if (termo === "ALL") { i += 1; continue; }
    if (termo === "SEEN") { condicoes.push({ seen: true }); i += 1; continue; }
    if (termo === "UNSEEN") { condicoes.push({ seen: false }); i += 1; continue; }
    if (termo === "FLAGGED") { condicoes.push({ flagged: true }); i += 1; continue; }
    if (termo === "UNFLAGGED") { condicoes.push({ flagged: false }); i += 1; continue; }
    if (termo === "ANSWERED") { condicoes.push({ answered: true }); i += 1; continue; }
    if (termo === "UNANSWERED") { condicoes.push({ answered: false }); i += 1; continue; }
    if (termo === "DELETED") { condicoes.push({ deleted: true }); i += 1; continue; }
    if (termo === "UNDELETED") { condicoes.push({ deleted: false }); i += 1; continue; }
    if (termo === "DRAFT") { condicoes.push({ draft: true }); i += 1; continue; }
    if (termo === "UNDRAFT") { condicoes.push({ draft: false }); i += 1; continue; }
    if (termo === "NEW") { condicoes.push({ seen: false }); i += 1; continue; }

    if (termo === "TO" || termo === "CC") {
      if (proximo === undefined) return { ok: false, termo };
      // Destinatarios ficam em JSON; `string_contains` cobre a busca do cliente.
      condicoes.push({
        [termo === "TO" ? "toAddresses" : "ccAddresses"]: {
          string_contains: semAspas(proximo).toLowerCase(),
        },
      });
      i += 2;
      continue;
    }

    if (TEXTOS[termo]) {
      if (proximo === undefined) return { ok: false, termo };
      condicoes.push({ [TEXTOS[termo]]: { contains: semAspas(proximo), mode: "insensitive" } });
      i += 2;
      continue;
    }

    if (DATAS[termo]) {
      if (proximo === undefined) return { ok: false, termo };
      const data = new Date(semAspas(proximo).replace(/-/g, " "));
      if (Number.isNaN(data.getTime())) return { ok: false, termo: `${termo} ${proximo}` };
      condicoes.push({ receivedAt: { [DATAS[termo]]: data } });
      i += 2;
      continue;
    }

    if (termo === "LARGER" || termo === "SMALLER") {
      if (proximo === undefined) return { ok: false, termo };
      condicoes.push({ sizeBytes: { [termo === "LARGER" ? "gt" : "lt"]: Number(proximo) } });
      i += 2;
      continue;
    }

    if (termo === "UID") {
      if (proximo === undefined) return { ok: false, termo };
      condicoes.push({ id: { in: expandirIntervalo(proximo, sessao, true) } });
      i += 2;
      continue;
    }

    // Conjunto de sequencia solto ("1:5"), valido como criterio.
    if (/^[\d,:*]+$/.test(termo)) {
      condicoes.push({ id: { in: expandirIntervalo(termo, sessao, porUid) } });
      i += 1;
      continue;
    }

    return { ok: false, termo };
  }

  void pasta;
  return { ok: true, condicoes };
}

// ---------------------------------------------------------------------------
// Sessao
// ---------------------------------------------------------------------------

function responder(socket: Socket, linha: string | Buffer): void {
  // Buffer e a resposta do FETCH, que carrega literal binario: vai como esta.
  if (Buffer.isBuffer(linha)) {
    socket.write(Buffer.concat([linha, Buffer.from("\r\n")]));
    return;
  }
  socket.write(`${linha}\r\n`);
}

/**
 * Executa o que o \Deleted marcou.
 *
 * Duas regras do protocolo que parecem detalhe e nao sao:
 *
 * 1. Cada mensagem removida gera um `* n EXPUNGE`, e n e a posicao NAQUELE
 *    instante. Por isso a emissao vai da ultima para a primeira: retirar a
 *    mensagem 3 renumera tudo que vem depois dela, e um cliente que receba os
 *    avisos em ordem crescente apaga a mensagem errada da tela.
 * 2. Na Lixeira, expurgar e destruir. Em qualquer outra pasta, e mandar para a
 *    Lixeira — o cliente que aperta "apagar" no celular espera poder se
 *    arrepender, e o IMAP nao proibe essa leitura.
 *
 * `silencioso` existe para o CLOSE, que faz a mesma limpeza sem avisar nada.
 */
async function expurgar(
  socket: Socket,
  sessao: Sessao,
  caixaId: string,
  pasta: PastaSelecionada,
  apenasEstes: string[] | null,
  silencioso = false,
): Promise<number> {
  const marcadas = await prisma.message.findMany({
    where: {
      mailboxId: caixaId,
      folderId: pasta.id,
      deleted: true,
      ...(apenasEstes ? { id: { in: apenasEstes } } : {}),
    },
    select: { id: true },
  });

  if (marcadas.length === 0) return 0;

  const alvos = new Set(marcadas.map((m) => m.id));

  // Posicoes na sequencia congelada, da maior para a menor.
  const posicoes = pasta.sequencia
    .map((item, indice) => ({ id: item.id, posicao: indice + 1 }))
    .filter((item) => alvos.has(item.id))
    .sort((a, b) => b.posicao - a.posicao);

  // `deleteMessages` ja aplica os dois tempos: na Lixeira destroi (liberando
  // quota e blob), fora dela move para la. Reaproveitar mantem uma unica
  // definicao de "apagar" para o webmail, o POP3 e o IMAP.
  const { deleteMessages } = await import("../services/messages.js");
  await deleteMessages(caixaId, [...alvos]);

  // Quem sobreviveu foi para a Lixeira: a marca era da pasta de origem e nao
  // acompanha a mensagem, senao a proxima limpeza da Lixeira a levaria junto
  // sem o cliente ter pedido.
  await prisma.message.updateMany({ where: { id: { in: [...alvos] } }, data: { deleted: false } });

  if (!silencioso) {
    for (const item of posicoes) responder(socket, `* ${item.posicao} EXPUNGE`);
  }

  pasta.sequencia = await carregarSequencia(caixaId, pasta.id);
  if (!silencioso) responder(socket, `* ${pasta.sequencia.length} EXISTS`);

  return posicoes.length;
}

async function tratar(
  socket: Socket,
  sessao: Sessao,
  linha: string,
  literais: Buffer[],
  tls?: TlsOptions,
): Promise<void> {
  const espaco = linha.indexOf(" ");
  const tag = espaco === -1 ? linha : linha.slice(0, espaco);
  const resto = espaco === -1 ? "" : linha.slice(espaco + 1);
  const espaco2 = resto.indexOf(" ");
  const comando = (espaco2 === -1 ? resto : resto.slice(0, espaco2)).toUpperCase();
  let args = espaco2 === -1 ? "" : resto.slice(espaco2 + 1);

  /**
   * Resposta final do comando.
   *
   * O codigo entre colchetes ([APPENDUID], [READ-WRITE], [COPYUID]) tem de vir
   * COLADO no OK, antes de qualquer outro texto — e assim que o cliente o
   * encontra. Escrito como `OK APPEND [APPENDUID 1 5]`, o codigo vira texto
   * livre: o cliente le "sucesso" e descarta a informacao. Foi o que acontecia
   * aqui, e so apareceu quando um cliente de verdade tentou usar o UID.
   */
  const ok = (texto = "concluido", codigo?: string) =>
    responder(socket, `${tag} OK ${codigo ? `${codigo} ` : ""}${comando} ${texto}`);
  const nao = (texto: string) => responder(socket, `${tag} NO ${texto}`);
  const ruim = (texto: string) => responder(socket, `${tag} BAD ${texto}`);

  // --- Qualquer estado ---

  if (comando === "CAPABILITY") {
    const caps = ["IMAP4rev1", "UIDPLUS", "MOVE", "IDLE", "LITERAL+", "ID", "NAMESPACE", "ENABLE"];
    if (sessao.seguro) {
      caps.push("AUTH=PLAIN");
    } else {
      // So anuncia STARTTLS se houver certificado carregado. Anunciar sem ter
      // faz o cliente tentar, levar BAD e desistir da conta - enquanto sem o
      // anuncio ele ao menos sabe de cara que aquela porta nao serve.
      if (tls) caps.push("STARTTLS");
      caps.push("LOGINDISABLED");
    }
    responder(socket, `* CAPABILITY ${caps.join(" ")}`);
    return ok();
  }

  if (comando === "NOOP") return ok();

  /**
   * Cortesias que o Outlook (o novo, que sincroniza pela nuvem da Microsoft)
   * manda antes e logo depois de logar: ID, NAMESPACE e ENABLE. Qualquer
   * resposta que nao seja OK aqui a Microsoft traduz para o usuario como
   * "INVALIDCREDENTIALS INTERACTIONREQUIRED", e a conta nunca entra
   * (11/09/2026, caixa do Vedashow, com a senha certa). O RFC 2971 permite ID
   * em qualquer estado; NAMESPACE e ENABLE valem no autenticado, e responder
   * OK vazio e o comportamento de quem nao tem namespace nem extensao.
   */
  if (comando === "ID") {
    responder(socket, `* ID ("name" "Avila Mail" "vendor" "Avila Ops" "support-url" "https://${config.hostname}/configurar")`);
    return ok("ID concluido");
  }
  if (comando === "NAMESPACE") {
    if (sessao.estado === "nao-autenticado") return ruim("autentique primeiro");
    responder(socket, '* NAMESPACE (("" "/")) NIL NIL');
    return ok("NAMESPACE concluido");
  }
  if (comando === "ENABLE") {
    if (sessao.estado === "nao-autenticado") return ruim("autentique primeiro");
    // Nenhuma extensao habilitavel: a resposta e a lista vazia, que e valida.
    responder(socket, "* ENABLED");
    return ok("ENABLE concluido");
  }

  if (comando === "LOGOUT") {
    responder(socket, "* BYE encerrando");
    ok();
    socket.end();
    return;
  }

  // --- Nao autenticado ---

  if (sessao.estado === "nao-autenticado") {
    if (comando === "LOGIN") {
      // Credencial em texto claro so com TLS — mesma regra do POP3 e do SMTP.
      if (!sessao.seguro) return nao("use STARTTLS antes de autenticar");

      // O cliente pode mandar usuario e senha como literais ({5} + linha
      // crua com o valor) em
      // vez de texto entre aspas — e o que acontece quando a senha tem aspas.
      const partes =
        literais.length >= 2
          ? literais.map((literal) => literal.toString("utf8"))
          : (args.match(/"([^"]*)"|(\S+)/g)?.map((p) => p.replace(/^"|"$/g, "")) ?? []);
      const [usuario = "", senha = ""] = partes;

      const resultado = await autenticarCaixa(usuario, senha, sessao.ip, "imap");
      if (!resultado.ok) {
        if (resultado.motivo === "bloqueada") return nao("muitas tentativas; aguarde alguns minutos");
        if (resultado.motivo === "suspensa") return nao("caixa suspensa; regularize no painel");
        return nao("usuario ou senha invalidos");
      }

      sessao.caixaId = resultado.caixa.id;
      sessao.endereco = resultado.caixa.address;
      sessao.estado = "autenticado";
      log.info("sessao IMAP aberta", { endereco: sessao.endereco });
      return ok("autenticado");
    }

    /**
     * AUTHENTICATE PLAIN (RFC 4616). O Apple Mail prefere este caminho ao
     * LOGIN, e anunciar AUTH=PLAIN sem atender seria mentir para o cliente:
     * ele tentaria, levaria BAD e desistiria da conta inteira.
     *
     * O payload vem em base64 como "\0usuario\0senha" — pode vir colado no
     * comando (SASL-IR) ou depois do "+" de continuacao.
     */
    if (comando === "AUTHENTICATE") {
      if (!sessao.seguro) return nao("use STARTTLS antes de autenticar");

      const partes = args.trim().split(/\s+/);
      const mecanismo = (partes[0] ?? "").toUpperCase();
      if (mecanismo !== "PLAIN") return nao("mecanismo nao suportado");

      const inicial = partes[1];
      const credencial = inicial ?? (await pedirContinuacao(socket, sessao));
      if (credencial === null) return nao("autenticacao cancelada");

      const campos = Buffer.from(credencial.trim(), "base64").toString("utf8").split("\0");
      const usuario = campos[1] ?? "";
      const senha = campos[2] ?? "";

      const resultado = await autenticarCaixa(usuario, senha, sessao.ip, "imap");
      if (!resultado.ok) {
        if (resultado.motivo === "bloqueada") return nao("muitas tentativas; aguarde alguns minutos");
        if (resultado.motivo === "suspensa") return nao("caixa suspensa; regularize no painel");
        return nao("usuario ou senha invalidos");
      }

      sessao.caixaId = resultado.caixa.id;
      sessao.endereco = resultado.caixa.address;
      sessao.estado = "autenticado";
      log.info("sessao IMAP aberta", { endereco: sessao.endereco, mecanismo: "PLAIN" });
      return ok("autenticado");
    }

    return ruim("autentique primeiro");
  }

  const caixaId = sessao.caixaId;
  if (!caixaId) return ruim("sessao invalida");

  // --- Autenticado ---

  if (comando === "LIST" || comando === "LSUB") {
    /**
     * LIST tem dois argumentos: uma referencia (prefixo) e um padrao.
     *
     * Devolver tudo, ignorando os dois, parece inofensivo e nao e: o cliente
     * pergunta "quais as subpastas de Lixeira?" com LIST "Lixeira" "%", recebe
     * a lista inteira de volta e conclui que existe uma Lixeira/Enviados. A
     * partir dai ele tenta abrir pastas que nunca existiram e a arvore de
     * pastas do Outlook vira ficcao.
     */
    const partes = args.match(/"([^"]*)"|(\S+)/g)?.map((p) => p.replace(/^"|"$/g, "")) ?? [];
    const referencia = partes[0] ?? "";
    const padrao = partes[1] ?? "*";

    // LIST "" "" e a pergunta "qual e o separador de hierarquia?".
    if (padrao === "") {
      responder(socket, `* ${comando} (\\Noselect) "/" ""`);
      return ok();
    }

    const alvo = `${referencia}${padrao}`;
    // "*" atravessa a hierarquia; "%" para no separador. O resto e literal.
    const regex = new RegExp(
      `^${alvo
        .split("")
        .map((c) => {
          if (c === "*") return ".*";
          if (c === "%") return "[^/]*";
          return c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        })
        .join("")}$`,
      "i",
    );

    const pastas = await prisma.mailFolder.findMany({
      where: { mailboxId: caixaId },
      orderBy: { createdAt: "asc" },
    });

    for (const pasta of pastas) {
      const nome = nomeImap(pasta);
      if (!regex.test(nome)) continue;
      const especial = ATRIBUTO_ESPECIAL[pasta.kind] ?? "";
      responder(socket, `* ${comando} (${especial}) "/" ${comoString(nome)}`);
    }
    return ok();
  }

  if (comando === "STATUS") {
    const nome = args.match(/^\s*("[^"]*"|\S+)/)?.[1] ?? "";
    const pasta = await acharPasta(caixaId, nome);
    if (!pasta) return nao("pasta inexistente");

    const [total, naoLidas] = await Promise.all([
      prisma.message.count({ where: { mailboxId: caixaId, folderId: pasta.id } }),
      prisma.message.count({ where: { mailboxId: caixaId, folderId: pasta.id, seen: false } }),
    ]);

    responder(
      socket,
      `* STATUS ${comoString(nomeImap(pasta))} (MESSAGES ${total} UNSEEN ${naoLidas} UIDNEXT ${pasta.uidNext} UIDVALIDITY ${pasta.uidValidity})`,
    );
    return ok();
  }

  if (comando === "SELECT" || comando === "EXAMINE") {
    const pasta = await acharPasta(caixaId, args.trim());
    if (!pasta) return nao("pasta inexistente");

    const sequencia = await carregarSequencia(caixaId, pasta.id);
    const naoLidas = await prisma.message.count({
      where: { mailboxId: caixaId, folderId: pasta.id, seen: false },
    });

    sessao.pasta = {
      id: pasta.id,
      nome: nomeImap(pasta),
      kind: pasta.kind,
      uidValidity: pasta.uidValidity,
      uidNext: pasta.uidNext,
      somenteLeitura: comando === "EXAMINE",
      sequencia,
    };
    sessao.estado = "selecionado";

    responder(socket, `* ${sequencia.length} EXISTS`);
    responder(socket, "* 0 RECENT");
    responder(socket, `* OK [UIDVALIDITY ${pasta.uidValidity}] validade`);
    responder(socket, `* OK [UIDNEXT ${pasta.uidNext}] proximo`);
    responder(socket, `* OK [UNSEEN ${naoLidas}] nao lidas`);
    responder(socket, "* FLAGS (\\Seen \\Flagged \\Answered \\Draft \\Deleted)");
    responder(socket, "* OK [PERMANENTFLAGS (\\Seen \\Flagged \\Answered \\Draft \\Deleted)] permitidas");
    return ok("selecionada", comando === "EXAMINE" ? "[READ-ONLY]" : "[READ-WRITE]");
  }

  if (comando === "CREATE") {
    const nome = args.trim().replace(/^"|"$/g, "");
    if (!nome) return nao("nome invalido");
    const { createFolder } = await import("../services/folders.js");
    try {
      await createFolder(caixaId, nome);
      return ok("criada");
    } catch (erro) {
      return nao(erro instanceof Error ? erro.message : "nao foi possivel criar");
    }
  }

  if (comando === "DELETE" || comando === "RENAME") {
    const partes = args.match(/"([^"]*)"|(\S+)/g)?.map((p) => p.replace(/^"|"$/g, "")) ?? [];
    const pasta = await acharPasta(caixaId, partes[0] ?? "");
    if (!pasta) return nao("pasta inexistente");

    const { deleteFolder, renameFolder } = await import("../services/folders.js");
    try {
      if (comando === "DELETE") await deleteFolder(caixaId, pasta.id);
      else await renameFolder(caixaId, pasta.id, partes[1] ?? "");
      return ok();
    } catch (erro) {
      return nao(erro instanceof Error ? erro.message : "operacao recusada");
    }
  }

  if (comando === "SUBSCRIBE" || comando === "UNSUBSCRIBE") {
    // Todas as pastas ja aparecem no LSUB, entao nao ha assinatura para guardar.
    return ok();
  }

  if (comando === "CLOSE") {
    /**
     * CLOSE tambem expurga — calado.
     *
     * E a diferenca entre CLOSE e UNSELECT: os dois fecham a pasta, mas o CLOSE
     * executa as marcas de \Deleted sem emitir os avisos de EXPUNGE (o cliente
     * ja esta saindo da pasta e nao tem mais o que renumerar). Cliente que usa
     * CLOSE para apagar — o Thunderbird faz isso — nao veria efeito nenhum se
     * aqui so fechasse a pasta.
     */
    if (sessao.pasta && !sessao.pasta.somenteLeitura) {
      await expurgar(socket, sessao, caixaId, sessao.pasta, null, true);
    }
    sessao.pasta = null;
    sessao.estado = "autenticado";
    return ok();
  }

  if (comando === "UNSELECT") {
    // Fecha SEM expurgar. Existe justamente para quem nao quer o efeito
    // colateral do CLOSE.
    sessao.pasta = null;
    sessao.estado = "autenticado";
    return ok();
  }

  if (comando === "IDLE") {
    // O cliente para de perguntar "chegou algo?" porque confia que sera
    // avisado. Segurar a conexao sem nunca avisar deixa a mensagem parada no
    // servidor ate a proxima sincronia manual — pior do que nao ter IDLE.
    sessao.emIdle = tag;
    socket.write("+ aguardando\r\n");
    return;
  }

  /**
   * APPEND: o cliente sobe uma mensagem pronta para dentro de uma pasta.
   *
   * Sem isso o Outlook reclama a cada envio ("nao foi possivel salvar em Itens
   * Enviados") e nenhum rascunho escrito no celular aparece no computador —
   * porque e por APPEND que o cliente guarda as duas coisas.
   */
  if (comando === "APPEND") {
    const nome = args.match(/^\s*("[^"]*"|\S+)/)?.[1] ?? "";
    const destino = await acharPasta(caixaId, nome);
    if (!destino) return nao("[TRYCREATE] pasta inexistente");

    const bruto = literais[literais.length - 1];
    if (!bruto || bruto.byteLength === 0) return ruim("APPEND sem mensagem");

    const marcadas = args.slice(nome.length).match(/\(([^)]*)\)/)?.[1]?.toUpperCase() ?? "";
    const marcas = {
      seen: marcadas.includes("\\SEEN"),
      flagged: marcadas.includes("\\FLAGGED"),
      answered: marcadas.includes("\\ANSWERED"),
      draft: marcadas.includes("\\DRAFT"),
    };

    const caixa = await prisma.mailbox.findUnique({
      where: { id: caixaId },
      select: { id: true, domainId: true, quotaBytes: true, usedBytes: true, status: true },
    });
    if (!caixa) return nao("caixa inexistente");

    const { deliverToMailbox } = await import("./deliver-local.js");
    const resultado = await deliverToMailbox(
      {
        kind: "mailbox",
        mailboxId: caixa.id,
        domainId: caixa.domainId,
        quotaBytes: caixa.quotaBytes,
        usedBytes: caixa.usedBytes,
        status: caixa.status,
      },
      bruto,
      null,
      { forceFolderId: destino.id, flags: marcas },
    );

    // Caixa cheia tem codigo proprio no IMAP: o cliente mostra "sem espaco" em
    // vez de "erro desconhecido" e para de tentar reenviar em loop.
    if (resultado.status !== "delivered") {
      const cheia = resultado.status === "rejected" && resultado.code === 552;
      return nao(cheia ? "[OVERQUOTA] caixa cheia" : "nao foi possivel guardar");
    }

    const gravada = await prisma.message.findUnique({
      where: { id: resultado.messageId },
      select: { uid: true },
    });

    // Se a pasta de destino for a que esta aberta, a sequencia da sessao mudou.
    if (sessao.pasta?.id === destino.id) {
      sessao.pasta.sequencia = await carregarSequencia(caixaId, destino.id);
      responder(socket, `* ${sessao.pasta.sequencia.length} EXISTS`);
    }

    const pastaAtual = await prisma.mailFolder.findUniqueOrThrow({
      where: { id: destino.id },
      select: { uidValidity: true },
    });
    return ok("guardada", `[APPENDUID ${pastaAtual.uidValidity} ${gravada?.uid ?? 0}]`);
  }

  // --- Selecionado ---

  const porUid = comando === "UID";
  let real = comando;

  if (porUid) {
    const corte = args.indexOf(" ");
    real = (corte === -1 ? args : args.slice(0, corte)).toUpperCase();
    args = corte === -1 ? "" : args.slice(corte + 1);
  }

  if (!sessao.pasta) return nao("selecione uma pasta primeiro");
  const pasta = sessao.pasta;

  if (real === "FETCH") {
    const corte = args.indexOf(" ");
    const spec = corte === -1 ? args : args.slice(0, corte);
    const itens = corte === -1 ? "" : args.slice(corte + 1);

    const ids = expandirIntervalo(spec, sessao, porUid);
    const linhas = await prisma.message.findMany({
      where: { id: { in: ids }, mailboxId: caixaId },
      orderBy: { uid: "asc" },
    });

    for (const m of linhas) {
      const posicao = pasta.sequencia.findIndex((s) => s.id === m.id) + 1;
      responder(socket, await montarFetch(m as unknown as LinhaFetch, itens, porUid, posicao));
    }
    return ok();
  }

  if (real === "STORE") {
    if (pasta.somenteLeitura) return nao("pasta aberta somente para leitura");

    const partes = args.split(/\s+/);
    const spec = partes[0] ?? "";
    const operacao = (partes[1] ?? "").toUpperCase();
    const valores = args.slice(args.indexOf("(")).toUpperCase();

    const ids = expandirIntervalo(spec, sessao, porUid);
    if (ids.length === 0) return ok();

    const dados: Record<string, boolean> = {};
    const ligar = !operacao.startsWith("-");
    if (valores.includes("\\SEEN")) dados.seen = ligar;
    if (valores.includes("\\FLAGGED")) dados.flagged = ligar;
    if (valores.includes("\\ANSWERED")) dados.answered = ligar;
    if (valores.includes("\\DRAFT")) dados.draft = ligar;

    /**
     * \Deleted e uma flag, nao uma acao.
     *
     * O cliente marca, segue trabalhando, e so o EXPUNGE (ou o CLOSE) executa.
     * Mover a mensagem aqui, na hora da marcacao, quebra tres coisas de uma
     * vez: a sequencia que a sessao congelou no SELECT, o direito de desmarcar
     * com -FLAGS (\Deleted), e o EXPUNGE, que passaria a nao ter o que fazer.
     */
    if (valores.includes("\\DELETED")) dados.deleted = ligar;

    if (Object.keys(dados).length > 0) {
      await prisma.message.updateMany({ where: { id: { in: ids }, mailboxId: caixaId }, data: dados });
    }

    if (!operacao.endsWith(".SILENT")) {
      const atualizadas = await prisma.message.findMany({
        where: { id: { in: ids }, mailboxId: caixaId },
        select: {
          id: true,
          uid: true,
          seen: true,
          flagged: true,
          answered: true,
          draft: true,
          deleted: true,
        },
      });
      for (const m of atualizadas) {
        const posicao = pasta.sequencia.findIndex((s) => s.id === m.id) + 1;
        responder(socket, `* ${posicao} FETCH (UID ${m.uid} FLAGS ${flags(m)})`);
      }
    }

    return ok();
  }

  if (real === "COPY" || real === "MOVE") {
    if (pasta.somenteLeitura) return nao("pasta aberta somente para leitura");

    const corte = args.indexOf(" ");
    const spec = corte === -1 ? args : args.slice(0, corte);
    const destinoNome = corte === -1 ? "" : args.slice(corte + 1).trim();

    const destino = await acharPasta(caixaId, destinoNome);
    if (!destino) return nao("[TRYCREATE] pasta de destino inexistente");

    const ids = expandirIntervalo(spec, sessao, porUid);
    if (ids.length === 0) return ok();

    const uidsOrigem = pasta.sequencia
      .filter((item) => ids.includes(item.id))
      .map((item) => item.uid);

    if (real === "MOVE") {
      /**
       * A mensagem sai da pasta atual, e o cliente precisa saber disso.
       *
       * Sem os `* n EXPUNGE`, a copia local do cliente continua exibindo a
       * mensagem na pasta de origem ate a proxima sincronia completa — e, se
       * ele tentar abrir, recebe erro de mensagem inexistente. Em ordem
       * decrescente pelo mesmo motivo do expurgo: cada remocao renumera as
       * posicoes seguintes.
       */
      const posicoes = pasta.sequencia
        .map((item, indice) => ({ id: item.id, posicao: indice + 1 }))
        .filter((item) => ids.includes(item.id))
        .sort((a, b) => b.posicao - a.posicao);

      const antesDoDestino = await prisma.mailFolder.findUniqueOrThrow({
        where: { id: destino.id },
        select: { uidValidity: true, uidNext: true },
      });

      await moverParaPasta(caixaId, ids, destino.id);

      const novos = await prisma.message.findMany({
        where: { id: { in: ids }, mailboxId: caixaId },
        orderBy: { uid: "asc" },
        select: { uid: true },
      });

      for (const item of posicoes) responder(socket, `* ${item.posicao} EXPUNGE`);

      pasta.sequencia = await carregarSequencia(caixaId, pasta.id);
      responder(socket, `* ${pasta.sequencia.length} EXISTS`);

      // COPYUID diz qual UID cada mensagem ganhou no destino; sem isso o cliente
      // nao consegue casar o que mandou mover com o que chegou la. Vai na
      // resposta final, colado no OK - untagged o cliente nao procura.
      return ok(
        "movidas",
        `[COPYUID ${antesDoDestino.uidValidity} ${uidsOrigem.join(",")} ${novos
          .map((m) => m.uid)
          .join(",")}]`,
      );
    }

    // COPY duplica: le o bruto e reentrega na pasta destino.
    const { storeCopyInMailbox } = await import("./deliver-local.js");
    const destinoAntes = await prisma.mailFolder.findUniqueOrThrow({
      where: { id: destino.id },
      select: { uidValidity: true },
    });

    const originais = await prisma.message.findMany({
      where: { id: { in: ids }, mailboxId: caixaId },
      select: { storageKey: true },
    });

    const criadas: number[] = [];
    for (const original of originais) {
      const bruto = await readRaw(original.storageKey);
      const novoId = await storeCopyInMailbox(caixaId, bruto, destino.kind as never);
      if (novoId) {
        const nova = await prisma.message.findUnique({ where: { id: novoId }, select: { uid: true } });
        if (nova) criadas.push(nova.uid);
      }
    }

    if (criadas.length === 0) return ok("copiadas");

    return ok(
      "copiadas",
      `[COPYUID ${destinoAntes.uidValidity} ${uidsOrigem.join(",")} ${criadas.join(",")}]`,
    );
  }

  if (real === "SEARCH") {
    const traduzido = traduzirBusca(args.trim(), pasta, sessao, porUid);

    /**
     * Criterio que o servidor nao entende tem de virar BAD.
     *
     * Antes, tudo que nao fosse SEEN/UNSEEN/FLAGGED era simplesmente ignorado:
     * uma busca por "FROM fornecedor" devolvia a pasta INTEIRA, e o cliente
     * exibia aquilo como se fossem os resultados. Resposta errada com cara de
     * certa e pior do que recusa — o cliente que recebe BAD ao menos cai para a
     * busca local dele.
     */
    if (!traduzido.ok) return ruim(`criterio de busca nao suportado: ${traduzido.termo}`);

    const achadas = await prisma.message.findMany({
      where: { mailboxId: caixaId, folderId: pasta.id, AND: traduzido.condicoes },
      orderBy: { uid: "asc" },
      select: { id: true, uid: true },
    });

    const numeros = achadas.map((m) =>
      porUid ? m.uid : pasta.sequencia.findIndex((s) => s.id === m.id) + 1,
    );

    responder(socket, `* SEARCH ${numeros.join(" ")}`.trim());
    return ok();
  }

  if (real === "EXPUNGE") {
    if (pasta.somenteLeitura) return nao("pasta aberta somente para leitura");

    // UID EXPUNGE (UIDPLUS) limita a limpeza ao conjunto pedido; o EXPUNGE
    // simples leva todas as marcadas.
    const limite = porUid && args.trim() !== "" ? expandirIntervalo(args.trim(), sessao, true) : null;
    await expurgar(socket, sessao, caixaId, pasta, limite);
    return ok();
  }

  return ruim(`comando nao suportado: ${real}`);
}

function conduzir(socket: Socket, seguro: boolean, tls?: TlsOptions): void {
  socket.setTimeout(30 * 60_000);

  const sessao: Sessao = {
    estado: "nao-autenticado",
    caixaId: null,
    endereco: null,
    pasta: null,
    seguro,
    ip: socket.remoteAddress ?? "",
    emIdle: null,
    aguardarLinha: null,
  };

  /**
   * O IMAP nao e um protocolo de linhas: no meio de um comando o cliente pode
   * anunciar {N} e despejar N bytes crus, que podem conter 

 a vontade — e
   * exatamente assim que uma mensagem inteira sobe no APPEND. Por isso o buffer
   * aqui e binario, e nao string: cortar por linha antes da hora parte a
   * mensagem no meio, e decodificar como texto corrompe anexo.
   */
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let texto = "";
  let literais: Buffer[] = [];
  let pedacos: Buffer[] = [];
  let faltam = 0;

  let ocupado = false;
  const fila: Array<{ texto: string; literais: Buffer[] }> = [];
  let entregarContinuacao: ((linha: string | null) => void) | null = null;

  /**
   * Aviso de mensagem nova, so enquanto o cliente esta em IDLE.
   *
   * Fora do IDLE o cliente pode estar no meio de um FETCH, e injetar um EXISTS
   * no meio da resposta confunde parser simples. Em IDLE a janela e explicita:
   * e para isso que ele abriu o comando.
   */
  let avisoPendente = false;

  const pararDeOuvir = ouvirEntregas((aviso) => {
    if (!sessao.pasta) return;
    if (aviso.mailboxId !== sessao.caixaId || aviso.folderId !== sessao.pasta.id) return;

    // Fora do IDLE o aviso fica guardado e sai no fim do proximo comando: e a
    // janela em que o protocolo permite resposta nao solicitada sem atrapalhar
    // o parser do cliente. Cliente que usa NOOP em laco tambem fica sabendo.
    if (!sessao.emIdle) {
      avisoPendente = true;
      return;
    }

    void (async () => {
      try {
        const pasta = sessao.pasta;
        if (!pasta) return;
        pasta.sequencia = await carregarSequencia(aviso.mailboxId, pasta.id);
        responder(socket, `* ${pasta.sequencia.length} EXISTS`);
      } catch (error) {
        log.warn("nao consegui avisar o cliente em IDLE", {
          endereco: sessao.endereco,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  });

  socket.once("close", () => pararDeOuvir());

  sessao.aguardarLinha = () =>
    new Promise<string | null>((resolve) => {
      entregarContinuacao = resolve;
    });

  async function drenar(): Promise<void> {
    if (ocupado) return;
    ocupado = true;

    while (fila.length > 0) {
      const item = fila.shift();
      if (item === undefined) break;
      try {
        await tratar(socket, sessao, item.texto, item.literais, tls);
      } catch (error) {
        log.error("erro ao tratar comando IMAP", {
          endereco: sessao.endereco,
          error: error instanceof Error ? error.message : String(error),
        });
        responder(socket, "* BAD erro interno");
      }

      // Fim de comando: janela segura para contar o que chegou enquanto o
      // cliente falava. Guardar e nunca entregar seria o mesmo que nao ter
      // avisado.
      if (avisoPendente && sessao.pasta) {
        avisoPendente = false;
        try {
          sessao.pasta.sequencia = await carregarSequencia(sessao.caixaId ?? "", sessao.pasta.id);
          responder(socket, `* ${sessao.pasta.sequencia.length} EXISTS`);
        } catch (error) {
          log.warn("nao consegui avisar sobre mensagem nova", {
            endereco: sessao.endereco,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    ocupado = false;
  }

  function abortar(motivo: string): void {
    responder(socket, `* BAD ${motivo}`);
    socket.destroy();
  }

  function processar(): boolean {
    for (;;) {
      if (faltam > 0) {
        if (buffer.length === 0) return true;
        const tomar = Math.min(faltam, buffer.length);
        pedacos.push(buffer.subarray(0, tomar));
        buffer = buffer.subarray(tomar);
        faltam -= tomar;
        if (faltam > 0) return true;

        const literal = Buffer.concat(pedacos);
        pedacos = [];
        literais.push(literal);

        // O corpo do APPEND NAO entra no texto do comando: os parenteses e as
        // aspas que existem dentro de qualquer e-mail seriam lidos como
        // sintaxe, e o servidor passaria a obedecer o conteudo da mensagem.
        if (!/^\S+\s+APPEND\b/i.test(texto)) texto += literal.toString("utf8");
        continue;
      }

      const quebra = buffer.indexOf(0x0a);
      if (quebra === -1) {
        // Linha sem fim a vista: alguem esta enchendo a memoria de proposito.
        if (buffer.length > 64 * 1024) {
          abortar("comando longo demais");
          return false;
        }
        return true;
      }

      const linha = buffer.subarray(0, quebra).toString("utf8").replace(/\r$/, "");
      buffer = buffer.subarray(quebra + 1);

      const anuncio = /\{(\d+)(\+?)\}$/.exec(linha);
      if (anuncio) {
        const tamanho = Number(anuncio[1]);
        const teto = sessao.estado === "nao-autenticado" ? LIMITE_LITERAL_ANONIMO : LIMITE_LITERAL;
        if (!Number.isFinite(tamanho) || tamanho > teto) {
          abortar("literal grande demais");
          return false;
        }

        texto += linha.slice(0, anuncio.index);
        faltam = tamanho;
        // LITERAL+ ({N+}) proibe a continuacao: o cliente ja esta mandando os
        // bytes, e um "+" a mais no meio do fluxo e erro de protocolo.
        if (anuncio[2] !== "+") socket.write("+ pronto\r\n");
        continue;
      }

      texto += linha;
      const completo = texto.trim();
      const acompanham = literais;
      texto = "";
      literais = [];

      if (!despachar(completo, acompanham)) return false;
    }
  }

  /** Devolve false quando a conexao nao deve mais ser lida (TLS assumiu). */
  function despachar(linha: string, acompanham: Buffer[]): boolean {
    // Continuacao pedida por AUTHENTICATE: a linha e credencial, nao comando.
    if (entregarContinuacao) {
      const entregar = entregarContinuacao;
      entregarContinuacao = null;
      entregar(linha === "*" ? null : linha);
      return true;
    }

    // DONE encerra o IDLE e nao carrega tag propria.
    if (sessao.emIdle && linha.toUpperCase() === "DONE") {
      responder(socket, `${sessao.emIdle} OK IDLE encerrado`);
      sessao.emIdle = null;
      return true;
    }

    if (/^\S+\s+STARTTLS\s*$/i.test(linha) && !sessao.seguro && tls) {
      const tag = linha.split(/\s+/)[0] ?? "*";
      responder(socket, `${tag} OK iniciando TLS`);

      /**
       * Passagem para TLS. Duas coisas precisam acontecer aqui, nesta ordem.
       *
       * 1. TUDO que ja estava no buffer e descartado. Bytes enviados junto com
       *    o STARTTLS chegaram em texto claro e nao vieram do dono da conexao
       *    autenticada — e o ataque classico de injecao de comando: o atacante
       *    cola "A1 LOGIN vitima senha" no mesmo pacote e o servidor executaria
       *    dentro da sessao ja cifrada, como se o cliente tivesse pedido.
       * 2. Os ouvintes do socket cru saem antes do TLSSocket assumir. Sem isso
       *    ficam dois leitores no mesmo descritor: o antigo consome bytes ja
       *    cifrados como se fossem comandos, e o handshake falha de formas
       *    dificeis de diagnosticar.
       */
      const descartados = buffer.length;
      buffer = Buffer.alloc(0);
      texto = "";
      literais = [];
      faltam = 0;
      fila.length = 0;

      if (descartados > 0) {
        log.warn("bytes enviados antes do TLS foram descartados", {
          ip: sessao.ip,
          bytes: descartados,
        });
      }

      socket.removeAllListeners("data");
      socket.removeAllListeners("timeout");

      const cifrado = new TLSSocket(socket, { isServer: true, ...tls });
      cifrado.on("secure", () => conduzir(cifrado, true, tls));
      cifrado.on("error", () => cifrado.destroy());
      return false;
    }

    if (linha !== "") fila.push({ texto: linha, literais: acompanham });
    return true;
  }

  socket.on("data", (pedaco: Buffer) => {
    buffer = buffer.length === 0 ? pedaco : Buffer.concat([buffer, pedaco]);
    if (!processar()) return;
    void drenar();
  });

  socket.on("timeout", () => {
    responder(socket, "* BYE sessao ociosa");
    socket.end();
  });
  socket.on("error", () => socket.destroy());

  // STARTTLS so entra no anuncio quando ha certificado carregado: prometer o
  // que nao existe faz o cliente tentar, levar BAD e desistir da conta.
  const caps = seguro
    ? "IMAP4rev1 UIDPLUS MOVE IDLE LITERAL+ ID NAMESPACE ENABLE AUTH=PLAIN"
    : `IMAP4rev1 ${tls ? "STARTTLS " : ""}LOGINDISABLED`;
  responder(socket, `* OK [CAPABILITY ${caps}] ${config.hostname} IMAP pronto`);
}

export function criarServidorImap(opcoes: { seguro: boolean; tls?: TlsOptions }): Server {
  if (opcoes.seguro && opcoes.tls) {
    return criarServidorTls(opcoes.tls, (socket) => conduzir(socket, true, opcoes.tls)) as unknown as Server;
  }
  return criarServidorTcp((socket) => conduzir(socket, false, opcoes.tls));
}
