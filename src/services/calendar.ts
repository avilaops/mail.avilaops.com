import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { DavError, excluirItem, gravarItem } from "../dav/store.js";
import {
  desdobrarLinhas,
  gerarEventoIcal,
  lerEvento,
  normalizarFusoIcal,
  type EventoIcal,
  type EventoLido,
} from "../dav/ical.js";
import { expandirRecorrencias } from "../dav/recorrencia.js";
import { adicionarExdate, adicionarOuSubstituirExcecao, anexarParticaoFutura, componenteDeExcecao, deslocarRecorrencias, particionarSerie, regraRestante, serieSemExclusoes } from "./calendar-scope.js";
import { convidadosAfetados, prepararConviteAgenda, validarOrganizadorConvite } from "./calendar-outbound.js";
import type { CalendarInviteOutboxInput } from "../dav/store.js";
import { garantirAgendaPadrao } from "./calendars.js";

const log = createLogger("calendar");

export class CalendarError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "CalendarError";
  }
}

function fusoIanaValido(fuso: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: fuso });
    return true;
  } catch {
    return false;
  }
}

const convidadoSchema = z.object({
  email: z.string().email().max(320),
  nome: z.string().max(500).optional(),
  resposta: z.enum(["pendente", "aceito", "recusado", "talvez"]),
});

const lembreteSchema = z.object({ minutosAntes: z.number().int().min(0).max(525_600) });

const eventoCalendarioBaseSchema = z.object({
    agendaId: z.string().min(1).optional(),
    titulo: z.string().trim().min(1).max(500),
    inicio: z.string().datetime({ offset: true }),
    fim: z.string().datetime({ offset: true }),
    diaInteiro: z.boolean().default(false),
    fuso: z.string().trim().min(1).max(100).refine(fusoIanaValido, "Fuso IANA invalido."),
    local: z.string().max(2_000).transform((valor) => valor === "" ? undefined : valor).optional(),
    descricao: z.string().max(100_000).transform((valor) => valor === "" ? undefined : valor).optional(),
    recorrencia: z.string().max(2_000).transform((valor) => valor === "" ? undefined : valor).optional(),
    lembretes: z.array(lembreteSchema).max(20).default([]),
    convidados: z.array(convidadoSchema).max(500).default([]),
    organizador: z.string().email().max(320).optional(),
    disponibilidade: z.enum(["ocupado", "livre"]).default("ocupado"),
    origem: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/).optional(),
    linkOrigem: z.string().url().max(2_000).optional(),
  });

export const eventoCalendarioSchema = eventoCalendarioBaseSchema
  .superRefine((evento, contexto) => {
    if (new Date(evento.fim).getTime() < new Date(evento.inicio).getTime()) {
      contexto.addIssue({ code: z.ZodIssueCode.custom, path: ["fim"], message: "Fim nao pode anteceder o inicio." });
    }
  });

export type DadosEventoCalendario = z.infer<typeof eventoCalendarioSchema>;

export const mudancasEventoCalendarioSchema = eventoCalendarioBaseSchema.partial().refine(
  (mudancas) => Object.keys(mudancas).length > 0,
  "Informe ao menos uma alteracao.",
);

export type MudancasEventoCalendario = z.input<typeof mudancasEventoCalendarioSchema>;
export type EscopoRecorrencia = "this" | "following" | "all";

export interface OpcoesEscopoRecorrencia {
  scope?: EscopoRecorrencia;
  recurrenceId?: string;
  notificarConvidados?: boolean;
}

export interface EventoCalendario extends DadosEventoCalendario {
  id: string;
  uid: string;
  href: string;
  etag: string;
  sequencia: number;
  criadoEm: string;
  modificadoEm: string;
  dtstamp: string;
  agendaId: string;
  cor: string;
}

export interface OcorrenciaCalendario extends EventoCalendario {
  recorrenciaId: string;
}

interface ItemCalendario {
  id: string;
  href: string;
  uid: string;
  etag: string;
  data: string;
  dtStart: Date | null;
  dtEnd: Date | null;
  recurring: boolean;
  createdAt: Date;
  updatedAt: Date;
  calendarId: string | null;
  calendar: { color: string } | null;
}

const selecaoItem = {
  id: true,
  href: true,
  uid: true,
  etag: true,
  data: true,
  dtStart: true,
  dtEnd: true,
  recurring: true,
  createdAt: true,
  updatedAt: true,
  calendarId: true,
  calendar: { select: { color: true } },
} as const;

