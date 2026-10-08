import { simpleParser } from "mailparser";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { deleteRaw, readRaw } from "../lib/storage.js";
import { htmlParaTexto, sanitizeMessageHtml } from "../lib/sanitize.js";
import { getSystemFolder, resolveFolder, type SystemFolderKind, ensureSystemFolders } from "./folders.js";
import { moverParaPasta } from "./uid.js";

const log = createLogger("messages");

/**
 * Acesso as mensagens da caixa — o que o webmail consome.
 *
 * Regra que vale para TODAS as funcoes deste arquivo: nenhuma consulta usa o
 * id da mensagem sozinho. O `mailboxId` da sessao entra sempre no `where`.
 * Um IDOR aqui expoe a correspondencia de um cliente para outro; a defesa
 * precisa ser estrutural, nao lembrada caso a caso.
 */

export class MessageError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "MessageError";
  }
}

const LIMITE_PADRAO = 30;
const LIMITE_MAXIMO = 100;

// ---------------------------------------------------------------------------
// Paginacao por cursor
// ---------------------------------------------------------------------------

interface Cursor {
  receivedAt: Date;
  id: string;
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(`${cursor.receivedAt.toISOString()}|${cursor.id}`).toString("base64url");
}

/**
 * Cursor por (receivedAt, id) em vez de offset: com offset, mensagem nova
 * chegando durante a rolagem empurra a lista e o usuario ve item repetido ou
 * pula item.
 */
function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const [iso, id] = Buffer.from(raw, "base64url").toString("utf8").split("|");
    if (!iso || !id) return null;
    const receivedAt = new Date(iso);
    return Number.isNaN(receivedAt.getTime()) ? null : { receivedAt, id };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Visao geral e pastas
// ---------------------------------------------------------------------------

export async function getOverview(mailboxId: string) {
  const mailbox = await prisma.mailbox.findUnique({
    where: { id: mailboxId },
    select: {
      id: true,
      localPart: true,
      displayName: true,
      status: true,
      quotaBytes: true,
      usedBytes: true,
      lastLoginAt: true,
      totpEnabledAt: true,
      domain: { select: { name: true, status: true } },
    },
  });
  if (!mailbox) throw new MessageError("Caixa nao encontrada.", 404);

  const usoPercentual = mailbox.quotaBytes > 0n
    ? Number((mailbox.usedBytes * 10000n) / mailbox.quotaBytes) / 100
    : 0;

  return {
    address: `${mailbox.localPart}@${mailbox.domain.name}`,
    displayName: mailbox.displayName,
    status: mailbox.status,
    domainStatus: mailbox.domain.status,
    quotaBytes: mailbox.quotaBytes.toString(),
    usedBytes: mailbox.usedBytes.toString(),
    usoPercentual,
    lastLoginAt: mailbox.lastLoginAt,
    twoFactorEnabled: mailbox.totpEnabledAt !== null,
  };
}

export async function listFolders(mailboxId: string) {
  // Garante as pastas de sistema antes de listar. Sem isto, tipo novo (o
  // Arquivo, criado em 31/08/2026) so apareceria em caixa criada depois dele:
  // as antigas nunca teriam a pasta, porque nada mais a pediria. O createMany
  // com skipDuplicates torna a chamada barata e idempotente.
  await ensureSystemFolders(mailboxId);

  const folders = await prisma.mailFolder.findMany({
    where: { mailboxId },
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, kind: true },
  });

  // Duas agregacoes em vez de uma contagem por pasta: N+1 com 5 pastas ja e
  // desperdicio, e com pasta customizada vira problema.
  const [totais, naoLidas] = await Promise.all([
    prisma.message.groupBy({ by: ["folderId"], where: { mailboxId }, _count: { _all: true } }),
    prisma.message.groupBy({ by: ["folderId"], where: { mailboxId, seen: false }, _count: { _all: true } }),
  ]);

  const mapaTotal = new Map(totais.map((linha) => [linha.folderId, linha._count._all]));
  const mapaNaoLidas = new Map(naoLidas.map((linha) => [linha.folderId, linha._count._all]));

  return folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    kind: folder.kind,
    total: mapaTotal.get(folder.id) ?? 0,
    unread: mapaNaoLidas.get(folder.id) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// Listagem
