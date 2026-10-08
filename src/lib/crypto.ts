import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

/**
 * Cifra simetrica para segredos em repouso — hoje so as chaves privadas DKIM.
 *
 * AES-256-GCM com IV aleatorio por operacao. Formato serializado:
 *   v1:<iv base64>:<authTag base64>:<ciphertext base64>
 * O prefixo de versao existe para permitir rotacao de algoritmo sem migracao
 * cega do banco.
 */

const VERSION = "v1";

function key(): Buffer {
  return Buffer.from(config.dkim.encryptionKey, "hex");
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(serialized: string): string {
  const parts = serialized.split(":");
  const [version, ivB64, tagB64, dataB64] = parts;

  if (parts.length !== 4 || version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
    throw new Error("Segredo cifrado em formato invalido ou de versao desconhecida.");
  }

  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}
