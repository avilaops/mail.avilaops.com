"use client";

import { useState, type FormEvent } from "react";
import { api } from "@/lib/cliente";
import { CampoSenha } from "./CampoSenha";
import { Marca } from "./Marca";


/**
 * Tela do primeiro acesso: o dono escolhe a senha dele.
 *
 * Não pede a senha atual — ela foi entregue por nós e é justamente o que
 * estamos substituindo. A sessão já prova a posse da caixa; a API só aceita
 * `/me/first-password` enquanto a marca de primeira troca estiver de pé.
 */
export function DefinirSenha() {
  const [senha, setSenha] = useState("");
  const [confirma, setConfirma] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  async function enviar(evento: FormEvent) {
    evento.preventDefault();
    setErro(null);
    if (senha.length < 12) return setErro("A senha precisa ter no mínimo 12 caracteres.");
    if (senha !== confirma) return setErro("As senhas não conferem.");

    setEnviando(true);
    try {
      await api("/me/first-password", { method: "POST", body: { newPassword: senha } });
      window.location.href = "/caixa";
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Não foi possível salvar a senha.");
      setEnviando(false);
    }
  }

  return (
    <main className="flex min-h-full items-center justify-center bg-[var(--color-fundo-suave)] px-6 py-16">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <Marca />
          <h1 className="text-2xl font-semibold tracking-tight">Defina sua senha</h1>
          <p className="mt-1 text-sm text-[var(--color-texto-fraco)]">
            Primeiro acesso: escolha uma senha só sua para substituir a que enviamos.
          </p>
        </div>

        <form onSubmit={enviar} className="space-y-4">
          <CampoSenha label="Nova senha" value={senha} onChange={setSenha} autoComplete="new-password" autoFocus required />
          <CampoSenha label="Repita a senha" value={confirma} onChange={setConfirma} autoComplete="new-password" required />

          <p className="text-xs text-[var(--color-texto-fraco)]">
            Mínimo de 12 caracteres. Vale para o webmail, para o login único e para os programas de e-mail (IMAP/SMTP).
          </p>

          {erro && (
            <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900">
              {erro}
            </p>
          )}

          <button
            type="submit"
            disabled={enviando}
            className="w-full rounded-lg bg-[var(--color-forte)] px-4 py-2.5 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] disabled:opacity-50"
          >
            {enviando ? "Salvando…" : "Salvar e entrar"}
          </button>
        </form>
      </div>
    </main>
  );
}
