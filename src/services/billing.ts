import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { provisionarPedidoPago } from "./signupCheckout.js";
import { createLogger } from "../lib/logger.js";
import { isValidAddress } from "../lib/address.js";
import {
  alterarStatus,
  atualizarValor,
  buscarAssinatura,
  buscarPagamentoAutorizado,
  criarAssinatura,
} from "../lib/mercadopago.js";

const log = createLogger("billing");

/**
 * Cobranca recorrente das caixas de e-mail.
 *
 * Uma assinatura por CLIENTE, com valor igual a R$ 10 x numero de caixas. Uma
 * assinatura por caixa encheria a fatura do cartao do cliente de linhas de
 * R$ 10 e multiplicaria a taxa fixa do gateway em cada uma.
 *
 * O numero de caixas e sempre lido do banco na hora, nunca guardado como
 * verdade: caixa criada ou removida pelo painel nao pode depender de alguem
 * lembrar de atualizar a cobranca.
 */

export class BillingError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "BillingError";
  }
}

/** Caixas cobraveis do cliente: ativas e suspensas (suspensa ocupa disco). */
async function contarCaixas(clientRef: string): Promise<number> {
  return prisma.mailbox.count({
    where: { status: { in: ["active", "suspended"] }, domain: { clientRef } },
  });
}

export async function garantirConta(input: {
  clientRef: string;
  payerEmail: string;
  payerName?: string;
}) {
  if (!isValidAddress(input.payerEmail)) {
    throw new BillingError("E-mail do pagador invalido.", 422);
  }

  const caixas = await contarCaixas(input.clientRef);
  const email = input.payerEmail.trim().toLowerCase();

  return prisma.billingAccount.upsert({
    where: { clientRef: input.clientRef },
    create: {
      clientRef: input.clientRef,
      payerEmail: email,
      payerName: input.payerName ?? null,
      unitPriceCents: config.billing.unitPriceCents,
      mailboxCount: caixas,
      amountCents: caixas * config.billing.unitPriceCents,
    },
    update: { payerEmail: email, payerName: input.payerName ?? undefined },
  });
}

async function exigirConta(clientRef: string) {
  const conta = await prisma.billingAccount.findUnique({ where: { clientRef } });
  if (!conta) throw new BillingError(`Cliente sem conta de cobranca: ${clientRef}`, 404);
  return conta;
}

/**
 * Gera o link para o cliente cadastrar o cartao.
 *
 * Devolve `initPoint`, a pagina do Mercado Pago. Nenhum dado de cartao chega
 * aqui — o que volta para nos e o webhook dizendo que a assinatura foi
 * autorizada.
 */
export async function iniciarAssinatura(clientRef: string) {
  const conta = await exigirConta(clientRef);

  if (conta.status === "authorized") {
    throw new BillingError("Este cliente ja tem assinatura ativa.", 409);
  }

  const caixas = await contarCaixas(clientRef);
  if (caixas === 0) {
    // Assinatura de R$ 0 e recusada pelo MP, e cobrar antes de existir caixa
    // seria cobrar por nada.
    throw new BillingError("Crie ao menos uma caixa antes de iniciar a cobranca.", 422);
  }

  // Sem isso o cliente cadastra o cartao e cai no vazio ao voltar. Falhar aqui
  // e melhor do que descobrir pelo cliente que pagou.
  if (!config.billing.backUrl) {
    throw new BillingError(
      "MP_BACK_URL nao configurado: defina a pagina do portal para onde o cliente volta apos o cartao.",
      500,
    );
  }

  const valor = caixas * conta.unitPriceCents;

  const assinatura = await criarAssinatura({
    motivo: `E-mail Avila Ops — ${caixas} caixa${caixas > 1 ? "s" : ""}`,
    clientRef,
    payerEmail: conta.payerEmail,
    valorCentavos: valor,
    backUrl: config.billing.backUrl,
  });

  const atualizada = await prisma.billingAccount.update({
    where: { id: conta.id },
    data: {
      preapprovalId: assinatura.id,
      initPoint: assinatura.init_point ?? null,
      status: assinatura.status === "authorized" ? "authorized" : "pending_card",
      mailboxCount: caixas,
      amountCents: valor,
    },
  });

  log.info("assinatura criada", { clientRef, preapprovalId: assinatura.id, valorCentavos: valor });

  return {
    initPoint: atualizada.initPoint,
    status: atualizada.status,
    mailboxCount: caixas,
    amountCents: valor,
  };
}

