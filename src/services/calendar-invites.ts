import { simpleParser } from "mailparser";
import { createHash } from "node:crypto";
import { prisma } from "../lib/db.js";
import { desdobrarLinhas, escaparTextoIcal, gerarEventoIcal, lerDataIcal, lerEvento } from "../dav/ical.js";
import { expandirRecorrencias } from "../dav/recorrencia.js";
import { DavError, gravarItem } from "../dav/store.js";
import { readRaw } from "../lib/storage.js";
import { sendMessage } from "./compose.js";
import { garantirAgendaPadrao } from "./calendars.js";

export interface ConviteMensagem {
  metodo: "REQUEST" | "CANCEL";
  uid: string;
  titulo: string;
  inicio: string;
  fim: string;
  diaInteiro: boolean;
  local?: string;
  organizador?: string;
  minhaResposta: "pendente" | "aceito" | "recusado" | "talvez";
  sequencia: number;
  conflito: boolean;
  cancelado: boolean;
  recorrenciaId?: string;
  cancelamento?: "aplicado" | "obsoleto" | "nao_confiavel" | "novo";
  alteracoes: string[];
}

export type RespostaConvite = "aceito" | "talvez" | "recusado";

export class CalendarInviteError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
    this.name = "CalendarInviteError";
  }
}

function metodoDoIcal(corpo: string): "REQUEST" | "CANCEL" | null {
  const metodo = desdobrarLinhas(corpo).find((linha) => /^METHOD:/i.test(linha))?.slice(7).trim().toUpperCase();
  return metodo === "REQUEST" || metodo === "CANCEL" ? metodo : null;
}

export async function extrairIcalDaMensagem(raw: Buffer): Promise<string | null> {
  const mensagem = await simpleParser(raw);
  const parte = mensagem.attachments.find((anexo) => anexo.contentType.toLowerCase() === "text/calendar" || anexo.filename?.toLowerCase().endsWith(".ics"));
  if (!parte || parte.content.length > 2 * 1024 * 1024) return null;
  const texto = parte.content.toString("utf8");
  return /BEGIN:VCALENDAR/i.test(texto) ? texto : null;
}

function alteracoesDoEvento(atual: ReturnType<typeof lerEvento>, recebido: NonNullable<ReturnType<typeof lerEvento>>): string[] {
  if (!atual) return [];
  const alteracoes: string[] = [];
  if (atual.summary !== recebido.summary) alteracoes.push("titulo");
  if (atual.dtStart?.getTime() !== recebido.dtStart?.getTime() || atual.dtEnd?.getTime() !== recebido.dtEnd?.getTime()) alteracoes.push("horario");
  if (atual.location !== recebido.location) alteracoes.push("local");
  return alteracoes;
}

function cancelarCorpo(corpo: string, sequencia: number): string {
  const linhas = desdobrarLinhas(corpo);
  const inicio = linhas.findIndex((linha) => linha.toUpperCase() === "BEGIN:VEVENT");
  const fim = linhas.findIndex((linha, indice) => indice > inicio && linha.toUpperCase() === "END:VEVENT");
  if (inicio < 0 || fim < 0) return corpo;
  const status = linhas.findIndex((linha, indice) => indice > inicio && indice < fim && /^STATUS:/i.test(linha));
  if (status >= 0) linhas[status] = "STATUS:CANCELLED";
  else linhas.splice(fim, 0, "STATUS:CANCELLED");
  const indiceSequencia = linhas.findIndex((linha, indice) => indice > inicio && indice < fim && /^SEQUENCE:/i.test(linha));
  if (indiceSequencia >= 0) linhas[indiceSequencia] = `SEQUENCE:${sequencia}`;
  else linhas.splice(fim, 0, `SEQUENCE:${sequencia}`);
  return `${linhas.join("\r\n")}\r\n`;
}

