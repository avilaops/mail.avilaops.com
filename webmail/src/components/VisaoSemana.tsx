"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { dataCivil, inicioDaSemana } from "@/lib/dataAgenda";
import { CriacaoRapida } from "@/components/CriacaoRapida";
import { eventoVaiParaFaixa, posicionarEventos } from "@/lib/layoutAgenda";
import { moverIntervalo, redimensionarFim } from "@/lib/arrasteAgenda";
import type { EventoAgenda } from "@/lib/tipos";

const ALTURA_HORA = 64;
const ALTURA_DIA = 24 * ALTURA_HORA;

interface Props {
  data: Date;
  dias: 1 | 7;
  eventos: EventoAgenda[];
  onMaisOpcoes: (inicio: Date, fim: Date, titulo: string) => void;
  onCriado: (evento: EventoAgenda) => void;
  onEvento: (evento: EventoAgenda) => void;
  somenteLeitura?: boolean;
  onAlterar: (evento: EventoAgenda, inicio: Date, fim: Date) => void;
  primeiroDia?: 0 | 1;
  expedienteInicio?: string;
  expedienteFim?: string;
  fuso?: string;
  lembretePadrao?: number;
  lembreteDiaInteiroPadrao?: number;
}

export function VisaoSemana({ data, dias, eventos, onMaisOpcoes, onCriado, onEvento, onAlterar, somenteLeitura = false, primeiroDia = 0, expedienteInicio = "09:00", expedienteFim = "18:00", fuso = "America/Sao_Paulo", lembretePadrao = 10, lembreteDiaInteiroPadrao = 1440 }: Props) {
  const rolagem = useRef<HTMLDivElement>(null);
  const [agora, setAgora] = useState(() => new Date());
  const [selecao, setSelecao] = useState<{ dia: Date; inicio: number; fim: number } | null>(null);
  const arraste = useRef<{ dia: Date; inicio: number } | null>(null);
  const arrasteEvento = useRef<{ evento: EventoAgenda; modo: "mover" | "redimensionar"; x: number; y: number; larguraDia: number; ativo: boolean; timer?: number; dias: number; minutos: number } | null>(null);
  const [previsao, setPrevisao] = useState<{ id: string; modo: "mover" | "redimensionar"; dias: number; minutos: number } | null>(null);
  const ignorarClique = useRef(false);
  const primeiro = useMemo(() => dias === 7 ? inicioDaSemana(data, primeiroDia) : new Date(data.getFullYear(), data.getMonth(), data.getDate()), [data, dias, primeiroDia]);
  const minutoExpediente = (valor: string) => { const [hora, minuto] = valor.split(":").map(Number); return (hora ?? 0) * 60 + (minuto ?? 0); };
  const inicioExpediente = minutoExpediente(expedienteInicio);
  const fimExpediente = minutoExpediente(expedienteFim);
  const colunas = useMemo(() => Array.from({ length: dias }, (_, indice) => {
    const dia = new Date(primeiro);
    dia.setDate(dia.getDate() + indice);
    return dia;
  }), [dias, primeiro]);
  const posicionados = useMemo(() => posicionarEventos(eventos, fuso), [eventos, fuso]);
  const faixa = eventos.filter((evento) => eventoVaiParaFaixa(evento, fuso));

  useEffect(() => {
    if (rolagem.current) rolagem.current.scrollTop = Math.max(0, inicioExpediente - 60) * ALTURA_HORA / 60;
    const timer = window.setInterval(() => setAgora(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, [data, dias, inicioExpediente]);

  return (
    <section className="h-full min-h-0 overflow-x-auto overflow-y-hidden" aria-label={dias === 7 ? "Agenda da semana" : "Agenda do dia"}>
      <div className="flex h-full min-h-0 flex-col" style={{ minWidth: dias === 7 ? "52rem" : "100%" }}>
      <div className="grid shrink-0 border-b border-[var(--color-borda)] bg-[var(--color-fundo)]" style={{ gridTemplateColumns: `4rem repeat(${dias}, minmax(7rem, 1fr))` }}>
        <div />
        {colunas.map((dia) => <div key={dataCivil(dia)} className="border-l border-[var(--color-borda)] px-2 py-2 text-center"><span className="text-[10px] font-semibold uppercase text-[var(--color-texto-fraco)]">{new Intl.DateTimeFormat("pt-BR", { weekday: "short" }).format(dia)}</span><strong className="ml-1 text-sm">{dia.getDate()}</strong></div>)}
      </div>
      {faixa.length > 0 && (
        <div className="grid shrink-0 border-b border-[var(--color-borda)] bg-[var(--color-fundo-suave)]" style={{ gridTemplateColumns: `4rem repeat(${dias}, minmax(7rem, 1fr))` }}>
          <div className="px-2 py-2 text-right text-[10px] text-[var(--color-texto-fraco)]">dia inteiro</div>
          {colunas.map((dia) => (
            <div key={dataCivil(dia)} className="min-h-9 border-l border-[var(--color-borda)] p-1">
              {faixa.filter((evento) => new Date(evento.inicio) < new Date(dia.getFullYear(), dia.getMonth(), dia.getDate() + 1) && new Date(evento.fim) > dia).map((evento) => (
                <button key={`${evento.id}:${evento.recorrenciaId ?? evento.inicio}`} onClick={() => onEvento(evento)} style={{ backgroundColor: evento.cor ?? "var(--color-realce)" }} className="mb-1 block w-full truncate rounded px-2 py-1 text-left text-xs font-medium text-white">{evento.titulo}</button>
              ))}
            </div>
          ))}
        </div>
      )}
      <div ref={rolagem} className="rolagem-fina min-h-0 flex-1 overflow-auto">
        <div className="grid min-w-max md:min-w-0" style={{ height: ALTURA_DIA, gridTemplateColumns: `4rem repeat(${dias}, minmax(7rem, 1fr))` }}>
          <div className="relative">
            {Array.from({ length: 24 }, (_, hora) => <span key={hora} className="absolute right-2 -translate-y-1/2 text-[10px] text-[var(--color-texto-fraco)]" style={{ top: hora * ALTURA_HORA }}>{String(hora).padStart(2, "0")}:00</span>)}
          </div>
          {colunas.map((dia) => {
            const chave = dataCivil(dia);
            const hoje = chave === dataCivil(agora);
            const minutosAgora = agora.getHours() * 60 + agora.getMinutes();
            return (
              <div
                key={chave}
                className="relative border-l border-[var(--color-borda)]"
                onPointerDown={(evento) => {
                  if (evento.target !== evento.currentTarget) return;
                  if (somenteLeitura) return;
                  evento.currentTarget.setPointerCapture(evento.pointerId);
                  const minutos = Math.max(0, Math.min(23 * 60 + 30, Math.floor(evento.nativeEvent.offsetY / (ALTURA_HORA / 2)) * 30));
                  arraste.current = { dia, inicio: minutos };
                  setSelecao(null);
                }}
                onPointerUp={(evento) => {
                  const atual = arraste.current;
                  if (!atual) return;
                  const solto = Math.max(0, Math.min(24 * 60, Math.ceil(evento.nativeEvent.offsetY / (ALTURA_HORA / 2)) * 30));
                  setSelecao({ dia: atual.dia, inicio: Math.min(atual.inicio, Math.max(0, solto - 30)), fim: Math.max(atual.inicio + 30, solto) });
                  arraste.current = null;
                }}
                tabIndex={0}
                aria-label={`Criar evento em ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "full" }).format(dia)}`}
                onKeyDown={(evento) => { if (!somenteLeitura && (evento.key === "Enter" || evento.key === " ")) { evento.preventDefault(); setSelecao({ dia, inicio: 9 * 60, fim: 9 * 60 + 30 }); } }}
                style={{ backgroundImage: "linear-gradient(to bottom, var(--color-borda) 1px, transparent 1px)", backgroundSize: `100% ${ALTURA_HORA / 2}px` }}
              >
                <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bg-[var(--color-fundo-suave)]/55" style={{ top: 0, height: inicioExpediente * ALTURA_HORA / 60 }} />
                <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bg-[var(--color-fundo-suave)]/55" style={{ top: fimExpediente * ALTURA_HORA / 60, bottom: 0 }} />
                {hoje && <div aria-label="Horário atual" className="pointer-events-none absolute z-20 h-px bg-[var(--color-perigo)]" style={{ top: minutosAgora * ALTURA_HORA / 60, left: 0, right: 0 }}><span className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-[var(--color-perigo)]" /></div>}
                {posicionados.filter((item) => item.dia === chave).map((item) => (
                  <button
                    key={`${item.evento.id}:${item.evento.recorrenciaId ?? item.evento.inicio}`}
                    onClick={(evento) => { evento.stopPropagation(); if (ignorarClique.current) { ignorarClique.current = false; return; } onEvento(item.evento); }}
                    onPointerDown={(ponteiro) => {
                      if (somenteLeitura) return;
                      ponteiro.stopPropagation();
                      const elemento = ponteiro.currentTarget;
                      const pointerId = ponteiro.pointerId;
                      const estado = { evento: item.evento, modo: "mover" as const, x: ponteiro.clientX, y: ponteiro.clientY, larguraDia: elemento.parentElement?.getBoundingClientRect().width ?? 1, ativo: ponteiro.pointerType !== "touch", dias: 0, minutos: 0, timer: undefined as number | undefined };
                      if (ponteiro.pointerType === "touch") estado.timer = window.setTimeout(() => { estado.ativo = true; elemento.setPointerCapture(pointerId); }, 450);
                      else ponteiro.currentTarget.setPointerCapture(ponteiro.pointerId);
                      arrasteEvento.current = estado;
                    }}
                    onPointerMove={(ponteiro) => {
                      const estado = arrasteEvento.current;
                      if (!estado?.ativo) return;
                      ponteiro.preventDefault();
                      estado.dias = Math.round((ponteiro.clientX - estado.x) / estado.larguraDia);
                      estado.minutos = Math.round(((ponteiro.clientY - estado.y) * 60 / ALTURA_HORA) / 15) * 15;
                      setPrevisao({ id: estado.evento.id, modo: estado.modo, dias: estado.dias, minutos: estado.minutos });
                    }}
                    onPointerUp={(ponteiro) => {
                      const estado = arrasteEvento.current;
                      if (!estado) return;
                      if (estado.timer) window.clearTimeout(estado.timer);
                      arrasteEvento.current = null;
                      setPrevisao(null);
                      if (!estado.ativo || (estado.dias === 0 && estado.minutos === 0)) return;
                      ponteiro.preventDefault();
                      ignorarClique.current = true;
                      const inicioAtual = new Date(estado.evento.inicio);
                      const fimAtual = new Date(estado.evento.fim);
                      if (estado.modo === "mover") { const novo = moverIntervalo(inicioAtual, fimAtual, estado.dias, estado.minutos); onAlterar(estado.evento, novo.inicio, novo.fim); }
                      else onAlterar(estado.evento, inicioAtual, redimensionarFim(inicioAtual, fimAtual, estado.minutos));
                    }}
                    onPointerCancel={() => { const estado = arrasteEvento.current; if (estado?.timer) window.clearTimeout(estado.timer); arrasteEvento.current = null; setPrevisao(null); }}
                    className="absolute z-10 overflow-hidden rounded-md border-l-4 border-blue-700 bg-blue-100 px-1.5 py-1 text-left text-[11px] text-blue-950 shadow-sm dark:bg-blue-950 dark:text-blue-100"
                    style={{ top: item.inicioMinutos * ALTURA_HORA / 60, height: Math.max(18, item.duracaoMinutos * ALTURA_HORA / 60 + (previsao?.id === item.evento.id && previsao.modo === "redimensionar" ? previsao.minutos * ALTURA_HORA / 60 : 0)), left: `calc(${item.coluna * 100 / item.totalColunas}% + 2px)`, width: `calc(${100 / item.totalColunas}% - 4px)`, transform: previsao?.id === item.evento.id && previsao.modo === "mover" ? `translate(${previsao.dias * 100}%, ${previsao.minutos * ALTURA_HORA / 60}px)` : undefined, touchAction: "pan-y", borderLeftColor: item.evento.cor ?? "var(--color-realce)" }}
                    title={item.evento.titulo}
                    aria-label={`${item.evento.titulo}, ${new Intl.DateTimeFormat("pt-BR", { weekday: "long", timeZone: fuso }).format(new Date(item.evento.inicio))}, ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: fuso }).format(new Date(item.evento.inicio))} às ${new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: fuso }).format(new Date(item.evento.fim))}`}
                  >
                    <strong className="block truncate">{item.evento.titulo}</strong>
                    <span>{new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: fuso }).format(new Date(item.evento.inicio))}</span>
                    <span aria-label="Redimensionar evento" onPointerDown={(ponteiro) => { if (somenteLeitura) return; ponteiro.stopPropagation(); const elemento = ponteiro.currentTarget; const pointerId = ponteiro.pointerId; const estado = { evento: item.evento, modo: "redimensionar" as const, x: ponteiro.clientX, y: ponteiro.clientY, larguraDia: 1, ativo: ponteiro.pointerType !== "touch", dias: 0, minutos: 0, timer: undefined as number | undefined }; if (ponteiro.pointerType === "touch") estado.timer = window.setTimeout(() => { estado.ativo = true; elemento.setPointerCapture(pointerId); }, 450); else elemento.setPointerCapture(pointerId); arrasteEvento.current = estado; }} className="absolute inset-x-0 bottom-0 h-2 cursor-ns-resize" />
                  </button>
                ))}
                {selecao && dataCivil(selecao.dia) === chave && (() => {
                  const inicio = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), Math.floor(selecao.inicio / 60), selecao.inicio % 60);
                  const fim = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate(), Math.floor(selecao.fim / 60), selecao.fim % 60);
                  return <div className="absolute left-1 right-1 z-30 rounded-md border-l-4 border-[var(--color-realce)] bg-blue-100/95 px-2 py-1 text-xs text-blue-950 shadow-sm" style={{ top: selecao.inicio * ALTURA_HORA / 60, height: Math.max(32, (selecao.fim - selecao.inicio) * ALTURA_HORA / 60) }}><span className="font-medium">Novo evento</span><CriacaoRapida inicio={inicio} fim={fim} fuso={fuso} lembretePadrao={lembretePadrao} lembreteDiaInteiroPadrao={lembreteDiaInteiroPadrao} onCancelar={() => setSelecao(null)} onCriado={(evento) => { setSelecao(null); onCriado(evento); }} onMaisOpcoes={(titulo) => { setSelecao(null); onMaisOpcoes(inicio, fim, titulo); }} /></div>;
                })()}
              </div>
            );
          })}
        </div>
      </div>
      </div>
    </section>
  );
}
