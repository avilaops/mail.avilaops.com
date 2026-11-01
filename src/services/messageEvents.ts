import { prisma } from "../lib/db.js";
import { camposResumoMensagem, resumoMensagem } from "./messages.js";

export function cursorMensagem(mailboxId: string, seq: bigint): string {
  return `${mailboxId}:${seq}`;
}

/** Cursor pertence a uma caixa; entrada invalida exige reconciliacao inicial. */
export function lerCursorMensagem(valor: string | undefined, mailboxId: string, atual: bigint): bigint {
  if (!valor || valor.length > 180) return atual;
  const prefixo = `${mailboxId}:`;
  if (!valor.startsWith(prefixo) || !/^\d{1,20}$/.test(valor.slice(prefixo.length))) return atual;
  const seq = BigInt(valor.slice(prefixo.length));
  return seq <= atual ? seq : atual;
}

export async function eventosMensagem(mailboxId: string, depois: bigint) {
  const caixa = await prisma.mailbox.findUniqueOrThrow({ where: { id: mailboxId }, select: { messageEventSeq: true } });
  const linhas = await prisma.message.findMany({
    where: { mailboxId, arrivalSeq: { gt: depois, lte: caixa.messageEventSeq } },
    orderBy: { arrivalSeq: "asc" }, take: 20,
    select: { ...camposResumoMensagem, arrivalSeq: true, notificationKind: true, folder: { select: { kind: true } } },
  });
  return {
    seq: linhas.length === 20 ? linhas[linhas.length - 1]!.arrivalSeq : caixa.messageEventSeq,
    messages: linhas.map(({ arrivalSeq: _seq, notificationKind: _tipo, folder: _pasta, ...mensagem }) => resumoMensagem(mensagem)),
    avisos: linhas.map((linha) => ({ id: linha.id, tipo: linha.notificationKind, pasta: linha.folder.kind })),
  };
}
