import { createHash } from "node:crypto";
import { type AddressObject, type ParsedMail, simpleParser } from "mailparser";
import { prisma } from "../lib/db.js";
import { parseAddress, stripSubaddress } from "../lib/address.js";
import { storeRaw } from "../lib/storage.js";
import { avisarEntrega } from "./eventos.js";
import { getSystemFolder, type SystemFolderKind } from "../services/folders.js";
import { maybeAutoReply } from "../services/autoreply.js";
import { aplicarRegras } from "../services/rules.js";
import { enviarAviso } from "../services/push.js";
import { alertarQuota } from "../services/alertas.js";
import { enqueueForward } from "./queue.js";
import { proximoUid } from "../services/uid.js";
import { createLogger } from "../lib/logger.js";
import type { InboundAuthResult } from "./authcheck.js";

const log = createLogger("deliver-local");

export type DeliveryOutcome =
  | { status: "delivered"; messageId: string; folder: SystemFolderKind }
  | { status: "forwarded"; destination: string }
  | { status: "rejected"; code: number; reason: string };

export type RecipientResolution =
  | { kind: "mailbox"; mailboxId: string; domainId: string; quotaBytes: bigint; usedBytes: bigint; status: string }
  | { kind: "alias"; destination: string }
  | { kind: "unknown"; reason: string };

/**
 * Descobre para onde um endereco de destino aponta.
 *
 * Ordem: caixa exata → alias → catch-all do dominio. Sub-enderecamento
 * (contato+nota@) resolve para a caixa base, mas o endereco original continua
 * no header To:, que e o que o cliente usa para filtrar.
 */
export async function resolveRecipient(address: string): Promise<RecipientResolution> {
  const parsed = parseAddress(address);
  if (!parsed) return { kind: "unknown", reason: "endereco invalido" };

  const domain = await prisma.mailDomain.findUnique({
    where: { name: parsed.domain },
    select: { id: true, status: true, catchAllMailboxId: true },
  });

  if (!domain) return { kind: "unknown", reason: "dominio nao hospedado aqui" };
  if (domain.status === "disabled") return { kind: "unknown", reason: "dominio desativado" };

  const base = stripSubaddress(parsed.localPart);

  const mailbox = await prisma.mailbox.findUnique({
    where: { domainId_localPart: { domainId: domain.id, localPart: base } },
    select: { id: true, quotaBytes: true, usedBytes: true, status: true },
  });

  if (mailbox) {
    return {
      kind: "mailbox",
      mailboxId: mailbox.id,
      domainId: domain.id,
      quotaBytes: mailbox.quotaBytes,
      usedBytes: mailbox.usedBytes,
      status: mailbox.status,
    };
  }

  const alias = await prisma.mailAlias.findUnique({
    where: { domainId_localPart: { domainId: domain.id, localPart: base } },
    select: { destination: true },
  });
  if (alias) return { kind: "alias", destination: alias.destination };

  if (domain.catchAllMailboxId) {
    const catchAll = await prisma.mailbox.findUnique({
      where: { id: domain.catchAllMailboxId },
      select: { id: true, quotaBytes: true, usedBytes: true, status: true },
    });
    if (catchAll) {
      return {
        kind: "mailbox",
        mailboxId: catchAll.id,
        domainId: domain.id,
        quotaBytes: catchAll.quotaBytes,
        usedBytes: catchAll.usedBytes,
        status: catchAll.status,
      };
    }
  }

  return { kind: "unknown", reason: "caixa inexistente" };
}

function addressList(field: AddressObject | AddressObject[] | undefined): Array<{ address: string; name: string }> {
  if (!field) return [];
  const objects = Array.isArray(field) ? field : [field];
  return objects.flatMap((entry) =>
    (entry.value ?? []).map((item) => ({ address: item.address ?? "", name: item.name ?? "" })),
  );
}

const REPLY_PREFIX_RE = /^((re|res|resp|fwd|fw|enc|encaminhada|encaminhado)\s*(\[\d+\])?\s*:\s*)+/i;

function normalizeSubject(subject: string): string {
  return subject.replace(REPLY_PREFIX_RE, "").trim().toLowerCase();
}

/**
 * Agrupa a conversa. Prefere seguir o In-Reply-To, que e confiavel; cai para o
 * assunto normalizado quando o cliente de e-mail nao mandou referencia.
 */
