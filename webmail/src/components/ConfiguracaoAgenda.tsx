"use client";

import { useEffect, useState } from "react";
import { importarAgenda, listarAgendas, salvarPreferenciasAgenda } from "@/lib/cliente";
import type { AgendaCalendario, PreferenciasAgenda } from "@/lib/tipos";
import { enviarAnexo } from "@/lib/upload";
import { validarArquivoIcs } from "@/lib/transferenciaAgenda";

const campo = "mt-1 w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-3 py-2 text-sm";

export function ConfiguracaoAgenda({ inicial, endereco }: { inicial: PreferenciasAgenda; endereco: string }) {
  const [valor, setValor] = useState(inicial);
  const [estado, setEstado] = useState<"parado" | "salvando" | "salvo" | "erro">("parado");
  const [erro, setErro] = useState("");
  const [agendas, setAgendas] = useState<AgendaCalendario[]>([]);
  const [agendaId, setAgendaId] = useState("");
  const [importando, setImportando] = useState(false);
  const [resultadoImportacao, setResultadoImportacao] = useState("");
  const servidor = typeof window === "undefined" ? "https://mail.avilaops.com" : window.location.origin;
  const url = `${servidor}/dav/calendars/${encodeURIComponent(endereco)}/agenda/`;

  useEffect(() => {
    void listarAgendas().then((items) => { setAgendas(items); setAgendaId(items.find((item) => item.padrao)?.id ?? items[0]?.id ?? ""); }).catch(() => undefined);
  }, []);

  async function importar(arquivo: File) {
    const invalido = await validarArquivoIcs(arquivo);
    if (invalido) { setErro(invalido); return; }
    setImportando(true); setErro(""); setResultadoImportacao("");
    try {
      const upload = await enviarAnexo(arquivo, () => undefined).promessa;
      const resultado = await importarAgenda(upload.id, agendaId || undefined);
      setResultadoImportacao(`${resultado.importados} importados, ${resultado.ignorados} ignorados e ${resultado.erros} com erro.`);
    } catch (falha) { setErro(falha instanceof Error ? falha.message : "Não foi possível importar."); }
    finally { setImportando(false); }
  }

  async function salvar() {
    setEstado("salvando");
    setErro("");
    try {
      setValor(await salvarPreferenciasAgenda(valor));
      setEstado("salvo");
      window.setTimeout(() => setEstado("parado"), 2500);
    } catch (falha) {
      setEstado("erro");
      setErro(falha instanceof Error ? falha.message : "Não foi possível salvar.");
    }
  }

  return <div className="space-y-4">
    <label className="block text-sm font-medium">Fuso horário<input value={valor.timezone} onChange={(e) => setValor({ ...valor, timezone: e.target.value })} className={campo} list="fusos-agenda" /><datalist id="fusos-agenda"><option value="America/Sao_Paulo" /><option value="America/Manaus" /><option value="America/Cuiaba" /><option value="America/Rio_Branco" /><option value="UTC" /></datalist></label>
    <label className="block text-sm font-medium">Primeiro dia da semana<select value={valor.weekStart} onChange={(e) => setValor({ ...valor, weekStart: Number(e.target.value) as 0 | 1 })} className={campo}><option value={0}>Domingo</option><option value={1}>Segunda-feira</option></select></label>
    <div className="grid grid-cols-2 gap-3"><label className="block text-sm font-medium">Expediente começa<input type="time" value={valor.businessHoursStart} onChange={(e) => setValor({ ...valor, businessHoursStart: e.target.value })} className={campo} /></label><label className="block text-sm font-medium">Expediente termina<input type="time" value={valor.businessHoursEnd} onChange={(e) => setValor({ ...valor, businessHoursEnd: e.target.value })} className={campo} /></label></div>
    <label className="block text-sm font-medium">Visualização padrão<select value={valor.defaultView} onChange={(e) => setValor({ ...valor, defaultView: e.target.value as PreferenciasAgenda["defaultView"] })} className={campo}><option value="day">Dia</option><option value="week">Semana</option><option value="month">Mês</option><option value="list">Lista</option></select></label>
    <div className="grid grid-cols-2 gap-3"><label className="block text-sm font-medium">Lembrete padrão (min)<input type="number" min={0} max={525600} value={valor.defaultReminder} onChange={(e) => setValor({ ...valor, defaultReminder: Number(e.target.value) })} className={campo} /></label><label className="block text-sm font-medium">Dia inteiro (min)<input type="number" min={0} max={525600} value={valor.defaultAllDayReminder} onChange={(e) => setValor({ ...valor, defaultAllDayReminder: Number(e.target.value) })} className={campo} /></label></div>
    {erro && <p role="alert" className="text-sm text-[var(--color-perigo)]">{erro}</p>}
    <div className="flex items-center gap-3"><button type="button" onClick={() => void salvar()} disabled={estado === "salvando"} className="rounded-lg bg-[var(--color-forte)] px-4 py-2 text-sm font-medium text-[var(--color-sobre-forte)] disabled:opacity-50">{estado === "salvando" ? "Salvando…" : "Salvar"}</button>{estado === "salvo" && <span className="text-xs text-emerald-700">salvo</span>}</div>
    <div className="rounded-lg bg-[var(--color-fundo-suave)] p-3 text-xs text-[var(--color-texto-fraco)]"><p className="font-medium text-[var(--color-tinta)]">Sincronização CalDAV</p><p className="mt-1 break-all">Servidor: <code>{url}</code></p><p className="mt-2">iPhone/iPad: Ajustes → Apps → Calendário → Contas → Outra → Adicionar Conta CalDAV.</p><p className="mt-1">Android: use DAVx⁵. Outlook e Thunderbird: adicione um calendário CalDAV com o servidor acima. O usuário é seu e-mail completo.</p></div>
    <section className="rounded-lg border border-[var(--color-borda)] p-4"><h3 className="text-sm font-semibold">Importar ou exportar .ics</h3><p className="mt-1 text-xs text-[var(--color-texto-fraco)]">No Google Agenda: Configurações → Importar e exportar → Exportar. No Outlook: Calendário → Configurações → Calendários compartilhados → Publicar ou exportar.</p><label className="mt-3 block text-sm font-medium">Agenda de destino<select value={agendaId} onChange={(item) => setAgendaId(item.target.value)} className={campo}>{agendas.map((agenda) => <option key={agenda.id} value={agenda.id}>{agenda.nome}</option>)}</select></label><div className="mt-3 flex flex-wrap gap-2"><label className="cursor-pointer rounded-lg border border-[var(--color-borda)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-fundo-suave)]">{importando ? "Importando…" : "Importar .ics"}<input className="sr-only" type="file" accept=".ics,text/calendar" disabled={importando} onChange={(item) => { const arquivo = item.target.files?.[0]; if (arquivo) void importar(arquivo); item.target.value = ""; }} /></label><a download href={`/api/mail/me/calendar/export${agendaId ? `?agendaId=${encodeURIComponent(agendaId)}` : ""}`} className="rounded-lg border border-[var(--color-borda)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-fundo-suave)]">Exportar agenda</a><a download href="/api/mail/me/calendar/export" className="rounded-lg border border-[var(--color-borda)] px-4 py-2 text-sm font-medium hover:bg-[var(--color-fundo-suave)]">Exportar todas</a></div>{resultadoImportacao && <p role="status" className="mt-2 text-sm text-emerald-700">{resultadoImportacao}</p>}<p className="mt-2 text-xs text-[var(--color-texto-fraco)]">Limites: 50 MB, 10 mil eventos e 512 KB por evento.</p></section>
  </div>;
}
