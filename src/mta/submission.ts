import { randomUUID } from "node:crypto";
import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import type { Readable } from "node:stream";
import type { TlsOptions } from "node:tls";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { parseAddress } from "../lib/address.js";
import { burnPasswordTime, verifyPassword } from "../lib/password.js";
import { upgradeHashIfNeeded } from "../services/passwordUpgrade.js";
import { enqueueOutbound } from "./queue.js";
import { storeCopyInMailbox } from "./deliver-local.js";
import { consumeSendQuota } from "../services/sendQuota.js";

const log = createLogger("smtp-submission");

/**
 * SMTP de submission (587 com STARTTLS, 465 com TLS direto).
 *
 * Aqui o cliente autentica e nos confia a mensagem. Duas regras inegociaveis:
 * autenticacao obrigatoria e remetente amarrado a caixa autenticada. Servidor
 * de submission frouxo vira open relay, e open relay vira blacklist em horas.
 */

const MAX_RECIPIENTS_PER_MESSAGE = 50;

function collect(stream: SMTPServerDataStream & Readable, limit: number): Promise<{ raw: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total <= limit) chunks.push(chunk);
    });
    stream.on("end", () => resolve({ raw: Buffer.concat(chunks), truncated: total > limit || stream.sizeExceeded }));
    stream.on("error", reject);
  });
}

/**
 * Garante Message-ID e Date. Cliente que envia sem esses headers tem a
 * mensagem tratada como suspeita por boa parte dos provedores.
 */
function ensureHeaders(raw: Buffer, senderDomain: string): Buffer {
  const head = raw.subarray(0, Math.min(raw.byteLength, 16_384)).toString("utf8");
  const additions: string[] = [];

  if (!/^message-id:/im.test(head)) {
    additions.push(`Message-ID: <${randomUUID()}@${senderDomain}>\r\n`);
  }
  if (!/^date:/im.test(head)) {
    additions.push(`Date: ${new Date().toUTCString()}\r\n`);
  }

  return additions.length === 0 ? raw : Buffer.concat([Buffer.from(additions.join("")), raw]);
}

/** O remetente do envelope precisa ser a propria caixa ou um alias dela. */
async function senderAllowed(mailboxId: string, domainId: string, envelopeFrom: string): Promise<boolean> {
  const parsed = parseAddress(envelopeFrom);
  if (!parsed) return false;

  const mailbox = await prisma.mailbox.findUnique({
    where: { id: mailboxId },
    select: { localPart: true, domain: { select: { id: true, name: true } } },
  });
  if (!mailbox) return false;

  if (parsed.domain !== mailbox.domain.name) return false;
  if (parsed.localPart === mailbox.localPart) return true;

  const alias = await prisma.mailAlias.findUnique({
    where: { domainId_localPart: { domainId, localPart: parsed.localPart } },
    select: { destination: true },
  });

  return alias?.destination === `${mailbox.localPart}@${mailbox.domain.name}`;
}

interface SubmissionUser {
  mailboxId: string;
  domainId: string;
  address: string;
  sendLimitPerHour: number;
}

function sessionUser(session: SMTPServerSession): SubmissionUser | null {
  const user = session.user as unknown;
  return user && typeof user === "object" && "mailboxId" in user ? (user as SubmissionUser) : null;
}

