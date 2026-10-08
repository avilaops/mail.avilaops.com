import { randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { parseAddress } from "../lib/address.js";
import { enqueueOutbound } from "../mta/queue.js";
import { storeCopyInMailbox } from "../mta/deliver-local.js";
import { deleteMessages } from "./messages.js";
import { consumeSendQuota, remainingQuota } from "./sendQuota.js";
import { canSendAs } from "./contacts.js";
import { consumeUploads } from "./uploads.js";
import { getSettings } from "./settings.js";

const log = createLogger("compose");

/**
 * Composicao e envio pelo webmail.
 *
 * O caminho SMTP (submission) recebe o MIME pronto do cliente de e-mail; aqui
 * o MIME e montado por nos a partir de um formulario. Os dois desaguam na
 * mesma fila e consomem a mesma cota — sao portas diferentes para o mesmo
 * corredor, nao dois corredores.
 */

export class ComposeError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ComposeError";
  }
}

const MAX_DESTINATARIOS = 50;

export interface Attachment {
  filename: string;
  contentType?: string;
  contentBase64: string;
}

export interface ComposeInput {
  mailboxId: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
  /** Id de uma mensagem NOSSA a que se responde. */
  inReplyToMessageId?: string;
  attachments?: Attachment[];
  /** Anexos ja enviados antes, via POST /v1/me/attachments. */
  attachmentIds?: string[];
  /** Endereco de envio, quando a caixa tem alias. Padrao: o proprio. */
  fromAddress?: string;
  /** Cola a assinatura configurada no fim do corpo. */
  appendSignature?: boolean;
  /** Rascunho a descartar depois que o envio der certo. */
  draftId?: string;
}

interface CaixaRemetente {
  id: string;
  address: string;
  displayName: string | null;
  sendLimitPerHour: number;
}

async function carregarRemetente(mailboxId: string, fromAddress?: string): Promise<CaixaRemetente> {
  const mailbox = await prisma.mailbox.findUnique({
    where: { id: mailboxId },
    select: {
      id: true,
      localPart: true,
      displayName: true,
      status: true,
      sendLimitPerHour: true,
      domain: { select: { name: true, status: true } },
    },
  });

  if (!mailbox) throw new ComposeError("Caixa nao encontrada.", 404);
  if (mailbox.status !== "active") throw new ComposeError("Caixa suspensa: envio bloqueado.", 403);
  if (mailbox.domain.status === "disabled") throw new ComposeError("Dominio desativado.", 403);

  const proprio = `${mailbox.localPart}@${mailbox.domain.name}`;
  let address = proprio;

  if (fromAddress) {
    const escolhido = fromAddress.trim().toLowerCase();
    if (escolhido !== proprio) {
      // Sem esta checagem, a caixa mandaria e-mail como qualquer endereco do
      // dominio — inclusive o do chefe do cliente.
      if (!(await canSendAs(mailbox.id, escolhido))) {
        throw new ComposeError(`Esta caixa nao pode enviar como ${escolhido}.`, 403);
      }
      address = escolhido;
    }
  }

  return {
    id: mailbox.id,
    address,
    displayName: mailbox.displayName,
    sendLimitPerHour: mailbox.sendLimitPerHour,
  };
}

/** Normaliza, valida e remove repetidos preservando a ordem digitada. */
function normalizarDestinatarios(lista: string[] | undefined, rotulo: string): string[] {
  if (!lista || lista.length === 0) return [];

  const vistos = new Set<string>();
  const saida: string[] = [];

  for (const bruto of lista) {
    const parsed = parseAddress(bruto);
    if (!parsed) throw new ComposeError(`Endereco invalido em ${rotulo}: ${bruto}`, 422);
    if (!vistos.has(parsed.full)) {
      vistos.add(parsed.full);
      saida.push(parsed.full);
    }
  }

  return saida;
}

const PREFIXO_RESPOSTA = /^(re|res)\s*:/i;

interface ContextoResposta {
  inReplyTo: string | null;
  references: string | null;
  subject: string | null;
  originalId: string;
}

async function carregarResposta(mailboxId: string, messageId: string): Promise<ContextoResposta> {
  const original = await prisma.message.findFirst({
    where: { id: messageId, mailboxId },
    select: { id: true, rfcMessageId: true, subject: true },
  });

  if (!original) throw new ComposeError("Mensagem original nao encontrada.", 404);

  return {
    inReplyTo: original.rfcMessageId,
    references: original.rfcMessageId,
    subject: original.subject,
    originalId: original.id,
  };
}

