import { SMTPServer, type SMTPServerDataStream, type SMTPServerSession } from "smtp-server";
import type { Readable } from "node:stream";
import type { TlsOptions } from "node:tls";
import { config } from "../lib/config.js";
import { createLogger } from "../lib/logger.js";
import { prisma } from "../lib/db.js";
import { checkInboundAuth } from "./authcheck.js";
import { deliverToMailbox, resolveRecipient } from "./deliver-local.js";
import { enqueueForward } from "./queue.js";

const log = createLogger("smtp-inbound");

/**
 * SMTP de entrada, porta 25.
 *
 * Sem AUTH: quem entra aqui e outro MTA entregando para um dominio nosso, e so.
 * (A porta 25 de SAIDA foi liberada pela Hetzner em 14/08/2026; a de entrada
 * nunca foi bloqueada e recebe desde o dia 1.)
 */

interface CollectedMessage {
  raw: Buffer;
  truncated: boolean;
}

function collect(stream: SMTPServerDataStream & Readable, limit: number): Promise<CollectedMessage> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    stream.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      // Acima do limite paramos de acumular, mas seguimos drenando o socket:
      // cortar a leitura no meio deixa a conexao presa ate o timeout.
      if (total <= limit) chunks.push(chunk);
    });
    stream.on("end", () => resolve({ raw: Buffer.concat(chunks), truncated: total > limit || stream.sizeExceeded }));
    stream.on("error", reject);
  });
}

/** Header Received:, exigido pelo RFC 5321 e essencial para depurar entrega. */
function receivedHeader(session: SMTPServerSession, recipient: string): string {
  const from = session.clientHostname || "desconhecido";
  return (
    `Received: from ${from} (${session.remoteAddress})\r\n` +
    `\tby ${config.hostname} with ESMTP id ${session.id}\r\n` +
    `\tfor <${recipient}>; ${new Date().toUTCString()}\r\n`
  );
}

export function createInboundServer(options: { tls?: TlsOptions } = {}): SMTPServer {
  return new SMTPServer({
    name: config.hostname,
    banner: "Avila Ops Mail",
    size: config.limits.maxMessageBytes,
    /**
     * Sem o certificado do disco, o smtp-server anuncia STARTTLS com uma chave
     * autoassinada que vem no pacote e e publicamente conhecida. Quem entrega
     * para nos ve `CN=localhost` vencido: o Gmail marca a mensagem como nao
     * criptografada, e uma politica MTA-STS em modo enforce recusaria a
     * entrega. Passar o certificado real e o que faz a porta 25 de entrada
     * valer o mesmo que a submission.
     */
    ...(options.tls ?? {}),
    authOptional: true,
    disabledCommands: ["AUTH"],
    // STARTTLS oportunista: quase todo remetente serio usa, e quem nao usa
    // ainda precisa conseguir entregar.
    hideSTARTTLS: false,

    async onRcptTo(address, session, callback) {
      const resolution = await resolveRecipient(address.address).catch((error) => {
        log.error("falha ao resolver destinatario", {
          rcptTo: address.address,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });

      if (!resolution) {
        // Erro nosso, nao do remetente: 4xx pede retentativa em vez de bounce.
        return callback(new Error("451 4.3.0 Erro temporario ao resolver destinatario"));
      }

      if (resolution.kind === "unknown") {
        log.info("destinatario recusado", {
          rcptTo: address.address,
          remoteAddress: session.remoteAddress,
          reason: resolution.reason,
        });
        return callback(new Error(`550 5.1.1 Destinatario desconhecido (${resolution.reason})`));
      }

      return callback();
    },

    async onData(stream, session, callback) {
      try {
        const { raw, truncated } = await collect(stream, config.limits.maxMessageBytes);

        if (truncated) {
          return callback(new Error("552 5.3.4 Mensagem maior que o limite aceito"));
        }

        const auth = await checkInboundAuth(raw, {
          ip: session.remoteAddress,
          helo: session.clientHostname || session.hostNameAppearsAs || "",
          mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
        });

        const recipients = session.envelope.rcptTo.map((rcpt) => rcpt.address);
        const failures: string[] = [];

        for (const recipient of recipients) {
          const resolution = await resolveRecipient(recipient);

          if (resolution.kind === "unknown") {
            failures.push(`${recipient}: ${resolution.reason}`);
            continue;
          }

          if (resolution.kind === "alias") {
            await enqueueForward({
              originalRecipient: recipient,
              destination: resolution.destination,
              raw,
              mailFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
            });
            continue;
          }

          /**
           * Os cabecalhos entram ANTES da mensagem, sem linha em branco entre
           * eles e o resto.
           *
           * O `mailauth` ja devolve o bloco terminado em CRLF. Acrescentar
           * outro cria a linha vazia que, no formato de e-mail, significa "aqui
           * acabam os cabecalhos" — e a partir dali o From:, o To: e o Subject:
           * originais viram texto do corpo. A mensagem chega sem assunto, sem
           * remetente e com os proprios cabecalhos aparecendo para o leitor.
           */
          const cabecalhosAuth = auth?.headers
            ? auth.headers.endsWith("\r\n")
              ? auth.headers
              : `${auth.headers}\r\n`
            : "";

          const stamped = Buffer.concat([
            Buffer.from(receivedHeader(session, recipient)),
            Buffer.from(cabecalhosAuth),
            raw,
          ]);

          const outcome = await deliverToMailbox(resolution, stamped, auth, {
            envelopeFrom: session.envelope.mailFrom ? session.envelope.mailFrom.address : "",
          });
          if (outcome.status === "rejected") failures.push(`${recipient}: ${outcome.reason}`);
        }

        if (failures.length === recipients.length && recipients.length > 0) {
          const first = failures[0] ?? "entrega recusada";
          await prisma.mailEvent.create({
            data: {
              type: "inbound.rejected",
              severity: "warn",
              payload: { remoteAddress: session.remoteAddress, failures },
            },
          });
          return callback(new Error(`550 5.2.0 ${first}`));
        }

        if (failures.length > 0) {
          log.warn("entrega parcial", { failures, remoteAddress: session.remoteAddress });
        }

        return callback();
      } catch (error) {
        log.error("erro ao processar DATA", {
          remoteAddress: session.remoteAddress,
          error: error instanceof Error ? error.message : String(error),
        });
        // 451: o remetente tenta de novo em vez de dar a mensagem por perdida.
        return callback(new Error("451 4.3.0 Erro temporario ao processar a mensagem"));
      }
    },
  });
}