function erroValidacao(error: z.ZodError): CalendarError {
  return new CalendarError(error.issues[0]?.message ?? "Evento invalido.", 422);
}

function validarEvento(input: unknown): DadosEventoCalendario {
  const resultado = eventoCalendarioSchema.safeParse(input);
  if (!resultado.success) throw erroValidacao(resultado.error);
  return resultado.data;
}

async function executarStore<T>(operacao: () => Promise<T>): Promise<T> {
  try {
    return await operacao();
  } catch (error) {
    if (error instanceof DavError) throw new CalendarError(error.message, error.statusCode);
    throw error;
  }
}

function fusoDoEvento(corpo: string, evento: EventoLido): string {
  if (evento.timezone) return normalizarFusoIcal(evento.timezone) ?? evento.timezone;
  const inicio = corpo.match(/(?:^|\r?\n)DTSTART(?:;[^:]*)?:(\d{8}(?:T\d{6}Z?)?)(?:\r?\n|$)/i)?.[1];
  return inicio?.endsWith("Z") ? "UTC" : "America/Sao_Paulo";
}

function anexarExcecoesRecorrentes(original: string, gerado: string): string {
  const linhas = desdobrarLinhas(original);
  const excecoes: string[][] = [];
  let inicio = -1;
  for (let indice = 0; indice < linhas.length; indice += 1) {
    const linha = linhas[indice]?.toUpperCase();
    if (linha === "BEGIN:VEVENT") inicio = indice;
    if (linha !== "END:VEVENT" || inicio === -1) continue;
    const componente = linhas.slice(inicio, indice + 1);
    if (componente.some((item) => /^RECURRENCE-ID(?:;|:)/i.test(item))) excecoes.push(componente);
    inicio = -1;
  }
  if (excecoes.length === 0) return gerado;
  const novas = desdobrarLinhas(gerado);
  const fimCalendario = novas.findIndex((linha) => linha.toUpperCase() === "END:VCALENDAR");
  if (fimCalendario === -1) throw new CalendarError("iCalendar gerado sem fechamento.", 500);
  novas.splice(fimCalendario, 0, ...excecoes.flat());
  return `${novas.join("\r\n")}\r\n`;
}

function aplicarDadosDaOcorrencia(base: EventoCalendario, evento: EventoLido): EventoCalendario {
  return {
    ...base,
    titulo: evento.summary ?? base.titulo,
    diaInteiro: evento.allDay,
    fuso: evento.timezone ? (normalizarFusoIcal(evento.timezone) ?? base.fuso) : base.fuso,
    local: evento.location ?? undefined,
    descricao: evento.description ?? undefined,
    lembretes: evento.reminders,
    convidados: evento.attendees,
    organizador: evento.organizer ?? undefined,
    disponibilidade: evento.transparency === "TRANSPARENT" ? "livre" : "ocupado",
    origem: evento.origin ?? undefined,
    linkOrigem: evento.originLink ?? undefined,
    sequencia: evento.sequence,
  };
}

function iso(data: Date | null, fallback: Date): string {
  return (data ?? fallback).toISOString();
}

function mapearItem(item: ItemCalendario): EventoCalendario {
  const lido = lerEvento(item.data);
  if (!lido?.dtStart || !lido.dtEnd) throw new CalendarError("Evento CalDAV invalido.", 422);
  return {
    id: item.id,
    uid: lido.uid ?? item.uid,
    href: item.href,
    etag: item.etag,
    titulo: lido.summary ?? "",
    inicio: lido.dtStart.toISOString(),
    fim: lido.dtEnd.toISOString(),
    diaInteiro: lido.allDay,
    fuso: fusoDoEvento(item.data, lido),
    local: lido.location ?? undefined,
    descricao: lido.description ?? undefined,
    recorrencia: lido.rrule ?? undefined,
    lembretes: lido.reminders,
    convidados: lido.attendees,
    organizador: lido.organizer ?? undefined,
    disponibilidade: lido.transparency === "TRANSPARENT" ? "livre" : "ocupado",
    origem: lido.origin ?? undefined,
    linkOrigem: lido.originLink ?? undefined,
    sequencia: lido.sequence,
    criadoEm: iso(lido.createdAt, item.createdAt),
    modificadoEm: iso(lido.modifiedAt, item.updatedAt),
    dtstamp: iso(lido.dtstamp, item.updatedAt),
    agendaId: item.calendarId ?? "",
    cor: item.calendar?.color ?? "#2563EB",
  };
}

