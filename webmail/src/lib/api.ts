import { gravarSessao, tokenDeAcesso, tokenDeRefresh } from "@/lib/sessao";

/**
 * Cliente da API do servidor de e-mail — roda so no servidor.
 *
 * A URL aponta para loopback: a API nunca e exposta na internet, e o webmail
 * fala com ela pela rede local do proprio host.
 */

const BASE = process.env.MAIL_API_URL ?? "http://127.0.0.1:3040/v1";

export interface RespostaApi<T> {
  ok: boolean;
  status: number;
  dados: T | null;
  erro: string | null;
}

async function interpretar<T>(resposta: Response): Promise<RespostaApi<T>> {
  const texto = await resposta.text();
  let corpo: unknown = null;

  if (texto) {
    try {
      corpo = JSON.parse(texto);
    } catch {
      corpo = null;
    }
  }

  if (!resposta.ok) {
    const mensagem =
      corpo && typeof corpo === "object" && "error" in corpo
        ? String((corpo as { error?: { message?: string } }).error?.message ?? "Erro na requisicao.")
        : "Erro na requisicao.";
    return { ok: false, status: resposta.status, dados: null, erro: mensagem };
  }

  return { ok: true, status: resposta.status, dados: corpo as T, erro: null };
}

/**
 * Quem esta do outro lado do navegador.
 *
 * Sem isto, a API so enxerga o processo do webmail: IP 127.0.0.1 e User-Agent
 * "node" — e a tela de aparelhos conectados vira uma lista de "node" que nao
 * responde a unica pergunta dela ("esse acesso sou eu?"). O IP real vem do
 * `x-forwarded-for` que o Caddy carimba; o User-Agent, do proprio navegador.
 */
export interface OrigemCliente {
  ip?: string | null;
  userAgent?: string | null;
}

/** Extrai a origem de uma requisicao do Next (Request/NextRequest). */
export function origemDaRequisicao(request: { headers: Headers }): OrigemCliente {
  const encaminhado = request.headers.get("x-forwarded-for");
  return {
    ip: encaminhado?.split(",")[0]?.trim() || request.headers.get("x-real-ip"),
    userAgent: request.headers.get("user-agent"),
  };
}

export async function chamarApi<T>(
  caminho: string,
  opcoes: { method?: string; body?: unknown; token?: string | null; origem?: OrigemCliente } = {},
): Promise<RespostaApi<T>> {
  const cabecalhos: Record<string, string> = { Accept: "application/json" };
  if (opcoes.token) cabecalhos.Authorization = `Bearer ${opcoes.token}`;
  if (opcoes.body !== undefined) cabecalhos["Content-Type"] = "application/json";
  if (opcoes.origem?.ip) cabecalhos["x-forwarded-for"] = opcoes.origem.ip;
  if (opcoes.origem?.userAgent) cabecalhos["user-agent"] = opcoes.origem.userAgent;

  try {
    const resposta = await fetch(`${BASE}${caminho}`, {
      method: opcoes.method ?? "GET",
      headers: cabecalhos,
      body: opcoes.body === undefined ? undefined : JSON.stringify(opcoes.body),
      cache: "no-store",
      // 60s: operacoes de senha fazem bcrypt, que sob carga no host pode passar
      // de 30s. Melhor esperar que abortar e deixar a caixa a meio caminho.
      signal: AbortSignal.timeout(60_000),
    });

    return interpretar<T>(resposta);
  } catch (error) {
    const motivo = error instanceof Error ? error.message : String(error);
    return { ok: false, status: 502, dados: null, erro: `Servidor de e-mail indisponivel (${motivo}).` };
  }
}

/**
 * Chamada autenticada com renovacao automatica.
 *
 * O token de acesso vale 15 minutos. Sem esta renovacao transparente, o
 * cliente seria jogado para a tela de login no meio da leitura, a cada 15
 * minutos — o jeito mais rapido de fazer um webmail parecer quebrado.
 */
export async function chamarComSessao<T>(
  caminho: string,
  opcoes: { method?: string; body?: unknown; origem?: OrigemCliente } = {},
): Promise<RespostaApi<T>> {
  const acesso = await tokenDeAcesso();

  if (acesso) {
    const resposta = await chamarApi<T>(caminho, { ...opcoes, token: acesso });
    if (resposta.status !== 401) return resposta;
  }

  const refresh = await tokenDeRefresh();
  if (!refresh) return { ok: false, status: 401, dados: null, erro: "Sessao encerrada." };

  const renovada = await chamarApi<{ accessToken: string; refreshToken: string; expiresInSeconds: number }>(
    "/auth/refresh",
    { method: "POST", body: { refreshToken: refresh } },
  );

  if (!renovada.ok || !renovada.dados) {
    return { ok: false, status: 401, dados: null, erro: "Sessao encerrada." };
  }

  await gravarSessao(renovada.dados);
  return chamarApi<T>(caminho, { ...opcoes, token: renovada.dados.accessToken });
}

/**
 * Igual a `chamarComSessao`, mas devolve a Response crua.
 *
 * Anexo e .eml voltam como binario com os proprios cabecalhos de seguranca
 * (`Content-Disposition: attachment`, `nosniff`, CSP `sandbox`). Interpretar
 * isso como JSON corromperia o arquivo e, pior, perderia justamente os
 * cabecalhos que impedem um anexo HTML de executar na origem do webmail.
 */
export async function chamarBrutoComSessao(
  caminho: string,
  opcoes: { semTempoLimite?: boolean } = {},
): Promise<Response | null> {
  const buscar = async (token: string) =>
    fetch(`${BASE}${caminho}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      // Fluxo de eventos fica aberto por minutos de proposito; um tempo limite
      // aqui o mataria no meio e o cliente veria a conexao cair sozinha.
      signal: opcoes.semTempoLimite ? undefined : AbortSignal.timeout(60_000),
    });

  const acesso = await tokenDeAcesso();

  if (acesso) {
    const resposta = await buscar(acesso).catch(() => null);
    if (resposta && resposta.status !== 401) return resposta;
  }

  const refresh = await tokenDeRefresh();
  if (!refresh) return null;

  const renovada = await chamarApi<{ accessToken: string; refreshToken: string; expiresInSeconds: number }>(
    "/auth/refresh",
    { method: "POST", body: { refreshToken: refresh } },
  );

  if (!renovada.ok || !renovada.dados) return null;

  await gravarSessao(renovada.dados);
  return buscar(renovada.dados.accessToken).catch(() => null);
}
