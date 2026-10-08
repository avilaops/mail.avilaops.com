/**
 * Smoke test do nucleo do avila-mail — roda sem banco e sem rede.
 *
 * Cobre os pontos onde um erro silencioso custa caro em producao:
 * normalizacao de endereco (entrega no lugar errado), cifra das chaves DKIM
 * (perda das chaves), assinatura DKIM (e-mail em spam) e armazenamento
 * (mensagem perdida ou path traversal).
 *
 *   npx tsx src/scripts/smoke.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A config e lida na importacao dos modulos, entao o ambiente vem antes.
const workDir = mkdtempSync(join(tmpdir(), "avila-mail-smoke-"));
process.env.MAIL_STORAGE_DIR = workDir;
process.env.MAIL_DKIM_ENCRYPTION_KEY ??= "0".repeat(64);
process.env.MAIL_DATABASE_URL ??= "postgresql://smoke:smoke@127.0.0.1:5432/smoke";
process.env.MAIL_HOSTNAME ??= "mail.avilaops.com";

const { parseAddress, stripSubaddress, isValidLocalPart } = await import("../lib/address.js");
const { encryptSecret, decryptSecret } = await import("../lib/crypto.js");
const { hashPassword, verifyPassword, generatePassword } = await import("../lib/password.js");
const { storeRaw, readRaw, deleteRaw } = await import("../lib/storage.js");
const { generateDkimKeyPair, dkimTxtValue, dkimCnameTarget } = await import("../mta/dkim.js");
const { dkimSign } = await import("mailauth/lib/dkim/sign.js");
const { simpleParser } = await import("mailparser");

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

console.log("\n[1] Normalizacao de endereco");
check("minusculiza dominio e parte local", parseAddress("Contato@Exemplo.COM.br")?.full === "contato@exemplo.com.br");
check("extrai de 'Nome <a@b>'", parseAddress("Ávila Ops <nicolas@avilaops.com>")?.full === "nicolas@avilaops.com");
check("recusa endereco sem dominio", parseAddress("semarroba") === null);
check("recusa dominio sem TLD", parseAddress("a@localhost") === null);
check("recusa ponto no inicio", parseAddress(".a@b.com") === null);
check("sub-enderecamento resolve para a base", stripSubaddress("contato+nota") === "contato");
check("recusa parte local com espaco", !isValidLocalPart("con tato"));

console.log("\n[2] Cifra dos segredos em repouso");
const secret = "-----BEGIN PRIVATE KEY-----\nconteudo sensivel\n-----END PRIVATE KEY-----";
const sealed = encryptSecret(secret);
check("ciclo cifra/decifra preserva o valor", decryptSecret(sealed) === secret);
check("texto cifrado nao contem o segredo", !sealed.includes("sensivel"));
check("dois ciframentos do mesmo valor diferem (IV aleatorio)", encryptSecret(secret) !== sealed);
check(
  "texto adulterado e rejeitado pelo authTag",
  await (async () => {
    const parts = sealed.split(":");
    parts[3] = Buffer.from("adulterado").toString("base64");
    try {
      decryptSecret(parts.join(":"));
      return false;
    } catch {
      return true;
    }
  })(),
);

console.log("\n[3] Senha de caixa");
const plain = generatePassword(16);
const hash = await hashPassword(plain);
check("senha gerada tem o tamanho pedido", plain.length === 16);
check("senha correta valida", await verifyPassword(plain, hash));
check("senha errada nao valida", !(await verifyPassword(`${plain}x`, hash)));
check("hash nao contem a senha", !hash.includes(plain));
check("hash novo e scrypt (nativo, sem JIT)", hash.startsWith("$scrypt$"));
{
  const { needsRehash } = await import("../lib/password.js");
  const bcrypt = (await import("bcryptjs")).default;
  const legado = bcrypt.hashSync(plain, 4);
  check("hash bcrypt legado continua valendo", await verifyPassword(plain, legado));
  check("hash bcrypt legado pede troca; scrypt nao", needsRehash(legado) && !needsRehash(hash));
}

console.log("\n[4] DKIM");
const keys = generateDkimKeyPair();
check("gera chave privada PKCS#8", keys.privateKeyPem.includes("BEGIN PRIVATE KEY"));
check("registro TXT no formato do RFC 6376", dkimTxtValue(keys.publicKeyBase64).startsWith("v=DKIM1; k=rsa; p="));
check("alvo do CNAME usa a zona da Avila", dkimCnameTarget("clientex.com.br") === "clientex-com-br.dkim.avilaops.com");

const sampleMessage = Buffer.from(
  [
    "From: Contato <contato@clientex.com.br>",
    "To: destino@gmail.com",
    "Subject: Teste de assinatura",
    "Date: Wed, 13 Aug 2026 10:00:00 +0000",
    "Message-ID: <smoke-1@clientex.com.br>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Corpo da mensagem de teste.",
    "",
  ].join("\r\n"),
);

const signed = await dkimSign(sampleMessage, {
  canonicalization: "relaxed/relaxed",
  algorithm: "rsa-sha256",
  signatureData: [
    {
      signingDomain: "clientex.com.br",
      selector: keys.selector,
      privateKey: keys.privateKeyPem,
      algorithm: "rsa-sha256",
    },
  ],
});

const signatureHeader = signed.signatures ?? "";
check("gera header DKIM-Signature", signatureHeader.includes("DKIM-Signature:"));
check("assina com o dominio correto", signatureHeader.includes("d=clientex.com.br"));
check("usa o seletor correto", signatureHeader.includes(`s=${keys.selector}`));
check("inclui hash do corpo (bh=)", /bh=[A-Za-z0-9+/=]+/.test(signatureHeader));

console.log("\n[5] Parsing da mensagem");
const parsed = await simpleParser(Buffer.concat([Buffer.from(signatureHeader), sampleMessage]));
check("extrai assunto", parsed.subject === "Teste de assinatura");
check("extrai remetente", parsed.from?.value[0]?.address === "contato@clientex.com.br");
check("extrai corpo", (parsed.text ?? "").includes("Corpo da mensagem de teste"));
check("preserva Message-ID", parsed.messageId === "<smoke-1@clientex.com.br>");

console.log("\n[6] Armazenamento das mensagens");
const blob = await storeRaw("smoke-msg-1", sampleMessage, new Date("2026-08-13T10:00:00Z"));
check("particiona por ano/mes", blob.storageKey === "2026/08/smoke-msg-1.eml.gz");
check("reporta o tamanho sem compressao", blob.sizeBytes === sampleMessage.byteLength);
check("ciclo grava/le preserva os bytes", (await readRaw(blob.storageKey)).equals(sampleMessage));
check(
  "recusa chave que escapa do diretorio",
  await (async () => {
    try {
      await readRaw("../../../etc/passwd");
      return false;
    } catch {
      return true;
    }
  })(),
);
await deleteRaw(blob.storageKey);
check(
  "remover blob inexistente e idempotente",
  await (async () => {
    try {
      await deleteRaw(blob.storageKey);
      return true;
    } catch {
      return false;
    }
  })(),
);

rmSync(workDir, { recursive: true, force: true });

console.log("\n[7] Rampa do aquecimento de IP");
{
  const { capDoDia, diaDoAquecimento, proximaJanelaUtc } = await import("../mta/warmup.js");
  const caps = [30, 60, 120] as const;
  const dia = (n: number) => new Date(Date.UTC(2026, 7, 19 + n, 15, 30));
  const inicio = "2026-08-19";

  check("dia 0 usa o teto da primeira semana", capDoDia(inicio, caps, dia(0)) === 30);
  check("dia 6 ainda esta na primeira semana", capDoDia(inicio, caps, dia(6)) === 30);
  check("dia 7 vira a segunda semana", capDoDia(inicio, caps, dia(7)) === 60);
  check("ultima semana usa o ultimo teto", capDoDia(inicio, caps, dia(20)) === 120);
  check("rampa concluida devolve null (sem teto)", capDoDia(inicio, caps, dia(21)) === null);
  check("antes do inicio vale o comeco conservador", capDoDia("2026-09-01", caps, dia(0)) === 30);
  check("dia do aquecimento nunca e negativo", diaDoAquecimento("2026-09-01", dia(0)) === 0);
  check(
    "orcamento renasce na proxima meia-noite UTC",
    proximaJanelaUtc(dia(0)).toISOString() === "2026-08-20T00:00:00.000Z",
  );
}

console.log("\n[8] TOTP contra os vetores do RFC 4226");
{
  const { base32Decode, base32Encode, codigoDoContador, verificarCodigoTotp, otpauthUrl, gerarCodigosDeRecuperacao } =
    await import("../lib/totp.js");

  // Segredo canonico dos RFCs 4226/6238: "12345678901234567890" em ASCII.
  const segredoRfc = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  check("base32 decodifica o segredo do RFC", base32Decode(segredoRfc).toString("ascii") === "12345678901234567890");
  check("base32 e reversivel", base32Encode(base32Decode(segredoRfc)) === segredoRfc);

  check("contador 0 gera 755224 (RFC 4226)", codigoDoContador(segredoRfc, 0) === "755224");
  check("contador 1 gera 287082", codigoDoContador(segredoRfc, 1) === "287082");
  check("contador 2 gera 359152", codigoDoContador(segredoRfc, 2) === "359152");

  const agora = new Date(59_000); // t=59s → contador 1
  check("codigo da janela atual passa", verificarCodigoTotp(segredoRfc, "287082", agora) === 1);
  check("codigo da janela anterior passa (relogio atrasado)", verificarCodigoTotp(segredoRfc, "755224", agora) === 0);
  check("codigo da janela seguinte passa (relogio adiantado)", verificarCodigoTotp(segredoRfc, "359152", agora) === 2);
  check("codigo errado nao passa", verificarCodigoTotp(segredoRfc, "000000", agora) === null);
  check("codigo fora de duas janelas nao passa", verificarCodigoTotp(segredoRfc, codigoDoContador(segredoRfc, 5), agora) === null);
  check("lixo nao-numerico nao passa", verificarCodigoTotp(segredoRfc, "abc123", agora) === null);

  const url = otpauthUrl("contato@brilhax.com.br", segredoRfc);
  check("otpauth carrega o segredo e o emissor", url.includes(`secret=${segredoRfc}`) && url.includes("issuer=Avila%20Mail"));

  const codigos = gerarCodigosDeRecuperacao();
  check("oito codigos de recuperacao", codigos.length === 8);
  check("no formato xxxxx-xxxxx", codigos.every((codigo) => /^[a-z2-7]{5}-[a-z2-7]{5}$/.test(codigo)));
  check("todos diferentes", new Set(codigos).size === 8);
}

console.log("\n[9] Leitura de vCard e iCalendar (indice do DAV)");
{
  const { desdobrarLinhas, lerVCard, lerDataIcal, lerDuracaoMs, lerEvento } = await import("../dav/ical.js");

  check(
    "linha continuada e desdobrada",
    desdobrarLinhas("FN:Maria\r\n  da Silva\r\nUID:x")[0] === "FN:Maria da Silva",
  );

  const vcard = lerVCard("BEGIN:VCARD\r\nVERSION:4.0\r\nUID:abc-123\r\nFN:Padaria Central\\, Matriz\r\nEND:VCARD\r\n");
  check("vCard: extrai UID", vcard?.uid === "abc-123");
  check("vCard: FN com virgula escapada", vcard?.fn === "Padaria Central, Matriz");
  check("corpo que nao e vCard e recusado", lerVCard("BEGIN:VCALENDAR\r\nEND:VCALENDAR") === null);

  check("data UTC", lerDataIcal("20260819T120000Z")?.data.toISOString() === "2026-08-19T12:00:00.000Z");
  check("dia inteiro marcado como tal", lerDataIcal("20260819")?.diaInteiro === true);
  check("lixo de data e null", lerDataIcal("amanha") === null);
  check("duracao PT1H30M", lerDuracaoMs("PT1H30M") === 5_400_000);

  const evento = lerEvento(
    [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:ev-1",
      "SUMMARY:Reuniao",
      "DTSTART:20260820T140000Z",
      "DTEND:20260820T150000Z",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  );
  check("VEVENT: UID e SUMMARY", evento?.uid === "ev-1" && evento?.summary === "Reuniao");
  check("VEVENT: janela lida", evento?.dtEnd?.toISOString() === "2026-08-20T15:00:00.000Z");
  check("VEVENT sem RRULE nao e recorrente", evento?.recurring === false);

  const diaInteiro = lerEvento(
    ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:ev-2", "DTSTART;VALUE=DATE:20260821", "RRULE:FREQ=WEEKLY", "END:VEVENT", "END:VCALENDAR"].join(
      "\r\n",
    ),
  );
  check("dia inteiro sem DTEND dura o dia", diaInteiro?.dtEnd?.toISOString() === "2026-08-22T00:00:00.000Z");
  check("RRULE marca recorrencia", diaInteiro?.recurring === true);
  check("iCalendar sem VEVENT e recusado", lerEvento("BEGIN:VCALENDAR\r\nEND:VCALENDAR") === null);
}

console.log("\n[higiene] Codigo-fonte sem bytes de controle");
{
  /**
   * Guarda contra um erro que ja aconteceu aqui.
   *
   * Ao consertar quebras de linha com script, um NUL e um backspace acabaram
   * gravados CRUS dentro de strings e regex. O NUL sobreviveu porque em JS
   * `"<NUL>"` e `"\0"` sao a mesma string em execucao — o codigo funcionava e
   * ninguem via. O backspace nao teve a mesma sorte: `/APPEND<BS>/` exige um
   * 0x08 no texto e nunca casa, entao a protecao que ele guardava ficou
   * desligada em silencio.
   *
   * Erro que compila, passa no teste e so aparece em producao merece um teste
   * proprio. Editor nenhum mostra esses bytes.
   */
  const { readdirSync, readFileSync: lerCru } = await import("node:fs");
  const { join: juntar } = await import("node:path");

  const PROIBIDOS = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

  function varrer(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const caminho = juntar(dir, item.name);
      if (item.isDirectory()) return varrer(caminho);
      return item.name.endsWith(".ts") ? [caminho] : [];
    });
  }

  const sujos = varrer("src").filter((arquivo) => PROIBIDOS.test(lerCru(arquivo, "latin1")));
  check(
    "nenhum arquivo .ts carrega byte de controle",
    sujos.length === 0,
    sujos.join(", "),
  );
}

