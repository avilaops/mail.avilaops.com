import { createHash } from "node:crypto";
import { prisma } from "../lib/db.js";
import { lerEvento } from "../dav/ical.js";
import { DavError, gravarItem } from "../dav/store.js";
import { consumeUploads } from "./uploads.js";
import { CalendarError } from "./calendar.js";
import { garantirAgendaPadrao } from "./calendars.js";

const MAX_ARQUIVO_ICS = 50 * 1024 * 1024;
const MAX_EVENTOS_IMPORTACAO = 10_000;

function componentes(corpo: string, nome: "VEVENT" | "VTIMEZONE"): string[] {
  const resultado: string[] = [];
  const regex = new RegExp(`BEGIN:${nome}\\r?\\n[\\s\\S]*?END:${nome}(?:\\r?\\n|$)`, "gi");
  for (const match of corpo.matchAll(regex)) resultado.push(match[0]!.replace(/\r?\n/g, "\r\n").replace(/\r\n?$/, "") + "\r\n");
  return resultado;
}

function uidDoComponente(componente: string): string | null {
  const uid = componente.replace(/\r?\n[ \t]/g, "").match(/(?:^|\r?\n)UID(?:;[^:]*)?:(.+?)(?:\r?\n|$)/i)?.[1]?.trim();
  return uid || null;
}

export interface ResultadoImportacao {
  importados: number;
  ignorados: number;
  erros: number;
}

export async function importarIcs(mailboxId: string, uploadId: string, agendaId?: string): Promise<ResultadoImportacao> {
  const anexos = await consumeUploads(mailboxId, [uploadId]);
  const anexo = anexos[0];
  if (!anexo) throw new CalendarError("Arquivo não encontrado.", 404);
  if (!/\.ics$/i.test(anexo.filename) && !/^text\/calendar(?:;|$)/i.test(anexo.contentType)) throw new CalendarError("Envie um arquivo .ics.", 422);
  if (anexo.content.byteLength > MAX_ARQUIVO_ICS) throw new CalendarError("Arquivo .ics maior que 50 MB.", 413);
  const corpo = anexo.content.toString("utf8");
  if (!/BEGIN:VCALENDAR/i.test(corpo)) throw new CalendarError("Arquivo .ics inválido.", 422);

  const agenda = agendaId
    ? await prisma.mailCalendar.findFirst({ where: { id: agendaId, mailboxId } })
    : await garantirAgendaPadrao(mailboxId);
  if (!agenda) throw new CalendarError("Agenda não encontrada.", 404);

  const eventos = componentes(corpo, "VEVENT");
  if (eventos.length > MAX_EVENTOS_IMPORTACAO) throw new CalendarError(`O arquivo excede ${MAX_EVENTOS_IMPORTACAO} eventos.`, 413);
  const fusos = componentes(corpo, "VTIMEZONE").join("");
  const grupos = new Map<string, string[]>();
  let erros = 0;
  for (const componente of eventos) {
    const uid = uidDoComponente(componente);
    if (!uid) { erros += 1; continue; }
    const grupo = grupos.get(uid) ?? [];
    grupo.push(componente);
    grupos.set(uid, grupo);
  }

  let importados = 0;
  let ignorados = 0;
  for (const [uid, grupo] of grupos) {
    if (await prisma.mailDavItem.findFirst({ where: { mailboxId, collection: "calendar", calendarId: agenda.id, uid, deletedAt: null }, select: { id: true } })) {
      ignorados += 1;
      continue;
    }
    const item = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Avila Ops//Avila Mail//PT-BR\r\n${fusos}${grupo.join("")}END:VCALENDAR\r\n`;
    if (!lerEvento(item)) { erros += 1; continue; }
    const href = `import-${createHash("sha256").update(uid).digest("hex").slice(0, 32)}.ics`;
    try {
      await gravarItem({ mailboxId, colecao: "calendar", calendarId: agenda.id, href, corpo: item, ifNoneMatchAll: true });
      importados += 1;
    } catch (error) {
      if (error instanceof DavError && error.statusCode === 412) ignorados += 1;
      else erros += 1;
    }
  }
  return { importados, ignorados, erros };
}

export async function exportarIcs(mailboxId: string, agendaId?: string) {
  if (agendaId && !(await prisma.mailCalendar.findFirst({ where: { id: agendaId, mailboxId }, select: { id: true } }))) throw new CalendarError("Agenda não encontrada.", 404);
  const itens = await prisma.mailDavItem.findMany({
    where: { mailboxId, collection: "calendar", deletedAt: null, ...(agendaId ? { calendarId: agendaId } : {}) },
    orderBy: [{ calendarId: "asc" }, { href: "asc" }],
    select: { data: true },
  });
  const blocos = itens.flatMap((item) => [...componentes(item.data, "VTIMEZONE"), ...componentes(item.data, "VEVENT")]);
  const corpo = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Avila Ops//Avila Mail//PT-BR\r\n${blocos.join("")}END:VCALENDAR\r\n`;
  return { filename: "agenda-avila-mail.ics", contentType: "text/calendar; charset=utf-8", content: Buffer.from(corpo, "utf8") };
}
