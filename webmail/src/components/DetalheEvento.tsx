"use client";

import { useEffect, useRef } from "react";
import { recorrenciaEmPortugues, resumoRespostas } from "@/lib/detalheAgenda";
import { useFocoModal } from "@/lib/useFocoModal";
import type { EventoAgenda } from "@/lib/tipos";

function DescricaoComLinks({ texto }: { texto: string }) {
  return texto.split(/(https?:\/\/[^\s]+)/g).map((parte, indice) => /^https?:\/\//.test(parte)
    ? <a key={indice} href={parte} target="_blank" rel="noreferrer" className="text-[var(--color-realce)] underline">{parte}</a>
    : <span key={indice}>{parte}</span>);
}

interface Props {
  evento: EventoAgenda;
  onFechar: () => void;
  onEditar: () => void;
  onDuplicar: () => void;
  onExcluir: () => void;
  somenteLeitura?: boolean;
  fuso?: string;
}

export function DetalheEvento({ evento, onFechar, onEditar, onDuplicar, onExcluir, somenteLeitura = false, fuso = "America/Sao_Paulo" }: Props) {
  const modal = useRef<HTMLElement>(null);
  useFocoModal(modal);
  useEffect(() => {
    function aoTeclar(tecla: KeyboardEvent) {
      if (tecla.key === "Escape") onFechar();
      if (!somenteLeitura && tecla.key.toLowerCase() === "e" && !tecla.metaKey && !tecla.ctrlKey) onEditar();
      if (!somenteLeitura && tecla.key === "Delete") onExcluir();
    }
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [onEditar, onExcluir, onFechar, somenteLeitura]);

  const recorrencia = recorrenciaEmPortugues(evento.recorrencia);
  return (
    <div role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onFechar()} className="fixed inset-0 z-50 flex items-end bg-black/35 md:items-center md:justify-center md:p-4">
      <section ref={modal} role="dialog" aria-modal="true" aria-labelledby="titulo-detalhe-evento" className="max-h-[88dvh] w-full overflow-y-auto rounded-t-2xl border border-[var(--color-borda)] bg-[var(--color-superficie)] p-5 shadow-2xl md:max-w-md md:rounded-xl">
        <div className="flex items-start justify-between gap-4"><div><p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-texto-fraco)]">Evento</p><h2 id="titulo-detalhe-evento" className="text-xl font-semibold">{evento.titulo}</h2></div><button onClick={onFechar} aria-label="Fechar detalhe" className="rounded-md px-2 py-1 text-xl text-[var(--color-texto-fraco)] hover:bg-[var(--color-fundo-suave)]">×</button></div>
        <p className="mt-5 text-sm"><strong>{evento.diaInteiro ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeZone: "UTC" }).format(new Date(evento.inicio)) : new Intl.DateTimeFormat("pt-BR", { dateStyle: "full", timeStyle: "short", timeZone: fuso }).format(new Date(evento.inicio))}</strong></p>
        {!evento.diaInteiro && <p className="mt-1 text-sm text-[var(--color-texto-fraco)]">até {new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: fuso }).format(new Date(evento.fim))}</p>}
        {recorrencia && <p className="mt-3 text-sm text-[var(--color-texto-fraco)]">↻ {recorrencia}</p>}
        {evento.local && <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(evento.local)}`} target="_blank" rel="noreferrer" className="mt-4 block text-sm text-[var(--color-realce)] underline">{evento.local}</a>}
        {evento.descricao && <p className="mt-4 whitespace-pre-wrap break-words text-sm text-[var(--color-texto-fraco)]"><DescricaoComLinks texto={evento.descricao} /></p>}
        {evento.origem && <p className="mt-4 text-xs text-[var(--color-texto-fraco)]">Criado por {evento.linkOrigem ? <a href={evento.linkOrigem} target="_blank" rel="noreferrer" className="font-medium text-[var(--color-realce)] underline">{evento.origem}</a> : <strong>{evento.origem}</strong>}</p>}
        {evento.convidados.length > 0 && <section className="mt-5"><h3 className="text-xs font-semibold uppercase tracking-wide text-[var(--color-texto-fraco)]">Convidados</h3><p className="mt-2 text-sm font-medium">{resumoRespostas(evento.convidados)}</p><ul className="mt-2 space-y-1">{evento.convidados.map((convidado) => <li key={convidado.email} className="flex justify-between gap-3 text-sm"><span className="truncate">{convidado.nome || convidado.email}</span><span className="text-xs capitalize text-[var(--color-texto-fraco)]">{convidado.resposta}</span></li>)}</ul></section>}
        {!somenteLeitura && <div className="mt-6 grid grid-cols-3 gap-2"><button type="button" onClick={onEditar} className="rounded-lg bg-[var(--color-forte)] px-3 py-2 text-sm font-medium text-[var(--color-sobre-forte)]">Editar</button><button type="button" onClick={onDuplicar} className="rounded-lg border border-[var(--color-borda)] px-3 py-2 text-sm">Duplicar</button><button type="button" onClick={onExcluir} className="rounded-lg border border-[var(--color-perigo)] px-3 py-2 text-sm text-[var(--color-perigo)]">Excluir</button></div>}
      </section>
    </div>
  );
}
