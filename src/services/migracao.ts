import { ImapFlow } from "imapflow";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { deliverToMailbox } from "../mta/deliver-local.js";
import { getSystemFolder, type SystemFolderKind } from "./folders.js";

const log = createLogger("migracao");

/**
 * Migracao assistida: traz a caixa do provedor antigo para ca, por IMAP.
 *
 * E o que remove o maior atrito da venda. Ninguem troca de e-mail sabendo que
 * vai perder dez anos de historico — e "exporta um .mbox e me manda" nao e algo
 * que um dono de loja vai fazer. Aqui o cliente informa servidor, usuario e
 * senha do provedor atual e a copia acontece sozinha.
 *
 * Funciona hoje, apesar da porta 25 de saida ainda estar bloqueada pela
 * Hetzner: copiar caixa e conexao de SAIDA na 993, que esta liberada. Ou seja,
 * da para migrar cliente antes mesmo de conseguir enviar e-mail.
 */

/** Quantas mensagens buscar de uma vez. Lote grande estoura a memoria. */
const LOTE = 20;

/** Teto por mensagem: acima disso, pula e conta como ignorada. */
const TAMANHO_MAXIMO = 40 * 1024 * 1024;

export class MigracaoError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "MigracaoError";
  }
}

/**
 * Traduz o nome da pasta de origem para uma pasta nossa.
 *
 * Duas camadas: primeiro os atributos especiais que o servidor anuncia
 * (\Sent, \Trash), que funcionam em qualquer idioma; depois o nome, para
 * servidores que nao anunciam nada. A ordem importa — "Sent Mail" do Gmail vem
 * anunciado, mas "Elementos enviados" do Outlook em espanhol so da para
 * reconhecer pelo nome.
 */
const POR_NOME: Record<string, SystemFolderKind> = {
  inbox: "inbox",
  "caixa de entrada": "inbox",
  sent: "sent",
  "sent items": "sent",
  "sent mail": "sent",
  enviados: "sent",
  "itens enviados": "sent",
  "elementos enviados": "sent",
  drafts: "drafts",
  rascunhos: "drafts",
  borradores: "drafts",
  trash: "trash",
  deleted: "trash",
  "deleted items": "trash",
  lixeira: "trash",
  "itens excluidos": "trash",
  spam: "spam",
  junk: "spam",
  "junk e-mail": "spam",
  "lixo eletronico": "spam",
};

/**
 * "Arquivo" nao e pasta de sistema aqui: ela chega como pasta comum, com o
 * nome que o cliente ja usava. Renomear a pasta de alguem na migracao e uma
 * forma barata de fazer a pessoa achar que perdeu e-mail.
 */

function traduzirPasta(nome: string, atributos: string[]): SystemFolderKind | "propria" {
  const marcas = atributos.map((a) => a.toLowerCase());
  if (marcas.includes("\\sent")) return "sent";
  if (marcas.includes("\\trash")) return "trash";
  if (marcas.includes("\\drafts")) return "drafts";
  if (marcas.includes("\\junk")) return "spam";

  const limpo = nome
    .split(/[/.]/)
    .pop()!
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();

  if (limpo === "inbox") return "inbox";
  return POR_NOME[limpo] ?? "propria";
}

/**
 * Pastas que NAO valem a viagem.
 *
 * "Todos os e-mails" do Gmail e uma visao virtual: cada mensagem ja aparece na
 * pasta real dela, entao copiar essa tambem duplicaria a caixa inteira. Lixeira
 * e spam sao escolha do cliente na tela.
 */
function devePular(nome: string, atributos: string[]): boolean {
  const marcas = atributos.map((a) => a.toLowerCase());
  if (marcas.includes("\\all") || marcas.includes("\\noselect")) return true;
  const limpo = nome.toLowerCase();
  return limpo.includes("[gmail]/all mail") || limpo.includes("[gmail]/todos os e-mails");
}

