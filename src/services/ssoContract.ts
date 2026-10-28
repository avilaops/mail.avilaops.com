import jwt from "jsonwebtoken";
import { AuthError } from "./authError.js";

export interface IdentidadeSso {
  subject: string;
  email: string;
  issuedAt: Date;
  expiresAt: Date;
}

export function authBase(): string {
  return (process.env.MAIL_AUTH_URL ?? "https://auth.avilaops.com").replace(/\/$/, "");
}

/** O cookie compartilhado tem finalidade e emissor distintos dos tokens OIDC. */
export function identidadeSso(token: string): IdentidadeSso {
  const segredo = process.env.SSO_JWT_SECRET ?? "";
  if (segredo.length < 32) throw new AuthError("Login pelo SSO nao esta habilitado.", 503);
  try {
    const dados = jwt.verify(token, segredo, { algorithms: ["HS256"], issuer: "auth.avilaops.com" });
    if (typeof dados === "string" || typeof dados.sub !== "string" || !dados.sub || dados.sub.length > 200 ||
        typeof dados.email !== "string" || !dados.email || typeof dados.iat !== "number" ||
        typeof dados.exp !== "number" || !Number.isSafeInteger(dados.iat) || !Number.isSafeInteger(dados.exp) ||
        dados.iat > Date.now() / 1000 + 30 || dados.exp <= dados.iat ||
        dados.aud !== undefined || dados.token_use !== undefined) throw new Error("claims invalidos");
    return { subject: dados.sub, email: dados.email.trim().toLowerCase(),
      issuedAt: new Date(dados.iat * 1000), expiresAt: new Date(dados.exp * 1000) };
  } catch {
    throw new AuthError("Sessao do SSO invalida ou expirada.");
  }
}

/**
 * O gate ja usado pelo navegador e o dono da politica de acesso e de MFA.
 * Nao interpretar HTML nem copiar a politica: somente o retorno exato ao Mail
 * comprova que o Auth autorizou a sessao. Outros redirects nunca sao seguidos.
 */
export async function conferirPoliticaSso(token: string): Promise<void> {
  const base = authBase();
  const retorno = `${(process.env.WEBMAIL_URL ?? "https://mail.avilaops.com").replace(/\/$/, "")}/api/sessao/sso`;
  const destino = new URL("/login", base);
  destino.search = new URLSearchParams({ app: "mail", returnTo: retorno }).toString();
  let resposta: Response;
  try {
    resposta = await fetch(destino, { headers: { Cookie: `avila_sso=${token}` },
      redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(3000) });
  } catch {
    throw new AuthError("Login unico temporariamente indisponivel. Tente novamente.", 503);
  }
  await resposta.body?.cancel();
  if (resposta.status >= 500 || resposta.status === 429) {
    throw new AuthError("Login unico temporariamente indisponivel. Tente novamente.", 503);
  }
  const local = resposta.headers.get("location");
  if ([302, 303, 307, 308].includes(resposta.status) && local) {
    const url = new URL(local, base);
    if (url.href === retorno) return;
    if (url.origin === new URL(base).origin && url.pathname === "/api/auth/mfa/elevar") {
      throw new AuthError("Confirme o segundo fator no login unico.", 428);
    }
  }
  throw new AuthError("Sua conta nao tem acesso ao Mail no login unico.", 403);
}