function mapearCorpoTemporario(corpo: string, uid: string, href: string, agora: string, agendaId: string, cor: string): EventoCalendario {
  const data = new Date(agora);
  return mapearItem({ id: uid, uid, href, etag: "", data: corpo, dtStart: null, dtEnd: null, recurring: false, createdAt: data, updatedAt: data, calendarId: agendaId, calendar: { color: cor } });
}

function entregaConvite(mailboxId: string, evento: EventoCalendario & { recorrenciaId?: string }, metodo: "REQUEST" | "CANCEL", destinatarios: string[], rangeThisAndFuture = false): CalendarInviteOutboxInput[] {
  const chave = [mailboxId, evento.uid, metodo, evento.sequencia, evento.recorrenciaId ?? "master", rangeThisAndFuture ? "following" : "single", [...destinatarios].map((item) => item.toLowerCase()).sort().join(",")].join(":");
  const entrega = prepararConviteAgenda(evento, metodo, destinatarios, chave, { rangeThisAndFuture });
  return entrega ? [entrega] : [];
}

async function itemPorId(mailboxId: string, id: string): Promise<ItemCalendario> {
  const item = await prisma.mailDavItem.findFirst({
    where: { id, mailboxId, collection: "calendar", deletedAt: null },
    select: selecaoItem,
  });
  if (!item) throw new CalendarError("Evento nao encontrado.", 404);
  return item;
}

function paraIcal(evento: EventoCalendario): EventoIcal {
  return {
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
    local: evento.local,
    descricao: evento.descricao,
    recorrencia: evento.recorrencia,
    lembretes: evento.lembretes,
    convidados: evento.convidados,
    organizador: evento.organizador,
    disponibilidade: evento.disponibilidade,
    origem: evento.origem,
    linkOrigem: evento.linkOrigem,
  };
}

/** Devolve um evento persistido na colecao CalDAV da caixa. */
export async function obterEvento(mailboxId: string, id: string): Promise<EventoCalendario> {
  return mapearItem(await itemPorId(mailboxId, id));
}

/** Resolve uma ocorrência pelo identificador original, inclusive quando movida por override. */
export async function obterOcorrencia(mailboxId: string, id: string, recorrenciaIdIso: string): Promise<OcorrenciaCalendario> {
  const recorrenciaId = new Date(recorrenciaIdIso);
  if (!Number.isFinite(recorrenciaId.getTime())) throw new CalendarError("recurrenceId invalido.", 422);
  const item = await itemPorId(mailboxId, id);
  const base = mapearItem(item);
  const ocorrencia = expandirRecorrencias(item.data, {
    inicio: new Date(recorrenciaId.getTime() - 1),
    fim: new Date(recorrenciaId.getTime() + Math.max(1, new Date(base.fim).getTime() - new Date(base.inicio).getTime()) + 1),
    limite: 10,
    limiteCandidatos: 100,
  }).find((itemExpandido) => itemExpandido.recorrenciaId.getTime() === recorrenciaId.getTime());
  if (!ocorrencia) throw new CalendarError("Ocorrencia nao encontrada.", 404);
  return {
    ...aplicarDadosDaOcorrencia(base, ocorrencia.evento),
    inicio: ocorrencia.inicio.toISOString(),
    fim: ocorrencia.fim.toISOString(),
    recorrenciaId: ocorrencia.recorrenciaId.toISOString(),
  };
}

