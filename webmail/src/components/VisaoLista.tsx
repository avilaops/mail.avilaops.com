"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { listarEventosAgenda } from "@/lib/cliente";
import { dataCivil } from "@/lib/dataAgenda";
import { intervaloCivilNoFuso } from "@/lib/fusoAgenda";
import { agruparEventosPorDia, rotuloDoDia } from "@/lib/listaAgenda";
import type { EventoAgenda } from "@/lib/tipos";

interface Props {
  inicio: Date;
  eventos: EventoAgenda[];
  onEvento: (evento: EventoAgenda) => void;
  fuso?: string;
  agendasVisiveis?: ReadonlySet<string>;
  online?: boolean;
}

function chave(evento: EventoAgenda): string {
  return `${evento.id}:${evento.recorrenciaId ?? evento.inicio}`;
}

export function VisaoLista({ inicio, eventos, onEvento, fuso = "America/Sao_Paulo", agendasVisiveis, online = true }: Props) {
  const [itens, setItens] = useState(eventos);
  const [pagina, setPagina] = useState(1);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const geracao = useRef(0);
  const requisicaoAtiva = useRef(false);

  useEffect(() => {
    setItens(eventos);
    setPagina(1);
    setCarregando(false);
    setErro(null);
    requisicaoAtiva.current = false;
    return () => { geracao.current += 1; };
  }, [eventos, inicio, fuso]);

  async function carregarMais() {
    if (requisicaoAtiva.current || pagina >= 12 || !online) return;
    const carga = geracao.current;
    requisicaoAtiva.current = true;
    setCarregando(true);
    setErro(null);
    try {
      const de = new Date(inicio);
      de.setDate(de.getDate() + pagina * 30);
      const ate = new Date(de);
      ate.setDate(ate.getDate() + 30);
      const janela = intervaloCivilNoFuso(dataCivil(de), dataCivil(ate), fuso);
      const novos = await listarEventosAgenda(janela.inicio, janela.fim);
      if (carga !== geracao.current) return;
      setItens((atuais) => {
        const conhecidos = new Set(atuais.map(chave));
        return [...atuais, ...novos.filter((evento) => !conhecidos.has(chave(evento)))];
      });
      setPagina((atual) => atual + 1);
    } catch {
      if (carga === geracao.current) setErro("Não foi possível carregar mais compromissos.");
    } finally {
      if (carga === geracao.current) {
        requisicaoAtiva.current = false;
        setCarregando(false);
      }
    }
  }

  const grupos = useMemo(() => agruparEventosPorDia(itens.filter((evento) => !evento.agendaId || !agendasVisiveis || agendasVisiveis.has(evento.agendaId)), fuso), [itens, fuso, agendasVisiveis]);

  return (
    <section aria-label="Próximos compromissos" className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8">
      {grupos.length === 0 && !carregando && !erro ? (
        <div className="rounded-lg bg-[var(--color-fundo-suave)] p-4">
          <h2 className="font-medium">Nenhum compromisso no período</h2>
          <p className="mt-1 text-sm text-[var(--color-texto-fraco)]">{pagina < 12 ? "Consulte os próximos 30 dias para procurar mais eventos." : "Todos os períodos disponíveis foram consultados."}</p>
        </div>
      ) : grupos.map((grupo) => (
        <section key={grupo.dia.toISOString()} className="mb-8">
          <h2 className="sticky top-0 z-10 border-b border-[var(--color-borda)] bg-[var(--color-fundo)]/95 py-2 text-sm font-semibold capitalize backdrop-blur">{rotuloDoDia(grupo.dia)}</h2>
          <div className="divide-y divide-[var(--color-borda)]">
            {grupo.eventos.map((evento) => (
              <button key={chave(evento)} onClick={() => onEvento(evento)} className="grid w-full grid-cols-[4.5rem_1fr] gap-3 py-3 text-left hover:bg-[var(--color-fundo-suave)] focus-visible:outline-2 focus-visible:outline-[var(--color-realce)] sm:grid-cols-[6rem_1fr_auto] sm:px-2">
                <span className="flex items-center gap-2 text-xs font-medium text-[var(--color-texto-fraco)]"><i aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: evento.cor ?? "var(--color-realce)" }} />{evento.diaInteiro ? "Dia inteiro" : new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: fuso }).format(new Date(evento.inicio))}</span>
                <span className="min-w-0"><strong className="block truncate text-sm">{evento.titulo}</strong>{evento.local && <span className="mt-0.5 block truncate text-xs text-[var(--color-texto-fraco)]">{evento.local}</span>}</span>
                <span className="col-start-2 flex gap-2 text-xs text-[var(--color-texto-fraco)] sm:col-start-auto" aria-label="Características do evento">
                  {(evento.recorrencia || evento.recorrenciaId) && <span title="Recorrente" aria-label="Recorrente">↻</span>}
                  {evento.convidados.length > 0 && <span title={`${evento.convidados.length} convidados`} aria-label={`${evento.convidados.length} convidados`}>♙ {evento.convidados.length}</span>}
                </span>
              </button>
            ))}
          </div>
        </section>
      ))}
      {erro && <p role="alert" className="my-4 text-sm text-[var(--color-perigo)]">{erro}</p>}
      {pagina < 12 && (
        <div className="pt-4 text-center">
          <button type="button" disabled={carregando || !online} onClick={() => void carregarMais()} className="min-h-11 rounded-lg border border-[var(--color-borda)] px-4 text-sm font-medium hover:bg-[var(--color-fundo-suave)] disabled:opacity-50">
            {erro ? "Tentar novamente" : "Ver próximos compromissos"}
          </button>
          {carregando && <p role="status" className="mt-2 text-sm text-[var(--color-texto-fraco)]">Carregando compromissos…</p>}
        </div>
      )}
    </section>
  );
}
