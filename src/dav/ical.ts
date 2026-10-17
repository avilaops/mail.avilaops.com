import { getVtimezoneComponent } from "@touch4it/ical-timezones";
import { RRule } from "./rrule.js";

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
/** Escapa um valor TEXT conforme RFC 5545, inclusive quebras hostis. */
export function escaparTextoIcal(valor: string): string {
  return valor
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}
/** Dobra uma linha logica sem cortar caracteres UTF-8; continuacoes levam espaco. */
export function dobrarLinhaIcal(linha: string): string[] {
  const linhas: string[] = [];
  let atual = "";
  let limite = 75;

  for (const caractere of linha) {
    const bytes = Buffer.byteLength(caractere, "utf8");
    if (Buffer.byteLength(atual, "utf8") + bytes > limite && atual !== "") {
      linhas.push(atual);
      atual = ` ${caractere}`;
      limite = 75;
    } else {
      atual += caractere;
    }
  }

  linhas.push(atual);
  return linhas;
}

function desescapar(valor: string): string {
  return desescaparTexto(valor).replace(/\r?\n/g, " ").trim();
}

function desescaparTexto(valor: string): string {
  let saida = "";
  for (let i = 0; i < valor.length; i += 1) {
    const atual = valor[i];
    if (atual !== "\\" || i === valor.length - 1) {
      saida += atual;
      continue;
    }
    const seguinte = valor[i + 1];
    i += 1;
    saida += seguinte?.toLowerCase() === "n" ? "\n" : seguinte;
  }
  return saida;
}

interface Linha {
  nome: string;
  parametros: string;
  valor: string;
}

function indiceForaDeAspas(texto: string, caractere: string): number {
  let emAspas = false;
  for (let i = 0; i < texto.length; i += 1) {
    if (texto[i] === '"') emAspas = !emAspas;
    else if (!emAspas && texto[i] === caractere) return i;
  }
  return -1;
}

function separarForaDeAspas(texto: string, separador: string): string[] {
  const partes: string[] = [];
  let inicio = 0;
  let emAspas = false;
  for (let i = 0; i < texto.length; i += 1) {
    if (texto[i] === '"') emAspas = !emAspas;
    else if (!emAspas && texto[i] === separador) {
      partes.push(texto.slice(inicio, i));
      inicio = i + 1;
    }
  }
  partes.push(texto.slice(inicio));
  return partes;
}

function desescaparParametroIcal(valor: string): string {
  const semAspas = valor.startsWith('"') && valor.endsWith('"') ? valor.slice(1, -1) : valor;
  let saida = "";
  for (let i = 0; i < semAspas.length; i += 1) {
    if (semAspas[i] !== "^" || i === semAspas.length - 1) {
      saida += semAspas[i];
      continue;
    }
    const seguinte = semAspas[i + 1]!;
    i += 1;
    if (seguinte === "^") saida += "^";
    else if (seguinte === "'") saida += '"';
    else if (seguinte.toLowerCase() === "n") saida += "\n";
    else saida += `^${seguinte}`;
  }
  return saida;
}

function abrirLinha(linha: string): Linha | null {
  const doisPontos = indiceForaDeAspas(linha, ":");
  if (doisPontos <= 0) return null;
  const cabeca = linha.slice(0, doisPontos);
  const pontoEVirgula = indiceForaDeAspas(cabeca, ";");
  return {
    nome: (pontoEVirgula === -1 ? cabeca : cabeca.slice(0, pontoEVirgula)).toUpperCase(),
    parametros: pontoEVirgula === -1 ? "" : cabeca.slice(pontoEVirgula + 1),
    valor: linha.slice(doisPontos + 1),
  };
}

