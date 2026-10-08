import { NextResponse, type NextRequest } from "next/server";
import { chamarApi, origemDaRequisicao } from "@/lib/api";
import { gravarSessao } from "@/lib/sessao";
import { ssoAtivo, tokenSso, urlLoginSso, webmailBase } from "@/lib/sso";

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
  if (!ssoAtivo()) return NextResponse.redirect(`${base}/entrar?local=1`);

  const token = await tokenSso();
  if (!token) return NextResponse.redirect(urlLoginSso());

  const address = request.nextUrl.searchParams.get("address") ?? undefined;
  const resposta = await chamarApi<RespostaLogin | RespostaEscolha>("/auth/sso", {
    method: "POST",
    body: { ssoToken: token, address },
    // Quem entra pelo SSO tambem merece aparecer como o proprio aparelho.
    origem: origemDaRequisicao(request),
  });

  if (!resposta.ok || !resposta.dados) {
    const motivo = resposta.status === 404 ? "sem_caixa" : resposta.status === 403 ? "caixa_indisponivel" : "sso_invalido";
    const q = new URLSearchParams({ erro: motivo });
    if (resposta.erro) q.set("detalhe", resposta.erro);
    return NextResponse.redirect(`${base}/entrar?${q}`);
  }

  if ("choose" in resposta.dados) {
    return NextResponse.redirect(`${base}/entrar/caixas`);
  }

  const trocar = resposta.dados.mailbox.mustChangePassword === true;
  await gravarSessao(resposta.dados, { precisaTrocarSenha: trocar });
  return NextResponse.redirect(`${base}/${trocar ? "definir-senha" : "caixa"}`);
}
