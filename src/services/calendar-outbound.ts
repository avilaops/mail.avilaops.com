import { desdobrarLinhas, gerarEventoIcal } from "../dav/ical.js";
import type { EventoCalendario } from "./calendar.js";
import type { CalendarInviteOutboxInput } from "../dav/store.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { ComposeError, sendMessage, validarEnderecoDeEnvio } from "./compose.js";

const log = createLogger("calendar-invite-outbox");

export type MetodoConviteSaida = "REQUEST" | "CANCEL";
type EventoConviteSaida = EventoCalendario & { recorrenciaId?: string };

function escaparHtml(valor: string): string {
  return valor.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function paraIcal(evento: EventoConviteSaida): string {
  const corpo = gerarEventoIcal({
    uid: evento.uid,
    titulo: evento.titulo,
    inicio: evento.inicio,
    fim: evento.fim,
    diaInteiro: evento.diaInteiro,
    fuso: evento.fuso,
    criadoEm: evento.criadoEm,
    modificadoEm: evento.modificadoEm,
    dtstamp: evento.dtstamp,
    sequencia: evento.sequencia,
    ...(evento.local ? { local: evento.local } : {}),
    ...(evento.descricao ? { descricao: evento.descricao } : {}),
    ...(evento.recorrencia ? { recorrencia: evento.recorrencia } : {}),
    lembretes: [],
    convidados: evento.convidados,
    ...(evento.organizador ? { organizador: evento.organizador } : {}),
    disponibilidade: evento.disponibilidade,
  });
  return corpo;
}

function dataUtcIcal(iso: string, diaInteiro: boolean): string {
  const data = new Date(iso);
  const dois = (valor: number) => String(valor).padStart(2, "0");
  const dia = `${data.getUTCFullYear()}${dois(data.getUTCMonth() + 1)}${dois(data.getUTCDate())}`;
  return diaInteiro ? dia : `${dia}T${dois(data.getUTCHours())}${dois(data.getUTCMinutes())}${dois(data.getUTCSeconds())}Z`;
}

export function conviteIcalSaida(evento: EventoConviteSaida, metodo: MetodoConviteSaida, opcoes: { rangeThisAndFuture?: boolean } = {}): string {
  const linhas = desdobrarLinhas(paraIcal(evento));
  linhas.splice(2, 0, `METHOD:${metodo}`);
  if (evento.recorrenciaId) {
    const inicio = linhas.findIndex((linha) => /^DTSTART(?:;|:)/i.test(linha));
    linhas.splice(inicio, 0, `RECURRENCE-ID${evento.diaInteiro ? ";VALUE=DATE" : ""}${opcoes.rangeThisAndFuture ? ";RANGE=THISANDFUTURE" : ""}:${dataUtcIcal(evento.recorrenciaId, evento.diaInteiro)}`);
  }
  if (metodo === "CANCEL") {
    const fim = linhas.findIndex((linha) => linha.toUpperCase() === "END:VEVENT");
    const status = linhas.findIndex((linha) => /^STATUS:/i.test(linha));
    if (status >= 0 && status < fim) linhas[status] = "STATUS:CANCELLED";
    else linhas.splice(fim, 0, "STATUS:CANCELLED");
  }
  return `${linhas.join("\r\n")}\r\n`;
}

export async function enviarConviteAgenda(
  mailboxId: string,
  evento: EventoConviteSaida,
  metodo: MetodoConviteSaida,
  destinatarios: string[],
  opcoes: { rangeThisAndFuture?: boolean } = {},
): Promise<{ queuedId: string } | null> {
  const unicos = [...new Set(destinatarios.map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (unicos.length === 0) return null;
  if (!evento.organizador) throw new Error("Evento com convidados precisa de organizador.");
  const verbo = metodo === "CANCEL" ? "cancelou" : "convidou você para";
  const data = new Date(evento.inicio).toLocaleString("pt-BR", { dateStyle: "full", timeStyle: evento.diaInteiro ? undefined : "short", timeZone: evento.fuso });
  const texto = `${evento.organizador} ${verbo} “${evento.titulo}”.\nData: ${data}${evento.local ? `\nLocal: ${evento.local}` : ""}`;
  const html = `<p><strong>${escaparHtml(evento.organizador)}</strong> ${verbo} <strong>${escaparHtml(evento.titulo)}</strong>.</p><p>Data: ${escaparHtml(data)}${evento.local ? `<br>Local: ${escaparHtml(evento.local)}` : ""}</p>`;
  const resultado = await sendMessage({
    mailboxId,
    fromAddress: evento.organizador,
    to: unicos,
    subject: `${metodo === "CANCEL" ? "Cancelado" : "Convite"}: ${evento.titulo}`,
    text: texto,
    html,
    attachments: [{
      filename: "invite.ics",
      contentType: `text/calendar; method=${metodo}; charset=utf-8`,
      contentBase64: Buffer.from(conviteIcalSaida(evento, metodo, opcoes)).toString("base64"),
    }],
  });
  return { queuedId: resultado.queuedId };
}

export function prepararConviteAgenda(
  evento: EventoConviteSaida,
  metodo: MetodoConviteSaida,
  destinatarios: string[],
  dedupeKey: string,
  opcoes: { rangeThisAndFuture?: boolean } = {},
): CalendarInviteOutboxInput | null {
  const recipients = [...new Set(destinatarios.map((item) => item.trim().toLowerCase()).filter(Boolean))];
  if (recipients.length === 0) return null;
  if (!evento.organizador) throw new Error("Evento com convidados precisa de organizador.");
  const verbo = metodo === "CANCEL" ? "cancelou" : "convidou você para";
  const data = new Date(evento.inicio).toLocaleString("pt-BR", { dateStyle: "full", timeStyle: evento.diaInteiro ? undefined : "short", timeZone: evento.fuso });
  const text = `${evento.organizador} ${verbo} “${evento.titulo}”.\nData: ${data}${evento.local ? `\nLocal: ${evento.local}` : ""}`;
  const html = `<p><strong>${escaparHtml(evento.organizador)}</strong> ${verbo} <strong>${escaparHtml(evento.titulo)}</strong>.</p><p>Data: ${escaparHtml(data)}${evento.local ? `<br>Local: ${escaparHtml(evento.local)}` : ""}</p>`;
  return { dedupeKey, fromAddress: evento.organizador, recipients, subject: `${metodo === "CANCEL" ? "Cancelado" : "Convite"}: ${evento.titulo}`, text, html, ical: conviteIcalSaida(evento, metodo, opcoes), method: metodo };
}

export async function validarOrganizadorConvite(mailboxId: string, evento: EventoConviteSaida, destinatarios: string[]): Promise<void> {
  if (destinatarios.length === 0) return;
  if (!evento.organizador) throw new ComposeError("Evento com convidados precisa de organizador.", 422);
  await validarEnderecoDeEnvio(mailboxId, evento.organizador);
}

export async function processarFilaConvitesAgenda(agora = new Date()): Promise<{ enviados: number }> {
  await prisma.calendarInviteDelivery.updateMany({ where: { status: "processing", lastAttemptAt: { lt: new Date(agora.getTime() - 5 * 60_000) } }, data: { status: "pending", nextAttemptAt: agora } });
  const fila = await prisma.calendarInviteDelivery.findMany({ where: { status: "pending", nextAttemptAt: { lte: agora } }, orderBy: { nextAttemptAt: "asc" }, take: 100 });
  let enviados = 0;
  for (const entrega of fila) {
    const claim = await prisma.calendarInviteDelivery.updateMany({ where: { id: entrega.id, status: "pending" }, data: { status: "processing", attempts: { increment: 1 }, lastAttemptAt: agora } });
    if (claim.count === 0) continue;
    try {
      const resultado = await sendMessage({ mailboxId: entrega.mailboxId, fromAddress: entrega.fromAddress, to: entrega.recipients as string[], subject: entrega.subject, text: entrega.text, html: entrega.html, idempotencyKey: `calendar-invite:${entrega.id}`, attachments: [{ filename: "invite.ics", contentType: `text/calendar; method=${entrega.method}; charset=utf-8`, contentBase64: Buffer.from(entrega.ical).toString("base64") }] });
      await prisma.calendarInviteDelivery.update({ where: { id: entrega.id }, data: { status: "sent", deliveredAt: agora, outboundId: resultado.queuedId } });
      enviados += 1;
    } catch (error) {
      const permanente = error instanceof ComposeError && error.statusCode !== 429;
      const atraso = Math.min(60 * 60_000, 60_000 * 2 ** Math.min(entrega.attempts, 6));
      await prisma.calendarInviteDelivery.update({ where: { id: entrega.id }, data: permanente ? { status: "failed" } : { status: "pending", nextAttemptAt: new Date(agora.getTime() + atraso) } });
      log.warn("entrega de convite sera repetida", { id: entrega.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { enviados };
}

export function iniciarFilaConvitesAgenda(intervaloMs = 10_000): () => void {
  let executando = false;
  const rodar = async () => { if (executando) return; executando = true; try { await processarFilaConvitesAgenda(); } catch (error) { log.error("fila de convites falhou", { error: error instanceof Error ? error.message : String(error) }); } finally { executando = false; } };
  void rodar();
  const timer = setInterval(() => void rodar(), intervaloMs);
  return () => clearInterval(timer);
}

export function convidadosAfetados(antes: EventoCalendario, depois: EventoCalendario): { request: string[]; cancel: string[] } {
  const anteriores = new Set(antes.convidados.map((item) => item.email.toLowerCase()));
  const atuais = new Set(depois.convidados.map((item) => item.email.toLowerCase()));
  const mudouAgenda = antes.inicio !== depois.inicio || antes.fim !== depois.fim || antes.local !== depois.local || antes.diaInteiro !== depois.diaInteiro || antes.fuso !== depois.fuso;
  return {
    request: [...atuais].filter((email) => mudouAgenda || !anteriores.has(email)),
    cancel: [...anteriores].filter((email) => !atuais.has(email)),
  };
}
