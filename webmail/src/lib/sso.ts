import { cookies } from "next/headers";
import { destinoMail } from "./destinoMail";

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

export function authBase(): string {
  return (process.env.AUTH_URL ?? "https://auth.avilaops.com").replace(/\/$/, "");
}

/** Base publica do webmail — atras do Caddy, `request.nextUrl.origin` e localhost:3041. */
export function webmailBase(): string {
  return (process.env.WEBMAIL_URL ?? "https://mail.avilaops.com").replace(/\/$/, "");
}

export function oidcAtivo(): boolean {
  return Boolean(process.env.AUTH_CLIENT_ID?.trim() && process.env.AUTH_CLIENT_SECRET?.trim());
}

/** URL da tela do auth que volta para a rota de ingestao daqui. */
export function urlLoginSso(destino = "/caixa"): string {
  if (oidcAtivo()) {
    const q = new URLSearchParams({ returnTo: destinoMail(destino) });
    return `${webmailBase()}/api/sessao/oidc/iniciar?${q}`;
  }
  const callback = new URL(`${webmailBase()}/api/sessao/sso`);
  if (destinoMail(destino) !== "/caixa") callback.searchParams.set("returnTo", destinoMail(destino));
  const q = new URLSearchParams({ app: "mail", returnTo: callback.href });
  return `${authBase()}/login?${q}`;
}

/**
 * Logout global do auth: derruba o cookie de `.avilaops.com`, e com ele a
 * sessao em todos os subdominios. Volta para a tela de entrar do webmail, ja
 * deslogado — sem `local=1`, cairia no SSO de novo e reentraria sozinho.
 */
export function urlLogoutSso(): string {
  const retorno = `${webmailBase()}/entrar?local=1`;
  const q = new URLSearchParams({ app: "mail", returnTo: retorno, post_logout_redirect_uri: retorno });
  const clientId = process.env.AUTH_CLIENT_ID?.trim();
  if (clientId) q.set("client_id", clientId);
  return `${authBase()}/api/auth/logout?${q}`;
}

export async function tokenSso(): Promise<string | null> {
  return (await cookies()).get(COOKIE_SSO)?.value ?? null;
}