function parametro(linha: Linha, nome: string): string | undefined {
  for (const parte of separarForaDeAspas(linha.parametros, ";")) {
    const igual = indiceForaDeAspas(parte, "=");
    if (igual <= 0 || parte.slice(0, igual).toUpperCase() !== nome.toUpperCase()) continue;
    return desescaparParametroIcal(parte.slice(igual + 1));
  }
  return undefined;
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

export interface OpcoesDataIcal {
  tzid?: string;
  fusoPadrao?: string;
}

const FUSO_PADRAO = "America/Sao_Paulo";

const FUSOS_OUTLOOK: Readonly<Record<string, string>> = {
  "E. SOUTH AMERICA STANDARD TIME": "America/Sao_Paulo",
  "BAHIA STANDARD TIME": "America/Bahia",
  "CENTRAL BRAZILIAN STANDARD TIME": "America/Cuiaba",
  "TOCANTINS STANDARD TIME": "America/Araguaina",
  "SA EASTERN STANDARD TIME": "America/Cayenne",
};

interface PartesData {
  ano: number;
  mes: number;
  dia: number;
  hora: number;
  minuto: number;
  segundo: number;
}

function resolverFuso(tzid: string): string {
  return FUSOS_OUTLOOK[tzid.trim().toUpperCase()] ?? tzid.trim();
}

function formatadorNoFuso(fuso: string): Intl.DateTimeFormat | null {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: fuso,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return null;
  }
}

function partesNoFuso(data: Date, formatador: Intl.DateTimeFormat): PartesData | null {
  const partes = new Map(formatador.formatToParts(data).map((parte) => [parte.type, parte.value]));
  const tipos = ["year", "month", "day", "hour", "minute", "second"] as const;
  const valores = tipos.map((tipo) => Number(partes.get(tipo)));
  if (valores.some((valor) => !Number.isInteger(valor))) return null;
  const [ano, mes, dia, hora, minuto, segundo] = valores;
  if (ano === undefined || mes === undefined || dia === undefined || hora === undefined || minuto === undefined || segundo === undefined) {
    return null;
  }
  return { ano, mes, dia, hora, minuto, segundo };
}

/** Formata um instante como data/hora civil compacta no fuso informado. */
export function formatarInstanteCivilIcal(data: Date, fuso: string): string | null {
  if (!Number.isFinite(data.getTime())) return null;
  const formatador = formatadorNoFuso(resolverFuso(fuso));
  const partes = formatador ? partesNoFuso(data, formatador) : null;
  if (!partes) return null;
  const dois = (valor: number) => String(valor).padStart(2, "0");
  return `${partes.ano}${dois(partes.mes)}${dois(partes.dia)}T${dois(partes.hora)}${dois(partes.minuto)}${dois(partes.segundo)}`;
}

function mesmoHorario(a: PartesData, b: PartesData): boolean {
  return (
    a.ano === b.ano &&
    a.mes === b.mes &&
    a.dia === b.dia &&
    a.hora === b.hora &&
    a.minuto === b.minuto &&
    a.segundo === b.segundo
  );
}

function primeiroInstanteValido(partes: PartesData, civilComoUtc: number, candidato: number, formatador: Intl.DateTimeFormat): Date {
  const candidatos = new Set<number>([candidato]);
  const amostras = [-7 * 86_400_000, -36 * 3_600_000, 0, 36 * 3_600_000, 7 * 86_400_000];

  for (const distancia of amostras) {
    const instanteAmostrado = candidato + distancia;
    const renderizada = partesNoFuso(new Date(instanteAmostrado), formatador);
    if (!renderizada) continue;
    const renderizadaComoUtc = Date.UTC(
      renderizada.ano,
      renderizada.mes - 1,
      renderizada.dia,
      renderizada.hora,
      renderizada.minuto,
      renderizada.segundo,
    );
    const deslocamento = renderizadaComoUtc - instanteAmostrado;
    const possivel = civilComoUtc - deslocamento;
    const conferencia = partesNoFuso(new Date(possivel), formatador);
    if (conferencia && mesmoHorario(conferencia, partes)) candidatos.add(possivel);
  }

  return new Date(Math.min(...candidatos));
}

