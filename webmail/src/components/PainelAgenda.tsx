"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { NavegacaoProduto } from "@/components/NavegacaoProduto";
import { EventoNaAgenda } from "@/components/EventoNaAgenda";
import { EditorEvento } from "@/components/EditorEvento";
import { LateralAgenda } from "@/components/LateralAgenda";
import { VisaoSemana } from "@/components/VisaoSemana";
import { DetalheEvento } from "@/components/DetalheEvento";
import { VisaoMes } from "@/components/VisaoMes";
import { VisaoLista } from "@/components/VisaoLista";
import { BuscaAgenda } from "@/components/BuscaAgenda";
import { AjudaAtalhosAgenda } from "@/components/AjudaAtalhosAgenda";
import { DialogoRecorrencia, type EscopoRecorrencia } from "@/components/DialogoRecorrencia";
import { atualizarAgenda, atualizarEventoAgenda, criarAgenda, criarEventoAgenda, excluirAgenda, excluirEventoAgenda, invalidarCacheAgenda, listarAgendas, listarEventosAgenda, obterEventoAgenda, obterPreferenciasAgenda } from "@/lib/cliente";
import { dataCivil, intervaloDaVisao, lerDataCivil, lerVisaoAgenda, navegarData, rotuloDoIntervalo, type VisaoAgenda, VISOES_AGENDA } from "@/lib/dataAgenda";
import { useAtalhos, type Atalho } from "@/lib/atalhos";
import type { AgendaCalendario, EventoAgenda, PreferenciasAgenda } from "@/lib/tipos";
import { intervaloCivilNoFuso } from "@/lib/fusoAgenda";
import { classeConteudoAgenda, deveMostrarGradeAgenda, rotuloCompactoAgenda } from "@/lib/apresentacaoAgenda";
import { NavegacaoVisoesAgenda } from "@/components/NavegacaoVisoesAgenda";

const VISAO_DA_API: Record<PreferenciasAgenda["defaultView"], VisaoAgenda> = { day: "dia", week: "semana", month: "mes", list: "lista" };

