"use client";

import { useMemo, useRef, useState } from "react";
import { CriacaoRapida } from "@/components/CriacaoRapida";
import { dataCivil, diasDaGradeMes, diferencaDiasCivis } from "@/lib/dataAgenda";
import type { EventoAgenda } from "@/lib/tipos";
import { moverParaDia } from "@/lib/arrasteAgenda";
import { civilParaInstante, partesNoFuso } from "@/lib/fusoAgenda";

const NOMES_DIAS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function instanteDoDia(dia: Date, fuso: string): Date {
  return civilParaInstante(`${dataCivil(dia)}T00:00`, fuso);
}

function eventosNoDia(eventos: EventoAgenda[], dia: Date, fuso: string): EventoAgenda[] {
  const inicio = instanteDoDia(dia, fuso);
  const proximo = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate() + 1);
  const fim = instanteDoDia(proximo, fuso);
  const chave = dataCivil(dia);
  return eventos
    .filter((evento) => evento.diaInteiro ? evento.inicio.slice(0, 10) <= chave && evento.fim.slice(0, 10) > chave : new Date(evento.inicio) < fim && new Date(evento.fim) > inicio)
    .sort((a, b) => Number(b.diaInteiro) - Number(a.diaInteiro) || a.inicio.localeCompare(b.inicio));
}

function chaveEvento(evento: EventoAgenda): string {
  return `${evento.id}:${evento.recorrenciaId ?? evento.inicio}`;
}

interface FaixaSemanal {
  evento: EventoAgenda;
  faixa: number;
  primeiroDia: number;
  ultimoDia: number;
}

function faixasDaSemana(eventos: EventoAgenda[], dias: Date[], fuso: string): FaixaSemanal[] {
  const primeiro = dias[0];
  if (!primeiro) return [];
  const inicioSemana = new Date(primeiro.getFullYear(), primeiro.getMonth(), primeiro.getDate());
  const fimCivil = new Date(inicioSemana.getFullYear(), inicioSemana.getMonth(), inicioSemana.getDate() + 7);
  const inicioInstante = instanteDoDia(inicioSemana, fuso);
  const fimSemana = instanteDoDia(fimCivil, fuso);
  const ocupadas = Array.from({ length: 3 }, () => Array<boolean>(7).fill(false));

  return eventos
    .filter((evento) => new Date(evento.inicio) < fimSemana && new Date(evento.fim) > inicioInstante)
    .sort((a, b) => {
      const inicio = a.inicio.localeCompare(b.inicio);
      if (inicio !== 0) return inicio;
      return new Date(b.fim).getTime() - new Date(a.fim).getTime();
    })
    .flatMap((evento) => {
      const inicioBruto = new Date(evento.inicio);
      const fimBruto = new Date(new Date(evento.fim).getTime() - 1);
      const inicioPartes = partesNoFuso(inicioBruto, fuso);
      const fimPartes = partesNoFuso(fimBruto, fuso);
      const inicioEvento = evento.diaInteiro ? new Date(`${evento.inicio.slice(0, 10)}T12:00:00`) : new Date(inicioPartes.ano, inicioPartes.mes - 1, inicioPartes.dia);
      const fimDiaInteiro = new Date(`${evento.fim.slice(0, 10)}T12:00:00`);
      fimDiaInteiro.setDate(fimDiaInteiro.getDate() - 1);
      const ultimoInstante = evento.diaInteiro ? fimDiaInteiro : new Date(fimPartes.ano, fimPartes.mes - 1, fimPartes.dia);
      const primeiroDia = Math.max(0, diferencaDiasCivis(inicioSemana, inicioEvento));
      const ultimoDia = Math.min(6, diferencaDiasCivis(inicioSemana, ultimoInstante));
      const faixa = ocupadas.findIndex((diasOcupados) => {
        for (let dia = primeiroDia; dia <= ultimoDia; dia += 1) if (diasOcupados[dia]) return false;
        return true;
      });
      if (faixa < 0) return [];
      const diasOcupados = ocupadas[faixa];
      if (!diasOcupados) return [];
      for (let dia = primeiroDia; dia <= ultimoDia; dia += 1) diasOcupados[dia] = true;
      return [{ evento, faixa, primeiroDia, ultimoDia }];
    });
}

