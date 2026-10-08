import { createServer as criarServidorTcp, type Server, type Socket } from "node:net";
import { createServer as criarServidorTls, TLSSocket, type TlsOptions } from "node:tls";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { readRaw } from "../lib/storage.js";
import { autenticarCaixa } from "../services/mailboxAuth.js";
import { getSystemFolder } from "../services/folders.js";
import { moverParaPasta } from "../services/uid.js";

const log = createLogger("pop3");

/**
 * Servidor POP3 (RFC 1939).
 *
 * E o protocolo que o Gmail usa em "Verificar e-mails de outras contas" — a
 * unica forma de trazer uma caixa externa para dentro do Gmail. Sem ele, o
 * cliente que vive no Gmail nao consegue usar o e-mail da empresa dele.
 *
 * POP3 nao conhece pastas: enxerga apenas a Caixa de Entrada. E a lista de
 * mensagens fica CONGELADA no inicio da sessao, porque o protocolo numera as
 * mensagens de 1 a N e o cliente conta com essa numeracao ate desconectar —
 * mensagem nova chegando no meio nao pode reordenar nada.
 */

/** Mensagem visivel nesta sessao. A numeracao POP3 e o indice + 1. */
interface ItemSessao {
  id: string;
  storageKey: string;
  tamanho: number;
  apagada: boolean;
}

type Estado = "autorizacao" | "transacao";

interface Sessao {
  estado: Estado;
  usuario: string | null;
  caixaId: string | null;
  endereco: string | null;
  itens: ItemSessao[];
  seguro: boolean;
  ip: string;
}

function escrever(socket: Socket, linha: string): void {
  socket.write(`${linha}\r\n`);
}

/**
 * Resposta de varias linhas: o ponto final sozinho encerra, e por isso toda
 * linha do conteudo que ja comeca com ponto ganha um ponto extra — senao um
 * e-mail com ".", numa linha sozinha, cortaria a mensagem ao meio.
 */
function escreverMultilinha(socket: Socket, cabecalho: string, corpo: string): void {
  const recheado = corpo
    .split(/\r?\n/)
    .map((linha) => (linha.startsWith(".") ? `.${linha}` : linha))
    .join("\r\n");

  socket.write(`+OK ${cabecalho}\r\n${recheado}\r\n.\r\n`);
}

/** Carrega a Caixa de Entrada e congela a lista para a sessao inteira. */
async function carregarEntrada(caixaId: string): Promise<ItemSessao[]> {
  const entrada = await getSystemFolder(caixaId, "inbox");

  const mensagens = await prisma.message.findMany({
    where: { mailboxId: caixaId, folderId: entrada.id },
    orderBy: { receivedAt: "asc" },
    select: { id: true, storageKey: true, sizeBytes: true },
  });

  return mensagens.map((m) => ({
    id: m.id,
    storageKey: m.storageKey,
    tamanho: m.sizeBytes,
    apagada: false,
  }));
}

/**
 * Aplica o que foi marcado com DELE, no fechamento da sessao.
 *
 * Move para a Lixeira em vez de destruir. O cliente quase sempre tem tambem o
 * webmail, e o Gmail marca para apagar por padrao ao baixar — destruir aqui
 * significaria o cliente perder no webmail o que o Gmail acabou de puxar.
 * Na Lixeira ele reencontra, e a faxina dos 30 dias limpa depois.
 */
async function aplicarExclusoes(caixaId: string, itens: ItemSessao[]): Promise<number> {
  const marcadas = itens.filter((item) => item.apagada).map((item) => item.id);
  if (marcadas.length === 0) return 0;

  const lixeira = await getSystemFolder(caixaId, "trash");

  await prisma.message.updateMany({
    where: { id: { in: marcadas }, mailboxId: caixaId },
    data: { seen: true },
  });

  return moverParaPasta(caixaId, marcadas, lixeira.id);
}

function ativas(itens: ItemSessao[]): ItemSessao[] {
  return itens.filter((item) => !item.apagada);
}

/** Resolve o numero que o cliente mandou (1..N) no item correspondente. */
function porNumero(sessao: Sessao, argumento: string): ItemSessao | null {
  const numero = Number.parseInt(argumento, 10);
  if (!Number.isInteger(numero) || numero < 1 || numero > sessao.itens.length) return null;
  const item = sessao.itens[numero - 1];
  return item && !item.apagada ? item : null;
}

