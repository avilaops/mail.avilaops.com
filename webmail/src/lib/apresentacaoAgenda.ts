import { intervaloDaVisao, type VisaoAgenda } from "@/lib/dataAgenda";

export function deveMostrarGradeAgenda(visao: VisaoAgenda, comErro: boolean): boolean {
  return !comErro && (visao === "dia" || visao === "semana" || visao === "mes");
}

export function classeConteudoAgenda(visao: VisaoAgenda): string {
  return visao === "dia" || visao === "semana" || visao === "mes"
    ? "min-h-0 flex-1 overflow-hidden"
    : "rolagem-fina min-h-0 flex-1 overflow-y-auto";
}

export function rotuloCompactoAgenda(data: Date, visao: VisaoAgenda, primeiroDia: 0 | 1 = 0): string {
  if (visao === "dia") {
    return new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" }).format(data);
  }
  if (visao === "semana") {
    const periodo = intervaloDaVisao(data, visao, primeiroDia);
    const ultimo = new Date(periodo.fim);
    ultimo.setDate(ultimo.getDate() - 1);
    const inicio = new Intl.DateTimeFormat("pt-BR", { day: "numeric" }).format(periodo.inicio);
    const fim = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "short" }).format(ultimo).replace(" de ", " ");
    return `${inicio}–${fim}`;
  }
  return new Intl.DateTimeFormat("pt-BR", { month: "short", year: "numeric" }).format(data);
}