function horaCivilParaUtc(partes: PartesData, fuso: string): Date | null {
  const formatador = formatadorNoFuso(fuso);
  if (!formatador) return null;

  const civilComoUtc = Date.UTC(partes.ano, partes.mes - 1, partes.dia, partes.hora, partes.minuto, partes.segundo);
  let instante = civilComoUtc;
  const visitados = new Set<number>();

  for (let tentativa = 0; tentativa < 4 && !visitados.has(instante); tentativa += 1) {
    visitados.add(instante);
    const renderizada = partesNoFuso(new Date(instante), formatador);
    if (!renderizada) return null;
    if (mesmoHorario(renderizada, partes)) return primeiroInstanteValido(partes, civilComoUtc, instante, formatador);

    const renderizadaComoUtc = Date.UTC(
      renderizada.ano,
      renderizada.mes - 1,
      renderizada.dia,
      renderizada.hora,
      renderizada.minuto,
      renderizada.segundo,
    );
    instante += civilComoUtc - renderizadaComoUtc;
  }

  return null;
}

/**
 * Le uma data iCalendar UTC, com TZID ou flutuante. Datas flutuantes usam o
 * fuso da caixa; VALUE=DATE continua sendo um dia civil, sem deslocamento.
 */
export function lerDataIcal(valor: string, opcoes: OpcoesDataIcal = {}): { data: Date; diaInteiro: boolean } | null {
  const soDia = valor.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (soDia) {
    return {
      data: new Date(Date.UTC(Number(soDia[1]), Number(soDia[2]) - 1, Number(soDia[3]))),
      diaInteiro: true,
    };
  }

  const completa = valor.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/);
  if (!completa) return null;
  const partes: PartesData = {
    ano: Number(completa[1]),
    mes: Number(completa[2]),
    dia: Number(completa[3]),
    hora: Number(completa[4]),
    minuto: Number(completa[5]),
    segundo: Number(completa[6]),
  };

  if (completa[7] !== "Z") {
    const fuso = resolverFuso(opcoes.tzid ?? opcoes.fusoPadrao ?? FUSO_PADRAO);
    const data = horaCivilParaUtc(partes, fuso);
    return data ? { data, diaInteiro: false } : null;
  }

  return {
    data: new Date(Date.UTC(partes.ano, partes.mes - 1, partes.dia, partes.hora, partes.minuto, partes.segundo)),
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

export type RespostaConvidado = "pendente" | "aceito" | "recusado" | "talvez";

export interface ConvidadoIcal {
  email: string;
  nome?: string;
  resposta: RespostaConvidado;
}

export interface LembreteIcal {
  minutosAntes: number;
}

export interface EventoIcal {
  uid: string;
  titulo: string;
  inicio: string;
  fim: string;
  diaInteiro: boolean;
  fuso: string;
  criadoEm: string;
  modificadoEm: string;
  dtstamp: string;
  sequencia: number;
  local?: string;
  descricao?: string;
  recorrencia?: string;
  lembretes: LembreteIcal[];
  convidados: ConvidadoIcal[];
  organizador?: string;
  disponibilidade: "ocupado" | "livre";
  origem?: string;
  linkOrigem?: string;
}

export interface OpcoesGerarEventoIcal {
  original?: string;
}

const PARTSTAT_POR_RESPOSTA: Record<RespostaConvidado, string> = {
  pendente: "NEEDS-ACTION",
  aceito: "ACCEPTED",
  recusado: "DECLINED",
  talvez: "TENTATIVE",
};

const RESPOSTA_POR_PARTSTAT: Record<string, RespostaConvidado> = {
  "NEEDS-ACTION": "pendente",
  ACCEPTED: "aceito",
  DECLINED: "recusado",
  TENTATIVE: "talvez",
};

function dataValida(valor: string): Date {
  const partes = valor.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!partes) throw new Error(`Data iCalendar invalida: ${valor}`);
  const [, anoTexto, mesTexto, diaTexto, horaTexto, minutoTexto, segundoTexto] = partes;
  const ano = Number(anoTexto);
  const mes = Number(mesTexto);
  const dia = Number(diaTexto);
  const hora = Number(horaTexto);
  const minuto = Number(minutoTexto);
  const segundo = Number(segundoTexto);
  const calendario = new Date(0);
  calendario.setUTCFullYear(ano, mes - 1, dia);
  calendario.setUTCHours(hora, minuto, segundo, 0);
  if (
    calendario.getUTCFullYear() !== ano ||
    calendario.getUTCMonth() !== mes - 1 ||
    calendario.getUTCDate() !== dia ||
    calendario.getUTCHours() !== hora ||
    calendario.getUTCMinutes() !== minuto ||
    calendario.getUTCSeconds() !== segundo
  ) {
    throw new Error(`Data iCalendar invalida: ${valor}`);
  }
  const data = new Date(valor);
  if (!Number.isFinite(data.getTime())) throw new Error(`Data iCalendar invalida: ${valor}`);
  return data;
}

