"use client";

import { useEffect, useRef, useState } from "react";
import { criarEventoAgenda } from "@/lib/cliente";
import { intervaloDiaInteiro, tituloDoEvento } from "@/lib/editorAgenda";
import type { EventoAgenda } from "@/lib/tipos";
import { civilParaInstante } from "@/lib/fusoAgenda";
import { dataCivil } from "@/lib/dataAgenda";

interface Props {
  inicio: Date;
  fim: Date;
  diaInteiro?: boolean;
  onCancelar: () => void;
  onCriado: (evento: EventoAgenda) => void;
  onMaisOpcoes: (titulo: string) => void;
  fuso: string;
  lembretePadrao: number;
  lembreteDiaInteiroPadrao: number;
}

function valorCivil(data: Date): string {
  return `${dataCivil(data)}T${String(data.getHours()).padStart(2, "0")}:${String(data.getMinutes()).padStart(2, "0")}`;
}

export function CriacaoRapida({ inicio, fim, diaInteiro = false, onCancelar, onCriado, onMaisOpcoes, fuso, lembretePadrao, lembreteDiaInteiroPadrao }: Props) {
  const [titulo, setTitulo] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const envioEmCurso = useRef(false);

  useEffect(() => input.current?.focus(), []);

  async function salvar() {
    if (envioEmCurso.current) return;
    envioEmCurso.current = true;
    setSalvando(true);
    setErro(null);
    try {
      const intervalo = diaInteiro
        ? intervaloDiaInteiro(dataCivil(inicio), dataCivil(fim))
        : { inicio: civilParaInstante(valorCivil(inicio), fuso).toISOString(), fim: civilParaInstante(valorCivil(fim), fuso).toISOString() };
      const evento = await criarEventoAgenda({
        titulo: tituloDoEvento(titulo),
        inicio: intervalo.inicio,
        fim: intervalo.fim,
        diaInteiro,
        fuso,
        lembretes: [{ minutosAntes: diaInteiro ? lembreteDiaInteiroPadrao : lembretePadrao }],
        convidados: [],
        disponibilidade: "ocupado",
      });
      onCriado(evento);
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Não foi possível criar o evento.");
    } finally {
      envioEmCurso.current = false;
      setSalvando(false);
    }
  }

  return (
    <div className="absolute left-1 right-1 top-full z-40 mt-1 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--color-borda)] bg-[var(--color-superficie)] p-3 text-[var(--color-tinta)] shadow-2xl" onPointerDown={(evento) => evento.stopPropagation()}>
      <input ref={input} maxLength={500} value={titulo} onChange={(evento) => setTitulo(evento.target.value)} onKeyDown={(evento) => { if (evento.key === "Enter") { evento.preventDefault(); void salvar(); } if (evento.key === "Escape") { evento.preventDefault(); onCancelar(); } }} placeholder="Adicionar título" className="w-full border-b border-[var(--color-borda)] bg-transparent px-1 py-2 text-sm outline-none focus:border-[var(--color-realce)]" />
      <p className="mt-2 text-xs text-[var(--color-texto-fraco)]">{diaInteiro ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "full" }).format(inicio) : `${new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }).format(inicio)} – ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(fim)}`}</p>
      {erro && <p role="alert" className="mt-2 text-xs text-[var(--color-perigo)]">{erro}</p>}
      <div className="mt-3 flex justify-end gap-2"><button type="button" onClick={() => onMaisOpcoes(titulo)} className="rounded-md px-2.5 py-1.5 text-xs hover:bg-[var(--color-fundo-suave)]">Mais opções</button><button type="button" disabled={salvando} onClick={() => void salvar()} className="rounded-md bg-[var(--color-forte)] px-3 py-1.5 text-xs font-medium text-[var(--color-sobre-forte)] disabled:opacity-50">{salvando ? "Salvando…" : "Salvar"}</button></div>
    </div>
  );
}
