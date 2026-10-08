import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) sobre HMAC-SHA1, o unico modo que TODO aplicativo
 * autenticador implementa — Google Authenticator, Authy, 1Password, Aegis.
 * SHA-256 aqui seria pureza que tranca o cliente do lado de fora.
 *
 * So aritmetica e crypto do Node: sem dependencia nova para 30 linhas de RFC.
 */

const BASE32_ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(dados: Buffer): string {
  let bits = 0;
  let valor = 0;
  let saida = "";

  for (const byte of dados) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += BASE32_ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) saida += BASE32_ALFABETO[(valor << (5 - bits)) & 31];

  return saida;
}

export function base32Decode(texto: string): Buffer {
  const limpo = texto.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let valor = 0;
  const bytes: number[] = [];

  for (const caractere of limpo) {
    const indice = BASE32_ALFABETO.indexOf(caractere);
    if (indice === -1) throw new Error(`Caractere invalido em base32: ${caractere}`);
    valor = (valor << 5) | indice;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

/** Segredo novo: 20 bytes (160 bits), o tamanho canonico do RFC 4226. */
export function gerarSegredoTotp(): string {
  return base32Encode(randomBytes(20));
}

export const TOTP_PASSO_SEGUNDOS = 30;
export const TOTP_DIGITOS = 6;

/** Codigo do contador dado — exposto para o smoke conferir os vetores do RFC. */
export function codigoDoContador(segredoBase32: string, contador: number): string {
  const mensagem = Buffer.alloc(8);
  mensagem.writeBigUInt64BE(BigInt(contador));

  const resumo = createHmac("sha1", base32Decode(segredoBase32)).update(mensagem).digest();
  const deslocamento = (resumo[resumo.length - 1] ?? 0) & 0x0f;
  const trecho =
    (((resumo[deslocamento] ?? 0) & 0x7f) << 24) |
    (((resumo[deslocamento + 1] ?? 0) & 0xff) << 16) |
    (((resumo[deslocamento + 2] ?? 0) & 0xff) << 8) |
    ((resumo[deslocamento + 3] ?? 0) & 0xff);

  return String(trecho % 10 ** TOTP_DIGITOS).padStart(TOTP_DIGITOS, "0");
}

export function contadorAtual(agora = new Date()): number {
  return Math.floor(agora.getTime() / 1000 / TOTP_PASSO_SEGUNDOS);
}

/**
 * Confere o codigo com tolerancia de ±1 passo — relogio de celular atrasa.
 *
 * @returns o contador que casou (para o anti-replay guardar), ou null.
 */
export function verificarCodigoTotp(
  segredoBase32: string,
  codigo: string,
  agora = new Date(),
): number | null {
  const digitado = codigo.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digitado)) return null;

  const centro = contadorAtual(agora);
  for (const contador of [centro, centro - 1, centro + 1]) {
    const esperado = codigoDoContador(segredoBase32, contador);
    if (timingSafeEqual(Buffer.from(esperado), Buffer.from(digitado))) return contador;
  }
  return null;
}

/**
 * URL otpauth:// que o aplicativo autenticador importa. O rotulo leva o
 * endereco da caixa para o cliente com varias contas saber qual e qual.
 */
export function otpauthUrl(endereco: string, segredoBase32: string): string {
  const rotulo = encodeURIComponent(endereco);
  return `otpauth://totp/${rotulo}?secret=${segredoBase32}&issuer=${encodeURIComponent("Avila Mail")}&algorithm=SHA1&digits=${TOTP_DIGITOS}&period=${TOTP_PASSO_SEGUNDOS}`;
}

/**
 * Codigos de recuperacao: 8 codigos de uso unico no formato xxxxx-xxxxx.
 * Sao a saida de quem perdeu o celular — sem eles, 2FA vira chamado de
 * suporte com prova de identidade na mao.
 */
export function gerarCodigosDeRecuperacao(quantidade = 8): string[] {
  return Array.from({ length: quantidade }, () => {
    const texto = base32Encode(randomBytes(10)).toLowerCase().slice(0, 10);
    return `${texto.slice(0, 5)}-${texto.slice(5)}`;
  });
}
