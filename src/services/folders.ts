import { prisma } from "../lib/db.js";
import { moverParaPasta, novoUidValidity } from "./uid.js";

/**
 * Pastas de sistema criadas junto com a caixa.
 * Nomes em portugues porque o webmail e do cliente final brasileiro; o campo
 * `kind` e o identificador estavel usado pelo codigo.
 */
export const SYSTEM_FOLDERS = [
  { kind: "inbox", name: "Caixa de Entrada" },
  { kind: "sent", name: "Enviados" },
  { kind: "drafts", name: "Rascunhos" },
  { kind: "archive", name: "Arquivo" },
  { kind: "snoozed", name: "Adiadas" },
  { kind: "spam", name: "Spam" },
  { kind: "trash", name: "Lixeira" },
] as const;

export type SystemFolderKind = (typeof SYSTEM_FOLDERS)[number]["kind"];

export async function ensureSystemFolders(mailboxId: string): Promise<void> {
  await prisma.mailFolder.createMany({
    data: SYSTEM_FOLDERS.map((folder) => ({
      mailboxId,
      kind: folder.kind,
      name: folder.name,
      uidValidity: novoUidValidity(),
    })),
    skipDuplicates: true,
  });
}

/**
 * Devolve a pasta de sistema, criando-a se faltar.
 * A auto-criacao cobre caixas antigas e o caso de alguem apagar a pasta na mao:
 * entrega de e-mail nunca pode falhar por pasta ausente.
 */
export async function getSystemFolder(mailboxId: string, kind: SystemFolderKind): Promise<{ id: string }> {
  const existing = await prisma.mailFolder.findFirst({
    where: { mailboxId, kind },
    select: { id: true },
  });
  if (existing) return existing;

  await ensureSystemFolders(mailboxId);

  const created = await prisma.mailFolder.findFirst({
    where: { mailboxId, kind },
    select: { id: true },
  });
  if (!created) throw new Error(`Nao foi possivel garantir a pasta de sistema "${kind}" da caixa ${mailboxId}`);
  return created;
}

export class FolderError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "FolderError";
  }
}

const MAX_PASTAS_PROPRIAS = 50;
const SYSTEM_KINDS = new Set(SYSTEM_FOLDERS.map((folder) => folder.kind as string));

function nomeValido(nome: string): string {
  const limpo = nome.trim().replace(/[\r\n\t]/g, "");
  if (limpo.length < 1) throw new FolderError("Informe o nome da pasta.", 422);
  if (limpo.length > 60) throw new FolderError("Nome de pasta muito longo (maximo 60).", 422);
  return limpo;
}

/**
 * Cria pasta propria do cliente.
 *
 * Pasta de sistema tem `kind` proprio; as do cliente nascem todas como
 * "custom". Assim, o codigo que procura a Lixeira nunca esbarra numa pasta
 * que o cliente batizou de "Lixeira".
 */
export async function createFolder(mailboxId: string, name: string) {
  const nome = nomeValido(name);

  const quantidade = await prisma.mailFolder.count({ where: { mailboxId, kind: "custom" } });
  if (quantidade >= MAX_PASTAS_PROPRIAS) {
    throw new FolderError(`Limite de ${MAX_PASTAS_PROPRIAS} pastas proprias atingido.`, 429);
  }

  const existente = await prisma.mailFolder.findFirst({
    where: { mailboxId, name: nome },
    select: { id: true },
  });
  if (existente) throw new FolderError(`Ja existe uma pasta chamada "${nome}".`, 409);

  return prisma.mailFolder.create({
    data: { mailboxId, name: nome, kind: "custom", uidValidity: novoUidValidity() },
    select: { id: true, name: true, kind: true, createdAt: true },
  });
}

export async function renameFolder(mailboxId: string, folderId: string, name: string) {
  const nome = nomeValido(name);

  const pasta = await prisma.mailFolder.findFirst({
    where: { id: folderId, mailboxId },
    select: { id: true, kind: true },
  });
  if (!pasta) throw new FolderError("Pasta nao encontrada.", 404);

  // Renomear a Caixa de Entrada quebraria o cliente que a procura pelo nome.
  if (SYSTEM_KINDS.has(pasta.kind)) throw new FolderError("Pasta de sistema nao pode ser renomeada.", 422);

  const conflito = await prisma.mailFolder.findFirst({
    where: { mailboxId, name: nome, id: { not: folderId } },
    select: { id: true },
  });
  if (conflito) throw new FolderError(`Ja existe uma pasta chamada "${nome}".`, 409);

  return prisma.mailFolder.update({
    where: { id: pasta.id },
    data: { name: nome },
    select: { id: true, name: true, kind: true },
  });
}

/**
 * Remove pasta propria. As mensagens voltam para a Caixa de Entrada.
 *
 * Apagar junto com o conteudo seria mais simples e destruiria correspondencia
 * do cliente por um clique em "excluir pasta" — o que ele quis apagar foi a
 * organizacao, nao as mensagens.
 */
export async function deleteFolder(mailboxId: string, folderId: string) {
  const pasta = await prisma.mailFolder.findFirst({
    where: { id: folderId, mailboxId },
    select: { id: true, kind: true, name: true },
  });
  if (!pasta) throw new FolderError("Pasta nao encontrada.", 404);
  if (SYSTEM_KINDS.has(pasta.kind)) throw new FolderError("Pasta de sistema nao pode ser excluida.", 422);

  const entrada = await getSystemFolder(mailboxId, "inbox");

  const naPasta = await prisma.message.findMany({
    where: { mailboxId, folderId: pasta.id },
    select: { id: true },
  });

  const movidas = await moverParaPasta(mailboxId, naPasta.map((m) => m.id), entrada.id);

  await prisma.mailFolder.delete({ where: { id: pasta.id } });

  return { deleted: pasta.name, movedToInbox: movidas };
}

/** Resolve uma pasta por id ou por `kind`, sempre dentro da caixa da sessao. */
export async function resolveFolder(mailboxId: string, folderIdOrKind: string): Promise<{ id: string }> {
  const pasta = await prisma.mailFolder.findFirst({
    where: { mailboxId, OR: [{ id: folderIdOrKind }, { kind: folderIdOrKind }] },
    select: { id: true },
  });
  if (!pasta) throw new FolderError(`Pasta nao encontrada: ${folderIdOrKind}`, 404);
  return pasta;
}
