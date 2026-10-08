import { randomUUID } from "node:crypto";
import { wakeSnoozed } from "../services/messages.js";
import { resolveMx } from "node:dns/promises";
import nodemailer, { type Transporter } from "nodemailer";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { readRaw, storeRaw } from "../lib/storage.js";
import { parseAddress } from "../lib/address.js";
import { deliverToMailbox, resolveRecipient, type RecipientResolution } from "./deliver-local.js";
import { signMessage } from "./dkim.js";
import { orcamentoDeHoje, proximaJanelaUtc, type OrcamentoWarmup } from "./warmup.js";

const log = createLogger("queue");

/**
 * Fila de saida.
 *
 * Toda mensagem que sai passa por aqui — submission do cliente, encaminhamento
 * de alias e notificacao do sistema. Persistir antes de tentar entregar e o
 * que garante que nada se perde se o processo morrer no meio.
 *
 * O driver de entrega e plugavel porque a saida muda de forma ao longo do
 * projeto: hoje relay (porta 25 bloqueada pela Hetzner), amanha entrega direta.
 * Trocar o caminho de saida nao pode significar reescrever a fila.
 */

export interface EnqueueInput {
  mailboxId?: string;
  envelopeFrom: string;
  recipients: string[];
  raw: Buffer;
  subject?: string;
  /** Assina com DKIM antes de enfileirar. Falso para encaminhamento. */
  sign?: boolean;
  /**
   * Segura a mensagem na fila por N segundos antes da primeira tentativa.
   * Serve ao desfazer envio: a mensagem existe, mas o worker so a enxerga
   * quando o prazo vence, porque ele busca por nextAttemptAt <= agora.
   */
  delaySeconds?: number;
}

/**
 * Quantos destinatarios sao de fora dos nossos dominios. Decidido no
 * enfileiramento (o conjunto de dominios hospedados quase nao muda) para o
 * aquecimento de IP nao ter que abrir o JSON de cada linha a cada ciclo.
 * Endereco que nao parseia conta como externo — na duvida, gasta orcamento.
 */
async function contarExternos(recipients: string[]): Promise<number> {
  const dominios = [...new Set(recipients.map((r) => parseAddress(r)?.domain).filter((d): d is string => !!d))];
  if (dominios.length === 0) return recipients.length;

  const locais = new Set(
    (await prisma.mailDomain.findMany({ where: { name: { in: dominios } }, select: { name: true } }))
      .map((dominio) => dominio.name),
  );

  return recipients.filter((r) => !locais.has(parseAddress(r)?.domain ?? "")).length;
}

export async function enqueueOutbound(input: EnqueueInput): Promise<{ id: string }> {
  const sender = parseAddress(input.envelopeFrom);
  const raw = input.sign !== false && sender ? await signMessage(sender.domain, input.raw) : input.raw;

  const id = randomUUID();
  const blob = await storeRaw(`out-${id}`, raw);

  const queued = await prisma.outboundMessage.create({
    data: {
      mailboxId: input.mailboxId ?? null,
      envelopeFrom: input.envelopeFrom,
      recipients: input.recipients,
      subject: input.subject ?? null,
      storageKey: blob.storageKey,
      sizeBytes: blob.sizeBytes,
      status: "queued",
      nextAttemptAt: new Date(Date.now() + Math.max(0, input.delaySeconds ?? 0) * 1000),
      externalRecipients: await contarExternos(input.recipients),
    },
    select: { id: true },
  });

  log.info("mensagem enfileirada", {
    outboundId: queued.id,
    envelopeFrom: input.envelopeFrom,
    recipients: input.recipients.length,
    sizeBytes: blob.sizeBytes,
  });

  return queued;
}

/**
 * Encaminhamento de alias.
 *
 * O envelope-from vira vazio (<>) de proposito: encaminhamento quebra SPF do
 * remetente original, e um bounce so pode voltar para quem realmente enviou.
 * Envelope nulo e a convencao do RFC 5321 para nao gerar loop de bounce.
 */
export async function enqueueForward(input: {
  originalRecipient: string;
  destination: string;
  raw: Buffer;
  mailFrom: string;
}): Promise<void> {
  await enqueueOutbound({
    envelopeFrom: "",
    recipients: [input.destination],
    raw: input.raw,
    subject: `encaminhado de ${input.originalRecipient}`,
    sign: false,
  });
}

// --------------------------------------------------------------------------
// Drivers de entrega
// --------------------------------------------------------------------------

let relayTransport: Transporter | null = null;

