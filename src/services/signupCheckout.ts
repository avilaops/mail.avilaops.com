import { randomBytes, randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { criarAssinatura } from "../lib/mercadopago.js";
import { enqueueOutbound } from "../mta/queue.js";
import { createDomain, createMailbox } from "./provisioning.js";
import { SignupError, conferirDns, normalizarDominio, travarCheckout } from "./publicSignup.js";
import { enviarLinkDePrimeiroAcesso } from "./recovery.js";

const log = createLogger("signup-checkout");
const ROOT_ZONE = config.hostname.split(".").slice(-2).join(".");

/**
 * Passo 2 e 3 do autoatendimento: cobrar primeiro, provisionar depois.
 *
 * O passo 1 (`publicSignup.ts`) so informa e confere DNS. Aqui o pedido vira
 * dinheiro: criamos a assinatura no Mercado Pago e deixamos o pedido parado.
 * Dominio e caixa so nascem quando o webhook diz que a assinatura foi
 * autorizada — `provisionarPedidoPago`, chamada por `billing.ts`.
 *
 * A ordem importa. Provisionar antes de cobrar, numa rota publica, e caixa de
 * e-mail de graca para qualquer um; e caixa de graca em servidor com IP
 * proprio nao e prejuizo de R$ 10, e a reputacao de envio de todos os
 * clientes da casa indo junto.
 */

/** Nomes que ninguem compra por engano: sao nossos ou sao papel de sistema. */
const LOCAL_PARTS_RESERVADAS = new Set([
  "postmaster",
  "abuse",
  "hostmaster",
  "webmaster",
  "admin",
  "administrator",
  "root",
  "noreply",
  "no-reply",
  "dmarc",
  "mailer-daemon",
]);

/**
 * Limite de envio de uma caixa fora da quarentena. Espelha o `@default(200)`
 * de `Mailbox.sendLimitPerHour` no schema: mudar la exige mudar aqui, senao
 * a caixa que sai da quarentena fica com o limite antigo para sempre.
 */
const LIMITE_ENVIO_NORMAL = 200;

const LOCAL_PART_VALIDA = /^[a-z0-9]([a-z0-9._-]{0,30}[a-z0-9])?$/;
const EMAIL_VALIDO = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Descricao da assinatura como o Mercado Pago aceita.
 *
 * O campo `reason` tem teto de 60 caracteres e o MP responde 400 quando
 * passa. Com dominio curto isso nunca aparece, e foi assim que quase foi
 * para producao: `teste-selfservice.avilaops.com` estourou no primeiro
 * teste. O dominio entra so quando cabe — quem paga precisa reconhecer a
 * cobranca na fatura, mas nao as custas de a compra falhar.
 */
const LIMITE_REASON_MP = 60;

function motivoDaAssinatura(caixas: number, dominio: string): string {
  const plural = caixas > 1 ? "s" : "";
  const comDominio = `E-mail Avila Ops — ${caixas} caixa${plural} em ${dominio}`;
  if (comDominio.length <= LIMITE_REASON_MP) return comDominio;

  const semDominio = `E-mail Avila Ops — ${caixas} caixa${plural}`;
  return semDominio.slice(0, LIMITE_REASON_MP);
}

/** Retorno do pagamento carregando o token do pedido, sem quebrar a query. */
function comPedido(base: string, token: string): string {
  const url = new URL(base);
  url.searchParams.set("pedido", token);
  return url.toString();
}

export interface PedidoDeCadastro {
  domain: string;
  payerEmail: string;
  payerName?: string;
  localPart: string;
  mailboxCount: number;
  ip: string;
}

/**
 * Senha com que a caixa nasce, e que ninguem nunca ve.
 *
 * A caixa precisa de um hash de senha para existir, mas a casa nao manda
 * senha por e-mail (ver `welcome.ts`). Entao esta aqui so ocupa o lugar: o
 * dono cria a dele pelo link de primeiro acesso, e ate la nao ha como entrar.
 */
function senhaInacessivel(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Idade do dominio pelo RDAP.
 *
 * Dominio registrado na semana passada e o padrao de quem queima um dominio
 * por campanha de spam. `null` quando nao deu para saber — e a diferenca
 * importa: sem resposta do RDAP nos deixamos passar, porque recusar cliente de
 * verdade por indisponibilidade de terceiro e pior do que deixar entrar um
 * suspeito que ainda vai esbarrar no freio de novato e no limite de caixas.
 */
async function idadeDoDominioEmDias(dominio: string): Promise<number | null> {
  const controle = new AbortController();
  const prazo = setTimeout(() => controle.abort(), 6000);
  try {
    const r = await fetch(`https://rdap.org/domain/${encodeURIComponent(dominio)}`, {
      signal: controle.signal,
      headers: { accept: "application/rdap+json" },
    });
    if (!r.ok) return null;
    const corpo = (await r.json()) as { events?: Array<{ eventAction?: string; eventDate?: string }> };
    const registro = corpo.events?.find((e) => e.eventAction === "registration")?.eventDate;
    if (!registro) return null;
    const quando = new Date(registro).getTime();
    if (!Number.isFinite(quando)) return null;
    return Math.floor((Date.now() - quando) / 86_400_000);
  } catch {
    return null;
  } finally {
    clearTimeout(prazo);
  }
}

/**
 * O e-mail do pagador ja e conhecido da casa?
 *
 * Enquanto `MAIL_SIGNUP_MODO=restrito`, e isto que separa quem fecha sozinho
 * de quem precisa falar com a gente. Conhecido = ja paga alguma coisa aqui, ja
 * tem caixa, ou e o dono de alguma caixa no SSO.
 */
async function clienteConhecido(email: string): Promise<boolean> {
  const [conta, caixa] = await Promise.all([
    prisma.billingAccount.findFirst({ where: { payerEmail: email }, select: { id: true } }),
    prisma.mailbox.findFirst({
      where: {
        OR: [{ ownerEmail: { equals: email, mode: "insensitive" } }, { recoveryEmail: { equals: email, mode: "insensitive" } }],
      },
      select: { id: true },
    }),
  ]);
  return Boolean(conta || caixa);
}

/**
 * Cria o pedido e devolve o link de pagamento.
 *
 * Nada e provisionado aqui. O que sai desta funcao e uma linha em
 * `mail_signups` com status `aguardando_pagamento` e o `initPoint` do Mercado
 * Pago.
 */
export async function iniciarCheckout(pedido: PedidoDeCadastro) {
  const dominio = normalizarDominio(pedido.domain);
  const email = String(pedido.payerEmail ?? "").trim().toLowerCase();
  const localPart = String(pedido.localPart ?? "").trim().toLowerCase();
  const caixas = Number(pedido.mailboxCount ?? 1);

  if (!EMAIL_VALIDO.test(email)) {
    throw new SignupError("Informe um e-mail de contato valido.", 422);
  }
  if (!LOCAL_PART_VALIDA.test(localPart) || LOCAL_PARTS_RESERVADAS.has(localPart)) {
    throw new SignupError("Escolha outro nome para a caixa, como contato ou financeiro.", 422);
  }
  if (!Number.isInteger(caixas) || caixas < 1 || caixas > config.signup.maxCaixas) {
    throw new SignupError(
      `Pelo autoatendimento damos conta de ate ${config.signup.maxCaixas} caixas. Para mais, fale com a gente.`,
      422,
    );
  }

  if (!config.billing.accessToken) {
    throw new SignupError("Cobranca indisponivel no momento. Fale com a gente.", 503);
  }
  if (!config.signup.retornoUrl) {
    // O mesmo cuidado de `iniciarAssinatura`: sem o retorno configurado, o
    // cliente cadastra o cartao e cai no vazio. Falhar antes de cobrar.
    //
    // Confere `signup.retornoUrl`, que e a variavel de fato usada mais abaixo.
    // Conferir `billing.backUrl` aqui, como estava, deixava passar com o
    // retorno do autoatendimento vazio, e a falha aparecia como um `Invalid
    // URL` sem contexto depois de a pessoa ja ter clicado em comprar.
    throw new SignupError("Cobranca indisponivel no momento. Fale com a gente.", 503);
  }

  // A trava entra aqui, e nao no comeco: campo mal preenchido nao pode gastar
  // as tentativas de compra de quem so errou o e-mail. Daqui para baixo e que
  // a chamada custa — DNS, RDAP e assinatura no Mercado Pago.
  await travarCheckout(dominio, pedido.ip);

  // O DNS precisa estar de pe ANTES de cobrar. E tambem a prova de posse do
  // dominio: so quem controla o DNS consegue apontar o MX para nos.
  const dns = await conferirDns(dominio, pedido.ip, { contarTentativa: false });
  if (!dns.pronto) {
    throw new SignupError(
      `O DNS ainda nao esta pronto: falta ${dns.faltando.join(", ")}. Publique os registros e confira de novo.`,
      409,
    );
  }

  // Dominio que ja e nosso nao entra pelo autoatendimento: pode ser cliente
  // antigo, pode ser caixa que alguem quer roubar por cima. Passa por gente.
  const jaExiste = await prisma.mailDomain.findUnique({ where: { name: dominio }, select: { id: true } });
  if (jaExiste) {
    throw new SignupError("Este dominio ja esta cadastrado conosco. Fale com a gente para adicionar caixas.", 409);
  }

  const pendente = await prisma.mailSignup.findFirst({
    where: { domain: dominio, status: { in: ["aguardando_pagamento", "pago"] }, expiresAt: { gt: new Date() } },
    select: { token: true, initPoint: true, status: true },
  });
  if (pendente) {
    // Devolver o pedido que ja existe evita duas assinaturas para o mesmo
    // dominio quando a pessoa aperta o botao duas vezes.
    return { token: pendente.token, initPoint: pendente.initPoint, status: pendente.status, reaproveitado: true };
  }

  if (config.signup.modo === "restrito" && !(await clienteConhecido(email))) {
    throw new SignupError(
      "Por enquanto o cadastro automatico atende quem ja e cliente da casa. Fale com a gente e abrimos o seu.",
      403,
    );
  }

  const idade = await idadeDoDominioEmDias(dominio);
  if (idade !== null && idade < config.signup.idadeMinimaDias) {
    throw new SignupError(
      "Este dominio foi registrado ha pouco tempo. Fale com a gente para liberarmos o cadastro.",
      403,
    );
  }
  if (idade === null) {
    log.warn("idade do dominio desconhecida; seguindo assim mesmo", { dominio });
  }

  const token = randomBytes(24).toString("base64url");
  const clientRef = `auto:${token}`;
  const valor = caixas * config.billing.unitPriceCents;

  const assinatura = await criarAssinatura({
    motivo: motivoDaAssinatura(caixas, dominio),
    clientRef,
    payerEmail: email,
    valorCentavos: valor,
    // `URL` em vez de concatenar: o retorno pode ja ter query, e
    // `...?pedido=` grudado num `?a=b` existente vira URL invalida.
    backUrl: comPedido(config.signup.retornoUrl, token),
  });

  const criado = await prisma.mailSignup.create({
    data: {
      token,
      domain: dominio,
      payerEmail: email,
      payerName: pedido.payerName?.trim() || null,
      localPart,
      mailboxCount: caixas,
      unitPriceCents: config.billing.unitPriceCents,
      clientRef,
      preapprovalId: assinatura.id,
      initPoint: assinatura.init_point ?? null,
      ip: pedido.ip,
      expiresAt: new Date(Date.now() + config.signup.horasParaExpirar * 3_600_000),
    },
    select: { token: true, initPoint: true, status: true },
  });

  log.info("pedido de cadastro criado", { dominio, caixas, valorCentavos: valor, preapprovalId: assinatura.id });

  return { ...criado, reaproveitado: false };
}

/** Estado do pedido, para a tela que espera o pagamento. */
export async function estadoDoPedido(token: string) {
  const pedido = await prisma.mailSignup.findUnique({
    where: { token: String(token ?? "") },
    select: {
      domain: true,
      localPart: true,
      mailboxCount: true,
      unitPriceCents: true,
      status: true,
      initPoint: true,
      provisionedAt: true,
      expiresAt: true,
    },
  });
  if (!pedido) throw new SignupError("Pedido nao encontrado.", 404);

  return {
    ...pedido,
    endereco: pedido.status === "provisionado" ? `${pedido.localPart}@${pedido.domain}` : null,
    // Nenhuma credencial volta por aqui: o link para criar a senha foi para o
    // e-mail de contato. Devolver na tela transformaria o token do pedido, que
    // anda na URL, em credencial da caixa.
  };
}

/**
 * Provisiona o pedido depois que o pagamento foi confirmado.
 *
 * Chamada pelo webhook do Mercado Pago (`billing.ts`), nunca por rota publica.
 * Idempotente: o MP reenvia notificacao, e provisionar duas vezes criaria a
 * caixa duas vezes ou explodiria no meio.
 */
export async function provisionarPedidoPago(clientRef: string): Promise<{ provisionado: boolean; motivo: string }> {
  const pedido = await prisma.mailSignup.findUnique({ where: { clientRef } });
  if (!pedido) return { provisionado: false, motivo: "sem pedido de cadastro" };
  if (pedido.status === "provisionado") return { provisionado: false, motivo: "pedido ja provisionado" };

  // Pedido `expirado` segue adiante de proposito. Expirar so libera o dominio
  // para outro pedido; o link de pagamento do Mercado Pago continua valendo, e
  // quem pagou por ele pagou. Se o dominio ainda esta livre, a caixa nasce; se
  // outro cliente ja o levou, a checagem de dono abaixo para e avisa.

  // Marca `pago` antes de comecar: se o provisionamento falhar no meio, o
  // pedido nao volta a parecer nao pago, e a falha fica registrada em `erro`
  // para alguem retomar sem cobrar de novo.
  await prisma.mailSignup.update({ where: { id: pedido.id }, data: { status: "pago", erro: null } });

  try {
    const dominio = await createDomain({ domain: pedido.domain, clientRef: pedido.clientRef });

    // `createDomain` devolve o dominio que ja existe sem reclamar. Se ele e de
    // outro cliente — outro pedido para o mesmo dominio que pagou antes — seguir
    // daqui mandaria para ESTE pagador o link que cria a senha da caixa do
    // outro. Para e deixa a operacao decidir: e caso de estorno, nao de retomada.
    const dono = await prisma.mailDomain.findUnique({ where: { id: dominio.id }, select: { clientRef: true } });
    if (dono?.clientRef !== pedido.clientRef) {
      throw new SignupError(`O dominio ${pedido.domain} ja pertence a outro cliente; pedido pago precisa de estorno.`, 409);
    }

    // Tentativa anterior pode ter criado a caixa e caido depois. `createMailbox`
    // recusa caixa que ja existe, e sem esta checagem o pedido pago ficaria
    // preso em `falhou` para sempre, falhando de novo a cada retomada.
    const existente = await prisma.mailbox.findUnique({
      where: { domainId_localPart: { domainId: dominio.id, localPart: pedido.localPart } },
      select: { id: true },
    });

    const caixaId =
      existente?.id ??
      (
        await createMailbox({
          domain: pedido.domain,
          username: pedido.localPart,
          password: senhaInacessivel(),
          displayName: pedido.payerName ?? undefined,
          // Sem `notifyTo`: o aviso padrao diz "senha entregue separadamente",
          // e aqui nao ha ninguem para entregar. Quem avisa e o link de
          // primeiro acesso, logo abaixo.
          //
          // Sem troca obrigatoria: a senha que vale e a que o dono cria pelo
          // link, e pedir para trocar em seguida a senha que ele acabou de
          // escolher e so atrito.
          mustChangePassword: false,
        })
      ).id;

    await prisma.mailbox.update({
      where: { id: caixaId },
      data: {
        // E o que faz o link de primeiro acesso ter para onde ir, e o que
        // deixa o "Esqueci a senha" funcionar quando o link vencer.
        recoveryEmail: pedido.payerEmail,
        // Freio de novato. Fica na caixa, nao no dominio: quem compra hoje
        // envia pouco, e a faxina diaria solta o freio quando o prazo passa.
        sendLimitPerHour: config.signup.limiteEnvioNovato,
        probationUntil: new Date(Date.now() + config.signup.diasNovato * 86_400_000),
      },
    });

    await enviarLinkDePrimeiroAcesso(caixaId);

    await prisma.mailSignup.update({
      where: { id: pedido.id },
      data: { status: "provisionado", provisionedAt: new Date() },
    });

    log.info("pedido provisionado", { dominio: pedido.domain, caixa: `${pedido.localPart}@${pedido.domain}` });

    // Depois de marcar `provisionado` e sem deixar subir: o cliente ja foi
    // atendido, e aviso interno que falha nao pode desfazer isso.
    await avisarVenda(pedido).catch((falha) => {
      log.error("venda provisionada, mas o aviso a operacao nao saiu", {
        dominio: pedido.domain,
        erro: falha instanceof Error ? falha.message : String(falha),
      });
    });

    return { provisionado: true, motivo: "dominio e caixa criados" };
  } catch (falha) {
    const mensagem = falha instanceof Error ? falha.message : String(falha);
    await prisma.mailSignup.update({
      where: { id: pedido.id },
      data: { status: "falhou", erro: mensagem.slice(0, 2000) },
    });
    // Erro sobe: o cliente pagou e nao recebeu. Isso tem que aparecer no
    // alerta de saude, nao virar linha de log perdida.
    log.error("pedido pago que nao provisionou", { dominio: pedido.domain, erro: mensagem });
    throw falha;
  }
}

/**
 * Pedido `pago` mais novo que isto pode estar sendo provisionado agora pelo
 * webhook. Retomar por cima criaria a caixa em duas frentes.
 */
const MINUTOS_ANTES_DE_RETOMAR = 15;

/**
 * Avisa a operacao de pedido pago que continua sem caixa.
 *
 * E o unico aviso desta casa que significa "alguem pagou e nao recebeu".
 * Repete a cada faxina enquanto durar, de proposito: ao contrario do DNS de um
 * cliente, este problema nao tem versao toleravel.
 */
async function avisarPedidosTravados(travados: Array<{ domain: string; payerEmail: string; erro: string }>): Promise<void> {
  await avisarOperacao(`[mail] ${travados.length} pedido(s) pago(s) sem caixa criada`, [
    "Cliente que PAGOU pelo autoatendimento e ainda NAO recebeu a caixa.",
    "A retomada automatica tentou de novo e falhou. Precisa de gente.",
    "",
    ...travados.flatMap((pedido) => [
      `Dominio:  ${pedido.domain}`,
      `Pagador:  ${pedido.payerEmail}`,
      `Erro:     ${pedido.erro}`,
      "",
    ]),
    "A tentativa se repete a cada faxina diaria. O pedido fica em mail_signups com status 'falhou'.",
  ]);
}

/**
 * Avisa a operacao de cada venda fechada sem ninguem da casa no meio.
 *
 * Autoatendimento que funciona e silencioso por definicao, e venda que
 * ninguem viu e cliente novo sem ninguem de olho na primeira semana. Tambem e
 * o unico lugar que lembra das caixas que faltam: o pedido cria so a primeira,
 * e as demais nascem pelo painel administrativo.
 */
async function avisarVenda(pedido: {
  domain: string;
  payerEmail: string;
  payerName: string | null;
  localPart: string;
  mailboxCount: number;
}): Promise<void> {
  const faltam = pedido.mailboxCount - 1;

  await avisarOperacao(`[mail] Venda pelo autoatendimento: ${pedido.domain}`, [
    "Um pedido do autoatendimento foi pago e provisionado.",
    "",
    `Dominio:            ${pedido.domain}`,
    `Pagador:            ${pedido.payerName ? `${pedido.payerName} <${pedido.payerEmail}>` : pedido.payerEmail}`,
    `Caixa criada:       ${pedido.localPart}@${pedido.domain}`,
    `Caixas contratadas: ${pedido.mailboxCount}`,
    "",
    ...(faltam > 0
      ? [
          `FALTAM ${faltam} CAIXA(S). O pedido cria so a primeira: combine os nomes com o`,
          `cliente e crie as demais em https://${config.hostname}/admin. A cobranca acompanha`,
          "o numero de caixas que existem, entao ela so chega ao valor contratado depois disso.",
        ]
      : ["Nada a fazer: o cliente ja recebeu o link para criar a senha."]),
  ]);
}

/** Manda um aviso de texto para `MAIL_ADMIN_ADDRESSES`. */
async function avisarOperacao(assunto: string, linhas: string[]): Promise<void> {
  const destinatarios = config.admin.addresses;
  if (destinatarios.length === 0) {
    log.error("ha o que avisar, mas MAIL_ADMIN_ADDRESSES esta vazio; ninguem sera notificado", { assunto });
    return;
  }

  const remetente = `naoresponda@${ROOT_ZONE}`;

  const bruto = await new MailComposer({
    from: { name: "Avila Mail (autoatendimento)", address: remetente },
    to: destinatarios.join(", "),
    subject: assunto,
    text: linhas.join("\r\n"),
    messageId: `<${randomUUID()}@${ROOT_ZONE}>`,
    date: new Date(),
    textEncoding: "quoted-printable",
  })
    .compile()
    .build();

  await enqueueOutbound({ envelopeFrom: remetente, recipients: destinatarios, raw: bruto, subject: assunto, sign: true });
}

/**
 * Tenta de novo os pedidos pagos que ficaram sem caixa.
 *
 * O webhook provisiona na hora, mas basta o banco piscar no meio para o pedido
 * parar em `falhou` — ou em `pago`, se o processo caiu antes de registrar a
 * falha. Sem retomada, o unico sinal seria o cliente reclamando que pagou.
 */
async function retomarPedidosPagos(): Promise<{ retomados: number; travados: number }> {
  const corte = new Date(Date.now() - MINUTOS_ANTES_DE_RETOMAR * 60_000);

  const pendentes = await prisma.mailSignup.findMany({
    where: {
      OR: [{ status: "falhou" }, { status: "pago", createdAt: { lt: corte } }],
    },
    select: { clientRef: true, domain: true, payerEmail: true },
  });

  let retomados = 0;
  const travados: Array<{ domain: string; payerEmail: string; erro: string }> = [];

  for (const pedido of pendentes) {
    try {
      const resultado = await provisionarPedidoPago(pedido.clientRef);
      if (resultado.provisionado) retomados += 1;
    } catch (falha) {
      travados.push({
        domain: pedido.domain,
        payerEmail: pedido.payerEmail,
        erro: falha instanceof Error ? falha.message : String(falha),
      });
    }
  }

  if (travados.length > 0) {
    await avisarPedidosTravados(travados).catch((falha) => {
      log.error("nao foi possivel avisar sobre pedido pago sem caixa", {
        erro: falha instanceof Error ? falha.message : String(falha),
      });
    });
  }

  return { retomados, travados: travados.length };
}

/**
 * Faxina do self-service, chamada pela manutencao diaria.
 *
 * O que so acontece com o tempo: pedido que ninguem pagou some, caixa que
 * passou da quarentena volta ao limite normal de envio, e pedido pago que
 * ficou sem caixa e tentado de novo.
 */
export async function manutencaoDoSelfService(): Promise<{
  expirados: number;
  freiosSoltos: number;
  retomados: number;
  travados: number;
}> {
  const agora = new Date();

  const expirados = await prisma.mailSignup.updateMany({
    where: { status: "aguardando_pagamento", expiresAt: { lt: agora } },
    data: { status: "expirado" },
  });

  const freiosSoltos = await prisma.mailbox.updateMany({
    where: { probationUntil: { lt: agora } },
    data: { sendLimitPerHour: LIMITE_ENVIO_NORMAL, probationUntil: null },
  });

  const retomada = await retomarPedidosPagos();

  if (expirados.count || freiosSoltos.count || retomada.retomados || retomada.travados) {
    log.info("manutencao do self-service", {
      expirados: expirados.count,
      freiosSoltos: freiosSoltos.count,
      ...retomada,
    });
  }
  return { expirados: expirados.count, freiosSoltos: freiosSoltos.count, ...retomada };
}
