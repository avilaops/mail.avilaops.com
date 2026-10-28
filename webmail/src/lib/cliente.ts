"use client";

import type { AgendaCalendario, DadosEventoAgenda, EventoAgenda, PreferenciasAgenda } from "@/lib/tipos";

/**
 * Acesso a API a partir do navegador.
 *
 * Nunca carrega token: quem injeta o `Authorization` e o proxy no servidor,
 * lendo o cookie httpOnly. Aqui so viaja o token CSRF, que a pagina le do
 * cookie legivel e repete no header — a metade do duplo envio que uma pagina
 * de outro site nao consegue montar.
 */

export class ErroApi extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ErroApi";
  }
}

function tokenCsrf(): string {
  const encontrado = document.cookie
    .split(";")
    .map((parte) => parte.trim())
    .find((parte) => parte.startsWith("avila_mail_csrf="));

  return encontrado ? decodeURIComponent(encontrado.slice("avila_mail_csrf=".length)) : "";
}

export async function api<T>(
  caminho: string,
  opcoes: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<T> {
  const metodo = opcoes.method ?? "GET";
  const cabecalhos: Record<string, string> = { Accept: "application/json", ...opcoes.headers };

  if (metodo !== "GET") {
    cabecalhos["x-csrf-token"] = tokenCsrf();
    if (opcoes.body !== undefined) cabecalhos["Content-Type"] = "application/json";
  }

  const requisitar = () => fetch(`/api/mail${caminho}`, {
    method: metodo,
    headers: cabecalhos,
    body: opcoes.body === undefined ? undefined : JSON.stringify(opcoes.body),
    // Cookie httpOnly precisa acompanhar a requisicao.
    credentials: "same-origin",
  });
  let resposta = await requisitar();
  if (resposta.status === 401 && resposta.headers.get("x-mail-retomar") === "1") {
    const renovada = await fetch("/api/sessao/retomar", {
      method: "POST", headers: { "x-csrf-token": tokenCsrf() }, credentials: "same-origin",
    });
    resposta = renovada.ok ? await requisitar() : renovada;
  }

  const texto = await resposta.text();
  const corpo: unknown = texto ? JSON.parse(texto) : null;

  if (!resposta.ok) {
    const mensagem =
      corpo && typeof corpo === "object" && "erro" in corpo
        ? String((corpo as { erro?: unknown }).erro ?? "Erro na requisicao.")
        : "Erro na requisicao.";

    // Sessao morreu enquanto a aba estava aberta: recarregar cai no login.
    if (resposta.status === 401 || resposta.status === 428) window.location.href = "/entrar";

    // Primeiro acesso: a API recusa tudo (409) ate a senha ser definida. So a
    // propria chamada de definir a senha escapa, senao seria um laco.
    if (resposta.status === 409 && !caminho.startsWith("/me/first-password")) {
      window.location.href = "/definir-senha";
    }

    throw new ErroApi(mensagem, resposta.status);
  }

  return corpo as T;
}

export async function listarEventosAgenda(de: Date, ate: Date): Promise<EventoAgenda[]> {
  const parametros = new URLSearchParams({ from: de.toISOString(), to: ate.toISOString() });
  const chave = parametros.toString();
  const existente = cacheAgenda.get(chave);
  if (existente && existente.expiraEm > Date.now()) return existente.requisicao;
  const requisicao = api<{ events: EventoAgenda[] }>(`/me/calendar/events?${parametros}`)
    .then((resposta) => resposta.events)
    .catch((erro) => {
      cacheAgenda.delete(chave);
      throw erro;
    });
  cacheAgenda.set(chave, { requisicao, expiraEm: Date.now() + 30_000 });
  return requisicao;
}

const cacheAgenda = new Map<string, { requisicao: Promise<EventoAgenda[]>; expiraEm: number }>();

export function invalidarCacheAgenda(): void {
  cacheAgenda.clear();
}

export async function listarAgendas(): Promise<AgendaCalendario[]> {
  return (await api<{ calendars: AgendaCalendario[] }>("/me/calendar/calendars")).calendars;
}

export function criarAgenda(nome: string, cor: string): Promise<AgendaCalendario> {
  return api("/me/calendar/calendars", { method: "POST", body: { name: nome, color: cor } });
}

export function atualizarAgenda(id: string, mudancas: { name?: string; color?: string }): Promise<AgendaCalendario> {
  return api(`/me/calendar/calendars/${encodeURIComponent(id)}`, { method: "PATCH", body: mudancas });
}

export async function excluirAgenda(id: string): Promise<void> {
  await api(`/me/calendar/calendars/${encodeURIComponent(id)}`, { method: "DELETE" });
  invalidarCacheAgenda();
}

export async function obterEventoAgenda(id: string): Promise<EventoAgenda> {
  return api<EventoAgenda>(`/me/calendar/events/${encodeURIComponent(id)}`);
}

export async function criarEventoAgenda(dados: DadosEventoAgenda, opcoes?: { notificarConvidados?: boolean }): Promise<EventoAgenda> {
  const evento = await api<EventoAgenda>("/me/calendar/events", { method: "POST", body: { ...dados, notificarConvidados: opcoes?.notificarConvidados === true } });
  invalidarCacheAgenda();
  return evento;
}

export async function atualizarEventoAgenda(
  id: string,
  etag: string,
  mudancas: Partial<DadosEventoAgenda>,
  escopo?: { scope: "this" | "following" | "all"; recurrenceId: string },
  opcoes?: { notificarConvidados?: boolean },
): Promise<EventoAgenda> {
  const parametros = escopo ? `?${new URLSearchParams({ scope: escopo.scope, recurrenceId: escopo.recurrenceId })}` : "";
  const evento = await api<EventoAgenda>(`/me/calendar/events/${encodeURIComponent(id)}${parametros}`, {
    method: "PATCH",
    headers: { "If-Match": etag },
    body: { ...mudancas, notificarConvidados: opcoes?.notificarConvidados === true },
  });
  invalidarCacheAgenda();
  return evento;
}

export async function excluirEventoAgenda(id: string, etag: string, escopo?: { scope: "this" | "following" | "all"; recurrenceId: string }, opcoes?: { notificarConvidados?: boolean }): Promise<void> {
  const busca = new URLSearchParams(escopo ? { scope: escopo.scope, recurrenceId: escopo.recurrenceId } : {});
  if (opcoes?.notificarConvidados) busca.set("notificarConvidados", "true");
  const parametros = busca.size > 0 ? `?${busca}` : "";
  await api(`/me/calendar/events/${encodeURIComponent(id)}${parametros}`, {
    method: "DELETE",
    headers: { "If-Match": etag },
  });
  invalidarCacheAgenda();
}

export async function buscarEventosAgenda(consulta: string): Promise<EventoAgenda[]> {
  const parametros = new URLSearchParams({ q: consulta });
  return (await api<{ events: EventoAgenda[] }>(`/me/calendar/search?${parametros}`)).events;
}

export function obterPreferenciasAgenda(): Promise<PreferenciasAgenda> {
  return api<PreferenciasAgenda>("/me/calendar/settings");
}

export function salvarPreferenciasAgenda(dados: PreferenciasAgenda): Promise<PreferenciasAgenda> {
  return api<PreferenciasAgenda>("/me/calendar/settings", { method: "PUT", body: dados });
}

export function importarAgenda(uploadId: string, agendaId?: string): Promise<{ importados: number; ignorados: number; erros: number }> {
  return api("/me/calendar/import", { method: "POST", body: { uploadId, agendaId } });
}

export async function sair(): Promise<void> {
  await fetch("/api/sessao", {
    method: "DELETE",
    headers: { "x-csrf-token": tokenCsrf() },
    credentials: "same-origin",
  });
  // Ir para "/entrar" nao bastava: com SSO ligado aquela tela devolve para o
  // auth, que ainda tem o cookie de `.avilaops.com`, e a pessoa volta para a
  // caixa sem digitar nada. Quem termina o logout e a rota abaixo, que derruba
  // tambem a sessao do auth.
  window.location.href = "/api/sessao/sair";
}