async function resolveThreadKey(mailboxId: string, parsed: ParsedMail): Promise<string> {
  const inReplyTo = typeof parsed.inReplyTo === "string" ? parsed.inReplyTo.trim() : "";

  if (inReplyTo) {
    const parent = await prisma.message.findFirst({
      where: { mailboxId, rfcMessageId: inReplyTo },
      select: { threadKey: true },
    });
    if (parent?.threadKey) return parent.threadKey;
  }

  const basis = normalizeSubject(parsed.subject ?? "") || inReplyTo || parsed.messageId || "sem-assunto";
  return createHash("sha1").update(basis).digest("hex").slice(0, 32);
}

/**
 * Decide entre Caixa de Entrada e Spam com base na autenticacao do remetente.
 *
 * Quarentena, nunca descarte: e-mail legitimo classificado errado que some e
 * um chamado de suporte e um cliente perdido; na pasta de Spam, e um clique.
 */
function classify(auth: InboundAuthResult | null): { spam: boolean; reason: string | null; score: number } {
  if (!auth) return { spam: false, reason: null, score: 0 };

  let score = 0;
  const reasons: string[] = [];

  if (auth.dmarc === "fail") {
    if (auth.dmarcPolicy === "reject" || auth.dmarcPolicy === "quarantine") {
      score += 6;
      reasons.push(`DMARC fail com politica ${auth.dmarcPolicy}`);
    } else {
      score += 2;
      reasons.push("DMARC fail com politica none");
    }
  }

  if (auth.spf === "fail") {
    score += 3;
    reasons.push("SPF fail");
  } else if (auth.spf === "softfail") {
    score += 1;
    reasons.push("SPF softfail");
  }

  if (auth.dkim === "fail") {
    score += 2;
    reasons.push("DKIM fail");
  }

  const spam = score >= 5;
  return { spam, reason: spam ? reasons.join("; ") : null, score };
}

/**
 * Grava a mensagem na caixa: blob bruto em disco, metadado e corpo no banco,
 * quota atualizada. Blob e linha do banco sao escritos juntos para nao deixar
 * mensagem orfa contando quota.
 */
