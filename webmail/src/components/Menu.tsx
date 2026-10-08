"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface ItemDeMenu {
  chave: string;
  rotulo: string;
  /** Marca a opcao em uso, quando o menu representa uma escolha. */
  ativo?: boolean;
  perigo?: boolean;
  onEscolher?: () => void;
  /** Item que e download: o navegador baixa direto, sem fetch. */
  href?: string;
  download?: string;
}

interface Props {
  /** Nome acessivel e dica do gatilho. */
  titulo: string;
  gatilho: ReactNode;
  classeGatilho: string;
  itens: ItemDeMenu[];
  alinhar?: "esquerda" | "direita";
}

/**
 * Menu suspenso pequeno, para acao que nao merece lugar fixo na barra.
 *
 * Fecha com Esc, com clique fora e quando a janela perde o foco. O ultimo caso
 * existe por causa do leitor: o corpo do e-mail e um iframe, e clique dentro
 * dele nao chega ao documento de fora — sem isso o menu ficava aberto por cima
 * da mensagem.
 */
export function Menu({ titulo, gatilho, classeGatilho, itens, alinhar = "esquerda" }: Props) {
  const [aberto, setAberto] = useState(false);
  const raiz = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aberto) return;

    const fora = (evento: MouseEvent) => {
      if (!raiz.current?.contains(evento.target as Node)) setAberto(false);
    };
    const tecla = (evento: KeyboardEvent) => {
      if (evento.key === "Escape") setAberto(false);
    };
    const fechar = () => setAberto(false);

    document.addEventListener("mousedown", fora);
    document.addEventListener("keydown", tecla);
    window.addEventListener("blur", fechar);
    return () => {
      document.removeEventListener("mousedown", fora);
      document.removeEventListener("keydown", tecla);
      window.removeEventListener("blur", fechar);
    };
  }, [aberto]);

  const classeItem = (item: ItemDeMenu) =>
    `flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-xs transition hover:bg-[var(--color-hover-suave)] ${
      item.perigo ? "text-[var(--color-perigo)]" : ""
    } ${item.ativo ? "font-semibold text-[var(--color-realce)]" : ""}`;

  return (
    <div ref={raiz} className="relative">
      <button
        type="button"
        onClick={() => setAberto((atual) => !atual)}
        aria-haspopup="menu"
        aria-expanded={aberto}
        aria-label={titulo}
        title={titulo}
        className={classeGatilho}
      >
        {gatilho}
      </button>

      {aberto && (
        <div
          role="menu"
          aria-label={titulo}
          className={`absolute top-full z-30 mt-1 min-w-44 rounded-md border border-[var(--color-borda)] bg-[var(--color-superficie)] py-1 shadow-lg ${
            alinhar === "direita" ? "right-0" : "left-0"
          }`}
        >
          {itens.map((item) =>
            item.href ? (
              <a
                key={item.chave}
                role="menuitem"
                href={item.href}
                download={item.download}
                onClick={() => setAberto(false)}
                className={classeItem(item)}
              >
                {item.rotulo}
              </a>
            ) : (
              <button
                key={item.chave}
                type="button"
                role="menuitem"
                onClick={() => {
                  setAberto(false);
                  item.onEscolher?.();
                }}
                className={classeItem(item)}
              >
                {item.rotulo}
                {item.ativo && <span aria-hidden>✓</span>}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
