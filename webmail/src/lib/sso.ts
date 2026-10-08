import { cookies } from "next/headers";

/**
 * Integracao com o login unico (auth.avilaops.com).
 *
 * O cookie `avila_sso` e gravado em `.avilaops.com` pelo auth server e chega
 * aqui sozinho. O webmail nao valida o JWT: repassa para a API do e-mail, que
 * tem o segredo compartilhado e decide qual caixa a pessoa pode abrir.
 */

const COOKIE_SSO = "avila_sso";

export function ssoAtivo(): boolean {
  return process.env.SSO_ENABLED === "true";
}

function authBase(): string {
  return (process.env.AUTH_URL ?? "https://auth.avilaops.com").replace(/\/$/, "");
}

/** Base publica do webmail — atras do Caddy, `request.nextUrl.origin` e localhost:3041. */
export function webmailBase(): string {
  return (process.env.WEBMAIL_URL ?? "https://mail.avilaops.com").replace(/\/$/, "");
}

/** URL da tela do auth que volta para a rota de ingestao daqui. */
export function urlLoginSso(): string {
  const q = new URLSearchParams({ app: "mail", returnTo: `${webmailBase()}/api/sessao/sso` });
  return `${authBase()}/login?${q}`;
}

/**
 * Logout global do auth: derruba o cookie de `.avilaops.com`, e com ele a
 * sessao em todos os subdominios. Volta para a tela de entrar do webmail, ja
 * deslogado — sem `local=1`, cairia no SSO de novo e reentraria sozinho.
 */
export function urlLogoutSso(): string {
  const q = new URLSearchParams({ app: "mail", returnTo: `${webmailBase()}/entrar?local=1` });
  return `${authBase()}/api/auth/logout?${q}`;
}

export async function tokenSso(): Promise<string | null> {
  return (await cookies()).get(COOKIE_SSO)?.value ?? null;
}
