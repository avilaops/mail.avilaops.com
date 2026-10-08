"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/cliente";

/**
 * Area de desenvolvedor: o dono cria, copia e revoga as chaves da API sem
 * ninguem entrar no servidor. A chave aparece UMA vez, na criacao — o
 * servidor guarda so o hash, como senha — por isso o aviso "copie agora" e o
 * botao de copiar ficam no mesmo bloco.
 *
 * Quem e administrador ve tambem o escopo "provisionamento" (criar dominio e
 * caixa), que e o que o n8n usa. Todo mundo ve o escopo "caixa".
 */

interface Chave {
  id: string;
  name: string;
  scope: "mailbox" | "provisioning";
  prefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

const NOME_ESCOPO: Record<Chave["scope"], string> = {
  mailbox: "Caixa (ler e enviar como você)",
  provisioning: "Provisionamento (criar domínios e caixas)",
};

const campo =
  "rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-3 py-2 text-sm outline-none transition focus:border-[var(--color-realce)]";

function data(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : "nunca";
}

function Copiar({ texto }: { texto: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(texto).then(() => {
          setCopiado(true);
          setTimeout(() => setCopiado(false), 2000);
        });
      }}
      className="shrink-0 rounded-md border border-[var(--color-borda)] px-2 py-1 text-xs text-[var(--color-texto-fraco)] transition hover:bg-[var(--color-fundo-suave)]"
    >
      {copiado ? "Copiado ✓" : "Copiar"}
    </button>
  );
}

