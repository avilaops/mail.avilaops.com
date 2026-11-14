import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from './cloudflare-inbound.mjs';

function fixture() {
  const objects = new Map();
  const events = [];
  const tasks = [];
  const env = {
    RECIPIENTS: 'probe@example.test,alias@example.test',
    INGEST_URL: 'https://api.example.test/v1/inbound/cloudflare',
    INGEST_TOKEN: 'private-test-token',
    INCOMING: {
      async put(key, body, options) { events.push('stored'); objects.set(key, { body: body instanceof ArrayBuffer ? body : await new Response(body).arrayBuffer(), ...options }); },
      async get(key) { const object = objects.get(key); return object ? { ...object, body: new Response(object.body).body } : null; },
      async delete(key) { events.push('deleted'); objects.delete(key); },
      async list({ prefix, limit }) { return { objects: [...objects.keys()].filter(key => key.startsWith(prefix)).slice(0, limit).map(key => ({ key })) }; },
    },
  };
  const message = { from: 'sender@example.test', to: 'probe@example.test', headers: new Headers({ 'Authentication-Results': 'mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass' }), raw: new Response('synthetic MIME bytes').body, rawSize: 20, setReject(reason) { events.push('rejected'); this.rejection = reason; } };
  const ctx = { waitUntil(task) { tasks.push(task); } };
  return { env, message, ctx, objects, events, tasks };
}
test('accepts only after durable storage, then delivers and clears the queue', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(f.events[0], 'stored');
    assert.equal(url, f.env.INGEST_URL);
    assert.equal(options.headers.Authorization, 'Bearer private-test-token');
    const key = JSON.parse(options.body).storageKey;
    assert.equal(f.objects.get(key).customMetadata.to, f.message.to);
    return Response.json({ delivered: true });
  };
  try { await worker.email(f.message, f.env, f.ctx); await Promise.all(f.tasks); assert.equal(f.objects.size, 0); }
  finally { globalThis.fetch = original; }
});
test('failed delivery remains durable and is retried by the scheduled handler', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  try {
    await worker.email(f.message, f.env, f.ctx); await Promise.all(f.tasks);
    assert.equal(f.objects.size, 1);
    const bytes = [...f.objects.values()][0].body;
    assert.equal(await new Response(bytes).text(), 'synthetic MIME bytes');
    globalThis.fetch = async () => Response.json({ delivered: true });
    await worker.scheduled({}, f.env, f.ctx);
    assert.equal(f.objects.size, 0);
  } finally { globalThis.fetch = original; }
});
test('unknown recipients and oversized messages are rejected without storing', async () => {
  for (const change of [{ to: 'unknown@example.test' }, { rawSize: 25 * 1024 * 1024 + 1 }]) {
    const f = fixture(); Object.assign(f.message, change);
    await worker.email(f.message, f.env, f.ctx);
    assert.equal(f.objects.size, 0); assert.ok(f.message.rejection);
  }
});
test('accepts subaddresses of an allowed mailbox and preserves the envelope', async () => {
  const f = fixture(); f.message.to = 'probe+tag@example.test';
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('unavailable', { status: 503 });
  try { await worker.email(f.message, f.env, f.ctx); await Promise.all(f.tasks); assert.equal([...f.objects.values()][0].customMetadata.to, f.message.to); }
  finally { globalThis.fetch = original; }
});
test('permanent application rejection retains the MIME in the failed queue', async () => {
  const f = fixture();
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('unknown mailbox', { status: 422 });
  try {
    await worker.email(f.message, f.env, f.ctx); await Promise.all(f.tasks);
    assert.equal(f.objects.size, 1);
    assert.match([...f.objects.keys()][0], /^failed-incoming\//);
  } finally { globalThis.fetch = original; }
});
