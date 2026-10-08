"use client";

import { useState, type FormEvent } from "react";
import { CampoSenha } from "./CampoSenha";
import { Marca } from "./Marca";

/**
 * Tela de entrada.
 *
 * A mensagem de erro repete o que a API devolve, e a API responde a mesma
 * coisa para caixa inexistente e senha errada — de proposito. Aqui nao ha
 * "usuario nao encontrado" para confirmar quais enderecos existem.
 */
export function FormularioEntrar({ aviso }: { aviso?: string | null } = {}) {
  const [endereco, setEndereco] = useState("");
  const [senha, setSenha] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  // Segunda etapa (2FA): a senha passou e a API espera o codigo.
  const [totpToken, setTotpToken] = useState<string | null>(null);
  const [codigo, setCodigo] = useState("");

  async function enviarSessao(body: unknown): Promise<void> {
    setErro(null);
    setEnviando(true);

    try {
      const resposta = await fetch("/api/sessao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "same-origin",
      });

      if (!resposta.ok) {
        const corpo = (await resposta.json().catch(() => null)) as { erro?: string } | null;
        setErro(corpo?.erro ?? "Nao foi possivel entrar.");
        setEnviando(false);
        return;
      }

      const corpo = (await resposta.json().catch(() => null)) as
        | { requiresTotp?: boolean; totpToken?: string; mailbox?: { mustChangePassword?: boolean } }
        | null;

      if (corpo?.requiresTotp && corpo.totpToken) {
        setTotpToken(corpo.totpToken);
        setEnviando(false);
        return;
      }

      window.location.href = corpo?.mailbox?.mustChangePassword ? "/definir-senha" : "/caixa";
    } catch {
      setErro("Sem conexao com o servidor. Tente novamente.");
      setEnviando(false);
    }
  }

  async function entrar(evento: FormEvent) {
    evento.preventDefault();
    await enviarSessao({ address: endereco.trim(), password: senha });
  }

  async function confirmarCodigo(evento: FormEvent) {
    evento.preventDefault();
    await enviarSessao({ totpToken, code: codigo.trim() });
  }

  if (totpToken) {
    return (
      <main className="flex min-h-full items-center justify-center bg-[var(--color-fundo-suave)] px-6 py-16">
        <div className="w-full max-w-sm">
          <div className="mb-10">
            <Marca />
            <h1 className="text-2xl font-semibold tracking-tight">Verificação em duas etapas</h1>
            <p className="mt-1 text-sm text-[var(--color-texto-fraco)]">
              Digite o código do seu aplicativo autenticador — ou um código de recuperação.
            </p>
          </div>

          <form onSubmit={confirmarCodigo} className="space-y-4">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              required
              value={codigo}
              onChange={(evento) => setCodigo(evento.target.value)}
              placeholder="000000"
              className="w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-3.5 py-2.5 text-center font-mono text-lg tracking-widest outline-none transition focus:border-[var(--color-realce)] focus:ring-2 focus:ring-blue-100"
            />

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
              {enviando ? "Verificando…" : "Confirmar"}
            </button>
          </form>

          <p className="mt-6 text-center text-sm text-[var(--color-texto-fraco)]">
            <button
              type="button"
              onClick={() => {
                setTotpToken(null);
                setCodigo("");
                setErro(null);
              }}
              className="underline underline-offset-2 hover:text-[var(--color-tinta)]"
            >
              Voltar ao login
            </button>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-[var(--color-fundo-suave)] px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-10">
          <Marca />
          <h1 className="text-2xl font-semibold tracking-tight">Seu e-mail</h1>
          <p className="mt-1 text-sm text-[var(--color-texto-fraco)]">Ávila Ops Tecnologia</p>
        </div>

        {aviso && (
          <p role="status" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {aviso}
          </p>
        )}
        <form onSubmit={entrar} className="space-y-4">
          <div>
            <label htmlFor="endereco" className="mb-1.5 block text-sm font-medium">
              Endereço
            </label>
            <input
              id="endereco"
              type="email"
              autoComplete="username"
              required
              value={endereco}
              onChange={(evento) => setEndereco(evento.target.value)}
              placeholder="contato@suaempresa.com.br"
              className="w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-3.5 py-2.5 text-sm outline-none transition focus:border-[var(--color-realce)] focus:ring-2 focus:ring-blue-100"
            />
          </div>

          <CampoSenha id="senha" label="Senha" value={senha} onChange={setSenha} required />

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
            {enviando ? "Entrando…" : "Entrar"}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-[var(--color-texto-fraco)]">
          <a href="/recuperar" className="underline underline-offset-2 hover:text-[var(--color-tinta)]">
            Esqueci minha senha
          </a>
        </p>

        <p className="mt-3 text-center text-sm text-[var(--color-texto-fraco)]">
          Ainda não tem e-mail profissional?{" "}
          <a href="/criar-conta" className="underline underline-offset-2 hover:text-[var(--color-tinta)]">
            Ver como contratar
          </a>
        </p>

        <p className="mt-3 text-center text-xs text-[var(--color-texto-fraco)]">
          <a href="/configurar" className="underline underline-offset-2 hover:text-[var(--color-tinta)]">
            Configurar no celular ou no Outlook
          </a>
        </p>
      </div>
    </main>
  );
}
