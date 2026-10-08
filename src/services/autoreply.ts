import { randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { ParsedMail } from "mailparser";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { parseAddress } from "../lib/address.js";
import { enqueueOutbound } from "../mta/queue.js";

const log = createLogger("autoreply");

/**
 * Resposta automatica de ausencia.
 *
 * O recurso e trivial de descrever e traicoeiro de implementar: duas caixas
 * com resposta automatica ligada, sem protecao, entram em pingue-pongue e
 * geram milhares de mensagens em minutos — o jeito mais rapido de queimar a
 * reputacao do IP e derrubar a entregabilidade de todos os outros clientes.
 *
 * Por isso a decisao aqui e sempre "no caso de duvida, NAO responder".
 */

/** Uma resposta por remetente a cada 4 dias. */
const INTERVALO_DIAS = 4;

export interface AutoReplyDecision {
  reply: boolean;
  reason: string;
}

/**
 * Decide se a mensagem merece resposta automatica.
 *
 * Cada regra corresponde a um convite de loop ou a um disparo indesejado:
 * responder a robo, a lista de discussao ou a bounce nao ajuda ninguem.
 */
export function shouldAutoReply(parsed: ParsedMail, envelopeFrom: string, ownAddress: string): AutoReplyDecision {
  const cabecalho = (nome: string): string => {
    const valor = parsed.headers.get(nome);
    if (typeof valor === "string") return valor.toLowerCase();
    if (valor && typeof valor === "object" && "value" in valor) {
      return String((valor as { value: unknown }).value).toLowerCase();
    }
    return "";
  };

  /**
   * Presenca do cabecalho, lida do `headerLines`.
   *
   * O `headers` do mailparser e normalizado: todos os `List-*` viram uma unica
   * chave "list", entao `headers.has("list-id")` devolve false mesmo com o
   * cabecalho presente. O `headerLines` guarda as chaves como vieram no fio,
   * que e o que interessa aqui.
   */
  const temCabecalho = (nome: string): boolean =>
    parsed.headers.has(nome) || parsed.headerLines.some((linha) => linha.key.toLowerCase() === nome);

  // Envelope vazio (<>) e a marca de bounce e de notificacao automatica.
  // Responder devolve o bounce para o nada e pode gerar loop no outro lado.
  if (!envelopeFrom || envelopeFrom.trim() === "") {
    return { reply: false, reason: "envelope nulo (bounce ou notificacao)" };
  }

  const remetente = parseAddress(envelopeFrom);
  if (!remetente) return { reply: false, reason: "remetente invalido" };

  if (remetente.full === ownAddress.toLowerCase()) {
    return { reply: false, reason: "mensagem da propria caixa" };
  }

  // RFC 3834: quem ja e automatico se declara aqui. Respeitar isso e o que
  // impede dois servidores de ficarem se cumprimentando para sempre.
  const autoSubmitted = cabecalho("auto-submitted");
  if (autoSubmitted && autoSubmitted !== "no") {
    return { reply: false, reason: `auto-submitted: ${autoSubmitted}` };
  }

  if (temCabecalho("x-auto-response-suppress")) {
    return { reply: false, reason: "remetente pediu supressao de auto-resposta" };
  }

  const precedence = cabecalho("precedence");
  if (["bulk", "list", "junk", "auto_reply"].includes(precedence)) {
    return { reply: false, reason: `precedence: ${precedence}` };
  }

  if (temCabecalho("list-id") || temCabecalho("list-unsubscribe") || temCabecalho("list-post")) {
    return { reply: false, reason: "mensagem de lista de discussao" };
  }

  if (temCabecalho("x-failed-recipients") || temCabecalho("x-autoreply") || temCabecalho("x-autorespond")) {
    return { reply: false, reason: "mensagem ja automatica" };
  }

  // Enderecos que por convencao nunca devem receber resposta.
  const locaisProibidos = ["mailer-daemon", "postmaster", "noreply", "no-reply", "naoresponda", "bounce", "bounces"];
  if (locaisProibidos.some((proibido) => remetente.localPart.startsWith(proibido))) {
    return { reply: false, reason: `remetente de sistema (${remetente.localPart})` };
  }

  return { reply: true, reason: "ok" };
}

/**
 * Envia a resposta automatica, se for o caso.
 *
 * Nunca lanca: a mensagem original ja foi entregue com sucesso, e falha aqui
 * nao pode transformar uma entrega boa em erro de SMTP.
 */
export async function maybeAutoReply(input: {
  mailboxId: string;
  parsed: ParsedMail;
  envelopeFrom: string;
}): Promise<{ sent: boolean; reason: string }> {
  try {
    const mailbox = await prisma.mailbox.findUnique({
      where: { id: input.mailboxId },
      select: {
        localPart: true,
        displayName: true,
        status: true,
        domain: { select: { name: true } },
        settings: {
          select: { autoReplyEnabled: true, autoReplySubject: true, autoReplyBody: true, autoReplyUntil: true },
        },
      },
    });

    if (!mailbox?.settings?.autoReplyEnabled) return { sent: false, reason: "resposta automatica desligada" };
    if (mailbox.status !== "active") return { sent: false, reason: "caixa inativa" };

    const { autoReplyUntil, autoReplyBody, autoReplySubject } = mailbox.settings;

    if (autoReplyUntil && autoReplyUntil <= new Date()) {
      // Data de volta passou: desliga sozinho, para o cliente que esqueceu nao
      // ficar avisando ausencia por meses.
      await prisma.mailboxSettings.update({
        where: { mailboxId: input.mailboxId },
        data: { autoReplyEnabled: false },
      });
      return { sent: false, reason: "periodo de ausencia encerrado" };
    }

    if (!autoReplyBody?.trim()) return { sent: false, reason: "sem mensagem configurada" };

    const ownAddress = `${mailbox.localPart}@${mailbox.domain.name}`;
    const decisao = shouldAutoReply(input.parsed, input.envelopeFrom, ownAddress);
    if (!decisao.reply) return { sent: false, reason: decisao.reason };

    const remetente = parseAddress(input.envelopeFrom);
    if (!remetente) return { sent: false, reason: "remetente invalido" };

    const desde = new Date(Date.now() - INTERVALO_DIAS * 86_400_000);
    const jaRespondido = await prisma.autoReplyLog.findUnique({
      where: { mailboxId_sender: { mailboxId: input.mailboxId, sender: remetente.full } },
      select: { sentAt: true },
    });

    if (jaRespondido && jaRespondido.sentAt > desde) {
      return { sent: false, reason: "ja respondido nos ultimos dias" };
    }

    const assuntoOriginal = input.parsed.subject ?? "";
    const assunto = autoReplySubject?.trim() || `Ausente: ${assuntoOriginal}`.trim();

    const composer = new MailComposer({
      from: mailbox.displayName ? { name: mailbox.displayName, address: ownAddress } : ownAddress,
      to: remetente.full,
      subject: assunto.slice(0, 200),
      text: autoReplyBody,
      messageId: `<${randomUUID()}@${mailbox.domain.name}>`,
      date: new Date(),
      inReplyTo: input.parsed.messageId ?? undefined,
      references: input.parsed.messageId ?? undefined,
      headers: {
        // Marca a saida como automatica para que o servidor do outro lado
        // aplique a mesma protecao e nao responda de volta.
        "Auto-Submitted": "auto-replied",
        "X-Auto-Response-Suppress": "All",
        Precedence: "auto_reply",
      },
      textEncoding: "quoted-printable",
    });

    const raw = await composer.compile().build();

    // Envelope nulo na saida: se a resposta automatica bater em caixa cheia,
    // o bounce nao volta para ca gerando uma segunda rodada.
    await enqueueOutbound({
      envelopeFrom: "",
      recipients: [remetente.full],
      raw,
      subject: assunto,
      sign: false,
    });

    await prisma.autoReplyLog.upsert({
      where: { mailboxId_sender: { mailboxId: input.mailboxId, sender: remetente.full } },
      create: { mailboxId: input.mailboxId, sender: remetente.full },
      update: { sentAt: new Date() },
    });

    log.info("resposta automatica enviada", { mailboxId: input.mailboxId, para: remetente.full });
    return { sent: true, reason: "ok" };
  } catch (error) {
    log.error("falha na resposta automatica; a mensagem original segue entregue", {
      mailboxId: input.mailboxId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { sent: false, reason: "erro interno" };
  }
}

/** Limpeza do historico antigo, junto com a manutencao. */
export async function cleanupAutoReplyLog(): Promise<{ removed: number }> {
  const resultado = await prisma.autoReplyLog.deleteMany({
    where: { sentAt: { lt: new Date(Date.now() - 30 * 86_400_000) } },
  });
  return { removed: resultado.count };
}

/** Assinatura do servidor, usada no rodape da resposta automatica quando vazia. */
export const AUTO_REPLY_FOOTER = `\r\n\r\n--\r\nMensagem automatica enviada por ${config.hostname}`;