function dois(valor: number): string {
  return String(valor).padStart(2, "0");
}

function formatarUtcIcal(valor: string): string {
  const data = dataValida(valor);
  return `${data.getUTCFullYear()}${dois(data.getUTCMonth() + 1)}${dois(data.getUTCDate())}T${dois(data.getUTCHours())}${dois(
    data.getUTCMinutes(),
  )}${dois(data.getUTCSeconds())}Z`;
}

function formatarLocalIcal(valor: string, fuso: string): string {
  const formatador = formatadorNoFuso(resolverFuso(fuso));
  if (!formatador) throw new Error(`Fuso iCalendar invalido: ${fuso}`);
  const partes = partesNoFuso(dataValida(valor), formatador);
  if (!partes) throw new Error(`Nao foi possivel formatar data no fuso ${fuso}`);
  return `${partes.ano}${dois(partes.mes)}${dois(partes.dia)}T${dois(partes.hora)}${dois(partes.minuto)}${dois(partes.segundo)}`;
}

export function normalizarFusoIcal(fuso: string): string | null {
  if (/[\r\n\x00-\x1f\x7f]/.test(fuso)) return null;
  const formatador = formatadorNoFuso(resolverFuso(fuso));
  return formatador?.resolvedOptions().timeZone ?? null;
}

function fusoCanonico(fuso: string): string {
  const canonico = normalizarFusoIcal(fuso);
  if (!canonico) throw new Error(`Fuso iCalendar invalido: ${fuso}`);
  return canonico;
}

function linhaDataHora(nome: "DTSTART" | "DTEND", valor: string, fuso: string): string {
  const data = dataValida(valor);
  const local = formatarLocalIcal(valor, fuso);
  const relida = lerDataIcal(local, { tzid: fuso })?.data;
  if (!relida || Math.trunc(relida.getTime() / 1000) !== Math.trunc(data.getTime() / 1000)) {
    return `${nome}:${formatarUtcIcal(valor)}`;
  }
  return `${nome};TZID=${fuso}:${local}`;
}

function formatarDiaIcal(valor: string): string {
  const data = dataValida(valor);
  return `${data.getUTCFullYear()}${dois(data.getUTCMonth() + 1)}${dois(data.getUTCDate())}`;
}

