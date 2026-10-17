"use client";

import { useEffect, useRef } from "react";
import type { Atalho } from "@/lib/atalhos";
import { useFocoModal } from "@/lib/useFocoModal";

export function AjudaAtalhosAgenda({ atalhos, onFechar }: { atalhos: Atalho[]; onFechar: () => void }) {
  const modal = useRef<HTMLDivElement>(null);
  useFocoModal(modal);
  useEffect(() => { const fechar = (evento: KeyboardEvent) => { if (evento.key === "Escape") onFechar(); }; window.addEventListener("keydown", fechar); return () => window.removeEventListener("keydown", fechar); }, [onFechar]);
  return <div role="presentation" className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-6" onMouseDown={(evento) => evento.target === evento.currentTarget && onFechar()}><div ref={modal} role="dialog" aria-modal="true" aria-label="Atalhos de teclado" className="max-h-[80dvh] w-full max-w-sm overflow-y-auto rounded-xl bg-[var(--color-superficie)] p-6 shadow-2xl"><h2 className="mb-4 font-semibold">Atalhos da agenda</h2><dl className="space-y-1.5">{atalhos.filter((atalho) => atalho.tecla !== "Escape").map((atalho) => <div key={atalho.tecla} className="flex items-baseline justify-between gap-4"><dt className="text-sm text-[var(--color-texto-fraco)]">{atalho.descricao}</dt><dd><kbd className="rounded border border-[var(--color-borda)] bg-[var(--color-fundo-suave)] px-1.5 py-0.5 font-mono text-xs">{atalho.tecla}</kbd></dd></div>)}</dl><div className="mt-3 border-t border-[var(--color-borda)] pt-3 text-xs text-[var(--color-texto-fraco)]">No detalhe: E edita, Del exclui e Esc fecha.</div><button autoFocus onClick={onFechar} className="mt-5 w-full rounded-lg bg-[var(--color-forte)] px-4 py-2 text-sm text-[var(--color-sobre-forte)]">Fechar</button></div></div>;
}