// ---------------------------------------------------------------------------

export interface ListMessagesInput {
  mailboxId: string;
  folder?: SystemFolderKind | string;
  cursor?: string;
  limit?: number;
  query?: string;
  unreadOnly?: boolean;
  flaggedOnly?: boolean;
  /** So mensagens com anexo: qualquer arquivo, imagem ou PDF. */
  attachment?: AttachmentFilter;
}

export const ATTACHMENT_FILTERS = ["any", "image", "pdf"] as const;
export type AttachmentFilter = (typeof ATTACHMENT_FILTERS)[number];

export function parseAttachmentFilter(valor: string | null | undefined): AttachmentFilter | undefined {
  return ATTACHMENT_FILTERS.find((filtro) => filtro === valor);
}

const EXTENSOES_IMAGEM = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp", ".tif", ".tiff", ".svg"];

/**
 * Imagem embutida no corpo (com Content-ID) abaixo deste tamanho e quase
 * sempre logo de assinatura. Sem o corte, "Imagens" e "Arquivos" trariam
 * praticamente todo e-mail corporativo. Foto colada no corpo passa do corte e
 * continua aparecendo.
 */
const IMAGEM_EMBUTIDA_MINIMA = 50 * 1024;

function attachmentWhere(filtro: AttachmentFilter): Record<string, unknown> {
  // O tipo declarado nao basta: muito cliente manda PDF e foto como
  // application/octet-stream, e ai so o nome do arquivo diz o que e.
  const nomeTermina = (extensao: string) => ({ filename: { endsWith: extensao, mode: "insensitive" } });
  const ehImagem = {
    OR: [{ contentType: { startsWith: "image/", mode: "insensitive" } }, ...EXTENSOES_IMAGEM.map(nomeTermina)],
  };
  const logoDeAssinatura = {
    AND: [ehImagem, { contentId: { not: null } }, { sizeBytes: { lt: IMAGEM_EMBUTIDA_MINIMA } }],
  };

  if (filtro === "pdf") {
    return { OR: [{ contentType: { equals: "application/pdf", mode: "insensitive" } }, nomeTermina(".pdf")] };
  }
  if (filtro === "image") return { AND: [ehImagem, { NOT: logoDeAssinatura }] };
  return { NOT: logoDeAssinatura };
}

export async function listMessages(input: ListMessagesInput) {
  const limit = Math.min(Math.max(input.limit ?? LIMITE_PADRAO, 1), LIMITE_MAXIMO);
  const cursor = decodeCursor(input.cursor);

  const where: Record<string, unknown> = { mailboxId: input.mailboxId };

  if (input.folder) {
    const folder = await prisma.mailFolder.findFirst({
      where: { mailboxId: input.mailboxId, OR: [{ kind: input.folder }, { id: input.folder }] },
      select: { id: true },
    });
    if (!folder) throw new MessageError(`Pasta nao encontrada: ${input.folder}`, 404);
    where.folderId = folder.id;
  }

  if (input.unreadOnly) where.seen = false;
  if (input.flaggedOnly) where.flagged = true;
  if (input.attachment) where.attachments = { some: attachmentWhere(input.attachment) };

  const termo = input.query?.trim();
  if (termo) {
    // ILIKE com curinga a esquerda nao usa indice. Aceitavel no volume da
    // Fase 1; quando incomodar, a troca e para tsvector + GIN nesta mesma
    // funcao, sem mexer no resto.
    where.OR = [
      { subject: { contains: termo, mode: "insensitive" } },
      { fromAddress: { contains: termo, mode: "insensitive" } },
      { fromName: { contains: termo, mode: "insensitive" } },
      { snippet: { contains: termo, mode: "insensitive" } },
      { bodyText: { contains: termo, mode: "insensitive" } },
      { attachments: { some: { filename: { contains: termo, mode: "insensitive" } } } },
    ];
  }

  if (cursor) {
    where.AND = [
      {
        OR: [
          { receivedAt: { lt: cursor.receivedAt } },
          { receivedAt: cursor.receivedAt, id: { lt: cursor.id } },
        ],
      },
    ];
  }

  // Pede um a mais para saber se ha proxima pagina sem um count() extra.
  const linhas = await prisma.message.findMany({
    where,
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      folderId: true,
      threadKey: true,
      fromAddress: true,
      fromName: true,
      toAddresses: true,
      subject: true,
      snippet: true,
      seen: true,
      flagged: true,
      answered: true,
      hasAttachments: true,
      sizeBytes: true,
      spamScore: true,
      quarantineReason: true,
      authResult: true,
      receivedAt: true,
    },
  });

  const temMais = linhas.length > limit;
  const pagina = temMais ? linhas.slice(0, limit) : linhas;
  const ultimo = pagina[pagina.length - 1];

  return {
    messages: pagina.map((mensagem) => ({
      ...mensagem,
      /** Selo de remetente verificado: DKIM valido e DMARC passando. */
      senderVerified: isVerified(mensagem.authResult),
      authResult: undefined,
    })),
    nextCursor: temMais && ultimo ? encodeCursor({ receivedAt: ultimo.receivedAt, id: ultimo.id }) : null,
  };
}

