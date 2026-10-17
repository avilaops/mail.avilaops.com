import { desdobrarLinhas, lerDataIcal, lerEvento } from "../dav/ical.js";
import { DavError, gravarItem } from "../dav/store.js";
import { prisma } from "../lib/db.js";
import type { InboundAuthResult } from "../mta/authcheck.js";
import { canSendAs } from "./contacts.js";
import { expandirRecorrencias } from "../dav/recorrencia.js";

export type ResultadoRespostaRecebida = "aplicada" | "ignorada";

function metodoReply(corpo: string): boolean {
  return desdobrarLinhas(corpo).some((linha) => /^METHOD:REPLY$/i.test(linha.trim()));
}

function endereco(valor: string): string {
  return valor.replace(/^mailto:/i, "").trim().toLowerCase();
}

function autenticada(auth: InboundAuthResult | null): boolean {
  return auth?.dmarc === "pass" && (auth.spf === "pass" || auth.dkim === "pass");
}

function recorrenciaIdDoComponente(componente: string[]): string | null {
  return componente.find((linha) => /^RECURRENCE-ID(?:;|:)/i.test(linha)) ?? null;
}

function componentes(corpo: string): string[][] {
  const linhas = desdobrarLinhas(corpo);
  const saida: string[][] = [];
  let inicio = -1;
  for (let indice = 0; indice < linhas.length; indice += 1) {
    if (linhas[indice]?.toUpperCase() === "BEGIN:VEVENT") inicio = indice;
    if (inicio >= 0 && linhas[indice]?.toUpperCase() === "END:VEVENT") {
      saida.push(linhas.slice(inicio, indice + 1));
      inicio = -1;
    }
  }
  return saida;
}

function dataRecorrencia(linha: string): { data: Date; diaInteiro: boolean } | null {
  const separador = linha.indexOf(":");
  if (separador < 0) return null;
  const tzid = linha.slice(0, separador).match(/(?:^|;)TZID=(?:"([^"]+)"|([^;:]+))/i);
  return lerDataIcal(linha.slice(separador + 1).trim(), { tzid: tzid?.[1] ?? tzid?.[2] });
}

function trocarPartstat(componente: string[], email: string, resposta: "pendente" | "aceito" | "recusado" | "talvez"): string[] | null {
  const partstat = { pendente: "NEEDS-ACTION", aceito: "ACCEPTED", recusado: "DECLINED", talvez: "TENTATIVE" }[resposta];
  let encontrou = false;
  const atualizado = componente.map((linha) => {
    if (!/^ATTENDEE(?:;|:)/i.test(linha) || endereco(linha.slice(linha.indexOf(":") + 1)) !== email) return linha;
    encontrou = true;
    const separador = linha.indexOf(":");
    let cabecalho = linha.slice(0, separador);
    cabecalho = /;PARTSTAT=[^;:]*/i.test(cabecalho) ? cabecalho.replace(/;PARTSTAT=[^;:]*/i, `;PARTSTAT=${partstat}`) : `${cabecalho};PARTSTAT=${partstat}`;
    return `${cabecalho}:${linha.slice(separador + 1)}`;
  });
  return encontrou ? atualizado : null;
}

function formatarDataUtc(data: Date, diaInteiro: boolean): string {
  const iso = data.toISOString();
  const compacta = iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return diaInteiro ? compacta.slice(0, 8) : compacta;
}

