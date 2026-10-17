"use client";

import { useEffect, type RefObject } from "react";

const SELETOR_FOCO = "button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])";

export function useFocoModal(referencia: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const anterior = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const modal = referencia.current;
    const focaveis = () => modal ? [...modal.querySelectorAll<HTMLElement>(SELETOR_FOCO)] : [];
    focaveis()[0]?.focus();
    function conterFoco(evento: KeyboardEvent) {
      if (evento.key !== "Tab") return;
      const itens = focaveis();
      if (itens.length === 0) { evento.preventDefault(); return; }
      const primeiro = itens[0]!;
      const ultimo = itens.at(-1)!;
      if (evento.shiftKey && document.activeElement === primeiro) { evento.preventDefault(); ultimo.focus(); }
      else if (!evento.shiftKey && document.activeElement === ultimo) { evento.preventDefault(); primeiro.focus(); }
    }
    document.addEventListener("keydown", conterFoco);
    return () => { document.removeEventListener("keydown", conterFoco); anterior?.focus(); };
  }, [referencia]);
}