function isVerified(authResult: unknown): boolean {
  if (!authResult || typeof authResult !== "object") return false;
  const resultado = authResult as { dkim?: string; dmarc?: string; spf?: string };
  return resultado.dmarc === "pass" && (resultado.dkim === "pass" || resultado.spf === "pass");
}

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

export async function getMessage(
  mailboxId: string,
  messageId: string,
  options: { showRemoteImages?: boolean; markAsRead?: boolean } = {},
) {
  const mensagem = await prisma.message.findFirst({
    where: { id: messageId, mailboxId },
    select: {
      id: true,
      folderId: true,
      threadKey: true,
      rfcMessageId: true,
      inReplyTo: true,
      fromAddress: true,
      fromName: true,
      toAddresses: true,
      ccAddresses: true,
      replyTo: true,
      subject: true,
      bodyText: true,
      bodyHtml: true,
      seen: true,
      flagged: true,
      answered: true,
      sizeBytes: true,
      spamScore: true,
      quarantineReason: true,
      authResult: true,
      receivedAt: true,
      attachments: {
        select: { id: true, filename: true, contentType: true, sizeBytes: true, contentId: true },
        orderBy: { partIndex: "asc" },
      },
    },
  });

  if (!mensagem) throw new MessageError("Mensagem nao encontrada.", 404);

  const sanitizado = mensagem.bodyHtml
    ? sanitizeMessageHtml(mensagem.bodyHtml, options.showRemoteImages ?? false)
    : null;

  if (options.markAsRead !== false && !mensagem.seen) {
    await prisma.message.update({ where: { id: mensagem.id }, data: { seen: true } });
  }

  return {
    ...mensagem,
    seen: options.markAsRead !== false ? true : mensagem.seen,
    bodyHtml: sanitizado?.html ?? null,
    bodyText: mensagem.bodyText ?? (mensagem.bodyHtml ? htmlParaTexto(mensagem.bodyHtml) : null),
    blockedRemoteImages: sanitizado?.imagensBloqueadas ?? 0,
    senderVerified: isVerified(mensagem.authResult),
  };
}

/** Conversa inteira, em ordem cronologica. */
export async function getThread(mailboxId: string, threadKey: string) {
  const mensagens = await prisma.message.findMany({
    where: { mailboxId, threadKey },
    orderBy: { receivedAt: "asc" },
    select: {
      id: true,
      fromAddress: true,
      fromName: true,
      subject: true,
      snippet: true,
      seen: true,
      hasAttachments: true,
      receivedAt: true,
      folderId: true,
    },
  });

  if (mensagens.length === 0) throw new MessageError("Conversa nao encontrada.", 404);
  return { threadKey, count: mensagens.length, messages: mensagens };
}

// ---------------------------------------------------------------------------
// Anexos
// ---------------------------------------------------------------------------

export async function getAttachment(mailboxId: string, messageId: string, attachmentId: string) {
  const anexo = await prisma.attachment.findFirst({
    where: { id: attachmentId, messageId, message: { mailboxId } },
    select: {
      filename: true,
      contentType: true,
      partIndex: true,
      message: { select: { storageKey: true } },
    },
  });

  if (!anexo) throw new MessageError("Anexo nao encontrado.", 404);

  // O binario nao e duplicado no banco: sai do .eml original na hora do
  // download. Custa um parse por download, que e raro, e economiza o dobro
  // de disco em toda mensagem com anexo.
  const raw = await readRaw(anexo.message.storageKey);
  const parsed = await simpleParser(raw);
  const parte = parsed.attachments[anexo.partIndex];

  if (!parte) throw new MessageError("Anexo indisponivel na mensagem original.", 410);

  return {
    filename: anexo.filename ?? parte.filename ?? "anexo",
    contentType: anexo.contentType || parte.contentType || "application/octet-stream",
    content: parte.content as Buffer,
  };
}

