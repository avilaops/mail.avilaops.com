"use client";

import { useEffect, useRef } from "react";

/**
 * Atalhos de teclado globais da caixa.
 *
 * Quem lê muito e-mail trabalha com as duas mãos no teclado; obrigar a ir ao
 * mouse para abrir a próxima mensagem é o que faz um webmail parecer lento
 * mesmo quando é rápido.
 */

export interface Atalho {
  tecla: string;
  descricao: string;
  acao: () => void;
}

/** Elementos onde a tecla pertence a quem está digitando, não ao atalho. */
function digitando(alvo: EventTarget | null): boolean {
  const elemento = alvo as HTMLElement | null;
  if (!elemento) return false;
  if (elemento.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(elemento.tagName);
}

export function useAtalhos(atalhos: Atalho[], ativo: boolean): void {
  // A lista muda de identidade a cada render. Guardar numa ref evita
  // reinscrever o ouvinte do documento sessenta vezes por segundo.
  const atual = useRef(atalhos);
  atual.current = atalhos;

  useEffect(() => {
    if (!ativo) return;

    function aoTeclar(evento: KeyboardEvent) {
      if (digitando(evento.target)) return;
      // Combinações com modificador pertencem ao navegador (Ctrl+F, Cmd+R…).
      if (evento.ctrlKey || evento.metaKey || evento.altKey) return;

      const escolhido = atual.current.find((atalho) => atalho.tecla === evento.key);
      if (!escolhido) return;

      evento.preventDefault();
      escolhido.acao();
    }

    document.addEventListener("keydown", aoTeclar);
    return () => document.removeEventListener("keydown", aoTeclar);
  }, [ativo]);
}
