import { NextResponse, type NextRequest } from "next/server";
import { chamarApi, origemDaRequisicao } from "@/lib/api";
import { gravarSessao } from "@/lib/sessao";
import { authBase, oidcAtivo, ssoAtivo, tokenSso, urlLoginSso, webmailBase } from "@/lib/sso";
import { destinoMail } from "@/lib/destinoMail";

/**
 * Ingestao da sessao do SSO.
 *
 * `auth.avilaops.com` manda o navegador para ca depois do login. Com o cookie
 * `avila_sso` em maos, pedimos a API uma sessao de caixa. Uma caixa: entra
 * direto. Varias: manda para o seletor. Nenhuma: volta ao /entrar explicando.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RespostaLogin {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  mailbox: { id: string; address: string; displayName: string | null; mustChangePassword?: boolean };
}
interface RespostaEscolha {
  choose: { address: string; displayName: string | null }[];
}

export async function GET(request: NextRequest) {
  // Nunca derivar de `request.nextUrl`: atras do proxy o host e o interno
  // (localhost:3041) e o Location sairia apontando para a maquina do usuario.
  const base = webmailBase();
  const destino = destinoMail(request.nextUrl.searchParams.get("returnTo"));
  const retorno = new URLSearchParams({ returnTo: destino });
  if (!ssoAtivo()) return NextResponse.redirect(`${base}/entrar?local=1&${retorno}`);

  if (oidcAtivo() && request.nextUrl.searchParams.has("code")) {
    const jar = await (await import("next/headers")).cookies();
    const bruto = jar.get("mail_oidc_flow")?.value;
    jar.set("mail_oidc_flow", "", { httpOnly: true, secure: request.nextUrl.protocol === "https:", sameSite: "lax", path: "/", maxAge: 0 });
    let fluxo: { state: string; nonce: string; verifier: string; destino: string; exp: number } | null = null;
    try { fluxo = bruto ? JSON.parse(bruto) : null; } catch { fluxo = null; }
    const code = request.nextUrl.searchParams.get("code") ?? "";
    const state = request.nextUrl.searchParams.get("state") ?? "";
    if (!fluxo || fluxo.exp <= Date.now() || fluxo.state !== state || !code || request.nextUrl.searchParams.get("error")) {
      return NextResponse.redirect(`${base}/entrar?erro=sso_invalido&${retorno}`);
    }
    const clientId = process.env.AUTH_CLIENT_ID?.trim();
    const clientSecret = process.env.AUTH_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) return NextResponse.redirect(`${base}/entrar?erro=sso_invalido&${retorno}`);
    const respostaToken = await fetch(`${authBase()}/oauth/token`, { method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(8000),
      headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}` },
      body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${base}/api/sessao/sso`, code_verifier: fluxo.verifier }) });
    const tokens = await respostaToken.json().catch(() => null) as { access_token?: string; id_token?: string } | null;
    if (!respostaToken.ok || !tokens?.access_token) return NextResponse.redirect(`${base}/entrar?erro=sso_invalido&${retorno}`);
    if (!tokens.id_token || !idTokenNonce(tokens.id_token, fluxo.nonce)) return NextResponse.redirect(`${base}/entrar?erro=sso_invalido&${retorno}`);
    const resposta = await chamarApi<RespostaLogin | RespostaEscolha>("/auth/oidc", { method: "POST", body: { accessToken: tokens.access_token }, origem: origemDaRequisicao(request) });
    if (!resposta.ok || !resposta.dados) return NextResponse.redirect(`${base}/entrar?erro=${resposta.status === 404 ? "sem_caixa" : "sso_invalido"}&${retorno}`);
    if ("choose" in resposta.dados) return NextResponse.redirect(`${base}/entrar/caixas?${retorno}`);
    const trocar = resposta.dados.mailbox.mustChangePassword === true;
    await gravarSessao(resposta.dados, { precisaTrocarSenha: trocar });
    return NextResponse.redirect(trocar ? `${base}/definir-senha?${retorno}` : `${base}${fluxo.destino}`);
  }

  const token = await tokenSso();
  if (!token) return NextResponse.redirect(urlLoginSso(destino));

  const address = request.nextUrl.searchParams.get("address") ?? undefined;
  const resposta = await chamarApi<RespostaLogin | RespostaEscolha>("/auth/sso", {
    method: "POST",
    body: { ssoToken: token, address },
    // Quem entra pelo SSO tambem merece aparecer como o proprio aparelho.
    origem: origemDaRequisicao(request),
  });

  if (!resposta.ok || !resposta.dados) {
    if (resposta.codigo === "sso_reauth_required") return NextResponse.redirect(`${base}/api/sessao/sso/reautenticar?${retorno}`);
    if (resposta.status === 428) return NextResponse.redirect(urlLoginSso(destino));
    const motivo = resposta.status === 404 ? "sem_caixa" : resposta.status === 403 ? "caixa_indisponivel" : "sso_invalido";
    const q = new URLSearchParams({ erro: motivo, returnTo: destino });
    if (resposta.erro) q.set("detalhe", resposta.erro);
    return NextResponse.redirect(`${base}/entrar?${q}`);
  }

  if ("choose" in resposta.dados) {
    return NextResponse.redirect(`${base}/entrar/caixas?${retorno}`);
  }

  const trocar = resposta.dados.mailbox.mustChangePassword === true;
  await gravarSessao(resposta.dados, { precisaTrocarSenha: trocar });
  return NextResponse.redirect(trocar ? `${base}/definir-senha?${retorno}` : `${base}${destino}`);
}

function idTokenNonce(token: string, nonce: string): boolean {
  try {
    const partes = token.split(".");
    if (partes.length !== 3) return false;
    const payload = JSON.parse(Buffer.from(partes[1]!, "base64url").toString("utf8")) as { nonce?: unknown };
    return payload.nonce === nonce;
  } catch { return false; }
}
