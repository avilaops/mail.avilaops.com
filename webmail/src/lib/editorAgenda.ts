export function tituloDoEvento(titulo: string): string {
  return titulo.trim() || "(sem título)";
}

export function moverFimMantendoDuracao(inicioAnterior: string, fimAnterior: string, novoInicio: string): string {
  const duracao = new Date(fimAnterior).getTime() - new Date(inicioAnterior).getTime();
  const fim = new Date(new Date(novoInicio).getTime() + Math.max(0, duracao));
  const deslocamento = fim.getTimezoneOffset() * 60_000;
  return new Date(fim.getTime() - deslocamento).toISOString().slice(0, 16);
}

export function intervaloValido(inicio: string, fim: string): boolean {
  return Boolean(inicio && fim) && new Date(fim).getTime() >= new Date(inicio).getTime();
}

export function proximoDiaCivil(data: string): string {
  const [ano, mes, dia] = data.split("-").map(Number);
  return new Date(Date.UTC(ano!, mes! - 1, dia! + 1)).toISOString().slice(0, 10);
}

export function intervaloDiaInteiro(inicio: string, fim: string): { inicio: string; fim: string } {
  const fimExclusivo = fim > inicio ? fim : proximoDiaCivil(inicio);
  return { inicio: `${inicio}T00:00:00.000Z`, fim: `${fimExclusivo}T00:00:00.000Z` };
}
