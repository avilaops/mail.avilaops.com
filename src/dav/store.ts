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

function etagDe(corpo: string): string {
  return createHash("sha256").update(corpo, "utf8").digest("hex").slice(0, 32);
}

/** Nome de recurso vindo da URL: sem barra, sem esquisitice. */
export function hrefValido(href: string): boolean {
  return /^[A-Za-z0-9._@%~-]{1,255}$/.test(href);
}

export async function ctag(mailboxId: string, colecao: Colecao): Promise<string> {
  const caixa = await prisma.mailbox.findUniqueOrThrow({
    where: { id: mailboxId },
    select: { davContactsSeq: true, davCalendarSeq: true },
  });
  return caixa[CAMPO_SEQ[colecao]].toString();
}

export async function listarItens(mailboxId: string, colecao: Colecao) {
  return prisma.mailDavItem.findMany({
    where: { mailboxId, collection: colecao, deletedAt: null },
    orderBy: { href: "asc" },
    select: { href: true, etag: true, displayName: true, dtStart: true, dtEnd: true, recurring: true },
  });
}

export async function obterItem(mailboxId: string, colecao: Colecao, href: string) {
  return prisma.mailDavItem.findFirst({
    where: { mailboxId, collection: colecao, href, deletedAt: null },
    select: { href: true, etag: true, data: true, uid: true },
  });
}

/** Listagem com o blob — para os REPORTs de query, que devolvem o conteudo. */
export async function listarComDados(mailboxId: string, colecao: Colecao) {
  return prisma.mailDavItem.findMany({
    where: { mailboxId, collection: colecao, deletedAt: null },
    orderBy: { href: "asc" },
    select: { href: true, etag: true, data: true, dtStart: true, dtEnd: true, recurring: true },
  });
}

export async function obterVarios(mailboxId: string, colecao: Colecao, hrefs: string[]) {
  return prisma.mailDavItem.findMany({
    where: { mailboxId, collection: colecao, href: { in: hrefs }, deletedAt: null },
    select: { href: true, etag: true, data: true },
  });
}

export interface GravarInput {
  mailboxId: string;
  colecao: Colecao;
  href: string;
  corpo: string;
  /** Valor do If-Match (etag), quando o cliente exige atualizar a versao X. */
  ifMatch?: string;
  /** If-None-Match: * — o cliente exige que seja criacao. */
  ifNoneMatchAll?: boolean;
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

  const existente = await prisma.mailDavItem.findUnique({
    where: {
      mailboxId_collection_href: { mailboxId: input.mailboxId, collection: input.colecao, href: input.href },
    },
    select: { id: true, etag: true, deletedAt: true },
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
      where: { mailboxId: input.mailboxId, collection: input.colecao, deletedAt: null },
    });
    if (total >= MAX_ITENS_POR_COLECAO) {
      throw new DavError(`Limite de ${MAX_ITENS_POR_COLECAO} itens na colecao.`, 507);
    }
  }

  const etag = etagDe(input.corpo);
  const campoSeq = CAMPO_SEQ[input.colecao];

  await prisma.$transaction(async (tx) => {
    const caixa = await tx.mailbox.update({
      where: { id: input.mailboxId },
      data: { [campoSeq]: { increment: 1 } },
      select: { davContactsSeq: true, davCalendarSeq: true },
    });
    const seq = caixa[campoSeq];

    const dados = {
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
      await tx.mailDavItem.update({ where: { id: existente.id }, data: dados });
    } else {
      await tx.mailDavItem.create({
        data: { mailboxId: input.mailboxId, collection: input.colecao, href: input.href, ...dados },
      });
    }
  });

  log.info("item DAV gravado", {
    mailboxId: input.mailboxId,
    colecao: input.colecao,
    href: input.href,
    created: !vivo,
  });

  return { etag, created: !vivo };
}

export async function excluirItem(mailboxId: string, colecao: Colecao, href: string): Promise<void> {
  const item = await prisma.mailDavItem.findFirst({
    where: { mailboxId, collection: colecao, href, deletedAt: null },
    select: { id: true },
  });
  if (!item) throw new DavError("Recurso nao encontrado.", 404);

  const campoSeq = CAMPO_SEQ[colecao];
  await prisma.$transaction(async (tx) => {
    const caixa = await tx.mailbox.update({
      where: { id: mailboxId },
      data: { [campoSeq]: { increment: 1 } },
      select: { davContactsSeq: true, davCalendarSeq: true },
    });
    await tx.mailDavItem.update({
      where: { id: item.id },
      data: { deletedAt: new Date(), seq: caixa[campoSeq] },
    });
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
): Promise<Mudancas> {
  let desde = 0n;
  if (token) {
    const numero = token.match(/(\d+)$/)?.[1];
    if (numero !== undefined) desde = BigInt(numero);
  }

  const [itens, atual] = await Promise.all([
    prisma.mailDavItem.findMany({
      where: { mailboxId, collection: colecao, seq: { gt: desde } },
      select: { href: true, etag: true, deletedAt: true },
      orderBy: { seq: "asc" },
    }),
    ctag(mailboxId, colecao),
  ]);

  return {
    alterados: itens.filter((item) => item.deletedAt === null).map(({ href, etag }) => ({ href, etag })),
    // Lapide de item que o cliente nunca viu (sync inicial) e ruido: 404 de
    // href desconhecido faz certos clientes abortarem a sincronizacao.
    excluidos: desde === 0n ? [] : itens.filter((item) => item.deletedAt !== null).map((item) => item.href),
    syncToken: `avila-mail-sync-${atual}`,
  };
}
