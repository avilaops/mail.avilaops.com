"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { api } from "@/lib/cliente";

/**
 * Campo de destinatarios com fichas e autocompletar.
 *
 * As sugestoes vem de `/me/contacts`, que deriva a agenda do proprio historico
 * da caixa. Nao existe cadastro de contatos de proposito: a agenda util de um
 * e-mail e para quem a pessoa ja escreveu.
 */

interface Contato {
  address: string;
  name: string | null;
  frequency: number;
}

interface Props {
  rotulo: string;
  valores: string[];
  onMudar: (valores: string[]) => void;
  autoFocus?: boolean;
}

export function CampoDestinatarios({ rotulo, valores, onMudar, autoFocus }: Props) {
  const [rascunho, setRascunho] = useState("");
  const [sugestoes, setSugestoes] = useState<Contato[]>([]);
  const [aberto, setAberto] = useState(false);
  const [destacado, setDestacado] = useState(0);

  const idLista = useId();
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (temporizador.current) clearTimeout(temporizador.current);

    const termo = rascunho.trim();
    if (termo.length < 2) {
      setSugestoes([]);
      setAberto(false);
      return;
    }

    // Espera a digitacao parar: uma consulta por tecla castigaria o banco.
    temporizador.current = setTimeout(() => {
      void api<{ contacts: Contato[] }>(`/me/contacts?q=${encodeURIComponent(termo)}&limit=6`)
        .then((dados) => {
          const novos = dados.contacts.filter((contato) => !valores.includes(contato.address));
          setSugestoes(novos);
          setAberto(novos.length > 0);
          setDestacado(0);
        })
        .catch(() => setSugestoes([]));
    }, 220);

    return () => {
      if (temporizador.current) clearTimeout(temporizador.current);
    };
  }, [rascunho, valores]);

  function adicionar(endereco: string) {
    const limpo = endereco.trim().toLowerCase();
    if (limpo && !valores.includes(limpo)) onMudar([...valores, limpo]);
    setRascunho("");
    setSugestoes([]);
    setAberto(false);
  }

  function aoTeclar(evento: KeyboardEvent<HTMLInputElement>) {
    if (aberto && (evento.key === "ArrowDown" || evento.key === "ArrowUp")) {
      evento.preventDefault();
      setDestacado((atual) => {
        const proximo = evento.key === "ArrowDown" ? atual + 1 : atual - 1;
        return (proximo + sugestoes.length) % sugestoes.length;
      });
      return;
    }

    // Virgula e ponto-e-virgula fecham a ficha: e como todo mundo digita lista
    // de e-mail, e obrigar Enter a cada endereco irrita rapido.
    if (evento.key === "Enter" || evento.key === "," || evento.key === ";" || evento.key === "Tab") {
      const escolhida = aberto ? sugestoes[destacado] : null;
      if (escolhida || rascunho.trim()) {
        if (evento.key !== "Tab" || rascunho.trim()) evento.preventDefault();
        adicionar(escolhida?.address ?? rascunho);
      }
      return;
    }

    if (evento.key === "Backspace" && rascunho === "" && valores.length > 0) {
      onMudar(valores.slice(0, -1));
      return;
    }

    if (evento.key === "Escape") setAberto(false);
  }

  return (
    <div className="relative flex items-start gap-2 border-b border-[var(--color-borda)] px-4 py-2">
      <span className="shrink-0 pt-1.5 text-xs text-[var(--color-texto-fraco)]">{rotulo}</span>

      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {valores.map((endereco) => (
          <span
            key={endereco}
            className="flex items-center gap-1 rounded bg-[var(--color-fundo-suave)] py-0.5 pl-2 pr-1 text-xs"
          >
            {endereco}
            <button
              type="button"
              onClick={() => onMudar(valores.filter((item) => item !== endereco))}
              aria-label={`Remover ${endereco}`}
              className="rounded px-1 text-[var(--color-texto-fraco)] transition hover:bg-[var(--color-hover-suave)] hover:text-[var(--color-perigo)]"
            >
              ×
            </button>
          </span>
        ))}

        <input
          type="text"
          value={rascunho}
          autoFocus={autoFocus}
          onChange={(evento) => setRascunho(evento.target.value)}
          onKeyDown={aoTeclar}
          onBlur={() => {
            // Sem isso, o endereco digitado e nao confirmado com Enter some ao
            // clicar em "Enviar" — e o cliente descobre pelo erro.
            if (rascunho.trim()) adicionar(rascunho);
          }}
          role="combobox"
          aria-expanded={aberto}
          aria-controls={idLista}
          aria-autocomplete="list"
          className="min-w-[12rem] flex-1 bg-transparent py-1 text-sm outline-none"
        />
      </div>

      {aberto && (
        <ul
          id={idLista}
          role="listbox"
          className="absolute left-16 top-full z-20 mt-1 w-80 overflow-hidden rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] shadow-lg"
        >
          {sugestoes.map((contato, indice) => (
            <li key={contato.address}>
              <button
                type="button"
                role="option"
                aria-selected={indice === destacado}
                onMouseDown={(evento) => {
                  // mousedown em vez de click: o blur do input dispara antes do
                  // click e fecharia a lista sem selecionar nada.
                  evento.preventDefault();
                  adicionar(contato.address);
                }}
                className={`block w-full px-3 py-2 text-left text-sm transition ${
                  indice === destacado ? "bg-[var(--color-fundo-suave)]" : "hover:bg-[var(--color-fundo-suave)]"
                }`}
              >
                {contato.name && <span className="font-medium">{contato.name} </span>}
                <span className="text-[var(--color-texto-fraco)]">{contato.address}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