export async function testarConexao(input: {
  host: string;
  port: number;
  user: string;
  password: string;
}): Promise<{ ok: true; pastas: number; mensagens: number }> {
  const cliente = new ImapFlow({
    host: input.host,
    port: input.port,
    secure: true,
    auth: { user: input.user, pass: input.password },
    logger: false,
    // O provedor antigo pode demorar; melhor falhar em 20s do que pendurar a
    // requisicao do cliente por minutos.
    socketTimeout: 20_000,
  });

  try {
    await cliente.connect();
    const lista = await cliente.list();
    const uteis = lista.filter((p) => !devePular(p.path, p.flags ? [...p.flags] : []));

    let total = 0;
    for (const pasta of uteis) {
      const status = await cliente.status(pasta.path, { messages: true });
      total += status.messages ?? 0;
    }

    return { ok: true, pastas: uteis.length, mensagens: total };
  } catch (error) {
    /**
     * Distinguir "senha errada" de "servidor fora do ar" e o que decide se o
     * cliente conserta sozinho ou abre chamado.
     *
     * A mensagem do erro nao serve para isso: o cliente IMAP resume tudo como
     * "Command failed". Quem sabe a diferenca e a flag que ele mesmo levanta ao
     * ver o NO no AUTHENTICATE.
     */
    const detalhe = error as { authenticationFailed?: boolean; responseText?: string };
    const mensagem = error instanceof Error ? error.message : String(error);
    const textoServidor = detalhe.responseText ?? "";

    if (
      detalhe.authenticationFailed === true ||
      /auth|login|credential|invalid|senha|usuario/i.test(`${mensagem} ${textoServidor}`)
    ) {
      // Nao repassamos o texto cru do provedor: costuma vir com URL de suporte,
      // id de sessao e, em alguns, o proprio endereco tentado.
      throw new MigracaoError("Usuario ou senha recusados pelo provedor antigo.", 401);
    }
    throw new MigracaoError(`Nao consegui conectar em ${input.host}:${input.port}.`, 502);
  } finally {
    await cliente.logout().catch(() => undefined);
  }
}

export async function agendarMigracao(input: {
  mailboxId: string;
  host: string;
  port?: number;
  user: string;
  password: string;
}): Promise<{ id: string; mensagensEstimadas: number }> {
  const emAndamento = await prisma.mailMigration.findFirst({
    where: { mailboxId: input.mailboxId, status: { in: ["pendente", "copiando"] } },
    select: { id: true },
  });
  if (emAndamento) {
    throw new MigracaoError("Ja existe uma migracao em andamento para esta caixa.", 409);
  }

  const porta = input.port ?? 993;
  const teste = await testarConexao({
    host: input.host,
    port: porta,
    user: input.user,
    password: input.password,
  });

  const criada = await prisma.mailMigration.create({
    data: {
      mailboxId: input.mailboxId,
      sourceHost: input.host,
      sourcePort: porta,
      sourceUser: input.user,
      sourceSecret: encryptSecret(input.password),
      totalMessages: teste.mensagens,
      status: "pendente",
    },
    select: { id: true },
  });

  log.info("migracao agendada", {
    mailboxId: input.mailboxId,
    host: input.host,
    mensagens: teste.mensagens,
  });

  return { id: criada.id, mensagensEstimadas: teste.mensagens };
}

/**
 * Copia uma migracao inteira. Chamada pelo worker, nao pela API: a requisicao
 * do cliente responde na hora e a copia segue em segundo plano.
 */
