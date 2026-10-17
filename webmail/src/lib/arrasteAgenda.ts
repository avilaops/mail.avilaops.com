export function moverIntervalo(inicio: Date, fim: Date, dias: number, minutos: number): { inicio: Date; fim: Date } {
  const novoInicio = new Date(inicio);
  const novoFim = new Date(fim);
  novoInicio.setDate(novoInicio.getDate() + dias);
  novoFim.setDate(novoFim.getDate() + dias);
  novoInicio.setMinutes(novoInicio.getMinutes() + minutos);
  novoFim.setMinutes(novoFim.getMinutes() + minutos);
  return { inicio: novoInicio, fim: novoFim };
}

export function redimensionarFim(inicio: Date, fim: Date, minutos: number): Date {
  const novoFim = new Date(fim);
  novoFim.setMinutes(novoFim.getMinutes() + minutos);
  const minimo = inicio.getTime() + 15 * 60_000;
  return novoFim.getTime() < minimo ? new Date(minimo) : novoFim;
}

export function moverParaDia(inicio: Date, fim: Date, destino: Date): { inicio: Date; fim: Date } {
  const dias = Math.round((Date.UTC(destino.getFullYear(), destino.getMonth(), destino.getDate()) - Date.UTC(inicio.getFullYear(), inicio.getMonth(), inicio.getDate())) / 86_400_000);
  return moverIntervalo(inicio, fim, dias, 0);
}