console.log("\n[higiene+1] Casamento de regras de triagem");
{
  const { regraCasa } = await import("../services/rules.js");
  const mensagem = {
    from: "Boletos <cobranca@FORNECEDOR.com.br>".toLowerCase(),
    to: ["contato@minhaempresa.com.br", "financeiro@minhaempresa.com.br"],
    subject: "Fatura #123 — vencimento amanhã",
    hasAttachments: true,
  };

  check(
    "condicao de remetente ignora caixa alta",
    regraCasa("all", [{ field: "from", contains: "Fornecedor.com" }], mensagem),
  );
  check(
    "'all' exige todas as condicoes",
    !regraCasa(
      "all",
      [
        { field: "from", contains: "fornecedor" },
        { field: "subject", contains: "nota fiscal" },
      ],
      mensagem,
    ),
  );
  check(
    "'any' basta uma condicao",
    regraCasa(
      "any",
      [
        { field: "from", contains: "ninguem" },
        { field: "subject", contains: "fatura" },
      ],
      mensagem,
    ),
  );
  check(
    "condicao de destinatario cobre To e Cc",
    regraCasa("all", [{ field: "to", contains: "financeiro@" }], mensagem),
  );
  check("condicao de anexo casa quando ha anexo", regraCasa("all", [{ field: "has_attachment" }], mensagem));
  check(
    "condicao de anexo nao casa sem anexo",
    !regraCasa("all", [{ field: "has_attachment" }], { ...mensagem, hasAttachments: false }),
  );
  check("sem condicoes nunca casa", !regraCasa("all", [], mensagem));
  check(
    "condicao de texto vazia nunca casa (nao vira pega-tudo)",
    !regraCasa("all", [{ field: "subject", contains: "" }], mensagem),
  );

  // A regra do "encaminhar tudo" do painel depende de casar com QUALQUER
  // mensagem. Se estas deixarem de valer, o encaminhamento passa a perder
  // mensagem em silencio — que e o pior jeito de um encaminhamento falhar.
  const pegaTudo = [
    { field: "from" as const, contains: "@" },
    { field: "to" as const, contains: "@" },
  ];
  check("pega-tudo casa com mensagem comum", regraCasa("any", pegaTudo, mensagem));
  check(
    "pega-tudo casa mesmo sem destinatario visivel (Cco)",
    regraCasa("any", pegaTudo, { ...mensagem, to: [] }),
  );
  check(
    "pega-tudo casa com assunto vazio e sem anexo",
    regraCasa("any", pegaTudo, { ...mensagem, subject: "", hasAttachments: false }),
  );
  check(
    "pega-tudo nao casa quando nao ha remetente nem destinatario",
    !regraCasa("any", pegaTudo, { from: "", to: [], subject: "x", hasAttachments: false }),
  );
}

