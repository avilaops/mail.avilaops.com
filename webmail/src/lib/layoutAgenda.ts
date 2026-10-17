import type { EventoAgenda } from "@/lib/tipos";
import { dataCivilNoFuso, partesNoFuso } from "@/lib/fusoAgenda";

export interface EventoPosicionado {
  evento: EventoAgenda;
  dia: string;
  inicioMinutos: number;
  duracaoMinutos: number;
  coluna: number;
  totalColunas: number;
}

function minutosNoDia(data: Date, fuso: string): number {
  const partes = partesNoFuso(data, fuso);
  return partes.hora * 60 + partes.minuto;
}

export function eventoVaiParaFaixa(evento: EventoAgenda, fuso = "America/Sao_Paulo"): boolean {
  return evento.diaInteiro || dataCivilNoFuso(new Date(evento.inicio), fuso) !== dataCivilNoFuso(new Date(evento.fim), fuso);
}

/** Distribui conflitos transitivos em colunas sem sobrepor blocos visuais. */
export function posicionarEventos(eventos: EventoAgenda[], fuso = "America/Sao_Paulo"): EventoPosicionado[] {
  const porDia = new Map<string, Array<{ evento: EventoAgenda; inicio: number; fim: number }>>();
  for (const evento of eventos) {
    if (eventoVaiParaFaixa(evento, fuso)) continue;
    const inicio = new Date(evento.inicio);
    const fim = new Date(evento.fim);
    const dia = dataCivilNoFuso(inicio, fuso);
    const lista = porDia.get(dia) ?? [];
    lista.push({ evento, inicio: minutosNoDia(inicio, fuso), fim: Math.max(minutosNoDia(fim, fuso), minutosNoDia(inicio, fuso) + 15) });
    porDia.set(dia, lista);
  }

  const saida: EventoPosicionado[] = [];
  for (const [dia, lista] of porDia) {
    lista.sort((a, b) => a.inicio - b.inicio || b.fim - a.fim);
    let grupo: typeof lista = [];
    let fimDoGrupo = -1;

    const concluirGrupo = () => {
      if (grupo.length === 0) return;
      const finais: number[] = [];
      const atribuicoes = grupo.map((item) => {
        let coluna = finais.findIndex((fim) => fim <= item.inicio);
        if (coluna === -1) coluna = finais.length;
        finais[coluna] = item.fim;
        return { item, coluna };
      });
      const totalColunas = Math.max(1, ...atribuicoes.map(({ coluna }) => coluna + 1));
      for (const { item, coluna } of atribuicoes) {
        saida.push({
          evento: item.evento,
          dia,
          inicioMinutos: item.inicio,
          duracaoMinutos: item.fim - item.inicio,
          coluna,
          totalColunas,
        });
      }
      grupo = [];
    };

    for (const item of lista) {
      if (grupo.length > 0 && item.inicio >= fimDoGrupo) concluirGrupo();
      grupo.push(item);
      fimDoGrupo = Math.max(fimDoGrupo, item.fim);
    }
    concluirGrupo();
  }
  return saida;
}
