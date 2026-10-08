import { prisma } from "../lib/db.js";

/**
 * UIDs do IMAP.
 *
 * O protocolo exige que cada mensagem tenha um numero unico e CRESCENTE dentro
 * da pasta, e que esse numero nunca seja reaproveitado. O cliente guarda o
 * ultimo UID que viu e pede "tudo acima disso" — reaproveitar um numero faz
 * ele exibir a mensagem errada, ou pior, nunca baixar a nova.
 *
 * Por isso o contador vive na pasta e so avanca, mesmo quando mensagens sao
 * apagadas.
 */

/**
 * Reserva o proximo UID da pasta.
 *
 * O incremento e atomico no banco: dois e-mails chegando ao mesmo tempo na
 * mesma caixa nao podem receber o mesmo numero. Ler-e-depois-gravar aqui seria
 * uma corrida com consequencia visivel para o cliente.
 */
export async function proximoUid(folderId: string): Promise<number> {
  const pasta = await prisma.mailFolder.update({
    where: { id: folderId },
    data: { uidNext: { increment: 1 } },
    select: { uidNext: true },
  });

  // O update devolve o valor JA incrementado; o UID desta mensagem e o anterior.
  return pasta.uidNext - 1;
}

/** Reserva um bloco de UIDs, para mover varias mensagens de uma vez. */
export async function reservarUids(folderId: string, quantidade: number): Promise<number[]> {
  if (quantidade <= 0) return [];

  const pasta = await prisma.mailFolder.update({
    where: { id: folderId },
    data: { uidNext: { increment: quantidade } },
    select: { uidNext: true },
  });

  const primeiro = pasta.uidNext - quantidade;
  return Array.from({ length: quantidade }, (_, i) => primeiro + i);
}

/**
 * Move mensagens para outra pasta, com UID novo em cada uma.
 *
 * O protocolo trata a mensagem movida como uma mensagem NOVA no destino: ela
 * recebe UID da sequencia daquela pasta. Reaproveitar o UID de origem faria o
 * cliente confundir duas mensagens diferentes, ou ignorar a que chegou porque
 * "esse numero eu ja tenho".
 *
 * Por isso nao da para usar um `updateMany` unico — cada linha precisa do seu
 * proprio numero.
 */
export async function moverParaPasta(
  mailboxId: string,
  messageIds: string[],
  folderId: string,
): Promise<number> {
  if (messageIds.length === 0) return 0;

  const uids = await reservarUids(folderId, messageIds.length);

  const resultados = await prisma.$transaction(
    messageIds.map((id, indice) =>
      prisma.message.updateMany({
        where: { id, mailboxId },
        data: { folderId, uid: uids[indice] ?? 0 },
      }),
    ),
  );

  return resultados.reduce((soma, r) => soma + r.count, 0);
}

/**
 * UIDVALIDITY novo, em segundos.
 *
 * Segundos e nao milissegundos porque o campo do protocolo e um inteiro de
 * 32 bits sem sinal — milissegundos estourariam o limite.
 */
export function novoUidValidity(): number {
  return Math.floor(Date.now() / 1000);
}
