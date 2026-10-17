interface PartesFuso { ano: number; mes: number; dia: number; hora: number; minuto: number }

function formatador(fuso: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", { timeZone: fuso, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export function partesNoFuso(data: Date, fuso: string): PartesFuso {
  const mapa = new Map(formatador(fuso).formatToParts(data).map((parte) => [parte.type, parte.value]));
  const resultado = { ano: Number(mapa.get("year")), mes: Number(mapa.get("month")), dia: Number(mapa.get("day")), hora: Number(mapa.get("hour")), minuto: Number(mapa.get("minute")) };
  if (Object.values(resultado).some((valor) => !Number.isInteger(valor))) throw new RangeError("Data ou fuso inválido.");
  return resultado;
}

export function instanteParaCivil(data: Date, fuso: string): string {
  const p = partesNoFuso(data, fuso);
  const dois = (valor: number) => String(valor).padStart(2, "0");
  return `${p.ano}-${dois(p.mes)}-${dois(p.dia)}T${dois(p.hora)}:${dois(p.minuto)}`;
}

function iguais(a: PartesFuso, b: PartesFuso): boolean {
  return a.ano === b.ano && a.mes === b.mes && a.dia === b.dia && a.hora === b.hora && a.minuto === b.minuto;
}

export function civilParaInstante(valor: string, fuso: string): Date {
  const encontrado = valor.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!encontrado) throw new RangeError("Data civil inválida.");
  const alvo = { ano: Number(encontrado[1]), mes: Number(encontrado[2]), dia: Number(encontrado[3]), hora: Number(encontrado[4]), minuto: Number(encontrado[5]) };
  const civilUtc = Date.UTC(alvo.ano, alvo.mes - 1, alvo.dia, alvo.hora, alvo.minuto);
  let candidato = civilUtc;
  const vistos = new Set<number>();
  for (let tentativa = 0; tentativa < 4 && !vistos.has(candidato); tentativa += 1) {
    vistos.add(candidato);
    const renderizado = partesNoFuso(new Date(candidato), fuso);
    if (iguais(renderizado, alvo)) return new Date(candidato);
    candidato += civilUtc - Date.UTC(renderizado.ano, renderizado.mes - 1, renderizado.dia, renderizado.hora, renderizado.minuto);
  }
  throw new RangeError("Horário inexistente neste fuso.");
}

export function dataCivilNoFuso(data: Date, fuso: string): string {
  return instanteParaCivil(data, fuso).slice(0, 10);
}

export function intervaloCivilNoFuso(inicio: string, fim: string, fuso: string): { inicio: Date; fim: Date } {
  return { inicio: civilParaInstante(`${inicio}T00:00`, fuso), fim: civilParaInstante(`${fim}T00:00`, fuso) };
}
