import bcrypt from "bcryptjs";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

/**
 * Senha de caixa postal.
 *
 * Hash novo: scrypt do node:crypto (nativo, em C). Hash antigo: bcrypt custo 12
 * (bcryptjs, JavaScript puro), que continua sendo aceito e e trocado pelo
 * scrypt na primeira autenticacao correta — ver `upgradeHashIfNeeded` em
 * src/services/passwordUpgrade.ts.
 *
 * Por que a troca: os servicos rodam com `--jitless` para conviver com o
 * MemoryDenyWriteExecute do systemd, e sem JIT o bcryptjs leva dezenas de
 * segundos por verificacao. Todo login IMAP/SMTP/webmail passava a demorar o
 * suficiente para o cliente desistir (o n8n recebia "421 Timeout"). O scrypt
 * nativo nao depende do JIT e fica na casa dos 100 ms.
 */

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 32, maxmem: 64 * 1024 * 1024 } as const;
const PREFIXO_SCRYPT = "$scrypt$";

function derivar(plain: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      plain,
      salt,
      SCRYPT.keylen,
      { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem },
      (erro, chave) => (erro ? reject(erro) : resolve(chave)),
    );
  });
}

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const chave = await derivar(plain, salt);
  return `${PREFIXO_SCRYPT}N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$${salt.toString("base64")}$${chave.toString("base64")}`;
}

/** Hash no formato antigo (bcrypt): valido, mas deve ser trocado no proximo login. */
export function needsRehash(hash: string): boolean {
  return !hash.startsWith(PREFIXO_SCRYPT);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    if (hash.startsWith(PREFIXO_SCRYPT)) {
      const [, , parametros, saltB64, chaveB64] = hash.split("$");
      if (!parametros || !saltB64 || !chaveB64) return false;
      const esperada = Buffer.from(chaveB64, "base64");
      const obtida = await derivar(plain, Buffer.from(saltB64, "base64"));
      return obtida.length === esperada.length && timingSafeEqual(obtida, esperada);
    }
    // Legado bcrypt: lento sem JIT, mas so ate o primeiro login correto.
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

/** Salt fixo: o objetivo e gastar o tempo de um scrypt real, nao guardar nada. */
const SALT_FANTASMA = Buffer.from("avila-mail-caixa-inexistente");

/**
 * Gasta o mesmo tempo de uma verificacao real.
 *
 * Sem isso, "caixa nao existe" responde em milissegundos e "senha errada"
 * responde no tempo do scrypt. Cronometrando as respostas, o atacante descobre
 * quais enderecos existem — o que anula a mensagem de erro unica, que so
 * protege contra quem le o texto, nao contra quem mede o relogio.
 */
export async function burnPasswordTime(plain: string): Promise<void> {
  await derivar(plain, SALT_FANTASMA).catch(() => undefined);
}

/** Alfabeto sem caracteres ambiguos (0/O, 1/l/I) — a senha vai ser digitada no celular. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generatePassword(length = 16): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += ALPHABET[bytes[i]! % ALPHABET.length];
  }
  return out;
}

/** Comparacao de token de API em tempo constante. */
export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
