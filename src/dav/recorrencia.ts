import { desdobrarLinhas, formatarInstanteCivilIcal, lerDataIcal, lerDuracaoMs, lerEvento, type EventoLido } from "./ical.js";
import { rrulestr } from "./rrule.js";

export interface JanelaRecorrencia {
  inicio: Date;
  fim: Date;
  limite?: number;
  limiteCandidatos?: number;
  fusoPadrao?: string;
}

export interface OcorrenciaEvento {
  uid: string | null;
  inicio: Date;
  fim: Date;
  recorrenciaId: Date;
  evento: EventoLido;
}

function componentesEvento(ical: string): string[][] {
  const linhas = desdobrarLinhas(ical);
  const eventos: string[][] = [];
  let inicio = -1;
  for (let i = 0; i < linhas.length; i += 1) {
    const linha = linhas[i]?.toUpperCase();
    if (linha === "BEGIN:VEVENT") {
      if (inicio !== -1) throw new Error("VEVENT aninhado invalido.");
      inicio = i + 1;
    } else if (linha === "END:VEVENT" && inicio !== -1) {
      eventos.push(linhas.slice(inicio, i));
      inicio = -1;
    }
  }
  if (inicio !== -1) throw new Error("VEVENT recorrente sem END:VEVENT.");
  return eventos;
}

