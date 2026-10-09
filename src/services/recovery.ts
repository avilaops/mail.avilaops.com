import { createHash, randomBytes, randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { parseAddress } from "../lib/address.js";
import { burnPasswordTime, hashPassword } from "../lib/password.js";
import { enqueueOutbound } from "../mta/queue.js";
import { AuthError, logoutAll } from "./session.js";

const log = createLogger("recovery");

/**
 * Recuperacao de senha pelo proprio cliente.
 *
 * So funciona para quem cadastrou um e-mail de recuperacao externo. Mandar o
 * link para a propria caixa seria inutil: quem perdeu a senha nao consegue
 * abrir a caixa para ler o link.
 */

const ROOT_ZONE = config.hostname.replace(/^mail\./, "");
const VALIDADE_MINUTOS = 60;
const MAX_PEDIDOS_POR_JANELA = 3;
const JANELA_MINUTOS = 60;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function janelaAtual(): Date {
  const tamanho = JANELA_MINUTOS * 60_000;
  return new Date(Math.floor(Date.now() / tamanho) * tamanho);
}

/** Mascara o destino: confirma o envio sem revelar o endereco completo. */
function mascarar(email: string): string {
  const [local, dominio] = email.split("@");
  if (!local || !dominio) return "***";
  const visivel = local.slice(0, 2);
  return `${visivel}${"*".repeat(Math.max(local.length - 2, 1))}@${dominio}`;
}

async function montarEmail(destino: string, endereco: string, token: string): Promise<Buffer> {
  const link = `https://${config.hostname}/redefinir?token=${token}`;

  const texto = [
    `Recebemos um pedido para redefinir a senha da caixa ${endereco}.`,
    "",
    "Abra o endereco abaixo para criar uma senha nova:",
    link,
    "",
    `O link vale por ${VALIDADE_MINUTOS} minutos e so pode ser usado uma vez.`,
    "",
    "Se nao foi voce que pediu, ignore esta mensagem: a senha atual continua valendo.",
    "",
    "Avila Ops Tecnologia",
  ].join("\r\n");

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;color:#1a1a1a;line-height:1.6;">
<p>Recebemos um pedido para redefinir a senha da caixa <strong>${endereco}</strong>.</p>
<p style="margin:24px 0;">
  <a href="${link}" style="display:inline-block;padding:12px 24px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px;">Criar senha nova</a>
</p>
<p style="font-size:14px;color:#666;">O link vale por ${VALIDADE_MINUTOS} minutos e so pode ser usado uma vez.</p>
<p style="font-size:14px;color:#666;">Se nao foi voce que pediu, ignore esta mensagem: a senha atual continua valendo.</p>
<p style="margin-top:24px;font-size:13px;color:#666;">Avila Ops Tecnologia</p>
</div>`;

  const composer = new MailComposer({
    from: { name: "Avila Ops", address: `naoresponda@${ROOT_ZONE}` },
    to: destino,
    subject: "Redefinicao de senha da sua caixa de e-mail",
    text: texto,
    html,
    messageId: `<${randomUUID()}@${ROOT_ZONE}>`,
    date: new Date(),
    textEncoding: "quoted-printable",
  });

  return composer.compile().build();
}

/**
 * Validade do link de primeiro acesso. Bem maior que a da redefinicao: quem
 * comprou no fim da tarde so abre o e-mail no dia seguinte, e link vencido na
 * primeira visita e cliente pagante batendo em porta fechada. Passado o prazo,
 * "Esqueci a senha" resolve sozinho, porque o e-mail de recuperacao ja esta
 * cadastrado.
 */
const VALIDADE_PRIMEIRO_ACESSO_HORAS = 72;

async function montarEmailDePrimeiroAcesso(input: {
  destino: string;
  endereco: string;
  token: string;
  assunto: string;
}): Promise<Buffer> {
  const { destino, endereco, token, assunto } = input;
  const link = `https://${config.hostname}/redefinir?token=${token}`;
  const recuperar = `https://${config.hostname}/recuperar`;

  const texto = [
    `O pagamento foi confirmado e a caixa ${endereco} esta pronta.`,
    "",
    "Abra o endereco abaixo para criar a sua senha:",
    link,
    "",
    `O link vale por ${VALIDADE_PRIMEIRO_ACESSO_HORAS} horas e so pode ser usado uma vez.`,
    `Se ele vencer, peca outro em ${recuperar} informando ${endereco}.`,
    "",
    "Depois de criar a senha:",
    `  Webmail: https://${config.hostname}`,
    `  Celular e Outlook: https://${config.hostname}/configurar`,
    "",
    "Avila Ops Tecnologia",
  ].join("\r\n");

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;color:#1a1a1a;line-height:1.6;">
<p style="font-size:18px;margin:0 0 4px;">Sua caixa <strong>${endereco}</strong> esta pronta.</p>
<p style="margin:0;color:#666;">O pagamento foi confirmado. Falta so voce criar a sua senha.</p>
<p style="margin:24px 0;">
  <a href="${link}" style="display:inline-block;padding:12px 24px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px;">Criar minha senha</a>
</p>
<p style="font-size:14px;color:#666;">O link vale por ${VALIDADE_PRIMEIRO_ACESSO_HORAS} horas e so pode ser usado uma vez. Se ele vencer, peca outro em <a href="${recuperar}">${config.hostname}/recuperar</a> informando ${endereco}.</p>
<p style="font-size:14px;color:#666;">Depois de criar a senha, o passo a passo para celular e Outlook esta em <a href="https://${config.hostname}/configurar">${config.hostname}/configurar</a>.</p>
<p style="margin-top:24px;font-size:13px;color:#666;">Avila Ops Tecnologia</p>
</div>`;

  const composer = new MailComposer({
    from: { name: "Avila Ops", address: `naoresponda@${ROOT_ZONE}` },
    to: destino,
    subject: assunto,
    text: texto,
    html,
    messageId: `<${randomUUID()}@${ROOT_ZONE}>`,
    date: new Date(),
    textEncoding: "quoted-printable",
  });

  return composer.compile().build();
}

/**
 * Manda o link para o dono criar a senha da caixa que acabou de comprar.
 *
 * E a entrega da caixa no autoatendimento. A senha nao viaja por e-mail em
 * lugar nenhum da casa (ver `welcome.ts`), entao quem compra sozinho recebe um
 * link de uso unico e escolhe a propria senha — a que criamos no
 * provisionamento nunca e mostrada a ninguem.
 *
 * Diferente de `requestPasswordReset`, esta funcao LANCA: e chamada pelo
 * provisionamento, e pedido pago sem link entregue e pedido que falhou.
 */
export async function enviarLinkDePrimeiroAcesso(mailboxId: string): Promise<{ sentTo: string }> {
  const mailbox = await prisma.mailbox.findUnique({
    where: { id: mailboxId },
    select: { localPart: true, recoveryEmail: true, domain: { select: { name: true } } },
  });
  if (!mailbox) throw new AuthError("Caixa nao encontrada para o primeiro acesso.", 404);
  if (!mailbox.recoveryEmail) {
    throw new AuthError("Caixa sem e-mail de contato: nao ha para onde mandar o primeiro acesso.", 422);
  }

  const endereco = `${mailbox.localPart}@${mailbox.domain.name}`;
  const token = randomBytes(32).toString("base64url");

  await prisma.passwordResetToken.updateMany({
    where: { mailboxId, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.passwordResetToken.create({
    data: {
      mailboxId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + VALIDADE_PRIMEIRO_ACESSO_HORAS * 3_600_000),
    },
  });

  const assunto = `Sua caixa ${endereco} esta pronta: crie a sua senha`;

  await enqueueOutbound({
    envelopeFrom: `naoresponda@${ROOT_ZONE}`,
    recipients: [mailbox.recoveryEmail],
    raw: await montarEmailDePrimeiroAcesso({ destino: mailbox.recoveryEmail, endereco, token, assunto }),
    subject: assunto,
    sign: true,
  });

  await prisma.mailEvent.create({
    data: {
      mailboxId,
      type: "password.first_access_sent",
      payload: { sentTo: mascarar(mailbox.recoveryEmail) },
    },
  });

  log.info("link de primeiro acesso enviado", { mailboxId });

  return { sentTo: mascarar(mailbox.recoveryEmail) };
}

export interface RequestResetResult {
  /** Sempre true. O detalhe real fica so no log. */
  accepted: true;
  /** Preenchido so quando ha e-mail de recuperacao, para o painel dar retorno util. */
  sentTo: string | null;
}

/**
 * Pede a redefinicao.
 *
 * A resposta e IGUAL em todos os casos — caixa inexistente, caixa sem e-mail de
 * recuperacao, caixa suspensa. Diferenciar aqui entregaria de bandeja quais
 * enderecos existem, que e justamente o que o login se esforca para esconder.
 */
export async function requestPasswordReset(input: {
  address: string;
  ip?: string;
}): Promise<RequestResetResult> {
  const parsed = parseAddress(input.address);
  const resposta: RequestResetResult = { accepted: true, sentTo: null };

  if (!parsed) {
    await burnPasswordTime(input.address);
    return resposta;
  }

  const identificador = `reset:${parsed.full}`;
  const janela = janelaAtual();

  const contador = await prisma.loginAttempt.upsert({
    where: { identifier_windowStart: { identifier: identificador, windowStart: janela } },
    create: { identifier: identificador, windowStart: janela, failures: 1 },
    update: { failures: { increment: 1 } },
    select: { failures: true },
  });

  // Sem teto, o pedido de redefinicao vira ferramenta de flood na caixa
  // pessoal do cliente — e o remetente somos nos.
  if (contador.failures > MAX_PEDIDOS_POR_JANELA) {
    log.warn("pedido de redefinicao bloqueado por excesso", { address: parsed.full, ip: input.ip });
    return resposta;
  }

  const mailbox = await prisma.mailbox.findFirst({
    where: { localPart: parsed.localPart, domain: { name: parsed.domain } },
    select: { id: true, status: true, recoveryEmail: true },
  });

  if (!mailbox || !mailbox.recoveryEmail || mailbox.status === "disabled") {
    await burnPasswordTime(input.address);
    log.info("pedido de redefinicao sem destino valido", {
      address: parsed.full,
      motivo: !mailbox ? "caixa inexistente" : !mailbox.recoveryEmail ? "sem e-mail de recuperacao" : "caixa desativada",
    });
    return resposta;
  }

  const token = randomBytes(32).toString("base64url");

  // Pedido novo invalida os anteriores: dois links vivos ao mesmo tempo
  // dobram a janela de exposicao sem beneficio nenhum.
  await prisma.passwordResetToken.updateMany({
    where: { mailboxId: mailbox.id, usedAt: null },
    data: { usedAt: new Date() },
  });

  await prisma.passwordResetToken.create({
    data: {
      mailboxId: mailbox.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + VALIDADE_MINUTOS * 60_000),
    },
  });

  const raw = await montarEmail(mailbox.recoveryEmail, parsed.full, token);

  await enqueueOutbound({
    envelopeFrom: `naoresponda@${ROOT_ZONE}`,
    recipients: [mailbox.recoveryEmail],
    raw,
    subject: "Redefinicao de senha da sua caixa de e-mail",
    sign: true,
  });

  await prisma.mailEvent.create({
    data: {
      mailboxId: mailbox.id,
      type: "password.reset_requested",
      payload: { ip: input.ip ?? null, sentTo: mascarar(mailbox.recoveryEmail) },
    },
  });

  log.info("link de redefinicao enviado", { mailboxId: mailbox.id, ip: input.ip });

  resposta.sentTo = mascarar(mailbox.recoveryEmail);
  return resposta;
}

export async function resetPassword(input: { token: string; newPassword: string }): Promise<{ address: string }> {
  if (input.newPassword.length < 12) {
    throw new AuthError("A nova senha precisa ter no minimo 12 caracteres.", 422);
  }

  const registro = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(input.token) },
    select: {
      id: true,
      mailboxId: true,
      usedAt: true,
      expiresAt: true,
      mailbox: { select: { localPart: true, domain: { select: { name: true } } } },
    },
  });

  // Mesma mensagem para token inexistente, usado e vencido: distinguir daria
  // ao atacante um oraculo para saber quando chegou perto de um token valido.
  if (!registro || registro.usedAt || registro.expiresAt <= new Date()) {
    throw new AuthError("Link invalido ou expirado. Peca um novo.", 400);
  }

  await prisma.$transaction([
    prisma.passwordResetToken.update({ where: { id: registro.id }, data: { usedAt: new Date() } }),
    prisma.mailbox.update({
      where: { id: registro.mailboxId },
      data: { passwordHash: await hashPassword(input.newPassword) },
    }),
  ]);

  // Se a senha foi redefinida porque vazou, sessao antiga viva anula a troca.
  await logoutAll(registro.mailboxId);

  await prisma.mailEvent.create({
    data: { mailboxId: registro.mailboxId, type: "password.reset_completed", payload: {} },
  });

  const address = `${registro.mailbox.localPart}@${registro.mailbox.domain.name}`;
  log.info("senha redefinida por link de recuperacao", { mailboxId: registro.mailboxId });

  return { address };
}

/** Limpeza de tokens vencidos, junto com a manutencao das sessoes. */
export async function cleanupExpiredTokens(): Promise<{ removed: number }> {
  const resultado = await prisma.passwordResetToken.deleteMany({
    where: { OR: [{ expiresAt: { lt: new Date() } }, { usedAt: { not: null } }] },
  });
  return { removed: resultado.count };
}
