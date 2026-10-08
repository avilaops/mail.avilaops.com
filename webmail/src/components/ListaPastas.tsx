"use client";

import { useState } from "react";
import { sair } from "@/lib/cliente";
import type { Caixa, Pasta } from "@/lib/tipos";
import BotaoTema from "@/lib/tema-noturno/react";

const ORDEM: Record<string, number> = { inbox: 0, snoozed: 1, archive: 2, sent: 3, drafts: 4, spam: 5, trash: 6 };

/**
 * Escala a unidade ao valor. Arredondar tudo para MB fazia caixa nova com
 * algumas centenas de KB exibir "0 MB usados", como se estivesse vazia.
 */
function formatarEspaco(bytes: string): string {
  const valor = Number(bytes);
  if (valor >= 1024 ** 3) return `${(valor / 1024 ** 3).toFixed(1)} GB`;
  if (valor >= 1024 ** 2) return `${(valor / 1024 ** 2).toFixed(1)} MB`;
  if (valor >= 1024) return `${Math.round(valor / 1024)} KB`;
  return `${valor} B`;
}

interface Props {
  caixa: Caixa | null;
  pastas: Pasta[];
  pastaAtual: string;
  onEscolher: (chave: string) => void;
  onEscrever: () => void;
  onCriarPasta: (nome: string) => Promise<void>;
  onRenomearPasta: (id: string, nome: string) => Promise<void>;
  onExcluirPasta: (id: string, nome: string) => Promise<void>;
}

