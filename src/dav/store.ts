import { createHash } from "node:crypto";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { lerEvento, lerVCard } from "./ical.js";

const log = createLogger("dav");

/**
 * Armazenamento das colecoes DAV — contatos (vCard) e agenda (iCalendar).
 *
 * Cada mudanca bumpa a sequencia da colecao na caixa e carimba o item com o
 * valor novo; o sync-collection e "tudo com seq maior que o token do cliente".
 * Exclusao vira lapide com seq novo: apagar de verdade faria o item excluido
 * num aparelho reaparecer no outro.
 */

export type Colecao = "contacts" | "calendar";

export class DavError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly xmlBody?: string,
  ) {
    super(message);
    this.name = "DavError";
  }
}

const MAX_ITEM_BYTES = 512 * 1024;
const MAX_ITENS_POR_COLECAO = 10_000;

const CAMPO_SEQ: Record<Colecao, "davContactsSeq" | "davCalendarSeq"> = {
  contacts: "davContactsSeq",
  calendar: "davCalendarSeq",
};

const CAMPO_MIN_SEQ: Record<Colecao, "davContactsMinSeq" | "davCalendarMinSeq"> = {
  contacts: "davContactsMinSeq",
  calendar: "davCalendarMinSeq",
};

function etagDe(corpo: string): string {
  return createHash("sha256").update(corpo, "utf8").digest("hex").slice(0, 32);
}

/** Nome de recurso vindo da URL: sem barra, sem esquisitice. */
export function hrefValido(href: string): boolean {
  return /^[A-Za-z0-9._@%~-]{1,255}$/.test(href);
}

export async function ctag(mailboxId: string, colecao: Colecao, calendarId?: string): Promise<string> {
  if (colecao === "calendar" && calendarId) {
    return (await prisma.mailCalendar.findFirstOrThrow({ where: { id: calendarId, mailboxId }, select: { seq: true } })).seq.toString();
  }
  const caixa = await prisma.mailbox.findUniqueOrThrow({
    where: { id: mailboxId },
    select: { davContactsSeq: true, davCalendarSeq: true },
  });
  return caixa[CAMPO_SEQ[colecao]].toString();
}

export async function listarItens(mailboxId: string, colecao: Colecao, calendarId?: string) {
  return prisma.mailDavItem.findMany({
    where: { mailboxId, collection: colecao, deletedAt: null, ...(colecao === "calendar" && calendarId ? { calendarId } : {}) },
    orderBy: { href: "asc" },
    select: { href: true, etag: true, displayName: true, dtStart: true, dtEnd: true, recurring: true },
  });
}

export async function obterItem(mailboxId: string, colecao: Colecao, href: string, calendarId?: string) {
  return prisma.mailDavItem.findFirst({
    where: { mailboxId, collection: colecao, href, deletedAt: null, ...(colecao === "calendar" && calendarId ? { calendarId } : {}) },
    select: { href: true, etag: true, data: true, uid: true },
  });
}

/** Listagem com o blob — para os REPORTs de query, que devolvem o conteudo. */
export async function listarComDados(mailboxId: string, colecao: Colecao, calendarId?: string) {
  return prisma.mailDavItem.findMany({
    where: { mailboxId, collection: colecao, deletedAt: null, ...(colecao === "calendar" && calendarId ? { calendarId } : {}) },
    orderBy: { href: "asc" },
    select: { href: true, etag: true, data: true, dtStart: true, dtEnd: true, recurring: true },
  });
}

export async function obterVarios(mailboxId: string, colecao: Colecao, hrefs: string[], calendarId?: string) {
  return prisma.mailDavItem.findMany({
    where: { mailboxId, collection: colecao, href: { in: hrefs }, deletedAt: null, ...(colecao === "calendar" && calendarId ? { calendarId } : {}) },
    select: { href: true, etag: true, data: true },
  });
}

export interface GravarInput {
  mailboxId: string;
  colecao: Colecao;
  calendarId?: string;
  /** Recurso existente conhecido, usado ao mover um evento entre agendas. */
  existingId?: string;
  href: string;
  corpo: string;
  /** Valor do If-Match (etag), quando o cliente exige atualizar a versao X. */
  ifMatch?: string;
  /** If-None-Match: * — o cliente exige que seja criacao. */
  ifNoneMatchAll?: boolean;
  calendarInviteDeliveries?: CalendarInviteOutboxInput[];
}

