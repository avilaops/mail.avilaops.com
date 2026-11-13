import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = await mkdtemp(join(tmpdir(), "mail-inbound-test-"));
process.env.MAIL_STORAGE_DRIVER = "filesystem";
process.env.MAIL_STORAGE_DIR = workDir;
const { prisma, disconnect } = await import("../lib/db.js");
const { ensureSystemFolders } = await import("../services/folders.js");
const { deleteMessages } = await import("../services/messages.js");
const { deliverToMailbox } = await import("../mta/deliver-local.js");
const domain = await prisma.mailDomain.create({ data: { name: `inbound-test-${randomUUID()}.invalid`, status: "active" } });
try {
  const box = await prisma.mailbox.create({ data: { domainId: domain.id, localPart: "probe", passwordHash: "test-only-not-a-password", status: "active" } });
  await ensureSystemFolders(box.id);
  const target = { kind: "mailbox" as const, mailboxId: box.id, domainId: domain.id, quotaBytes: box.quotaBytes, usedBytes: 0n, status: "active" };
  const raw = Buffer.from("From: sender@example.invalid\r\nTo: probe@example.invalid\r\nSubject: inbound test\r\n\r\nSynthetic body\r\n");
  const deliveryId = `cfmail-${randomUUID().replaceAll("-", "")}`;
  const outcomes = await Promise.all(Array.from({ length: 3 }, () => deliverToMailbox(target, raw, null, { deliveryId })));
  assert.ok(outcomes.every(outcome => outcome.status === "delivered" && outcome.messageId === deliveryId));
  assert.equal(await prisma.message.count({ where: { mailboxId: box.id } }), 1);
  assert.equal((await prisma.mailbox.findUniqueOrThrow({ where: { id: box.id } })).usedBytes, BigInt(raw.length));
  await deleteMessages(box.id, [deliveryId], { permanent: true });
  await deliverToMailbox(target, raw, null, { deliveryId });
  assert.equal(await prisma.message.count({ where: { mailboxId: box.id } }), 0, "retry must not restore a message deleted by its owner");
  assert.equal((await prisma.mailbox.findUniqueOrThrow({ where: { id: box.id } })).usedBytes, 0n);
  console.log("PASS: concurrent inbound retry stores one message/quota and respects later deletion");
} finally {
  await prisma.mailDomain.delete({ where: { id: domain.id } });
  await disconnect();
  await rm(workDir, { recursive: true, force: true });
}