function smtpRelayTransport(): Transporter {
  if (relayTransport) return relayTransport;
  relayTransport = nodemailer.createTransport({
    host: config.relay.smtp.host,
    port: config.relay.smtp.port,
    secure: config.relay.smtp.port === 465,
    auth: config.relay.smtp.user ? { user: config.relay.smtp.user, pass: config.relay.smtp.pass } : undefined,
    pool: true,
    maxConnections: 3,
  });
  return relayTransport;
}

async function deliverViaSmtpRelay(envelopeFrom: string, recipients: string[], raw: Buffer): Promise<void> {
  await smtpRelayTransport().sendMail({
    envelope: { from: envelopeFrom, to: recipients },
    raw,
  });
}

/**
 * Ponte pelo n8n: o workflow "Avila Ops - Relay de Saida" recebe a mensagem
 * ja pronta e usa a credencial SMTP que vive la. Util para trocar de provedor
 * de envio sem tocar no servidor, e como rota de contingencia.
 */
async function deliverViaN8n(envelopeFrom: string, recipients: string[], raw: Buffer): Promise<void> {
  const response = await fetch(config.relay.n8n.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.relay.n8n.token}`,
    },
    body: JSON.stringify({
      envelopeFrom,
      recipients,
      rawBase64: raw.toString("base64"),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`relay n8n respondeu ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
}

/**
 * Entrega direta MX-a-MX. So funciona depois que a Hetzner liberar a porta 25
 * de saida; ate la o driver existe mas nao e o selecionado.
 */
async function deliverDirect(envelopeFrom: string, recipients: string[], raw: Buffer): Promise<void> {
  const byDomain = new Map<string, string[]>();
  for (const recipient of recipients) {
    const parsed = parseAddress(recipient);
    if (!parsed) throw new Error(`destinatario invalido na fila: ${recipient}`);
    byDomain.set(parsed.domain, [...(byDomain.get(parsed.domain) ?? []), parsed.full]);
  }

  for (const [domain, targets] of byDomain) {
    const records = await resolveMx(domain);
    if (records.length === 0) throw new Error(`dominio ${domain} sem registro MX`);

    // Ordem de preferencia do proprio dominio. O segundo MX existe justamente
    // para quando o primeiro esta fora — tentar so o melhor e desistir de uma
    // entrega que teria funcionado.
    const ordenados = records.sort((a, b) => a.priority - b.priority);

    let ultimoErro: unknown = null;
    let entregue = false;

    for (const mx of ordenados) {
      const transport = nodemailer.createTransport({
        host: mx.exchange,
        port: 25,
        secure: false,
        ignoreTLS: false,
        name: config.hostname,
        connectionTimeout: 20_000,
        /**
         * TLS oportunista, como manda o RFC 7435 — e como o Postfix opera por
         * padrao (`smtp_tls_security_level = may`).
         *
         * Entre servidores de e-mail nao existe autoridade certificadora
         * comum: certificado autoassinado, vencido ou com nome trocado e o
         * normal, nao a excecao. Validar com rigor aqui significa recusar a
         * conversa e nao entregar — foi o que aconteceu no primeiro teste real,
         * com um destinatario de certificado vencido.
         *
         * A alternativa (nao usar TLS) seria pior: cifrar sem validar protege
         * contra quem apenas escuta a rede, que e a ameaca realista aqui.
         */
        tls: { rejectUnauthorized: false },
      });

      try {
        await transport.sendMail({ envelope: { from: envelopeFrom, to: targets }, raw });
        entregue = true;
        break;
      } catch (erro) {
        ultimoErro = erro;

        // 5xx e recusa definitiva DESTE destinatario: o proximo MX do mesmo
        // dominio vai responder igual. Insistir so gasta reputacao.
        const codigo = (erro as { responseCode?: number }).responseCode;
        if (typeof codigo === "number" && codigo >= 500) throw erro;

        log.warn("MX recusou; tentando o proximo", {
          domain,
          mx: mx.exchange,
          error: erro instanceof Error ? erro.message : String(erro),
        });
      } finally {
        transport.close();
      }
    }

    if (!entregue) throw ultimoErro ?? new Error(`nenhum MX de ${domain} aceitou a mensagem`);
  }
}

async function deliver(envelopeFrom: string, recipients: string[], raw: Buffer): Promise<void> {
  switch (config.relay.driver) {
    case "smtp":
      return deliverViaSmtpRelay(envelopeFrom, recipients, raw);
    case "n8n":
      return deliverViaN8n(envelopeFrom, recipients, raw);
    case "direct":
      return deliverDirect(envelopeFrom, recipients, raw);
  }
}

// --------------------------------------------------------------------------
// Worker
// --------------------------------------------------------------------------