export function createSubmissionServer(options: { secure: boolean; tls?: TlsOptions }): SMTPServer {
  return new SMTPServer({
    name: config.hostname,
    banner: "Avila Ops Mail Submission",
    size: config.limits.maxMessageBytes,
    secure: options.secure,
    ...(options.tls ?? {}),
    authMethods: ["PLAIN", "LOGIN"],
    // Sem TLS nao ha AUTH: senha de caixa nao trafega em claro.
    allowInsecureAuth: false,

    async onAuth(auth, session, callback) {
      const parsed = parseAddress(auth.username ?? "");
      if (!parsed || !auth.password) {
        return callback(new Error("535 5.7.8 Usuario ou senha invalidos"));
      }

      const mailbox = await prisma.mailbox
        .findFirst({
          where: { localPart: parsed.localPart, domain: { name: parsed.domain } },
          select: { id: true, domainId: true, passwordHash: true, status: true, sendLimitPerHour: true },
        })
        .catch(() => null);

      // Mesma mensagem E mesmo tempo para caixa inexistente e senha errada:
      // diferenciar as duas, no texto ou no relogio, entrega ao atacante uma
      // lista de caixas validas.
      const senhaConfere = mailbox
        ? await verifyPassword(auth.password, mailbox.passwordHash)
        : (await burnPasswordTime(auth.password), false);

      if (!mailbox || !senhaConfere) {
        log.warn("autenticacao recusada", { username: parsed.full, remoteAddress: session.remoteAddress });
        return callback(new Error("535 5.7.8 Usuario ou senha invalidos"));
      }

      upgradeHashIfNeeded(mailbox.id, auth.password, mailbox.passwordHash);

      if (mailbox.status !== "active") {
        return callback(new Error("535 5.7.8 Caixa suspensa. Regularize o acesso no painel."));
      }

      void prisma.mailbox
        .update({ where: { id: mailbox.id }, data: { lastLoginAt: new Date() } })
        .catch(() => undefined);

      const user: SubmissionUser = {
        mailboxId: mailbox.id,
        domainId: mailbox.domainId,
        address: parsed.full,
        sendLimitPerHour: mailbox.sendLimitPerHour,
      };

      return callback(null, { user: user as unknown as string });
    },

    async onMailFrom(address, session, callback) {
      const user = sessionUser(session);
      if (!user) return callback(new Error("530 5.7.0 Autenticacao obrigatoria"));

      const allowed = await senderAllowed(user.mailboxId, user.domainId, address.address);
      if (!allowed) {
        log.warn("remetente recusado", { authenticated: user.address, attempted: address.address });
        return callback(new Error("550 5.7.1 Remetente nao pertence a caixa autenticada"));
      }

      return callback();
    },

    onRcptTo(_address, session, callback) {
      if (session.envelope.rcptTo.length >= MAX_RECIPIENTS_PER_MESSAGE) {
        return callback(new Error(`452 4.5.3 Maximo de ${MAX_RECIPIENTS_PER_MESSAGE} destinatarios por mensagem`));
      }
      return callback();
    },

    async onData(stream, session, callback) {
      const user = sessionUser(session);
      if (!user) return callback(new Error("530 5.7.0 Autenticacao obrigatoria"));

      try {
        const { raw, truncated } = await collect(stream, config.limits.maxMessageBytes);
        if (truncated) return callback(new Error("552 5.3.4 Mensagem maior que o limite aceito"));

        const recipients = session.envelope.rcptTo.map((rcpt) => rcpt.address);

        const quota = await consumeSendQuota(user.mailboxId, recipients.length, user.sendLimitPerHour);
        if (!quota.allowed) {
          return callback(new Error("451 4.7.0 Limite de envio por hora atingido. Tente novamente mais tarde."));
        }

        const envelopeFrom = session.envelope.mailFrom ? session.envelope.mailFrom.address : user.address;
        const senderDomain = parseAddress(envelopeFrom)?.domain ?? config.hostname;
        const prepared = ensureHeaders(raw, senderDomain);

        await enqueueOutbound({
          mailboxId: user.mailboxId,
          envelopeFrom,
          recipients,
          raw: prepared,
          sign: true,
        });

        await storeCopyInMailbox(user.mailboxId, prepared);

        log.info("submission aceita", {
          mailboxId: user.mailboxId,
          recipients: recipients.length,
          sizeBytes: prepared.byteLength,
        });

        return callback();
      } catch (error) {
        log.error("erro no DATA de submission", {
          mailboxId: user.mailboxId,
          error: error instanceof Error ? error.message : String(error),
        });
        return callback(new Error("451 4.3.0 Erro temporario ao aceitar a mensagem"));
      }
    },
  });
}
