import { createHash } from "node:crypto";
import type { InboundAuthResult } from "../mta/authcheck.js";
import { deliverToMailbox, resolveRecipient } from "../mta/deliver-local.js";
import { readPendingInbound } from "../lib/storage.js";
import { HttpError } from "../api/http.js";
import { prisma } from "../lib/db.js";

export function cloudflareAuthResult(header: string): InboundAuthResult | null {
  // Only Cloudflare's first result is trusted; later headers may be forged.
  const first = header.split(",", 1)[0] ?? "";
  if (!/^mx\.cloudflare\.net\s*;/i.test(first)) return null;
  const result = (method: string) => first.match(new RegExp(`;\\s*${method}=(pass|fail|softfail|neutral|none|temperror|permerror)\\b`, "i"))?.[1]?.toLowerCase() ?? "none";
  return { spf: result("spf"), dkim: result("dkim"), dmarc: result("dmarc"), arc: result("arc"), dkimDomain: first.match(/\bheader\.d=([a-z0-9.-]+)/i)?.[1] ?? null, dmarcPolicy: first.match(/\b(?:p|policy)=(reject|quarantine|none)\b/i)?.[1] ?? null, headers: first };
}

export async function deliverCloudflareInbound(storageKey: string) {
  const deliveryId = "cfmail-" + createHash("sha256").update(storageKey).digest("hex");
  const receipt = await prisma.mailEvent.findUnique({ where: { id: deliveryId }, select: { type: true, payload: true } });
  const previous = receipt?.payload as { messageId?: unknown } | undefined;
  // Confirma a mesma entrega mesmo se o dono excluiu a mensagem ou alterou um alias.
  if (receipt?.type === "inbound.delivered" && typeof previous?.messageId === "string") return { delivered: true, messageId: previous.messageId };
  const { raw, metadata } = await readPendingInbound(storageKey);
  const recipient = metadata.to;
  if (!recipient || !metadata.receivedat || !Number.isFinite(Date.parse(metadata.receivedat))) throw new HttpError("Envelope de entrada invalido.", 422);
  let address = recipient;
  const visited = new Set<string>();
  for (let hop = 0; hop < 10; hop++) {
    if (visited.has(address.toLowerCase())) throw new HttpError("Alias de entrada com ciclo.", 422);
    visited.add(address.toLowerCase());
    const target = await resolveRecipient(address);
    if (target.kind === "alias") { address = target.destination; continue; }
    if (target.kind === "unknown") throw new HttpError("Destinatario de entrada indisponivel.", 422);
    const outcome = await deliverToMailbox(target, raw, cloudflareAuthResult(metadata.authenticationresults ?? ""), { deliveryId, envelopeFrom: metadata.from ?? "" });
    if (outcome.status !== "delivered") throw new HttpError("A caixa nao pode receber a mensagem; original preservado.", 422);
    return { delivered: true, messageId: outcome.messageId };
  }
  throw new HttpError("Alias de entrada excede limite de saltos.", 422);
}
