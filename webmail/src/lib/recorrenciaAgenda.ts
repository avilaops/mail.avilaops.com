import { recorrenciaEmPortugues } from "@/lib/detalheAgenda";

export type FrequenciaAgenda = "nenhuma" | "diaria" | "semanal" | "mensal-dia" | "mensal-semana" | "anual" | "personalizada";
export type TerminoRecorrencia = "nunca" | "data" | "quantidade";

export interface ConfiguracaoRecorrencia {
  frequencia: FrequenciaAgenda;
  intervalo: number;
  diasSemana: string[];
  termino: TerminoRecorrencia;
  dataTermino: string;
  quantidade: number;
  personalizada: string;
}

const DIAS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function lerConfiguracaoRecorrencia(regra: string, inicio: Date): ConfiguracaoRecorrencia {
  const partes = new Map(regra.split(";").filter(Boolean).map((item) => item.split("=", 2) as [string, string]));
  const frequencia = partes.get("FREQ");
  const suportadas = new Set(["FREQ", "INTERVAL", "BYDAY", "BYMONTHDAY", "BYSETPOS", "COUNT", "UNTIL"]);
  const personalizada = Boolean(regra) && ([...partes.keys()].some((item) => !suportadas.has(item)) || !["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(frequencia ?? ""));
  let tipo: FrequenciaAgenda = "nenhuma";
  if (personalizada) tipo = "personalizada";
  else if (frequencia === "DAILY") tipo = "diaria";
  else if (frequencia === "WEEKLY") tipo = "semanal";
  else if (frequencia === "MONTHLY") tipo = partes.has("BYSETPOS") ? "mensal-semana" : "mensal-dia";
  else if (frequencia === "YEARLY") tipo = "anual";
  const until = partes.get("UNTIL") ?? "";
  return {
    frequencia: tipo,
    intervalo: Math.max(1, Number(partes.get("INTERVAL") ?? 1)),
    diasSemana: partes.get("BYDAY")?.split(",").filter((dia) => DIAS.includes(dia)) ?? [DIAS[inicio.getDay()]!],
    termino: partes.has("COUNT") ? "quantidade" : partes.has("UNTIL") ? "data" : "nunca",
    dataTermino: /^\d{8}/.test(until) ? `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` : "",
    quantidade: Math.max(1, Number(partes.get("COUNT") ?? 10)),
    personalizada: regra,
  };
}

export function gerarRegraRecorrencia(config: ConfiguracaoRecorrencia, inicio: Date): string {
  if (config.frequencia === "nenhuma") return "";
  if (config.frequencia === "personalizada") return config.personalizada.trim();
  const freq = config.frequencia === "diaria" ? "DAILY" : config.frequencia === "semanal" ? "WEEKLY" : config.frequencia.startsWith("mensal") ? "MONTHLY" : "YEARLY";
  const partes = [`FREQ=${freq}`];
  if (config.intervalo > 1) partes.push(`INTERVAL=${config.intervalo}`);
  if (config.frequencia === "semanal") partes.push(`BYDAY=${config.diasSemana.length ? config.diasSemana.join(",") : DIAS[inicio.getDay()]}`);
  if (config.frequencia === "mensal-dia") partes.push(`BYMONTHDAY=${inicio.getDate()}`);
  if (config.frequencia === "mensal-semana") { partes.push(`BYDAY=${DIAS[inicio.getDay()]}`); partes.push(`BYSETPOS=${Math.ceil(inicio.getDate() / 7)}`); }
  if (config.termino === "quantidade") partes.push(`COUNT=${Math.max(1, config.quantidade)}`);
  if (config.termino === "data" && config.dataTermino) partes.push(`UNTIL=${config.dataTermino.replaceAll("-", "")}T235959Z`);
  return partes.join(";");
}

export function resumoRecorrencia(regra: string): string {
  return recorrenciaEmPortugues(regra) ?? "Não se repete";
}
