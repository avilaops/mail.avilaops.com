import { NextResponse } from "next/server";
import { ssoAtivo, urlLoginSso, webmailBase } from "@/lib/sso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!ssoAtivo()) return NextResponse.redirect(`${webmailBase()}/entrar?local=1`);
  // Auth publica iat/event_timestamp em segundos. Apos o POST de logout do
  // emissor, cruzar essa fronteira evita repetir uma prova temporal ambigua.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const resposta = NextResponse.redirect(urlLoginSso());
  resposta.headers.set("Cache-Control", "no-store");
  return resposta;
}