export async function deliverToMailbox(
  target: Extract<RecipientResolution, { kind: "mailbox" }>,
  raw: Buffer,
  auth: InboundAuthResult | null,
  options: {
    forceFolder?: SystemFolderKind;
    envelopeFrom?: string;
    /**
     * Pasta exata, por id. Existe por causa do APPEND do IMAP: o cliente pode
     * mandar guardar numa pasta que ele mesmo criou ("Projetos"), e essa nao
     * tem `kind` de sistema para o `forceFolder` apontar.
     */
    forceFolderId?: string;
    /** Flags que o cliente enviou junto no APPEND (\Seen, \Draft...). */
    flags?: { seen?: boolean; flagged?: boolean; answered?: boolean; draft?: boolean };
  } = {},
): Promise<DeliveryOutcome> {
  if (target.status === "disabled") {
    return { status: "rejected", code: 550, reason: "5.2.1 Caixa desativada" };
  }

  const size = BigInt(raw.byteLength);
  if (target.usedBytes + size > target.quotaBytes) {
    await prisma.mailEvent.create({
      data: {
        mailboxId: target.mailboxId,
        type: "quota.exceeded",
        severity: "warn",
        payload: { usedBytes: target.usedBytes.toString(), quotaBytes: target.quotaBytes.toString() },
      },
    });
    return { status: "rejected", code: 552, reason: "5.2.2 Caixa cheia" };
  }

  const parsed = await simpleParser(raw, { skipTextLinks: true });
  // Mensagem colocada pelo proprio dono (copia de enviada, rascunho, APPEND)
  // nunca passa pelo filtro de spam: quem a pos ali foi o cliente.
  const posta = Boolean(options.forceFolder || options.forceFolderId);
  const from = addressList(parsed.from)[0] ?? { address: "", name: "" };

  let verdict: { spam: boolean; reason: string | null; score: number } = posta
    ? { spam: false, reason: null, score: 0 }
    : classify(auth);

  /**
   * Reputacao aprendida dos botoes "e spam" / "nao e spam" desta caixa.
   *
   * Bloqueio vence a classificacao: o dono ja disse o que acha deste
   * remetente. Confianca so resgata da quarentena quando o DMARC nao
   * reprovou com politica dura — remetente confiavel FALSIFICADO e
   * exatamente o phishing que a quarentena existe para segurar.
   */
  if (!posta && from.address) {
    const reputacao = await prisma.mailSenderReputation.findUnique({
      where: { mailboxId_senderAddress: { mailboxId: target.mailboxId, senderAddress: from.address } },
      select: { verdict: true },
    });
    if (reputacao?.verdict === "block" && !verdict.spam) {
      verdict = { spam: true, reason: "remetente marcado como spam por voce", score: verdict.score };
    } else if (reputacao?.verdict === "trust" && verdict.spam) {
      const falsificado =
        auth?.dmarc === "fail" && (auth.dmarcPolicy === "reject" || auth.dmarcPolicy === "quarantine");
      if (!falsificado) verdict = { spam: false, reason: null, score: verdict.score };
    }
  }

  // Regras do dono: so mensagem de fora que cairia na Entrada. Spam nao passa
  // por regra (a quarentena vence), e o que o proprio dono guardou tambem nao.
  const regra =
    !posta && !verdict.spam
      ? await aplicarRegras(target.mailboxId, {
          from: from.address,
          to: [...addressList(parsed.to), ...addressList(parsed.cc)].map((a) => a.address),
          subject: parsed.subject ?? "",
          hasAttachments: parsed.attachments.length > 0,
        })
      : null;

  const folderKind = options.forceFolder ?? (verdict.spam ? "spam" : "inbox");
  const folder = options.forceFolderId
    ? await prisma.mailFolder.findFirstOrThrow({
        where: { id: options.forceFolderId, mailboxId: target.mailboxId },
        select: { id: true },
      })
    : regra?.folderId
      ? { id: regra.folderId }
      : await getSystemFolder(target.mailboxId, folderKind);
  const threadKey = await resolveThreadKey(target.mailboxId, parsed);
  const receivedAt = parsed.date ?? new Date();

  const text = parsed.text ?? "";
  const snippet = text.replace(/\s+/g, " ").trim().slice(0, 320);

  // Reservado ANTES da transacao: se ela falhar, o UID fica sem uso e vira um
  // buraco na sequencia. O protocolo permite buracos; o que ele nao permite e
  // reaproveitar numero.
  const uid = await proximoUid(folder.id);

  const message = await prisma.$transaction(async (tx) => {
    const created = await tx.message.create({
      data: {
        mailboxId: target.mailboxId,
        folderId: folder.id,
        rfcMessageId: parsed.messageId ?? null,
        inReplyTo: typeof parsed.inReplyTo === "string" ? parsed.inReplyTo : null,
        threadKey,
        fromAddress: from.address,
        fromName: from.name || null,
        toAddresses: addressList(parsed.to),
        ccAddresses: addressList(parsed.cc),
        replyTo: addressList(parsed.replyTo),
        subject: parsed.subject ?? null,
        snippet: snippet || null,
        bodyText: text || null,
        bodyHtml: typeof parsed.html === "string" ? parsed.html : null,
        sizeBytes: raw.byteLength,
        storageKey: "", // preenchido logo abaixo, quando o id do blob existir
        authResult: auth ? { ...auth } : undefined,
        spamScore: verdict.score,
        quarantineReason: verdict.reason,
        hasAttachments: parsed.attachments.length > 0,
        uid,
        receivedAt,
        seen: options.flags?.seen ?? regra?.seen ?? false,
        flagged: options.flags?.flagged ?? regra?.flagged ?? false,
        answered: options.flags?.answered ?? false,
        draft: options.flags?.draft ?? false,
      },
      select: { id: true },
    });

    const blob = await storeRaw(created.id, raw, receivedAt);

    await tx.message.update({ where: { id: created.id }, data: { storageKey: blob.storageKey } });

    if (parsed.attachments.length > 0) {
      await tx.attachment.createMany({
        data: parsed.attachments.map((attachment, index) => ({
          messageId: created.id,
          filename: attachment.filename ?? null,
          contentType: attachment.contentType || "application/octet-stream",
          sizeBytes: attachment.size ?? 0,
          contentId: attachment.cid ?? null,
          partIndex: index,
        })),
      });
    }

    await tx.mailbox.update({
      where: { id: target.mailboxId },
      data: { usedBytes: { increment: size } },
    });

    return created;
  });

  /**
   * Aviso no aparelho, mesmo com o webmail fechado.
   *
   * So para mensagem que chegou de fora e caiu numa pasta normal: copia de
   * enviada, rascunho e spam nao acordam ninguem. Falha de push nunca pode
   * atrapalhar a entrega — por isso `void` com catch.
   */
  // Caixa enchendo: avisar antes de recusar mensagem, nao depois.
  void alertarQuota(target.mailboxId);

  if (!posta && !verdict.spam) {
    void enviarAviso(target.mailboxId, {
      titulo: from.name?.trim() || from.address || "Mensagem nova",
      corpo: (parsed.subject ?? "").trim() || "(sem assunto)",
      messageId: message.id,
      tipo: "mensagem",
      naEntrada: folderKind === "inbox" && !regra?.folderId,
    }).catch(() => undefined);
  }

  // Acorda quem estiver em IDLE nesta pasta. Depois da transacao de proposito:
  // avisar antes faria o cliente pedir a mensagem que ainda nao existe.
  avisarEntrega({ mailboxId: target.mailboxId, folderId: folder.id });

  log.info("mensagem entregue", {
    mailboxId: target.mailboxId,
    messageId: message.id,
    folder: folderKind,
    sizeBytes: raw.byteLength,
    spamScore: verdict.score,
    ...(regra ? { regra: regra.ruleName } : {}),
  });

  /**
   * Encaminhamento pedido pela regra — uma COPIA; a mensagem ja esta guardada
   * acima. Encaminhar para a propria caixa foi barrado na criacao da regra;
   * o laco por terceiros (a gente encaminha para fora, o de fora manda de
   * volta) e cortado pelo limite classico de saltos: mensagem com 25 ou mais
   * Received ja esta rodando em circulo, e mais um salto nao a salva.
   */
  if (!posta && regra?.forwardTo) {
    const saltos = parsed.headerLines.filter((linha) => linha.key === "received").length;
    if (saltos >= 25) {
      log.warn("encaminhamento suprimido: limite de saltos", {
        mailboxId: target.mailboxId,
        regra: regra.ruleName,
        saltos,
      });
      await prisma.mailEvent.create({
        data: {
          mailboxId: target.mailboxId,
          type: "rule.forward_loop",
          severity: "warn",
          payload: { regra: regra.ruleName, destination: regra.forwardTo, saltos },
        },
      });
    } else {
      const caixa = await prisma.mailbox.findUniqueOrThrow({
        where: { id: target.mailboxId },
        select: { localPart: true, domain: { select: { name: true } } },
      });
      await enqueueForward({
        originalRecipient: `${caixa.localPart}@${caixa.domain.name}`,
        destination: regra.forwardTo,
        raw,
        mailFrom: options.envelopeFrom ?? from.address,
      });
    }
  }

  // Resposta automatica so para mensagem que chegou de fora e caiu na entrada.
  // Copia em Enviados, rascunho e mensagem em quarentena nao disparam nada —
  // responder a spam confirma que a caixa existe.
  if (!posta && folderKind === "inbox" && options.envelopeFrom !== undefined) {
    await maybeAutoReply({
      mailboxId: target.mailboxId,
      parsed,
      envelopeFrom: options.envelopeFrom,
    });
  }

  return { status: "delivered", messageId: message.id, folder: folderKind };
}