/** Porta inicial da agenda; as grades especializadas entram nas tarefas seguintes. */
export function PainelAgenda() {
  const router = useRouter();
  const parametros = useSearchParams();
  const [eventos, setEventos] = useState<EventoAgenda[]>([]);
  const [agendas, setAgendas] = useState<AgendaCalendario[]>([]);
  const [agendasVisiveis, setAgendasVisiveis] = useState<Set<string>>(new Set());
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [lateralAberta, setLateralAberta] = useState(false);
  const [editorAberto, setEditorAberto] = useState(false);
  const [inicioCriacao, setInicioCriacao] = useState<Date | null>(null);
  const [eventoAberto, setEventoAberto] = useState<EventoAgenda | null>(null);
  const [eventoEditando, setEventoEditando] = useState<EventoAgenda | null>(null);
  const [rascunhoCriacao, setRascunhoCriacao] = useState<{ fim?: Date; titulo?: string; diaInteiro?: boolean; descricao?: string; convidadosSugeridos?: string[] } | null>(null);
  const [exclusoesPendentes, setExclusoesPendentes] = useState<Array<{ evento: EventoAgenda; timer: number }>>([]);
  const [alteracoesPendentes, setAlteracoesPendentes] = useState<Array<{ anterior: EventoAgenda; atual: EventoAgenda; timer: number }>>([]);
  const [online, setOnline] = useState(true);
  const [primeiraVisita, setPrimeiraVisita] = useState(false);
  const [conflitoExterno, setConflitoExterno] = useState(false);
  const [ajuda, setAjuda] = useState(false);
  const [buscaAberta, setBuscaAberta] = useState(false);
  const [preferencias, setPreferencias] = useState<PreferenciasAgenda | null>(null);
  const [escopoEditor, setEscopoEditor] = useState<EscopoRecorrencia | undefined>();
  const [acaoEscopo, setAcaoEscopo] = useState<"editar" | "mover" | "excluir" | null>(null);
  const [lembreteNaAba, setLembreteNaAba] = useState<{ texto: string; url: string } | null>(null);
  const executarEscopo = useRef<((escopo: EscopoRecorrencia) => void) | null>(null);
  const geracaoCarga = useRef(0);
  const mutacoesHorario = useRef(new Set<string>());
  const eventoDaUrlAberto = useRef<string | null>(null);
  const lembretesSseVistos = useRef(new Set<string>());

  const data = useMemo(() => lerDataCivil(parametros.get("data")), [parametros]);
  const visao = useMemo(() => lerVisaoAgenda(parametros.get("visao")), [parametros]);
  const janelaCivil = useMemo(() => intervaloDaVisao(data, visao, preferencias?.weekStart ?? 0), [data, visao, preferencias?.weekStart]);
  const janela = useMemo(() => preferencias
    ? intervaloCivilNoFuso(dataCivil(janelaCivil.inicio), dataCivil(janelaCivil.fim), preferencias.timezone)
    : janelaCivil, [janelaCivil, preferencias]);

  const atualizarUrl = useCallback((proximaData: Date, proximaVisao: VisaoAgenda) => {
    const query = new URLSearchParams({ visao: proximaVisao, data: dataCivil(proximaData) });
    router.push(`/agenda?${query}`, { scroll: false });
  }, [router]);

  useEffect(() => {
    void obterPreferenciasAgenda().then(setPreferencias).catch((falha) => setErro(falha instanceof Error ? falha.message : "Não foi possível carregar as preferências da agenda."));
    void listarAgendas().then((items) => { setAgendas(items); setAgendasVisiveis(new Set(items.map((item) => item.id))); }).catch((falha) => setErro(falha instanceof Error ? falha.message : "Não foi possível carregar as agendas."));
  }, []);

  useEffect(() => {
    if (parametros.get("novo") !== "mensagem") return;
    try {
      const salvo = sessionStorage.getItem("avila_evento_da_mensagem");
      if (!salvo) return;
      const dados = JSON.parse(salvo) as { titulo?: string; descricao?: string; convidadosSugeridos?: string[] };
      sessionStorage.removeItem("avila_evento_da_mensagem");
      setInicioCriacao(new Date());
      setRascunhoCriacao(dados);
      setEventoEditando(null);
      setEditorAberto(true);
    } catch { sessionStorage.removeItem("avila_evento_da_mensagem"); }
  }, [parametros]);

  useEffect(() => {
    if (!preferencias) return;
    const informada = parametros.get("visao");
    const visaoCanonica = !VISOES_AGENDA.includes(informada as VisaoAgenda)
      ? (window.matchMedia("(max-width: 639px)").matches ? "lista" : VISAO_DA_API[preferencias.defaultView])
      : visao;
    if (parametros.get("data") !== dataCivil(data) || informada !== visaoCanonica) {
      const query = new URLSearchParams({ visao: visaoCanonica, data: dataCivil(data) });
      router.replace(`/agenda?${query}`, { scroll: false });
    }
  }, [data, parametros, preferencias, router, visao]);

  const carregar = useCallback(async () => {
    if (!preferencias) return;
    const geracao = ++geracaoCarga.current;
    setCarregando(true);
    try {
      const recebidos = await listarEventosAgenda(janela.inicio, janela.fim);
      if (geracao !== geracaoCarga.current) return;
      setEventos(recebidos);
      setErro(null);
    } catch (falha) {
      if (geracao !== geracaoCarga.current) return;
      setErro(falha instanceof Error ? falha.message : "Nao foi possivel carregar a agenda.");
    } finally {
      if (geracao === geracaoCarga.current) setCarregando(false);
    }
  }, [janela, preferencias]);

  const eventosVisiveis = useMemo(() => eventos.filter((evento) => !evento.agendaId || agendasVisiveis.has(evento.agendaId)), [agendasVisiveis, eventos]);

  async function novaAgenda() {
    const nome = window.prompt("Nome da nova agenda:")?.trim();
    if (!nome) return;
    const criada = await criarAgenda(nome, "#2563EB");
    setAgendas((atuais) => [...atuais, criada]);
    setAgendasVisiveis((atuais) => new Set([...atuais, criada.id]));
  }

  async function editarAgenda(agenda: AgendaCalendario) {
    const nome = window.prompt("Nome da agenda:", agenda.nome)?.trim();
    if (!nome) return;
    const cor = window.prompt("Cor (#RRGGBB):", agenda.cor)?.trim();
    if (!cor) return;
    const salva = await atualizarAgenda(agenda.id, { name: nome, color: cor });
    setAgendas((atuais) => atuais.map((item) => item.id === salva.id ? salva : item));
    setEventos((atuais) => atuais.map((evento) => evento.agendaId === salva.id ? { ...evento, cor: salva.cor } : evento));
  }

  async function removerAgenda(agenda: AgendaCalendario) {
    if (!window.confirm(`Excluir “${agenda.nome}” e ${agenda.quantidadeEventos} evento(s)?`)) return;
    await excluirAgenda(agenda.id);
    setAgendas((atuais) => atuais.filter((item) => item.id !== agenda.id));
    setEventos((atuais) => atuais.filter((evento) => evento.agendaId !== agenda.id));
  }

  useEffect(() => {
    if (preferencias) void carregar();
  }, [carregar, preferencias]);

  useEffect(() => {
    const href = parametros.get("evento");
    if (!href || eventoDaUrlAberto.current === href || eventos.length === 0) return;
    const encontrado = eventos.find((evento) => evento.href === href);
    if (encontrado) {
      eventoDaUrlAberto.current = href;
      setEventoAberto(encontrado);
    }
  }, [eventos, parametros]);

  useEffect(() => {
    const atualizarConexao = () => setOnline(navigator.onLine);
    atualizarConexao();
    setPrimeiraVisita(localStorage.getItem("avila_agenda_visitada") !== "1");
    window.addEventListener("online", atualizarConexao);
    window.addEventListener("offline", atualizarConexao);
    return () => { window.removeEventListener("online", atualizarConexao); window.removeEventListener("offline", atualizarConexao); };
  }, []);

  useEffect(() => {
    const fonte = new EventSource("/api/mail/me/events", { withCredentials: true });
    fonte.addEventListener("calendar", () => {
      invalidarCacheAgenda();
      void carregar();
      if (eventoEditando) {
        void obterEventoAgenda(eventoEditando.id)
          .then((atual) => { if (atual.etag !== eventoEditando.etag) setConflitoExterno(true); })
          .catch(() => setConflitoExterno(true));
      }
    });
    fonte.addEventListener("calendar-reminder", (evento) => {
      try {
        const dados = JSON.parse((evento as MessageEvent<string>).data) as { reminders?: Array<{ id: string; minutesBefore: number; url: string }> };
        const lembrete = dados.reminders?.filter((item) => !lembretesSseVistos.current.has(item.id)).at(-1);
        for (const item of dados.reminders ?? []) lembretesSseVistos.current.add(item.id);
        if (lembrete) setLembreteNaAba({ texto: lembrete.minutesBefore === 0 ? "Um evento começa agora." : `Um evento começa em ${lembrete.minutesBefore} min.`, url: lembrete.url });
      } catch { /* Evento SSE malformado e ignorado; a conexão continua ativa. */ }
    });
    fonte.onerror = () => undefined;
    return () => fonte.close();
  }, [carregar, eventoEditando]);

  const abrirCriacaoPadrao = useCallback(() => {
    const [hora = 9, minuto = 0] = (preferencias?.businessHoursStart ?? "09:00").split(":").map(Number);
    setInicioCriacao(new Date(data.getFullYear(), data.getMonth(), data.getDate(), hora, minuto));
    setEventoEditando(null);
    setRascunhoCriacao(null);
    setEditorAberto(true);
  }, [data, preferencias?.businessHoursStart]);

  const pedirEscopo = useCallback((evento: EventoAgenda, acao: "editar" | "mover" | "excluir", executar: (escopo: EscopoRecorrencia) => void) => {
    if ((!evento.recorrencia && !evento.recorrenciaId) || !evento.recorrenciaId) {
      executar("all");
      return;
    }
    executarEscopo.current = executar;
    setAcaoEscopo(acao);
  }, []);

  const abrirEdicao = useCallback((evento: EventoAgenda, escopo: EscopoRecorrencia) => {
    const abrir = (alvo: EventoAgenda, escopoEfetivo?: EscopoRecorrencia) => {
      setEscopoEditor(escopoEfetivo);
      setEventoEditando(alvo);
      setInicioCriacao(new Date(alvo.inicio));
      setRascunhoCriacao(null);
      setEventoAberto(null);
      setEditorAberto(true);
    };
    if (escopo === "all" && evento.recorrenciaId) {
      void obterEventoAgenda(evento.id).then((mestre) => abrir(mestre)).catch((falha) => setErro(falha instanceof Error ? falha.message : "Não foi possível carregar a série."));
      return;
    }
    abrir(evento, escopo);
  }, []);

  const excluirSelecionado = useCallback((evento: EventoAgenda, escopo: EscopoRecorrencia) => {
    const notificarConvidados = evento.convidados.length > 0 && window.confirm("Enviar cancelamento aos convidados?");
    setEventoAberto(null);
    if (evento.recorrenciaId) {
      void excluirEventoAgenda(evento.id, evento.etag, { scope: escopo, recurrenceId: evento.recorrenciaId }, { notificarConvidados })
        .then(() => { invalidarCacheAgenda(); void carregar(); })
        .catch((falha) => setErro(falha instanceof Error ? falha.message : "Não foi possível excluir o evento."));
      return;
    }
    setEventos((atuais) => atuais.filter((item) => item.id !== evento.id));
    const timer = window.setTimeout(() => { void excluirEventoAgenda(evento.id, evento.etag, undefined, { notificarConvidados }).catch((falha) => { setErro(falha instanceof Error ? falha.message : "Não foi possível excluir o evento."); setEventos((atuais) => [...atuais, evento]); }); setExclusoesPendentes((atuais) => atuais.filter((item) => item.evento.id !== evento.id)); }, 6_000);
    setExclusoesPendentes((atuais) => [...atuais, { evento, timer }]);
  }, [carregar]);

  const atalhos: Atalho[] = [
    { tecla: "t", descricao: "Hoje", acao: () => atualizarUrl(new Date(), visao) },
    { tecla: "d", descricao: "Visão de dia", acao: () => atualizarUrl(data, "dia") },
    { tecla: "s", descricao: "Visão de semana", acao: () => atualizarUrl(data, "semana") },
    { tecla: "m", descricao: "Visão de mês", acao: () => atualizarUrl(data, "mes") },
    { tecla: "l", descricao: "Visão de lista", acao: () => atualizarUrl(data, "lista") },
    { tecla: "ArrowLeft", descricao: "Período anterior", acao: () => atualizarUrl(navegarData(data, visao, -1), visao) },
    { tecla: "j", descricao: "Período anterior", acao: () => atualizarUrl(navegarData(data, visao, -1), visao) },
    { tecla: "ArrowRight", descricao: "Próximo período", acao: () => atualizarUrl(navegarData(data, visao, 1), visao) },
    { tecla: "k", descricao: "Próximo período", acao: () => atualizarUrl(navegarData(data, visao, 1), visao) },
    { tecla: "c", descricao: "Criar evento", acao: () => { if (online) abrirCriacaoPadrao(); } },
    { tecla: "/", descricao: "Buscar", acao: () => setBuscaAberta(true) },
    { tecla: "g a", descricao: "Ir para a agenda", acao: () => router.push("/agenda") },
    { tecla: "g i", descricao: "Ir para a caixa", acao: () => router.push("/caixa") },
    { tecla: "?", descricao: "Mostrar atalhos", acao: () => setAjuda((atual) => !atual) },
    { tecla: "Escape", descricao: "Fechar", acao: () => { setAjuda(false); setBuscaAberta(false); setLateralAberta(false); } },
  ];
  useAtalhos(atalhos, !editorAberto && !eventoAberto && !ajuda && !buscaAberta);

  const alterarHorario = useCallback((evento: EventoAgenda, inicio: Date, fim: Date, escopo: EscopoRecorrencia = "all") => {
    if (mutacoesHorario.current.has(evento.id)) return;
    mutacoesHorario.current.add(evento.id);
    const otimista = { ...evento, inicio: inicio.toISOString(), fim: fim.toISOString() };
    if (evento.recorrenciaId) {
      const recurrenceId = evento.recorrenciaId;
      const salvar = async () => {
        if (escopo !== "all") return atualizarEventoAgenda(evento.id, evento.etag, { inicio: otimista.inicio, fim: otimista.fim }, { scope: escopo, recurrenceId }, { notificarConvidados: evento.convidados.length > 0 });
        const mestre = await obterEventoAgenda(evento.id);
        const deslocamento = inicio.getTime() - new Date(evento.inicio).getTime();
        return atualizarEventoAgenda(mestre.id, mestre.etag, {
          inicio: new Date(new Date(mestre.inicio).getTime() + deslocamento).toISOString(),
          fim: new Date(new Date(mestre.fim).getTime() + deslocamento).toISOString(),
        }, undefined, { notificarConvidados: mestre.convidados.length > 0 });
      };
      void salvar()
        .then(() => { invalidarCacheAgenda(); void carregar(); })
        .catch((falha) => setErro(falha instanceof Error ? falha.message : "Não foi possível alterar o horário."))
        .finally(() => mutacoesHorario.current.delete(evento.id));
      return;
    }
    setEventos((atuais) => atuais.map((item) => item.id === evento.id ? otimista : item));
    void atualizarEventoAgenda(evento.id, evento.etag, { inicio: otimista.inicio, fim: otimista.fim }, undefined, { notificarConvidados: evento.convidados.length > 0 })
      .then((salvo) => {
        setEventos((atuais) => atuais.map((item) => item.id === salvo.id ? salvo : item));
        const timer = window.setTimeout(() => setAlteracoesPendentes((atuais) => atuais.filter((item) => item.atual.id !== salvo.id)), 6_000);
        setAlteracoesPendentes((atuais) => {
          for (const item of atuais.filter((pendente) => pendente.atual.id === salvo.id)) window.clearTimeout(item.timer);
          return [...atuais.filter((item) => item.atual.id !== salvo.id), { anterior: evento, atual: salvo, timer }];
        });
      })
      .catch((falha) => {
        setEventos((atuais) => atuais.map((item) => item.id === evento.id ? evento : item));
        setErro(falha instanceof Error ? falha.message : "Não foi possível alterar o horário.");
      })
      .finally(() => mutacoesHorario.current.delete(evento.id));
  }, [carregar]);

  const solicitarAlteracaoHorario = useCallback((evento: EventoAgenda, inicio: Date, fim: Date) => {
    pedirEscopo(evento, "mover", (escopo) => alterarHorario(evento, inicio, fim, escopo));
  }, [alterarHorario, pedirEscopo]);

  return (
    <div className="topo-seguro flex h-dvh max-h-dvh min-h-0 flex-col overflow-hidden bg-[var(--color-fundo)]">
      <NavegacaoProduto />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <LateralAgenda aberta={lateralAberta} data={data} visao={visao} primeiroDia={preferencias?.weekStart} somenteLeitura={!online} agendas={agendas} visiveis={agendasVisiveis} onVisibilidade={(id, visivel) => setAgendasVisiveis((atuais) => { const proximas = new Set(atuais); if (visivel) proximas.add(id); else proximas.delete(id); return proximas; })} onCriarAgenda={() => void novaAgenda().catch((falha) => setErro(falha instanceof Error ? falha.message : "Não foi possível criar a agenda."))} onEditarAgenda={(agenda) => void editarAgenda(agenda).catch((falha) => setErro(falha instanceof Error ? falha.message : "Não foi possível editar a agenda."))} onExcluirAgenda={(agenda) => void removerAgenda(agenda).catch((falha) => setErro(falha instanceof Error ? falha.message : "Não foi possível excluir a agenda."))} onCriar={abrirCriacaoPadrao} onData={(dia) => atualizarUrl(dia, visao)} onVisao={(item) => atualizarUrl(data, item)} onFechar={() => setLateralAberta(false)} />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="sticky top-0 z-20 flex min-h-14 items-center gap-1 border-b border-[var(--color-borda)] bg-[var(--color-fundo)]/95 px-2 backdrop-blur sm:min-h-16 sm:gap-2 sm:px-5">
            <button onClick={() => setLateralAberta(true)} aria-label="Abrir navegação da agenda" className="grid min-h-11 min-w-11 place-items-center rounded-lg hover:bg-[var(--color-fundo-suave)] md:hidden">☰</button>
            <button onClick={() => atualizarUrl(new Date(), visao)} className="rounded-md border border-[var(--color-borda)] px-3 py-1.5 text-sm font-medium hover:bg-[var(--color-fundo-suave)]">Hoje</button>
            <div className="flex">
              <button onClick={() => atualizarUrl(navegarData(data, visao, -1), visao)} aria-label="Período anterior" className="rounded-l-md p-2 hover:bg-[var(--color-fundo-suave)]">←</button>
              <button onClick={() => atualizarUrl(navegarData(data, visao, 1), visao)} aria-label="Próximo período" className="rounded-r-md p-2 hover:bg-[var(--color-fundo-suave)]">→</button>
            </div>
            <h1 className="min-w-0 flex-1 truncate text-center text-sm font-semibold capitalize sm:text-left sm:text-base">
              <span className="sm:hidden">{rotuloCompactoAgenda(data, visao, preferencias?.weekStart)}</span>
              <span className="hidden sm:inline">{rotuloDoIntervalo(data, visao, preferencias?.weekStart)}</span>
            </h1>
            <button onClick={() => setBuscaAberta(true)} aria-label="Buscar na agenda" className="grid min-h-11 min-w-11 place-items-center rounded-lg hover:bg-[var(--color-fundo-suave)]">⌕</button>
          </div>
          <NavegacaoVisoesAgenda visao={visao} onMudar={(item) => atualizarUrl(data, item)} />

          {!online && <div role="status" className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950">Sem conexão. A agenda está disponível somente para leitura.</div>}
          {lembreteNaAba && <div role="status" className="flex items-center gap-3 border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-950"><a href={lembreteNaAba.url} className="min-w-0 flex-1 font-medium underline">{lembreteNaAba.texto}</a><button type="button" aria-label="Fechar lembrete" onClick={() => setLembreteNaAba(null)}>×</button></div>}
          {primeiraVisita && <div className="flex items-center gap-3 border-b border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-950"><span className="min-w-0 flex-1">Leve seus eventos para o calendário do celular. <a href="/configurar#agenda" className="font-medium underline">Configurar agenda</a></span><button aria-label="Fechar aviso" onClick={() => { localStorage.setItem("avila_agenda_visitada", "1"); setPrimeiraVisita(false); }}>×</button></div>}
          {carregando && eventos.length > 0 && <div role="status" className="h-0 overflow-visible"><div className="h-0.5 animate-pulse bg-[var(--color-realce)]" /></div>}

          {(visao === "dia" || visao === "semana") && deveMostrarGradeAgenda(visao, Boolean(erro)) && (!carregando || eventos.length > 0) ? (
            <div className={classeConteudoAgenda(visao)}>
              <VisaoSemana data={data} dias={visao === "dia" ? 1 : 7} eventos={eventosVisiveis} primeiroDia={preferencias?.weekStart} expedienteInicio={preferencias?.businessHoursStart} expedienteFim={preferencias?.businessHoursEnd} fuso={preferencias?.timezone} lembretePadrao={preferencias?.defaultReminder} lembreteDiaInteiroPadrao={preferencias?.defaultAllDayReminder} somenteLeitura={!online} onAlterar={solicitarAlteracaoHorario} onMaisOpcoes={(inicio, fim, titulo) => { setInicioCriacao(inicio); setRascunhoCriacao({ fim, titulo }); setEventoEditando(null); setEditorAberto(true); }} onCriado={(evento) => setEventos((atuais) => [...atuais, evento])} onEvento={setEventoAberto} />
            </div>
          ) : visao === "mes" && deveMostrarGradeAgenda(visao, Boolean(erro)) && (!carregando || eventos.length > 0) ? (
            <div className={classeConteudoAgenda(visao)}>
              <VisaoMes data={data} eventos={eventosVisiveis} primeiroDia={preferencias?.weekStart} fuso={preferencias?.timezone} lembretePadrao={preferencias?.defaultReminder} lembreteDiaInteiroPadrao={preferencias?.defaultAllDayReminder} somenteLeitura={!online} onAlterar={solicitarAlteracaoHorario} onDia={(dia) => atualizarUrl(dia, "dia")} onEvento={setEventoAberto} onCriado={(evento) => setEventos((atuais) => [...atuais, evento])} onMaisOpcoes={(inicio, fim, titulo, diaInteiro) => { setInicioCriacao(inicio); setRascunhoCriacao({ fim, titulo, diaInteiro }); setEventoEditando(null); setEditorAberto(true); }} />
            </div>
          ) : visao === "lista" && !erro && (!carregando || eventos.length > 0) ? (
            <div className={`${classeConteudoAgenda(visao)} pb-20 md:pb-0`}><VisaoLista inicio={janela.inicio} eventos={eventosVisiveis} fuso={preferencias?.timezone} onEvento={setEventoAberto} /></div>
          ) : <div className={`${classeConteudoAgenda(visao)} mx-auto w-full max-w-5xl px-4 py-8 pb-24 sm:px-8 sm:py-10 md:pb-10`}>

          {erro ? <div role="alert" className="mb-6 border-l-2 border-[var(--color-perigo)] bg-[var(--color-fundo-suave)] px-4 py-3 text-sm"><p>{erro}</p><button onClick={() => void carregar()} className="mt-2 font-medium text-[var(--color-realce)] underline">Tentar de novo</button></div> : carregando ? (
            <div aria-label="Carregando agenda" className="animate-pulse space-y-3"><div className="h-8 w-48 rounded bg-[var(--color-fundo-suave)]" /><div className="h-64 rounded-xl bg-[var(--color-fundo-suave)]" /></div>
          ) : eventosVisiveis.length === 0 ? (
            <section className="border-l-2 border-[var(--color-borda)] py-10 pl-6">
              <h2 className="text-lg font-medium">Nenhum compromisso {visao === "semana" ? "nesta semana" : "neste período"}</h2>
              <p className="mt-1 text-sm text-[var(--color-texto-fraco)]">Eventos criados no celular ou no computador aparecerão aqui.</p>
              <button disabled={!online} onClick={abrirCriacaoPadrao} className="mt-4 rounded-lg bg-[var(--color-forte)] px-4 py-2 text-sm text-[var(--color-sobre-forte)] disabled:opacity-50">Criar</button>
            </section>
          ) : (
            <ol className="relative ml-2 border-l-2 border-[var(--color-realce)]/35">
              {eventosVisiveis.map((evento) => (
                <EventoNaAgenda key={`${evento.id}:${evento.recorrenciaId ?? evento.inicio}`} evento={evento} />
              ))}
            </ol>
          )}
          </div>}
        </main>
      </div>
      <button type="button" disabled={!online} onClick={abrirCriacaoPadrao} aria-label="Criar evento" className="fixed right-4 z-30 grid h-14 w-14 place-items-center rounded-full bg-[var(--color-forte)] text-3xl font-light text-[var(--color-sobre-forte)] shadow-xl transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-realce)] disabled:opacity-50 md:hidden" style={{ bottom: "calc(1rem + env(safe-area-inset-bottom, 0px))" }}>+</button>
      {editorAberto && <EditorEvento agendas={agendas} key={eventoEditando ? `${eventoEditando.id}:${eventoEditando.recorrenciaId ?? "all"}` : `novo:${inicioCriacao?.toISOString()}`} data={inicioCriacao ?? data} fimInicial={rascunhoCriacao?.fim} tituloInicial={rascunhoCriacao?.titulo} descricaoInicial={rascunhoCriacao?.descricao} convidadosSugeridos={rascunhoCriacao?.convidadosSugeridos} diaInteiroInicial={rascunhoCriacao?.diaInteiro} evento={eventoEditando ?? undefined} escopo={escopoEditor} fusoPadrao={preferencias?.timezone} lembretePadrao={preferencias?.defaultReminder} lembreteDiaInteiroPadrao={preferencias?.defaultAllDayReminder} conflitoExterno={conflitoExterno} onConflitoResolvido={() => setConflitoExterno(false)} onFechar={() => { setEditorAberto(false); setEventoEditando(null); setEscopoEditor(undefined); setRascunhoCriacao(null); setConflitoExterno(false); }} onSalvar={() => { setEditorAberto(false); setEventoEditando(null); setEscopoEditor(undefined); setRascunhoCriacao(null); setConflitoExterno(false); void carregar(); }} />}
      {eventoAberto && <DetalheEvento evento={eventoAberto} fuso={preferencias?.timezone} somenteLeitura={!online} onFechar={() => setEventoAberto(null)} onEditar={() => pedirEscopo(eventoAberto, "editar", (escopo) => abrirEdicao(eventoAberto, escopo))} onDuplicar={() => { const origem = eventoAberto; void criarEventoAgenda({ titulo: `${origem.titulo} (cópia)`, inicio: origem.inicio, fim: origem.fim, diaInteiro: origem.diaInteiro, fuso: origem.fuso, local: origem.local, descricao: origem.descricao, recorrencia: origem.recorrencia, lembretes: origem.lembretes, convidados: origem.convidados, disponibilidade: origem.disponibilidade }).then((copia) => { setEventos((atuais) => [...atuais, copia]); setEventoAberto(copia); }).catch((falha) => setErro(falha instanceof Error ? falha.message : "Não foi possível duplicar o evento.")); }} onExcluir={() => pedirEscopo(eventoAberto, "excluir", (escopo) => excluirSelecionado(eventoAberto, escopo))} />}
      <div className="fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col gap-2">{exclusoesPendentes.map((pendente) => <div key={pendente.evento.id} role="status" className="flex items-center gap-4 rounded-lg bg-[var(--color-forte)] px-4 py-3 text-sm text-[var(--color-sobre-forte)] shadow-xl"><span>“{pendente.evento.titulo}” excluído</span><button type="button" onClick={() => { window.clearTimeout(pendente.timer); setEventos((atuais) => [...atuais, pendente.evento]); setExclusoesPendentes((atuais) => atuais.filter((item) => item.evento.id !== pendente.evento.id)); }} className="font-semibold underline">Desfazer</button></div>)}</div>
      <div className="fixed bottom-5 right-5 z-[60] flex flex-col gap-2">{alteracoesPendentes.map((pendente) => <div key={pendente.atual.id} role="status" className="flex items-center gap-4 rounded-lg bg-[var(--color-forte)] px-4 py-3 text-sm text-[var(--color-sobre-forte)] shadow-xl"><span>Horário alterado</span><button type="button" onClick={() => { window.clearTimeout(pendente.timer); const restaurado = { ...pendente.anterior, etag: pendente.atual.etag }; setEventos((atuais) => atuais.map((item) => item.id === restaurado.id ? restaurado : item)); setAlteracoesPendentes((atuais) => atuais.filter((item) => item.atual.id !== pendente.atual.id)); void atualizarEventoAgenda(pendente.atual.id, pendente.atual.etag, { inicio: pendente.anterior.inicio, fim: pendente.anterior.fim }).then((salvo) => setEventos((atuais) => atuais.map((item) => item.id === salvo.id ? salvo : item))).catch((falha) => { setErro(falha instanceof Error ? falha.message : "Não foi possível desfazer a alteração."); void carregar(); }); }} className="font-semibold underline">Desfazer</button></div>)}</div>
      {buscaAberta && <BuscaAgenda onFechar={() => setBuscaAberta(false)} onEvento={(evento) => { const destino = evento.diaInteiro ? lerDataCivil(evento.inicio.slice(0, 10)) : new Date(evento.inicio); atualizarUrl(destino, "dia"); setEventoAberto(evento); }} />}
      {ajuda && <AjudaAtalhosAgenda atalhos={atalhos} onFechar={() => setAjuda(false)} />}
      {acaoEscopo && <DialogoRecorrencia acao={acaoEscopo} onCancelar={() => { setAcaoEscopo(null); executarEscopo.current = null; }} onEscolher={(escopo) => { const executar = executarEscopo.current; setAcaoEscopo(null); executarEscopo.current = null; executar?.(escopo); }} />}
    </div>
  );
}
