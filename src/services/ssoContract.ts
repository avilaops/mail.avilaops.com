import { AuthError } from "./authError.js";

export interface IdentidadeSso {
  subject: string;
  email: string;
  issuedAt: Date;
  expiresAt: Date;
  apps?: string[];
}

export function authBase(): string {
  return (process.env.MAIL_AUTH_URL ?? "https://auth.avilaops.com").replace(/\/$/, "");
}

/** Valida um access token OIDC no userinfo do emissor central. */
export async function identidadeOidc(accessToken: string): Promise<IdentidadeSso & { token: string }> {
  if (!accessToken || accessToken.length > 8192) throw new AuthError("Token OIDC invalido.", 401);
  let resposta: Response;
  try {
    resposta = await fetch(`${authBase()}/oauth/userinfo`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(3000),
    });
  } catch { throw new AuthError("Login unico temporariamente indisponivel. Tente novamente.", 503); }
  if (resposta.status === 401 || resposta.status === 403) throw new AuthError("Token OIDC recusado pelo Auth.", 401);
  if (!resposta.ok) throw new AuthError("Login unico temporariamente indisponivel. Tente novamente.", 503);
  const dados = await resposta.json().catch(() => null) as { sub?: unknown; email?: unknown; email_verified?: unknown; apps?: unknown } | null;
  if (!dados || typeof dados.sub !== "string" || !dados.sub || dados.sub.length > 200 ||
      typeof dados.email !== "string" || !dados.email || dados.email.length > 320 || dados.email_verified === false) {
    throw new AuthError("Resposta OIDC invalida.", 401);
  }
  const agora = new Date();
  const apps = Array.isArray(dados.apps) ? dados.apps.filter((app): app is string => typeof app === "string" && app.length <= 100) : undefined;
  return { subject: dados.sub, email: dados.email.trim().toLowerCase(), issuedAt: agora, expiresAt: new Date(agora.getTime() + 55 * 60_000), apps, token: accessToken };
}

/** Consulta o cookie no Auth; o Mail não valida JWT nem guarda segredo do emissor. */
export async function identidadeSso(token: string): Promise<IdentidadeSso> {
  if (!token || token.length > 8192) throw new AuthError("Sessao do SSO invalida ou expirada.");
  let resposta: Response;
  try {
    resposta = await fetch(`${authBase()}/api/session?app=mail`, {
      headers: { Cookie: `avila_sso=${token}`, accept: "application/json" },
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(3000),
    });
  } catch { throw new AuthError("Login unico temporariamente indisponivel. Tente novamente.", 503); }
  if (!resposta.ok) throw new AuthError("Sessao do SSO invalida ou expirada.");
  const dados = await resposta.json().catch(() => null) as { autenticado?: unknown; permitido?: unknown; sessao?: { sub?: unknown; email?: unknown; iat?: unknown; exp?: unknown } } | null;
  if (dados?.autenticado !== true || dados.permitido !== true || typeof dados.sessao?.sub !== "string" || typeof dados.sessao.email !== "string") {
    throw new AuthError("Sua conta nao tem acesso ao Mail no login unico.", 403);
  }
  const agora = new Date();
  const issuedAt = typeof dados.sessao.iat === "number" && Number.isSafeInteger(dados.sessao.iat)
    ? new Date(dados.sessao.iat * 1000)
    : agora;
  const expiresAt = typeof dados.sessao.exp === "number" && Number.isSafeInteger(dados.sessao.exp) && dados.sessao.exp * 1000 > agora.getTime()
    ? new Date(dados.sessao.exp * 1000)
    : new Date(agora.getTime() + 55 * 60_000);
  return { subject: dados.sessao.sub, email: dados.sessao.email.trim().toLowerCase(), issuedAt, expiresAt };
}

/**
 * O gate ja usado pelo navegador e o dono da politica de acesso e de MFA.
 * Nao interpretar HTML nem copiar a politica: somente o retorno exato ao Mail
 * comprova que o Auth autorizou a sessao. Outros redirects nunca sao seguidos.
 */
export async function conferirPoliticaSso(token: string): Promise<void> {
  const base = authBase();
  const retorno = new URL("/api/sessao/sso", process.env.WEBMAIL_URL ?? "https://mail.avilaops.com").href;
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