/**
 * Guarda na propria caixa uma copia do que ela produziu — Enviados apos o
 * envio, Rascunhos ao salvar.
 *
 * No caso de Enviados o erro e registrado e engolido: a mensagem ja saiu, e
 * nao da para desfazer um envio so porque a copia falhou. Para Rascunhos o
 * chamador confere o retorno nulo.
 *
 * @returns id da mensagem gravada, ou null se nao deu.
 */
export async function storeCopyInMailbox(
  mailboxId: string,
  raw: Buffer,
  folder: SystemFolderKind = "sent",
): Promise<string | null> {
  try {
    const mailbox = await prisma.mailbox.findUnique({
      where: { id: mailboxId },
      select: { id: true, domainId: true, quotaBytes: true, usedBytes: true, status: true },
    });
    if (!mailbox) return null;

    const outcome = await deliverToMailbox(
      {
        kind: "mailbox",
        mailboxId: mailbox.id,
        domainId: mailbox.domainId,
        quotaBytes: mailbox.quotaBytes,
        usedBytes: mailbox.usedBytes,
        status: mailbox.status,
      },
      raw,
      null,
      { forceFolder: folder },
    );

    return outcome.status === "delivered" ? outcome.messageId : null;
  } catch (error) {
    log.error("falha ao gravar copia na caixa", {
      mailboxId,
      folder,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
