import webpush from "web-push";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { AuthError } from "./authError.js";
import type { Prisma } from "@prisma/client";

const log = createLogger("push");

/**
 * Aviso de mensagem nova com a aba fechada (Web Push, RFC 8030 + 8291).
 *
 * O navegador se inscreve num servico de push (Google, Mozilla, Apple) e nos
 * entrega um endpoint mais duas chaves. Ciframos o aviso com essas chaves e
 * mandamos para o endpoint: o servico de push entrega o pacote sem conseguir
 * ler o conteudo, e nos assinamos a requisicao com VAPID para o servico saber
 * de quem veio.
 *
 * Sem chaves VAPID configuradas o recurso simplesmente nao existe — nada
 * quebra, o webmail nao oferece o botao e a entrega segue igual.
 *
 * O que vai no aviso e deliberadamente magro: remetente e assunto. Quem
 * quiser ler abre a caixa. Corpo de e-mail em notificacao de tela bloqueada e
 * vazamento esperando acontecer.
 */

let configurado = false;

export function pushDisponivel(): boolean {
  return Boolean(config.push.publicKey && config.push.privateKey);
}

export function chavePublica(): string | null {
  return pushDisponivel() ? config.push.publicKey : null;
}

function garantirConfiguracao(): void {
  if (configurado || !pushDisponivel()) return;
  webpush.setVapidDetails(config.push.subject, config.push.publicKey, config.push.privateKey);
  configurado = true;
}

export interface Inscricao {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

async function sessaoDoAparelho(tx: Prisma.TransactionClient, mailboxId: string, sessionId: string) {
  const sessao = await tx.mailSession.findFirst({
    where: { id: sessionId, mailboxId, revokedAt: null, expiresAt: { gt: new Date() }, authSource: { not: "legacy" } },
    select: { id: true, familyId: true },
  });
  if (!sessao) throw new AuthError("Sessao do aparelho encerrada.");
  return sessao.familyId ?? sessao.id;
}

export async function avisosHabilitadosAqui(mailboxId: string, sessionId: string): Promise<boolean> {
  const sessao = await prisma.mailSession.findFirst({
    where: { id: sessionId, mailboxId, revokedAt: null, expiresAt: { gt: new Date() }, authSource: { not: "legacy" } },
    select: { id: true, familyId: true },
  });
  if (!sessao) return false;
  return Boolean((await prisma.mailSession.findUnique({ where: { id: sessao.familyId ?? sessao.id },
    select: { notificationsEnabled: true } }))?.notificationsEnabled);
}

export async function habilitarAvisosAqui(mailboxId: string, sessionId: string, enabled: boolean): Promise<{ ok: true }> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM mail_mailboxes WHERE id = ${mailboxId} FOR UPDATE`;
    const familyId = await sessaoDoAparelho(tx, mailboxId, sessionId);
    await tx.mailSession.update({ where: { id: familyId }, data: { notificationsEnabled: enabled } });
    if (!enabled) await tx.mailPushSubscription.deleteMany({ where: { mailboxId, familyId } });
  });
  return { ok: true };
}

/** Filtra inclusive expiracao, suspensao e transferencia de dono antes de enviar. */
async function familiasAtivas(mailboxId: string): Promise<string[]> {
  const caixa = await prisma.mailbox.findUnique({ where: { id: mailboxId },
    select: { status: true, ownerEmail: true, localPart: true, domain: { select: { name: true } } } });
  if (!caixa || caixa.status !== "active") return [];
  const emails = [caixa.ownerEmail, `${caixa.localPart}@${caixa.domain.name}`].filter((email): email is string => Boolean(email));
  const sessoes = await prisma.mailSession.findMany({
    where: { mailboxId, revokedAt: null, expiresAt: { gt: new Date() },
      OR: [{ authSource: "password" }, { authSource: "sso", ssoEmail: { in: emails } }] },
    select: { id: true, familyId: true },
  });
  const raizes = [...new Set(sessoes.map((sessao) => sessao.familyId ?? sessao.id))];
  return (await prisma.mailSession.findMany({ where: { id: { in: raizes }, notificationsEnabled: true }, select: { id: true } })).map((sessao) => sessao.id);
}

/**
 * Guarda (ou atualiza) a inscricao do navegador.
 *
 * O endpoint e a identidade da inscricao: reinscrever o mesmo navegador
 * atualiza a linha em vez de criar outra — sem isso, cada recarregamento da
 * pagina viraria mais um aviso duplicado no mesmo aparelho.
 */
export async function registrarInscricao(
  mailboxId: string,
  inscricao: Inscricao,
  userAgent?: string,
  sessionId?: string,
): Promise<{ ok: true }> {
  if (!sessionId) throw new AuthError("Entre no webmail para autorizar este aparelho.", 403);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM mail_mailboxes WHERE id = ${mailboxId} FOR UPDATE`;
    const familyId = await sessaoDoAparelho(tx, mailboxId, sessionId);
    await tx.mailSession.update({ where: { id: familyId }, data: { notificationsEnabled: true } });
    await tx.mailPushSubscription.upsert({
      where: { endpoint: inscricao.endpoint },
      create: {
        mailboxId,
        familyId,
        endpoint: inscricao.endpoint,
        p256dh: inscricao.keys.p256dh,
        auth: inscricao.keys.auth,
        userAgent: userAgent?.slice(0, 300) ?? null,
      },
      update: {
        // O mesmo navegador passa a pertencer a quem acabou de autorizar.
        mailboxId,
        familyId,
        p256dh: inscricao.keys.p256dh,
        auth: inscricao.keys.auth,
        userAgent: userAgent?.slice(0, 300) ?? null,
      },
    });
  });
  return { ok: true };
}