/** Backoff em minutos por tentativa. Depois da lista, repete o ultimo valor. */
const BACKOFF_MINUTES = [1, 5, 15, 30, 60, 120, 240, 480, 720, 1440];

/**
 * Tentativa em que sai o aviso de atraso.
 *
 * Na quinta tentativa ja se passou cerca de uma hora — tempo suficiente para o
 * problema ser real e nao um soluco de rede, e cedo o bastante para o cliente
 * ainda conseguir avisar o destinatario por outro caminho.
 */
const AVISO_DE_ATRASO_NA_TENTATIVA = 5;

function nextAttemptAt(attempts: number): Date {
  const minutes = BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)] ?? 1440;
  return new Date(Date.now() + minutes * 60_000);
}

/**
 * Erro 5xx do servidor remoto e permanente (caixa inexistente, dominio errado):
 * insistir so queima reputacao. 4xx e temporario e merece retentativa.
 */
function isPermanent(error: unknown): boolean {
  const code = (error as { responseCode?: number } | null)?.responseCode;
  return typeof code === "number" && code >= 500 && code < 600;
}

/**
 * Separa quem mora aqui de quem mora fora.
 *
 * Uma caixa nossa escrevendo para outra caixa nossa nao tem por que sair para a
 * internet: o servidor e o destino. Sair custava caro de verdade enquanto o MX
 * do dominio ainda aponta para o provedor antigo — a mensagem dava a volta,
 * chegava la e voltava recusada, porque o SPF de la ainda nao conhecia a gente.
 * Foi o que aconteceu com o vedashow em 09/09/2026: as quatro caixas nao
 * conseguiam se falar, com tudo do nosso lado certo.
 *
 * Entrega local tambem e mais rapida e nao gasta reputacao de IP.
 */
async function separarPorDestino(recipients: string[]) {
  const locais: { endereco: string; alvo: Extract<RecipientResolution, { kind: "mailbox" }> }[] = [];
  const remotos: string[] = [];

  for (const endereco of recipients) {
    const resolucao = await resolveRecipient(endereco);
    if (resolucao.kind === "mailbox") locais.push({ endereco, alvo: resolucao });
    else remotos.push(endereco);
  }

  return { locais, remotos };
}

