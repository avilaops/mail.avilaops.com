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
let falhaPush = false;
let falhaInscricaoPush = false;
let modoSso = "revogado";
let logoutIndisponivel = false;
const endpointPush = "https://push.exemplo.test/navegador-ci";
const estadoPush = { disponivel: true, chavePublica: "BAECAwQ", habilitadoAqui: true,
  aparelhos: [{ id: "aparelho-ci", endpoint: endpointPush, nesteAparelho: true, userAgent: "Chromium CI", lastSentAt: null, createdAt: "2026-10-28T00:00:00Z" }] };
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
  if (req.url === "/v1/auth/logout") return responder(logoutIndisponivel ? 503 : 200, logoutIndisponivel ? { error: { message: "Falha temporária ao encerrar sessão." } } : { ok: true });
  if (req.url === "/v1/auth/sso") {
    if (modoSso === "permitido") return responder(200, tokens());
    if (modoSso === "mfa") return responder(428, { error: { message: "Confirme o segundo fator." } });
    return responder(401, { error: { message: "Sessao do SSO revogada.", code: "sso_reauth_required" } });
  }
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
  if (req.url?.startsWith("/v1/me/events")) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    return res.end(`id: teste:1\nevent: ready\ndata: ${JSON.stringify({ mailboxId: "teste", cursorRecebido: req.headers["last-event-id"] ?? null })}\n\n`);
  }
  if (req.url?.endsWith("/raw")) {
    res.writeHead(200, { "content-type": "message/rfc822", "content-disposition": "attachment" });
    return res.end("Subject: teste\r\n\r\nMensagem de teste");
  }
  if (req.url === "/v1/me") return responder(200, mailbox);
  if (req.url === "/v1/me/settings") return responder(200, { notifyEnabled: true, notifyOnlyInbox: true, notifyQuietStart: null, notifyQuietEnd: null });
  if (req.url === "/v1/me/push") {
    if (req.method === "POST") {
      if (falhaInscricaoPush) return responder(503, { error: { message: "Falha controlada ao inscrever" } });
      estadoPush.habilitadoAqui = true;
      estadoPush.aparelhos = [{ id: "aparelho-ci", endpoint: input.endpoint, nesteAparelho: true, userAgent: "Chromium CI", lastSentAt: null, createdAt: "2026-10-28T00:00:00Z" }];
      return responder(201, { ok: true });
    }
    if (req.method === "PUT") {
      if (falhaPush) return responder(503, { error: { message: "Falha controlada ao desligar" } });
      estadoPush.habilitadoAqui = input.enabled;
      if (!input.enabled) estadoPush.aparelhos = [];
      return responder(200, { ok: true });
    }
    return responder(200, estadoPush);
  }
  if (req.url === "/v1/me/folders") return responder(200, { folders: [
    { id: "pasta-entrada-ci", name: "Entrada", kind: "inbox", total: 0, unread: 0 },
    { id: "pasta-arquivo-ci", name: "Arquivo", kind: "archive", total: 0, unread: 0 },
  ] });
  if (req.url?.startsWith("/v1/me/messages/aviso-ci?")) return responder(200, {
    id: "aviso-ci", folderId: "pasta-arquivo-ci", threadKey: null, fromAddress: "remetente@exemplo.test", fromName: "Remetente CI", toAddresses: [], ccAddresses: [],
    subject: "Mensagem exata do aviso CI", snippet: "Corpo CI", seen: true, flagged: false, answered: false, hasAttachments: false, sizeBytes: 20,
    spamScore: null, quarantineReason: null, senderVerified: true, receivedAt: "2026-10-28T00:00:00Z", bodyText: "Corpo CI", bodyHtml: null, blockedRemoteImages: 0, attachments: [], convite: null,
  });
  if (req.url?.startsWith("/v1/me/messages/aviso-removido?")) return responder(404, { error: { message: "Mensagem não encontrada." } });
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
  env: { ...process.env, COOKIE_SECURE: "true", SSO_ENABLED: "true", AUTH_URL: "https://auth.exemplo.test", AGENDA_ENABLED: "false", WEBMAIL_URL: "https://127.0.0.1:3441", MAIL_API_URL: "http://127.0.0.1:3040/v1" },
  stdio: ["ignore", "ignore", "inherit"],
});
let browser;
try {
  for (let tentativa = 0; ; tentativa++) {
    try { if ((await fetch("http://127.0.0.1:3041/entrar?local=1")).ok) break; } catch { /* aguarda o servidor CI */ }
    if (tentativa > 60 || next.exitCode !== null) throw new Error("Next nao iniciou no CI");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  browser = await chromium.launch({ headless: true, args: ["--ignore-certificate-errors"] });
  const contexto = await browser.newContext({ ignoreHTTPSErrors: true });
  // Executar o cliente real permite verificar a repeticao de mutacoes, sem
  // criar uma pagina de teste dentro da aplicacao ou copiar sua logica.
  const cliente = await build({ entryPoints: ["src/lib/cliente.ts"], bundle: true, write: false, format: "iife", globalName: "MailCliente", logLevel: "silent" });
  await contexto.addInitScript({ content: `${cliente.outputFiles[0].text}\nglobalThis.MailCliente = MailCliente;` });
  const avisos = await build({ entryPoints: ["src/lib/notificacoes.ts"], bundle: true, write: false, format: "iife", globalName: "MailAvisos", logLevel: "silent" });
  await contexto.addInitScript({ content: `${avisos.outputFiles[0].text}\nglobalThis.MailAvisos = MailAvisos;` });
  const interfaceAvisos = await build({ stdin: { contents: 'import { createElement } from "react"; import { createRoot } from "react-dom/client"; import { AvisosDeMensagem } from "./src/components/AvisosDeMensagem"; export function montar(elemento) { const raiz = createRoot(elemento); raiz.render(createElement(AvisosDeMensagem)); return () => raiz.unmount(); }', resolveDir: process.cwd(), loader: "js" }, bundle: true, write: false, format: "iife", globalName: "MailAvisosUi", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "silent" });
  await contexto.addInitScript({ content: `${interfaceAvisos.outputFiles[0].text}\nglobalThis.MailAvisosUi = MailAvisosUi;` });
  const pagina = await contexto.newPage();
  const base = "https://127.0.0.1:3441";
  await pagina.goto(`${base}/entrar?local=1`);
  const contagemAvisos = await pagina.evaluate(async () => {
    const Original = window.Notification;
    const serviceWorkerOriginal = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    let emitidos = 0;
    window.Notification = class { static permission = "granted"; };
    const registro = { active: { postMessage: (_dados, portas) => { emitidos++; portas[0].postMessage({ ok: true }); } } };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: async () => registro, ready: Promise.resolve(registro) } });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    const mensagens = [{ id: "mensagem-ci", fromAddress: "remetente@exemplo.test", subject: "Teste" }];
    await window.MailAvisos.avisarSistema(mensagens, false, "caixa-ci");
    const desligado = emitidos;
    await window.MailAvisos.avisarSistema(mensagens, true, "caixa-ci");
    const ligado = emitidos;
    window.Notification = Original;
    if (serviceWorkerOriginal) Object.defineProperty(navigator, "serviceWorker", serviceWorkerOriginal);
    else delete navigator.serviceWorker;
    delete document.visibilityState;
    return { desligado, ligado };
  });
  assert.deepEqual(contagemAvisos, { desligado: 0, ligado: 1 }, "balao respeita decisao do servidor para preferencia e aparelho");
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
  const cursorRepassado = await pagina.evaluate(async () => (await fetch("/api/mail/me/events", { headers: { "Last-Event-ID": "teste:12345" } })).text());
  assert.ok(cursorRepassado.includes('"cursorRecebido":"teste:12345"'), "BFF repassa Last-Event-ID ao renovar ou reconectar SSE");
  assert.equal(csrf?.httpOnly, false);
  const rt = (await contexto.cookies()).find((cookie) => cookie.name === "avila_mail_rt_v2");
  assert.equal(rt?.httpOnly, true);
  assert.equal(rt?.secure, true);
  assert.equal(rt?.path, "/");
  assert.ok(rt.expires - Date.now() / 1000 < 3601, "cookie respeita o TTL da API");
  const saidaDireta = await contexto.request.get(`${base}/api/sessao/sair`, { maxRedirects: 0 });
  assert.equal(saidaDireta.status(), 307, "GET de conclusao nao inicia logout de uma familia ainda ativa");
  assert.equal(saidaDireta.headers().location, `${base}/caixa`);
  assert.ok((await contexto.cookies()).some((cookie) => cookie.name === "avila_mail_rt_v2"), "acesso direto preserva prova para revogar via DELETE protegido");
  logoutIndisponivel = true;
  const tentativaLogout = await pagina.evaluate(async () => {
    const csrf = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("avila_mail_csrf="))?.split("=")[1];
    return (await fetch("/api/sessao", { method: "DELETE", headers: { "x-csrf-token": decodeURIComponent(csrf ?? "") } })).status;
  });
  assert.equal(tentativaLogout, 503, "logout nao afirma sucesso quando revogacao remota falha");
  assert.ok((await contexto.cookies()).some((cookie) => cookie.name === "avila_mail_rt_v2"), "logout falho preserva token para repetir revogacao");
  assert.equal(await pagina.evaluate(async () => {
    const antes = location.href;
    try { await window.MailCliente.sair(); return false; } catch { return location.href === antes; }
  }), true, "cliente nao segue ao logout global quando Mail nao foi revogado");
  logoutIndisponivel = false;
  const saidaConfirmada = await pagina.evaluate(async () => {
    const csrf = document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("avila_mail_csrf="))?.split("=")[1];
    return (await fetch("/api/sessao", { method: "DELETE", headers: { "x-csrf-token": decodeURIComponent(csrf ?? "") } })).status;
  });
  assert.equal(saidaConfirmada, 200, "repetir logout apos recuperacao confirma revogacao");
  assert.equal((await contexto.cookies()).some((cookie) => cookie.name === "avila_mail_rt_v2"), false, "cookie e limpo somente apos confirmar revogacao");
  const conclusaoLogout = await contexto.request.get(`${base}/api/sessao/sair`, { maxRedirects: 0 });
  assert.equal(conclusaoLogout.status(), 200);
  assert.ok((await conclusaoLogout.text()).includes("/api/auth/logout"), "SSO global fica para depois do DELETE confirmado");
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
  assert.ok((await contexto.cookies()).find((cookie) => cookie.name === "avila_mail_csrf").value === csrfAntes, "renovacao preserva CSRF em requests concorrentes");
  assert.equal(await pagina.evaluate(async () => (await fetch("/api/sessao/retomar", { method: "POST" })).status), 403, "ponte de mutacao exige CSRF");

  primeiraSenha = true;
  await contexto.clearCookies();
  const primeiroAcesso = tokens();
  await contexto.addCookies([{ name: "avila_mail_rt", value: primeiroAcesso.refreshToken, domain: "127.0.0.1", path: "/api/sessao", httpOnly: true, secure: true, sameSite: "Strict" }]);
  assert.equal((await pedir("/api/mail/me")).status, 409, "ponte preserva 409 de primeiro acesso para o cliente");
  assert.ok((await contexto.cookies()).some((cookie) => cookie.name === "avila_mail_trocar"), "marca do primeiro acesso sobrevive a renovacao");
  await pagina.evaluate(() => window.MailCliente.api("/me/first-password", { method: "POST", body: { newPassword: "senha-exclusiva-ci" } }));
  assert.equal((await contexto.cookies()).some((cookie) => cookie.name === "avila_mail_trocar"), false, "marca removida somente apos definir a senha");
  // Monta o componente de producao na pagina real, com API pelo BFF e CSP.
  // Somente a permissao/SW sao controlados: o Chromium CI nao tem provedor push.
  await pagina.evaluate((endpoint) => {
    const original = Object.getOwnPropertyDescriptor(navigator, "serviceWorker");
    const notificacaoOriginal = window.Notification;
    const pushManagerOriginal = window.PushManager;
    window.permissaoAvisosCi = "granted";
    window.Notification = class { static get permission() { return window.permissaoAvisosCi; } static async requestPermission() { return window.permissaoAvisosCi; } };
    const registro = { pushManager: { getSubscription: async () => ({ endpoint, options: { applicationServerKey: new Uint8Array([4, 1, 2, 3, 4]).buffer }, toJSON: () => ({ endpoint, keys: { p256dh: "publica-ci", auth: "auth-ci" } }), unsubscribe: async () => { throw new Error("Falha controlada do navegador"); } }) } };
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { getRegistration: async () => registro, register: async () => registro, ready: Promise.resolve(registro) } });
    const elemento = document.createElement("div");
    elemento.id = "avisos-reais-ci";
    document.body.append(elemento);
    const desmontar = window.MailAvisosUi.montar(elemento);
    window.limparAvisosCi = () => {
      desmontar(); elemento.remove(); window.Notification = notificacaoOriginal;
      window.PushManager = pushManagerOriginal;
      if (original) Object.defineProperty(navigator, "serviceWorker", original);
      else delete navigator.serviceWorker;
    };
  }, endpointPush);
  const avisosReais = pagina.locator("#avisos-reais-ci");
  await avisosReais.getByText("Ligado: você recebe o aviso mesmo com o webmail fechado.", { exact: true }).waitFor();
  estadoPush.chavePublica = "BgcICQo";
  await pagina.evaluate(() => window.dispatchEvent(new Event("focus")));
  await avisosReais.getByRole("button", { name: "Ativar em segundo plano" }).waitFor();
  assert.equal(await avisosReais.getByText("Ligado: você recebe o aviso mesmo com o webmail fechado.", { exact: true }).count(), 0, "VAPID alterada exige reativacao mesmo com endpoint e familia iguais");
  estadoPush.chavePublica = "BAECAwQ";
  await pagina.evaluate(() => window.dispatchEvent(new Event("focus")));
  await avisosReais.getByText("Ligado: você recebe o aviso mesmo com o webmail fechado.", { exact: true }).waitFor();
  falhaPush = true;
  await avisosReais.getByRole("button", { name: "Desligar aqui" }).click();
  await avisosReais.getByRole("alert").filter({ hasText: "Falha controlada ao desligar" }).waitFor();
  assert.equal(estadoPush.habilitadoAqui, true, "falha remota nao finge que desligou");
  falhaPush = false;
  await avisosReais.getByRole("button", { name: "Desligar aqui" }).click();
  await avisosReais.getByRole("alert").filter({ hasText: "Falha controlada do navegador" }).waitFor();
  assert.equal(estadoPush.habilitadoAqui, false, "falha local nao mantem servidor autorizado");
  assert.equal(await avisosReais.getByRole("button", { name: "Desligar aqui" }).count(), 0, "inscricao local orfa nao aparece como ligada");
  falhaInscricaoPush = true;
  await avisosReais.getByRole("button", { name: "Ligar avisos", exact: true }).click();
  await avisosReais.getByRole("alert").filter({ hasText: "Falha controlada ao inscrever" }).waitFor();
  assert.equal(await avisosReais.getByRole("button", { name: "Desligar aqui" }).count(), 0, "POST falho nao confirma inscricao orfa");
  falhaInscricaoPush = false;
  await avisosReais.getByRole("button", { name: "Ligar avisos", exact: true }).click();
  await avisosReais.getByText("Ligado: você recebe o aviso mesmo com o webmail fechado.", { exact: true }).waitFor();
  await pagina.evaluate(() => { window.permissaoAvisosCi = "denied"; window.dispatchEvent(new Event("focus")); });
  await avisosReais.getByText(/O navegador está bloqueando avisos/).waitFor();
  assert.equal(await avisosReais.getByRole("button", { name: "Ligar avisos", exact: true }).isDisabled(), true);
  await pagina.evaluate(() => { window.permissaoAvisosCi = "granted"; delete window.PushManager; window.dispatchEvent(new Event("focus")); });
  await avisosReais.getByText(/Ligado com o webmail aberto/).waitFor();
  assert.equal(await avisosReais.getByRole("button", { name: "Enviar aviso de teste" }).count(), 0, "sem PushManager nao promete segundo plano");
  await pagina.evaluate(() => window.limparAvisosCi());
  await pagina.goto(`${base}/caixa?mensagem=aviso-ci`);
  await pagina.getByRole("heading", { name: "Mensagem exata do aviso CI", exact: true }).waitFor();
  await contexto.clearCookies();
  const pedidoSemSessao = await contexto.request.get(`${base}/caixa?mensagem=aviso-ci`, { maxRedirects: 0 });
  const ponteDestino = new URL(pedidoSemSessao.headers().location, base);
  assert.equal(ponteDestino.searchParams.get("returnTo"), "/caixa?mensagem=aviso-ci", "destino do aviso sobrevive a ponte sem sessao");
  const pedidoAgendaSemSessao = await contexto.request.get(`${base}/agenda?data=2026-10-28&evento=evento-ci.ics`, { maxRedirects: 0 });
  assert.equal(new URL(pedidoAgendaSemSessao.headers().location, base).searchParams.get("returnTo"), "/agenda?data=2026-10-28&evento=evento-ci.ics", "ocorrencia do lembrete sobrevive ao login");
  await pagina.goto(`${base}/entrar?local=1&returnTo=${encodeURIComponent("/caixa?mensagem=aviso-ci")}`);
  await pagina.getByLabel("Endereço").fill("teste@exemplo.test");
  await pagina.getByLabel("Senha", { exact: true }).fill("somente-ci");
  await pagina.getByRole("button", { name: "Entrar", exact: true }).click();
  await pagina.getByRole("heading", { name: "Mensagem exata do aviso CI", exact: true }).waitFor();
  assert.equal(new URL(pagina.url()).searchParams.get("mensagem"), "aviso-ci", "login local conserva destino do aviso");
  await pagina.goto(`${base}/caixa?mensagem=aviso-removido`);
  await pagina.getByRole("alert").filter({ hasText: "Mensagem não encontrada." }).waitFor();
  const retornoAviso = "/caixa?mensagem=aviso-ci";
  const inicioSsoComDestino = await contexto.request.get(`${base}/entrar?returnTo=${encodeURIComponent(retornoAviso)}`, { maxRedirects: 0 });
  const callbackComDestino = new URL(new URL(inicioSsoComDestino.headers().location).searchParams.get("returnTo"));
  assert.equal(callbackComDestino.origin, base);
  assert.equal(callbackComDestino.searchParams.get("returnTo"), retornoAviso, "SSO conserva destino interno no callback");
  for (const inseguro of ["https://outro.exemplo.test", "//outro.exemplo.test", "/api/sessao/sair", "/\\outro.exemplo.test"]) {
    const inicioInseguro = await contexto.request.get(`${base}/entrar?returnTo=${encodeURIComponent(inseguro)}`, { maxRedirects: 0 });
    assert.equal(new URL(inicioInseguro.headers().location).searchParams.get("returnTo"), `${base}/api/sessao/sso`, "retorno invalido volta ao callback padrao");
  }
  await contexto.addCookies([{ name: "avila_sso", value: "prova-exclusiva-do-teste-ci", domain: "127.0.0.1", path: "/", httpOnly: true, secure: true }]);
  modoSso = "mfa";
  const fatorSso = await contexto.request.get(callbackComDestino.href, { maxRedirects: 0 });
  assert.equal(new URL(new URL(fatorSso.headers().location).searchParams.get("returnTo")).searchParams.get("returnTo"), retornoAviso, "MFA conserva destino do aviso");
  modoSso = "permitido";
  const callbackPermitido = await contexto.request.get(callbackComDestino.href, { maxRedirects: 0 });
  assert.equal(callbackPermitido.headers().location, `${base}${retornoAviso}`);
  await pagina.goto(callbackPermitido.headers().location);
  await pagina.getByRole("heading", { name: "Mensagem exata do aviso CI", exact: true }).waitFor();
  modoSso = "revogado";
  const contextoDedup = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const aba1 = await contextoDedup.newPage();
    await aba1.goto(`${base}/entrar?local=1`);
    const workerCriado = contextoDedup.waitForEvent("serviceworker");
    await aba1.evaluate(async () => { await navigator.serviceWorker.register("/sw.js", { scope: "/" }); await navigator.serviceWorker.ready; });
    const worker = await workerCriado;
    await worker.evaluate(() => {
      self.exibidosCi = 0;
      self.falharAvisoCi = false;
      self.registration.showNotification = async () => { if (self.falharAvisoCi) throw new Error("Recusa controlada CI"); self.exibidosCi++; };
    });
    const aba2 = await contextoDedup.newPage();
    await aba2.goto(`${base}/entrar?local=1`);
    const mandarAviso = (aba, aviso) => aba.evaluate(async (dados) => {
      const registro = await navigator.serviceWorker.ready;
      return new Promise((resolve, reject) => {
        const canal = new MessageChannel();
        const limite = setTimeout(() => { canal.port1.close(); reject(new Error("Worker nao confirmou aviso CI")); }, 5000);
        canal.port1.onmessage = (evento) => { clearTimeout(limite); canal.port1.close(); resolve(evento.data.ok); };
        registro.active.postMessage({ type: "mail:avisar", avisos: [dados] }, [canal.port2]);
      });
    }, aviso);
    const avisoUnico = { mailboxId: "caixa-dedup-ci", eventId: "evento-unico-ci", messageId: "mensagem-unica-ci", titulo: "Aviso CI", corpo: "Teste" };
    await Promise.all([mandarAviso(aba1, avisoUnico), mandarAviso(aba2, avisoUnico), worker.evaluate((aviso) => emitirAvisos([aviso]), avisoUnico)]);
    assert.equal(await worker.evaluate(() => self.exibidosCi), 1, "duas abas e caminho push compartilham uma reserva IndexedDB real");
    await worker.evaluate(async (aviso) => { await emitirAvisos([aviso, aviso]); }, { ...avisoUnico, eventId: "duplicado-no-lote" });
    assert.equal(await worker.evaluate(() => self.exibidosCi), 2, "evento repetido no mesmo lote nao duplica aviso");
    await worker.evaluate(() => { self.falharAvisoCi = true; });
    assert.equal(await mandarAviso(aba1, { ...avisoUnico, eventId: "falha-recuperavel" }), false);
    await worker.evaluate(() => { self.falharAvisoCi = false; });
    assert.equal(await mandarAviso(aba2, { ...avisoUnico, eventId: "falha-recuperavel" }), true);
    assert.equal(await worker.evaluate(() => self.exibidosCi), 3, "recusa do navegador libera reserva para uma tentativa posterior");
    await aba1.evaluate(() => navigator.serviceWorker.addEventListener("message", (evento) => {
      if (evento.data?.type === "mail:consultar") evento.ports[0]?.postMessage({ mailboxId: "caixa-dedup-ci", visivel: true });
    }));
    await aba1.bringToFront();
    await mandarAviso(aba2, { ...avisoUnico, eventId: "caixa-ja-visivel" });
    assert.equal(await worker.evaluate(() => self.exibidosCi), 3, "push nao avisa caixa que ja esta visivel em outra aba");
    await mandarAviso(aba1, { ...avisoUnico, mailboxId: "outra-caixa-ci" });
    assert.equal(await worker.evaluate(() => self.exibidosCi), 4, "deduplicacao e presenca sao isoladas por caixa");
  } finally { await contextoDedup.close(); }
  let saiuDoAuth = 0;
  let inicioNovoLogin = 0;
  await pagina.route("https://auth.exemplo.test/**", async (rota) => {
    const url = new URL(rota.request().url());
    if (url.pathname === "/api/auth/logout") {
      assert.equal(rota.request().method(), "POST");
      saiuDoAuth++;
      inicioNovoLogin = Date.now();
      await contexto.clearCookies({ name: "avila_sso" });
      // Playwright nao intercepta a proxima URL da mesma cadeia de redirect.
      // O retorno do emissor e exercitado separadamente sem resolver .test.
      await rota.fulfill({ status: 200, contentType: "text/html", body: "<h1>Sessao anterior encerrada</h1>" });
    } else {
      assert.equal(url.pathname, "/login");
      assert.ok(Date.now() - inicioNovoLogin >= 1000, "nova prova e solicitada depois da fronteira do segundo");
      await rota.fulfill({ status: 200, contentType: "text/html", body: "<h1>Novo login Auth</h1>" });
    }
  });
  await contexto.addCookies([{ name: "avila_sso", value: "prova-exclusiva-do-teste-ci", domain: "127.0.0.1", path: "/", httpOnly: true, secure: true }]);
  await pagina.goto(`${base}/api/sessao/sso`);
  assert.equal(new URL(pagina.url()).pathname, "/api/sessao/sso/reautenticar", "cookie revogado tem recuperacao explicita");
  assert.equal(saiuDoAuth, 0, "recuperacao nao encerra sessao global sem clique");
  await pagina.getByRole("button", { name: "Encerrar sessao anterior e entrar novamente" }).click();
  await pagina.getByRole("heading", { name: "Sessao anterior encerrada" }).waitFor();
  assert.equal(saiuDoAuth, 1);
  const novoLogin = await contexto.request.get(`${base}/api/sessao/sso/novo-login`, { maxRedirects: 0 });
  assert.equal(novoLogin.status(), 307);
  assert.equal(new URL(novoLogin.headers().location).origin, "https://auth.exemplo.test");
  assert.equal(new URL(novoLogin.headers().location).pathname, "/login");
  assert.ok(Date.now() - inicioNovoLogin >= 1000);
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