async function tratarComando(socket: Socket, sessao: Sessao, bruto: string): Promise<void> {
  const [comandoBruto = "", ...args] = bruto.trim().split(/\s+/);
  const comando = comandoBruto.toUpperCase();
  const arg = args[0] ?? "";

  // --- Sempre disponiveis ---

  if (comando === "QUIT") {
    if (sessao.estado === "transacao" && sessao.caixaId) {
      const movidas = await aplicarExclusoes(sessao.caixaId, sessao.itens).catch(() => 0);
      if (movidas > 0) log.info("mensagens movidas para a lixeira via POP3", { caixaId: sessao.caixaId, movidas });
    }
    escrever(socket, "+OK ate logo");
    socket.end();
    return;
  }

  if (comando === "NOOP") return escrever(socket, "+OK");

  if (comando === "CAPA") {
    const capacidades = ["TOP", "UIDL", "USER", "RESP-CODES", "PIPELINING"];
    if (!sessao.seguro) capacidades.push("STLS");
    return escreverMultilinha(socket, "lista de capacidades", capacidades.join("\r\n"));
  }

  // --- Autorizacao ---

  if (sessao.estado === "autorizacao") {
    if (comando === "USER") {
      sessao.usuario = arg;
      return escrever(socket, "+OK envie a senha");
    }

    if (comando === "PASS") {
      // Senha em texto claro so com TLS. POP3 sem criptografia entrega a
      // credencial da caixa para qualquer um no caminho.
      if (!sessao.seguro) {
        return escrever(socket, "-ERR use STLS ou conecte na porta 995 antes de enviar a senha");
      }
      if (!sessao.usuario) return escrever(socket, "-ERR envie USER primeiro");

      const resultado = await autenticarCaixa(sessao.usuario, bruto.slice(5).trim(), sessao.ip, "pop3");

      if (!resultado.ok) {
        if (resultado.motivo === "bloqueada") {
          return escrever(socket, "-ERR muitas tentativas; tente novamente em alguns minutos");
        }
        if (resultado.motivo === "suspensa") {
          return escrever(socket, "-ERR caixa suspensa; regularize o acesso no painel");
        }
        return escrever(socket, "-ERR usuario ou senha invalidos");
      }

      sessao.caixaId = resultado.caixa.id;
      sessao.endereco = resultado.caixa.address;
      sessao.itens = await carregarEntrada(resultado.caixa.id);
      sessao.estado = "transacao";

      const total = ativas(sessao.itens).reduce((soma, item) => soma + item.tamanho, 0);
      log.info("sessao POP3 aberta", { endereco: sessao.endereco, mensagens: sessao.itens.length });
      return escrever(socket, `+OK ${sessao.itens.length} mensagens (${total} bytes)`);
    }

    return escrever(socket, "-ERR autentique primeiro");
  }

  // --- Transacao ---

  if (comando === "STAT") {
    const vivas = ativas(sessao.itens);
    const bytes = vivas.reduce((soma, item) => soma + item.tamanho, 0);
    return escrever(socket, `+OK ${vivas.length} ${bytes}`);
  }

  if (comando === "LIST" || comando === "UIDL") {
    const uidl = comando === "UIDL";

    if (arg) {
      const item = porNumero(sessao, arg);
      if (!item) return escrever(socket, "-ERR mensagem inexistente");
      const numero = sessao.itens.indexOf(item) + 1;
      return escrever(socket, `+OK ${numero} ${uidl ? item.id : item.tamanho}`);
    }

    const linhas = sessao.itens
      .map((item, indice) => (item.apagada ? null : `${indice + 1} ${uidl ? item.id : item.tamanho}`))
      .filter((linha): linha is string => linha !== null);

    return escreverMultilinha(socket, `${linhas.length} mensagens`, linhas.join("\r\n"));
  }

  if (comando === "RETR" || comando === "TOP") {
    const item = porNumero(sessao, arg);
    if (!item) return escrever(socket, "-ERR mensagem inexistente");

    const bruto = (await readRaw(item.storageKey)).toString("utf8");

    if (comando === "RETR") {
      // Baixar conta como ler: o cliente ja tem a mensagem na mao.
      void prisma.message.update({ where: { id: item.id }, data: { seen: true } }).catch(() => undefined);
      return escreverMultilinha(socket, `${item.tamanho} bytes`, bruto);
    }

    // TOP <n> <linhas>: cabecalhos inteiros + N linhas do corpo. E como o
    // cliente decide se vale a pena baixar a mensagem toda.
    const quantas = Number.parseInt(args[1] ?? "0", 10);
    if (!Number.isInteger(quantas) || quantas < 0) return escrever(socket, "-ERR numero de linhas invalido");

    const separador = bruto.search(/\r?\n\r?\n/);
    const cabecalhos = separador === -1 ? bruto : bruto.slice(0, separador);
    const corpo = separador === -1 ? "" : bruto.slice(separador).replace(/^\r?\n\r?\n/, "");

    const trecho = corpo.split(/\r?\n/).slice(0, quantas).join("\r\n");
    return escreverMultilinha(socket, "cabecalhos e inicio do corpo", `${cabecalhos}\r\n\r\n${trecho}`);
  }

  if (comando === "DELE") {
    const item = porNumero(sessao, arg);
    if (!item) return escrever(socket, "-ERR mensagem inexistente");
    item.apagada = true;
    return escrever(socket, `+OK mensagem ${arg} marcada para remocao`);
  }

  if (comando === "RSET") {
    // Desfaz as marcacoes: o RFC garante que RSET traz tudo de volta.
    for (const item of sessao.itens) item.apagada = false;
    const bytes = sessao.itens.reduce((soma, item) => soma + item.tamanho, 0);
    return escrever(socket, `+OK ${sessao.itens.length} mensagens (${bytes} bytes)`);
  }

  return escrever(socket, `-ERR comando desconhecido: ${comando}`);
}

