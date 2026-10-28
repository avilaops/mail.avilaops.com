import { NextResponse, type NextRequest } from "next/server";
import { chamarApi } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Back-channel do Auth: autenticacao por assinatura, sem sessao do navegador. */
export async function POST(request: NextRequest) {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return NextResponse.json({ erro: "Formato de aviso invalido." }, { status: 415 });
  }
  const leitor = request.body?.getReader();
  if (!leitor) return NextResponse.json({ erro: "Aviso ausente." }, { status: 400 });
  const partes: Uint8Array[] = [];
  let tamanho = 0;
  try {
    while (true) {
      const parte = await leitor.read();
      if (parte.done) break;
      tamanho += parte.value.byteLength;
      if (tamanho > 12_000) {
        await leitor.cancel();
        return NextResponse.json({ erro: "Aviso muito grande." }, { status: 413 });
      }
      partes.push(parte.value);
    }
  } catch {
    return NextResponse.json({ erro: "Aviso incompleto." }, { status: 400 });
  } finally {
    leitor.releaseLock();
  }
  const texto = Buffer.concat(partes).toString("utf8");
  const token = new URLSearchParams(texto).get("logout_token");
  if (!token || token.length > 8192) return NextResponse.json({ erro: "Aviso invalido." }, { status: 400 });
  const resposta = await chamarApi("/auth/sso/logout", { method: "POST", body: { logoutToken: token } });
  return NextResponse.json(resposta.ok ? { ok: true } : { erro: resposta.erro }, {
    status: resposta.status, headers: { "Cache-Control": "no-store" },
  });
}