/**
 * Recalcula o valor conforme o numero de caixas de hoje.
 *
 * Chamado depois de criar ou remover caixa. Se o valor nao mudou, nao toca no
 * Mercado Pago: PUT desnecessario em assinatura ativa e risco de gerar
 * reautorizacao do cliente sem motivo.
 */
export async function sincronizarValor(clientRef: string) {
  const conta = await exigirConta(clientRef);
  const caixas = await contarCaixas(clientRef);
  const valor = caixas * conta.unitPriceCents;

  if (valor === conta.amountCents && caixas === conta.mailboxCount) {
    return { alterado: false, mailboxCount: caixas, amountCents: valor };
  }

  if (conta.preapprovalId && conta.status === "authorized" && valor > 0) {
    await atualizarValor(conta.preapprovalId, valor);
  }

  await prisma.billingAccount.update({
    where: { id: conta.id },
    data: { mailboxCount: caixas, amountCents: valor },
  });

  log.info("valor da assinatura sincronizado", {
    clientRef,
    de: conta.amountCents,
    para: valor,
    caixas,
  });

  return { alterado: true, mailboxCount: caixas, amountCents: valor };
}

export async function cancelarAssinatura(clientRef: string) {
  const conta = await exigirConta(clientRef);
  if (conta.preapprovalId) await alterarStatus(conta.preapprovalId, "cancelled");

  await prisma.billingAccount.update({
    where: { id: conta.id },
    data: { status: "cancelled" },
  });

  log.warn("assinatura cancelada", { clientRef });
  return { clientRef, status: "cancelled" };
}

// ---------------------------------------------------------------------------
// Suspensao por inadimplencia
// ---------------------------------------------------------------------------

/**
 * Bloqueia o ACESSO das caixas do cliente — nao o recebimento.
 *
 * Decisao de produto ja tomada no provisionamento: quem atrasa nao pode perder
 * e-mail. A mensagem continua chegando e reaparece assim que o pagamento entra.
 */
export async function suspenderPorInadimplencia(clientRef: string) {
  const resultado = await prisma.mailbox.updateMany({
    where: { status: "active", domain: { clientRef } },
    data: { status: "suspended" },
  });

  await prisma.billingAccount.updateMany({
    where: { clientRef },
    data: { suspendedAt: new Date() },
  });

  if (resultado.count > 0) {
    log.warn("caixas suspensas por inadimplencia", { clientRef, caixas: resultado.count });
  }

  return { suspensas: resultado.count };
}

