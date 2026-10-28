import { NextResponse, type NextRequest } from "next/server";

/** Limita tambem corpos chunked; verificar o tamanho depois de text() e tarde. */
export async function lerAvisoAuth(request: NextRequest, tipo: string): Promise<
  { ok: true; texto: string } | { ok: false; resposta: NextResponse }
> {
  const erro = (mensagem: string, status: number) => ({ ok: false as const,
    resposta: NextResponse.json({ erro: mensagem }, { status }) });
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== tipo) {
    return erro("Formato de aviso invalido.", 415);
  }
  const leitor = request.body?.getReader();
  if (!leitor) return erro("Aviso ausente.", 400);
  const partes: Uint8Array[] = [];
  let tamanho = 0;
  try {
    while (true) {
      const parte = await leitor.read();
      if (parte.done) break;
      tamanho += parte.value.byteLength;
      if (tamanho > 12_000) {
        await leitor.cancel();
        return erro("Aviso muito grande.", 413);
      }
      partes.push(parte.value);
    }
  } catch {
    return erro("Aviso incompleto.", 400);
  } finally {
    leitor.releaseLock();
  }
  return { ok: true, texto: Buffer.concat(partes).toString("utf8") };
}
