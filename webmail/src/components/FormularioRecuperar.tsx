"use client";

import { useState, type FormEvent } from "react";

/**
 * Pedido de recuperacao de senha.
 *
 * A tela mostra a MESMA confirmacao em todos os casos — caixa inexistente, sem
 * e-mail de recuperacao cadastrado ou bloqueada por excesso de pedidos. A API
 * responde igual de proposito, e a interface nao pode desfazer isso: qualquer
 * diferenca aqui vira uma forma de descobrir quais enderecos existem.
 */
export function FormularioRecuperar() {
  const [endereco, setEndereco] = useState("");
  const [enviado, setEnviado] = useState<{ destino: string | null } | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  async function pedir(evento: FormEvent) {
    evento.preventDefault();
    setErro(null);
    setEnviando(true);

    try {
      const resposta = await fetch("/api/mail/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: endereco.trim() }),
        credentials: "same-origin",
      });

      const corpo = (await resposta.json().catch(() => null)) as { sentTo?: string | null } | null;
      setEnviado({ destino: corpo?.sentTo ?? null });
    } catch {
      setErro("Sem conexão com o servidor. Tente novamente.");
    } finally {
      setEnviando(false);
    }
  }

  if (enviado) {
    return (
      <main className="flex min-h-full items-center justify-center bg-[var(--color-fundo-suave)] px-6 py-16">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-tight">Verifique seu e-mail</h1>

          <p className="mt-3 text-sm leading-relaxed text-[var(--color-texto-fraco)]">
            Se houver uma caixa com esse endereço e um e-mail de recuperação cadastrado, enviamos
            um link {enviado.destino ? <>para <strong>{enviado.destino}</strong></> : "para o endereço cadastrado"}.
          </p>

          <p className="mt-3 text-sm text-[var(--color-texto-fraco)]">
            O link vale por 60 minutos e só pode ser usado uma vez.
          </p>

          <p className="mt-3 text-sm text-[var(--color-texto-fraco)]">
            Não cadastrou um e-mail de recuperação? Fale com quem cuida do seu e-mail — só a
            Ávila Ops consegue redefinir a senha nesse caso.
          </p>

          <a
            href="/entrar"
            className="mt-8 inline-block text-sm underline underline-offset-2 hover:text-[var(--color-tinta)]"
          >
            Voltar para o login
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-[var(--color-fundo-suave)] px-6 py-16">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Recuperar senha</h1>
        <p className="mt-1 text-sm text-[var(--color-texto-fraco)]">
          Enviamos um link para o e-mail de recuperação da sua caixa.
        </p>

        <form onSubmit={pedir} className="mt-8 space-y-4">
          <div>
            <label htmlFor="endereco" className="mb-1.5 block text-sm font-medium">
              Seu endereço de e-mail
            </label>
            <input
              id="endereco"
              type="email"
              autoComplete="username"
              required
              autoFocus
              value={endereco}
              onChange={(evento) => setEndereco(evento.target.value)}
              placeholder="contato@suaempresa.com.br"
              className="w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-3.5 py-2.5 text-sm outline-none transition focus:border-[var(--color-realce)] focus:ring-2 focus:ring-blue-100"
            />
          </div>

          {erro && (
            <p role="alert" className="rounded-lg bg-red-50 px-3.5 py-2.5 text-sm text-[var(--color-perigo)]">
              {erro}
            </p>
          )}

          <button
            type="submit"
            disabled={enviando}
            className="w-full rounded-lg bg-[var(--color-forte)] px-4 py-2.5 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] disabled:opacity-50"
          >
            {enviando ? "Enviando…" : "Enviar link"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[var(--color-texto-fraco)]">
          <a href="/entrar" className="underline underline-offset-2 hover:text-[var(--color-tinta)]">
            Voltar para o login
          </a>
        </p>
      </div>
    </main>
  );
}
