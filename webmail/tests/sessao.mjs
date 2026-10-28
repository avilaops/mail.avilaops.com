import assert from "node:assert/strict";
import { createServer, request as encaminharHttp } from "node:http";
import { createServer as criarProxyHttps } from "node:https";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { build } from "esbuild";

// Somente GitHub CI: navegador e Next reais; a API controlada permite vencer
// o acesso sem aguardar quinze minutos ou usar credenciais de produção.
const acessos = new Map();
const refreshes = new Set();
let indisponivel = false;
let sequencia = 0;
let primeiraSenha = false;
let mutacoes = 0;
const mailbox = { id: "teste", address: "teste@exemplo.test", displayName: "Teste", quotaBytes: "1000", usedBytes: "0", mustChangePassword: false };
function tokens() {
  const accessToken = `acesso-${++sequencia}`;
  const refreshToken = `refresh-${sequencia}`;
  acessos.set(accessToken, Date.now() + 2_000);
  refreshes.add(refreshToken);
  return { accessToken, refreshToken, expiresInSeconds: 2, refreshExpiresInSeconds: 3600, mailbox: { ...mailbox, mustChangePassword: primeiraSenha } };
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
  if (req.url === "/v1/me/first-password" && req.method === "POST") {
    primeiraSenha = false;
    return responder(200, { ok: true });
  }
  if (primeiraSenha && req.url !== "/v1/me/first-password") return responder(409, { error: { message: "Defina a senha" } });
  if (req.url === "/v1/me/messages/mark-all-read" && req.method === "POST") {
    mutacoes++;
    return responder(200, { ok: true });
  }
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
// A CSP promove redirects de fetch para HTTPS. Reproduzir o TLS do proxy de
// producao tambem verifica cookies Secure; desabilitar a CSP esconderia isso.
const temporario = mkdtempSync(join(tmpdir(), "mail-sessao-ci-"));
const chave = join(temporario, "key.pem");
const certificado = join(temporario, "cert.pem");
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", chave, "-out", certificado, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
const tls = criarProxyHttps({ key: readFileSync(chave), cert: readFileSync(certificado) }, (req, res) => {
  const upstream = encaminharHttp({ hostname: "127.0.0.1", port: 3041, path: req.url, method: req.method,
    headers: { ...req.headers, "x-forwarded-proto": "https", "x-forwarded-host": "127.0.0.1:3441" } }, (origem) => {
    res.writeHead(origem.statusCode, origem.headers);
    origem.pipe(res);
  });
  upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  res.on("close", () => upstream.destroy());
  req.pipe(upstream);
});
tls.listen(3441, "127.0.0.1");
await once(tls, "listening");
const next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", "3041"], {
  env: { ...process.env, COOKIE_SECURE: "true", SSO_ENABLED: "false", AGENDA_ENABLED: "false", WEBMAIL_URL: "https://127.0.0.1:3441", MAIL_API_URL: "http://127.0.0.1:3040/v1" },
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
  const contexto = await browser.newContext({ ignoreHTTPSErrors: true });
  // Executar o cliente real permite verificar a repeticao de mutacoes, sem
  // criar uma pagina de teste dentro da aplicacao ou copiar sua logica.
  const cliente = await build({ entryPoints: ["src/lib/cliente.ts"], bundle: true, write: false, format: "iife", globalName: "MailCliente", logLevel: "silent" });
  await contexto.addInitScript({ content: cliente.outputFiles[0].text });
  const pagina = await contexto.newPage();
  const base = "https://127.0.0.1:3441";
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
  await pagina.goto(`${base}/entrar?local=1`);

  for (const caminho of ["/api/mail/me", "/api/mail/me/messages/teste/raw", "/api/mail/me/events"]) {
    await login();
    await pagina.waitForTimeout(2300);
    indisponivel = true;
    assert.equal((await pedir(caminho)).status, 502, "falha transitoria preserva status");
    assert.ok((await contexto.cookies()).some((cookie) => cookie.name === "avila_mail_rt_v2"), "refresh preservado durante falha");
    indisponivel = false;
    assert.equal((await pedir(caminho)).status, 200, "mesmo request recupera sem autenticar novamente");
  }
  const csrf = (await contexto.cookies()).find((cookie) => cookie.name === "avila_mail_csrf");
  assert.equal(csrf?.httpOnly, false);
  const rt = (await contexto.cookies()).find((cookie) => cookie.name === "avila_mail_rt_v2");
  assert.equal(rt?.httpOnly, true);
  assert.equal(rt?.secure, true);
  assert.equal(rt?.path, "/");
  assert.ok(rt.expires - Date.now() / 1000 < 3601, "cookie respeita o TTL da API");
  await contexto.clearCookies();
  const legado = tokens();
  await contexto.addCookies([{ name: "avila_mail_rt", value: legado.refreshToken, domain: "127.0.0.1", path: "/api/sessao", httpOnly: true, sameSite: "Strict" }]);
  await pagina.goto(`${base}/caixa`);
  assert.equal(new URL(pagina.url()).pathname, "/caixa", "cookie legado migra sem novo login");
  assert.equal((await contexto.cookies()).some((cookie) => cookie.name === "avila_mail_rt"), false, "cookie legado removido");
  assert.equal((await pedir("/api/mail/me")).status, 200);
  await pagina.goto(`${base}/entrar?local=1`);
  for (const caminho of ["/api/mail/me", "/api/mail/me/messages/teste/raw", "/api/mail/me/events"]) {
    await contexto.clearCookies();
    const sessaoAntiga = tokens();
    await contexto.addCookies([{ name: "avila_mail_rt", value: sessaoAntiga.refreshToken, domain: "127.0.0.1", path: "/api/sessao", httpOnly: true, sameSite: "Strict" }]);
    assert.equal((await pedir(caminho)).status, 200, "aba ja aberta recupera cookie legado pela API");
  }
  await contexto.clearCookies();
  const antesDeMutar = tokens();
  await contexto.addCookies([
    { name: "avila_mail_rt", value: antesDeMutar.refreshToken, domain: "127.0.0.1", path: "/api/sessao", httpOnly: true, secure: true, sameSite: "Strict" },
    { name: "avila_mail_csrf", value: "csrf-exclusivo-ci", domain: "127.0.0.1", path: "/", secure: true, sameSite: "Strict" },
  ]);
  const csrfAntes = (await contexto.cookies()).find((cookie) => cookie.name === "avila_mail_csrf").value;
  await pagina.evaluate(() => window.MailCliente.api("/me/messages/mark-all-read", { method: "POST", body: { folder: "inbox" } }));
  assert.equal(mutacoes, 1, "cliente real renova e repete a mutacao uma unica vez");
  assert.equal((await contexto.cookies()).find((cookie) => cookie.name === "avila_mail_csrf").value, csrfAntes, "renovacao preserva CSRF em requests concorrentes");
  assert.equal(await pagina.evaluate(async () => (await fetch("/api/sessao/retomar", { method: "POST" })).status), 403, "ponte de mutacao exige CSRF");

  primeiraSenha = true;
  await contexto.clearCookies();
  const primeiroAcesso = tokens();
  await contexto.addCookies([{ name: "avila_mail_rt", value: primeiroAcesso.refreshToken, domain: "127.0.0.1", path: "/api/sessao", httpOnly: true, secure: true, sameSite: "Strict" }]);
  assert.equal((await pedir("/api/mail/me")).status, 409, "ponte preserva 409 de primeiro acesso para o cliente");
  assert.ok((await contexto.cookies()).some((cookie) => cookie.name === "avila_mail_trocar"), "marca do primeiro acesso sobrevive a renovacao");
  await pagina.evaluate(() => window.MailCliente.api("/me/first-password", { method: "POST", body: { newPassword: "senha-exclusiva-ci" } }));
  assert.equal((await contexto.cookies()).some((cookie) => cookie.name === "avila_mail_trocar"), false, "marca removida somente apos definir a senha");
  console.log("PASSOU — sessao real no navegador: reabertura, renovacao, JSON/download/SSE, recuperacao e cookies");
} finally {
  await browser?.close();
  next.kill("SIGTERM");
  tls.closeAllConnections();
  await new Promise((resolve) => tls.close(resolve));
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
  rmSync(temporario, { recursive: true, force: true });
}