export async function reativarAposPagamento(clientRef: string) {
  const resultado = await prisma.mailbox.updateMany({
    // Só as que NOS suspendemos. Caixa 'disabled' foi desativada de propósito
    // e não pode voltar sozinha porque um boleto foi pago.
    where: { status: "suspended", domain: { clientRef } },
    data: { status: "active" },
  });

  await prisma.billingAccount.updateMany({
    where: { clientRef },
    data: { suspendedAt: null, failedAttempts: 0 },
  });

  if (resultado.count > 0) {
    log.info("caixas reativadas apos pagamento", { clientRef, caixas: resultado.count });
  }

  return { reativadas: resultado.count };
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export interface Notificacao {
  topic: string;
  action?: string;
  dataId: string;
  payload?: unknown;
}

/**
 * Processa uma notificacao do Mercado Pago.
 *
 * Idempotente por construcao: a notificacao e gravada com chave unica ANTES
 * de ser processada. O MP reenvia a mesma notificacao quando nao recebe 200
 * rapido, e sem isso o mesmo pagamento entraria duas vezes.
 *
 * A excecao e `subscription_preapproval`. Ali o id notificado e o da
 * assinatura, que e o mesmo do cadastro do cartao ao cancelamento: descartar
 * pela chave jogava fora toda mudanca de estado depois da primeira — a
 * autorizacao que provisiona a caixa de quem acabou de pagar, e o
 * cancelamento que tira o acesso. Esse topico nao carrega um fato, so manda
 * reler a assinatura no MP, e reler duas vezes da no mesmo lugar.
 */
export async function processarNotificacao(notificacao: Notificacao): Promise<{ processada: boolean; motivo: string }> {
  const chave = `${notificacao.topic}:${notificacao.dataId}`;
  const espelhaEstado = notificacao.topic === "subscription_preapproval";

  const jaVista = await prisma.billingEvent.findUnique({
    where: { notificationId: chave },
    select: { processedAt: true },
  });
  if (jaVista?.processedAt && !espelhaEstado) return { processada: false, motivo: "notificacao repetida" };

  const evento = await prisma.billingEvent.upsert({
    where: { notificationId: chave },
    create: {
      notificationId: chave,
      topic: notificacao.topic,
      action: notificacao.action ?? null,
      payload: (notificacao.payload ?? {}) as object,
    },
    update: {},
    select: { id: true },
  });

  try {
    const resultado = await despachar(notificacao);

    await prisma.billingEvent.update({
      where: { id: evento.id },
      data: { processedAt: new Date(), accountId: resultado.accountId ?? null, error: null },
    });

    return { processada: true, motivo: resultado.motivo };
  } catch (falha) {
    const mensagem = falha instanceof Error ? falha.message : String(falha);

    await prisma.billingEvent.update({
      where: { id: evento.id },
      data: { error: mensagem.slice(0, 2000) },
    });

    log.error("falha ao processar notificacao", { chave, erro: mensagem });
    throw falha;
  }
}

async function despachar(
  notificacao: Notificacao,
): Promise<{ motivo: string; accountId?: string }> {
  if (notificacao.topic === "subscription_preapproval") {
    return sincronizarAssinatura(notificacao.dataId);
  }

  if (notificacao.topic === "subscription_authorized_payment") {
    return registrarCobranca(notificacao.dataId);
  }

  return { motivo: `topico ignorado: ${notificacao.topic}` };
}

/** Espelha o estado da assinatura no Mercado Pago para o nosso banco. */
async function sincronizarAssinatura(preapprovalId: string) {
  const assinatura = await buscarAssinatura(preapprovalId);

  const conta = await prisma.billingAccount.findFirst({
    where: {
      OR: [{ preapprovalId }, { clientRef: assinatura.external_reference ?? "___" }],
    },
  });

  if (!conta) {
    // Pedido de autoatendimento ainda nao tem `BillingAccount`: quando o
    // checkout criou a assinatura nao existia caixa nenhuma para contar, e
    // `garantirConta` calcula o valor a partir das caixas. A conta nasce
    // aqui, ja com o pagamento confirmado, e o provisionamento vem em
    // seguida.
    const pedido = await prisma.mailSignup.findUnique({
      where: { clientRef: assinatura.external_reference ?? "___" },
      select: { clientRef: true, payerEmail: true, payerName: true, mailboxCount: true, unitPriceCents: true },
    });
    if (!pedido) return { motivo: "assinatura sem conta correspondente" };

    const criada = await prisma.billingAccount.create({
      data: {
        clientRef: pedido.clientRef,
        payerEmail: pedido.payerEmail,
        payerName: pedido.payerName,
        preapprovalId,
        status: assinatura.status,
        unitPriceCents: pedido.unitPriceCents,
        mailboxCount: pedido.mailboxCount,
        amountCents: pedido.mailboxCount * pedido.unitPriceCents,
        nextChargeAt: assinatura.next_payment_date ? new Date(assinatura.next_payment_date) : null,
      },
    });

    if (assinatura.status === "authorized") {
      await provisionarPedidoPago(pedido.clientRef);
    }

    return { motivo: `cadastro automatico ${assinatura.status}`, accountId: criada.id };
  }

  await prisma.billingAccount.update({
    where: { id: conta.id },
    data: {
      preapprovalId,
      status: assinatura.status,
      nextChargeAt: assinatura.next_payment_date ? new Date(assinatura.next_payment_date) : null,
    },
  });

  // Cancelamento derruba o acesso; autorizacao devolve. Quem cancelou pode ter
  // sido o proprio cliente pelo app do MP — nao ha aviso nenhum além deste.
  if (assinatura.status === "cancelled" || assinatura.status === "paused") {
    await suspenderPorInadimplencia(conta.clientRef);
  } else if (assinatura.status === "authorized" && conta.suspendedAt) {
    await reativarAposPagamento(conta.clientRef);
  }

  // Autoatendimento: e AQUI que o dominio e a caixa nascem. O pedido ficou
  // parado desde o checkout justamente esperando esta confirmacao — cobrar
  // primeiro e provisionar depois e o que impede caixa de graca em rota
  // publica. Idempotente do outro lado: o MP reenvia a mesma notificacao.
  if (assinatura.status === "authorized") {
    await provisionarPedidoPago(conta.clientRef);
  }

  return { motivo: `assinatura ${assinatura.status}`, accountId: conta.id };
}

/** Registra a cobranca mensal e decide entre reativar e suspender. */
async function registrarCobranca(authorizedPaymentId: string) {
  const cobranca = await buscarPagamentoAutorizado(authorizedPaymentId);

  const conta = await prisma.billingAccount.findFirst({
    where: { preapprovalId: cobranca.preapproval_id },
  });
  if (!conta) return { motivo: "cobranca sem conta correspondente" };

  const aprovada = cobranca.status === "processed" || cobranca.payment?.status === "approved";
  const centavos = Math.round((cobranca.transaction_amount ?? 0) * 100);

  await prisma.billingPayment.upsert({
    where: { externalId: String(cobranca.id) },
    create: {
      accountId: conta.id,
      externalId: String(cobranca.id),
      amountCents: centavos,
      status: aprovada ? "approved" : (cobranca.payment?.status ?? cobranca.status),
      statusDetail: cobranca.payment?.status_detail ?? null,
      paidAt: aprovada ? new Date() : null,
    },
    update: {
      status: aprovada ? "approved" : (cobranca.payment?.status ?? cobranca.status),
      statusDetail: cobranca.payment?.status_detail ?? null,
      paidAt: aprovada ? new Date() : null,
    },
  });

  if (aprovada) {
    await prisma.billingAccount.update({
      where: { id: conta.id },
      data: { lastPaymentAt: new Date(), failedAttempts: 0 },
    });
    await reativarAposPagamento(conta.clientRef);
    return { motivo: "pagamento aprovado", accountId: conta.id };
  }

  const tentativas = conta.failedAttempts + 1;
  await prisma.billingAccount.update({
    where: { id: conta.id },
    data: { failedAttempts: tentativas },
  });

  // O MP tenta de novo por alguns dias antes de desistir. Suspender na primeira
  // recusa puniria cartao que expirou e vai ser trocado em duas horas.
  const primeiraRecusa = conta.lastPaymentAt ?? conta.createdAt;
  const diasDesdeOk = (Date.now() - primeiraRecusa.getTime()) / 86_400_000;

  if (diasDesdeOk > config.billing.graceDays) {
    await suspenderPorInadimplencia(conta.clientRef);
    return { motivo: `cobranca recusada, acesso suspenso apos ${config.billing.graceDays} dias`, accountId: conta.id };
  }

  return { motivo: `cobranca recusada, ${tentativas}a tentativa, dentro da tolerancia`, accountId: conta.id };
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

export async function resumoConta(clientRef: string) {
  const conta = await exigirConta(clientRef);
  const caixas = await contarCaixas(clientRef);

  const pagamentos = await prisma.billingPayment.findMany({
    where: { accountId: conta.id },
    orderBy: { createdAt: "desc" },
    take: 12,
    select: { externalId: true, amountCents: true, status: true, statusDetail: true, paidAt: true, createdAt: true },
  });

  return {
    clientRef: conta.clientRef,
    status: conta.status,
    payerEmail: conta.payerEmail,
    initPoint: conta.status === "authorized" ? null : conta.initPoint,
    mailboxCount: caixas,
    unitPriceCents: conta.unitPriceCents,
    // O valor cobrado acompanha o número de caixas de hoje, não o congelado.
    amountCents: caixas * conta.unitPriceCents,
    nextChargeAt: conta.nextChargeAt,
    lastPaymentAt: conta.lastPaymentAt,
    failedAttempts: conta.failedAttempts,
    suspendedAt: conta.suspendedAt,
    payments: pagamentos,
  };
}

/** Painel de faturamento: todas as contas com o que cada uma rende. */
export async function visaoGeral() {
  const contas = await prisma.billingAccount.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      clientRef: true,
      payerEmail: true,
      status: true,
      mailboxCount: true,
      amountCents: true,
      lastPaymentAt: true,
      suspendedAt: true,
    },
  });

  const ativas = contas.filter((conta) => conta.status === "authorized");

  return {
    accounts: contas,
    totals: {
      accounts: contas.length,
      authorized: ativas.length,
      mailboxes: ativas.reduce((soma, conta) => soma + conta.mailboxCount, 0),
      /** Receita recorrente mensal, em centavos. */
      mrrCents: ativas.reduce((soma, conta) => soma + conta.amountCents, 0),
    },
  };
}