function atualizarCorpo(corpoAtual: string, corpoReply: string, email: string, resposta: "pendente" | "aceito" | "recusado" | "talvez"): string | null {
  const atuais = desdobrarLinhas(corpoAtual);
  const reply = componentes(corpoReply)[0];
  if (!reply) return null;
  const recorrenciaReply = recorrenciaIdDoComponente(reply);
  const dataReply = recorrenciaReply ? dataRecorrencia(recorrenciaReply) : null;
  if (recorrenciaReply && !dataReply) return null;
  let inicio = -1;
  let mestre: string[] | null = null;
  for (let indice = 0; indice < atuais.length; indice += 1) {
    if (atuais[indice]?.toUpperCase() === "BEGIN:VEVENT") inicio = indice;
    if (inicio < 0 || atuais[indice]?.toUpperCase() !== "END:VEVENT") continue;
    const componente = atuais.slice(inicio, indice + 1);
    const recorrenciaAtual = recorrenciaIdDoComponente(componente);
    const dataAtual = recorrenciaAtual ? dataRecorrencia(recorrenciaAtual) : null;
    if (!recorrenciaAtual) mestre = componente;
    const corresponde = dataReply ? dataAtual?.data.getTime() === dataReply.data.getTime() && dataAtual.diaInteiro === dataReply.diaInteiro : recorrenciaReply === null && !recorrenciaAtual;
    if (corresponde) {
      const atualizado = trocarPartstat(componente, email, resposta);
      if (!atualizado) return null;
      atuais.splice(inicio, componente.length, ...atualizado);
      return `${atuais.join("\r\n")}\r\n`;
    }
    inicio = -1;
  }
  if (!recorrenciaReply || !mestre) return null;
  const eventoAtual = lerEvento(corpoAtual);
  const idRecorrencia = dataRecorrencia(recorrenciaReply);
  const recorrencia = eventoAtual?.dtStart && eventoAtual.dtEnd && idRecorrencia ? expandirRecorrencias(corpoAtual, {
    inicio: new Date(idRecorrencia.data.getTime() - 1),
    fim: new Date(idRecorrencia.data.getTime() + 366 * 86_400_000),
    limite: 10_000,
    limiteCandidatos: 100_000,
  }).find((item) => item.recorrenciaId.getTime() === idRecorrencia.data.getTime() && item.evento.allDay === idRecorrencia.diaInteiro) : undefined;
  if (!recorrencia) return null;
  let excecao = mestre.filter((item) => !/^(RRULE|RDATE|EXDATE)(?:;|:)/i.test(item));
  const inicioEvento = excecao.findIndex((item) => /^DTSTART(?:;|:)/i.test(item));
  const fimEvento = excecao.findIndex((item) => /^DTEND(?:;|:)/i.test(item));
  if (inicioEvento < 0 || fimEvento < 0) return null;
  excecao[inicioEvento] = `DTSTART${recorrencia.evento.allDay ? ";VALUE=DATE" : ""}:${formatarDataUtc(recorrencia.inicio, recorrencia.evento.allDay)}`;
  excecao[fimEvento] = `DTEND${recorrencia.evento.allDay ? ";VALUE=DATE" : ""}:${formatarDataUtc(recorrencia.fim, recorrencia.evento.allDay)}`;
  excecao.splice(excecao.findIndex((item) => /^DTSTART(?:;|:)/i.test(item)), 0, recorrenciaReply);
  const atualizada = trocarPartstat(excecao, email, resposta);
  if (!atualizada) return null;
  const fim = atuais.findIndex((item) => item.toUpperCase() === "END:VCALENDAR");
  if (fim < 0) return null;
  atuais.splice(fim, 0, ...atualizada);
  return `${atuais.join("\r\n")}\r\n`;
}

/** Aplica um iTIP REPLY autenticado ao evento do organizador, com CAS. */
export async function aplicarRespostaRecebida(mailboxId: string, corpo: string, remetente: string, auth: InboundAuthResult | null): Promise<ResultadoRespostaRecebida> {
  if (!metodoReply(corpo) || !autenticada(auth)) return "ignorada";
  const reply = lerEvento(corpo);
  if (!reply?.uid || !reply.organizer) return "ignorada";
  const email = remetente.trim().toLowerCase();
  const convidado = reply.attendees.find((item) => item.email.toLowerCase() === email);
  if (!convidado || !(await canSendAs(mailboxId, reply.organizer))) return "ignorada";

  for (let tentativa = 0; tentativa < 3; tentativa += 1) {
    const item = await prisma.mailDavItem.findFirst({ where: { mailboxId, collection: "calendar", uid: reply.uid, deletedAt: null }, select: { href: true, etag: true, data: true } });
    if (!item) return "ignorada";
    const atual = lerEvento(item.data);
    if (!atual || endereco(atual.organizer ?? "") !== endereco(reply.organizer) || atual.sequence !== reply.sequence || !atual.attendees.some((participante) => participante.email.toLowerCase() === email)) return "ignorada";
    const atualizado = atualizarCorpo(item.data, corpo, email, convidado.resposta);
    if (!atualizado || atualizado === item.data) return "ignorada";
    try {
      await gravarItem({ mailboxId, colecao: "calendar", href: item.href, corpo: atualizado, ifMatch: item.etag });
      return "aplicada";
    } catch (error) {
      if (error instanceof DavError && error.statusCode === 412 && tentativa < 2) continue;
      throw error;
    }
  }
  return "ignorada";
}
