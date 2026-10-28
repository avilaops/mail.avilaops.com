import { NextResponse, type NextRequest } from "next/server";
import { chamarApi } from "@/lib/api";
import { lerAvisoAuth } from "@/lib/corpoAvisoAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Back-channel do Auth: autenticacao por assinatura, sem sessao do navegador. */
export async function POST(request: NextRequest) {
  const corpo = await lerAvisoAuth(request, "application/x-www-form-urlencoded");
  if (!corpo.ok) return corpo.resposta;
  const token = new URLSearchParams(corpo.texto).get("logout_token");
  if (!token || token.length > 8192) return NextResponse.json({ erro: "Aviso invalido." }, { status: 400 });
  const resposta = await chamarApi("/auth/sso/logout", { method: "POST", body: { logoutToken: token } });
  return NextResponse.json(resposta.ok ? { ok: true } : { erro: resposta.erro }, {
    status: resposta.status, headers: { "Cache-Control": "no-store" },
  });
}
