import { NextResponse } from "next/server";
import { limparSessao } from "@/lib/sessao";
import { ssoAtivo, urlLogoutSso } from "@/lib/sso";

/**
 * Sair de verdade.
 *
 * Apagar so a sessao do webmail nao desloga ninguem: `/entrar` devolve para o
 * auth, que ainda tem o cookie de `.avilaops.com`, e a pessoa volta para a
 * caixa sem digitar nada. Quem reclamou primeiro foi a Luana, do vedashow, em
 * 09/09/2026 — clicava em Sair e continuava dentro.
 *
 * O logout do auth e POST de proposito (em GET, uma `<img>` em qualquer pagina
 * deslogaria a pessoa sem ela pedir), e redirecionar nao faz POST. Entao esta
 * rota devolve um formulario que se envia sozinho: o navegador faz o POST com
 * o cookie e segue o redirect do auth.
 *
 * Sem SSO, o caminho antigo continua valendo: sessao apagada e volta para a
 * tela de entrar.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  await limparSessao();

  if (!ssoAtivo()) {
    return NextResponse.redirect(new URL("/entrar?local=1", process.env.WEBMAIL_URL ?? "https://mail.avilaops.com"));
  }

  const destino = urlLogoutSso();
  // `noscript` para nao prender quem desligou o JavaScript: o botao faz o mesmo.
  const html = `<!doctype html>
<html lang="pt-BR">
<head><meta charset="utf-8"><title>Saindo…</title></head>
<body style="font:15px system-ui;padding:32px;color:#333">
<form id="sair" method="POST" action="${destino}">
  <noscript><p>Saindo da sua conta.</p><button type="submit">Continuar</button></noscript>
</form>
<p>Saindo…</p>
<script>document.getElementById("sair").submit();</script>
</body></html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