console.log("\n[higiene+2] Chaves de API (area de desenvolvedor)");
{
  const { gerarToken, hashToken, escopoDoToken, prefixoVisivel } = await import("../services/apiKeys.js");
  const caixa = gerarToken("mailbox");
  const prov = gerarToken("provisioning");
  check("token de caixa comeca com amk_m_", caixa.startsWith("amk_m_"));
  check("token de provisionamento comeca com amk_p_", prov.startsWith("amk_p_"));
  check("token tem 160 bits aleatorios (40 hex)", /^amk_[mp]_[0-9a-f]{40}$/.test(caixa) && /^amk_[mp]_[0-9a-f]{40}$/.test(prov));
  check("dois tokens nunca coincidem", gerarToken("mailbox") !== caixa);
  check("escopo sai do prefixo", escopoDoToken(caixa) === "mailbox" && escopoDoToken(prov) === "provisioning");
  check("token estranho nao tem escopo", escopoDoToken("Bearer xyz") === null && escopoDoToken("amk_x_abc") === null);
  check("hash e deterministico e nao contem o token", hashToken(caixa) === hashToken(caixa) && !hashToken(caixa).includes(caixa.slice(6, 20)));
  check("prefixo visivel nao entrega a chave", prefixoVisivel(caixa).length === 13 && !caixa.endsWith(prefixoVisivel(caixa)));
}

