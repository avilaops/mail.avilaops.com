"use client";

import type { VisaoAgenda } from "@/lib/dataAgenda";

const VISOES: Array<{ id: VisaoAgenda; rotulo: string }> = [
  { id: "dia", rotulo: "Dia" },
  { id: "semana", rotulo: "Semana" },
  { id: "mes", rotulo: "Mês" },
  { id: "lista", rotulo: "Lista" },
];

export function NavegacaoVisoesAgenda({ visao, onMudar }: { visao: VisaoAgenda; onMudar: (visao: VisaoAgenda) => void }) {
  return (
    <nav aria-label="Visualização da agenda" className="grid grid-cols-4 border-b border-[var(--color-borda)] bg-[var(--color-superficie)] px-2 md:hidden">
      {VISOES.map((item) => (
        <button
          type="button"
          key={item.id}
          aria-current={visao === item.id ? "page" : undefined}
          onClick={() => onMudar(item.id)}
          className={`relative min-h-11 px-2 text-xs font-medium transition-colors ${visao === item.id ? "text-[var(--color-tinta)]" : "text-[var(--color-texto-fraco)]"}`}
        >
          {item.rotulo}
          {visao === item.id && <span aria-hidden="true" className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-[var(--color-realce)]" />}
        </button>
      ))}
    </nav>
  );
}
