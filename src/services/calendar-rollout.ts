import { prisma } from "../lib/db.js";

type ContagemPorStatus = Record<string, number>;

function objetoJson(valor: unknown): Record<string, unknown> {
  return typeof valor === "object" && valor !== null && !Array.isArray(valor)
    ? valor as Record<string, unknown>
    : {};
}

function dataIso(valor: unknown, fallback: Date): string {
  if (typeof valor !== "string") return fallback.toISOString();
  const data = new Date(valor);
  return Number.isNaN(data.getTime()) ? fallback.toISOString() : data.toISOString();
}

function contagens(grupos: Array<{ status: string; _count: { _all: number } }>): ContagemPorStatus {
  return Object.fromEntries(grupos.map((grupo) => [grupo.status, grupo._count._all]));
}

/** Resume a janela de observacao interna registrada pela operacao. */
export async function estadoDaValidacaoInternaDaAgenda(agora = new Date()) {
  const validacao = await prisma.mailEvent.findFirst({
    where: { type: "calendar.internal_validation.started", mailboxId: { not: null } },
    orderBy: { createdAt: "desc" },
    include: { mailbox: { include: { domain: { select: { name: true } } } } },
  });

  if (!validacao?.mailbox) return null;

  const payload = objetoJson(validacao.payload);
  const startedAt = dataIso(payload.startedAt, validacao.createdAt);
  const endsAt = dataIso(payload.endsAt, new Date(new Date(startedAt).getTime() + 7 * 86_400_000));
  const mailboxId = validacao.mailbox.id;

  const [activeEvents, deletedEvents, reminderGroups, inviteGroups, errors] = await Promise.all([
    prisma.mailDavItem.count({ where: { mailboxId, collection: "calendar", deletedAt: null } }),
    prisma.mailDavItem.count({ where: { mailboxId, collection: "calendar", deletedAt: { not: null } } }),
    prisma.calendarReminderDelivery.groupBy({ by: ["status"], where: { mailboxId }, _count: { _all: true } }),
    prisma.calendarInviteDelivery.groupBy({ by: ["status"], where: { mailboxId }, _count: { _all: true } }),
    prisma.mailEvent.count({ where: { mailboxId, severity: "error", createdAt: { gte: new Date(startedAt) } } }),
  ]);

  return {
    mailbox: `${validacao.mailbox.localPart}@${validacao.mailbox.domain.name}`,
    startedAt,
    endsAt,
    observationComplete: agora.getTime() >= new Date(endsAt).getTime(),
    activeEvents,
    deletedEvents,
    reminders: contagens(reminderGroups),
    invites: contagens(inviteGroups),
    errors,
  };
}
