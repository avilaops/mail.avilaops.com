import { NextResponse, type NextRequest } from "next/server";
import { chamarApi } from "@/lib/api";
import { lerAvisoAuth } from "@/lib/corpoAvisoAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Entrega push SSF (RFC 8935) do transmissor Auth existente. */
export async function POST(request: NextRequest) {
  const corpo = await lerAvisoAuth(request, "application/secevent+jwt");
  if (!corpo.ok) return corpo.resposta;
  const token = corpo.texto.trim();
  if (!token || token.length > 8192) return NextResponse.json({ erro: "Sinal invalido." }, { status: 400 });
  const resposta = await chamarApi("/auth/sso/events", { method: "POST", body: { securityEventToken: token } });
  return NextResponse.json(resposta.ok ? {} : { erro: resposta.erro }, {
    status: resposta.ok ? 202 : resposta.status, headers: { "Cache-Control": "no-store" },
  });
}
