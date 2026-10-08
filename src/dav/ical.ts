/**
 * Leitura minima de vCard (RFC 6350) e iCalendar (RFC 5545).
 *
 * O blob do cliente e guardado byte a byte — o que se extrai aqui e so o
 * indice: UID para identidade, FN/SUMMARY para listagem, e a janela do VEVENT
 * para o filtro time-range. Reescrever o formato do cliente e o caminho certo
 * para corromper um campo que a gente nem conhece.
 */

/** Desdobra linhas continuadas (CRLF + espaco/tab) e descarta vazias. */
export function desdobrarLinhas(texto: string): string[] {
  const linhas: string[] = [];
  for (const bruta of texto.split(/\r?\n/)) {
    if ((bruta.startsWith(" ") || bruta.startsWith("\t")) && linhas.length > 0) {
      linhas[linhas.length - 1] += bruta.slice(1);
    } else if (bruta !== "") {
      linhas.push(bruta);
    }
  }
  return linhas;
}

function desescapar(valor: string): string {
  return valor
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

interface Linha {
  nome: string;
  parametros: string;
  valor: string;
}

function abrirLinha(linha: string): Linha | null {
  const doisPontos = linha.indexOf(":");
  if (doisPontos <= 0) return null;
  const cabeca = linha.slice(0, doisPontos);
  const pontoEVirgula = cabeca.indexOf(";");
  return {
    nome: (pontoEVirgula === -1 ? cabeca : cabeca.slice(0, pontoEVirgula)).toUpperCase(),
    parametros: pontoEVirgula === -1 ? "" : cabeca.slice(pontoEVirgula + 1).toUpperCase(),
    valor: linha.slice(doisPontos + 1),
  };
}

function primeira(linhas: string[], nome: string): Linha | null {
  for (const linha of linhas) {
    const aberta = abrirLinha(linha);
    if (aberta?.nome === nome) return aberta;
  }
  return null;
}

export interface VCardLido {
  uid: string | null;
  fn: string | null;
}

/** Null quando o corpo nao e um vCard. */
export function lerVCard(texto: string): VCardLido | null {
  const linhas = desdobrarLinhas(texto);
  if (linhas[0]?.toUpperCase() !== "BEGIN:VCARD") return null;
  if (!linhas.some((linha) => linha.toUpperCase() === "END:VCARD")) return null;

  return {
    uid: primeira(linhas, "UID") ? desescapar(primeira(linhas, "UID")!.valor) : null,
    fn: primeira(linhas, "FN") ? desescapar(primeira(linhas, "FN")!.valor) : null,
  };
}

/**
 * Data do iCalendar: `20260819T120000Z`, `20260819T120000` (flutuante ou com
 * TZID — tratada como UTC: o filtro time-range e um recorte grosso, e errar
 * por algumas horas para DENTRO do superconjunto nao perde compromisso) e
 * `20260819` (dia inteiro).
 */
export function lerDataIcal(valor: string): { data: Date; diaInteiro: boolean } | null {
  const soDia = valor.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (soDia) {
    return {
      data: new Date(Date.UTC(Number(soDia[1]), Number(soDia[2]) - 1, Number(soDia[3]))),
      diaInteiro: true,
    };
  }

  const completa = valor.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!completa) return null;
  return {
    data: new Date(
      Date.UTC(
        Number(completa[1]),
        Number(completa[2]) - 1,
        Number(completa[3]),
        Number(completa[4]),
        Number(completa[5]),
        Number(completa[6]),
      ),
    ),
    diaInteiro: false,
  };
}

/** DURATION basico: P1D, PT1H30M, P1DT2H... Ignora semanas negativas etc. */
export function lerDuracaoMs(valor: string): number | null {
  const m = valor.match(/^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!m) return null;
  const [, semanas, dias, horas, minutos, segundos] = m;
  return (
    (Number(semanas ?? 0) * 7 + Number(dias ?? 0)) * 86_400_000 +
    Number(horas ?? 0) * 3_600_000 +
    Number(minutos ?? 0) * 60_000 +
    Number(segundos ?? 0) * 1_000
  );
}

export interface EventoLido {
  uid: string | null;
  summary: string | null;
  dtStart: Date | null;
  dtEnd: Date | null;
  recurring: boolean;
}

/** Null quando o corpo nao e um iCalendar com ao menos um VEVENT. */
export function lerEvento(texto: string): EventoLido | null {
  const linhas = desdobrarLinhas(texto);
  if (linhas[0]?.toUpperCase() !== "BEGIN:VCALENDAR") return null;

  const inicio = linhas.findIndex((linha) => linha.toUpperCase() === "BEGIN:VEVENT");
  if (inicio === -1) return null;
  const fim = linhas.findIndex((linha, i) => i > inicio && linha.toUpperCase() === "END:VEVENT");
  if (fim === -1) return null;

  const evento = linhas.slice(inicio + 1, fim);

  const dtStartLinha = primeira(evento, "DTSTART");
  const dtStartLida = dtStartLinha ? lerDataIcal(dtStartLinha.valor.trim()) : null;

  let dtEnd: Date | null = null;
  const dtEndLinha = primeira(evento, "DTEND");
  if (dtEndLinha) {
    dtEnd = lerDataIcal(dtEndLinha.valor.trim())?.data ?? null;
  } else if (dtStartLida) {
    const duracaoLinha = primeira(evento, "DURATION");
    const duracaoMs = duracaoLinha ? lerDuracaoMs(duracaoLinha.valor.trim()) : null;
    if (duracaoMs !== null) {
      dtEnd = new Date(dtStartLida.data.getTime() + duracaoMs);
    } else {
      // RFC 5545: sem DTEND nem DURATION, evento de dia inteiro dura o dia;
      // com hora marcada, nao ocupa tempo.
      dtEnd = new Date(dtStartLida.data.getTime() + (dtStartLida.diaInteiro ? 86_400_000 : 0));
    }
  }

  return {
    uid: primeira(evento, "UID") ? desescapar(primeira(evento, "UID")!.valor) : null,
    summary: primeira(evento, "SUMMARY") ? desescapar(primeira(evento, "SUMMARY")!.valor) : null,
    dtStart: dtStartLida?.data ?? null,
    dtEnd,
    recurring: primeira(evento, "RRULE") !== null || primeira(evento, "RDATE") !== null,
  };
}
