import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("send-quota");

/**
 * Cota de envio por caixa, em janela de uma hora.
 *
 * Existe para conter conta comprometida: uma senha vazada sem esta trava vira
 * disparo de spam, e quem paga a conta e a reputacao do IP do servidor
 * inteiro — ou seja, a entregabilidade de todos os outros clientes.
 *
 * Compartilhado entre a submission SMTP e o envio pelo webmail de proposito:
 * dois caminhos de saida com contadores separados seriam duas metades de uma
 * trava, e o atacante usaria a que estivesse mais folgada.
 */

export function currentWindow(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
}

export interface QuotaResult {
  allowed: boolean;
  usedInWindow: number;
  limit: number;
}

/**
 * Reserva cota para `recipients` destinatarios.
 *
 * Incrementa antes de decidir: em corrida, dois envios simultaneos somam em
 * vez de cada um ler o valor antigo e ambos passarem. Se estourar, o excedente
 * fica contado — o efeito pratico e a caixa esperar a proxima janela, que e
 * exatamente o comportamento desejado.
 */
export async function consumeSendQuota(
  mailboxId: string,
  recipients: number,
  limit: number,
): Promise<QuotaResult> {
  const windowStart = currentWindow();

  const counter = await prisma.sendCounter.upsert({
    where: { mailboxId_windowStart: { mailboxId, windowStart } },
    create: { mailboxId, windowStart, recipients },
    update: { recipients: { increment: recipients } },
    select: { recipients: true },
  });

  const allowed = counter.recipients <= limit;

  if (!allowed) {
    await prisma.mailEvent.create({
      data: {
        mailboxId,
        type: "outbound.rate_limited",
        severity: "warn",
        payload: { limit, usedInWindow: counter.recipients, requested: recipients },
      },
    });
    log.warn("cota de envio estourada", { mailboxId, limit, usedInWindow: counter.recipients });
  }

  return { allowed, usedInWindow: counter.recipients, limit };
}

/** Quanto ainda resta na janela atual — o webmail mostra antes de deixar enviar. */
export async function remainingQuota(mailboxId: string, limit: number): Promise<number> {
  const counter = await prisma.sendCounter.findUnique({
    where: { mailboxId_windowStart: { mailboxId, windowStart: currentWindow() } },
    select: { recipients: true },
  });
  return Math.max(0, limit - (counter?.recipients ?? 0));
}
