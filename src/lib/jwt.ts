import jwt from "jsonwebtoken";
import { config } from "./config.js";

/**
 * Access token do dono da caixa.
 *
 * Curto de proposito (15 min por padrao). O que da longevidade a sessao e o
 * refresh token, que vive no banco e pode ser revogado — um JWT longo nao
 * teria como ser cancelado quando o cliente clica em "sair de todos os
 * dispositivos" ou quando a caixa e suspensa por falta de pagamento.
 */

const ISSUER = "avila-mail";
const AUDIENCE = "avila-mail-webmail";

export interface AccessTokenPayload {
  /** id da caixa */
  sub: string;
  /** endereco completo, para log e exibicao sem ida ao banco */
  adr: string;
  /** id da sessao, permite revogar o par access/refresh */
  sid: string;
}

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, config.session.jwtSecret, {
    algorithm: "HS256",
    expiresIn: `${config.session.accessTokenMinutes}m`,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

/**
 * Token intermediario do login com 2FA: prova que a senha ja foi conferida,
 * enquanto o codigo do autenticador ainda nao veio. Curto (5 min) e com
 * audience propria — nunca serve como access token, e vice-versa.
 */
const AUDIENCE_TOTP = "avila-mail-totp";

export function signTotpToken(payload: { sub: string }): string {
  return jwt.sign(payload, config.session.jwtSecret, {
    algorithm: "HS256",
    expiresIn: "5m",
    issuer: ISSUER,
    audience: AUDIENCE_TOTP,
  });
}

export function verifyTotpToken(token: string): { sub: string } | null {
  try {
    const decoded = jwt.verify(token, config.session.jwtSecret, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE_TOTP,
    });
    if (typeof decoded === "string") return null;
    const { sub } = decoded as Record<string, unknown>;
    return typeof sub === "string" ? { sub } : null;
  } catch {
    return null;
  }
}

/**
 * Devolve o payload ou null. Nunca lanca: token invalido e o caso comum
 * (expirou, veio torto), nao excecao.
 *
 * `algorithms` fixo em HS256 fecha o ataque de confusao de algoritmo, em que
 * o atacante troca o alg do header por "none" ou por RS256 com chave publica.
 */
export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.session.jwtSecret, {
      algorithms: ["HS256"],
      issuer: ISSUER,
      audience: AUDIENCE,
    });

    if (typeof decoded === "string") return null;
    const { sub, adr, sid } = decoded as Record<string, unknown>;
    if (typeof sub !== "string" || typeof adr !== "string" || typeof sid !== "string") return null;

    return { sub, adr, sid };
  } catch {
    return null;
  }
}
