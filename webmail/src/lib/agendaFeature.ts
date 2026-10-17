import { tokenDeAcesso } from "@/lib/sessao";

export async function agendaDisponivel(): Promise<boolean> {
  const modo = (process.env.AGENDA_ENABLED ?? "false").toLowerCase();
  if (modo === "true" || modo === "all") return true;
  if (modo !== "internal") return false;
  const token = await tokenDeAcesso();
  if (!token) return false;
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { adr?: unknown };
    const dominio = typeof payload.adr === "string" ? payload.adr.split("@").at(-1)?.toLowerCase() : undefined;
    const internos = (process.env.AGENDA_INTERNAL_DOMAINS ?? "avilaops.com").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
    return dominio !== undefined && internos.includes(dominio);
  } catch { return false; }
}
