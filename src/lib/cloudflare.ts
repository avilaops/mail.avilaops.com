import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("cloudflare");

const API = "https://api.cloudflare.com/client/v4";

export function cloudflareConfigurado(): boolean {
  const { email, globalKey, zoneId } = config.cloudflare;
  return Boolean(email && globalKey && zoneId);
}

function headers(): Record<string, string> {
  return {
    "X-Auth-Email": config.cloudflare.email,
    "X-Auth-Key": config.cloudflare.globalKey,
    "Content-Type": "application/json",
  };
}

type Resposta<T> = { success: boolean; result: T; errors?: { code: number; message: string }[] };

/**
 * Cria ou atualiza um TXT na nossa zona.
 *
 * Idempotente de propósito: `createDomain` é chamado de novo quando o portal
 * reenvia o provisionamento, e um segundo TXT com o mesmo nome não substitui o
 * primeiro, convive com ele — dois DKIM para o mesmo seletor fazem o
 * verificador escolher um deles, e metade das mensagens falha a assinatura.
 */
export async function publicarTxt(input: {
  nome: string;
  valor: string;
  comentario?: string;
}): Promise<{ ok: true; criado: boolean } | { ok: false; motivo: string }> {
  if (!cloudflareConfigurado()) {
    return { ok: false, motivo: "cloudflare nao configurado" };
  }

  const { zoneId } = config.cloudflare;

  try {
    const busca = await fetch(
      `${API}/zones/${zoneId}/dns_records?type=TXT&name=${encodeURIComponent(input.nome)}`,
      { headers: headers() },
    );
    const encontrados = (await busca.json()) as Resposta<{ id: string; content: string }[]>;

    if (!encontrados.success) {
      const motivo = encontrados.errors?.[0]?.message ?? "erro ao consultar a zona";
      return { ok: false, motivo };
    }

    const existente = encontrados.result[0];
    const corpo = JSON.stringify({
      type: "TXT",
      name: input.nome,
      content: input.valor,
      ttl: 1,
      comment: input.comentario,
    });

    if (existente) {
      // Mesmo conteúdo: nada a fazer, e não gasta escrita na API.
      if (existente.content === input.valor) return { ok: true, criado: false };

      const r = await fetch(`${API}/zones/${zoneId}/dns_records/${existente.id}`, {
        method: "PUT",
        headers: headers(),
        body: corpo,
      });
      const d = (await r.json()) as Resposta<unknown>;
      if (!d.success) return { ok: false, motivo: d.errors?.[0]?.message ?? "erro ao atualizar" };
      return { ok: true, criado: false };
    }

    const r = await fetch(`${API}/zones/${zoneId}/dns_records`, {
      method: "POST",
      headers: headers(),
      body: corpo,
    });
    const d = (await r.json()) as Resposta<unknown>;
    if (!d.success) return { ok: false, motivo: d.errors?.[0]?.message ?? "erro ao criar" };
    return { ok: true, criado: true };
  } catch (erro) {
    log.warn("falha ao falar com a Cloudflare", { erro: String(erro) });
    return { ok: false, motivo: String(erro) };
  }
}