export interface CalendarInviteOutboxInput {
  dedupeKey: string;
  fromAddress: string;
  recipients: string[];
  subject: string;
  text: string;
  html: string;
  ical: string;
  method: "REQUEST" | "CANCEL";
}

async function gravarConvitesNaOutbox(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  mailboxId: string,
  entregas: CalendarInviteOutboxInput[] | undefined,
): Promise<void> {
  if (!entregas?.length) return;
  await tx.calendarInviteDelivery.createMany({
    data: entregas.map((entrega) => ({ mailboxId, ...entrega })),
    skipDuplicates: true,
  });
}

export async function gravarItem(input: GravarInput): Promise<{ etag: string; created: boolean }> {
  if (!hrefValido(input.href)) throw new DavError("Nome de recurso invalido.", 400);
  if (Buffer.byteLength(input.corpo, "utf8") > MAX_ITEM_BYTES) {
    throw new DavError("Item grande demais (maximo 512 KB).", 413);
  }

  // O indice sai da leitura minima; o blob e guardado como veio.
  let uid: string | null = null;
  let displayName: string | null = null;
  let dtStart: Date | null = null;
  let dtEnd: Date | null = null;
  let recurring = false;

  if (input.colecao === "contacts") {
    const vcard = lerVCard(input.corpo);
    if (!vcard) throw new DavError("Corpo nao e um vCard valido.", 415);
    uid = vcard.uid;
    displayName = vcard.fn;
  } else {
    const evento = lerEvento(input.corpo);
    if (!evento) throw new DavError("Corpo nao e um iCalendar com VEVENT.", 415);
    uid = evento.uid;
    displayName = evento.summary;
    dtStart = evento.dtStart;
    dtEnd = evento.dtEnd;
    recurring = evento.recurring;
  }

  const existente = await prisma.mailDavItem.findFirst({
    where: {
      mailboxId: input.mailboxId,
      collection: input.colecao,
      ...(input.existingId ? { id: input.existingId } : {}),
      ...(!input.existingId && input.colecao === "calendar" && input.calendarId ? { calendarId: input.calendarId } : {}),
      href: input.href,
    },
    select: {
      id: true,
      calendarId: true,
      etag: true,
      deletedAt: true,
      uid: true,
      data: true,
      displayName: true,
      dtStart: true,
      dtEnd: true,
      recurring: true,
    },
  });
  const vivo = existente && existente.deletedAt === null ? existente : null;

  // Preconditions do HTTP: sao elas que impedem dois aparelhos de
  // sobrescreverem a edicao um do outro sem perceber.
  if (input.ifNoneMatchAll && vivo) throw new DavError("O recurso ja existe.", 412);
  if (input.ifMatch !== undefined && (!vivo || vivo.etag !== input.ifMatch)) {
    throw new DavError("O recurso mudou desde a sua leitura.", 412);
  }

  if (!vivo) {
    const total = await prisma.mailDavItem.count({
      where: { mailboxId: input.mailboxId, collection: input.colecao, deletedAt: null, ...(input.colecao === "calendar" ? { calendarId: input.calendarId } : {}) },
    });
    if (total >= MAX_ITENS_POR_COLECAO) {
      throw new DavError(`Limite de ${MAX_ITENS_POR_COLECAO} itens na colecao.`, 507);
    }
  }

  const etag = etagDe(input.corpo);
  const campoSeq = CAMPO_SEQ[input.colecao];

  try {
    await prisma.$transaction(async (tx) => {
      const caixa = await tx.mailbox.update({
        where: { id: input.mailboxId },
        data: { [campoSeq]: { increment: 1 } },
        select: { davContactsSeq: true, davCalendarSeq: true },
      });
      const seq = input.colecao === "calendar" && input.calendarId
        ? (await tx.mailCalendar.update({ where: { id: input.calendarId }, data: { seq: { increment: 1 } }, select: { seq: true } })).seq
        : caixa[campoSeq];
      const moveuDeAgenda = input.colecao === "calendar"
        && vivo?.calendarId
        && input.calendarId
        && vivo.calendarId !== input.calendarId;

      const dados = {
        ...(input.colecao === "calendar" && input.calendarId ? { calendarId: input.calendarId } : {}),
        uid: uid ?? input.href,
        etag,
        data: input.corpo,
        displayName,
        dtStart,
        dtEnd,
        recurring,
        seq,
        deletedAt: null,
      };

      if (existente) {
        if (moveuDeAgenda) {
          const ocupadoNoDestino = await tx.mailDavItem.findFirst({
            where: { calendarId: input.calendarId, href: input.href },
            select: { id: true, deletedAt: true },
          });
          if (ocupadoNoDestino?.deletedAt === null) throw new DavError("O recurso ja existe na agenda de destino.", 412);
          if (ocupadoNoDestino) await tx.mailDavItem.delete({ where: { id: ocupadoNoDestino.id } });
        }
        const alterado = await tx.mailDavItem.updateMany({
          where: {
            id: existente.id,
            ...(vivo ? { deletedAt: null } : { deletedAt: { not: null } }),
            ...(input.ifMatch === undefined ? {} : { etag: input.ifMatch }),
          },
          data: dados,
        });
        if (alterado.count !== 1) throw new DavError("O recurso mudou desde a sua leitura.", 412);
        if (moveuDeAgenda) {
          const oldSeq = (await tx.mailCalendar.update({ where: { id: vivo.calendarId! }, data: { seq: { increment: 1 } }, select: { seq: true } })).seq;
          await tx.mailDavItem.create({
            data: {
              mailboxId: input.mailboxId,
              collection: "calendar",
              calendarId: vivo.calendarId,
              href: input.href,
              uid: vivo.uid,
              etag: vivo.etag,
              data: vivo.data,
              displayName: vivo.displayName,
              dtStart: vivo.dtStart,
              dtEnd: vivo.dtEnd,
              recurring: vivo.recurring,
              seq: oldSeq,
              deletedAt: new Date(),
            },
          });
        }
      } else {
        await tx.mailDavItem.create({
          data: { mailboxId: input.mailboxId, collection: input.colecao, calendarId: input.calendarId, href: input.href, ...dados },
        });
      }
      await gravarConvitesNaOutbox(tx, input.mailboxId, input.calendarInviteDeliveries);
    });
  } catch (error) {
    if (error instanceof DavError) throw error;
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      throw new DavError("O recurso ja existe.", 412);
    }
    throw error;
  }

  log.info("item DAV gravado", {
    mailboxId: input.mailboxId,
    colecao: input.colecao,
    href: input.href,
    created: !vivo,
  });

  return { etag, created: !vivo };
}