/** Download da mensagem original em .eml — o cliente leva o e-mail dele embora. */
export async function getRawMessage(mailboxId: string, messageId: string) {
  const mensagem = await prisma.message.findFirst({
    where: { id: messageId, mailboxId },
    select: { storageKey: true, subject: true },
  });
  if (!mensagem) throw new MessageError("Mensagem nao encontrada.", 404);

  return {
    filename: `${(mensagem.subject ?? "mensagem").replace(/[^\w\s.-]/g, "_").slice(0, 80)}.eml`,
    content: await readRaw(mensagem.storageKey),
  };
}

// ---------------------------------------------------------------------------
// Alteracoes
// ---------------------------------------------------------------------------

export interface UpdateMessagesInput {
  mailboxId: string;
  messageIds: string[];
  seen?: boolean;
  flagged?: boolean;
  /** Mover para uma pasta de sistema. */
  moveTo?: SystemFolderKind;
  /** Mover para uma pasta propria do cliente, por id. */
  moveToFolderId?: string;
}

export async function updateMessages(input: UpdateMessagesInput): Promise<{ updated: number }> {
  if (input.messageIds.length === 0) return { updated: 0 };
  if (input.messageIds.length > 200) {
    throw new MessageError("No maximo 200 mensagens por operacao.", 422);
  }

  const dados: Record<string, unknown> = {};
  if (input.seen !== undefined) dados.seen = input.seen;
  if (input.flagged !== undefined) dados.flagged = input.flagged;

  // Mover exige UID novo por mensagem, entao sai do `updateMany` e vai para
  // `moverParaPasta`. As flags continuam em lote, que e barato.
  let destinoId: string | null = null;
  if (input.moveTo) {
    destinoId = (await getSystemFolder(input.mailboxId, input.moveTo)).id;
  } else if (input.moveToFolderId) {
    // resolveFolder filtra por mailboxId: id de pasta alheia nao move nada.
    destinoId = (await resolveFolder(input.mailboxId, input.moveToFolderId)).id;
  }

  if (Object.keys(dados).length === 0 && !destinoId) return { updated: 0 };

  let alteradas = 0;

  if (Object.keys(dados).length > 0) {
    const resultado = await prisma.message.updateMany({
      where: { id: { in: input.messageIds }, mailboxId: input.mailboxId },
      data: dados,
    });
    alteradas = resultado.count;
  }

  if (destinoId) {
    alteradas = await moverParaPasta(input.mailboxId, input.messageIds, destinoId);
  }

  return { updated: alteradas };
}

/**
 * Apagar em dois tempos: da pasta atual vai para a Lixeira; da Lixeira, some
 * de vez, com o blob removido do disco e a quota devolvida.
 */
