"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const destinos = [
  { href: "/caixa", rotulo: "Mail" },
  { href: "/agenda", rotulo: "Agenda" },
] as const;

/** Alternancia persistente entre os dois instrumentos de trabalho da caixa. */
export function NavegacaoProduto({ agendaHabilitada = true }: { agendaHabilitada?: boolean }) {
  const caminho = usePathname();

  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b border-[var(--color-borda)] bg-[var(--color-superficie)] px-3 sm:px-4">
      <Link href="/caixa" className="flex items-center gap-2 rounded-md text-sm font-semibold tracking-tight focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[var(--color-realce)]">
        {/* eslint-disable-next-line @next/next/no-img-element -- icone local pequeno e estatico */}
        <img src="/favicon-96x96.png" alt="" width={24} height={24} className="h-6 w-6 rounded-md" />
        <span className="hidden sm:inline">Ávila Mail</span>
      </Link>

      <nav aria-label="Alternar produto" className="flex rounded-lg bg-[var(--color-fundo-suave)] p-1">
        {destinos.filter((destino) => destino.href !== "/agenda" || agendaHabilitada).map((destino) => {
          const ativo = caminho.startsWith(destino.href);
          return (
            <Link
              key={destino.href}
              href={destino.href}
              aria-current={ativo ? "page" : undefined}
              className={`min-w-20 rounded-md px-4 py-1.5 text-center text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-realce)] ${
                ativo
                  ? "bg-[var(--color-superficie)] text-[var(--color-tinta)] shadow-sm"
                  : "text-[var(--color-texto-fraco)] hover:text-[var(--color-tinta)]"
              }`}
            >
              {destino.rotulo}
            </Link>
          );
        })}
      </nav>

      <div className="w-6 sm:w-24" aria-hidden="true" />
    </header>
  );
}
