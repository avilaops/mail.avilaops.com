import { randomBytes, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";

/**
 * Camada BFF de sessao.
 *
 * O token de acesso nunca chega ao JavaScript da pagina: fica em cookie
 * httpOnly e e injetado no servidor, aqui. Webmail renderiza HTML de terceiros
 * por definicao; se um vetor de XSS escapar da sanitizacao, token em
 * localStorage e lido por `document` e a conta inteira vai junto. Em cookie
 * httpOnly, o script simplesmente nao alcanca o valor.
 *
 * O preco disso e precisar de protecao CSRF, resolvida com duplo envio: um
 * cookie legivel pelo JS e o mesmo valor repetido num header. Pagina de outro
 * site consegue fazer o navegador mandar o cookie, mas nao consegue ler o
 * valor para montar o header.
 */

const COOKIE_ACESSO = "avila_mail_at";
// Nome novo: um cookie legado de Path=/api/sessao nao pode sombrear o novo.
const COOKIE_REFRESH = "avila_mail_rt_v2";
const COOKIE_REFRESH_LEGADO = "avila_mail_rt";
const COOKIE_CSRF = "avila_mail_csrf";
// Marca o primeiro acesso: enquanto existe, o dono ainda nao definiu a senha.
// A trava real e a API (409); este cookie so evita o flash de tela ao navegar.
const COOKIE_TROCAR = "avila_mail_trocar";

const CAMINHO_REFRESH = "/";

function seguro(): boolean {
  return process.env.COOKIE_SECURE !== "false";
}

export interface TokensSessao {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  refreshExpiresInSeconds?: number;
  mailbox?: { mustChangePassword?: boolean };
}

export async function gravarSessao(tokens: TokensSessao, opts: { precisaTrocarSenha?: boolean } = {}): Promise<string> {
  const jar = await cookies();
  // Requests concorrentes renovam o mesmo par: manter CSRF evita invalidar
  // uma mutacao cujo header foi montado antes de outra resposta de refresh.
  const csrf = jar.get(COOKIE_CSRF)?.value ?? randomBytes(32).toString("base64url");

  const base = {
    httpOnly: true,
    secure: seguro(),
    // Strict: o cookie nao acompanha navegacao vinda de outro site, o que
    // sozinho ja barra a maior parte dos ataques de CSRF.
    sameSite: "strict" as const,
    path: "/",
  };

  jar.set(COOKIE_ACESSO, tokens.accessToken, { ...base, maxAge: tokens.expiresInSeconds });

  // Paginas, SSE e downloads precisam receber a prova de continuidade.
  // Continua inacessivel ao JavaScript e restrito a este host.
  const duracao = tokens.refreshExpiresInSeconds ?? 30 * 86_400;
  jar.delete({ name: COOKIE_REFRESH_LEGADO, path: "/api/sessao" });
  jar.set(COOKIE_REFRESH, tokens.refreshToken, { ...base, path: CAMINHO_REFRESH, maxAge: duracao });

  // Este e o unico legivel pelo JS: e a metade do duplo envio que a pagina
  // precisa copiar para o header.
  jar.set(COOKIE_CSRF, csrf, { ...base, httpOnly: false, maxAge: duracao });

  if (opts.precisaTrocarSenha ?? tokens.mailbox?.mustChangePassword ?? jar.get(COOKIE_TROCAR)?.value === "1") {
    jar.set(COOKIE_TROCAR, "1", { ...base, maxAge: tokens.expiresInSeconds });
  } else {
    jar.delete(COOKIE_TROCAR);
  }

  return csrf;
}

export async function precisaTrocarSenha(): Promise<boolean> {
  return (await cookies()).get(COOKIE_TROCAR)?.value === "1";
}

export async function limparMarcaTrocarSenha(): Promise<void> {
  (await cookies()).delete(COOKIE_TROCAR);
}

export async function limparSessao(): Promise<void> {
  const jar = await cookies();
  jar.delete(COOKIE_ACESSO);
  jar.delete({ name: COOKIE_REFRESH, path: CAMINHO_REFRESH });
  jar.delete({ name: COOKIE_REFRESH_LEGADO, path: "/api/sessao" });
  jar.delete(COOKIE_CSRF);
  jar.delete(COOKIE_TROCAR);
}

export async function tokenDeAcesso(): Promise<string | null> {
  return (await cookies()).get(COOKIE_ACESSO)?.value ?? null;
}

export async function tokenDeRefresh(): Promise<string | null> {
  const jar = await cookies();
  return jar.get(COOKIE_REFRESH)?.value ?? jar.get(COOKIE_REFRESH_LEGADO)?.value ?? null;
}

export async function temSessao(): Promise<boolean> {
  return (await tokenDeAcesso()) !== null || (await tokenDeRefresh()) !== null;
}

function comparaSegura(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Duplo envio: o header precisa repetir o valor do cookie.
 *
 * So exigido em metodo que muda estado. GET nao altera nada, e cobrar token
 * nele quebraria navegacao normal sem ganho de seguranca.
 */
export function csrfValido(request: NextRequest): boolean {
  const metodo = request.method.toUpperCase();
  if (metodo === "GET" || metodo === "HEAD" || metodo === "OPTIONS") return true;

  const doCookie = request.cookies.get(COOKIE_CSRF)?.value ?? "";
  const doHeader = request.headers.get("x-csrf-token") ?? "";

  return doCookie.length > 0 && comparaSegura(doCookie, doHeader);
}

export const NOMES_COOKIE = {
  acesso: COOKIE_ACESSO,
  refresh: COOKIE_REFRESH,
  csrf: COOKIE_CSRF,
} as const;