/** Monta o MIME. Fica separado do envio para o rascunho reaproveitar. */
async function montarMime(
  remetente: CaixaRemetente,
  input: ComposeInput,
  destino: { to: string[]; cc: string[]; bcc: string[] },
  resposta: ContextoResposta | null,
): Promise<{ raw: Buffer; subject: string; rfcMessageId: string }> {
  let subject = (input.subject ?? "").trim();
  if (resposta && !subject) {
    const base = resposta.subject ?? "";
    subject = PREFIXO_RESPOSTA.test(base) ? base : `Re: ${base}`.trim();
  }
  if (!subject) subject = "(sem assunto)";

  const dominio = parseAddress(remetente.address)?.domain ?? config.hostname;
  const rfcMessageId = `<${randomUUID()}@${dominio}>`;

  const anexosInline = (input.attachments ?? []).map((anexo) => ({
    filename: anexo.filename,
    content: Buffer.from(anexo.contentBase64, "base64"),
    contentType: anexo.contentType || "application/octet-stream",
  }));

  // Anexos enviados antes sao consumidos aqui — some da lista de pendentes e
  // vira parte da mensagem, sem ocupar disco duas vezes.
  const anexosEnviados = await consumeUploads(remetente.id, input.attachmentIds ?? []);
  const anexos = [...anexosInline, ...anexosEnviados];

  let { text, html } = input;

  if (input.appendSignature) {
    const preferencias = await getSettings(remetente.id);
    if (preferencias.signatureText && text) text = `${text}\r\n\r\n--\r\n${preferencias.signatureText}`;
    if (preferencias.signatureHtml && html) html = `${html}<br><br>--<br>${preferencias.signatureHtml}`;
  }

  const composer = new MailComposer({
    from: remetente.displayName
      ? { name: remetente.displayName, address: remetente.address }
      : remetente.address,
    to: destino.to,
    cc: destino.cc.length > 0 ? destino.cc : undefined,
    // Bcc fica fora dos headers (padrao do MailComposer) e entra so no
    // envelope — se vazasse no header, todo destinatario veria a copia oculta.
    subject,
    text,
    html,
    messageId: rfcMessageId,
    date: new Date(),
    inReplyTo: resposta?.inReplyTo ?? undefined,
    references: resposta?.references ?? undefined,
    attachments: anexos.length > 0 ? anexos : undefined,
    textEncoding: "quoted-printable",
  });

  const raw = await composer.compile().build();
  return { raw, subject, rfcMessageId };
}

export interface SendResult {
  queuedId: string;
  rfcMessageId: string;
  subject: string;
  recipients: number;
  remainingThisHour: number;
  /** Instante ate o qual desfazer ainda cancela de verdade. */
  desfazerAteMs: number;
}

/**
 * Quanto tempo a mensagem espera na fila antes da primeira tentativa.
 *
 * E o que torna "desfazer envio" honesto: dentro da janela a mensagem ainda
 * nao saiu do servidor, entao cancelar e cancelar mesmo, e nao um pedido de
 * volta que ninguem pode atender. Quinze segundos e o bastante para perceber o
 * anexo esquecido e curto para nao parecer travamento.
 */
export const JANELA_DESFAZER_SEGUNDOS = 15;

export async function sendMessage(input: ComposeInput): Promise<SendResult> {
  const remetente = await carregarRemetente(input.mailboxId, input.fromAddress);

  if (!input.text && !input.html) {
    throw new ComposeError("A mensagem precisa ter texto ou HTML.", 422);
  }

  const to = normalizarDestinatarios(input.to, "Para");
  const cc = normalizarDestinatarios(input.cc, "Cc");
  const bcc = normalizarDestinatarios(input.bcc, "Cco");

  if (to.length === 0) throw new ComposeError("Informe ao menos um destinatario.", 422);

  const envelope = [...new Set([...to, ...cc, ...bcc])];
  if (envelope.length > MAX_DESTINATARIOS) {
    throw new ComposeError(`No maximo ${MAX_DESTINATARIOS} destinatarios por mensagem.`, 422);
  }

  const resposta = input.inReplyToMessageId
    ? await carregarResposta(input.mailboxId, input.inReplyToMessageId)
    : null;

  const { raw, subject, rfcMessageId } = await montarMime(remetente, input, { to, cc, bcc }, resposta);

  if (raw.byteLength > config.limits.maxMessageBytes) {
    const limiteMb = Math.floor(config.limits.maxMessageBytes / 1024 / 1024);
    throw new ComposeError(`Mensagem maior que o limite de ${limiteMb} MB.`, 413);
  }

  // A cota e consumida so depois de tudo validado: mensagem que nem chegou a
  // ser montada nao pode gastar o saldo de envio do cliente.
  const quota = await consumeSendQuota(remetente.id, envelope.length, remetente.sendLimitPerHour);
  if (!quota.allowed) {
    throw new ComposeError(
      `Limite de ${quota.limit} destinatarios por hora atingido. Tente novamente mais tarde.`,
      429,
    );
  }

  const enfileirada = await enqueueOutbound({
    mailboxId: remetente.id,
    envelopeFrom: remetente.address,
    recipients: envelope,
    raw,
    subject,
    sign: true,
    delaySeconds: JANELA_DESFAZER_SEGUNDOS,
  });

  await storeCopyInMailbox(remetente.id, raw);

  if (resposta) {
    await prisma.message.updateMany({
      where: { id: resposta.originalId, mailboxId: remetente.id },
      data: { answered: true },
    });
  }

  if (input.draftId) {
    await deleteMessages(remetente.id, [input.draftId], { permanent: true }).catch(() => undefined);
  }

  log.info("mensagem enviada pelo webmail", {
    mailboxId: remetente.id,
    outboundId: enfileirada.id,
    recipients: envelope.length,
    sizeBytes: raw.byteLength,
  });

  return {
    queuedId: enfileirada.id,
    desfazerAteMs: Date.now() + JANELA_DESFAZER_SEGUNDOS * 1000,
    rfcMessageId,
    subject,
    recipients: envelope.length,
    remainingThisHour: await remainingQuota(remetente.id, remetente.sendLimitPerHour),
  };
}