function lerRecorrenciaId(corpo: string): Date | null {
  const linha = desdobrarLinhas(corpo).find((item) => /^RECURRENCE-ID(?:;|:)/i.test(item));
  if (!linha) return null;
  const separador = linha.indexOf(":");
  if (separador < 0) return null;
  const tzid = linha.slice(0, separador).match(/(?:^|;)TZID=(?:"([^"]+)"|([^;:]+))/i);
  return lerDataIcal(linha.slice(separador + 1).trim(), { tzid: tzid?.[1] ?? tzid?.[2] })?.data ?? null;
}

function normalizarEndereco(valor?: string | null): string | null {
  if (!valor) return null;
  const endereco = valor.replace(/^mailto:/i, "").trim().toLowerCase();
  return endereco || null;
}

function recorrenciaDaLinha(linha: string): Date | null {
  const separador = linha.indexOf(":");
  if (separador < 0) return null;
  const tzid = linha.slice(0, separador).match(/(?:^|;)TZID=(?:"([^"]+)"|([^;:]+))/i);
  return lerDataIcal(linha.slice(separador + 1).trim(), { tzid: tzid?.[1] ?? tzid?.[2] })?.data ?? null;
}

function sequenciaDaOcorrencia(corpo: string, recorrenciaId: Date): number | null {
  const linhas = desdobrarLinhas(corpo);
  let inicio = -1;
  for (let indice = 0; indice < linhas.length; indice += 1) {
    if (linhas[indice]?.toUpperCase() === "BEGIN:VEVENT") inicio = indice;
    if (inicio < 0 || linhas[indice]?.toUpperCase() !== "END:VEVENT") continue;
    const componente = linhas.slice(inicio + 1, indice);
    const linhaId = componente.find((linha) => /^RECURRENCE-ID(?:;|:)/i.test(linha));
    if (linhaId && recorrenciaDaLinha(linhaId)?.getTime() === recorrenciaId.getTime()) {
      const valor = Number(componente.find((linha) => /^SEQUENCE:/i.test(linha))?.slice(9) ?? 0);
      return Number.isFinite(valor) ? valor : 0;
    }
    inicio = -1;
  }
  return null;
}

function gravarCancelamentoDeOcorrencia(corpoAtual: string, corpoCancelamento: string, recorrenciaId: Date): string {
  const atuais = desdobrarLinhas(corpoAtual);
  let inicio = -1;
  for (let indice = 0; indice < atuais.length; indice += 1) {
    if (atuais[indice]?.toUpperCase() === "BEGIN:VEVENT") inicio = indice;
    if (inicio < 0 || atuais[indice]?.toUpperCase() !== "END:VEVENT") continue;
    const linhaId = atuais.slice(inicio + 1, indice).find((linha) => /^RECURRENCE-ID(?:;|:)/i.test(linha));
    if (linhaId && recorrenciaDaLinha(linhaId)?.getTime() === recorrenciaId.getTime()) {
      atuais.splice(inicio, indice - inicio + 1);
      break;
    }
    inicio = -1;
  }
  const recebidas = desdobrarLinhas(corpoCancelamento);
  const inicioRecebido = recebidas.findIndex((linha) => linha.toUpperCase() === "BEGIN:VEVENT");
  const fimRecebido = recebidas.findIndex((linha, indice) => indice > inicioRecebido && linha.toUpperCase() === "END:VEVENT");
  if (inicioRecebido < 0 || fimRecebido < 0) throw new Error("CANCEL sem VEVENT.");
  const componente = recebidas.slice(inicioRecebido, fimRecebido + 1);
  if (!componente.some((linha) => /^STATUS:/i.test(linha))) componente.splice(componente.length - 1, 0, "STATUS:CANCELLED");
  const fimCalendario = atuais.findIndex((linha) => linha.toUpperCase() === "END:VCALENDAR");
  atuais.splice(fimCalendario, 0, ...componente);
  return `${atuais.join("\r\n")}\r\n`;
}

