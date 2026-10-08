import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { parseAddress } from "../lib/address.js";
import { burnPasswordTime, verifyPassword } from "../lib/password.js";
import { upgradeHashIfNeeded } from "./passwordUpgrade.js";

const log = createLogger("auth-caixa");

/**
 * Autenticacao de caixa para os protocolos de e-mail.
 *
 * SMTP submission, POP3 e IMAP autenticam a mesma coisa do mesmo jeito. Cada
 * um com sua copia significaria que endurecer a trava num deles deixa os
 * outros dois abertos — e o atacante escolhe por onde entrar.
 */

export interface CaixaAutenticada {
  id: string;
  domainId: string;
  address: string;
  displayName: string | null;
  sendLimitPerHour: number;
}

export type ResultadoAuth =
  | { ok: true; caixa: CaixaAutenticada }
  | { ok: false; motivo: "credencial" | "suspensa" | "bloqueada" };

const JANELA_MINUTOS = 15;

function inicioJanela(): Date {
  const tamanho = JANELA_MINUTOS * 60_000;
  return new Date(Math.floor(Date.now() / tamanho) * tamanho);
}

/**
 * Travas em camadas, iguais as do webmail.
 *
 * O limite por endereco e alto de proposito: se fosse igual ao do par
 * endereco+IP, qualquer um erraria a senha oito vezes e deixaria a caixa do
 * cliente fora do ar.
 */
function travas(address: string, ip: string): Array<{ id: string; limite: number }> {
  return [
    { id: `addr:${address}`, limite: 40 },
    { id: `pair:${address}|${ip}`, limite: 8 },
    { id: `ip:${ip}`, limite: 24 },
  ];
}

async function bloqueado(lista: ReturnType<typeof travas>): Promise<boolean> {
  const registros = await prisma.loginAttempt.findMany({
    where: { identifier: { in: lista.map((t) => t.id) }, windowStart: inicioJanela() },
    select: { identifier: true, failures: true },
  });

  const falhas = new Map(registros.map((r) => [r.identifier, r.failures]));
  return lista.some((t) => (falhas.get(t.id) ?? 0) >= t.limite);
}

async function registrarFalha(lista: ReturnType<typeof travas>): Promise<void> {
  const janela = inicioJanela();
  await Promise.all(
    lista.map((t) =>
      prisma.loginAttempt.upsert({
        where: { identifier_windowStart: { identifier: t.id, windowStart: janela } },
        create: { identifier: t.id, windowStart: janela, failures: 1 },
        update: { failures: { increment: 1 } },
      }),
    ),
  );
}

/**
 * Confere endereco e senha.
 *
 * O bcrypt roda mesmo quando a caixa nao existe: sem isso, "caixa inexistente"
 * responde em milissegundos e "senha errada" em ~250 ms, e cronometrar as
 * respostas revela quais enderecos existem — anulando a mensagem de erro unica.
 */
export async function autenticarCaixa(
  usuario: string,
  senha: string,
  ip: string,
  protocolo: string,
): Promise<ResultadoAuth> {
  const parsed = parseAddress(usuario);
  if (!parsed || !senha) {
    await burnPasswordTime(senha || "vazia");
    return { ok: false, motivo: "credencial" };
  }

  const lista = travas(parsed.full, ip);

  if (await bloqueado(lista)) {
    log.warn("autenticacao bloqueada por excesso de tentativas", { protocolo, address: parsed.full, ip });
    return { ok: false, motivo: "bloqueada" };
  }

  const mailbox = await prisma.mailbox
    .findFirst({
      where: { localPart: parsed.localPart, domain: { name: parsed.domain } },
      select: {
        id: true,
        domainId: true,
        localPart: true,
        displayName: true,
        passwordHash: true,
        status: true,
        sendLimitPerHour: true,
        domain: { select: { name: true } },
      },
    })
    .catch(() => null);

  const confere = mailbox
    ? await verifyPassword(senha, mailbox.passwordHash)
    : (await burnPasswordTime(senha), false);

  if (!mailbox || !confere) {
    await registrarFalha(lista);
    log.warn("autenticacao recusada", { protocolo, address: parsed.full, ip });
    return { ok: false, motivo: "credencial" };
  }

  upgradeHashIfNeeded(mailbox.id, senha, mailbox.passwordHash);

  if (mailbox.status !== "active") {
    return { ok: false, motivo: "suspensa" };
  }

  await prisma.loginAttempt.deleteMany({
    where: { identifier: { in: lista.map((t) => t.id) }, windowStart: inicioJanela() },
  });

  void prisma.mailbox
    .update({ where: { id: mailbox.id }, data: { lastLoginAt: new Date() } })
    .catch(() => undefined);

  return {
    ok: true,
    caixa: {
      id: mailbox.id,
      domainId: mailbox.domainId,
      address: `${mailbox.localPart}@${mailbox.domain.name}`,
      displayName: mailbox.displayName,
      sendLimitPerHour: mailbox.sendLimitPerHour,
    },
  };
}