export async function removerInscricao(mailboxId: string, endpoint: string): Promise<{ ok: true }> {
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM mail_mailboxes WHERE id = ${mailboxId} FOR UPDATE`;
    const inscricao = await tx.mailPushSubscription.findFirst({ where: { mailboxId, endpoint } });
    if (inscricao?.familyId) await tx.mailSession.update({ where: { id: inscricao.familyId }, data: { notificationsEnabled: false } });
    await tx.mailPushSubscription.deleteMany({ where: { mailboxId, endpoint } });
  });
  return { ok: true };
}

export async function listarInscricoes(mailboxId: string, sessionId?: string) {
  const familiaAtual = sessionId ? await sessaoDoAparelho(prisma, mailboxId, sessionId) : null;
  const inscricoes = await prisma.mailPushSubscription.findMany({
    where: { mailboxId, familyId: { in: await familiasAtivas(mailboxId) } },
    orderBy: { createdAt: "desc" },
    select: { id: true, endpoint: true, familyId: true, userAgent: true, lastSentAt: true, createdAt: true },
  });
  return inscricoes.map(({ familyId, ...inscricao }) => ({ ...inscricao, nesteAparelho: familyId === familiaAtual }));
}

export interface AvisoPush {
  titulo: string;
  corpo: string;
  messageId?: string;
  url?: string;
  notificationTag?: string;
  /**
   * "seguranca" ignora as preferencias do cliente: conta invadida as 3h da
   * manha nao pode esperar o fim do silencio noturno. "mensagem" respeita.
   */
  tipo?: "mensagem" | "seguranca" | "calendario";
  /** Caiu na Entrada? Regra que arquivou a mensagem nao precisa interromper. */
  naEntrada?: boolean;
}

/** Hora atual no fuso da operacao — e nele que o cliente pensou o silencio. */
function horaLocal(agora = new Date()): number {
  const formatada = new Intl.DateTimeFormat("pt-BR", {
    timeZone: config.timezone,
    hour: "numeric",
    hour12: false,
  }).format(agora);
  return Number.parseInt(formatada, 10);
}

/** Janela que cruza a meia-noite (22h -> 7h) e o caso normal, nao a excecao. */
function dentroDoSilencio(inicio: number | null, fim: number | null, agora = new Date()): boolean {
  if (inicio === null || fim === null || inicio === fim) return false;
  const hora = horaLocal(agora);
  return inicio < fim ? hora >= inicio && hora < fim : hora >= inicio || hora < fim;
}

/**
 * Decide se o aviso sai, olhando as preferencias da caixa.
 *
 * Aviso que chega na hora errada e pior que aviso nenhum: a pessoa desliga a
 * permissao e perde tambem os alertas de seguranca, que sao os que importam.
 */
export async function avisoPermitido(mailboxId: string, aviso: AvisoPush, agora = new Date()): Promise<boolean> {
  if (aviso.tipo === "seguranca") return true;

  const prefs = await prisma.mailboxSettings.findUnique({
    where: { mailboxId },
    select: { notifyEnabled: true, notifyQuietStart: true, notifyQuietEnd: true, notifyOnlyInbox: true },
  });
  if (!prefs) return true;

  if (!prefs.notifyEnabled) return false;
  if (prefs.notifyOnlyInbox && aviso.naEntrada === false) return false;
  if (dentroDoSilencio(prefs.notifyQuietStart, prefs.notifyQuietEnd, agora)) return false;
  return true;
}

/**
 * Dispara o aviso para todos os aparelhos autorizados da caixa.
 *
 * Nunca lanca: e chamado no caminho da entrega, e nenhuma falha de push pode
 * impedir uma mensagem de ser gravada. Inscricao que o servico recusa como
 * inexistente (404) ou expirada (410) e apagada na hora — navegador
 * desinstalado nao vira fila de erro eterna.
 */
export async function enviarAviso(mailboxId: string, aviso: AvisoPush): Promise<{ tentativas: number; enviados: number }> {
  if (!pushDisponivel()) return { tentativas: 0, enviados: 0 };
  if (!(await avisoPermitido(mailboxId, aviso))) return { tentativas: 0, enviados: 0 };
  return enviarParaAparelhos(mailboxId, aviso);
}

/** Teste solicitado pelo usuario, somente para o aparelho desta sessao. */
export async function testarAviso(mailboxId: string, sessionId: string): Promise<{ tentativas: number; enviados: number }> {
  if (!pushDisponivel()) throw new AuthError("Aviso em segundo plano indisponivel no servidor.", 503);
  const familia = await sessaoDoAparelho(prisma, mailboxId, sessionId);
  return enviarParaAparelhos(mailboxId, { titulo: "Teste de aviso Ávila Mail", corpo: "O aviso deste aparelho está funcionando.", url: "/conta", notificationTag: "mail:teste" }, familia);
}

async function enviarParaAparelhos(mailboxId: string, aviso: AvisoPush, somenteFamilia?: string): Promise<{ tentativas: number; enviados: number }> {
  garantirConfiguracao();
  const familias = (await familiasAtivas(mailboxId)).filter((id) => !somenteFamilia || id === somenteFamilia);
  const inscricoes = await prisma.mailPushSubscription.findMany({
    where: { mailboxId, familyId: { in: familias } },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (inscricoes.length === 0) return { tentativas: 0, enviados: 0 };

  const conteudo = JSON.stringify(aviso);

  const resultados = await Promise.all(
    inscricoes.map(async (inscricao) => {
      try {
        await webpush.sendNotification(
          { endpoint: inscricao.endpoint, keys: { p256dh: inscricao.p256dh, auth: inscricao.auth } },
          conteudo,
          { TTL: 600, urgency: "high" },
        );
        await prisma.mailPushSubscription
          .update({ where: { id: inscricao.id }, data: { lastSentAt: new Date() } })
          .catch(() => undefined);
        return true;
      } catch (erro) {
        const status = (erro as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await prisma.mailPushSubscription.delete({ where: { id: inscricao.id } }).catch(() => undefined);
          log.info("inscricao de push expirada, removida", { mailboxId, status });
          return false;
        }
        log.warn("falha ao enviar push", {
          mailboxId,
          status,
          erro: erro instanceof Error ? erro.message : String(erro),
        });
        return false;
      }
    }),
  );
  return { tentativas: inscricoes.length, enviados: resultados.filter(Boolean).length };
}