export async function executarMigracao(migracaoId: string): Promise<void> {
  const migracao = await prisma.mailMigration.findUnique({
    where: { id: migracaoId },
    select: {
      id: true,
      mailboxId: true,
      sourceHost: true,
      sourcePort: true,
      sourceUser: true,
      sourceSecret: true,
      status: true,
      copiedMessages: true,
      skippedMessages: true,
      copiedBytes: true,
    },
  });

  if (!migracao || !migracao.sourceSecret) return;
  if (migracao.status !== "pendente") return;

  await prisma.mailMigration.update({
    where: { id: migracaoId },
    data: { status: "copiando", startedAt: new Date() },
  });

  const cliente = new ImapFlow({
    host: migracao.sourceHost,
    port: migracao.sourcePort,
    secure: true,
    auth: { user: migracao.sourceUser, pass: decryptSecret(migracao.sourceSecret) },
    logger: false,
    socketTimeout: 120_000,
  });

  let copiadas = migracao.copiedMessages;
  let ignoradas = migracao.skippedMessages;
  let bytes = migracao.copiedBytes;

  try {
    await cliente.connect();
    const pastas = await cliente.list();

    for (const pasta of pastas) {
      const atributos = pasta.flags ? [...pasta.flags] : [];
      if (devePular(pasta.path, atributos)) continue;

      const destinoTipo = traduzirPasta(pasta.path, atributos);
      const destino =
        destinoTipo === "propria"
          ? await pastaPropria(migracao.mailboxId, pasta.name || pasta.path)
          : await getSystemFolder(migracao.mailboxId, destinoTipo);

      // Quando um cliente reclamar que "os enviados vieram para a entrada",
      // esta linha responde na hora se o problema foi a traducao da pasta.
      log.info("pasta traduzida", {
        migracaoId,
        origem: pasta.path,
        atributos: atributos.join(","),
        destino: destinoTipo,
      });

      await prisma.mailMigration.update({
        where: { id: migracaoId },
        data: { currentFolder: pasta.name || pasta.path },
      });

      /**
       * Uma pasta problematica nao pode matar a migracao inteira.
       *
       * Provedor antigo tem pasta com nome estranho, pasta que o servidor
       * anuncia mas nao deixa abrir, pasta corrompida. Perder o historico todo
       * por causa de uma delas seria trocar um problema pequeno por um enorme.
       */
      let trava;
      try {
        trava = await cliente.getMailboxLock(pasta.path);
      } catch (falha) {
        log.warn("nao consegui abrir a pasta de origem; seguindo sem ela", {
          migracaoId,
          pasta: pasta.path,
          error: falha instanceof Error ? falha.message : String(falha),
        });
        continue;
      }

      try {
        const caixaAberta = cliente.mailbox;
        const existentes = typeof caixaAberta === "object" ? caixaAberta.exists : 0;
        if (!existentes) continue;

        for (let inicio = 1; inicio <= existentes; inicio += LOTE) {
          const fim = Math.min(inicio + LOTE - 1, existentes);

          for await (const mensagem of cliente.fetch(`${inicio}:${fim}`, {
            source: true,
            flags: true,
            internalDate: true,
            size: true,
          })) {
            const bruto = mensagem.source;
            if (!bruto || bruto.byteLength === 0) {
              ignoradas += 1;
              continue;
            }

            if (bruto.byteLength > TAMANHO_MAXIMO) {
              // Nao derruba a migracao inteira por causa de um anexo gigante:
              // conta como ignorada e o cliente ve o numero na tela.
              ignoradas += 1;
              log.warn("mensagem grande demais, ignorada", {
                migracaoId,
                pasta: pasta.path,
                bytes: bruto.byteLength,
              });
              continue;
            }

            const marcas = mensagem.flags ? [...mensagem.flags].map((f) => f.toLowerCase()) : [];
            const guardada = await copiarUma({
              mailboxId: migracao.mailboxId,
              folderId: destino.id,
              raw: bruto,
              flags: {
                seen: marcas.includes("\\seen"),
                flagged: marcas.includes("\\flagged"),
                answered: marcas.includes("\\answered"),
                draft: marcas.includes("\\draft"),
              },
            });

            if (guardada) {
              copiadas += 1;
              bytes += BigInt(bruto.byteLength);
            } else {
              ignoradas += 1;
            }
          }

          await prisma.mailMigration.update({
            where: { id: migracaoId },
            data: { copiedMessages: copiadas, skippedMessages: ignoradas, copiedBytes: bytes },
          });
        }
      } finally {
        trava.release();
      }
    }

    await prisma.mailMigration.update({
      where: { id: migracaoId },
      data: {
        status: "concluida",
        finishedAt: new Date(),
        currentFolder: null,
        copiedMessages: copiadas,
        skippedMessages: ignoradas,
        copiedBytes: bytes,
        // A senha do provedor antigo sai do banco assim que deixa de ser util.
        sourceSecret: null,
      },
    });

    await prisma.mailEvent.create({
      data: {
        mailboxId: migracao.mailboxId,
        type: "migration.completed",
        severity: "info",
        payload: { migracaoId, copiadas, ignoradas, bytes: bytes.toString() },
      },
    });

    log.info("migracao concluida", { migracaoId, copiadas, ignoradas });
  } catch (error) {
    const mensagem = error instanceof Error ? error.message : String(error);

    await prisma.mailMigration.update({
      where: { id: migracaoId },
      data: {
        status: "falhou",
        finishedAt: new Date(),
        lastError: mensagem.slice(0, 2000),
        copiedMessages: copiadas,
        skippedMessages: ignoradas,
        copiedBytes: bytes,
        sourceSecret: null,
      },
    });

    log.error("migracao falhou", { migracaoId, error: mensagem, copiadas });
  } finally {
    await cliente.logout().catch(() => undefined);
  }
}