export function ListaPastas({
  caixa,
  pastas,
  pastaAtual,
  onEscolher,
  onEscrever,
  onCriarPasta,
  onRenomearPasta,
  onExcluirPasta,
}: Props) {
  const [criando, setCriando] = useState(false);
  const [nomeNovo, setNomeNovo] = useState("");
  const [renomeando, setRenomeando] = useState<string | null>(null);
  const [nomeEditado, setNomeEditado] = useState("");

  const sistema = pastas
    .filter((pasta) => pasta.kind !== "custom")
    .sort((a, b) => (ORDEM[a.kind] ?? 99) - (ORDEM[b.kind] ?? 99));

  const proprias = pastas
    .filter((pasta) => pasta.kind === "custom")
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  const uso = caixa?.usoPercentual ?? 0;

  function Item({ pasta }: { pasta: Pasta }) {
    const ativa = pasta.kind === pastaAtual || pasta.id === pastaAtual;
    const propria = pasta.kind === "custom";

    if (renomeando === pasta.id) {
      return (
        <form
          onSubmit={(evento) => {
            evento.preventDefault();
            void onRenomearPasta(pasta.id, nomeEditado).finally(() => setRenomeando(null));
          }}
          className="px-1 py-0.5"
        >
          <input
            autoFocus
            value={nomeEditado}
            onChange={(evento) => setNomeEditado(evento.target.value)}
            onBlur={() => setRenomeando(null)}
            onKeyDown={(evento) => evento.key === "Escape" && setRenomeando(null)}
            className="w-full rounded border border-[var(--color-realce)] bg-[var(--color-superficie)] px-2 py-1 text-sm outline-none"
          />
        </form>
      );
    }

    return (
      <div className="group relative">
        <button
          onClick={() => onEscolher(propria ? pasta.id : pasta.kind)}
          aria-current={ativa ? "page" : undefined}
          className={`flex w-full items-center justify-between rounded-md px-2.5 py-2 text-sm transition ${
            ativa ? "bg-[var(--color-forte)] font-medium text-[var(--color-sobre-forte)]" : "text-[var(--color-tinta)] hover:bg-[var(--color-hover-suave)]"
          }`}
        >
          <span className="truncate pr-1">{pasta.name}</span>
          {/* Em Enviados e Rascunhos "nao lida" nao quer dizer nada: o contador
              so chamava atencao para o que o proprio dono escreveu. */}
          {pasta.unread > 0 && pasta.kind !== "sent" && pasta.kind !== "drafts" && (
            <span
              className={`ml-2 shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                ativa ? "bg-[var(--color-sobre-forte)]/20 text-white" : "bg-[var(--color-realce)] text-white"
              }`}
            >
              {pasta.unread}
            </span>
          )}
        </button>

        {propria && (
          // Acoes so no hover: pasta de e-mail e coisa de clicar, nao de
          // administrar; deixar dois botoes fixos em cada linha polui a lista.
          <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 gap-0.5 group-hover:flex">
            <button
              onClick={() => {
                setNomeEditado(pasta.name);
                setRenomeando(pasta.id);
              }}
              aria-label={`Renomear ${pasta.name}`}
              title="Renomear"
              className={`rounded px-1.5 text-xs ${ativa ? "text-[var(--color-sobre-forte)]/70 hover:bg-[var(--color-sobre-forte)]/20" : "bg-[var(--color-superficie)] text-[var(--color-texto-fraco)] hover:text-[var(--color-tinta)]"}`}
            >
              ✎
            </button>
            <button
              onClick={() => void onExcluirPasta(pasta.id, pasta.name)}
              aria-label={`Excluir ${pasta.name}`}
              title="Excluir"
              className={`rounded px-1.5 text-xs ${ativa ? "text-[var(--color-sobre-forte)]/70 hover:bg-[var(--color-sobre-forte)]/20" : "bg-[var(--color-superficie)] text-[var(--color-texto-fraco)] hover:text-[var(--color-perigo)]"}`}
            >
              ×
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <nav className="flex h-full w-full shrink-0 flex-col border-r md:w-60 border-[var(--color-borda)] bg-[var(--color-fundo-suave)]">
      <div className="px-4 py-4">
        <p className="truncate text-sm font-medium" title={caixa?.address}>
          {caixa?.displayName || caixa?.address || "…"}
        </p>
        {caixa?.displayName && (
          <p className="truncate text-xs text-[var(--color-texto-fraco)]">{caixa.address}</p>
        )}
      </div>

      <div className="px-3 pb-3">
        <button
          onClick={onEscrever}
          className="w-full rounded-lg bg-[var(--color-forte)] px-4 py-2.5 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)]"
        >
          Escrever
        </button>
      </div>

      <div className="rolagem-fina min-h-0 flex-1 overflow-y-auto px-2">
        <ul className="space-y-0.5">
          {sistema.map((pasta) => (
            <li key={pasta.id}>
              <Item pasta={pasta} />
            </li>
          ))}
        </ul>

        <div className="mt-4">
          <p className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-texto-fraco)]">
            Minhas pastas
          </p>

          <ul className="space-y-0.5">
            {proprias.map((pasta) => (
              <li key={pasta.id}>
                <Item pasta={pasta} />
              </li>
            ))}
          </ul>

          {criando ? (
            <form
              onSubmit={(evento) => {
                evento.preventDefault();
                const nome = nomeNovo.trim();
                if (!nome) {
                  setCriando(false);
                  return;
                }
                void onCriarPasta(nome).finally(() => {
                  setNomeNovo("");
                  setCriando(false);
                });
              }}
              className="px-1 py-0.5"
            >
              <input
                autoFocus
                value={nomeNovo}
                onChange={(evento) => setNomeNovo(evento.target.value)}
                onBlur={() => setCriando(false)}
                onKeyDown={(evento) => evento.key === "Escape" && setCriando(false)}
                placeholder="Nome da pasta"
                className="w-full rounded border border-[var(--color-realce)] bg-[var(--color-superficie)] px-2 py-1 text-sm outline-none"
              />
            </form>
          ) : (
            <button
              onClick={() => setCriando(true)}
              className="w-full rounded-md px-2.5 py-1.5 text-left text-sm text-[var(--color-texto-fraco)] transition hover:bg-[var(--color-hover-suave)] hover:text-[var(--color-tinta)]"
            >
              + Nova pasta
            </button>
          )}
        </div>
      </div>

      <div className="rodape-seguro border-t border-[var(--color-borda)] px-4 pt-3">
        {caixa && (
          <div className="mb-3">
            <div className="mb-1 flex justify-between text-[11px] text-[var(--color-texto-fraco)]">
              <span>{formatarEspaco(caixa.usedBytes)} usados</span>
              <span>{formatarEspaco(caixa.quotaBytes)}</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-[var(--color-borda)]">
              <div
                className={`h-full rounded-full ${uso > 90 ? "bg-[var(--color-perigo)]" : "bg-[var(--color-realce)]"}`}
                style={{ width: `${Math.min(Math.max(uso, 1), 100)}%` }}
              />
            </div>
          </div>
        )}

        <div className="flex items-center gap-3 text-xs text-[var(--color-texto-fraco)]">
          <a href="/conta" className="underline underline-offset-2 transition hover:text-[var(--color-tinta)]">
            Conta
          </a>
          {caixa?.isAdmin && (
            <a href="/admin" className="underline underline-offset-2 transition hover:text-[var(--color-tinta)]">
              Administração
            </a>
          )}
          <button
            onClick={() => void sair()}
            className="underline underline-offset-2 transition hover:text-[var(--color-tinta)]"
          >
            Sair
          </button>
          {/* O tema segue o horário; este botão é a saída para quem quer o contrário agora. */}
          <BotaoTema className="botao-tema ml-auto" />
        </div>
      </div>
    </nav>
  );
}
