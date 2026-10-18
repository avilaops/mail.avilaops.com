"use client";

import { useEffect, useRef, useState } from "react";
import { CampoDestinatarios } from "@/components/CampoDestinatarios";
import { atualizarEventoAgenda, criarEventoAgenda, ErroApi, obterEventoAgenda } from "@/lib/cliente";
import { dataCivil } from "@/lib/dataAgenda";
import { intervaloDiaInteiro, intervaloValido, moverFimMantendoDuracao, proximoDiaCivil, tituloDoEvento } from "@/lib/editorAgenda";
import type { AgendaCalendario, DadosEventoAgenda, EventoAgenda } from "@/lib/tipos";
import { useFocoModal } from "@/lib/useFocoModal";
import { EditorRecorrencia } from "@/components/EditorRecorrencia";
import { civilParaInstante, instanteParaCivil } from "@/lib/fusoAgenda";
import type { EscopoRecorrencia } from "@/components/DialogoRecorrencia";

function valorLocal(data: Date): string {
  const hora = String(data.getHours()).padStart(2, "0");
  const minuto = String(data.getMinutes()).padStart(2, "0");
  return `${dataCivil(data)}T${hora}:${minuto}`;
}

interface Props {
  data: Date;
  fimInicial?: Date;
  tituloInicial?: string;
  diaInteiroInicial?: boolean;
  evento?: EventoAgenda;
  onFechar: () => void;
  onSalvar: (evento: EventoAgenda) => void;
  conflitoExterno?: boolean;
  onConflitoResolvido?: () => void;
  fusoPadrao?: string;
  lembretePadrao?: number;
  lembreteDiaInteiroPadrao?: number;
  escopo?: EscopoRecorrencia;
  agendas: AgendaCalendario[];
  descricaoInicial?: string;
  convidadosSugeridos?: string[];
}

