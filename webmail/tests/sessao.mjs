import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chromium } from "playwright";

// Somente GitHub CI: navegador e Next reais; a API controlada permite vencer
// o acesso sem aguardar quinze minutos ou usar credenciais de produção.
const acessos = new Map();
const refreshes = new Set();
let indisponivel = false;
let sequencia = 0;
const mailbox = { id: "teste", address: "teste@exemplo.test", displayName: "Teste", quotaBytes: "1000", usedBytes: "0", mustChangePassword: false };
function tokens() {
  const accessToken = `acesso-${++sequencia}`;
  const refreshToken = `refresh-${sequencia}`;
  acessos.set(accessToken, Date.now() + 2_000);
  refreshes.add(refreshToken);
  return { accessToken, refreshToken, expiresInSeconds: 2, refreshExpiresInSeconds: 3600, mailbox };
}
const backend = createServer(async (req, res) => {
  const partes = [];
  for await (const parte of req) partes.push(parte);
  const input = partes.length ? JSON.parse(Buffer.concat(partes).toString()) : {};
  const responder = (status, corpo) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(corpo));
  };
  if (req.url === "/v1/auth/login") return responder(200, tokens());
  if (req.url === "/v1/auth/refresh") {
    if (indisponivel) return responder(502, { error: { message: "Indisponibilidade controlada" } });
    if (!refreshes.has(input.refreshToken)) return responder(401, { error: { message: "Sessao invalida" } });
    return responder(200, tokens());
  }
  if (req.url === "/v1/auth/logout") return responder(200, { ok: true });
  const acesso = req.headers.authorization?.replace(/^Bearer /, "");
  if ((acessos.get(acesso) ?? 0) <= Date.now()) return responder(401, { error: { message: "Acesso expirado" } });
  if (req.url === "/v1/me/events") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.end("event: ready\ndata: {}\n\n");
  }
  if (req.url?.endsWith("/raw")) {
    res.writeHead(200, { "content-type": "message/rfc822", "content-disposition": "attachment" });
    return res.end("Subject: teste\r\n\r\nMensagem de teste");
  }
  if (req.url === "/v1/me") return responder(200, mailbox);
  if (req.url === "/v1/me/folders") return responder(200, { folders: [] });
  if (req.url?.startsWith("/v1/me/messages")) return responder(200, { messages: [], nextCursor: null });
  responder(200, {});
});
backend.listen(3040, "127.0.0.1");
await once(backend, "listening");
const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3041"], {
  env: { ...process.env, COOKIE_SECURE: "false", SSO_ENABLED: "false", AGENDA_ENABLED: "false", MAIL_API_URL: "http://127.0.0.1:3040/v1" },
  stdio: ["ignore", "ignore", "inherit"],
});
let browser;
try {
  for (let tentativa = 0; ; tentativa++) {
    try { if ((await fetch("http://127.0.0.1:3041/entrar?local=1")).ok) break; } catch { /* aguarda o servidor CI */ }
    if (tentativa > 60 || next.exitCode !== null) throw new Error("Next nao iniciou no CI");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  browser = await chromium.launch({ headless: true });
  const contexto = await browser.newContext();
  const pagina = await contexto.newPage();
  const base = "http://127.0.0.1:3041";
  await pagina.goto(`${base}/entrar?local=1`);
  const login = async () => {
    assert.equal(await pagina.evaluate(async () => (await fetch("/api/sessao", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "teste@exemplo.test", password: "somente-ci" }),
    })).status), 200);
  };
  const pedir = (caminho) => pagina.evaluate(async (url) => {
    const resposta = await fetch(url);
    return { status: resposta.status, texto: await resposta.text() };
  }, caminho);
  await login();
  await pagina.waitForTimeout(2300);
  await pagina.goto(`${base}/caixa`);
  assert.equal(new URL(pagina.url()).pathname, "/caixa", "reabrir caixa com refresh valido nao pede login");
  assert.equal((await pedir("/api/mail/me")).status, 200, "JSON renova acesso vencido");

  for (const caminho of ["/api/mail/me", "/api/mail/me/messages/teste/raw", "/api/mail/me/events"]) {
    await login();
    await pagina.waitForTimeout(2300);
    indisponivel = true;
    assert.equal((await pedir(caminho)).status, 502, "falha transitoria preserva status");
    assert.ok((await contexto.cookies()).some((cookie) => cookie.name === "avila_mail_rt"), "refresh preservado durante falha");
    indisponivel = false;
    assert.equal((await pedir(caminho)).status, 200, "mesmo request recupera sem autenticar novamente");
  }
  const csrf = (await contexto.cookies()).find((cookie) => cookie.name === "avila_mail_csrf");
  assert.equal(csrf?.httpOnly, false);
  const rt = (await contexto.cookies()).find((cookie) => cookie.name === "avila_mail_rt");
  assert.equal(rt?.httpOnly, true);
  assert.equal(rt?.path, "/");
  assert.ok(rt.expires - Date.now() / 1000 < 3601, "cookie respeita o TTL da API");
  console.log("PASSOU — sessao real no navegador: reabertura, renovacao, JSON/download/SSE, recuperacao e cookies");
} finally {
  await browser?.close();
  next.kill("SIGTERM");
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
}
