"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { listarEventosAgenda } from "@/lib/cliente";
import { agruparEventosPorDia, rotuloDoDia } from "@/lib/listaAgenda";
import type { EventoAgenda } from "@/lib/tipos";

interface Props {
  inicio: Date;
  eventos: EventoAgenda[];
  onEvento: (evento: EventoAgenda) => void;
  fuso?: string;
}

function chave(evento: EventoAgenda): string {
  return `${evento.id}:${evento.recorrenciaId ?? evento.inicio}`;
}

export function VisaoLista({ inicio, eventos, onEvento, fuso = "America/Sao_Paulo" }: Props) {
  const [itens, setItens] = useState(eventos);
  const [pagina, setPagina] = useState(1);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const sentinela = useRef<HTMLDivElement>(null);
  const geracao = useRef(0);

  useEffect(() => {
    geracao.current += 1;
    setItens(eventos);
    setPagina(1);
    setCarregando(false);
    setErro(null);
  }, [eventos, inicio]);

  useEffect(() => {
    const alvo = sentinela.current;
    if (!alvo || carregando || pagina >= 12) return;
    const observador = new IntersectionObserver(([entrada]) => {
      if (!entrada?.isIntersecting) return;
      const carga = geracao.current;
      setCarregando(true);
      const de = new Date(inicio);
      de.setDate(de.getDate() + pagina * 30);
      const ate = new Date(de);
      ate.setDate(ate.getDate() + 30);
      void listarEventosAgenda(de, ate)
        .then((novos) => {
          if (carga !== geracao.current) return;
          setItens((atuais) => {
            const conhecidos = new Set(atuais.map(chave));
            return [...atuais, ...novos.filter((evento) => !conhecidos.has(chave(evento)))];
          });
          setPagina((atual) => atual + 1);
          setErro(null);
        })
        .catch((falha) => {
          if (carga === geracao.current) setErro(falha instanceof Error ? falha.message : "Não foi possível carregar mais eventos.");
        })
        .finally(() => {
          if (carga === geracao.current) setCarregando(false);
        });
    }, { rootMargin: "300px" });
    observador.observe(alvo);
    return () => observador.disconnect();
  }, [carregando, inicio, pagina]);

  const grupos = useMemo(() => agruparEventosPorDia(itens, fuso), [itens, fuso]);

  return (
    <section aria-label="Próximos compromissos" className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-8">
      {grupos.length === 0 && !carregando ? (
        <div className="border-l-2 border-[var(--color-borda)] py-8 pl-5"><h2 className="font-medium">Nenhum compromisso próximo</h2><p className="mt-1 text-sm text-[var(--color-texto-fraco)]">Continue rolando para procurar nas próximas janelas.</p></div>
      ) : grupos.map((grupo) => (
        <section key={grupo.dia.toISOString()} className="mb-8">
          <h2 className="sticky top-16 z-10 border-b border-[var(--color-borda)] bg-[var(--color-fundo)]/95 py-2 text-sm font-semibold capitalize backdrop-blur">{rotuloDoDia(grupo.dia)}</h2>
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
      <div ref={sentinela} className="py-4 text-center text-xs text-[var(--color-texto-fraco)]">{carregando ? "Carregando mais…" : pagina < 12 ? "Role para ver mais" : "Um ano carregado"}</div>
    </section>
  );
}
