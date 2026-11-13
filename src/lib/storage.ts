import { gunzipSync, gzipSync } from "node:zlib";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { config } from "./config.js";

/**
 * Armazenamento das mensagens brutas.
 *
 * O .eml e a fonte da verdade: e ele que preserva os headers originais, a
 * assinatura DKIM recebida e os anexos. O banco guarda so metadado e corpo
 * indexado. Anexo nao e duplicado — sai do .eml sob demanda.
 *
 * Layout: <MAIL_STORAGE_DIR>/<AAAA>/<MM>/<id>.eml.gz
 * Com MAIL_STORAGE_DRIVER=r2, a mesma chave fica em MAIL_R2_BUCKET.
 * Particionar por mes mantem o numero de arquivos por diretorio administravel
 * e torna trivial arquivar ou expurgar um periodo inteiro.
 */

export interface StoredBlob {
  storageKey: string;
  /** Tamanho do .eml original, sem compressao. E o que conta para a quota. */
  sizeBytes: number;
}

const r2 = config.storageDriver === "r2" ? new S3Client({
  endpoint: config.r2.endpoint,
  region: "auto",
  forcePathStyle: true,
  credentials: { accessKeyId: config.r2.accessKeyId, secretAccessKey: config.r2.secretAccessKey },
}) : null;

function validObjectKey(storageKey: string): string {
  if (!/^\d{4}\/(?:0[1-9]|1[0-2])\/[A-Za-z0-9_-]+\.eml\.gz$/.test(storageKey)) {
    throw new Error("Chave de armazenamento de mensagem invalida.");
  }
  return storageKey;
}

function keyFor(id: string, when: Date): string {
  const year = String(when.getUTCFullYear());
  const month = String(when.getUTCMonth() + 1).padStart(2, "0");
  return `${year}/${month}/${id}.eml.gz`;
}

/**
 * Resolve a chave para caminho absoluto recusando qualquer coisa que escape
 * do diretorio de armazenamento. A chave vem do banco, mas tratar dado do
 * banco como confiavel e exatamente como se constroi um path traversal.
 */
function resolvePath(storageKey: string): string {
  const absolute = normalize(join(config.storageDir, storageKey));
  const root = normalize(config.storageDir);
  if (absolute !== root && !absolute.startsWith(root.endsWith(sep) ? root : root + sep)) {
    throw new Error(`Chave de armazenamento fora do diretorio permitido: ${storageKey}`);
  }
  return absolute;
}

export async function storeRaw(id: string, raw: Buffer, when: Date = new Date()): Promise<StoredBlob> {
  const storageKey = keyFor(id, when);
  if (r2) {
    await r2.send(new PutObjectCommand({ Bucket: config.r2.bucket, Key: validObjectKey(storageKey), Body: gzipSync(raw, { level: 6 }), ContentType: "application/gzip" }));
    return { storageKey, sizeBytes: raw.byteLength };
  }
  const target = resolvePath(storageKey);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, gzipSync(raw, { level: 6 }), { mode: 0o640 });
  return { storageKey, sizeBytes: raw.byteLength };
}

export async function readRaw(storageKey: string): Promise<Buffer> {
  if (r2) {
    try {
      const object = await r2.send(new GetObjectCommand({ Bucket: config.r2.bucket, Key: validObjectKey(storageKey) }));
      if (!object.Body) throw new Error("Objeto de mensagem retornou sem corpo.");
      return gunzipSync(await object.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof Error && error.name === "NoSuchKey") {
        throw Object.assign(new Error("Arquivo de mensagem nao encontrado."), { code: "ENOENT" });
      }
      throw error;
    }
  }
  return gunzipSync(await readFile(resolvePath(storageKey)));
}

export async function deleteRaw(storageKey: string): Promise<void> {
  if (r2) {
    await r2.send(new DeleteObjectCommand({ Bucket: config.r2.bucket, Key: validObjectKey(storageKey) }));
    return;
  }
  try {
    await unlink(resolvePath(storageKey));
  } catch (error) {
    // Blob ja removido nao e erro: o objetivo (nao existir) foi atingido.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function ensureStorageDir(): Promise<void> {
  if (r2) {
    await r2.send(new HeadBucketCommand({ Bucket: config.r2.bucket }));
    return;
  }
  await mkdir(config.storageDir, { recursive: true, mode: 0o750 });
}

/** MIME pendente de Email Worker. Este namespace nunca contem blobs de caixas. */
export async function readPendingInbound(storageKey: string) {
  if (!/^incoming\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.eml$/.test(storageKey)) {
    throw new Error("Chave de entrada invalida.");
  }
  if (!r2) throw new Error("Recepcao Cloudflare requer armazenamento R2.");
  const object = await r2.send(new GetObjectCommand({ Bucket: config.r2.bucket, Key: storageKey }));
  if (!object.Body || !object.ContentLength || object.ContentLength > config.limits.maxMessageBytes) {
    throw new Error("Mensagem pendente sem corpo ou maior que o limite.");
  }
  const raw = Buffer.from(await object.Body.transformToByteArray());
  if (raw.byteLength !== object.ContentLength || raw.byteLength > config.limits.maxMessageBytes) {
    throw new Error("Tamanho da mensagem pendente invalido.");
  }
  return { raw, metadata: object.Metadata ?? {} };
}
