import type { EventoAgenda } from "@/lib/tipos";
import { dataCivilNoFuso, partesNoFuso } from "@/lib/fusoAgenda";

export function agruparEventosPorDia(eventos: EventoAgenda[], fuso = "America/Sao_Paulo"): Array<{ dia: Date; eventos: EventoAgenda[] }> {
  const grupos = new Map<string, { dia: Date; eventos: EventoAgenda[] }>();
  for (const evento of [...eventos].sort((a, b) => a.inicio.localeCompare(b.inicio))) {
    const inicio = new Date(evento.inicio);
    const chave = evento.diaInteiro ? evento.inicio.slice(0, 10) : dataCivilNoFuso(inicio, fuso);
    const partes = evento.diaInteiro ? chave.split("-").map(Number) : Object.values(partesNoFuso(inicio, fuso)).slice(0, 3);
    const grupo = grupos.get(chave) ?? { dia: new Date(partes[0]!, partes[1]! - 1, partes[2]!), eventos: [] };
    grupo.eventos.push(evento);
    grupos.set(chave, grupo);
  }
  return [...grupos.values()];
}

export function rotuloDoDia(dia: Date, hoje = new Date()): string {
  const base = new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const alvo = new Date(dia.getFullYear(), dia.getMonth(), dia.getDate());
  const distancia = Math.round((alvo.getTime() - base.getTime()) / 86_400_000);
  if (distancia === 0) return "Hoje";
  if (distancia === 1) return "Amanhã";
  return new Intl.DateTimeFormat("pt-BR", { weekday: "short", day: "numeric", month: "short" }).format(alvo);
}
