"use client";

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
  opcoes: { method?: string; body?: unknown } = {},
): Promise<T> {
  const metodo = opcoes.method ?? "GET";
  const cabecalhos: Record<string, string> = { Accept: "application/json" };

  if (metodo !== "GET") {
    cabecalhos["x-csrf-token"] = tokenCsrf();
    if (opcoes.body !== undefined) cabecalhos["Content-Type"] = "application/json";
  }

  const resposta = await fetch(`/api/mail${caminho}`, {
    method: metodo,
    headers: cabecalhos,
    body: opcoes.body === undefined ? undefined : JSON.stringify(opcoes.body),
    // Cookie httpOnly precisa acompanhar a requisicao.
    credentials: "same-origin",
  });

  const texto = await resposta.text();
  const corpo: unknown = texto ? JSON.parse(texto) : null;

  if (!resposta.ok) {
    const mensagem =
      corpo && typeof corpo === "object" && "erro" in corpo
        ? String((corpo as { erro?: unknown }).erro ?? "Erro na requisicao.")
        : "Erro na requisicao.";

    // Sessao morreu enquanto a aba estava aberta: recarregar cai no login.
    if (resposta.status === 401) window.location.href = "/entrar";

    // Primeiro acesso: a API recusa tudo (409) ate a senha ser definida. So a
    // propria chamada de definir a senha escapa, senao seria um laco.
    if (resposta.status === 409 && !caminho.startsWith("/me/first-password")) {
      window.location.href = "/definir-senha";
    }

    throw new ErroApi(mensagem, resposta.status);
  }

  return corpo as T;
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