async function aplicarCancelamento(
  mailboxId: string,
  existente: { href: string; etag: string; data: string },
  sequencia: number,
  recorrenciaId: Date | null,
  corpoCancelamento: string,
): Promise<"aplicado" | "obsoleto"> {
  let item = existente;
  for (let tentativa = 0; tentativa < 2; tentativa += 1) {
    const atual = lerEvento(item.data);
    const sequenciaAtual = recorrenciaId ? (sequenciaDaOcorrencia(item.data, recorrenciaId) ?? atual?.sequence ?? 0) : (atual?.sequence ?? 0);
    if (!atual || sequencia <= sequenciaAtual) return "obsoleto";
    const corpo = recorrenciaId ? gravarCancelamentoDeOcorrencia(item.data, corpoCancelamento, recorrenciaId) : cancelarCorpo(item.data, sequencia);
    try {
      await gravarItem({ mailboxId, colecao: "calendar", href: item.href, corpo, ifMatch: item.etag });
      return "aplicado";
    } catch (erro) {
      if (!(erro instanceof DavError) || erro.statusCode !== 412 || tentativa > 0) return "obsoleto";
      const recarregado = await prisma.mailDavItem.findFirst({
        where: { mailboxId, collection: "calendar", href: item.href, deletedAt: null },
        select: { href: true, etag: true, data: true },
      });
      if (!recarregado) return "obsoleto";
      item = recarregado;
    }
  }
  return "obsoleto";
}

function sobrepoe(inicioA: Date, fimA: Date, inicioB: Date, fimB: Date): boolean {
  return inicioA < fimB && fimA > inicioB;
}

function eventoPersistido(corpo: string, enderecoCaixa: string, resposta: RespostaConvite): string {
  const evento = lerEvento(corpo);
  if (!evento?.uid || !evento.dtStart || !evento.dtEnd) throw new CalendarInviteError("Convite de agenda invalido.", 422);
  const agora = new Date().toISOString();
  const convidados = evento.attendees.map((convidado) => convidado.email.toLowerCase() === enderecoCaixa.toLowerCase() ? { ...convidado, resposta } : convidado);
  if (!convidados.some((convidado) => convidado.email.toLowerCase() === enderecoCaixa.toLowerCase())) convidados.push({ email: enderecoCaixa, resposta });
  return gerarEventoIcal({
    uid: evento.uid,
    titulo: evento.summary ?? "Convite sem título",
    inicio: evento.dtStart.toISOString(),
    fim: evento.dtEnd.toISOString(),
    diaInteiro: evento.allDay,
    fuso: evento.timezone ?? "UTC",
    criadoEm: evento.createdAt?.toISOString() ?? agora,
    modificadoEm: agora,
    dtstamp: agora,
    sequencia: evento.sequence,
    ...(evento.location ? { local: evento.location } : {}),
    ...(evento.description ? { descricao: evento.description } : {}),
    ...(evento.rrule ? { recorrencia: evento.rrule } : {}),
    lembretes: evento.reminders,
    convidados,
    ...(evento.organizer ? { organizador: evento.organizer } : {}),
    disponibilidade: evento.transparency === "TRANSPARENT" ? "livre" : "ocupado",
  });
}

const partstatPorResposta: Record<RespostaConvite, string> = { aceito: "ACCEPTED", talvez: "TENTATIVE", recusado: "DECLINED" };

function linhaAttendeeComResposta(linha: string, resposta: RespostaConvite): string {
  const separador = linha.indexOf(":");
  if (separador < 0) return linha;
  let cabecalho = linha.slice(0, separador);
  if (/;PARTSTAT=[^;:]*/i.test(cabecalho)) cabecalho = cabecalho.replace(/;PARTSTAT=[^;:]*/i, `;PARTSTAT=${partstatPorResposta[resposta]}`);
  else cabecalho += `;PARTSTAT=${partstatPorResposta[resposta]}`;
  return `${cabecalho}:${linha.slice(separador + 1)}`;
}

function componenteDoConvite(corpo: string): string[] {
  const linhas = desdobrarLinhas(corpo);
  const inicio = linhas.findIndex((linha) => linha.toUpperCase() === "BEGIN:VEVENT");
  const fim = linhas.findIndex((linha, indice) => indice > inicio && linha.toUpperCase() === "END:VEVENT");
  if (inicio < 0 || fim < 0) throw new CalendarInviteError("Convite sem VEVENT.", 422);
  return linhas.slice(inicio, fim + 1);
}

