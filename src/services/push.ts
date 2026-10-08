import webpush from "web-push";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";

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
): Promise<{ ok: true }> {
  await prisma.mailPushSubscription.upsert({
    where: { endpoint: inscricao.endpoint },
    create: {
      mailboxId,
      endpoint: inscricao.endpoint,
      p256dh: inscricao.keys.p256dh,
      auth: inscricao.keys.auth,
      userAgent: userAgent?.slice(0, 300) ?? null,
    },
    update: {
      // Endereco reaproveitado por outra caixa (mesmo navegador, outro login)
      // passa a pertencer a quem acabou de autorizar.
      mailboxId,
      p256dh: inscricao.keys.p256dh,
      auth: inscricao.keys.auth,
      userAgent: userAgent?.slice(0, 300) ?? null,
    },
  });
  return { ok: true };
}

export async function removerInscricao(mailboxId: string, endpoint: string): Promise<{ ok: true }> {
  await prisma.mailPushSubscription.deleteMany({ where: { mailboxId, endpoint } });
  return { ok: true };
}

export async function listarInscricoes(mailboxId: string) {
  return prisma.mailPushSubscription.findMany({
    where: { mailboxId },
    orderBy: { createdAt: "desc" },
    select: { id: true, endpoint: true, userAgent: true, lastSentAt: true, createdAt: true },
  });
}

export interface AvisoPush {
  titulo: string;
  corpo: string;
  messageId?: string;
  /**
   * "seguranca" ignora as preferencias do cliente: conta invadida as 3h da
   * manha nao pode esperar o fim do silencio noturno. "mensagem" respeita.
   */
  tipo?: "mensagem" | "seguranca";
  /** Caiu na Entrada? Regra que arquivou a mensagem nao precisa interromper. */
  naEntrada?: boolean;
}

/** Hora atual no fuso da operacao — e nele que o cliente pensou o silencio. */
function horaLocal(): number {
  const formatada = new Intl.DateTimeFormat("pt-BR", {
    timeZone: config.timezone,
    hour: "numeric",
    hour12: false,
  }).format(new Date());
  return Number.parseInt(formatada, 10);
}

/** Janela que cruza a meia-noite (22h -> 7h) e o caso normal, nao a excecao. */
function dentroDoSilencio(inicio: number | null, fim: number | null): boolean {
  if (inicio === null || fim === null || inicio === fim) return false;
  const hora = horaLocal();
  return inicio < fim ? hora >= inicio && hora < fim : hora >= inicio || hora < fim;
}

/**
 * Decide se o aviso sai, olhando as preferencias da caixa.
 *
 * Aviso que chega na hora errada e pior que aviso nenhum: a pessoa desliga a
 * permissao e perde tambem os alertas de seguranca, que sao os que importam.
 */
async function permitido(mailboxId: string, aviso: AvisoPush): Promise<boolean> {
  if (aviso.tipo === "seguranca") return true;

  const prefs = await prisma.mailboxSettings.findUnique({
    where: { mailboxId },
    select: { notifyEnabled: true, notifyQuietStart: true, notifyQuietEnd: true, notifyOnlyInbox: true },
  });
  if (!prefs) return true;

  if (!prefs.notifyEnabled) return false;
  if (prefs.notifyOnlyInbox && aviso.naEntrada === false) return false;
  if (dentroDoSilencio(prefs.notifyQuietStart, prefs.notifyQuietEnd)) return false;
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
export async function enviarAviso(mailboxId: string, aviso: AvisoPush): Promise<void> {
  if (!pushDisponivel()) return;
  if (!(await permitido(mailboxId, aviso))) return;
  garantirConfiguracao();

  const inscricoes = await prisma.mailPushSubscription.findMany({
    where: { mailboxId },
    select: { id: true, endpoint: true, p256dh: true, auth: true },
  });
  if (inscricoes.length === 0) return;

  const conteudo = JSON.stringify(aviso);

  await Promise.all(
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
      } catch (erro) {
        const status = (erro as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          await prisma.mailPushSubscription.delete({ where: { id: inscricao.id } }).catch(() => undefined);
          log.info("inscricao de push expirada, removida", { mailboxId, status });
          return;
        }
        log.warn("falha ao enviar push", {
          mailboxId,
          status,
          erro: erro instanceof Error ? erro.message : String(erro),
        });
      }
    }),
  );
}
