import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { CalendarError } from "./calendar.js";

const colorSchema = z.string().regex(/^#[0-9A-F]{6}$/i, "Cor deve usar o formato #RRGGBB.");
const inputSchema = z.object({ name: z.string().trim().min(1).max(100), color: colorSchema.default("#2563EB") });
const patchSchema = inputSchema.partial().refine((value) => Object.keys(value).length > 0, "Informe ao menos uma alteração.");

const selectCalendar = { id: true, name: true, color: true, position: true, isDefault: true, _count: { select: { items: { where: { deletedAt: null } } } } } as const;

function output(calendar: { id: string; name: string; color: string; position: number; isDefault: boolean; _count: { items: number } }) {
  return { id: calendar.id, nome: calendar.name, cor: calendar.color, ordem: calendar.position, padrao: calendar.isDefault, quantidadeEventos: calendar._count.items };
}

export async function garantirAgendaPadrao(mailboxId: string) {
  const existing = await prisma.mailCalendar.findFirst({ where: { mailboxId, isDefault: true } });
  if (existing) return existing;
  try {
    return await prisma.mailCalendar.create({ data: { mailboxId, href: "agenda", name: "Agenda", color: "#2563EB", isDefault: true, position: 0 } });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") return prisma.mailCalendar.findFirstOrThrow({ where: { mailboxId, isDefault: true } });
    throw error;
  }
}

export async function listarAgendas(mailboxId: string) {
  await garantirAgendaPadrao(mailboxId);
  return (await prisma.mailCalendar.findMany({ where: { mailboxId }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: selectCalendar })).map(output);
}

export async function criarAgenda(mailboxId: string, input: unknown) {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new CalendarError(parsed.error.issues[0]?.message ?? "Agenda inválida.", 422);
  const position = (await prisma.mailCalendar.aggregate({ where: { mailboxId }, _max: { position: true } }))._max.position ?? -1;
  try {
    const id = randomUUID();
    return output(await prisma.mailCalendar.create({ data: { id, mailboxId, href: id, name: parsed.data.name, color: parsed.data.color.toUpperCase(), position: position + 1 }, select: selectCalendar }));
  }
  catch (error) { if (typeof error === "object" && error && "code" in error && error.code === "P2002") throw new CalendarError("Já existe uma agenda com esse nome.", 409); throw error; }
}

export async function atualizarAgenda(mailboxId: string, id: string, input: unknown) {
  const parsed = patchSchema.safeParse(input);
  if (!parsed.success) throw new CalendarError(parsed.error.issues[0]?.message ?? "Agenda inválida.", 422);
  let changed;
  try {
    changed = await prisma.mailCalendar.updateMany({ where: { id, mailboxId }, data: { ...(parsed.data.name ? { name: parsed.data.name } : {}), ...(parsed.data.color ? { color: parsed.data.color.toUpperCase() } : {}) } });
  } catch (error) {
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") throw new CalendarError("Já existe uma agenda com esse nome.", 409);
    throw error;
  }
  if (!changed.count) throw new CalendarError("Agenda não encontrada.", 404);
  return output(await prisma.mailCalendar.findUniqueOrThrow({ where: { id }, select: selectCalendar }));
}

export async function excluirAgenda(mailboxId: string, id: string) {
  const calendars = await prisma.mailCalendar.findMany({ where: { mailboxId }, orderBy: { position: "asc" }, select: { id: true, isDefault: true } });
  const target = calendars.find((calendar) => calendar.id === id);
  if (!target) throw new CalendarError("Agenda não encontrada.", 404);
  if (calendars.length === 1) throw new CalendarError("A última agenda não pode ser excluída.", 409);
  await prisma.$transaction(async (tx) => {
    await tx.mailCalendar.delete({ where: { id } });
    if (target.isDefault) await tx.mailCalendar.update({ where: { id: calendars.find((calendar) => calendar.id !== id)!.id }, data: { isDefault: true } });
    await tx.mailbox.update({ where: { id: mailboxId }, data: { davCalendarSeq: { increment: 1 } } });
  });
  return { ok: true };
}