function aplicarRespostaEmComponente(componente: string[], enderecoCaixa: string, resposta: RespostaConvite): string[] {
  const normalizado = enderecoCaixa.toLowerCase();
  let encontrou = false;
  const atualizado = componente.map((linha) => {
    if (!/^ATTENDEE(?:;|:)/i.test(linha) || linha.slice(linha.indexOf(":") + 1).replace(/^mailto:/i, "").trim().toLowerCase() !== normalizado) return linha;
    encontrou = true;
    return linhaAttendeeComResposta(linha, resposta);
  });
  if (!encontrou) atualizado.splice(atualizado.length - 1, 0, `ATTENDEE;PARTSTAT=${partstatPorResposta[resposta]}:mailto:${enderecoCaixa}`);
  return atualizado;
}

function atualizarRespostaPersistida(corpoAtual: string, corpoConvite: string, enderecoCaixa: string, resposta: RespostaConvite, recorrenciaId: Date | null): string {
  const linhas = desdobrarLinhas(corpoAtual);
  let inicio = -1;
  for (let indice = 0; indice < linhas.length; indice += 1) {
    if (linhas[indice]?.toUpperCase() === "BEGIN:VEVENT") inicio = indice;
    if (inicio < 0 || linhas[indice]?.toUpperCase() !== "END:VEVENT") continue;
    const componente = linhas.slice(inicio, indice + 1);
    const linhaId = componente.find((linha) => /^RECURRENCE-ID(?:;|:)/i.test(linha));
    const corresponde = recorrenciaId ? Boolean(linhaId && recorrenciaDaLinha(linhaId)?.getTime() === recorrenciaId.getTime()) : !linhaId;
    if (corresponde) {
      linhas.splice(inicio, componente.length, ...aplicarRespostaEmComponente(componente, enderecoCaixa, resposta));
      return `${linhas.join("\r\n")}\r\n`;
    }
    inicio = -1;
  }
  if (!recorrenciaId) throw new CalendarInviteError("Evento salvo sem componente mestre.", 422);
  const componente = aplicarRespostaEmComponente(componenteDoConvite(corpoConvite), enderecoCaixa, resposta);
  const fimCalendario = linhas.findIndex((linha) => linha.toUpperCase() === "END:VCALENDAR");
  linhas.splice(fimCalendario, 0, ...componente);
  return `${linhas.join("\r\n")}\r\n`;
}

function corpoReply(corpo: string, enderecoCaixa: string, resposta: RespostaConvite, comentario?: string): string {
  const evento = lerEvento(corpo);
  if (!evento?.uid || !evento.dtStart || !evento.dtEnd || !evento.organizer) throw new CalendarInviteError("Convite sem organizador.", 422);
  const base = gerarEventoIcal({
    uid: evento.uid,
    titulo: evento.summary ?? "Convite sem título",
    inicio: evento.dtStart.toISOString(),
    fim: evento.dtEnd.toISOString(),
    diaInteiro: evento.allDay,
    fuso: evento.timezone ?? "UTC",
    criadoEm: evento.createdAt?.toISOString() ?? new Date().toISOString(),
    modificadoEm: new Date().toISOString(),
    dtstamp: new Date().toISOString(),
    sequencia: evento.sequence,
    lembretes: [],
    convidados: [{ email: enderecoCaixa, resposta }],
    organizador: evento.organizer,
    disponibilidade: "livre",
  });
  const linhas = desdobrarLinhas(base);
  linhas.splice(2, 0, "METHOD:REPLY");
  const linhaRecorrencia = desdobrarLinhas(corpo).find((linha) => /^RECURRENCE-ID(?:;|:)/i.test(linha));
  if (linhaRecorrencia) linhas.splice(linhas.findIndex((linha) => /^DTSTART(?:;|:)/i.test(linha)), 0, linhaRecorrencia);
  if (comentario) linhas.splice(linhas.findIndex((linha) => linha.toUpperCase() === "END:VEVENT"), 0, `COMMENT:${escaparTextoIcal(comentario)}`);
  return `${linhas.join("\r\n")}\r\n`;
}

