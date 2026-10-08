import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";

/**
 * Aquecimento de IP.
 *
 * O IP nunca enviou correspondencia: para Gmail e Outlook, volume subito de um
 * IP desconhecido e a assinatura classica de spammer, e o primeiro lote grande
 * define a reputacao pelos proximos meses. A saida e uma rampa: um teto diario
 * de mensagens EXTERNAS que dobra a cada semana ate o aquecimento terminar.
 *
 * O teto vale so para a entrega direta (driver `direct`) e so conta
 * destinatario de fora dos nossos dominios — mensagem interna nao gasta
 * reputacao. Quem passa do teto nao e recusado nem vira bounce: fica na fila
 * com `nextAttemptAt` na proxima virada de dia UTC, sem consumir tentativa.
 */

export interface OrcamentoWarmup {
  /** Dia corrente do aquecimento, contado a partir de MAIL_WARMUP_INICIO (dia 0). */
  dia: number;
  /** Teto de mensagens externas para hoje. */
  cap: number;
  /** Mensagens externas ja entregues hoje (soma de destinatarios externos). */
  enviadosHoje: number;
  restante: number;
}

function inicioUtcMs(inicio: string): number {
  const [ano, mes, dia] = inicio.split("-").map((parte) => Number.parseInt(parte, 10));
  return Date.UTC(ano ?? 1970, (mes ?? 1) - 1, dia ?? 1);
}

function hojeUtcMs(agora: Date): number {
  return Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate());
}

/** Numero do dia de aquecimento. Antes do inicio vale 0 — comeco conservador. */
export function diaDoAquecimento(inicio: string, agora: Date): number {
  return Math.max(0, Math.floor((hojeUtcMs(agora) - inicioUtcMs(inicio)) / 86_400_000));
}

/**
 * Teto do dia, ou null quando a rampa terminou (uma semana por valor da lista).
 * Funcao pura para o smoke test conferir a aritmetica sem banco.
 */
export function capDoDia(inicio: string, capsSemanais: readonly number[], agora: Date): number | null {
  const dia = diaDoAquecimento(inicio, agora);
  if (dia >= capsSemanais.length * 7) return null;
  return capsSemanais[Math.floor(dia / 7)] ?? null;
}

/** Proxima virada de dia UTC — quando o orcamento do aquecimento renasce. */
export function proximaJanelaUtc(agora = new Date()): Date {
  return new Date(hojeUtcMs(agora) + 86_400_000);
}

export function aquecimentoConfigurado(): boolean {
  return config.relay.driver === "direct" && config.warmup.inicio !== "";
}

/**
 * Orcamento de hoje, lido do banco na hora — igual a cota de envio, um
 * contador em memoria mentiria depois de um restart. Null = sem trava
 * (aquecimento desligado, driver de relay, ou rampa concluida).
 */
export async function orcamentoDeHoje(agora = new Date()): Promise<OrcamentoWarmup | null> {
  if (!aquecimentoConfigurado()) return null;

  const cap = capDoDia(config.warmup.inicio, config.warmup.capsSemanais, agora);
  if (cap === null) return null;

  const soma = await prisma.outboundMessage.aggregate({
    _sum: { externalRecipients: true },
    where: { relayDriver: "direct", sentAt: { gte: new Date(hojeUtcMs(agora)) } },
  });

  const enviadosHoje = soma._sum.externalRecipients ?? 0;
  return {
    dia: diaDoAquecimento(config.warmup.inicio, agora),
    cap,
    enviadosHoje,
    restante: Math.max(0, cap - enviadosHoje),
  };
}
