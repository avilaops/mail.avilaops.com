import { gunzipSync, gzipSync } from "node:zlib";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, sep } from "node:path";
import { config } from "./config.js";

/**
 * Armazenamento das mensagens brutas.
 *
 * O .eml e a fonte da verdade: e ele que preserva os headers originais, a
 * assinatura DKIM recebida e os anexos. O banco guarda so metadado e corpo
 * indexado. Anexo nao e duplicado — sai do .eml sob demanda.
 *
 * Layout: <MAIL_STORAGE_DIR>/<AAAA>/<MM>/<id>.eml.gz
 * Particionar por mes mantem o numero de arquivos por diretorio administravel
 * e torna trivial arquivar ou expurgar um periodo inteiro.
 */

export interface StoredBlob {
  storageKey: string;
  /** Tamanho do .eml original, sem compressao. E o que conta para a quota. */
  sizeBytes: number;
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
  const target = resolvePath(storageKey);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, gzipSync(raw, { level: 6 }), { mode: 0o640 });
  return { storageKey, sizeBytes: raw.byteLength };
}

export async function readRaw(storageKey: string): Promise<Buffer> {
  return gunzipSync(await readFile(resolvePath(storageKey)));
}

export async function deleteRaw(storageKey: string): Promise<void> {
  try {
    await unlink(resolvePath(storageKey));
  } catch (error) {
    // Blob ja removido nao e erro: o objetivo (nao existir) foi atingido.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export async function ensureStorageDir(): Promise<void> {
  await mkdir(config.storageDir, { recursive: true, mode: 0o750 });
}
