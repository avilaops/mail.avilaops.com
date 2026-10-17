import type { EventoAgenda } from "@/lib/tipos";

function formatarHorario(evento: EventoAgenda): string {
  if (evento.diaInteiro) return "Dia inteiro";
  return new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(new Date(evento.inicio));
}

/** Linha compartilhada pela tela e pelo teste de renderizacao segura. */
export function EventoNaAgenda({ evento }: { evento: EventoAgenda }) {
  return (
    <li className="relative pb-7 pl-7 last:pb-0">
      <span className="absolute -left-[7px] top-1.5 h-3 w-3 rounded-full border-2 border-[var(--color-fundo)]" style={{ backgroundColor: evento.cor ?? "var(--color-realce)" }} />
      <time className="text-xs font-medium text-[var(--color-texto-fraco)]">
        {new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "2-digit", month: "short" }).format(new Date(evento.inicio))}
        {" · "}{formatarHorario(evento)}
      </time>
      <h2 className="mt-1 text-base font-medium text-[var(--color-tinta)]">{evento.titulo}</h2>
      {evento.local && <p className="mt-0.5 text-sm text-[var(--color-texto-fraco)]">{evento.local}</p>}
      {evento.descricao && <p className="mt-1 line-clamp-2 text-sm text-[var(--color-texto-fraco)]">{evento.descricao}</p>}
    </li>
  );
}