/** Lista ocorrencias que intersectam a janela semiaberta [de, ate). */
export async function listarJanela(mailboxId: string, de: Date, ate: Date): Promise<OcorrenciaCalendario[]> {
  if (!Number.isFinite(de.getTime()) || !Number.isFinite(ate.getTime()) || ate <= de) {
    throw new CalendarError("Janela de calendario invalida.", 422);
  }
  const ocorrencias: OcorrenciaCalendario[] = [];
  const limiteTotal = 5_000;
  const limiteBytes = 64 * 1024 * 1024;
  let bytesLidos = 0;
  const caixa = await prisma.mailbox.findUnique({ where: { id: mailboxId }, select: { localPart: true, domain: { select: { name: true } } } });
  const enderecoCaixa = caixa ? `${caixa.localPart}@${caixa.domain.name}`.toLowerCase() : null;
  let cursor: string | undefined;
  while (true) {
    const itens = await prisma.mailDavItem.findMany({
      where: {
        mailboxId,
        collection: "calendar",
        deletedAt: null,
        OR: [
          { recurring: true },
          { dtStart: { lt: ate }, OR: [{ dtEnd: { gt: de } }, { dtEnd: null }] },
        ],
      },
      orderBy: { id: "asc" },
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: selecaoItem,
    });
    if (itens.length === 0) break;
    cursor = itens.at(-1)!.id;
    for (const item of itens) {
      bytesLidos += Buffer.byteLength(item.data, "utf8");
      if (bytesLidos > limiteBytes) throw new CalendarError("Janela de calendario excede o limite de leitura.", 422);
    let evento: EventoCalendario;
    try {
      evento = mapearItem(item);
    } catch (error) {
      log.warn("evento CalDAV invalido ignorado na janela JSON", {
        mailboxId,
        href: item.href,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (enderecoCaixa && evento.convidados.some((convidado) => convidado.email.toLowerCase() === enderecoCaixa && convidado.resposta === "recusado")) continue;
    if (!item.recurring) {
      ocorrencias.push({ ...evento, recorrenciaId: evento.inicio });
    } else {
      const restantes = limiteTotal - ocorrencias.length;
      if (restantes <= 0) throw new CalendarError(`Janela excede o limite de ${limiteTotal} ocorrencias.`, 422);
      const expandidas = expandirRecorrencias(item.data, {
        inicio: de,
        fim: ate,
        limite: Math.min(10_000, restantes + 1),
        limiteCandidatos: 20_000,
      });
      for (const ocorrencia of expandidas) {
        const eventoDaOcorrencia = aplicarDadosDaOcorrencia(evento, ocorrencia.evento);
        if (enderecoCaixa && eventoDaOcorrencia.convidados.some((convidado) => convidado.email.toLowerCase() === enderecoCaixa && convidado.resposta === "recusado")) continue;
        ocorrencias.push({
          ...eventoDaOcorrencia,
          inicio: ocorrencia.inicio.toISOString(),
          fim: ocorrencia.fim.toISOString(),
          recorrenciaId: ocorrencia.recorrenciaId.toISOString(),
        });
      }
    }
    if (ocorrencias.length > limiteTotal) throw new CalendarError(`Janela excede o limite de ${limiteTotal} ocorrencias.`, 422);
    }
    if (itens.length < 100) break;
  }
  return ocorrencias.sort((a, b) => a.inicio.localeCompare(b.inicio) || a.id.localeCompare(b.id));
}

/** Cria um VEVENT e o grava pelo store CalDAV, que atualiza seq/etag. */
export async function criarEvento(mailboxId: string, input: unknown, opcoes: { notificarConvidados?: boolean } = {}): Promise<EventoCalendario> {
  const dados = validarEvento(input);
  const agenda = dados.agendaId
    ? await prisma.mailCalendar.findFirst({ where: { id: dados.agendaId, mailboxId } })
    : await garantirAgendaPadrao(mailboxId);
  if (!agenda) throw new CalendarError("Agenda não encontrada.", 404);
  const uid = randomUUID();
  const href = `${uid}.ics`;
  const agora = new Date().toISOString();
  const corpo = gerarEventoIcal({
    uid,
    ...dados,
    criadoEm: agora,
    modificadoEm: agora,
    dtstamp: agora,
    sequencia: 0,
  });
  const temporario = mapearCorpoTemporario(corpo, uid, href, agora, agenda.id, agenda.color);
  const entregas = opcoes.notificarConvidados ? entregaConvite(mailboxId, temporario, "REQUEST", temporario.convidados.map((item) => item.email)) : [];
  if (opcoes.notificarConvidados) await validarOrganizadorConvite(mailboxId, temporario, temporario.convidados.map((item) => item.email));
  await executarStore(() => gravarItem({ mailboxId, colecao: "calendar", calendarId: agenda.id, href, corpo, ifNoneMatchAll: true, calendarInviteDeliveries: entregas }));
  const item = await prisma.mailDavItem.findFirstOrThrow({
    where: { mailboxId, collection: "calendar", calendarId: agenda.id, href },
    select: selecaoItem,
  });
  return mapearItem(item);
}

/** Atualiza o mesmo recurso, preservando UID, CREATED e extensoes desconhecidas. */
export async function atualizarEvento(
  mailboxId: string,
  id: string,
  input: unknown,
  etag: string,
  opcoes: OpcoesEscopoRecorrencia = {},
): Promise<EventoCalendario> {
  if (typeof etag !== "string" || etag.length === 0) throw new CalendarError("If-Match e obrigatorio.", 428);
  const item = await itemPorId(mailboxId, id);
  const mudancas = mudancasEventoCalendarioSchema.safeParse(input);
  if (!mudancas.success) throw erroValidacao(mudancas.error);
  const atual = mapearItem(item);
  const escopo = opcoes.scope ?? "all";
  if (escopo !== "all") {
    if (!atual.recorrencia) throw new CalendarError("Escopo de ocorrencia exige uma serie recorrente.", 422);
    const recorrenciaId = new Date(opcoes.recurrenceId ?? "");
    if (!Number.isFinite(recorrenciaId.getTime())) throw new CalendarError("recurrenceId e obrigatorio para este escopo.", 422);
    if (mudancas.data.recorrencia !== undefined) throw new CalendarError("A recorrencia so pode ser alterada em toda a serie.", 422);
    const duracao = new Date(atual.fim).getTime() - new Date(atual.inicio).getTime();
    const dadosOcorrencia = validarEvento({
      ...atual,
      inicio: recorrenciaId.toISOString(),
      fim: new Date(recorrenciaId.getTime() + duracao).toISOString(),
      recorrencia: undefined,
      ...mudancas.data,
    });
    const agoraEscopo = new Date().toISOString();
    if (escopo === "following") {
      const anteriores = expandirRecorrencias(serieSemExclusoes(item.data), { inicio: new Date(new Date(atual.inicio).getTime() - 1), fim: new Date(recorrenciaId.getTime()), limite: 10_000, limiteCandidatos: 100_000 }).filter((ocorrencia) => ocorrencia.recorrenciaId < recorrenciaId).length;
      const particao = particionarSerie(item.data, recorrenciaId, atual.diaInteiro);
      if (opcoes.notificarConvidados) {
        await validarOrganizadorConvite(mailboxId, atual, atual.convidados.map((convidado) => convidado.email));
        await validarOrganizadorConvite(mailboxId, { ...atual, ...dadosOcorrencia }, dadosOcorrencia.convidados.map((convidado) => convidado.email));
      }
      const novaSerie = await criarEvento(mailboxId, { ...dadosOcorrencia, recorrencia: regraRestante(atual.recorrencia, anteriores) });
      try {
        const deslocamento = new Date(dadosOcorrencia.inicio).getTime() - recorrenciaId.getTime();
        const novaComFuturas = anexarParticaoFutura((await itemPorId(mailboxId, novaSerie.id)).data, particao, novaSerie.uid, deslocamento, dadosOcorrencia.diaInteiro);
        await executarStore(() => gravarItem({ mailboxId, colecao: "calendar", href: novaSerie.href, corpo: novaComFuturas, ifMatch: novaSerie.etag }));
        const cancelado = { ...aplicarDadosDaOcorrencia(atual, { ...lerEvento(item.data)!, dtStart: recorrenciaId, dtEnd: new Date(recorrenciaId.getTime() + duracao) }), inicio: recorrenciaId.toISOString(), fim: new Date(recorrenciaId.getTime() + duracao).toISOString(), recorrenciaId: recorrenciaId.toISOString() };
        const entregas = opcoes.notificarConvidados ? [
          ...entregaConvite(mailboxId, cancelado, "CANCEL", cancelado.convidados.map((convidado) => convidado.email), true),
          ...entregaConvite(mailboxId, novaSerie, "REQUEST", novaSerie.convidados.map((convidado) => convidado.email)),
        ] : [];
        await executarStore(() => gravarItem({ mailboxId, colecao: "calendar", href: item.href, corpo: particao.anterior, ifMatch: etag, calendarInviteDeliveries: entregas }));
      } catch (error) {
        const criado = await itemPorId(mailboxId, novaSerie.id).catch(() => null);
        if (criado) await executarStore(() => excluirItem(mailboxId, "calendar", criado.href, criado.etag)).catch(() => undefined);
        throw error;
      }
      return obterEvento(mailboxId, novaSerie.id);
    }
    const mestreAtualizado = gerarEventoIcal({ ...paraIcal(atual), modificadoEm: agoraEscopo, dtstamp: agoraEscopo, sequencia: atual.sequencia + 1 }, { original: item.data });
    const comExcecoes = anexarExcecoesRecorrentes(item.data, mestreAtualizado);
    const excecaoGerada = gerarEventoIcal({
      ...paraIcal(atual),
      ...dadosOcorrencia,
      recorrencia: undefined,
      modificadoEm: agoraEscopo,
      dtstamp: agoraEscopo,
      sequencia: atual.sequencia + 1,
    });
    const corpo = adicionarOuSubstituirExcecao(comExcecoes, componenteDeExcecao(excecaoGerada, recorrenciaId, atual.diaInteiro), recorrenciaId, atual.diaInteiro);
    const ocorrenciaAnterior = await obterOcorrencia(mailboxId, id, recorrenciaId.toISOString());
    const ocorrenciaAtualizada = { ...ocorrenciaAnterior, ...dadosOcorrencia, sequencia: atual.sequencia + 1, modificadoEm: agoraEscopo, dtstamp: agoraEscopo, recorrenciaId: recorrenciaId.toISOString() };
    const afetadosOcorrencia = convidadosAfetados(ocorrenciaAnterior, ocorrenciaAtualizada);
    const entregas = opcoes.notificarConvidados ? [
      ...entregaConvite(mailboxId, ocorrenciaAtualizada, "REQUEST", afetadosOcorrencia.request),
      ...entregaConvite(mailboxId, { ...ocorrenciaAtualizada, convidados: ocorrenciaAnterior.convidados.filter((convidado) => afetadosOcorrencia.cancel.includes(convidado.email.toLowerCase())) }, "CANCEL", afetadosOcorrencia.cancel),
    ] : [];
    if (opcoes.notificarConvidados) await validarOrganizadorConvite(mailboxId, ocorrenciaAtualizada, [...afetadosOcorrencia.request, ...afetadosOcorrencia.cancel]);
    await executarStore(() => gravarItem({ mailboxId, colecao: "calendar", href: item.href, corpo, ifMatch: etag, calendarInviteDeliveries: entregas }));
    return obterEvento(mailboxId, id);
  }
  const dados = validarEvento({
    titulo: atual.titulo,
    inicio: atual.inicio,
    fim: atual.fim,
    diaInteiro: atual.diaInteiro,
    fuso: atual.fuso,
    local: atual.local,
    descricao: atual.descricao,
    recorrencia: atual.recorrencia,
    lembretes: atual.lembretes,
    convidados: atual.convidados,
    organizador: atual.organizador,
    disponibilidade: atual.disponibilidade,
    ...mudancas.data,
  });
  const agora = new Date().toISOString();
  const agendaDestino = dados.agendaId && dados.agendaId !== atual.agendaId
    ? await prisma.mailCalendar.findFirst({ where: { id: dados.agendaId, mailboxId } })
    : null;
  if (dados.agendaId && dados.agendaId !== atual.agendaId && !agendaDestino) throw new CalendarError("Agenda não encontrada.", 404);
  const deslocamento = new Date(dados.inicio).getTime() - new Date(atual.inicio).getTime();
  const mudouTipo = dados.diaInteiro !== atual.diaInteiro;
  const original = deslocamento === 0 && !mudouTipo ? item.data : deslocarRecorrencias(item.data, deslocamento, atual.uid, dados.diaInteiro);
  const corpoGerado = gerarEventoIcal(
    {
      ...paraIcal(atual),
      ...dados,
      modificadoEm: agora,
      dtstamp: agora,
      sequencia: atual.sequencia + 1,
    },
    { original },
  );
  const corpo = anexarExcecoesRecorrentes(original, corpoGerado);
  const temporario = mapearCorpoTemporario(corpo, atual.uid, item.href, agora, agendaDestino?.id ?? atual.agendaId, agendaDestino?.color ?? atual.cor);
  const afetados = convidadosAfetados(atual, temporario);
  const entregas = opcoes.notificarConvidados ? [
    ...entregaConvite(mailboxId, temporario, "REQUEST", afetados.request),
    ...entregaConvite(mailboxId, { ...temporario, convidados: atual.convidados.filter((convidado) => afetados.cancel.includes(convidado.email.toLowerCase())) }, "CANCEL", afetados.cancel),
  ] : [];
  if (opcoes.notificarConvidados) await validarOrganizadorConvite(mailboxId, temporario, [...afetados.request, ...afetados.cancel]);
  await executarStore(() => gravarItem({ mailboxId, colecao: "calendar", calendarId: agendaDestino?.id ?? atual.agendaId, existingId: item.id, href: item.href, corpo, ifMatch: etag, calendarInviteDeliveries: entregas }));
  return obterEvento(mailboxId, id);
}

/** Exclui com precondicao etag; o store mantem a lapide para sync-collection. */
export async function excluirEvento(mailboxId: string, id: string, etag: string, opcoes: OpcoesEscopoRecorrencia = {}): Promise<void> {
  if (typeof etag !== "string" || etag.length === 0) throw new CalendarError("If-Match e obrigatorio.", 428);
  const item = await itemPorId(mailboxId, id);
  const escopo = opcoes.scope ?? "all";
  if (escopo !== "all") {
    const atual = mapearItem(item);
    if (!atual.recorrencia) throw new CalendarError("Escopo de ocorrencia exige uma serie recorrente.", 422);
    const recorrenciaId = new Date(opcoes.recurrenceId ?? "");
    if (!Number.isFinite(recorrenciaId.getTime())) throw new CalendarError("recurrenceId e obrigatorio para este escopo.", 422);
    const corpo = escopo === "this" ? adicionarExdate(item.data, recorrenciaId, atual.diaInteiro) : particionarSerie(item.data, recorrenciaId, atual.diaInteiro).anterior;
    const alvo = await obterOcorrencia(mailboxId, id, recorrenciaId.toISOString());
    const entregas = opcoes.notificarConvidados ? entregaConvite(mailboxId, alvo, "CANCEL", alvo.convidados.map((convidado) => convidado.email), escopo === "following") : [];
    if (opcoes.notificarConvidados) await validarOrganizadorConvite(mailboxId, alvo, alvo.convidados.map((convidado) => convidado.email));
    await executarStore(() => gravarItem({ mailboxId, colecao: "calendar", href: item.href, corpo, ifMatch: etag, calendarInviteDeliveries: entregas }));
    return;
  }
  const atual = mapearItem(item);
  const entregas = opcoes.notificarConvidados ? entregaConvite(mailboxId, atual, "CANCEL", atual.convidados.map((convidado) => convidado.email)) : [];
  if (opcoes.notificarConvidados) await validarOrganizadorConvite(mailboxId, atual, atual.convidados.map((convidado) => convidado.email));
  await executarStore(() => excluirItem(mailboxId, "calendar", item.href, etag, entregas));
}

/** Busca simples nos campos humanos do VEVENT, limitada para proteger a caixa. */
export function normalizarBuscaAgenda(texto: string): string {
  return texto.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");
}

export async function buscarEventos(mailboxId: string, consulta: string): Promise<EventoCalendario[]> {
  const q = consulta.trim();
  if (!q) return [];
  if (q.length > 500) throw new CalendarError("Busca longa demais.", 422);
  const agulha = normalizarBuscaAgenda(q);
  const resultados: EventoCalendario[] = [];
  const limiteBytes = 64 * 1024 * 1024;
  let bytesLidos = 0;
  let cursor: string | undefined;
  while (resultados.length < 100) {
    const itens = await prisma.mailDavItem.findMany({
      where: { mailboxId, collection: "calendar", deletedAt: null },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: selecaoItem,
    });
    if (itens.length === 0) break;
    cursor = itens.at(-1)!.id;
    for (const item of itens) {
      bytesLidos += Buffer.byteLength(item.data, "utf8");
      if (bytesLidos > limiteBytes) throw new CalendarError("Busca excede o limite de leitura.", 422);
      let evento: EventoCalendario | null;
      try {
        evento = mapearItem(item);
      } catch {
        evento = null;
      }
      if (evento && [evento.titulo, evento.local ?? "", evento.descricao ?? ""].some((texto) =>
        normalizarBuscaAgenda(texto).includes(agulha),
      )) resultados.push(evento);
      if (resultados.length === 100) break;
    }
    if (itens.length < 100) break;
  }
  return resultados;
}
