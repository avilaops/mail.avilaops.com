import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { lerEvento } from "../dav/ical.js";
import { expandirRecorrencias } from "../dav/recorrencia.js";
import { avisoPermitido, enviarAviso, type AvisoPush } from "./push.js";

const log = createLogger("calendar-reminders");
const JANELA_MS = 60_000;
const MAXIMO_LEMBRETE_MINUTOS = 525_600;

export interface LembretePendente {
  uid: string;
  href: string;
  occurrenceAt: Date;
  minutesBefore: number;
  titulo: string;
}

/** Calcula lembretes sem tocar no banco; o relogio controlado deixa os casos de borda reproduziveis. */
export function lembretesPendentesDoItem(corpo: string, href: string, agora: Date, janelaMs = JANELA_MS): LembretePendente[] {
  const mestre = lerEvento(corpo);
  if (!mestre?.dtStart || !mestre.dtEnd || !mestre.uid) return [];
  const minutos = [...corpo.matchAll(/TRIGGER:-PT(\d+)M(?:\r?\n|$)/gi)].map((item) => Number(item[1])).filter((valor) => Number.isInteger(valor) && valor >= 0 && valor <= MAXIMO_LEMBRETE_MINUTOS);
  const maior = Math.max(0, ...minutos, ...mestre.reminders.map((item) => item.minutosAntes));
  if (maior === 0 && mestre.reminders.every((item) => item.minutosAntes !== 0)) return [];
  const inicioJanela = agora.getTime() - janelaMs;
  const fimBusca = new Date(agora.getTime() + maior * 60_000 + janelaMs);
  const ocorrencias = expandirRecorrencias(corpo, { inicio: new Date(inicioJanela), fim: fimBusca, limite: 10_000, limiteCandidatos: 100_000 });
  const fimJanela = agora.getTime() + janelaMs;
  const pendentes: LembretePendente[] = [];
  for (const ocorrencia of ocorrencias) {
    for (const lembrete of ocorrencia.evento.reminders) {
      const vence = ocorrencia.inicio.getTime() - lembrete.minutosAntes * 60_000;
      if (vence < inicioJanela || vence >= fimJanela) continue;
      pendentes.push({
        uid: ocorrencia.uid ?? mestre.uid,
        href,
        occurrenceAt: ocorrencia.recorrenciaId,
        minutesBefore: lembrete.minutosAntes,
        titulo: ocorrencia.evento.summary ?? mestre.summary ?? "Evento da agenda",
      });
    }
  }
  return pendentes;
}

export interface OpcoesVarreduraLembretes {
  agora?: Date;
  janelaMs?: number;
  enviar?: (mailboxId: string, aviso: AvisoPush) => Promise<unknown>;
}

export async function varrerLembretesAgenda(opcoes: OpcoesVarreduraLembretes = {}): Promise<{ enviados: number }> {
  const agora = opcoes.agora ?? new Date();
  const janelaMs = opcoes.janelaMs ?? JANELA_MS;
  const enviar = opcoes.enviar ?? enviarAviso;
  const itens = await prisma.mailDavItem.findMany({
    where: {
      collection: "calendar",
      deletedAt: null,
      OR: [{ recurring: true }, { dtStart: { gte: new Date(agora.getTime() - janelaMs), lte: new Date(agora.getTime() + MAXIMO_LEMBRETE_MINUTOS * 60_000 + janelaMs) } }],
    },
    select: { mailboxId: true, href: true, data: true },
  });
  let enviados = 0;
  for (const item of itens) {
    let pendentes: LembretePendente[];
    try {
      pendentes = lembretesPendentesDoItem(item.data, item.href, agora, janelaMs);
    } catch (error) {
      log.warn("evento invalido ignorado na varredura de lembretes", { href: item.href, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    for (const lembrete of pendentes) {
      const data = lembrete.occurrenceAt.toISOString().slice(0, 10);
      const aviso: AvisoPush = { titulo: lembrete.titulo, corpo: lembrete.minutesBefore === 0 ? "Começa agora" : `Começa em ${lembrete.minutesBefore} min`, tipo: "calendario", url: `/agenda?data=${data}&evento=${encodeURIComponent(lembrete.href)}`, notificationTag: `calendar:${lembrete.uid}:${lembrete.occurrenceAt.toISOString()}:${lembrete.minutesBefore}` };
      if (!(await avisoPermitido(item.mailboxId, aviso, agora))) continue;
      await prisma.calendarReminderDelivery.upsert({
        where: { mailboxId_uid_occurrenceAt_minutesBefore: { mailboxId: item.mailboxId, uid: lembrete.uid, occurrenceAt: lembrete.occurrenceAt, minutesBefore: lembrete.minutesBefore } },
        create: { mailboxId: item.mailboxId, uid: lembrete.uid, href: lembrete.href, title: lembrete.titulo, occurrenceAt: lembrete.occurrenceAt, minutesBefore: lembrete.minutesBefore },
        update: {},
      });
    }
  }
  await prisma.calendarReminderDelivery.updateMany({ where: { status: "processing", lastAttemptAt: { lt: new Date(agora.getTime() - 5 * 60_000) } }, data: { status: "pending", nextAttemptAt: agora } });
  const fila = await prisma.calendarReminderDelivery.findMany({ where: { status: "pending", nextAttemptAt: { lte: agora } }, orderBy: { nextAttemptAt: "asc" }, take: 500 });
  for (const lembrete of fila) {
    const data = lembrete.occurrenceAt.toISOString().slice(0, 10);
    const aviso: AvisoPush = { titulo: lembrete.title, corpo: lembrete.minutesBefore === 0 ? "Começa agora" : `Começa em ${lembrete.minutesBefore} min`, tipo: "calendario", url: `/agenda?data=${data}&evento=${encodeURIComponent(lembrete.href)}`, notificationTag: `calendar:${lembrete.uid}:${lembrete.occurrenceAt.toISOString()}:${lembrete.minutesBefore}` };
    if (!(await avisoPermitido(lembrete.mailboxId, aviso, agora))) {
      await prisma.calendarReminderDelivery.update({ where: { id: lembrete.id }, data: { status: "suppressed" } });
      continue;
    }
    const claim = await prisma.calendarReminderDelivery.updateMany({ where: { id: lembrete.id, status: "pending" }, data: { status: "processing", attempts: { increment: 1 }, lastAttemptAt: agora } });
    if (claim.count === 0) continue;
    try {
      const resultado = await enviar(lembrete.mailboxId, aviso) as { tentativas?: number; enviados?: number } | undefined;
      if (resultado && (resultado.tentativas ?? 0) > 0 && (resultado.enviados ?? 0) === 0) throw new Error("Nenhum endpoint push aceitou o lembrete.");
      await prisma.calendarReminderDelivery.update({ where: { id: lembrete.id }, data: { status: "sent", deliveredAt: agora } });
      enviados += 1;
    } catch (error) {
      await prisma.calendarReminderDelivery.update({ where: { id: lembrete.id }, data: { status: "pending", nextAttemptAt: new Date(agora.getTime() + 60_000) } });
      log.warn("entrega de lembrete sera repetida", { id: lembrete.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { enviados };
}

export function iniciarLembretesAgenda(intervaloMs = JANELA_MS): () => void {
  let executando = false;
  const rodar = async () => {
    if (executando) return;
    executando = true;
    try { await varrerLembretesAgenda(); }
    catch (error) { log.error("varredura de lembretes falhou", { error: error instanceof Error ? error.message : String(error) }); }
    finally { executando = false; }
  };
  void rodar();
  const timer = setInterval(() => void rodar(), intervaloMs);
  return () => clearInterval(timer);
}
