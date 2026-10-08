import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("mercadopago");

/**
 * Cliente da API de assinaturas do Mercado Pago.
 *
 * Escrito na mao em vez de usar o SDK oficial: precisamos de quatro chamadas
 * (criar, ler, atualizar e cancelar assinatura) e de uma validacao de
 * assinatura de webhook. O SDK traz o resto da plataforma junto e uma camada
 * de abstracao a mais para depurar quando um pagamento nao entra.
 *
 * DECISAO IMPORTANTE: a assinatura e criada SEM `card_token_id`. O MP devolve
 * um `init_point` e o cliente cadastra o cartao na pagina dele. Assim nenhum
 * dado de cartao passa pelos nossos servidores — some o escopo de PCI, e o
 * webmail nao precisa afrouxar a CSP para carregar o SDK de tokenizacao.
 */

const BASE = "https://api.mercadopago.com";

export class MercadoPagoError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly corpo?: unknown,
  ) {
    super(message);
    this.name = "MercadoPagoError";
  }
}

async function chamar<T>(caminho: string, init: { method: string; body?: unknown }): Promise<T> {
  if (!config.billing.accessToken) {
    throw new MercadoPagoError("MP_ACCESS_TOKEN nao configurado.", 500);
  }

  const resposta = await fetch(`${BASE}${caminho}`, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${config.billing.accessToken}`,
      "Content-Type": "application/json",
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(20_000),
  });

  const texto = await resposta.text();
  let corpo: unknown = null;
  try {
    corpo = texto ? JSON.parse(texto) : null;
  } catch {
    corpo = texto;
  }

  if (!resposta.ok) {
    const mensagem =
      corpo && typeof corpo === "object" && "message" in corpo
        ? String((corpo as { message?: unknown }).message)
        : `Mercado Pago respondeu ${resposta.status}`;

    log.error("chamada ao Mercado Pago falhou", { caminho, status: resposta.status, mensagem });
    throw new MercadoPagoError(mensagem, resposta.status, corpo);
  }

  return corpo as T;
}

export interface Preapproval {
  id: string;
  status: "pending" | "authorized" | "paused" | "cancelled";
  init_point?: string;
  external_reference?: string;
  payer_email?: string;
  next_payment_date?: string;
  auto_recurring?: {
    frequency: number;
    frequency_type: string;
    transaction_amount: number;
    currency_id: string;
  };
}

export interface CriarAssinaturaInput {
  /** Aparece na fatura do cartao do cliente. */
  motivo: string;
  clientRef: string;
  payerEmail: string;
  valorCentavos: number;
  /** Para onde o MP devolve o cliente depois de cadastrar o cartao. */
  backUrl: string;
}

export async function criarAssinatura(input: CriarAssinaturaInput): Promise<Preapproval> {
  return chamar<Preapproval>("/preapproval", {
    method: "POST",
    body: {
      reason: input.motivo,
      external_reference: input.clientRef,
      payer_email: input.payerEmail,
      back_url: input.backUrl,
      // Sem `status: authorized` e sem card_token_id: o MP devolve init_point
      // e o cartao é cadastrado na página dele.
      auto_recurring: {
        frequency: 1,
        frequency_type: "months",
        transaction_amount: input.valorCentavos / 100,
        currency_id: "BRL",
      },
    },
  });
}

export async function buscarAssinatura(preapprovalId: string): Promise<Preapproval> {
  return chamar<Preapproval>(`/preapproval/${preapprovalId}`, { method: "GET" });
}

/** Ajusta o valor mensal — usado quando o cliente ganha ou perde uma caixa. */
export async function atualizarValor(preapprovalId: string, valorCentavos: number): Promise<Preapproval> {
  return chamar<Preapproval>(`/preapproval/${preapprovalId}`, {
    method: "PUT",
    body: {
      auto_recurring: {
        transaction_amount: valorCentavos / 100,
        currency_id: "BRL",
      },
    },
  });
}

export async function alterarStatus(
  preapprovalId: string,
  status: "paused" | "authorized" | "cancelled",
): Promise<Preapproval> {
  return chamar<Preapproval>(`/preapproval/${preapprovalId}`, { method: "PUT", body: { status } });
}

export interface PagamentoAutorizado {
  id: number;
  preapproval_id: string;
  /** processed | recycling | scheduled | cancelled */
  status: string;
  payment?: {
    id?: number;
    status?: string;
    status_detail?: string;
  };
  transaction_amount?: number;
  debit_date?: string;
}

export async function buscarPagamentoAutorizado(id: string): Promise<PagamentoAutorizado> {
  return chamar<PagamentoAutorizado>(`/authorized_payments/${id}`, { method: "GET" });
}

/**
 * Confere se a notificacao veio mesmo do Mercado Pago.
 *
 * Sem isso, o endpoint de webhook e publico e qualquer um pode postar
 * "pagamento aprovado" para reativar a caixa de um inadimplente — ou pior,
 * "assinatura cancelada" para suspender a caixa de um cliente em dia.
 *
 * O MP monta o manifesto no formato:
 *   id:<data.id>;request-id:<x-request-id>;ts:<ts do x-signature>;
 * e assina com HMAC-SHA256 usando o segredo da integracao.
 */
export function assinaturaValida(input: {
  xSignature: string;
  xRequestId: string;
  dataId: string;
}): boolean {
  if (!config.billing.webhookSecret) {
    log.error("MP_WEBHOOK_SECRET nao configurado: toda notificacao sera recusada", {});
    return false;
  }

  const partes = new Map(
    input.xSignature
      .split(",")
      .map((parte) => parte.split("=").map((valor) => valor.trim()))
      .filter((par): par is [string, string] => par.length === 2)
      .map(([chave, valor]) => [chave, valor] as [string, string]),
  );

  const ts = partes.get("ts");
  const recebida = partes.get("v1");
  if (!ts || !recebida) return false;

  // Notificacao velha demais é replay: o atacante repete uma cobrança
  // aprovada de meses atrás para reativar uma conta suspensa.
  const idade = Math.abs(Date.now() - Number(ts) * 1000);
  if (!Number.isFinite(idade) || idade > 10 * 60_000) {
    log.warn("notificacao com carimbo de tempo fora da janela", { ts, idadeMs: idade });
    return false;
  }

  const manifesto = `id:${input.dataId};request-id:${input.xRequestId};ts:${ts};`;
  const esperada = createHmac("sha256", config.billing.webhookSecret).update(manifesto).digest("hex");

  const bufEsperada = Buffer.from(esperada);
  const bufRecebida = Buffer.from(recebida);
  if (bufEsperada.length !== bufRecebida.length) return false;

  return timingSafeEqual(bufEsperada, bufRecebida);
}