/** Persiste a resposta do dono e envia um iTIP REPLY assinado ao organizador. */
export async function responderConvite(
  mailboxId: string,
  messageId: string,
  resposta: RespostaConvite,
  comentario?: string,
): Promise<{ resposta: RespostaConvite; eventId: string; queuedId: string }> {
  const mensagem = await prisma.message.findFirst({
    where: { id: messageId, mailboxId },
    select: { storageKey: true, subject: true, fromAddress: true },
  });
  if (!mensagem) throw new CalendarInviteError("Mensagem nao encontrada.", 404);
  const caixa = await prisma.mailbox.findUnique({
    where: { id: mailboxId },
    select: { localPart: true, domain: { select: { name: true } } },
  });
  if (!caixa) throw new CalendarInviteError("Caixa nao encontrada.", 404);
  const enderecoCaixa = `${caixa.localPart}@${caixa.domain.name}`.toLowerCase();
  const corpo = await extrairIcalDaMensagem(await readRaw(mensagem.storageKey));
  const evento = corpo ? lerEvento(corpo) : null;
  if (!corpo || metodoDoIcal(corpo) !== "REQUEST" || !evento?.uid || !evento.organizer) {
    throw new CalendarInviteError("A mensagem nao contem um convite que aceite resposta.", 422);
  }
  if (!evento.attendees.some((convidado) => convidado.email.toLowerCase() === enderecoCaixa)) {
    throw new CalendarInviteError("Este convite nao foi destinado a sua caixa.", 403);
  }
  if (evento.organizer.toLowerCase() !== mensagem.fromAddress.toLowerCase()) {
    throw new CalendarInviteError("O organizador do convite nao corresponde ao remetente.", 422);
  }

  const hrefNovo = `invite-${createHash("sha256").update(evento.uid).digest("hex").slice(0, 32)}.ics`;
  const recorrenciaId = lerRecorrenciaId(corpo);
  let href = hrefNovo;
  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    const existente = await prisma.mailDavItem.findFirst({
      where: { mailboxId, collection: "calendar", uid: evento.uid, deletedAt: null },
      select: { href: true, etag: true, data: true, calendarId: true },
    });
    href = existente?.href ?? hrefNovo;
    const atual = existente ? lerEvento(existente.data) : null;
    const sequenciaAtual = recorrenciaId && existente ? (sequenciaDaOcorrencia(existente.data, recorrenciaId) ?? atual?.sequence ?? 0) : (atual?.sequence ?? -1);
    const corpoSalvar = existente && (recorrenciaId || sequenciaAtual > evento.sequence)
      ? atualizarRespostaPersistida(existente.data, corpo, enderecoCaixa, resposta, recorrenciaId)
      : eventoPersistido(corpo, enderecoCaixa, resposta);
    try {
      const agenda = await garantirAgendaPadrao(mailboxId);
      await gravarItem({ mailboxId, colecao: "calendar", calendarId: existente?.calendarId ?? agenda.id, href, corpo: corpoSalvar, ...(existente ? { ifMatch: existente.etag } : { ifNoneMatchAll: true }) });
      break;
    } catch (erro) {
      if (erro instanceof DavError && erro.statusCode === 412 && tentativa < 2) continue;
      if (erro instanceof DavError) throw new CalendarInviteError(erro.message, erro.statusCode);
      throw erro;
    }
  }
  const salvo = await prisma.mailDavItem.findFirstOrThrow({
    where: { mailboxId, collection: "calendar", href, deletedAt: null },
    select: { id: true },
  });
  const reply = corpoReply(corpo, enderecoCaixa, resposta, comentario);
  const envio = await sendMessage({
    mailboxId,
    to: [evento.organizer],
    subject: `Re: ${mensagem.subject ?? evento.summary ?? "Convite de agenda"}`,
    text: comentario?.trim() || `Resposta ao convite: ${resposta}.`,
    inReplyToMessageId: messageId,
    attachments: [{ filename: "invite.ics", contentType: "text/calendar; method=REPLY; charset=utf-8", contentBase64: Buffer.from(reply).toString("base64") }],
  });
  return { resposta, eventId: salvo.id, queuedId: envio.queuedId };
}