async function processOne(row: { id: string; envelopeFrom: string; recipients: unknown; storageKey: string; attempts: number }): Promise<void> {
  const recipients = Array.isArray(row.recipients) ? (row.recipients as string[]) : [];

  try {
    const raw = await readRaw(row.storageKey);
    const { locais, remotos } = await separarPorDestino(recipients);

    for (const { endereco, alvo } of locais) {
      const resultado = await deliverToMailbox(alvo, raw, null, { envelopeFrom: row.envelopeFrom });
      if (resultado.status === "rejected") {
        // Recusa de caixa nossa e definitiva: insistir nao muda nada.
        throw Object.assign(new Error(`${endereco}: ${resultado.reason}`), { responseCode: 550 });
      }
      log.info("entrega local", { outboundId: row.id, para: endereco });
    }

    if (remotos.length > 0) await deliver(row.envelopeFrom, remotos, raw);

    await prisma.outboundMessage.update({
      where: { id: row.id },
      data: { status: "sent", sentAt: new Date(), relayDriver: config.relay.driver, lastError: null },
    });

    log.info("mensagem entregue", { outboundId: row.id, driver: config.relay.driver, recipients: recipients.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const attempts = row.attempts + 1;
    const permanent = isPermanent(error) || attempts >= config.limits.maxDeliveryAttempts;

    await prisma.outboundMessage.update({
      where: { id: row.id },
      data: {
        status: permanent ? "failed" : "deferred",
        attempts,
        lastError: message.slice(0, 2000),
        relayDriver: config.relay.driver,
        nextAttemptAt: nextAttemptAt(attempts),
      },
    });

    await prisma.mailEvent.create({
      data: {
        type: permanent ? "outbound.failed" : "outbound.deferred",
        severity: permanent ? "error" : "warn",
        payload: { outboundId: row.id, attempts, recipients, error: message.slice(0, 500) },
      },
    });

    log[permanent ? "error" : "warn"]("falha na entrega", { outboundId: row.id, attempts, permanent, error: message });

    /**
     * Avisa o remetente.
     *
     * Duas ocasioes: quando desistimos de vez, e uma unica vez no meio do
     * caminho, para quem esta esperando resposta ha horas nao ficar no escuro.
     * O `bouncedAt` garante o "uma unica vez" — sem ele, cada nova tentativa
     * geraria outro aviso e o cliente receberia o mesmo alerta a cada hora.
     */
    const avisarAtraso = !permanent && attempts === AVISO_DE_ATRASO_NA_TENTATIVA;
    if (permanent || avisarAtraso) {
      const jaAvisado = await prisma.outboundMessage.findUnique({
        where: { id: row.id },
        select: { bouncedAt: true, subject: true },
      });

      if (permanent || !jaAvisado?.bouncedAt) {
        try {
          const { avisarRemetente } = await import("../services/bounce.js");
          const destino = await avisarRemetente({
            outboundId: row.id,
            envelopeFrom: row.envelopeFrom,
            destinatarios: recipients,
            erro: message,
            storageKey: row.storageKey,
            assunto: jaAvisado?.subject ?? null,
            definitivo: permanent,
          });

          if (destino !== "ignorado") {
            await prisma.outboundMessage.update({
              where: { id: row.id },
              data: { bouncedAt: new Date() },
            });
          }
        } catch (falha) {
          // Falhar ao avisar nao pode derrubar o worker: a mensagem ja esta
          // marcada como failed, e o evento acima guarda o motivo.
          log.error("nao consegui avisar o remetente", {
            outboundId: row.id,
            error: falha instanceof Error ? falha.message : String(falha),
          });
        }
      }
    }
  }
}

/**
 * Worker de fila. Poll simples a cada 10s — o volume da Fase 1 (dezenas de
 * caixas) nao justifica broker; a coluna nextAttemptAt ja e a agenda.
 */
export function startQueueWorker(intervalMs = 10_000): () => void {
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;

    // Mensagem adiada volta antes da fila de saida ser trabalhada: sao coisas
    // independentes, e falha de uma nao pode impedir a outra.
    try {
      const devolvidas = await wakeSnoozed();
      if (devolvidas > 0) log.info("mensagens adiadas voltaram para a Entrada", { devolvidas });
    } catch (falha) {
      log.error("falha ao devolver mensagens adiadas", {
        error: falha instanceof Error ? falha.message : String(falha),
      });
    }

    try {
      const due = await prisma.outboundMessage.findMany({
        where: { status: { in: ["queued", "deferred"] }, nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: "asc" },
        take: 20,
        select: {
          id: true,
          envelopeFrom: true,
          recipients: true,
          storageKey: true,
          attempts: true,
          externalRecipients: true,
        },
      });

      // Lido do banco a cada ciclo (nao cacheado): o que falhou num ciclo
      // anterior nao consumiu o teto, e a virada do dia UTC devolve tudo.
      let orcamento: OrcamentoWarmup | null = due.length > 0 ? await orcamentoDeHoje() : null;
      let adiadasPeloAquecimento = 0;

      for (const row of due) {
        /**
         * Teto do aquecimento de IP. Mensagem que nao cabe no orcamento de
         * hoje volta para a fila com hora marcada na virada do dia UTC — sem
         * consumir tentativa e sem virar bounce, porque nao houve falha:
         * fomos nos que seguramos. Mensagem interna (externalRecipients = 0)
         * nunca espera. O laco continua porque uma mensagem menor logo atras
         * ainda pode caber no que sobrou.
         */
        if (orcamento && row.externalRecipients > orcamento.restante) {
          await prisma.outboundMessage.updateMany({
            where: { id: row.id, status: { in: ["queued", "deferred"] } },
            data: { nextAttemptAt: proximaJanelaUtc() },
          });
          adiadasPeloAquecimento += 1;
          continue;
        }

        // Marca antes de tentar: evita entrega duplicada se um segundo worker subir.
        const claimed = await prisma.outboundMessage.updateMany({
          where: { id: row.id, status: { in: ["queued", "deferred"] } },
          data: { status: "sending" },
        });
        if (claimed.count === 0) continue;

        await processOne(row);

        if (orcamento && row.externalRecipients > 0) {
          orcamento = { ...orcamento, restante: Math.max(0, orcamento.restante - row.externalRecipients) };
        }
      }

      if (adiadasPeloAquecimento > 0 && orcamento) {
        log.info("aquecimento de IP segurou mensagens para amanha", {
          adiadas: adiadasPeloAquecimento,
          dia: orcamento.dia,
          cap: orcamento.cap,
        });
        await prisma.mailEvent.create({
          data: {
            type: "outbound.warmup_deferred",
            severity: "info",
            payload: { adiadas: adiadasPeloAquecimento, dia: orcamento.dia, cap: orcamento.cap },
          },
        });
      }
    } catch (error) {
      log.error("erro no ciclo da fila", { error: error instanceof Error ? error.message : String(error) });
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
    relayTransport?.close();
  };
}
