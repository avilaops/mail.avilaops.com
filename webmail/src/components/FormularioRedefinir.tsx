"use client";

import { useState, type FormEvent } from "react";
import { CampoSenha } from "./CampoSenha";

/** Mínimo aceito pela API. Repetido aqui só para avisar antes da viagem. */
const TAMANHO_MINIMO = 12;

interface Props {
  token: string;
}

export function FormularioRedefinir({ token }: Props) {
  const [senha, setSenha] = useState("");
  const [repetida, setRepetida] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [pronto, setPronto] = useState<string | null>(null);

  async function redefinir(evento: FormEvent) {
    evento.preventDefault();
    setErro(null);

    if (senha.length < TAMANHO_MINIMO) {
      setErro(`A senha precisa ter no mínimo ${TAMANHO_MINIMO} caracteres.`);
      return;
    }
    if (senha !== repetida) {
      setErro("As senhas não conferem.");
      return;
    }

    setEnviando(true);
    try {
      const resposta = await fetch("/api/mail/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, newPassword: senha }),
        credentials: "same-origin",
      });

      const corpo = (await resposta.json().catch(() => null)) as { address?: string; erro?: string } | null;

      if (!resposta.ok) {
        setErro(corpo?.erro ?? "Não foi possível redefinir a senha.");
        setEnviando(false);
        return;
      }

      setPronto(corpo?.address ?? "");
    } catch {
      setErro("Sem conexão com o servidor. Tente novamente.");
      setEnviando(false);
    }
  }

  if (!token) {
    return (
      <main className="flex min-h-full items-center justify-center bg-[var(--color-fundo-suave)] px-6 py-16">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-tight">Link incompleto</h1>
          <p className="mt-3 text-sm text-[var(--color-texto-fraco)]">
            Abra o link exatamente como ele veio no e-mail. Alguns programas quebram endereços
            longos em duas linhas.
          </p>
          <a
            href="/recuperar"
            className="mt-8 inline-block text-sm underline underline-offset-2 hover:text-[var(--color-tinta)]"
          >
            Pedir um link novo
          </a>
        </div>
      </main>
    );
  }

  if (pronto !== null) {
    return (
      <main className="flex min-h-full items-center justify-center bg-[var(--color-fundo-suave)] px-6 py-16">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-semibold tracking-tight">Senha alterada</h1>
          <p className="mt-3 text-sm text-[var(--color-texto-fraco)]">
            {pronto ? <>A senha de <strong>{pronto}</strong> foi redefinida.</> : "Sua senha foi redefinida."}{" "}
            Por segurança, as sessões abertas em outros aparelhos foram encerradas — e o aplicativo
            de e-mail do celular vai pedir a senha nova.
          </p>
          <a
            href="/entrar"
            className="mt-8 inline-block rounded-lg bg-[var(--color-forte)] px-4 py-2.5 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)]"
          >
            Entrar
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-[var(--color-fundo-suave)] px-6 py-16">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Nova senha</h1>
        <p className="mt-1 text-sm text-[var(--color-texto-fraco)]">
          Mínimo de {TAMANHO_MINIMO} caracteres.
        </p>

        <form onSubmit={redefinir} className="mt-8 space-y-4">
          <CampoSenha id="senha" label="Senha" value={senha} onChange={setSenha} autoComplete="new-password" autoFocus required />

          <CampoSenha id="repetida" label="Repita a senha" value={repetida} onChange={setRepetida} autoComplete="new-password" required />

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
            {enviando ? "Salvando…" : "Salvar senha"}
          </button>
        </form>
      </div>
    </main>
  );
}