interface Props {
  data: Date;
  eventos: EventoAgenda[];
  onDia: (dia: Date) => void;
  onEvento: (evento: EventoAgenda) => void;
  onCriado: (evento: EventoAgenda) => void;
  onMaisOpcoes: (inicio: Date, fim: Date, titulo: string, diaInteiro: boolean) => void;
  somenteLeitura?: boolean;
  onAlterar: (evento: EventoAgenda, inicio: Date, fim: Date) => void;
  primeiroDia?: 0 | 1;
  fuso?: string;
  lembretePadrao?: number;
  lembreteDiaInteiroPadrao?: number;
}

export function VisaoMes({ data, eventos, onDia, onEvento, onCriado, onMaisOpcoes, onAlterar, somenteLeitura = false, primeiroDia = 0, fuso = "America/Sao_Paulo", lembretePadrao = 10, lembreteDiaInteiroPadrao = 1440 }: Props) {
  const dias = useMemo(() => diasDaGradeMes(data, primeiroDia), [data, primeiroDia]);
  const nomesDias = primeiroDia === 1 ? [...NOMES_DIAS.slice(1), NOMES_DIAS[0]!] : NOMES_DIAS;
  const [expandido, setExpandido] = useState<string | null>(null);
  const [criacao, setCriacao] = useState<string | null>(null);
  const arrasteEvento = useRef<{ evento: EventoAgenda; ativo: boolean; timer?: number } | null>(null);
  const ignorarClique = useRef(false);
  const hoje = dataCivil(new Date());
  const linhas = dias.length / 7;
  const faixas = useMemo(() => Array.from({ length: linhas }, (_, semana) => {
    const diasDaSemana = dias.slice(semana * 7, semana * 7 + 7);
    return faixasDaSemana(eventos, diasDaSemana, fuso);
  }), [dias, eventos, fuso, linhas]);

  return (
    <section aria-label="Agenda do mês" className="flex h-full min-h-[32rem] flex-col overflow-auto">
      <div className="grid shrink-0 grid-cols-7 border-b border-[var(--color-borda)] bg-[var(--color-fundo-suave)]">
        {nomesDias.map((nome) => <div key={nome} className="px-2 py-2 text-center text-[10px] font-semibold uppercase tracking-wide text-[var(--color-texto-fraco)]">{nome}</div>)}
      </div>
      <div className="grid min-h-[30rem] flex-1 grid-cols-7" style={{ gridTemplateRows: `repeat(${linhas}, minmax(6rem, 1fr))` }}>
        {dias.map((dia, indice) => {
          const chave = dataCivil(dia);
          const doDia = eventosNoDia(eventos, dia, fuso);
          const diaNaSemana = indice % 7;
          const semana = Math.floor(indice / 7);
          const segmentos = (faixas[semana] ?? [])
            .filter((item) => item.primeiroDia <= diaNaSemana && item.ultimoDia >= diaNaSemana)
            .sort((a, b) => a.faixa - b.faixa);
          const chavesVisiveis = new Set(segmentos.map(({ evento }) => chaveEvento(evento)));
          const restantes = doDia.filter((evento) => !chavesVisiveis.has(chaveEvento(evento))).length;
          return (
            <div key={chave} data-dia={chave} tabIndex={0} aria-label={`Dia ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "full" }).format(dia)}`} onKeyDown={(evento) => { if (!somenteLeitura && (evento.key === "Enter" || evento.key === " ")) { evento.preventDefault(); setCriacao(chave); } }} onClick={(evento) => { const alvo = evento.target as HTMLElement; if (!somenteLeitura && !alvo.closest("button, a, input, select, textarea, [role='dialog']")) setCriacao(chave); }} className={`relative min-w-0 border-b border-r border-[var(--color-borda)] p-1 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[var(--color-realce)] ${dia.getMonth() === data.getMonth() ? "bg-[var(--color-fundo)]" : "bg-[var(--color-fundo-suave)] text-[var(--color-texto-fraco)]"}`}>
              <button onClick={(evento) => { evento.stopPropagation(); onDia(dia); }} aria-label={`Abrir ${new Intl.DateTimeFormat("pt-BR", { dateStyle: "full" }).format(dia)}`} className={`mb-1 grid h-7 w-7 place-items-center rounded-full text-xs font-medium hover:bg-[var(--color-hover-suave)] ${chave === hoje ? "bg-[var(--color-realce)] text-white" : ""}`}>{dia.getDate()}</button>
              <div className="grid grid-rows-3 gap-0.5">
                {[0, 1, 2].map((faixa) => {
                  const segmento = segmentos.find((item) => item.faixa === faixa);
                  if (!segmento) return <span key={faixa} aria-hidden="true" className="h-[1.125rem]" />;
                  const { evento, primeiroDia, ultimoDia } = segmento;
                  const comecaAqui = diaNaSemana === primeiroDia;
                  const terminaAqui = diaNaSemana === ultimoDia;
                  return (
                    <button
                      key={`${chaveEvento(evento)}:${faixa}`}
                      onClick={() => { if (ignorarClique.current) { ignorarClique.current = false; return; } onEvento(evento); }}
                      onPointerDown={(ponteiro) => { if (somenteLeitura) return; ponteiro.stopPropagation(); const elemento = ponteiro.currentTarget; const pointerId = ponteiro.pointerId; const estado = { evento, ativo: ponteiro.pointerType !== "touch", timer: undefined as number | undefined }; if (ponteiro.pointerType === "touch") estado.timer = window.setTimeout(() => { estado.ativo = true; elemento.setPointerCapture(pointerId); }, 450); else elemento.setPointerCapture(pointerId); arrasteEvento.current = estado; }}
                      onPointerUp={(ponteiro) => { const estado = arrasteEvento.current; if (!estado) return; if (estado.timer) window.clearTimeout(estado.timer); arrasteEvento.current = null; if (!estado.ativo) return; const alvo = document.elementFromPoint(ponteiro.clientX, ponteiro.clientY)?.closest<HTMLElement>("[data-dia]"); const destino = alvo?.dataset.dia; if (!destino || destino === dataCivil(new Date(estado.evento.inicio))) return; ponteiro.preventDefault(); ignorarClique.current = true; const [ano, mes, diaDestino] = destino.split("-").map(Number); const movido = moverParaDia(new Date(estado.evento.inicio), new Date(estado.evento.fim), new Date(ano!, mes! - 1, diaDestino!)); onAlterar(estado.evento, movido.inicio, movido.fim); }}
                      onPointerCancel={() => { const estado = arrasteEvento.current; if (estado?.timer) window.clearTimeout(estado.timer); arrasteEvento.current = null; }}
                      title={evento.titulo}
                      style={{ backgroundColor: evento.cor ?? "var(--color-realce)" }}
                      className={`block h-[1.125rem] w-full truncate bg-[var(--color-realce)] px-1.5 text-left text-[10px] font-medium leading-[1.125rem] text-white ${comecaAqui ? "rounded-l" : "rounded-l-none"} ${terminaAqui ? "rounded-r" : "rounded-r-none"}`}
                    >
                      {comecaAqui ? evento.titulo : <span aria-label={evento.titulo}>&nbsp;</span>}
                    </button>
                  );
                })}
              </div>
              {restantes > 0 && <button onClick={() => setExpandido(chave)} className="mt-1 text-[10px] font-semibold text-[var(--color-texto-fraco)] hover:text-[var(--color-tinta)]">+{restantes} mais</button>}
              {expandido === chave && (
                <div role="dialog" aria-label={`Eventos de ${chave}`} className="absolute left-1 top-9 z-30 w-56 rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] p-2 shadow-xl">
                  <div className="mb-2 flex items-center justify-between"><strong className="text-xs">{new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long" }).format(dia)}</strong><button onClick={() => setExpandido(null)} aria-label="Fechar">×</button></div>
                  {doDia.map((evento) => <button key={`${evento.id}:${evento.recorrenciaId ?? evento.inicio}`} onClick={() => onEvento(evento)} className="block w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-[var(--color-fundo-suave)]">{evento.titulo}</button>)}
                </div>
              )}
              {criacao === chave && (() => { const inicio = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate()); const fim = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate() + 1); return <CriacaoRapida inicio={inicio} fim={fim} diaInteiro fuso={fuso} lembretePadrao={lembretePadrao} lembreteDiaInteiroPadrao={lembreteDiaInteiroPadrao} onCancelar={() => setCriacao(null)} onCriado={(evento) => { setCriacao(null); onCriado(evento); }} onMaisOpcoes={(titulo) => { setCriacao(null); onMaisOpcoes(inicio, fim, titulo, true); }} />; })()}
            </div>
          );
        })}
      </div>
    </section>
  );
}