function conduzirSessao(socket: Socket, seguro: boolean, tls?: TlsOptions): void {
  socket.setTimeout(10 * 60_000);

  const sessao: Sessao = {
    estado: "autorizacao",
    usuario: null,
    caixaId: null,
    endereco: null,
    itens: [],
    seguro,
    ip: socket.remoteAddress ?? "",
  };

  let acumulado = "";
  let ocupado = false;
  const fila: string[] = [];

  async function drenar(): Promise<void> {
    if (ocupado) return;
    ocupado = true;

    while (fila.length > 0) {
      const linha = fila.shift();
      if (linha === undefined) break;
      try {
        await tratarComando(socket, sessao, linha);
      } catch (error) {
        log.error("erro ao tratar comando POP3", {
          endereco: sessao.endereco,
          error: error instanceof Error ? error.message : String(error),
        });
        escrever(socket, "-ERR erro interno");
      }
    }

    ocupado = false;
  }

  socket.on("data", (pedaco: Buffer) => {
    acumulado += pedaco.toString("utf8");

    // Linha absurda so pode ser tentativa de estourar a memoria do processo.
    if (acumulado.length > 8192) {
      escrever(socket, "-ERR comando longo demais");
      socket.destroy();
      return;
    }

    let quebra = acumulado.indexOf("\n");
    while (quebra !== -1) {
      const linha = acumulado.slice(0, quebra).replace(/\r$/, "");
      acumulado = acumulado.slice(quebra + 1);

      // STLS troca o socket por um cifrado; o resto da sessao continua nele.
      if (linha.trim().toUpperCase() === "STLS" && !sessao.seguro && tls) {
        escrever(socket, "+OK iniciando TLS");
        const cifrado = new TLSSocket(socket, { isServer: true, ...tls });
        cifrado.on("secure", () => conduzirSessao(cifrado, true, tls));
        return;
      }

      if (linha.trim() !== "") fila.push(linha);
      quebra = acumulado.indexOf("\n");
    }

    void drenar();
  });

  socket.on("timeout", () => {
    escrever(socket, "-ERR sessao ociosa por tempo demais");
    socket.end();
  });

  socket.on("error", () => socket.destroy());

  if (!seguro || socket instanceof TLSSocket) {
    escrever(socket, `+OK ${config.hostname} POP3 pronto`);
  }
}

export function criarServidorPop3(opcoes: { seguro: boolean; tls?: TlsOptions }): Server {
  if (opcoes.seguro && opcoes.tls) {
    const servidor = criarServidorTls(opcoes.tls, (socket) => conduzirSessao(socket, true, opcoes.tls));
    return servidor as unknown as Server;
  }

  return criarServidorTcp((socket) => conduzirSessao(socket, false, opcoes.tls));
}
