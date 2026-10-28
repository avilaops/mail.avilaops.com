import { NextResponse, type NextRequest } from "next/server";
import { ssoAtivo, urlLoginSso, webmailBase } from "@/lib/sso";
import { caminhoEntrar, destinoMail } from "@/lib/destinoMail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const destino = destinoMail(request.nextUrl.searchParams.get("returnTo"));
  if (!ssoAtivo()) return NextResponse.redirect(`${webmailBase()}${caminhoEntrar(destino, true)}`);
  // Auth publica iat/event_timestamp em segundos. Apos o POST de logout do
  // emissor, cruzar essa fronteira evita repetir uma prova temporal ambigua.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const resposta = NextResponse.redirect(urlLoginSso(destino));
  resposta.headers.set("Cache-Control", "no-store");
  return resposta;
}
