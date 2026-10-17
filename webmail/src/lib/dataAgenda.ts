export type VisaoAgenda = "dia" | "semana" | "mes" | "lista";

export const VISOES_AGENDA: readonly VisaoAgenda[] = ["dia", "semana", "mes", "lista"];

export function dataCivil(data: Date): string {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, "0");
  const dia = String(data.getDate()).padStart(2, "0");
  return `${ano}-${mes}-${dia}`;
}

/** Diferença entre datas civis, imune a dias de 23/25 horas por mudança de fuso. */
export function diferencaDiasCivis(inicio: Date, fim: Date): number {
  const civilUtc = (data: Date) => Date.UTC(data.getFullYear(), data.getMonth(), data.getDate());
  return Math.round((civilUtc(fim) - civilUtc(inicio)) / 86_400_000);
}

export function lerDataCivil(valor: string | null, hoje = new Date()): Date {
  const encontrada = valor?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!encontrada) return new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  const data = new Date(Number(encontrada[1]), Number(encontrada[2]) - 1, Number(encontrada[3]));
  if (dataCivil(data) !== valor) return new Date(hoje.getFullYear(), hoje.getMonth(), hoje.getDate());
  return data;
}

export function lerVisaoAgenda(valor: string | null, celular = false): VisaoAgenda {
  if (VISOES_AGENDA.includes(valor as VisaoAgenda)) return valor as VisaoAgenda;
  return celular ? "lista" : "semana";
}

export function inicioDaSemana(data: Date, primeiroDia: 0 | 1 = 0): Date {
  const resultado = new Date(data.getFullYear(), data.getMonth(), data.getDate());
  const deslocamento = (resultado.getDay() - primeiroDia + 7) % 7;
  resultado.setDate(resultado.getDate() - deslocamento);
  return resultado;
}

export function intervaloDaVisao(data: Date, visao: VisaoAgenda, primeiroDia: 0 | 1 = 0): { inicio: Date; fim: Date } {
  const inicio = visao === "semana" ? inicioDaSemana(data, primeiroDia) : visao === "mes" ? diasDaGradeMes(data, primeiroDia)[0]! : new Date(data.getFullYear(), data.getMonth(), data.getDate());
  const fim = new Date(inicio);
  if (visao === "dia") fim.setDate(fim.getDate() + 1);
  else if (visao === "semana") fim.setDate(fim.getDate() + 7);
  else if (visao === "mes") fim.setDate(fim.getDate() + diasDaGradeMes(data, primeiroDia).length);
  else fim.setDate(fim.getDate() + 30);
  return { inicio, fim };
}

export function navegarData(data: Date, visao: VisaoAgenda, direcao: -1 | 1): Date {
  const resultado = new Date(data);
  if (visao === "dia") resultado.setDate(resultado.getDate() + direcao);
  else if (visao === "semana") resultado.setDate(resultado.getDate() + 7 * direcao);
  else if (visao === "mes") return new Date(resultado.getFullYear(), resultado.getMonth() + direcao, 1);
  else resultado.setDate(resultado.getDate() + 30 * direcao);
  return resultado;
}

export function diasDoMiniCalendario(data: Date, primeiroDia: 0 | 1 = 0): Date[] {
  const primeiro = inicioDaSemana(new Date(data.getFullYear(), data.getMonth(), 1), primeiroDia);
  return Array.from({ length: 42 }, (_, indice) => {
    const dia = new Date(primeiro);
    dia.setDate(dia.getDate() + indice);
    return dia;
  });
}

export function diasDaGradeMes(data: Date, primeiroDia: 0 | 1 = 0): Date[] {
  const primeiro = inicioDaSemana(new Date(data.getFullYear(), data.getMonth(), 1), primeiroDia);
  const ultimoDoMes = new Date(data.getFullYear(), data.getMonth() + 1, 0);
  const distancia = Math.round((ultimoDoMes.getTime() - primeiro.getTime()) / 86_400_000) + 1;
  const quantidade = distancia <= 35 ? 35 : 42;
  return Array.from({ length: quantidade }, (_, indice) => {
    const dia = new Date(primeiro);
    dia.setDate(dia.getDate() + indice);
    return dia;
  });
}

export function rotuloDoIntervalo(data: Date, visao: VisaoAgenda, primeiroDia: 0 | 1 = 0): string {
  const { inicio, fim } = intervaloDaVisao(data, visao, primeiroDia);
  if (visao === "dia") return new Intl.DateTimeFormat("pt-BR", { dateStyle: "long" }).format(inicio);
  if (visao === "mes") return new Intl.DateTimeFormat("pt-BR", { month: "long", year: "numeric" }).format(data);

  const ultimo = new Date(fim);
  ultimo.setDate(ultimo.getDate() - 1);
  const mesmoMes = inicio.getMonth() === ultimo.getMonth() && inicio.getFullYear() === ultimo.getFullYear();
  if (mesmoMes) {
    return `${inicio.getDate()} – ${new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short", year: "numeric" }).format(ultimo)}`;
  }
  return `${new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" }).format(inicio)} – ${new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short", year: "numeric" }).format(ultimo)}`;
}