function escaparParametroIcal(valor: string): string {
  return valor.replace(/\^/g, "^^").replace(/\r\n|\r|\n/g, "^n").replace(/"/g, "^'");
}

function serializarLinhasIcal(linhas: string[]): string {
  return `${linhas.flatMap(dobrarLinhaIcal).join("\r\n")}\r\n`;
}

function emailIcalValido(email: string): boolean {
  return /^[^\s@<>,;:\r\n]+@[^\s@<>,;:\r\n]+$/.test(email);
}

function validarEventoIcal(evento: EventoIcal): { inicio: Date; fim: Date; fuso: string; vtimezone: string[] } {
  const inicio = dataValida(evento.inicio);
  const fim = dataValida(evento.fim);
  if (fim.getTime() < inicio.getTime()) throw new Error("Fim do evento nao pode anteceder o inicio.");
  if (!Number.isInteger(evento.sequencia) || evento.sequencia < 0) {
    throw new Error("SEQUENCE precisa ser um inteiro nao negativo.");
  }

  if (evento.recorrencia !== undefined) {
    if (/[\r\n\x00-\x1f\x7f]/.test(evento.recorrencia)) throw new Error("RRULE contem caractere de controle.");
    try {
      RRule.fromString(evento.recorrencia);
    } catch {
      throw new Error("RRULE iCalendar invalida.");
    }
  }

  for (const email of [evento.organizador, ...evento.convidados.map((convidado) => convidado.email)]) {
    if (email !== undefined && !emailIcalValido(email.trim())) throw new Error(`Endereco iCalendar invalido: ${email}`);
  }

  if (evento.diaInteiro) return { inicio, fim, fuso: evento.fuso, vtimezone: [] };
  const fuso = fusoCanonico(evento.fuso);
  if (fuso === "UTC") return { inicio, fim, fuso, vtimezone: [] };
  const componente = getVtimezoneComponent(fuso);
  if (!componente) throw new Error(`VTIMEZONE indisponivel para ${fuso}`);
  return { inicio, fim, fuso, vtimezone: desdobrarLinhas(componente) };
}

function extensoesDoEvento(original: string | undefined): string[] {
  if (!original) return [];
  const linhas = desdobrarLinhas(original);
  const inicio = linhas.findIndex((linha) => linha.toUpperCase() === "BEGIN:VEVENT");
  if (inicio === -1) return [];

  const extensoes = new Set<string>();
  let profundidade = 0;
  for (let i = inicio + 1; i < linhas.length; i += 1) {
    const linha = linhas[i]!;
    const maiuscula = linha.toUpperCase();
    if (maiuscula.startsWith("BEGIN:")) {
      profundidade += 1;
      continue;
    }
    if (maiuscula.startsWith("END:")) {
      if (profundidade === 0) break;
      profundidade -= 1;
      continue;
    }
    if (profundidade !== 0) continue;
    const aberta = abrirLinha(linha);
    if (aberta?.nome.startsWith("X-") && aberta.nome !== "X-AVILA-ORIGEM" && aberta.nome !== "X-AVILA-LINK") extensoes.add(linha);
  }
  return [...extensoes];
}

/** Gera um VCALENDAR com um VEVENT para armazenamento no mesmo CalDAV. */
export function gerarEventoIcal(evento: EventoIcal, opcoes: OpcoesGerarEventoIcal = {}): string {
  const validado = validarEventoIcal(evento);
  const linhas = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Avila Ops//Avila Mail//PT-BR",
    "CALSCALE:GREGORIAN",
    ...validado.vtimezone,
    "BEGIN:VEVENT",
    `UID:${escaparTextoIcal(evento.uid)}`,
    `DTSTAMP:${formatarUtcIcal(evento.dtstamp)}`,
    `CREATED:${formatarUtcIcal(evento.criadoEm)}`,
    `LAST-MODIFIED:${formatarUtcIcal(evento.modificadoEm)}`,
    `SEQUENCE:${evento.sequencia}`,
  ];

  if (evento.diaInteiro) {
    linhas.push(`DTSTART;VALUE=DATE:${formatarDiaIcal(evento.inicio)}`);
    linhas.push(`DTEND;VALUE=DATE:${formatarDiaIcal(evento.fim)}`);
  } else {
    linhas.push(linhaDataHora("DTSTART", evento.inicio, validado.fuso));
    linhas.push(linhaDataHora("DTEND", evento.fim, validado.fuso));
  }

  linhas.push(`SUMMARY:${escaparTextoIcal(evento.titulo)}`);
  if (evento.local !== undefined) linhas.push(`LOCATION:${escaparTextoIcal(evento.local)}`);
  if (evento.descricao !== undefined) linhas.push(`DESCRIPTION:${escaparTextoIcal(evento.descricao)}`);
  if (evento.recorrencia !== undefined) linhas.push(`RRULE:${evento.recorrencia}`);
  if (evento.organizador !== undefined) linhas.push(`ORGANIZER:mailto:${evento.organizador.trim().toLowerCase()}`);
  if (evento.origem !== undefined) linhas.push(`X-AVILA-ORIGEM:${escaparTextoIcal(evento.origem)}`);
  if (evento.linkOrigem !== undefined) linhas.push(`X-AVILA-LINK:${escaparTextoIcal(evento.linkOrigem)}`);

  for (const convidado of evento.convidados) {
    const parametros = [
      convidado.nome === undefined ? null : `CN="${escaparParametroIcal(convidado.nome)}"`,
      `PARTSTAT=${PARTSTAT_POR_RESPOSTA[convidado.resposta]}`,
    ].filter((valor): valor is string => valor !== null);
    linhas.push(`ATTENDEE;${parametros.join(";")}:mailto:${convidado.email.trim().toLowerCase()}`);
  }

  linhas.push(...extensoesDoEvento(opcoes.original));
  linhas.push(`TRANSP:${evento.disponibilidade === "livre" ? "TRANSPARENT" : "OPAQUE"}`);
  for (const lembrete of evento.lembretes) {
    if (!Number.isInteger(lembrete.minutosAntes) || lembrete.minutosAntes < 0) {
      throw new Error("Lembrete iCalendar precisa ser um numero inteiro nao negativo.");
    }
    linhas.push("BEGIN:VALARM", `TRIGGER:${lembrete.minutosAntes === 0 ? "PT0M" : `-PT${lembrete.minutosAntes}M`}`);
    linhas.push("ACTION:DISPLAY", `DESCRIPTION:${escaparTextoIcal(evento.titulo)}`, "END:VALARM");
  }
  linhas.push("END:VEVENT", "END:VCALENDAR");
  return serializarLinhasIcal(linhas);
}

