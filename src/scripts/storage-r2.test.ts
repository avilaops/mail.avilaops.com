import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gzipSync, gunzipSync } from "node:zlib";

// Exercise the real S3 client's HTTP contract, including binary gzip bodies.
// No production credentials or mail data are used.
const objects = new Map<string, Buffer>();
const calls: string[] = [];
let rejectReads = false;
const server = createServer(async (req, res) => {
  const key = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  calls.push(`${req.method} ${key}`);
  if (req.headers.authorization?.includes("test-access") !== true) {
    res.writeHead(403).end();
    return;
  }
  if (req.method === "HEAD" && key === "/recovery/") {
    res.writeHead(200).end();
    return;
  }
  if (req.method === "PUT") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    objects.set(key, Buffer.concat(chunks));
    res.writeHead(200, { ETag: '"test-etag"' }).end();
    return;
  }
  if (req.method === "GET") {
    if (rejectReads) {
      res.writeHead(403, { "Content-Type": "application/xml" }).end("<Error><Code>AccessDenied</Code></Error>");
      return;
    }
    const body = objects.get(key);
    if (!body) {
      res.writeHead(404, { "Content-Type": "application/xml" }).end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": body.length }).end(body);
    return;
  }
  if (req.method === "DELETE") {
    objects.delete(key);
    res.writeHead(204).end();
    return;
  }
  res.writeHead(405).end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address !== "string");
const localDir = await mkdtemp(join(tmpdir(), "mail-storage-test-"));
process.env.MAIL_STORAGE_DRIVER = "r2";
process.env.NODE_ENV = "test";
process.env.MAIL_STORAGE_DIR = localDir;
process.env.MAIL_R2_ENDPOINT = `http://127.0.0.1:${address.port}`;
process.env.MAIL_R2_BUCKET = "recovery";
process.env.MAIL_R2_ACCESS_KEY_ID = "test-access";
process.env.MAIL_R2_SECRET_ACCESS_KEY = "test-secret";
const storage = await import("../lib/storage.js");
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await rm(localDir, { recursive: true, force: true });
});

test("message bytes persist in the remote bucket and read back intact", async () => {
  const raw = Buffer.from("From: recovery@example.test\r\nSubject: Binario\r\n\r\nOl\u00e1\u0000\u00ff");
  const result = await storage.storeRaw("message-1", raw, new Date("2026-11-13T00:00:00Z"));
  assert.equal(result.storageKey, "2026/11/message-1.eml.gz");
  assert.equal(result.sizeBytes, raw.length);
  const remote = objects.get("/recovery/2026/11/message-1.eml.gz");
  assert.ok(remote, "message must be durable outside the ephemeral filesystem");
  assert.deepEqual(gunzipSync(remote), raw);
  assert.deepEqual(await storage.readRaw(result.storageKey), raw);
});

test("reads restored gzip objects without needing a local copy", async () => {
  const raw = Buffer.from("Recovered message with attachment bytes\u0000");
  objects.set("/recovery/2026/10/restored-1.eml.gz", gzipSync(raw));
  assert.deepEqual(await storage.readRaw("2026/10/restored-1.eml.gz"), raw);
});

test("missing blobs retain ENOENT semantics; access failures propagate", async () => {
  await assert.rejects(storage.readRaw("2026/11/missing.eml.gz"), { code: "ENOENT" });
  rejectReads = true;
  try {
    await assert.rejects(storage.readRaw("2026/10/restored-1.eml.gz"), { name: "AccessDenied" });
  } finally {
    rejectReads = false;
  }
});

test("delete affects only the selected object and is idempotent", async () => {
  objects.set("/recovery/2026/11/remove-me.eml.gz", gzipSync(Buffer.from("remove")));
  await storage.deleteRaw("2026/11/remove-me.eml.gz");
  await storage.deleteRaw("2026/11/remove-me.eml.gz");
  assert.equal(objects.has("/recovery/2026/11/remove-me.eml.gz"), false);
  assert.equal(objects.has("/recovery/2026/10/restored-1.eml.gz"), true);
});

test("invalid storage keys are rejected before contacting the bucket", async () => {
  const count = calls.length;
  for (const key of ["../secret", "2026/11/../../outside.eml.gz", "/absolute.eml.gz", "2026/13/id.eml.gz"]) {
    await assert.rejects(storage.readRaw(key));
    await assert.rejects(storage.deleteRaw(key));
  }
  await assert.rejects(storage.storeRaw("../../outside", Buffer.from("invalid")));
  assert.equal(calls.length, count);
});