export async function resumirConvite(mailboxId: string, enderecoCaixa: string, corpo: string, remetente?: string): Promise<ConviteMensagem | null> {
  const metodo = metodoDoIcal(corpo);
  const evento = lerEvento(corpo);
  if (!metodo || !evento?.uid || !evento.dtStart || !evento.dtEnd) return null;
  const existente = await prisma.mailDavItem.findFirst({ where: { mailboxId, collection: "calendar", uid: evento.uid, deletedAt: null }, select: { href: true, etag: true, data: true } });
  const atual = existente ? lerEvento(existente.data) : null;
  const alteracoes = atual && evento.sequence > atual.sequence ? alteracoesDoEvento(atual, evento) : [];
  const recorrenciaId = lerRecorrenciaId(corpo);
  let cancelamento: ConviteMensagem["cancelamento"];
  if (metodo === "CANCEL") {
    if (!existente || !atual) cancelamento = "novo";
    else {
      const organizador = normalizarEndereco(evento.organizer);
      const confiavel = organizador !== null && organizador === normalizarEndereco(atual.organizer) && organizador === normalizarEndereco(remetente);
      if (!confiavel) cancelamento = "nao_confiavel";
      else if (evento.sequence <= atual.sequence) cancelamento = "obsoleto";
      else cancelamento = await aplicarCancelamento(mailboxId, existente, evento.sequence, recorrenciaId, corpo);
    }
  }

  let conflito = false;
  if (metodo === "REQUEST") {
    const fimJanela = new Date(Math.min(evento.dtStart.getTime() + 366 * 86_400_000, Date.UTC(2100, 0, 1)));
    const ocorrenciasRecebidas = expandirRecorrencias(corpo, { inicio: evento.dtStart, fim: fimJanela, limite: 500, limiteCandidatos: 10_000 });
    const inicios = ocorrenciasRecebidas.map((ocorrencia) => ocorrencia.inicio.getTime());
    const fins = ocorrenciasRecebidas.map((ocorrencia) => ocorrencia.fim.getTime());
    const inicioConflito = new Date(Math.min(...inicios));
    const fimConflito = new Date(Math.max(...fins));
    const candidatos = await prisma.mailDavItem.findMany({
      where: { mailboxId, collection: "calendar", deletedAt: null, uid: { not: evento.uid }, OR: [{ recurring: true }, { dtStart: { lt: fimConflito }, dtEnd: { gt: inicioConflito } }] },
      select: { data: true },
    });
    conflito = candidatos.some((item) => {
      try {
        const ocupacoes = expandirRecorrencias(item.data, { inicio: inicioConflito, fim: fimConflito, limite: 500, limiteCandidatos: 10_000 });
        return ocorrenciasRecebidas.some((recebida) => ocupacoes.some((ocupacao) => sobrepoe(recebida.inicio, recebida.fim, ocupacao.inicio, ocupacao.fim)));
      }
      catch { return false; }
    });
  }
  const resposta = evento.attendees.find((convidado) => convidado.email.toLowerCase() === enderecoCaixa.toLowerCase())?.resposta ?? "pendente";
  return {
    metodo, uid: evento.uid, titulo: evento.summary ?? "Convite sem título", inicio: evento.dtStart.toISOString(), fim: evento.dtEnd.toISOString(), diaInteiro: evento.allDay,
    ...(evento.location ? { local: evento.location } : {}), ...(evento.organizer ? { organizador: evento.organizer } : {}),
    minhaResposta: resposta, sequencia: evento.sequence, conflito,
    cancelado: metodo === "CANCEL" && (cancelamento === "aplicado" || cancelamento === "novo"),
    ...(recorrenciaId ? { recorrenciaId: recorrenciaId.toISOString() } : {}), ...(cancelamento ? { cancelamento } : {}), alteracoes,
  };
}
