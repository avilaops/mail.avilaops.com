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

/**
 * Daqui para baixo: zonas de CLIENTE que estao na conta da casa.
 *
 * A Global Key enxerga todas as zonas da conta, entao o painel consegue
 * publicar os registros do dominio no lugar de quem cadastrou. So precisa de
 * e-mail e chave; `zoneId` continua valendo apenas para a nossa zona.
 */
export function cloudflareComCredencial(): boolean {
  return Boolean(config.cloudflare.email && config.cloudflare.globalKey);
}

export interface RegistroCloudflare {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
}

const TEMPO_LIMITE_MS = 10_000;

async function chamar<T>(caminho: string, init: { method?: string; body?: string } = {}): Promise<T> {
  const r = await fetch(`${API}${caminho}`, { ...init, headers: headers(), signal: AbortSignal.timeout(TEMPO_LIMITE_MS) });
  const d = (await r.json()) as Resposta<T>;
  if (!d.success) throw new Error(d.errors?.[0]?.message ?? `Cloudflare respondeu ${r.status}`);
  return d.result;
}

/** Id da zona com exatamente este nome, se a conta da casa a enxerga. */
export async function zonaPorNome(dominio: string): Promise<string | null> {
  if (!cloudflareComCredencial()) return null;
  const zonas = await chamar<{ id: string; name: string }[]>(`/zones?name=${encodeURIComponent(dominio)}`);
  return zonas.find((z) => z.name.toLowerCase() === dominio.toLowerCase())?.id ?? null;
}

/** Todos os registros com este nome completo, de qualquer tipo. */
export async function registrosDoNome(zoneId: string, nome: string): Promise<RegistroCloudflare[]> {
  return chamar<RegistroCloudflare[]>(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(nome)}&per_page=100`);
}

export interface RegistroNovo {
  type: "MX" | "TXT" | "CNAME";
  name: string;
  content: string;
  priority?: number;
}

function corpo(r: RegistroNovo): string {
  return JSON.stringify({
    type: r.type,
    name: r.name,
    content: r.content,
    ttl: 1,
    ...(r.type === "MX" ? { priority: r.priority ?? 10 } : {}),
    // CNAME de DKIM nunca passa pelo proxy: o verificador precisa do alvo de verdade.
    ...(r.type === "CNAME" ? { proxied: false } : {}),
    comment: "Avila Mail",
  });
}

export async function criarRegistro(zoneId: string, r: RegistroNovo): Promise<void> {
  await chamar(`/zones/${zoneId}/dns_records`, { method: "POST", body: corpo(r) });
}

export async function atualizarRegistro(zoneId: string, id: string, r: RegistroNovo): Promise<void> {
  await chamar(`/zones/${zoneId}/dns_records/${id}`, { method: "PUT", body: corpo(r) });
}

export async function apagarRegistro(zoneId: string, id: string): Promise<void> {
  await chamar(`/zones/${zoneId}/dns_records/${id}`, { method: "DELETE" });
}