function linhasDiretas(evento: string[]): string[] {
  const diretas: string[] = [];
  let profundidade = 0;
  for (const linha of evento) {
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

function embrulharEvento(linhas: string[]): string {
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", ...linhas, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
}

function validarJanela(janela: JanelaRecorrencia): { limite: number; limiteCandidatos: number } {
  if (!Number.isFinite(janela.inicio.getTime()) || !Number.isFinite(janela.fim.getTime()) || janela.fim <= janela.inicio) {
    throw new Error("Janela de recorrencia invalida.");
  }
  const limite = janela.limite ?? 1_000;
  if (!Number.isInteger(limite) || limite < 1 || limite > 10_000) throw new Error("Limite de recorrencias invalido.");
  const limiteCandidatos = janela.limiteCandidatos ?? 10_000;
  if (!Number.isInteger(limiteCandidatos) || limiteCandidatos < limite || limiteCandidatos > 100_000) {
    throw new Error("Limite de candidatos de recorrencia invalido.");
  }
  return { limite, limiteCandidatos };
}

interface ExcecaoRecorrencia {
  recorrenciaId: Date;
  evento: EventoLido | null;
  cancelada: boolean;
}

interface PropriedadeDataRecorrencia {
  nome: "DTSTART" | "RDATE" | "EXDATE" | "RECURRENCE-ID";
  valores: string[];
  tzid?: string;
}

function lerPropriedadeData(linha: string): PropriedadeDataRecorrencia | null {
  const doisPontos = linha.indexOf(":");
  if (doisPontos === -1) return null;
  const cabecalho = linha.slice(0, doisPontos);
  const nome = cabecalho.split(";", 1)[0]?.toUpperCase();
  if (nome !== "DTSTART" && nome !== "RDATE" && nome !== "EXDATE" && nome !== "RECURRENCE-ID") return null;
  const tzid = cabecalho.match(/(?:^|;)TZID=(?:"([^"]+)"|([^;:]+))/i);
  return {
    nome,
    valores: linha
      .slice(doisPontos + 1)
      .split(",")
      .map((valor) => valor.trim())
      .filter(Boolean),
    tzid: tzid?.[1] ?? tzid?.[2],
  };
}

function dataPseudoUtc(data: Date): string {
  const dois = (valor: number) => String(valor).padStart(2, "0");
  return `${data.getUTCFullYear()}${dois(data.getUTCMonth() + 1)}${dois(data.getUTCDate())}T${dois(data.getUTCHours())}${dois(
    data.getUTCMinutes(),
  )}${dois(data.getUTCSeconds())}`;
}

function converterPseudoUtc(data: Date, fuso: string | undefined): Date | null {
  return lerDataIcal(dataPseudoUtc(data), { tzid: fuso, fusoPadrao: fuso })?.data ?? null;
}

interface DataAdicional {
  inicio: Date;
  duracao?: number;
}

function lerDatasAdicionais(
  diretas: string[],
  nome: "RDATE" | "EXDATE",
  fusoDaSerie: string | undefined,
): DataAdicional[] {
  const datas: DataAdicional[] = [];
  for (const linha of diretas) {
    const propriedade = lerPropriedadeData(linha);
    if (propriedade?.nome !== nome) continue;
    for (const valor of propriedade.valores) {
      const [inicioTexto, fimTexto, sobra] = valor.split("/");
      if (!inicioTexto || sobra !== undefined || (nome === "EXDATE" && fimTexto !== undefined)) {
        throw new Error(`${nome} contem data invalida.`);
      }
      const inicio = lerDataIcal(inicioTexto, { tzid: propriedade.tzid, fusoPadrao: fusoDaSerie })?.data;
      if (!inicio) throw new Error(`${nome} contem data invalida.`);
      if (fimTexto === undefined) {
        datas.push({ inicio });
        continue;
      }
      const duracaoDireta = lerDuracaoMs(fimTexto);
      const fim = duracaoDireta === null
        ? lerDataIcal(fimTexto, { tzid: propriedade.tzid, fusoPadrao: fusoDaSerie })?.data
        : null;
      const duracao = duracaoDireta ?? (fim ? fim.getTime() - inicio.getTime() : 0);
      if (duracao <= 0) throw new Error(`${nome} contem periodo invalido.`);
      datas.push({ inicio, duracao });
    }
  }
  return datas;
}

function lerRecorrenciaId(linhas: string[], fusoPadrao: string | undefined): Date | null {
  const linha = linhas.find((item) => /^RECURRENCE-ID(?:;|:)/i.test(item));
  if (!linha) return null;
  const propriedade = lerPropriedadeData(linha);
  const valor = propriedade?.valores[0];
  return valor ? (lerDataIcal(valor, { tzid: propriedade.tzid, fusoPadrao })?.data ?? null) : null;
}

/** Expande o VEVENT mestre dentro de uma janela de instantes. */
export function expandirRecorrencias(ical: string, janela: JanelaRecorrencia): OcorrenciaEvento[] {
  const { limite, limiteCandidatos } = validarJanela(janela);
  const componentes = componentesEvento(ical);
  const mestreLinhas = componentes.find((evento) => !linhasDiretas(evento).some((linha) => /^RECURRENCE-ID(?:;|:)/i.test(linha)));
  if (!mestreLinhas) throw new Error("VCALENDAR sem VEVENT mestre.");

  const mestre = lerEvento(embrulharEvento(mestreLinhas), { fusoPadrao: janela.fusoPadrao });
  if (!mestre?.dtStart || !mestre.dtEnd) throw new Error("VEVENT mestre sem janela valida.");
  const duracao = mestre.dtEnd.getTime() - mestre.dtStart.getTime();
  if (duracao < 0) throw new Error("VEVENT mestre termina antes de comecar.");

  const diretas = linhasDiretas(mestreLinhas);
  const fusoDaSerie = mestre.timezone ?? janela.fusoPadrao;
  const excecoes = new Map<number, ExcecaoRecorrencia>();
  for (const linhas of componentes.filter((evento) => evento !== mestreLinhas)) {
    const propriedades = linhasDiretas(linhas);
    const linhaRecorrenciaId = propriedades.find((linha) => /^RECURRENCE-ID(?:;|:)/i.test(linha));
    if (linhaRecorrenciaId && /;RANGE=(?:"?THISANDFUTURE"?)(?:;|:)/i.test(linhaRecorrenciaId)) {
      throw new Error("RECURRENCE-ID;RANGE=THISANDFUTURE ainda nao e suportado.");
    }
    const recorrenciaId = lerRecorrenciaId(propriedades, fusoDaSerie);
    if (!recorrenciaId) continue;
    const cancelada = propriedades.some((linha) => /^STATUS:CANCELLED$/i.test(linha));
    const evento = cancelada ? null : lerEvento(embrulharEvento(linhas), { fusoPadrao: fusoDaSerie });
    excecoes.set(recorrenciaId.getTime(), { recorrenciaId, evento, cancelada });
  }
  const recorrencia = diretas.filter((linha) => /^(DTSTART|RRULE|RDATE|EXDATE)(?:;|:)/i.test(linha));
  if (!recorrencia.some((linha) => /^RRULE(?:;|:)/i.test(linha)) && !recorrencia.some((linha) => /^RDATE(?:;|:)/i.test(linha))) {
    if (mestre.dtStart < janela.fim && mestre.dtEnd > janela.inicio) {
      const excecao = excecoes.get(mestre.dtStart.getTime());
      if (excecao?.cancelada) return [];
      if (excecao?.evento?.dtStart && excecao.evento.dtEnd) {
        return [
          {
            uid: excecao.evento.uid,
            inicio: excecao.evento.dtStart,
            fim: excecao.evento.dtEnd,
            recorrenciaId: excecao.recorrenciaId,
            evento: excecao.evento,
          },
        ];
      }
      return [{ uid: mestre.uid, inicio: mestre.dtStart, fim: mestre.dtEnd, recorrenciaId: mestre.dtStart, evento: mestre }];
    }
    return [];
  }

  const dtstart = diretas.map(lerPropriedadeData).find((propriedade) => propriedade?.nome === "DTSTART");
  if (!dtstart || dtstart.valores.length !== 1) throw new Error("VEVENT mestre sem DTSTART valido.");
  const valorDtstart = dtstart.valores[0] as string;
  const recorrenciaCivil = !mestre.allDay && !valorDtstart.endsWith("Z");
  const linhasMotor = diretas
    .filter((linha) => /^(DTSTART|RRULE)(?:;|:)/i.test(linha))
    .map((linha) => {
      const propriedade = lerPropriedadeData(linha);
      if (propriedade?.nome === "DTSTART") return `DTSTART:${valorDtstart}`;
      if (recorrenciaCivil && /^RRULE:/i.test(linha)) {
        return linha.replace(/UNTIL=(\d{8}T\d{6}Z)/i, (_trecho, valor: string) => {
          const instante = lerDataIcal(valor)?.data;
          const civil = instante && fusoDaSerie ? formatarInstanteCivilIcal(instante, fusoDaSerie) : null;
          if (!civil) throw new Error("RRULE contem UNTIL invalido para o fuso da serie.");
          return `UNTIL=${civil}`;
        });
      }
      return linha;
    });
  const rdates = lerDatasAdicionais(diretas, "RDATE", fusoDaSerie);
  const exdates = new Set(lerDatasAdicionais(diretas, "EXDATE", fusoDaSerie).map(({ inicio }) => inicio.getTime()));

  const inicioBusca = new Date(janela.inicio.getTime() - duracao);
  const margemCivil = recorrenciaCivil ? 86_400_000 : 0;
  const count = linhasMotor.join("\n").match(/(?:^|;)COUNT=(\d+)(?:;|$)/im)?.[1];
  const quantidadeAlvo = count ? Number(count) : null;
  if (quantidadeAlvo !== null && quantidadeAlvo > limiteCandidatos) {
    throw new Error(`Expansao excedeu o limite interno de ${limiteCandidatos} candidatos.`);
  }

  const executarMotor = (quantidadeMotor: number | null): Date[] => {
    let excedeuCandidatos = false;
    const texto = quantidadeMotor === null
      ? linhasMotor.join("\n")
      : linhasMotor.join("\n").replace(/COUNT=\d+/i, `COUNT=${quantidadeMotor}`);
    const conjunto = rrulestr(texto, { forceset: true });
    const aceitar = (_data: Date, quantidade: number) => {
      if (quantidade >= limiteCandidatos) {
        excedeuCandidatos = true;
        return false;
      }
      return true;
    };
    const resultado = quantidadeMotor === null
      ? conjunto.between(
          new Date(inicioBusca.getTime() - margemCivil),
          new Date(janela.fim.getTime() + margemCivil),
          true,
          aceitar,
        )
      : conjunto.all(aceitar);
    if (excedeuCandidatos) throw new Error(`Expansao excedeu o limite interno de ${limiteCandidatos} candidatos.`);
    return resultado;
  };

  let geradasConvertidas: Date[];
  if (quantidadeAlvo === null) {
    geradasConvertidas = executarMotor(null)
      .map((data) => (recorrenciaCivil ? converterPseudoUtc(data, fusoDaSerie) : data))
      .filter((data): data is Date => data !== null);
  } else {
    let quantidadeMotor = quantidadeAlvo;
    while (true) {
      const convertidas = executarMotor(quantidadeMotor)
        .map((data) => (recorrenciaCivil ? converterPseudoUtc(data, fusoDaSerie) : data))
        .filter((data): data is Date => data !== null);
      if (convertidas.length >= quantidadeAlvo) {
        geradasConvertidas = convertidas.slice(0, quantidadeAlvo);
        break;
      }
      const faltantes = quantidadeAlvo - convertidas.length;
      if (quantidadeMotor + faltantes > limiteCandidatos) {
        throw new Error(`Expansao excedeu o limite interno de ${limiteCandidatos} candidatos.`);
      }
      quantidadeMotor += faltantes;
    }
  }

  const datas = new Map<number, DataAdicional>();
  for (const inicio of geradasConvertidas) datas.set(inicio.getTime(), { inicio });
  for (const adicional of rdates) datas.set(adicional.inicio.getTime(), adicional);
  for (const excluida of exdates) datas.delete(excluida);

  const idsExpandidos = new Set(datas.keys());
  const ocorrencias: OcorrenciaEvento[] = [];
  for (const { inicio, duracao: duracaoEspecifica } of datas.values()) {
    const excecao = excecoes.get(inicio.getTime());
    if (excecao?.cancelada) continue;
    if (excecao?.evento?.dtStart && excecao.evento.dtEnd) {
      ocorrencias.push({
        uid: excecao.evento.uid,
        inicio: excecao.evento.dtStart,
        fim: excecao.evento.dtEnd,
        recorrenciaId: excecao.recorrenciaId,
        evento: excecao.evento,
      });
      continue;
    }
    ocorrencias.push({
      uid: mestre.uid,
      inicio,
      fim: new Date(inicio.getTime() + (duracaoEspecifica ?? duracao)),
      recorrenciaId: inicio,
      evento: mestre,
    });
  }

  for (const [id, excecao] of excecoes) {
    if (idsExpandidos.has(id) || excecao.cancelada || !excecao.evento?.dtStart || !excecao.evento.dtEnd) continue;
    ocorrencias.push({
      uid: excecao.evento.uid,
      inicio: excecao.evento.dtStart,
      fim: excecao.evento.dtEnd,
      recorrenciaId: excecao.recorrenciaId,
      evento: excecao.evento,
    });
  }

  const naJanela = ocorrencias
    .filter((ocorrencia) => ocorrencia.inicio < janela.fim && ocorrencia.fim > janela.inicio)
    .sort((a, b) => a.inicio.getTime() - b.inicio.getTime() || a.recorrenciaId.getTime() - b.recorrenciaId.getTime());
  if (naJanela.length > limite) throw new Error(`Expansao excedeu o limite de ${limite} ocorrencias.`);
  return naJanela;
}