export function EditorEvento({ data, fimInicial, tituloInicial, diaInteiroInicial, evento, onFechar, onSalvar, conflitoExterno = false, onConflitoResolvido, fusoPadrao, lembretePadrao = 10, lembreteDiaInteiroPadrao = 1440, escopo, agendas, descricaoInicial, convidadosSugeridos = [] }: Props) {
  const modal = useRef<HTMLElement>(null);
  useFocoModal(modal);
  const inicioPadrao = evento ? new Date(evento.inicio) : data;
  const fimPadrao = evento ? new Date(evento.fim) : (fimInicial ?? new Date(inicioPadrao.getTime() + 3_600_000));
  const fusoInicial = evento?.fuso ?? fusoPadrao ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || "America/Sao_Paulo");
  const [titulo, setTitulo] = useState(evento?.titulo ?? tituloInicial ?? "");
  const inicialmenteDiaInteiro = evento?.diaInteiro ?? diaInteiroInicial ?? false;
  const [inicio, setInicio] = useState(inicialmenteDiaInteiro ? (evento?.inicio.slice(0, 10) ?? dataCivil(inicioPadrao)) : evento ? instanteParaCivil(inicioPadrao, fusoInicial) : valorLocal(inicioPadrao));
  const [fim, setFim] = useState(inicialmenteDiaInteiro ? (evento?.fim.slice(0, 10) ?? dataCivil(fimPadrao)) : evento ? instanteParaCivil(fimPadrao, fusoInicial) : valorLocal(fimPadrao));
  const [diaInteiro, setDiaInteiro] = useState(inicialmenteDiaInteiro);
  const [fuso, setFuso] = useState(fusoInicial);
  const [mostrarFuso, setMostrarFuso] = useState(false);
  const [local, setLocal] = useState(evento?.local ?? "");
  const [descricao, setDescricao] = useState(evento?.descricao ?? descricaoInicial ?? "");
  const [recorrencia, setRecorrencia] = useState(evento?.recorrencia ?? "");
  const [convidados, setConvidados] = useState(evento?.convidados.map((item) => item.email) ?? []);
  const [lembretes, setLembretes] = useState<number[]>(evento?.lembretes.map((item) => item.minutosAntes) ?? [inicialmenteDiaInteiro ? lembreteDiaInteiroPadrao : lembretePadrao]);
  const lembretePersonalizado = useRef(Boolean(evento));
  const [disponibilidade, setDisponibilidade] = useState<"ocupado" | "livre">(evento?.disponibilidade ?? "ocupado");
  const [agendaId, setAgendaId] = useState(evento?.agendaId ?? agendas.find((item) => item.padrao)?.id ?? agendas[0]?.id ?? "");
  const [salvando, setSalvando] = useState(false);
  const [detalhesAbertos, setDetalhesAbertos] = useState(Boolean(evento || local || descricao || convidadosSugeridos.length));
  const [alterado, setAlterado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [conflito, setConflito] = useState(false);
  const [versaoAtual, setVersaoAtual] = useState(evento);

  function fechar() {
    if (!alterado || window.confirm("Descartar as alterações deste evento?")) onFechar();
  }

  useEffect(() => {
    function aoTeclar(eventoTeclado: KeyboardEvent) {
      if (eventoTeclado.key !== "Escape") return;
      eventoTeclado.preventDefault();
      fechar();
    }
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  });

  function mudarInicio(novoInicio: string) {
    setFim(moverFimMantendoDuracao(inicio, fim, novoInicio));
    setInicio(novoInicio);
    setAlterado(true);
  }

  async function salvar() {
    if (!diaInteiro && !intervaloValido(inicio, fim)) {
      setErro("O fim não pode ser anterior ao início.");
      return;
    }
    setSalvando(true);
    setErro(null);
    setConflito(false);
    try {
      const intervalo = diaInteiro ? intervaloDiaInteiro(inicio, fim) : { inicio: civilParaInstante(inicio, fuso).toISOString(), fim: civilParaInstante(fim, fuso).toISOString() };
      const convidadosOriginais = new Map(versaoAtual?.convidados.map((item) => [item.email.toLowerCase(), item]) ?? []);
      const dados: DadosEventoAgenda = {
        agendaId,
        titulo: tituloDoEvento(titulo), inicio: intervalo.inicio, fim: intervalo.fim, diaInteiro, fuso,
        local: local.trim(), descricao: descricao.trim(), recorrencia,
        lembretes: lembretes.map((minutosAntes) => ({ minutosAntes })),
        convidados: convidados.map((email) => convidadosOriginais.get(email.toLowerCase()) ?? { email, resposta: "pendente" as const }),
        organizador: evento?.organizador, disponibilidade,
      };
      const haviaConvidados = (versaoAtual?.convidados.length ?? 0) > 0;
      const devePerguntar = convidados.length > 0 || haviaConvidados;
      const notificarConvidados = devePerguntar && window.confirm(versaoAtual ? "Enviar esta atualização aos convidados?" : "Enviar convite aos convidados?");
      const salvo = versaoAtual
        ? await atualizarEventoAgenda(versaoAtual.id, versaoAtual.etag, dados, escopo && versaoAtual.recorrenciaId ? { scope: escopo, recurrenceId: versaoAtual.recorrenciaId } : undefined, { notificarConvidados })
        : await criarEventoAgenda(dados, { notificarConvidados });
      onSalvar(salvo);
    } catch (falha) {
      if (falha instanceof ErroApi && falha.status === 412) {
        setConflito(true);
        setErro("Este evento mudou em outro aparelho.");
      } else {
        setErro(falha instanceof Error ? falha.message : "Não foi possível salvar o evento.");
      }
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div role="presentation" onMouseDown={(item) => item.target === item.currentTarget && fechar()} className="fixed inset-0 z-50 overflow-hidden bg-black/40 md:flex md:justify-end">
      <section ref={modal} role="dialog" aria-modal="true" aria-labelledby="titulo-editor-evento" className="ml-auto flex h-[100dvh] min-w-0 max-w-full flex-col overflow-hidden bg-[var(--color-superficie)] shadow-2xl md:max-w-xl md:border-l md:border-[var(--color-borda)]">
        <header className="flex items-center justify-between border-b border-[var(--color-borda)] px-5 py-4">
          <h2 id="titulo-editor-evento" className="text-lg font-semibold">{evento ? "Editar evento" : "Novo evento"}</h2>
          <button type="button" onClick={fechar} aria-label="Fechar editor" className="rounded-md px-2 py-1 text-xl text-[var(--color-texto-fraco)] hover:bg-[var(--color-fundo-suave)]">×</button>
        </header>
        <form onSubmit={(item) => { item.preventDefault(); void salvar(); }} className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="rolagem-fina min-h-0 min-w-0 flex-1 space-y-5 overflow-x-hidden overflow-y-auto p-4 sm:p-5">
            <label className="block text-sm font-medium">Título<input autoFocus maxLength={500} value={titulo} onChange={(item) => { setTitulo(item.target.value); setAlterado(true); }} className="mt-1.5 w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-fundo)] px-3 py-2.5 outline-none focus:border-[var(--color-realce)]" /></label>
            <label className="block text-sm font-medium">Agenda<select required value={agendaId} onChange={(item) => { setAgendaId(item.target.value); setAlterado(true); }} className="mt-1.5 w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-fundo)] px-3 py-2">{agendas.map((agenda) => <option key={agenda.id} value={agenda.id}>{agenda.nome}</option>)}</select></label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="min-w-0 text-sm font-medium">Início<input required type={diaInteiro ? "date" : "datetime-local"} value={inicio} onChange={(item) => diaInteiro ? (setInicio(item.target.value), setAlterado(true)) : mudarInicio(item.target.value)} className="mt-1.5 block w-full min-w-0 max-w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-fundo)] px-3 py-2 outline-none focus:border-[var(--color-realce)]" /></label>
              <label className="min-w-0 text-sm font-medium">Fim<input required type={diaInteiro ? "date" : "datetime-local"} min={diaInteiro ? proximoDiaCivil(inicio) : inicio} value={fim} onChange={(item) => { setFim(item.target.value); setAlterado(true); }} className="mt-1.5 block w-full min-w-0 max-w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-fundo)] px-3 py-2 outline-none focus:border-[var(--color-realce)]" /></label>
            </div>
            <div className="flex flex-wrap items-center gap-4 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={diaInteiro} onChange={(item) => { const marcado = item.target.checked; if (marcado) { const dia = inicio.slice(0, 10); setInicio(dia); setFim(proximoDiaCivil(dia)); } else { setInicio(`${inicio.slice(0, 10)}T09:00`); setFim(`${inicio.slice(0, 10)}T10:00`); } if (!evento && !lembretePersonalizado.current) setLembretes([marcado ? lembreteDiaInteiroPadrao : lembretePadrao]); setDiaInteiro(marcado); setAlterado(true); }} />Dia inteiro</label><button type="button" onClick={() => { setMostrarFuso((atual) => !atual); setDetalhesAbertos(true); }} className="text-[var(--color-realce)] hover:underline">Fuso horário</button></div>
            <button type="button" aria-expanded={detalhesAbertos} onClick={() => setDetalhesAbertos((atual) => !atual)} className="flex min-h-11 w-full items-center justify-between rounded-lg border border-[var(--color-borda)] px-3 text-left text-sm font-medium hover:bg-[var(--color-fundo-suave)]"><span>{detalhesAbertos ? "Menos opções" : "Mais opções"}</span><span aria-hidden="true">{detalhesAbertos ? "−" : "+"}</span></button>
            {detalhesAbertos && <div className="min-w-0 space-y-5">
            {mostrarFuso && <label className="block text-sm font-medium">Fuso<input value={fuso} onChange={(item) => { setFuso(item.target.value); setAlterado(true); }} className="mt-1.5 w-full min-w-0 rounded-lg border border-[var(--color-borda)] bg-[var(--color-fundo)] px-3 py-2" /></label>}
            <label className="block text-sm font-medium">Local<input maxLength={2000} value={local} onChange={(item) => { setLocal(item.target.value); setAlterado(true); }} className="mt-1.5 w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-fundo)] px-3 py-2" /></label>
            <label className="block text-sm font-medium">Descrição<textarea maxLength={100000} rows={5} value={descricao} onChange={(item) => { setDescricao(item.target.value); setAlterado(true); }} className="mt-1.5 w-full resize-y rounded-lg border border-[var(--color-borda)] bg-[var(--color-fundo)] px-3 py-2" /></label>
            <div className="overflow-hidden rounded-lg border border-[var(--color-borda)]"><CampoDestinatarios rotulo="Convidados" valores={convidados} onMudar={(valores) => { setConvidados(valores); setAlterado(true); }} /></div>
            {convidadosSugeridos.length > 0 && <fieldset><legend className="text-xs font-medium text-[var(--color-texto-fraco)]">Sugeridos pela mensagem</legend><div className="mt-2 flex flex-wrap gap-2">{convidadosSugeridos.map((email) => <label key={email} className="flex items-center gap-2 rounded-full border border-[var(--color-borda)] px-3 py-1.5 text-xs"><input type="checkbox" checked={convidados.includes(email)} onChange={(item) => { setConvidados(item.target.checked ? [...convidados, email] : convidados.filter((valor) => valor !== email)); setAlterado(true); }} />{email}</label>)}</div></fieldset>}
            <fieldset><legend className="mb-2 text-sm font-medium">Lembretes</legend><div className="space-y-2">{lembretes.map((minutos, indice) => { const predefinido = [10, 60, 1440].includes(minutos); return <div key={indice} className="flex gap-2"><select aria-label={`Lembrete ${indice + 1}`} value={predefinido ? String(minutos) : "personalizado"} onChange={(item) => { lembretePersonalizado.current = true; const copia = [...lembretes]; copia[indice] = item.target.value === "personalizado" ? 30 : Number(item.target.value); setLembretes(copia); setAlterado(true); }} className="rounded-lg border border-[var(--color-borda)] bg-[var(--color-fundo)] px-3 py-2 text-sm"><option value="10">10 minutos antes</option><option value="60">1 hora antes</option><option value="1440">1 dia antes</option><option value="personalizado">Personalizado</option></select>{!predefinido && <input aria-label="Minutos do lembrete personalizado" type="number" min="0" max="525600" value={minutos} onChange={(item) => { lembretePersonalizado.current = true; const copia = [...lembretes]; copia[indice] = Number(item.target.value); setLembretes(copia); setAlterado(true); }} className="w-28 rounded-lg border border-[var(--color-borda)] bg-[var(--color-fundo)] px-3 py-2 text-sm" />}<button type="button" onClick={() => { lembretePersonalizado.current = true; setLembretes(lembretes.filter((_, posicao) => posicao !== indice)); setAlterado(true); }} aria-label={`Remover lembrete ${indice + 1}`} className="rounded-lg px-3 hover:bg-[var(--color-fundo-suave)]">×</button></div>; })}</div><button type="button" onClick={() => { lembretePersonalizado.current = true; setLembretes([...lembretes, 30]); setAlterado(true); }} className="mt-2 text-sm text-[var(--color-realce)] hover:underline">Adicionar lembrete</button></fieldset>
            <label className="block text-sm font-medium">Disponibilidade<select value={disponibilidade} onChange={(item) => { setDisponibilidade(item.target.value as "ocupado" | "livre"); setAlterado(true); }} className="mt-1.5 w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-fundo)] px-3 py-2"><option value="ocupado">Ocupado</option><option value="livre">Livre</option></select></label>
            <EditorRecorrencia regra={recorrencia} inicio={new Date(diaInteiro ? `${inicio}T12:00:00` : inicio)} onMudar={(regra) => { setRecorrencia(regra); setAlterado(true); }} />
            </div>}
            {(conflitoExterno && !erro) && <p role="alert" className="text-sm text-[var(--color-perigo)]">Este evento mudou em outro aparelho.</p>}
            {erro && <p role="alert" className="text-sm text-[var(--color-perigo)]">{erro}</p>}
            {(conflito || conflitoExterno) && versaoAtual && <button type="button" onClick={() => { void obterEventoAgenda(versaoAtual.id).then((atual) => { setVersaoAtual(atual); setConflito(false); onConflitoResolvido?.(); setErro("Versão atual recarregada; suas alterações foram mantidas."); }).catch((falha) => setErro(falha instanceof Error ? falha.message : "Não foi possível recarregar o evento.")); }} className="text-sm font-medium text-[var(--color-realce)] hover:underline">Recarregar versão atual</button>}
          </div>
          <footer className="rodape-seguro flex shrink-0 justify-end gap-2 border-t border-[var(--color-borda)] px-4 pt-3"><button type="button" onClick={fechar} className="min-h-11 rounded-lg px-4 py-2 text-sm hover:bg-[var(--color-fundo-suave)]">Cancelar</button><button disabled={salvando} className="min-h-11 rounded-lg bg-[var(--color-forte)] px-5 py-2 text-sm font-medium text-[var(--color-sobre-forte)] disabled:opacity-50">{salvando ? "Salvando…" : "Salvar"}</button></footer>
        </form>
      </section>
    </div>
  );
}