export async function deleteMessages(
  mailboxId: string,
  messageIds: string[],
  options: { permanent?: boolean } = {},
): Promise<{ trashed: number; purged: number; freedBytes: string }> {
  if (messageIds.length === 0) return { trashed: 0, purged: 0, freedBytes: "0" };

  const lixeira = await getSystemFolder(mailboxId, "trash");

  const mensagens = await prisma.message.findMany({
    where: { id: { in: messageIds }, mailboxId },
    select: { id: true, folderId: true, storageKey: true, sizeBytes: true },
  });

  // `permanent` pula a lixeira. Usado ao substituir rascunho no autosave, onde
  // passar pela lixeira encheria a pasta de versoes intermediarias.
  const paraLixeira = options.permanent
    ? []
    : mensagens.filter((mensagem) => mensagem.folderId !== lixeira.id);
  const paraApagar = options.permanent
    ? mensagens
    : mensagens.filter((mensagem) => mensagem.folderId === lixeira.id);

  if (paraLixeira.length > 0) {
    await moverParaPasta(mailboxId, paraLixeira.map((mensagem) => mensagem.id), lixeira.id);
  }

  let liberados = 0n;

  if (paraApagar.length > 0) {
    liberados = paraApagar.reduce((soma, mensagem) => soma + BigInt(mensagem.sizeBytes), 0n);

    await prisma.$transaction([
      prisma.message.deleteMany({ where: { id: { in: paraApagar.map((m) => m.id) }, mailboxId } }),
      prisma.mailbox.update({ where: { id: mailboxId }, data: { usedBytes: { decrement: liberados } } }),
    ]);

    // Blob depois da linha: se o processo cair no meio, sobra arquivo orfao
    // (recuperavel por varredura) em vez de linha apontando para nada.
    for (const mensagem of paraApagar) {
      if (mensagem.storageKey) await deleteRaw(mensagem.storageKey);
    }

    log.info("mensagens removidas em definitivo", {
      mailboxId,
      count: paraApagar.length,
      freedBytes: liberados.toString(),
    });
  }

  return {
    trashed: paraLixeira.length,
    purged: paraApagar.length,
    freedBytes: liberados.toString(),
  };
}

/**
 * Marcar como spam ou tirar de spam.
 *
 * Alem de mover, registra o evento com o remetente e o resultado da
 * autenticacao. Hoje isso e trilha de auditoria; e a materia-prima de um
 * filtro que aprenda com o cliente, sem depender de servico externo.
 */
export async function reportSpam(
  mailboxId: string,
  messageIds: string[],
  spam: boolean,
): Promise<{ moved: number }> {
  if (messageIds.length === 0) return { moved: 0 };
  if (messageIds.length > 200) throw new MessageError("No maximo 200 mensagens por operacao.", 422);

  const mensagens = await prisma.message.findMany({
    where: { id: { in: messageIds }, mailboxId },
    select: { id: true, fromAddress: true, authResult: true, subject: true },
  });

  if (mensagens.length === 0) return { moved: 0 };

  const destino = await getSystemFolder(mailboxId, spam ? "spam" : "inbox");

  const movidas = await moverParaPasta(mailboxId, mensagens.map((m) => m.id), destino.id);

  const resultado = await prisma.message.updateMany({
    where: { id: { in: mensagens.map((m) => m.id) }, mailboxId },
    data: {
      quarantineReason: spam ? "marcado como spam pelo usuario" : null,
      // Tirar do spam marca como lida: o cliente acabou de ler para decidir.
      ...(spam ? {} : { seen: true }),
    },
  });
  void resultado;

  await prisma.mailEvent.createMany({
    data: mensagens.map((mensagem) => ({
      mailboxId,
      type: spam ? "message.reported_spam" : "message.reported_not_spam",
      payload: {
        messageId: mensagem.id,
        from: mensagem.fromAddress,
        subject: mensagem.subject,
        auth: mensagem.authResult ?? null,
      },
    })),
  });

  /**
   * O treino do anti-spam: o botao vira reputacao do remetente PARA ESTA
   * caixa. A decisao mais recente vence — quem bloqueou por engano tira do
   * spam qualquer mensagem daquele remetente e o bloqueio vira confianca.
   * A entrega consulta isto antes de classificar (deliver-local.ts).
   */
  const remetentes = [...new Set(mensagens.map((m) => m.fromAddress).filter((endereco) => endereco))];
  for (const senderAddress of remetentes) {
    await prisma.mailSenderReputation.upsert({
      where: { mailboxId_senderAddress: { mailboxId, senderAddress } },
      create: { mailboxId, senderAddress, verdict: spam ? "block" : "trust" },
      update: { verdict: spam ? "block" : "trust", reports: { increment: 1 } },
    });
  }

  log.info(spam ? "mensagens marcadas como spam" : "mensagens tiradas do spam", {
    mailboxId,
    count: movidas,
  });

  return { moved: movidas };
}

/**
 * Marca a pasta inteira como lida.
 *
 * Faz num `updateMany` em vez de listar os ids e mandar de volta: caixa com
 * 3 mil nao lidas estouraria o limite de 200 por operacao do PATCH, e o
 * cliente teria que paginar para executar uma acao que e uma so.
 */
