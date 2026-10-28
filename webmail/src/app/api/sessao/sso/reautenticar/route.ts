import { NextResponse, type NextRequest } from "next/server";
import { ssoAtivo, urlLogoutSso, webmailBase } from "@/lib/sso";
import { caminhoEntrar, destinoMail } from "@/lib/destinoMail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** O usuario confirma o logout global: visitar esta pagina nao o executa. */
export async function GET(request: NextRequest) {
  const retorno = destinoMail(request.nextUrl.searchParams.get("returnTo"));
  if (!ssoAtivo()) return NextResponse.redirect(`${webmailBase()}${caminhoEntrar(retorno, true)}`);
  const destino = new URL(urlLogoutSso());
  destino.searchParams.set("returnTo", `${webmailBase()}/api/sessao/sso/novo-login?${new URLSearchParams({ returnTo: retorno })}`);
  const acao = destino.href.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Confirme seu acesso</title></head>
<body style="font:16px system-ui;max-width:34rem;margin:10vh auto;padding:24px;line-height:1.6">
<h1>Confirme seu acesso</h1><p>Houve uma alteracao na seguranca da conta. Para abrir o Mail, entre novamente pelo login unico.</p>
<p>Ao continuar, a sessao anterior do login unico sera encerrada tambem nos outros aplicativos.</p>
<form method="POST" action="${acao}"><button type="submit" style="font:inherit;padding:12px 16px">Encerrar sessao anterior e entrar novamente</button></form>
<p><a href="${caminhoEntrar(retorno, true).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">Entrar com a senha da caixa</a></p></body></html>`;
  return new NextResponse(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${destino.origin}; frame-ancestors 'none'; base-uri 'none'` } });
}
