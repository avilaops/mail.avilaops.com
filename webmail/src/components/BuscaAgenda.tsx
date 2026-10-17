"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { buscarEventosAgenda } from "@/lib/cliente";
import { useFocoModal } from "@/lib/useFocoModal";
import type { EventoAgenda } from "@/lib/tipos";
import { dataCivil } from "@/lib/dataAgenda";
import { intervaloDestaque } from "@/lib/buscaAgenda";

function Destacar({ texto, termo }: { texto: string; termo: string }) {
  const intervalo = intervaloDestaque(texto, termo);
  if (!intervalo) return <>{texto}</>;
  return <>{texto.slice(0, intervalo.inicio)}<mark className="bg-yellow-200 text-inherit">{texto.slice(intervalo.inicio, intervalo.fim)}</mark>{texto.slice(intervalo.fim)}</>;
}

export function BuscaAgenda({ onFechar, onEvento }: { onFechar: () => void; onEvento: (evento: EventoAgenda) => void }) {
  const modal = useRef<HTMLDivElement>(null);
  useFocoModal(modal);
  const [consulta, setConsulta] = useState("");
  const [resultados, setResultados] = useState<EventoAgenda[]>([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const geracao = useRef(0);
  const grupos = useMemo(() => {
    const mapa = new Map<string, EventoAgenda[]>();
    for (const evento of [...resultados].sort((a, b) => a.inicio.localeCompare(b.inicio))) {
      const dia = evento.diaInteiro ? evento.inicio.slice(0, 10) : dataCivil(new Date(evento.inicio));
      mapa.set(dia, [...(mapa.get(dia) ?? []), evento]);
    }
    return [...mapa.entries()];
  }, [resultados]);

  useEffect(() => {
    const carga = ++geracao.current;
    const termo = consulta.trim();
    if (!termo) { setResultados([]); setErro(null); setCarregando(false); return; }
    const timer = window.setTimeout(() => {
      setCarregando(true);
      void buscarEventosAgenda(termo)
        .then((eventos) => { if (carga === geracao.current) { setResultados(eventos); setErro(null); } })
        .catch((falha) => { if (carga === geracao.current) setErro(falha instanceof Error ? falha.message : "Não foi possível buscar."); })
        .finally(() => { if (carga === geracao.current) setCarregando(false); });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [consulta]);

  useEffect(() => {
    const fechar = (evento: KeyboardEvent) => { if (evento.key === "Escape") onFechar(); };
    window.addEventListener("keydown", fechar);
    return () => window.removeEventListener("keydown", fechar);
  }, [onFechar]);

  return <div role="presentation" className="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 p-4 pt-[10vh]" onMouseDown={(evento) => evento.target === evento.currentTarget && onFechar()}><div ref={modal} role="dialog" aria-modal="true" aria-label="Buscar na agenda" className="w-full max-w-lg rounded-xl bg-[var(--color-superficie)] p-4 shadow-2xl"><input autoFocus type="search" value={consulta} onChange={(evento) => setConsulta(evento.target.value)} placeholder="Buscar eventos" className="w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-fundo)] px-3 py-2" />{carregando && <p className="mt-3 text-xs text-[var(--color-texto-fraco)]">Buscando…</p>}{erro && <p role="alert" className="mt-3 text-xs text-[var(--color-perigo)]">{erro}</p>}<div className="mt-3 max-h-[60dvh] overflow-y-auto">{!carregando && consulta.trim() && resultados.length === 0 && !erro && <p className="py-4 text-sm text-[var(--color-texto-fraco)]">Nenhum evento encontrado.</p>}{grupos.map(([dia, eventos]) => <section key={dia}><h3 className="sticky top-0 border-b border-[var(--color-borda)] bg-[var(--color-superficie)] py-2 text-xs font-semibold capitalize">{new Intl.DateTimeFormat("pt-BR", { dateStyle: "full" }).format(new Date(`${dia}T12:00:00`))}</h3>{eventos.map((evento) => <button key={evento.id} onClick={() => { onEvento(evento); onFechar(); }} className="block w-full border-b border-[var(--color-borda)] px-2 py-3 text-left hover:bg-[var(--color-fundo-suave)]"><strong className="block truncate text-sm"><Destacar texto={evento.titulo} termo={consulta.trim()} /></strong>{evento.local && <span className="block truncate text-xs text-[var(--color-texto-fraco)]"><Destacar texto={evento.local} termo={consulta.trim()} /></span>}<span className="text-xs text-[var(--color-texto-fraco)]">{evento.diaInteiro ? "Dia inteiro" : new Intl.DateTimeFormat("pt-BR", { timeStyle: "short" }).format(new Date(evento.inicio))}</span>{evento.descricao && <span className="mt-1 block truncate text-xs text-[var(--color-texto-fraco)]"><Destacar texto={evento.descricao} termo={consulta.trim()} /></span>}</button>)}</section>)}</div><button onClick={onFechar} className="mt-4 rounded-lg px-3 py-2 text-sm hover:bg-[var(--color-fundo-suave)]">Fechar</button></div></div>;
}