export async function markAllRead(mailboxId: string, folder?: string): Promise<{ updated: number }> {
  const where: Record<string, unknown> = { mailboxId, seen: false };

  if (folder) {
    const pasta = await prisma.mailFolder.findFirst({
      where: { mailboxId, OR: [{ kind: folder }, { id: folder }] },
      select: { id: true },
    });
    if (!pasta) throw new MessageError(`Pasta nao encontrada: ${folder}`, 404);
    where.folderId = pasta.id;
  }

  const resultado = await prisma.message.updateMany({ where, data: { seen: true } });
  return { updated: resultado.count };
}

/** Contagem enxuta para o cliente consultar sem baixar a lista toda. */
export async function unreadCounts(mailboxId: string) {
  const [pastas, agregado] = await Promise.all([
    prisma.mailFolder.findMany({ where: { mailboxId }, select: { id: true, kind: true, name: true } }),
    prisma.message.groupBy({
      by: ["folderId"],
      where: { mailboxId, seen: false },
      _count: { _all: true },
    }),
  ]);

  const mapa = new Map(agregado.map((linha) => [linha.folderId, linha._count._all]));

  return {
    total: agregado.reduce((soma, linha) => soma + linha._count._all, 0),
    byFolder: pastas.map((pasta) => ({
      kind: pasta.kind,
      name: pasta.name,
      unread: mapa.get(pasta.id) ?? 0,
    })),
  };
}

export async function emptyTrash(mailboxId: string) {
  const lixeira = await getSystemFolder(mailboxId, "trash");
  const mensagens = await prisma.message.findMany({
    where: { mailboxId, folderId: lixeira.id },
    select: { id: true },
  });
  return deleteMessages(mailboxId, mensagens.map((mensagem) => mensagem.id));
}


/**
 * Adia mensagens: saem da Entrada agora e voltam sozinhas na hora marcada.
 *
 * Move para a pasta Adiadas em vez de so esconder da lista. Esconder seria
 * mais simples, mas quem le a mesma caixa por IMAP no celular continuaria
 * vendo a mensagem na Entrada, e as duas telas passariam a discordar.
 *
 * A coluna snoozedUntil e a agenda; quem devolve e o varredor do MTA.
 */
export async function snoozeMessages(
  mailboxId: string,
  messageIds: string[],
  until: Date,
): Promise<{ adiadas: number }> {
  if (messageIds.length === 0) return { adiadas: 0 };
  if (until.getTime() <= Date.now()) {
    throw new MessageError("Escolha um horario no futuro.", 422);
  }

  const destino = await getSystemFolder(mailboxId, "snoozed");
  const r = await prisma.message.updateMany({
    where: { mailboxId, id: { in: messageIds } },
    data: { folderId: destino.id, snoozedUntil: until },
  });
  return { adiadas: r.count };
}

/**
 * Devolve a Entrada as mensagens cujo prazo venceu.
 *
 * Chamada pelo laco do MTA, que ja roda a cada 10s. Processo separado so para
 * isso seria mais uma peca para vigiar, e o atraso de ate 10s nao muda nada
 * para quem adiou algo para amanha de manha.
 */
export async function wakeSnoozed(limite = 200): Promise<number> {
  const vencidas = await prisma.message.findMany({
    where: { snoozedUntil: { lte: new Date() } },
    take: limite,
    select: { id: true, mailboxId: true },
  });
  if (vencidas.length === 0) return 0;

  // Agrupa por caixa: cada uma tem a propria Entrada, e resolver a pasta por
  // mensagem seria uma consulta a mais para cada linha.
  const porCaixa = new Map<string, string[]>();
  for (const m of vencidas) {
    const atual = porCaixa.get(m.mailboxId) ?? [];
    atual.push(m.id);
    porCaixa.set(m.mailboxId, atual);
  }

  let devolvidas = 0;
  for (const [mailboxId, ids] of porCaixa) {
    const entrada = await getSystemFolder(mailboxId, "inbox");
    const r = await prisma.message.updateMany({
      where: { id: { in: ids }, mailboxId },
      // Volta como nao lida: mensagem que reaparece precisa ser vista de novo,
      // senao o adiamento vira um jeito de perder a mensagem para sempre.
      data: { folderId: entrada.id, snoozedUntil: null, seen: false },
    });
    devolvidas += r.count;
  }
  return devolvidas;
}