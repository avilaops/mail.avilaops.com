import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Agent, createServer, request } from "node:http";
import { setTimeout as esperar } from "node:timers/promises";

// SIGTERM real precisa de POSIX: no Windows child.kill termina o processo
// imediatamente, sem exercitar os handlers. O CI roda este teste em Linux.
if (process.platform === "win32") {
  console.log("IGNORADO — encerramento por sinal exige Linux (executado no CI)");
  process.exit(0);
}

for (const sinal of ["SIGTERM", "SIGINT"]) {
  const fluxos = new Set();
  let liberarMutacao;
  let avisarMutacao;
  const mutacaoRecebida = new Promise((resolve) => { avisarMutacao = resolve; });
  const backend = createServer(async (req, res) => {
    for await (const parte of req) void parte;
    const json = (dados) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(dados));
    };
    if (req.url === "/v1/auth/login") return json({
      accessToken: "acesso-ci", refreshToken: "refresh-ci", expiresInSeconds: 3600,
      mailbox: { id: "teste", address: "teste@exemplo.test", displayName: "Teste" },
    });
    if (req.headers.authorization !== "Bearer acesso-ci") {
      res.writeHead(401);
      return res.end();
    }
    if (req.url?.startsWith("/v1/me/events")) {
      fluxos.add(res);
      res.once("close", () => fluxos.delete(res));
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`id: teste:1\nevent: ready\ndata: ${JSON.stringify({ cursor: req.headers["last-event-id"] })}\n\n`);
      return;
    }
    if (req.url === "/v1/me/messages/drafts" && req.method === "POST") {
      liberarMutacao = () => json({ id: "rascunho-ci" });
      avisarMutacao();
      return;
    }
    json({ id: "teste" });
  });
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  // Reserva uma porta livre antes de iniciar o standalone real do build.
  const reserva = createServer();
  reserva.listen(0, "127.0.0.1");
  await once(reserva, "listening");
  const porta = reserva.address().port;
  await new Promise((resolve) => reserva.close(resolve));
  const base = `http://127.0.0.1:${porta}`;
  const next = spawn(process.execPath, [".next/standalone/server.js"], {
    env: { ...process.env, PORT: String(porta), HOSTNAME: "127.0.0.1", COOKIE_SECURE: "false",
      SSO_ENABLED: "false", WEBMAIL_URL: base, MAIL_API_URL: `http://127.0.0.1:${backend.address().port}/v1` },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  next.stdout.on("data", (parte) => { logs += parte; });
  next.stderr.on("data", (parte) => { logs += parte; });
  const saiu = once(next, "exit");
  const clientes = [];
  const proxy = new Agent({ keepAlive: true, maxSockets: 1 });
  let consultando = true;
  let consultas;
  try {
    for (let tentativa = 0; ; tentativa++) {
      try { if ((await fetch(`${base}/entrar?local=1`, { signal: AbortSignal.timeout(2000) })).ok) break; } catch { /* inicializando */ }
      assert.ok(tentativa < 120 && next.exitCode === null && next.signalCode === null, `Standalone nao iniciou: ${logs}`);
      await esperar(250);
    }
    const login = await fetch(`${base}/api/sessao`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: "teste@exemplo.test", password: "somente-ci" }),
    });
    assert.equal(login.status, 200);
    const { csrf } = await login.json();
    const cookie = login.headers.getSetCookie().map((valor) => valor.split(";")[0]).join("; ");
    const abrir = async () => {
      const controller = new AbortController();
      clientes.push(controller);
      const resposta = await fetch(`${base}/api/mail/me/events`, {
        headers: { cookie, "last-event-id": "teste:0" }, signal: controller.signal,
      });
      assert.equal(resposta.status, 200);
      assert.match(resposta.headers.get("content-type"), /text\/event-stream/);
      const leitor = resposta.body.getReader();
      assert.match(new TextDecoder().decode((await leitor.read()).value), /"cursor":"teste:0"/);
      return { controller, leitor };
    };
    const cancelado = await abrir();
    cancelado.controller.abort();
    for (let i = 0; i < 40 && fluxos.size; i++) await esperar(50);
    assert.equal(fluxos.size, 0, "cliente fechado libera conexao na API");

    const abertos = [await abrir(), await abrir()];
    assert.equal(fluxos.size, 2, "duas conexoes SSE continuam ativas antes do sinal");
    // Como o Caddy, tenta reutilizar o socket do SSE para requests curtos
    // depois do EOF. A parada nao pode depender de o proxy ficar ocioso.
    const fluxoProxy = await new Promise((resolve, reject) => {
      const pedido = request(`${base}/api/mail/me/events`, { agent: proxy, headers: { cookie } }, resolve);
      pedido.once("error", reject);
      pedido.end();
    });
    fluxoProxy.on("error", () => {});
    fluxoProxy.resume();
    consultas = (async () => {
      while (consultando) {
        await new Promise((resolve) => {
          const pedido = request(`${base}/api/mail/me`, { agent: proxy, headers: { cookie } }, (resposta) => {
            resposta.resume();
            resposta.once("end", resolve);
            resposta.once("error", resolve);
          });
          pedido.once("error", resolve);
          pedido.setTimeout(1000, () => pedido.destroy());
          pedido.end();
        });
        await esperar(20);
      }
    })();
    const terminouFluxos = Promise.allSettled(abertos.map(async ({ leitor }) => {
      while (!(await leitor.read()).done) { /* aguarda EOF limpo */ }
    }));
    const mutacao = fetch(`${base}/api/mail/me/messages/drafts`, {
      method: "POST", headers: { cookie, "content-type": "application/json", "x-csrf-token": csrf }, body: "{}",
    }).then(async (resposta) => ({ status: resposta.status, dados: await resposta.json() }));
    await Promise.race([mutacaoRecebida, esperar(5000).then(() => { throw new Error("Mutacao nao chegou a API"); })]);
    const inicio = performance.now();
    next.kill(sinal);
    await esperar(300);
    assert.equal(next.exitCode, null, "encerramento aguarda requisicao comum em andamento");
    liberarMutacao();
    assert.deepEqual(await mutacao, { status: 200, dados: { id: "rascunho-ci" } });
    const limite = setTimeout(() => next.kill("SIGKILL"), 5000);
    const [codigo, sinalSaida] = await saiu;
    clearTimeout(limite);
    assert.equal(sinalSaida, null, `Encerramento precisou de parada forcada: ${logs}`);
    assert.ok(codigo === 0 || codigo === (sinal === "SIGTERM" ? 143 : 130), `Saida inesperada: ${codigo}; ${logs}`);
    for (const resultado of await terminouFluxos) assert.equal(resultado.status, "fulfilled", "SSE termina com EOF limpo");
    assert.equal(fluxos.size, 0, "encerramento libera todos os fluxos na API");
    assert.doesNotMatch(logs, /failed to pipe response|uncaught|unhandled/i);
    console.log(`PASSOU — ${sinal}: SSE fechado, rascunho concluido e processo encerrado em ${Math.round(performance.now() - inicio)}ms`);
  } finally {
    consultando = false;
    proxy.destroy();
    await consultas;
    clientes.forEach((cliente) => cliente.abort());
    if (next.exitCode === null && next.signalCode === null) next.kill("SIGKILL");
    await saiu;
    backend.closeAllConnections();
    await new Promise((resolve) => backend.close(resolve));
  }
}
