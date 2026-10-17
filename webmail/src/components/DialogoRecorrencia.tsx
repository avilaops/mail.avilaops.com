"use client";

import { useEffect, useRef } from "react";
import { useFocoModal } from "@/lib/useFocoModal";

export type EscopoRecorrencia = "this" | "following" | "all";

export function DialogoRecorrencia({ acao, onEscolher, onCancelar }: { acao: "editar" | "mover" | "excluir"; onEscolher: (escopo: EscopoRecorrencia) => void; onCancelar: () => void }) {
  const modal = useRef<HTMLElement>(null);
  useFocoModal(modal);
  useEffect(() => {
    const fechar = (evento: KeyboardEvent) => { if (evento.key === "Escape") onCancelar(); };
    window.addEventListener("keydown", fechar);
    return () => window.removeEventListener("keydown", fechar);
  }, [onCancelar]);
  return <div role="presentation" onMouseDown={(evento) => evento.target === evento.currentTarget && onCancelar()} className="fixed inset-0 z-[70] grid place-items-center bg-black/40 p-4">
    <section ref={modal} role="dialog" aria-modal="true" aria-labelledby="titulo-escopo-recorrencia" className="w-full max-w-sm rounded-xl border border-[var(--color-borda)] bg-[var(--color-superficie)] p-5 shadow-2xl">
      <h2 id="titulo-escopo-recorrencia" className="text-lg font-semibold">{acao === "excluir" ? "Excluir evento recorrente" : acao === "mover" ? "Mover evento recorrente" : "Editar evento recorrente"}</h2>
      <p className="mt-1 text-sm text-[var(--color-texto-fraco)]">Qual parte da série deve mudar?</p>
      <div className="mt-5 grid gap-2">
        <button type="button" onClick={() => onEscolher("this")} className="rounded-lg border border-[var(--color-borda)] px-4 py-2.5 text-left text-sm hover:bg-[var(--color-fundo-suave)]">Somente este evento</button>
        <button type="button" onClick={() => onEscolher("following")} className="rounded-lg border border-[var(--color-borda)] px-4 py-2.5 text-left text-sm hover:bg-[var(--color-fundo-suave)]">Este e os seguintes</button>
        <button type="button" onClick={() => onEscolher("all")} className="rounded-lg border border-[var(--color-borda)] px-4 py-2.5 text-left text-sm hover:bg-[var(--color-fundo-suave)]">Todos os eventos</button>
      </div>
      <button type="button" onClick={onCancelar} className="mt-4 w-full rounded-lg px-4 py-2 text-sm hover:bg-[var(--color-fundo-suave)]">Cancelar</button>
    </section>
  </div>;
}
