const DIAS = ["domingo", "segunda-feira", "terça-feira", "quarta-feira", "quinta-feira", "sexta-feira", "sábado"];
const DIA_RRULE: Record<string, string> = { SU: "domingo", MO: "segunda", TU: "terça", WE: "quarta", TH: "quinta", FR: "sexta", SA: "sábado" };

function juntar(lista: string[]): string {
  return lista.length <= 1 ? (lista[0] ?? "") : `${lista.slice(0, -1).join(", ")} e ${lista.at(-1)}`;
}

export function recorrenciaEmPortugues(regra?: string): string | null {
  if (!regra) return null;
  const partes = new Map(regra.split(";").map((item) => item.split("=", 2) as [string, string]));
  const frequencia = partes.get("FREQ");
  const suportadas = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL"]);
  if ([...partes.keys()].some((chave) => !suportadas.has(chave))) return `Regra personalizada: ${regra}`;
  const diasBrutos = partes.get("BYDAY")?.split(",") ?? [];
  if (diasBrutos.some((dia) => !/^(SU|MO|TU|WE|TH|FR|SA)$/.test(dia))) return `Regra personalizada: ${regra}`;
  const intervalo = Number(partes.get("INTERVAL") ?? "1");
  let texto: string;
  if (frequencia === "DAILY") texto = intervalo === 1 ? "Todos os dias" : `A cada ${intervalo} dias`;
  else if (frequencia === "WEEKLY") texto = intervalo === 1 ? "Toda semana" : `A cada ${intervalo} semanas`;
  else if (frequencia === "MONTHLY") texto = intervalo === 1 ? "Todo mês" : `A cada ${intervalo} meses`;
  else if (frequencia === "YEARLY") texto = intervalo === 1 ? "Todo ano" : `A cada ${intervalo} anos`;
  else return `Regra personalizada: ${regra}`;
  const dias = diasBrutos.map((dia) => DIA_RRULE[dia] ?? dia);
  if (dias?.length) texto += `, ${juntar(dias)}`;
  const contagem = partes.get("COUNT");
  if (contagem) texto += `, por ${contagem} ocorrências`;
  const ate = partes.get("UNTIL");
  if (ate && /^\d{8}/.test(ate)) texto += `, até ${ate.slice(6, 8)}/${ate.slice(4, 6)}/${ate.slice(0, 4)}`;
  return texto;
}

export function diaDaSemanaEmPortugues(data: Date): string {
  return DIAS[data.getDay()] ?? "";
}

export function resumoRespostas(convidados: Array<{ resposta: "pendente" | "aceito" | "recusado" | "talvez" }>): string {
  const totais = { aceito: 0, talvez: 0, recusado: 0, pendente: 0 };
  for (const convidado of convidados) totais[convidado.resposta] += 1;
  return [
    totais.aceito ? `${totais.aceito} sim` : "",
    totais.talvez ? `${totais.talvez} talvez` : "",
    totais.recusado ? `${totais.recusado} não` : "",
    totais.pendente ? `${totais.pendente} sem resposta` : "",
  ].filter(Boolean).join(" · ");
}