/**
 * Salva rascunho como mensagem real na pasta Rascunhos.
 *
 * Ocupa quota de proposito: rascunho com anexo de 20 MB ocupa 20 MB de disco,
 * e esconder isso do cliente so adia a surpresa.
 */
export async function saveDraft(input: ComposeInput): Promise<{ draftId: string }> {
  const remetente = await carregarRemetente(input.mailboxId, input.fromAddress);

  const to = normalizarDestinatarios(input.to, "Para");
  const cc = normalizarDestinatarios(input.cc, "Cc");
  const bcc = normalizarDestinatarios(input.bcc, "Cco");

  const resposta = input.inReplyToMessageId
    ? await carregarResposta(input.mailboxId, input.inReplyToMessageId)
    : null;

  const { raw } = await montarMime(remetente, input, { to, cc, bcc }, resposta);

  // Rascunho anterior sai antes do novo entrar: sem isso, cada autosave
  // deixaria uma copia acumulando na pasta e na quota.
  if (input.draftId) {
    await deleteMessages(remetente.id, [input.draftId], { permanent: true }).catch(() => undefined);
  }

  const draftId = await storeCopyInMailbox(remetente.id, raw, "drafts");
  if (!draftId) throw new ComposeError("Nao foi possivel salvar o rascunho (quota da caixa cheia?).", 507);

  await prisma.message.update({ where: { id: draftId }, data: { draft: true, seen: true } });

  return { draftId };
}


/**
 * Cancela um envio que ainda esta dentro da janela.
 *
 * Duas travas: so cancela o que ainda esta "queued" e cujo prazo nao venceu.
 * Sem a segunda, uma corrida com o worker deixaria o cliente com "envio
 * cancelado" na tela e a mensagem entregue do outro lado, que e a pior
 * mentira que este recurso poderia contar.
 *
 * A copia em Enviados sai junto: mensagem cancelada nao foi enviada.
 */
export async function undoSend(
  mailboxId: string,
  outboundId: string,
  rfcMessageId: string,
): Promise<{ cancelado: boolean }> {
  const alvo = await prisma.outboundMessage.findFirst({
    where: { id: outboundId, mailboxId },
    select: { id: true, status: true, nextAttemptAt: true },
  });
  if (!alvo) throw new ComposeError("Envio nao encontrado.", 404);

  if (alvo.status !== "queued" || alvo.nextAttemptAt.getTime() <= Date.now()) {
    return { cancelado: false };
  }

  const removidos = await prisma.outboundMessage.deleteMany({
    where: { id: outboundId, mailboxId, status: "queued", nextAttemptAt: { gt: new Date() } },
  });
  if (removidos.count === 0) return { cancelado: false };

  // A copia em Enviados so pode sair depois de a fila confirmar a remocao:
  // apagar antes deixaria o cliente sem copia de uma mensagem que saiu.
  const enviados = await prisma.mailFolder.findFirst({
    where: { mailboxId, kind: "sent" },
    select: { id: true },
  });
  if (enviados) {
    const copia = await prisma.message.findFirst({
      where: { mailboxId, folderId: enviados.id, rfcMessageId },
      select: { id: true },
    });
    if (copia) await deleteMessages(mailboxId, [copia.id], { permanent: true }).catch(() => undefined);
  }

  log.info("envio desfeito pelo cliente", { mailboxId, outboundId });
  return { cancelado: true };
}