export interface EventoLido {
  uid: string | null;
  summary: string | null;
  dtStart: Date | null;
  dtEnd: Date | null;
  recurring: boolean;
  allDay: boolean;
  timezone: string | null;
  createdAt: Date | null;
  modifiedAt: Date | null;
  dtstamp: Date | null;
  sequence: number;
  location: string | null;
  description: string | null;
  rrule: string | null;
  organizer: string | null;
  attendees: ConvidadoIcal[];
  reminders: LembreteIcal[];
  transparency: "OPAQUE" | "TRANSPARENT";
  origin: string | null;
  originLink: string | null;
}

export interface OpcoesEventoIcal {
  fusoPadrao?: string;
}

function propriedadesDiretas(linhas: string[]): string[] {
  const diretas: string[] = [];
  let profundidade = 0;
  for (const linha of linhas) {
    const maiuscula = linha.toUpperCase();
    if (maiuscula.startsWith("BEGIN:")) {
      profundidade += 1;
      continue;
    }
    if (maiuscula.startsWith("END:")) {
      profundidade = Math.max(0, profundidade - 1);
      continue;
    }
    if (profundidade === 0) diretas.push(linha);
  }
  return diretas;
}

/** Null quando o corpo nao e um iCalendar com ao menos um VEVENT. */
export function lerEvento(texto: string, opcoes: OpcoesEventoIcal = {}): EventoLido | null {
  const linhas = desdobrarLinhas(texto);
  if (linhas[0]?.toUpperCase() !== "BEGIN:VCALENDAR") return null;

  const inicio = linhas.findIndex((linha) => linha.toUpperCase() === "BEGIN:VEVENT");
  if (inicio === -1) return null;
  const fim = linhas.findIndex((linha, i) => i > inicio && linha.toUpperCase() === "END:VEVENT");
  if (fim === -1) return null;

  const evento = linhas.slice(inicio + 1, fim);
  const diretas = propriedadesDiretas(evento);

  const dtStartLinha = primeira(diretas, "DTSTART");
  const dtStartLida = dtStartLinha
    ? lerDataIcal(dtStartLinha.valor.trim(), { tzid: parametro(dtStartLinha, "TZID"), fusoPadrao: opcoes.fusoPadrao })
    : null;

  const convidados = diretas.flatMap((linha): ConvidadoIcal[] => {
    const aberta = abrirLinha(linha);
    if (aberta?.nome !== "ATTENDEE") return [];
    const email = aberta.valor.replace(/^mailto:/i, "").trim().toLowerCase();
    const partstat = parametro(aberta, "PARTSTAT")?.toUpperCase() ?? "NEEDS-ACTION";
    const nome = parametro(aberta, "CN");
    return [{ email, ...(nome === undefined ? {} : { nome }), resposta: RESPOSTA_POR_PARTSTAT[partstat] ?? "pendente" }];
  });

  const lembretes: LembreteIcal[] = [];
  for (let i = 0; i < evento.length; i += 1) {
    if (evento[i]?.toUpperCase() !== "BEGIN:VALARM") continue;
    const fimAlarme = evento.findIndex((linha, indice) => indice > i && linha.toUpperCase() === "END:VALARM");
    if (fimAlarme === -1) break;
    const trigger = primeira(evento.slice(i + 1, fimAlarme), "TRIGGER")?.valor.trim();
    const minutos = trigger?.match(/^(-?)PT(\d+)M$/i);
    if (minutos) lembretes.push({ minutosAntes: minutos[1] === "-" ? Number(minutos[2]) : 0 });
    i = fimAlarme;
  }

  const timestamp = (nome: string): Date | null => {
    const linha = primeira(diretas, nome);
    return linha ? (lerDataIcal(linha.valor.trim())?.data ?? null) : null;
  };
  const sequence = Number(primeira(diretas, "SEQUENCE")?.valor ?? 0);
  const transparencia = primeira(diretas, "TRANSP")?.valor.toUpperCase() === "TRANSPARENT" ? "TRANSPARENT" : "OPAQUE";

  let dtEnd: Date | null = null;
  const dtEndLinha = primeira(diretas, "DTEND");
  if (dtEndLinha) {
    dtEnd =
      lerDataIcal(dtEndLinha.valor.trim(), { tzid: parametro(dtEndLinha, "TZID"), fusoPadrao: opcoes.fusoPadrao })?.data ?? null;
  } else if (dtStartLida) {
    const duracaoLinha = primeira(diretas, "DURATION");
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
    uid: primeira(diretas, "UID") ? desescapar(primeira(diretas, "UID")!.valor) : null,
    summary: primeira(diretas, "SUMMARY") ? desescapar(primeira(diretas, "SUMMARY")!.valor) : null,
    dtStart: dtStartLida?.data ?? null,
    dtEnd,
    recurring: primeira(diretas, "RRULE") !== null || primeira(diretas, "RDATE") !== null,
    allDay: dtStartLida?.diaInteiro ?? false,
    timezone: dtStartLinha ? (parametro(dtStartLinha, "TZID") ?? null) : null,
    createdAt: timestamp("CREATED"),
    modifiedAt: timestamp("LAST-MODIFIED"),
    dtstamp: timestamp("DTSTAMP"),
    sequence: Number.isFinite(sequence) ? sequence : 0,
    location: primeira(diretas, "LOCATION") ? desescaparTexto(primeira(diretas, "LOCATION")!.valor) : null,
    description: primeira(diretas, "DESCRIPTION") ? desescaparTexto(primeira(diretas, "DESCRIPTION")!.valor) : null,
    rrule: primeira(diretas, "RRULE")?.valor ?? null,
    organizer: primeira(diretas, "ORGANIZER")?.valor.replace(/^mailto:/i, "").trim().toLowerCase() ?? null,
    attendees: convidados,
    reminders: lembretes,
    transparency: transparencia,
    origin: primeira(diretas, "X-AVILA-ORIGEM") ? desescaparTexto(primeira(diretas, "X-AVILA-ORIGEM")!.valor) : null,
    originLink: primeira(diretas, "X-AVILA-LINK") ? desescaparTexto(primeira(diretas, "X-AVILA-LINK")!.valor) : null,
  };
}