/** Cria (ou reaproveita) uma pasta com o mesmo nome da origem. */
async function pastaPropria(mailboxId: string, nome: string) {
  const limpo = nome.slice(0, 60).trim() || "Importados";
  const existente = await prisma.mailFolder.findFirst({
    where: { mailboxId, name: limpo },
    select: { id: true },
  });
  if (existente) return existente;

  const { createFolder } = await import("./folders.js");
  return createFolder(mailboxId, limpo);
}

/**
 * Grava uma mensagem, sem deixar duplicata.
 *
 * Migracao interrompida e retomada e o caso normal, nao a excecao — por isso a
 * conferencia pelo Message-ID antes de gravar. Sem ela, o cliente que roda a
 * migracao duas vezes fica com a caixa dobrada.
 */
async function copiarUma(input: {
  mailboxId: string;
  folderId: string;
  raw: Buffer;
  flags: { seen: boolean; flagged: boolean; answered: boolean; draft: boolean };
}): Promise<boolean> {
  const cabecalho = input.raw.subarray(0, 8192).toString("utf8");
  const messageId = /^message-id:\s*(<[^>]+>)/im.exec(cabecalho)?.[1];

  if (messageId) {
    const jaTem = await prisma.message.findFirst({
      where: { mailboxId: input.mailboxId, folderId: input.folderId, rfcMessageId: messageId },
      select: { id: true },
    });
    if (jaTem) return false;
  }

  const caixa = await prisma.mailbox.findUnique({
    where: { id: input.mailboxId },
    select: { id: true, domainId: true, quotaBytes: true, usedBytes: true, status: true },
  });
  if (!caixa) return false;

  const resultado = await deliverToMailbox(
    {
      kind: "mailbox",
      mailboxId: caixa.id,
      domainId: caixa.domainId,
      quotaBytes: caixa.quotaBytes,
      usedBytes: caixa.usedBytes,
      status: caixa.status,
    },
    input.raw,
    null,
    { forceFolderId: input.folderId, flags: input.flags },
  );

  if (resultado.status !== "delivered") {
    if (resultado.status === "rejected" && resultado.code === 552) {
      throw new MigracaoError("A caixa encheu durante a migracao.", 507);
    }
    return false;
  }

  return true;
}

export async function verMigracao(mailboxId: string) {
  const migracao = await prisma.mailMigration.findFirst({
    where: { mailboxId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      sourceHost: true,
      sourceUser: true,
      status: true,
      totalMessages: true,
      copiedMessages: true,
      skippedMessages: true,
      copiedBytes: true,
      currentFolder: true,
      lastError: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
    },
  });

  if (!migracao) return null;

  const total = migracao.totalMessages;
  const feitas = migracao.copiedMessages + migracao.skippedMessages;

  return {
    ...migracao,
    copiedBytes: migracao.copiedBytes.toString(),
    percentual: total > 0 ? Math.min(100, Math.round((feitas / total) * 100)) : 0,
  };
}

export async function cancelarMigracao(mailboxId: string, migracaoId: string): Promise<void> {
  const atualizadas = await prisma.mailMigration.updateMany({
    where: { id: migracaoId, mailboxId, status: { in: ["pendente", "copiando"] } },
    // A senha sai junto: migracao cancelada nao tem por que guardar credencial
    // do provedor antigo.
    data: { status: "cancelada", finishedAt: new Date(), sourceSecret: null },
  });

  if (atualizadas.count === 0) {
    throw new MigracaoError("Migracao nao encontrada ou ja encerrada.", 404);
  }
}

/**
 * Worker: pega uma migracao pendente por vez.
 *
 * Uma por vez de proposito. Duas copias simultaneas de 5 GB no mesmo servidor
 * que roda o resto da stack derrubariam tudo por memoria — e migracao nao tem
 * pressa, o cliente ja esta usando a caixa nova enquanto o historico chega.
 */
export function iniciarWorkerMigracao(intervalMs = 30_000): () => void {
  let rodando = false;

  const tique = async () => {
    if (rodando) return;
    rodando = true;

    try {
      const proxima = await prisma.mailMigration.findFirst({
        where: { status: "pendente" },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });

      if (proxima) await executarMigracao(proxima.id);
    } catch (error) {
      log.error("erro no worker de migracao", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      rodando = false;
    }
  };

  const timer = setInterval(() => void tique(), intervalMs);
  timer.unref?.();

  log.info("worker de migracao no ar", { intervalMs, hostname: config.hostname });
  return () => clearInterval(timer);
}