console.log("");
console.log("[higiene+3] Silencio noturno do aviso");
{
  // A regra pura, replicada aqui: janela que cruza a meia-noite (22h -> 7h)
  // e o caso comum, e inverter a comparacao silencia o dia inteiro.
  const dentro = (inicio: number | null, fim: number | null, hora: number): boolean => {
    if (inicio === null || fim === null || inicio === fim) return false;
    return inicio < fim ? hora >= inicio && hora < fim : hora >= inicio || hora < fim;
  };
  check("22h-7h silencia as 23h", dentro(22, 7, 23));
  check("22h-7h silencia as 3h", dentro(22, 7, 3));
  check("22h-7h NAO silencia as 9h", !dentro(22, 7, 9));
  check("22h-7h NAO silencia as 21h", !dentro(22, 7, 21));
  check("janela normal 13h-14h silencia as 13h", dentro(13, 14, 13));
  check("janela normal 13h-14h nao silencia as 14h", !dentro(13, 14, 14));
  check("sem janela definida nunca silencia", !dentro(null, null, 3) && !dentro(22, null, 3));
  check("inicio igual ao fim nao silencia o dia inteiro", !dentro(8, 8, 8));
}

console.log("");
console.log("[higiene+4] Conferencia diaria de DNS: gravidade e politica DMARC");
{
  const { gravidadeDe, politicaNoRegistro } = await import("../services/conferenciaDeDns.js");
  const tudoOk = { mx: true, spf: true, dkim: true, dmarc: true };

  check("dominio inteiro publicado fica ok", gravidadeDe(tudoOk, "reject") === "ok");

  // Nao receber e-mail e pior do que enviar mal: MX manda na classificacao.
  check("MX quebrado e critico mesmo sem DMARC", gravidadeDe({ ...tudoOk, mx: false }, null) === "critico");
  check(
    "MX quebrado vence os outros",
    gravidadeDe({ mx: false, spf: false, dkim: false, dmarc: false }, "none") === "critico",
  );

  /**
   * O caso que originou esta rotina: em 31/08/2026 tres dominios enviavam sem
   * DKIM, dois com `p=reject`. Assinatura quebrada com politica que manda
   * recusar nao e "pode cair no spam" — e entrega recusada no destino, e
   * precisa chegar como critico.
   */
  check("DKIM quebrado com p=reject e critico", gravidadeDe({ ...tudoOk, dkim: false }, "reject") === "critico");
  check(
    "DKIM quebrado com p=quarantine e critico",
    gravidadeDe({ ...tudoOk, dkim: false }, "quarantine") === "critico",
  );
  check("DKIM quebrado com p=none e so aviso", gravidadeDe({ ...tudoOk, dkim: false }, "none") === "aviso");
  check("DKIM quebrado sem DMARC e so aviso", gravidadeDe({ ...tudoOk, dkim: false, dmarc: false }, null) === "aviso");
  check("SPF faltando e aviso", gravidadeDe({ ...tudoOk, spf: false }, "none") === "aviso");
  check("DMARC faltando e aviso", gravidadeDe({ ...tudoOk, dmarc: false }, null) === "aviso");

  check("le p=reject", politicaNoRegistro(["v=DMARC1; p=reject; rua=mailto:a@b.com"]) === "reject");
  check("le p=quarantine com espacos", politicaNoRegistro(["v=DMARC1 ;  p = quarantine "]) === "quarantine");
  check("le p=none", politicaNoRegistro(["v=DMARC1; p=none"]) === "none");
  check("maiusculas nao atrapalham", politicaNoRegistro(["V=DMARC1; P=REJECT"]) === "reject");
  check("sem registro DMARC devolve null", politicaNoRegistro([]) === null);
  check("TXT que nao e DMARC e ignorado", politicaNoRegistro(["v=spf1 include:_spf.avilaops.com ~all"]) === null);
  check("acha o DMARC no meio de outros TXT", politicaNoRegistro(["v=spf1 ~all", "v=DMARC1; p=reject"]) === "reject");

  // `sp=` e a politica dos subdominios; confundir com `p=` faria um dominio
  // com `p=none` ser lido como reject e virar alarme falso todo dia.
  check("sp=reject nao e confundido com p=", politicaNoRegistro(["v=DMARC1; sp=reject; p=none"]) === "none");

  // Registro sem `p=` e invalido pela RFC 7489; conta como none, que e o
  // efeito pratico nos provedores.
  check("DMARC sem p= conta como none", politicaNoRegistro(["v=DMARC1; rua=mailto:a@b.com"]) === "none");
}

console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} verificacoes ok, ${failed} falhas\n`);
process.exit(failed === 0 ? 0 : 1);
