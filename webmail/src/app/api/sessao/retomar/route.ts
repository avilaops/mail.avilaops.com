import { NextResponse, type NextRequest } from "next/server";
import { chamarComSessao, origemDaRequisicao } from "@/lib/api";
import { limparSessao } from "@/lib/sessao";
import { webmailBase } from "@/lib/sso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Ponte de migracao: o refresh antigo so acompanha /api/sessao. */
export async function GET(request: NextRequest) {
  const base = webmailBase();
  const pedido = request.nextUrl.searchParams.get("returnTo") ?? "/caixa";
  const destino = new URL(pedido, base);
  const permitido = destino.origin === new URL(base).origin &&
    ["/caixa", "/conta", "/admin", "/agenda", "/definir-senha"].includes(destino.pathname);
  const resposta = await chamarComSessao("/me", { origem: origemDaRequisicao(request) });
  if (resposta.ok) return NextResponse.redirect(permitido ? destino : new URL("/caixa", base));
  if (resposta.status === 409) return NextResponse.redirect(new URL("/definir-senha", base));
  if (resposta.status === 401) {
    await limparSessao();
    return NextResponse.redirect(new URL("/entrar", base));
  }
  return NextResponse.json({ erro: "Nao foi possivel restaurar sua sessao. Tente novamente." }, {
    status: resposta.status, headers: { "Cache-Control": "no-store", "Retry-After": "5" },
  });
}
