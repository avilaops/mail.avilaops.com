import { randomUUID } from "node:crypto";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { deleteRaw, readRaw, storeRaw } from "../lib/storage.js";
import { MessageError } from "./messages.js";

const log = createLogger("uploads");

/**
 * Anexo enviado antes da mensagem.
 *
 * Sem isso, o anexo so viaja junto com o envio: o cliente aperta "enviar" e
 * fica olhando para uma tela parada enquanto 20 MB sobem, sem barra de
 * progresso e sem poder desistir. Subindo antes, cada arquivo tem seu proprio
 * progresso e o envio em si e instantaneo.
 *
 * O arquivo fica em disco e conta contra a quota so quando a mensagem for
 * enviada de fato — anexo abandonado e limpo por `cleanupStaleUploads`.
 */

const VALIDADE_HORAS = 24;
const MAX_ANEXOS_PENDENTES = 20;

/** Extensoes que nao aceitamos guardar nem repassar. */
const EXTENSOES_BLOQUEADAS = new Set([
  "exe", "scr", "com", "pif", "bat", "cmd", "vbs", "vbe", "js", "jse",
  "wsf", "wsh", "msi", "msp", "hta", "cpl", "jar", "ps1", "reg", "lnk",
]);

/** Nome de arquivo nao pode virar caminho nem cabecalho. */
function nomeSeguro(filename: string): string {
  const base = filename
    .replace(/[\r\n\t]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/^\.+/, "")
    .trim();

  if (base === "" || base === "." || base === "..") throw new MessageError("Nome de arquivo invalido.", 422);
  if (base.length > 200) throw new MessageError("Nome de arquivo muito longo.", 422);

  const extensao = base.includes(".") ? (base.split(".").pop() ?? "").toLowerCase() : "";
  if (EXTENSOES_BLOQUEADAS.has(extensao)) {
    throw new MessageError(`Arquivos .${extensao} nao sao aceitos como anexo.`, 422);
  }

  return base;
}

export interface UploadInput {
  mailboxId: string;
  filename: string;
  contentType?: string;
  contentBase64: string;
}

export async function storeUpload(input: UploadInput) {
  const filename = nomeSeguro(input.filename);

  let conteudo: Buffer;
  try {
    conteudo = Buffer.from(input.contentBase64, "base64");
  } catch {
    throw new MessageError("Conteudo do anexo nao e base64 valido.", 422);
  }

  // Buffer.from com base64 invalido nao lanca: devolve lixo ou vazio. Sem esta
  // checagem, um upload corrompido viraria anexo de 0 byte na mensagem.
  if (conteudo.byteLength === 0) throw new MessageError("Anexo vazio ou base64 invalido.", 422);

  if (conteudo.byteLength > config.limits.maxMessageBytes) {
    const limiteMb = Math.floor(config.limits.maxMessageBytes / 1024 / 1024);
    throw new MessageError(`Anexo maior que o limite de ${limiteMb} MB.`, 413);
  }

  const pendentes = await prisma.pendingAttachment.count({ where: { mailboxId: input.mailboxId } });
  if (pendentes >= MAX_ANEXOS_PENDENTES) {
    throw new MessageError(`No maximo ${MAX_ANEXOS_PENDENTES} anexos pendentes por vez.`, 429);
  }

  const id = randomUUID();
  const blob = await storeRaw(`upload-${id}`, conteudo);

  const registro = await prisma.pendingAttachment.create({
    data: {
      mailboxId: input.mailboxId,
      filename,
      contentType: input.contentType?.slice(0, 150) || "application/octet-stream",
      sizeBytes: conteudo.byteLength,
      storageKey: blob.storageKey,
    },
    select: { id: true, filename: true, contentType: true, sizeBytes: true, createdAt: true },
  });

  log.info("anexo recebido", { mailboxId: input.mailboxId, uploadId: registro.id, sizeBytes: conteudo.byteLength });
  return registro;
}

export async function listUploads(mailboxId: string) {
  return prisma.pendingAttachment.findMany({
    where: { mailboxId },
    orderBy: { createdAt: "desc" },
    select: { id: true, filename: true, contentType: true, sizeBytes: true, createdAt: true },
  });
}

export async function deleteUpload(mailboxId: string, uploadId: string): Promise<void> {
  const registro = await prisma.pendingAttachment.findFirst({
    where: { id: uploadId, mailboxId },
    select: { id: true, storageKey: true },
  });
  if (!registro) throw new MessageError("Anexo nao encontrado.", 404);

  await prisma.pendingAttachment.delete({ where: { id: registro.id } });
  await deleteRaw(registro.storageKey);
}

/**
 * Materializa os anexos pendentes para o envio e os consome.
 * Escopo por `mailboxId` no `where`: id de upload alheio nao anexa nada.
 */
export async function consumeUploads(
  mailboxId: string,
  uploadIds: string[],
): Promise<Array<{ filename: string; contentType: string; content: Buffer }>> {
  if (uploadIds.length === 0) return [];

  const registros = await prisma.pendingAttachment.findMany({
    where: { id: { in: uploadIds }, mailboxId },
    select: { id: true, filename: true, contentType: true, storageKey: true },
  });

  if (registros.length !== uploadIds.length) {
    throw new MessageError("Algum anexo expirou ou nao pertence a esta caixa. Envie novamente.", 404);
  }

  const anexos = await Promise.all(
    registros.map(async (registro) => ({
      filename: registro.filename,
      contentType: registro.contentType,
      content: await readRaw(registro.storageKey),
    })),
  );

  await prisma.pendingAttachment.deleteMany({ where: { id: { in: registros.map((r) => r.id) }, mailboxId } });
  for (const registro of registros) await deleteRaw(registro.storageKey);

  return anexos;
}

/** Varre anexos abandonados. Chamado pelo worker de manutencao. */
export async function cleanupStaleUploads(): Promise<{ removed: number }> {
  const limite = new Date(Date.now() - VALIDADE_HORAS * 3_600_000);

  const velhos = await prisma.pendingAttachment.findMany({
    where: { createdAt: { lt: limite } },
    select: { id: true, storageKey: true },
  });

  if (velhos.length === 0) return { removed: 0 };

  await prisma.pendingAttachment.deleteMany({ where: { id: { in: velhos.map((v) => v.id) } } });
  for (const velho of velhos) await deleteRaw(velho.storageKey);

  log.info("anexos abandonados removidos", { count: velhos.length });
  return { removed: velhos.length };
}
