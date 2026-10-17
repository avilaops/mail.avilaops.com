import { desdobrarLinhas, lerDataIcal } from "../dav/ical.js";

function utcIcal(data: Date): string {
  return data.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function dataIcal(data: Date): string {
  return utcIcal(data).slice(0, 8);
}

interface FaixaEvento { inicio: number; fim: number; mestre: boolean }

function faixasEventos(linhas: string[]): FaixaEvento[] {
  const faixas: FaixaEvento[] = [];
  let inicio = -1;
  for (let indice = 0; indice < linhas.length; indice += 1) {
    if (linhas[indice]?.toUpperCase() === "BEGIN:VEVENT") inicio = indice;
    if (linhas[indice]?.toUpperCase() !== "END:VEVENT" || inicio < 0) continue;
    faixas.push({ inicio, fim: indice, mestre: !linhas.slice(inicio, indice + 1).some((linha) => /^RECURRENCE-ID(?:;|:)/i.test(linha)) });
    inicio = -1;
  }
  return faixas;
}

function serializar(linhas: string[]): string {
  return `${linhas.join("\r\n")}\r\n`;
}

function instanteRecorrencia(linha: string): number | null {
  if (!/^RECURRENCE-ID(?:;|:)/i.test(linha)) return null;
  const doisPontos = linha.indexOf(":");
  if (doisPontos < 0) return null;
  const tzid = linha.slice(0, doisPontos).match(/(?:^|;)TZID=(?:"([^"]+)"|([^;:]+))/i);
  return lerDataIcal(linha.slice(doisPontos + 1), { tzid: tzid?.[1] ?? tzid?.[2] })?.data.getTime() ?? null;
}

function instantePropriedade(linha: string): number | null {
  const doisPontos = linha.indexOf(":");
  if (doisPontos < 0) return null;
  const tzid = linha.slice(0, doisPontos).match(/(?:^|;)TZID=(?:"([^"]+)"|([^;:]+))/i);
  const inicioPeriodo = linha.slice(doisPontos + 1).split("/", 1)[0]!;
  return lerDataIcal(inicioPeriodo, { tzid: tzid?.[1] ?? tzid?.[2] })?.data.getTime() ?? null;
}

function deslocarLinhaData(linha: string, deslocamento: number, diaInteiro: boolean): string {
  const nome = linha.slice(0, linha.indexOf(":"));
  const doisPontos = linha.indexOf(":");
  const base = nome.split(";")[0]!;
  const valores = linha.slice(doisPontos + 1).split(",").map((valor) => valor.split("/").map((parte) => {
    if (/^P/i.test(parte)) return parte;
    const instante = instantePropriedade(`${nome}:${parte}`);
    if (instante === null) return parte;
    const data = new Date(instante + deslocamento);
    return diaInteiro ? dataIcal(data) : utcIcal(data);
  }).join("/"));
  const periodo = /(?:^|;)VALUE=PERIOD(?:;|$)/i.test(nome) || valores.some((valor) => valor.includes("/"));
  return diaInteiro ? `${base};VALUE=DATE:${valores.map((valor) => valor.split("/", 1)[0]).join(",")}` : `${base}${periodo ? ";VALUE=PERIOD" : ""}:${valores.join(",")}`;
}

function garantirFimExclusivoDiaInteiro(componente: string[], duracaoOriginal: number): string[] {
  if (duracaoOriginal <= 0) return componente;
  const indiceInicio = componente.findIndex((linha) => /^DTSTART(?:;|:)/i.test(linha));
  const indiceFim = componente.findIndex((linha) => /^DTEND(?:;|:)/i.test(linha));
  if (indiceInicio < 0 || indiceFim < 0) return componente;
  const inicio = instantePropriedade(componente[indiceInicio]!);
  const fim = instantePropriedade(componente[indiceFim]!);
  if (inicio !== null && (fim === null || fim <= inicio)) {
    const dias = Math.max(1, Math.ceil(duracaoOriginal / 86_400_000));
    componente[indiceFim] = `DTEND;VALUE=DATE:${dataIcal(new Date(inicio + dias * 86_400_000))}`;
  }
  return componente;
}

export interface ParticaoSerie {
  anterior: string;
  linhasFuturas: string[];
  componentesFuturos: string[][];
}

/** Separa excecoes e datas adicionais no mesmo ponto usado para dividir a RRULE. */
export function particionarSerie(corpo: string, corte: Date, diaInteiro = false): ParticaoSerie {
  let linhas = desdobrarLinhas(limitarSerieAntes(corpo, corte, diaInteiro));
  const faixas = faixasEventos(linhas);
  const mestre = faixas.find((faixa) => faixa.mestre);
  if (!mestre) throw new Error("VCALENDAR sem VEVENT mestre.");
  const linhasFuturas: string[] = [];
  for (let indice = mestre.fim - 1; indice > mestre.inicio; indice -= 1) {
    const linha = linhas[indice]!;
    if (!/^(?:EXDATE|RDATE)(?:;|:)/i.test(linha)) continue;
    const doisPontos = linha.indexOf(":");
    const prefixo = linha.slice(0, doisPontos);
    const anteriores: string[] = [];
    const futuras: string[] = [];
    for (const valor of linha.slice(doisPontos + 1).split(",")) {
      const candidata = `${prefixo}:${valor}`;
      ((instantePropriedade(candidata) ?? Number.NEGATIVE_INFINITY) >= corte.getTime() ? futuras : anteriores).push(valor);
    }
    if (futuras.length > 0) linhasFuturas.unshift(`${prefixo}:${futuras.join(",")}`);
    if (anteriores.length > 0) linhas[indice] = `${prefixo}:${anteriores.join(",")}`;
    else linhas.splice(indice, 1);
  }
  const componentesFuturos: string[][] = [];
  for (const faixa of faixasEventos(linhas).filter((item) => !item.mestre).reverse()) {
    const componente = linhas.slice(faixa.inicio, faixa.fim + 1);
    const id = componente.map(instanteRecorrencia).find((valor) => valor !== null);
    if (id !== undefined && id !== null && id >= corte.getTime()) {
      componentesFuturos.unshift(componente);
      linhas.splice(faixa.inicio, faixa.fim - faixa.inicio + 1);
    }
  }
  return { anterior: serializar(linhas), linhasFuturas, componentesFuturos };
}

/** Reanexa a metade futura a uma nova serie, alterando UID e horario quando necessario. */
export function anexarParticaoFutura(corpo: string, particao: ParticaoSerie, uid: string, deslocamento = 0, diaInteiro = false): string {
  const linhas = desdobrarLinhas(corpo);
  const mestre = faixasEventos(linhas).find((faixa) => faixa.mestre);
  const fimCalendario = linhas.findIndex((linha) => linha.toUpperCase() === "END:VCALENDAR");
  if (!mestre || fimCalendario < 0) throw new Error("VCALENDAR invalido.");
  const adicionais = particao.linhasFuturas.map((linha) => deslocarLinhaData(linha, deslocamento, diaInteiro));
  linhas.splice(mestre.fim, 0, ...adicionais);
  const componentes = particao.componentesFuturos.map((componente) => {
    const inicio = componente.find((linha) => /^DTSTART(?:;|:)/i.test(linha));
    const fim = componente.find((linha) => /^DTEND(?:;|:)/i.test(linha));
    const duracao = inicio && fim ? (instantePropriedade(fim) ?? 0) - (instantePropriedade(inicio) ?? 0) : 0;
    const deslocado = componente.map((linha) => {
      if (/^UID:/i.test(linha)) return `UID:${uid}`;
      if (/^(?:RECURRENCE-ID|DTSTART|DTEND)(?:;|:)/i.test(linha)) return deslocarLinhaData(linha, deslocamento, diaInteiro);
      return linha;
    });
    return diaInteiro ? garantirFimExclusivoDiaInteiro(deslocado, duracao) : deslocado;
  });
  linhas.splice(linhas.findIndex((linha) => linha.toUpperCase() === "END:VCALENDAR"), 0, ...componentes.flat());
  return serializar(linhas);
}

/** Mantem somente DTSTART+RRULE para contar as posicoes consumidas por COUNT. */
export function serieSemExclusoes(corpo: string): string {
  const linhas = desdobrarLinhas(corpo);
  for (const faixa of faixasEventos(linhas).filter((item) => !item.mestre).reverse()) linhas.splice(faixa.inicio, faixa.fim - faixa.inicio + 1);
  return serializar(linhas.filter((linha) => !/^(?:EXDATE|RDATE)(?:;|:)/i.test(linha)));
}

/** Desloca excecoes e datas adicionais junto com o mestre. */
export function deslocarRecorrencias(corpo: string, deslocamento: number, uid: string, diaInteiro = false): string {
  const linhas = desdobrarLinhas(corpo);
  const faixas = faixasEventos(linhas);
  for (const faixa of faixas) {
    const inicioOriginal = linhas.slice(faixa.inicio, faixa.fim + 1).find((linha) => /^DTSTART(?:;|:)/i.test(linha));
    const fimOriginal = linhas.slice(faixa.inicio, faixa.fim + 1).find((linha) => /^DTEND(?:;|:)/i.test(linha));
    const duracaoOriginal = inicioOriginal && fimOriginal ? (instantePropriedade(fimOriginal) ?? 0) - (instantePropriedade(inicioOriginal) ?? 0) : 0;
    for (let indice = faixa.inicio; indice <= faixa.fim; indice += 1) {
      const linha = linhas[indice]!;
      if (/^UID:/i.test(linha)) linhas[indice] = `UID:${uid}`;
      else if ((faixa.mestre && /^(?:EXDATE|RDATE)(?:;|:)/i.test(linha)) || (!faixa.mestre && /^(?:RECURRENCE-ID|DTSTART|DTEND)(?:;|:)/i.test(linha))) {
        linhas[indice] = deslocarLinhaData(linha, deslocamento, diaInteiro);
      }
    }
    if (diaInteiro && !faixa.mestre) garantirFimExclusivoDiaInteiro(linhas.slice(faixa.inicio, faixa.fim + 1), duracaoOriginal).forEach((linha, indice) => { linhas[faixa.inicio + indice] = linha; });
  }
  return serializar(linhas);
}

export function adicionarExdate(corpo: string, recorrenciaId: Date, diaInteiro: boolean): string {
  const linhas = desdobrarLinhas(corpo);
  const excecao = faixasEventos(linhas).find((faixa) => !faixa.mestre && linhas.slice(faixa.inicio, faixa.fim + 1).some((linha) => instanteRecorrencia(linha) === recorrenciaId.getTime()));
  if (excecao) linhas.splice(excecao.inicio, excecao.fim - excecao.inicio + 1);
  const mestre = faixasEventos(linhas).find((faixa) => faixa.mestre);
  if (!mestre) throw new Error("VCALENDAR sem VEVENT mestre.");
  const linha = diaInteiro ? `EXDATE;VALUE=DATE:${dataIcal(recorrenciaId)}` : `EXDATE:${utcIcal(recorrenciaId)}`;
  if (!linhas.slice(mestre.inicio, mestre.fim + 1).includes(linha)) linhas.splice(mestre.fim, 0, linha);
  return serializar(linhas);
}

export function limitarSerieAntes(corpo: string, recorrenciaId: Date, diaInteiro = false): string {
  const linhas = desdobrarLinhas(corpo);
  const mestre = faixasEventos(linhas).find((faixa) => faixa.mestre);
  if (!mestre) throw new Error("VCALENDAR sem VEVENT mestre.");
  const indice = linhas.findIndex((linha, posicao) => posicao > mestre.inicio && posicao < mestre.fim && /^RRULE:/i.test(linha));
  if (indice < 0) throw new Error("VEVENT mestre sem RRULE.");
  const regra = linhas[indice]!.slice(linhas[indice]!.indexOf(":") + 1).split(";").filter((parte) => !/^(?:UNTIL|COUNT)=/i.test(parte));
  const limite = diaInteiro ? dataIcal(new Date(recorrenciaId.getTime() - 86_400_000)) : utcIcal(new Date(recorrenciaId.getTime() - 1_000));
  regra.push(`UNTIL=${limite}`);
  linhas[indice] = `RRULE:${regra.join(";")}`;
  return serializar(linhas);
}

export function componenteDeExcecao(corpoGerado: string, recorrenciaId: Date, diaInteiro: boolean): string[] {
  const linhas = desdobrarLinhas(corpoGerado);
  const faixa = faixasEventos(linhas)[0];
  if (!faixa) throw new Error("iCalendar gerado sem VEVENT.");
  const componente = linhas.slice(faixa.inicio, faixa.fim + 1).filter((linha) => !/^RRULE:/i.test(linha));
  const indiceInicio = componente.findIndex((linha) => /^DTSTART(?:;|:)/i.test(linha));
  if (indiceInicio < 0) throw new Error("VEVENT gerado sem DTSTART.");
  componente.splice(indiceInicio + 1, 0, diaInteiro ? `RECURRENCE-ID;VALUE=DATE:${dataIcal(recorrenciaId)}` : `RECURRENCE-ID:${utcIcal(recorrenciaId)}`);
  return componente;
}

export function adicionarOuSubstituirExcecao(corpo: string, componente: string[], recorrenciaId: Date, diaInteiro: boolean): string {
  const linhas = desdobrarLinhas(corpo);
  const existente = faixasEventos(linhas).find((faixa) => !faixa.mestre && linhas.slice(faixa.inicio, faixa.fim + 1).some((linha) => instanteRecorrencia(linha) === recorrenciaId.getTime()));
  if (existente) linhas.splice(existente.inicio, existente.fim - existente.inicio + 1);
  const fimCalendario = linhas.findIndex((linha) => linha.toUpperCase() === "END:VCALENDAR");
  if (fimCalendario < 0) throw new Error("VCALENDAR sem fechamento.");
  linhas.splice(fimCalendario, 0, ...componente);
  return serializar(linhas);
}

export function regraRestante(regra: string, ocorrenciasAnteriores: number): string {
  const partes = regra.split(";");
  const indice = partes.findIndex((parte) => /^COUNT=/i.test(parte));
  if (indice < 0) return regra;
  const total = Number(partes[indice]!.slice(partes[indice]!.indexOf("=") + 1));
  const restante = total - ocorrenciasAnteriores;
  if (!Number.isInteger(restante) || restante < 1) throw new Error("A serie nao possui ocorrencias restantes.");
  partes[indice] = `COUNT=${restante}`;
  return partes.join(";");
}
