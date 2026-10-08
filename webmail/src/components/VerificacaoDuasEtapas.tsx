"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/cliente";

/**
 * Verificação em duas etapas (TOTP) do webmail.
 *
 * O segredo aparece UMA vez, na ativação — depois só o aplicativo autenticador
 * o conhece. Os códigos de recuperação também aparecem uma única vez: são a
 * saída de quem perdeu o celular.
 *
 * A 2FA protege o webmail; IMAP/POP3/SMTP continuam autenticando por senha,
 * que é o que os aplicativos de e-mail sabem falar — e a tela avisa isso.
 */

const campo =
  "rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-3 py-2 text-sm outline-none transition focus:border-[var(--color-realce)]";

function agrupar(segredo: string): string {
  return segredo.replace(/(.{4})/g, "$1 ").trim();
}

export function VerificacaoDuasEtapas() {
  const [carregado, setCarregado] = useState(false);
  const [ativa, setAtiva] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // Fluxo de ativação: segredo mostrado → código provado → recuperação anotada.
  const [segredo, setSegredo] = useState<{ secret: string; otpauth: string } | null>(null);
  const [codigo, setCodigo] = useState("");
  const [codigosRecuperacao, setCodigosRecuperacao] = useState<string[] | null>(null);

  // Desativação exige um código válido.
  const [desativando, setDesativando] = useState(false);
  const [codigoDesativar, setCodigoDesativar] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const dados = await api<{ twoFactorEnabled: boolean }>("/me");
        setAtiva(dados.twoFactorEnabled);
      } catch {
        setErro("Não foi possível carregar o estado da verificação.");
      } finally {
        setCarregado(true);
      }
    })();
  }, []);

  async function iniciar() {
    setErro(null);
    setOcupado(true);
    try {
      setSegredo(await api<{ secret: string; otpauth: string }>("/me/totp/setup", { method: "POST" }));
      setCodigo("");
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Não foi possível iniciar a ativação.");
    } finally {
      setOcupado(false);
    }
  }

  async function ativar() {
    setErro(null);
    setOcupado(true);
    try {
      const resposta = await api<{ recoveryCodes: string[] }>("/me/totp/enable", {
        method: "POST",
        body: { code: codigo.trim() },
      });
      setCodigosRecuperacao(resposta.recoveryCodes);
      setSegredo(null);
      setAtiva(true);
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Código inválido.");
    } finally {
      setOcupado(false);
    }
  }

  async function desativar() {
    setErro(null);
    setOcupado(true);
    try {
      await api("/me/totp/disable", { method: "POST", body: { code: codigoDesativar.trim() } });
      setAtiva(false);
      setDesativando(false);
      setCodigoDesativar("");
      setCodigosRecuperacao(null);
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Código inválido.");
    } finally {
      setOcupado(false);
    }
  }

  if (!carregado) return <p className="text-sm text-[var(--color-texto-fraco)]">Carregando…</p>;

  return (
    <div className="space-y-4">
      {erro && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-[var(--color-perigo)]">
          {erro}
        </p>
      )}

      {/* Códigos de recuperação: a ÚNICA vez que existem em claro. */}
      {codigosRecuperacao && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <p className="text-sm font-medium text-emerald-800">Verificação ativada. Guarde estes códigos de recuperação:</p>
          <ul className="mt-3 grid grid-cols-2 gap-1 font-mono text-sm">
            {codigosRecuperacao.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-emerald-700">
            Cada um vale uma única vez e substitui o código do aplicativo se você perder o celular. Eles não
            aparecem de novo.
          </p>
          <button
            type="button"
            onClick={() => setCodigosRecuperacao(null)}
            className="mt-3 rounded-lg border border-emerald-300 px-3 py-1.5 text-xs font-medium text-emerald-800 transition hover:bg-emerald-100"
          >
            Anotei, pode fechar
          </button>
        </div>
      )}

      {!ativa && !segredo && (
        <div className="space-y-3">
          <p className="text-sm text-[var(--color-texto-fraco)]">
            Além da senha, o login passa a pedir um código de 6 dígitos do seu aplicativo autenticador
            (Google Authenticator, 1Password, Authy…). Vale para o webmail; aplicativos de e-mail
            (celular, Outlook) continuam usando a senha.
          </p>
          <button
            type="button"
            onClick={() => void iniciar()}
            disabled={ocupado}
            className="rounded-lg bg-[var(--color-forte)] px-4 py-2 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] disabled:opacity-50"
          >
            Ativar verificação em duas etapas
          </button>
        </div>
      )}

      {!ativa && segredo && (
        <div className="space-y-3">
          <p className="text-sm">
            1. No aplicativo autenticador, adicione uma conta e digite esta chave (ou, no celular,{" "}
            <a href={segredo.otpauth} className="underline underline-offset-2">
              toque aqui para importar
            </a>
            ):
          </p>
          <code className="block rounded-lg bg-[var(--color-fundo-suave)] px-3 py-2 font-mono text-sm tracking-wide">
            {agrupar(segredo.secret)}
          </code>
          <p className="text-sm">2. Digite o código de 6 dígitos que o aplicativo mostrar:</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              inputMode="numeric"
              value={codigo}
              onChange={(evento) => setCodigo(evento.target.value)}
              placeholder="000000"
              maxLength={7}
              className={`${campo} w-32 text-center font-mono tracking-widest`}
            />
            <button
              type="button"
              onClick={() => void ativar()}
              disabled={ocupado || codigo.trim().length < 6}
              className="rounded-lg bg-[var(--color-forte)] px-4 py-2 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] disabled:opacity-50"
            >
              {ocupado ? "Conferindo…" : "Confirmar e ativar"}
            </button>
            <button
              type="button"
              onClick={() => {
                setSegredo(null);
                setErro(null);
              }}
              className="text-sm underline underline-offset-2 hover:text-[var(--color-tinta)]"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}

      {ativa && (
        <div className="space-y-3">
          <p className="text-sm">
            <span className="mr-2 inline-block rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
              Ativa
            </span>
            O login pede o código do aplicativo autenticador.
          </p>

          {!desativando ? (
            <button
              type="button"
              onClick={() => setDesativando(true)}
              className="rounded-lg border border-[var(--color-borda)] px-3 py-2 text-sm font-medium transition hover:bg-[var(--color-fundo-suave)]"
            >
              Desativar
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                value={codigoDesativar}
                onChange={(evento) => setCodigoDesativar(evento.target.value)}
                placeholder="código do aplicativo"
                maxLength={12}
                className={`${campo} w-44 font-mono`}
              />
              <button
                type="button"
                onClick={() => void desativar()}
                disabled={ocupado || codigoDesativar.trim().length < 6}
                className="rounded-lg bg-[var(--color-perigo)] px-4 py-2 text-sm font-medium text-white transition disabled:opacity-50"
              >
                {ocupado ? "Desativando…" : "Confirmar desativação"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDesativando(false);
                  setCodigoDesativar("");
                  setErro(null);
                }}
                className="text-sm underline underline-offset-2 hover:text-[var(--color-tinta)]"
              >
                Cancelar
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
