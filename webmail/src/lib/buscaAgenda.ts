export function normalizarTermoAgenda(texto: string): string {
  return texto.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");
}

export function intervaloDestaque(texto: string, termo: string): { inicio: number; fim: number } | null {
  const segmentos = [...new Intl.Segmenter("pt-BR", { granularity: "grapheme" }).segment(texto)];
  let normalizado = "";
  const inicios: number[] = [];
  const fins: number[] = [];
  for (const item of segmentos) {
    const trecho = normalizarTermoAgenda(item.segment);
    normalizado += trecho;
    for (let indice = 0; indice < trecho.length; indice += 1) {
      inicios.push(item.index);
      fins.push(item.index + item.segment.length);
    }
  }
  const agulha = normalizarTermoAgenda(termo);
  const indice = normalizado.indexOf(agulha);
  if (!agulha || indice < 0) return null;
  return { inicio: inicios[indice]!, fim: fins[indice + agulha.length - 1]! };
}
