"use client";

import { dataCivil, diasDoMiniCalendario, intervaloDaVisao, type VisaoAgenda, VISOES_AGENDA } from "@/lib/dataAgenda";
import type { AgendaCalendario } from "@/lib/tipos";

const ROTULOS: Record<VisaoAgenda, string> = { dia: "Dia", semana: "Semana", mes: "Mês", lista: "Lista" };
const DIAS = ["D", "S", "T", "Q", "Q", "S", "S"];

interface Props {
  aberta: boolean;
  data: Date;
  visao: VisaoAgenda;
  onCriar: () => void;
  onData: (data: Date) => void;
  onVisao: (visao: VisaoAgenda) => void;
  onFechar: () => void;
  somenteLeitura?: boolean;
  primeiroDia?: 0 | 1;
  agendas: AgendaCalendario[];
  visiveis: Set<string>;
  onVisibilidade: (id: string, visivel: boolean) => void;
  onCriarAgenda: () => void;
  onEditarAgenda: (agenda: AgendaCalendario) => void;
  onExcluirAgenda: (agenda: AgendaCalendario) => void;
}

export function LateralAgenda({ aberta, data, visao, onCriar, onData, onVisao, onFechar, somenteLeitura = false, primeiroDia = 0, agendas, visiveis, onVisibilidade, onCriarAgenda, onEditarAgenda, onExcluirAgenda }: Props) {
  const dias = diasDoMiniCalendario(data, primeiroDia);
  const periodo = intervaloDaVisao(data, visao, primeiroDia);
  const rotulosDias = primeiroDia === 1 ? [...DIAS.slice(1), DIAS[0]!] : DIAS;

  return (
    <>
      {aberta && <button aria-label="Fechar navegação da agenda" onClick={onFechar} className="fixed inset-0 z-30 bg-black/35 md:hidden" />}
      <aside
        aria-label="Navegação da agenda"
        className={`${aberta ? "translate-x-0" : "-translate-x-full"} fixed inset-y-0 left-0 z-40 flex w-[18rem] flex-col border-r border-[var(--color-borda)] bg-[var(--color-fundo-suave)] pt-[env(safe-area-inset-top,0px)] transition-transform md:static md:z-0 md:w-64 md:translate-x-0 md:pt-0`}
      >
        <div className="flex items-center justify-between px-4 py-3 md:hidden">
          <span className="text-sm font-semibold">Agenda</span>
          <button onClick={onFechar} aria-label="Fechar" className="rounded-md px-2 py-1 text-xl text-[var(--color-texto-fraco)]">×</button>
        </div>

        <div className="px-4 pb-4 pt-3">
          <button onClick={onCriar} disabled={somenteLeitura} className="w-full rounded-lg bg-[var(--color-forte)] px-4 py-2.5 text-sm font-medium text-[var(--color-sobre-forte)] hover:bg-[var(--color-forte-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-realce)] disabled:cursor-not-allowed disabled:opacity-50">
            Criar evento
          </button>
        </div>

        <section aria-label="Mini calendário" className="px-4">
          <div className="mb-3 text-sm font-semibold capitalize">
            {new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(data)}
          </div>
          <div className="grid grid-cols-7 text-center text-[10px] font-semibold text-[var(--color-texto-fraco)]">
            {rotulosDias.map((dia, indice) => <span key={`${dia}-${indice}`} className="py-1">{dia}</span>)}
          </div>
          <div className="grid grid-cols-7 gap-y-1">
            {dias.map((dia) => {
              const chave = dataCivil(dia);
              const selecionado = chave === dataCivil(data);
              const noPeriodo = dia >= periodo.inicio && dia < periodo.fim;
              const outroMes = dia.getMonth() !== data.getMonth();
              return (
                <button
                  key={chave}
                  onClick={() => { onData(dia); onFechar(); }}
                  aria-label={new Intl.DateTimeFormat("pt-BR", { dateStyle: "full" }).format(dia)}
                  aria-pressed={selecionado}
                  className={`mx-auto grid h-8 w-8 place-items-center rounded-full text-xs transition-colors focus-visible:outline-2 focus-visible:outline-[var(--color-realce)] ${
                    selecionado
                      ? "bg-[var(--color-realce)] font-semibold text-white"
                      : noPeriodo
                        ? "bg-[var(--color-realce)]/12 text-[var(--color-tinta)]"
                        : outroMes
                          ? "text-[var(--color-texto-fraco)]/50 hover:bg-[var(--color-hover-suave)]"
                          : "text-[var(--color-tinta)] hover:bg-[var(--color-hover-suave)]"
                  }`}
                >
                  {dia.getDate()}
                </button>
              );
            })}
          </div>
        </section>

        <nav aria-label="Visão da agenda" className="mt-6 px-3">
          <p className="px-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--color-texto-fraco)]">Visualização</p>
          {VISOES_AGENDA.map((item) => (
            <button
              key={item}
              onClick={() => { onVisao(item); onFechar(); }}
              aria-current={visao === item ? "page" : undefined}
              className={`mt-0.5 w-full rounded-md px-3 py-2 text-left text-sm transition-colors ${visao === item ? "bg-[var(--color-forte)] font-medium text-[var(--color-sobre-forte)]" : "hover:bg-[var(--color-hover-suave)]"}`}
            >
              {ROTULOS[item]}
            </button>
          ))}
        </nav>

        <div className="mt-auto border-t border-[var(--color-borda)] px-4 py-4">
          <div className="flex items-center justify-between"><p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-texto-fraco)]">Agendas</p><button disabled={somenteLeitura} onClick={onCriarAgenda} aria-label="Criar agenda" className="rounded px-2 text-lg disabled:opacity-50">+</button></div>
          <div className="mt-2 space-y-1">{agendas.map((agenda) => <div key={agenda.id} className="group flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-[var(--color-hover-suave)]"><input aria-label={`Exibir ${agenda.nome}`} type="checkbox" checked={visiveis.has(agenda.id)} onChange={(item) => onVisibilidade(agenda.id, item.target.checked)} /><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: agenda.cor }} /><button className="min-w-0 flex-1 truncate text-left" onClick={() => onEditarAgenda(agenda)}>{agenda.nome}</button><span className="text-xs text-[var(--color-texto-fraco)]">{agenda.quantidadeEventos}</span><button disabled={somenteLeitura || agendas.length === 1} onClick={() => onExcluirAgenda(agenda)} aria-label={`Excluir ${agenda.nome}`} className="invisible px-1 text-[var(--color-perigo)] group-hover:visible disabled:hidden">×</button></div>)}</div>
        </div>
      </aside>
    </>
  );
}
