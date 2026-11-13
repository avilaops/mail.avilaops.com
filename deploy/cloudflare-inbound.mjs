const MAX_BYTES = 25 * 1024 * 1024;

function allowedRecipient(address, recipients) {
  const parts = address.toLowerCase().split('@');
  if (parts.length !== 2) return false;
  const base = `${parts[0].split('+')[0]}@${parts[1]}`;
  return recipients.split(',').map(item => item.trim().toLowerCase()).includes(base);
}

async function deliver(storageKey, env) {
  const response = await fetch(env.INGEST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.INGEST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ storageKey }),
    signal: AbortSignal.timeout(20_000),
    redirect: 'error',
  });
  if (response.status === 422) {
    await response.body?.cancel();
    const object = await env.INCOMING.get(storageKey);
    if (object) {
      await env.INCOMING.put(storageKey.replace(/^incoming\//, 'failed-incoming/'), object.body, {
        httpMetadata: object.httpMetadata,
        customMetadata: { ...object.customMetadata, failure: 'application-rejected' },
      });
      await env.INCOMING.delete(storageKey);
    }
    console.error(JSON.stringify({ event: 'inbound_needs_attention', storageKey, status: 422 }));
    return;
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Inbound API HTTP ${response.status}`);
  }
  const receipt = await response.json();
  if (receipt.delivered !== true) throw new Error('Inbound API did not confirm delivery');
  await env.INCOMING.delete(storageKey);
  console.log(JSON.stringify({ event: 'inbound_delivered', storageKey }));
}

async function retry(storageKey, env) {
  try { await deliver(storageKey, env); }
  catch (error) { console.error(JSON.stringify({ event: 'inbound_retry_pending', storageKey, reason: error.message })); }
}

export default {
  async email(message, env, ctx) {
    if (!allowedRecipient(message.to, env.RECIPIENTS)) {
      message.setReject('5.1.1 Recipient not configured');
      return;
    }
    if (!Number.isSafeInteger(message.rawSize) || message.rawSize < 1 || message.rawSize > MAX_BYTES) {
      message.setReject('5.3.4 Message exceeds 25 MiB');
      return;
    }
    const raw = await new Response(message.raw).arrayBuffer();
    if (raw.byteLength > MAX_BYTES || raw.byteLength !== message.rawSize) throw new Error('Unexpected inbound message length');
    const storageKey = `incoming/${crypto.randomUUID()}.eml`;
    const metadata = {
      from: message.from,
      to: message.to,
      receivedat: new Date().toISOString(),
      authenticationresults: (message.headers.get('Authentication-Results') ?? '').replace(/[\r\n]/g, ' ').slice(0, 1000),
    };
    if (new TextEncoder().encode(JSON.stringify(metadata)).byteLength > 1800) metadata.authenticationresults = '';
    await env.INCOMING.put(storageKey, raw, { httpMetadata: { contentType: 'message/rfc822' }, customMetadata: metadata });
    ctx.waitUntil(retry(storageKey, env));
  },
  async scheduled(controller, env) {
    const page = await env.INCOMING.list({ prefix: 'incoming/', limit: 5 });
    for (let index = 0; index < page.objects.length; index += 2) {
      await Promise.all(page.objects.slice(index, index + 2).map(object => retry(object.key, env)));
    }
  },
  fetch() { return new Response('Not found\n', { status: 404 }); },
};