export function ChavesDeApi({ host }: { host: string }) {
  const [chaves, setChaves] = useState<Chave[]>([]);
  const [podeProvisionar, setPodeProvisionar] = useState(false);
  const [carregado, setCarregado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  const [nome, setNome] = useState("");
  const [escopo, setEscopo] = useState<Chave["scope"]>("mailbox");
  const [novaChave, setNovaChave] = useState<{ token: string; name: string } | null>(null);
  const [mostrarComoUsar, setMostrarComoUsar] = useState(false);

  async function carregar() {
    const dados = await api<{ keys: Chave[]; canProvision: boolean }>("/me/api-keys");
    setChaves(dados.keys);
    setPodeProvisionar(dados.canProvision);
  }

  useEffect(() => {
    void carregar()
      .catch((falha) => setErro(falha instanceof Error ? falha.message : "Falha ao carregar as chaves."))
      .finally(() => setCarregado(true));
  }, []);

  async function criar(evento: React.FormEvent) {
    evento.preventDefault();
    setErro(null);
    setOcupado(true);
    try {
      const resposta = await api<{ key: Chave; token: string }>("/me/api-keys", {
        method: "POST",
        body: { name: nome.trim(), scope: escopo },
      });
      setNovaChave({ token: resposta.token, name: resposta.key.name });
      setNome("");
      setEscopo("mailbox");
      await carregar();
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Não foi possível criar a chave.");
    } finally {
      setOcupado(false);
    }
  }

  async function revogar(chave: Chave) {
    if (!window.confirm(`Revogar a chave "${chave.name}"? Tudo que a usa para de funcionar na hora.`)) return;
    setErro(null);
    try {
      await api(`/me/api-keys/${chave.id}`, { method: "DELETE" });
      await carregar();
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Não foi possível revogar.");
    }
  }

  if (!carregado) return <p className="text-sm text-[var(--color-texto-fraco)]">Carregando…</p>;

  const ativas = chaves.filter((c) => !c.revokedAt);
  const revogadas = chaves.filter((c) => c.revokedAt);
  const exemplo = `curl -H "Authorization: Bearer ${novaChave?.token ?? "amk_m_SUA_CHAVE"}" https://${host}/api/v1/me`;

  return (
    <div className="space-y-4">
      {erro && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-[var(--color-perigo)]">
          {erro}
        </p>
      )}

      {/* A chave nova: visivel uma unica vez. */}
      {novaChave && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm dark:border-emerald-800 dark:bg-emerald-950">
          <p className="font-medium text-emerald-800 dark:text-emerald-300">Chave “{novaChave.name}” criada — copie agora</p>
          <div className="mt-2 flex items-center gap-2">
            <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-black/5 px-3 py-2 font-mono text-xs dark:bg-white/10">
              {novaChave.token}
            </code>
            <Copiar texto={novaChave.token} />
          </div>
          <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
            Ela não aparece de novo: guardamos só uma impressão digital. Perdeu? Revogue e crie outra.
          </p>
          <button
            type="button"
            onClick={() => setNovaChave(null)}
            className="mt-3 text-xs underline underline-offset-2 hover:text-[var(--color-tinta)]"
          >
            Copiei, pode esconder
          </button>
        </div>
      )}

      {ativas.length > 0 && (
        <ul className="divide-y divide-[var(--color-borda)] rounded-lg border border-[var(--color-borda)]">
          {ativas.map((chave) => (
            <li key={chave.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">
                  {chave.name}{" "}
                  <code className="ml-1 rounded bg-black/5 px-1.5 py-0.5 font-mono text-xs dark:bg-white/10">{chave.prefix}</code>
                </p>
                <p className="text-xs text-[var(--color-texto-fraco)]">
                  {NOME_ESCOPO[chave.scope]} · criada {data(chave.createdAt)} · último uso {data(chave.lastUsedAt)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void revogar(chave)}
                className="text-xs text-[var(--color-perigo)] underline underline-offset-2"
              >
                Revogar
              </button>
            </li>
          ))}
        </ul>
      )}

      {ativas.length === 0 && !novaChave && (
        <p className="text-sm text-[var(--color-texto-fraco)]">Nenhuma chave ativa. Crie uma para usar a API a partir de scripts, do n8n ou de outro sistema.</p>
      )}

      <form onSubmit={(evento) => void criar(evento)} className="flex flex-wrap items-stretch gap-2">
        <input
          type="text"
          value={nome}
          onChange={(evento) => setNome(evento.target.value)}
          placeholder="Nome (ex.: n8n, relatório mensal)"
          maxLength={60}
          required
          className={`${campo} min-w-0 flex-1`}
        />
        {podeProvisionar && (
          <select value={escopo} onChange={(evento) => setEscopo(evento.target.value as Chave["scope"])} className={campo}>
            <option value="mailbox">Caixa</option>
            <option value="provisioning">Provisionamento</option>
          </select>
        )}
        <button
          type="submit"
          disabled={ocupado}
          className="rounded-lg bg-[var(--color-forte)] px-4 py-2 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] disabled:opacity-50"
        >
          {ocupado ? "Criando…" : "Criar chave"}
        </button>
      </form>

      <div className="text-xs text-[var(--color-texto-fraco)]">
        <button
          type="button"
          onClick={() => setMostrarComoUsar(!mostrarComoUsar)}
          className="underline underline-offset-2 hover:text-[var(--color-tinta)]"
        >
          {mostrarComoUsar ? "Esconder como usar" : "Como usar a chave"}
        </button>
        {mostrarComoUsar && (
          <div className="mt-2 space-y-2">
            <p>
              Mande a chave no cabeçalho <code className="font-mono">Authorization: Bearer …</code>. A chave de
              caixa fala com as rotas <code className="font-mono">/api/v1/me/*</code> (ler pastas e mensagens, enviar,
              regras); a de provisionamento com <code className="font-mono">/api/v1/domains</code> e{" "}
              <code className="font-mono">/api/v1/mailboxes</code>.
            </p>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-md bg-black/5 px-3 py-2 font-mono dark:bg-white/10">
                {exemplo}
              </code>
              <Copiar texto={exemplo} />
            </div>
            <p>
              Por segurança, chave de API não troca senha, não mexe em 2FA, sessões ou em outras chaves — isso só pelo
              webmail. Vazou? Revogue aqui: para de valer no mesmo segundo.
            </p>
          </div>
        )}
      </div>

      {revogadas.length > 0 && (
        <details className="text-xs text-[var(--color-texto-fraco)]">
          <summary className="cursor-pointer">Revogadas ({revogadas.length})</summary>
          <ul className="mt-2 space-y-1">
            {revogadas.map((chave) => (
              <li key={chave.id}>
                {chave.name} <code className="font-mono">{chave.prefix}</code> · revogada {data(chave.revokedAt)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