export async function excluirItem(mailboxId: string, colecao: Colecao, href: string, ifMatch?: string, calendarInviteDeliveries?: CalendarInviteOutboxInput[]): Promise<void> {
  const item = await prisma.mailDavItem.findFirst({
    where: { mailboxId, collection: colecao, href, deletedAt: null },
    select: { id: true, etag: true, calendarId: true },
  });
  if (!item) throw new DavError("Recurso nao encontrado.", 404);
  if (ifMatch !== undefined && item.etag !== ifMatch) throw new DavError("O recurso mudou desde a sua leitura.", 412);

  const campoSeq = CAMPO_SEQ[colecao];
  await prisma.$transaction(async (tx) => {
    const caixa = await tx.mailbox.update({
      where: { id: mailboxId },
      data: { [campoSeq]: { increment: 1 } },
      select: { davContactsSeq: true, davCalendarSeq: true },
    });
    const seq = colecao === "calendar" && item.calendarId
      ? (await tx.mailCalendar.update({ where: { id: item.calendarId }, data: { seq: { increment: 1 } }, select: { seq: true } })).seq
      : caixa[campoSeq];
    const excluido = await tx.mailDavItem.updateMany({
      where: { id: item.id, deletedAt: null, ...(ifMatch === undefined ? {} : { etag: ifMatch }) },
      data: { deletedAt: new Date(), seq },
    });
    if (excluido.count !== 1) throw new DavError("O recurso mudou desde a sua leitura.", 412);
    await gravarConvitesNaOutbox(tx, mailboxId, calendarInviteDeliveries);
  });

  log.info("item DAV excluido (lapide)", { mailboxId, colecao, href });
}

export interface Mudancas {
  alterados: Array<{ href: string; etag: string }>;
  excluidos: string[];
  syncToken: string;
}

/** Tudo que mudou depois do token do cliente. Token ilegivel = sync inicial. */
export async function mudancasDesde(
  mailboxId: string,
  colecao: Colecao,
  token: string | null,
  calendarId?: string,
): Promise<Mudancas> {
  let desde = 0n;
  if (token) {
    const numero = token.match(/^avila-mail-sync-(\d+)$/)?.[1];
    if (numero === undefined) {
      throw new DavError(
        "Token de sincronizacao invalido.",
        403,
        '<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>',
      );
    }
    desde = BigInt(numero);
  }

  const caixa = await prisma.mailbox.findUniqueOrThrow({
    where: { id: mailboxId },
    select: {
      davContactsSeq: true,
      davCalendarSeq: true,
      davContactsMinSeq: true,
      davCalendarMinSeq: true,
    },
  });

  const agenda = colecao === "calendar" && calendarId
    ? await prisma.mailCalendar.findFirstOrThrow({ where: { id: calendarId, mailboxId }, select: { seq: true, minSeq: true } })
    : null;
  const minimo = agenda?.minSeq ?? caixa[CAMPO_MIN_SEQ[colecao]];
  const atual = agenda?.seq ?? caixa[CAMPO_SEQ[colecao]];
  if (token && (desde < minimo || desde > atual)) {
    throw new DavError(
      "Token de sincronizacao expirou.",
      403,
      '<?xml version="1.0" encoding="utf-8"?><d:error xmlns:d="DAV:"><d:valid-sync-token/></d:error>',
    );
  }

  const itens = await prisma.mailDavItem.findMany({
    where: { mailboxId, collection: colecao, seq: { gt: desde }, ...(colecao === "calendar" && calendarId ? { calendarId } : {}) },
    select: { href: true, etag: true, deletedAt: true },
    orderBy: { seq: "asc" },
  });

  return {
    alterados: itens.filter((item) => item.deletedAt === null).map(({ href, etag }) => ({ href, etag })),
    // Lapide de item que o cliente nunca viu (sync inicial) e ruido: 404 de
    // href desconhecido faz certos clientes abortarem a sincronizacao.
    excluidos: desde === 0n ? [] : itens.filter((item) => item.deletedAt !== null).map((item) => item.href),
    syncToken: `avila-mail-sync-${atual}`,
  };
}

/** Remove lapides antigas e avanca o piso que protege clientes incrementais. */
export async function limparLapidesDav(agora = new Date()): Promise<{ contacts: number; calendar: number }> {
  const limite = new Date(agora.getTime() - 90 * 86_400_000);
  const grupos = await prisma.mailDavItem.groupBy({
    by: ["mailboxId", "collection", "calendarId"],
    where: { deletedAt: { lt: limite }, collection: { in: ["contacts", "calendar"] } },
    _max: { seq: true },
  });
  const removidos = { contacts: 0, calendar: 0 };

  for (const grupo of grupos) {
    const colecao = grupo.collection as Colecao;
    const maiorSeq = grupo._max.seq;
    if (maiorSeq === null) continue;

    await prisma.$transaction(async (tx) => {
      const resultado = await tx.mailDavItem.deleteMany({
        where: {
          mailboxId: grupo.mailboxId,
          collection: colecao,
          deletedAt: { lt: limite },
          seq: { lte: maiorSeq },
        },
      });
      // updateMany com comparacao faz o piso avancar monotonamente mesmo se
      // duas faxinas concorrentes terminarem fora de ordem.
      if (colecao === "calendar" && grupo.calendarId) {
        await tx.mailCalendar.updateMany({ where: { id: grupo.calendarId, minSeq: { lt: maiorSeq } }, data: { minSeq: maiorSeq } });
      } else {
        await tx.mailbox.updateMany({
          where: { id: grupo.mailboxId, [CAMPO_MIN_SEQ[colecao]]: { lt: maiorSeq } },
          data: { [CAMPO_MIN_SEQ[colecao]]: maiorSeq },
        });
      }
      removidos[colecao] += resultado.count;
    });
  }

  return removidos;
}
