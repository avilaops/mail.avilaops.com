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
const { adicionarExdate, adicionarOuSubstituirExcecao, anexarParticaoFutura, componenteDeExcecao, deslocarRecorrencias, limitarSerieAntes, particionarSerie, serieSemExclusoes } = await import("../services/calendar-scope.js");
const { expandirRecorrencias: expandirRecorrenciasEscopo } = await import("../dav/recorrencia.js");
const { lembretesPendentesDoItem } = await import("../services/calendar-reminders.js");
const { extrairIcalDaMensagem } = await import("../services/calendar-invites.js");
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
  const { desdobrarLinhas, dobrarLinhaIcal, escaparTextoIcal, gerarEventoIcal, lerVCard, lerDataIcal, lerDuracaoMs, lerEvento } =
    await import("../dav/ical.js");

  check(
    "linha continuada e desdobrada",
    desdobrarLinhas("FN:Maria\r\n  da Silva\r\nUID:x")[0] === "FN:Maria da Silva",
  );

  const vcard = lerVCard("BEGIN:VCARD\r\nVERSION:4.0\r\nUID:abc-123\r\nFN:Padaria Central\\, Matriz\r\nEND:VCARD\r\n");
  check("vCard: extrai UID", vcard?.uid === "abc-123");
  check("vCard: FN com virgula escapada", vcard?.fn === "Padaria Central, Matriz");
  check("corpo que nao e vCard e recusado", lerVCard("BEGIN:VCALENDAR\r\nEND:VCALENDAR") === null);

  check("data UTC", lerDataIcal("20260819T120000Z")?.data.toISOString() === "2026-08-19T12:00:00.000Z");
  check(
    "data com TZID IANA vira o instante UTC correto",
    lerDataIcal("20260819T120000", { tzid: "America/Sao_Paulo" })?.data.toISOString() === "2026-08-19T15:00:00.000Z",
  );
  check(
    "data com TZID do Outlook vira o instante UTC correto",
    lerDataIcal("20260819T120000", { tzid: "E. South America Standard Time" })?.data.toISOString() ===
      "2026-08-19T15:00:00.000Z",
  );
  check(
    "data flutuante usa America/Sao_Paulo por padrao",
    lerDataIcal("20260819T120000")?.data.toISOString() === "2026-08-19T15:00:00.000Z",
  );
  check(
    "data flutuante respeita o fuso da caixa",
    lerDataIcal("20260819T120000", { fusoPadrao: "America/Manaus" })?.data.toISOString() === "2026-08-19T16:00:00.000Z",
  );
  check("dia inteiro marcado como tal", lerDataIcal("20260819")?.diaInteiro === true);
  check(
    "dia inteiro nao sofre deslocamento de fuso",
    lerDataIcal("20260819", { tzid: "America/Sao_Paulo" })?.data.toISOString() === "2026-08-19T00:00:00.000Z",
  );
  check(
    "fuso IANA usa deslocamento de inverno da data",
    lerDataIcal("20260115T120000", { tzid: "America/New_York" })?.data.toISOString() === "2026-01-15T17:00:00.000Z",
  );
  check(
    "fuso IANA usa deslocamento de verao da data",
    lerDataIcal("20260715T120000", { tzid: "America/New_York" })?.data.toISOString() === "2026-07-15T16:00:00.000Z",
  );
  check(
    "hora inexistente na entrada do horario de verao e recusada",
    lerDataIcal("20260308T023000", { tzid: "America/New_York" }) === null,
  );
  check(
    "hora ambigua escolhe a primeira ocorrencia",
    lerDataIcal("20261101T013000", { tzid: "America/New_York" })?.data.toISOString() === "2026-11-01T05:30:00.000Z",
  );
  check(
    "hora ambigua europeia escolhe a primeira ocorrencia",
    lerDataIcal("20261025T023000", { tzid: "Europe/Berlin" })?.data.toISOString() === "2026-10-25T00:30:00.000Z",
  );
  check(
    "hora ambigua com transicao de meia hora escolhe a primeira ocorrencia",
    lerDataIcal("20260405T014500", { tzid: "Australia/Lord_Howe" })?.data.toISOString() === "2026-04-04T14:45:00.000Z",
  );
  check("TZID invalido e recusado", lerDataIcal("20260819T120000", { tzid: "Fuso/Inexistente" }) === null);
  check("lixo de data e null", lerDataIcal("amanha") === null);
  check("duracao PT1H30M", lerDuracaoMs("PT1H30M") === 5_400_000);
  check(
    "iCalendar escapa barra, separadores e quebra de linha",
    escaparTextoIcal("A\\B,C;D\r\nE") === "A\\\\B\\,C\\;D\\nE",
  );

  const linhaAscii = `DESCRIPTION:${"a".repeat(70)}`;
  const dobradaAscii = dobrarLinhaIcal(linhaAscii);
  check("dobra iCalendar limita linha ASCII a 75 octetos", dobradaAscii.every((linha) => Buffer.byteLength(linha) <= 75));
  check("dobra iCalendar continua com espaco", dobradaAscii.length === 2 && dobradaAscii[1]?.startsWith(" ") === true);
  check("desdobrar recupera a linha ASCII original", desdobrarLinhas(dobradaAscii.join("\r\n"))[0] === linhaAscii);

  const linhaUtf8 = `SUMMARY:${"á".repeat(33)}😀`;
  const dobradaUtf8 = dobrarLinhaIcal(linhaUtf8);
  check("dobra iCalendar nao excede 75 octetos com UTF-8", dobradaUtf8.every((linha) => Buffer.byteLength(linha) <= 75));
  check("dobra iCalendar nao corrompe caractere UTF-8", desdobrarLinhas(dobradaUtf8.join("\r\n"))[0] === linhaUtf8);

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

  const eventoComFuso = lerEvento(
    [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:ev-tzid",
      "DTSTART;TZID=America/Sao_Paulo:20260820T140000",
      "DTEND;TZID=America/Sao_Paulo:20260820T150000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  );
  check("VEVENT: DTSTART respeita TZID IANA", eventoComFuso?.dtStart?.toISOString() === "2026-08-20T17:00:00.000Z");
  check("VEVENT: DTEND respeita TZID IANA", eventoComFuso?.dtEnd?.toISOString() === "2026-08-20T18:00:00.000Z");

  const eventoOutlook = lerEvento(
    [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:ev-outlook",
      "DTSTART;TZID=E. South America Standard Time:20260820T140000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  );
  check("VEVENT: DTSTART respeita TZID do Outlook", eventoOutlook?.dtStart?.toISOString() === "2026-08-20T17:00:00.000Z");

  const eventoFlutuante = lerEvento(
    ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:ev-flutuante", "DTSTART:20260820T140000", "END:VEVENT", "END:VCALENDAR"].join(
      "\r\n",
    ),
    { fusoPadrao: "America/Manaus" },
  );
  check("VEVENT: data flutuante usa o fuso da caixa", eventoFlutuante?.dtStart?.toISOString() === "2026-08-20T18:00:00.000Z");

  const eventoFusosDiferentes = lerEvento(
    [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:ev-fusos",
      "DTSTART;TZID=America/Sao_Paulo:20260820T140000",
      "DTEND;TZID=America/New_York:20260820T150000",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  );
  check(
    "VEVENT: DTSTART e DTEND aceitam fusos independentes",
    eventoFusosDiferentes?.dtStart?.toISOString() === "2026-08-20T17:00:00.000Z" &&
      eventoFusosDiferentes.dtEnd?.toISOString() === "2026-08-20T19:00:00.000Z",
  );

  const eventoComDuracao = lerEvento(
    [
      "BEGIN:VCALENDAR",
      "BEGIN:VEVENT",
      "UID:ev-duracao",
      "DTSTART;TZID=America/Sao_Paulo:20260820T140000",
      "DURATION:PT1H30M",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n"),
  );
  check("VEVENT: DURATION parte do instante convertido", eventoComDuracao?.dtEnd?.toISOString() === "2026-08-20T18:30:00.000Z");

  const icalGerado = gerarEventoIcal({
    uid: "agenda-123@avilaops.com",
    titulo: "Reuniao, vendas; sul",
    inicio: "2026-09-03T13:00:00.000Z",
    fim: "2026-09-03T14:30:00.000Z",
    diaInteiro: false,
    fuso: "America/Sao_Paulo",
    criadoEm: "2026-08-01T10:00:00.000Z",
    modificadoEm: "2026-08-02T11:00:00.000Z",
    dtstamp: "2026-08-02T11:00:00.000Z",
    sequencia: 4,
    local: "Sala 1, matriz",
    descricao: "Pauta A; Pauta B\nFechamento",
    recorrencia: "FREQ=WEEKLY;BYDAY=TH",
    lembretes: [{ minutosAntes: 15 }],
    convidados: [
      { email: "maria@example.com", nome: "Maria, Compras", resposta: "aceito" },
      { email: "joao@example.com", resposta: "pendente" },
    ],
    organizador: "dono@avilaops.com",
    disponibilidade: "livre",
  });
  const linhasGeradas = desdobrarLinhas(icalGerado);
  check("gerador cria VCALENDAR completo", linhasGeradas[0] === "BEGIN:VCALENDAR" && linhasGeradas.at(-1) === "END:VCALENDAR");
  check("gerador inclui PRODID", linhasGeradas.includes("PRODID:-//Avila Ops//Avila Mail//PT-BR"));
  check("gerador inclui UID estavel e SEQUENCE", linhasGeradas.includes("UID:agenda-123@avilaops.com") && linhasGeradas.includes("SEQUENCE:4"));
  check(
    "gerador inclui timestamps UTC",
    linhasGeradas.includes("DTSTAMP:20260802T110000Z") &&
      linhasGeradas.includes("CREATED:20260801T100000Z") &&
      linhasGeradas.includes("LAST-MODIFIED:20260802T110000Z"),
  );
  check(
    "gerador inclui datas locais com TZID",
    linhasGeradas.includes("DTSTART;TZID=America/Sao_Paulo:20260903T100000") &&
      linhasGeradas.includes("DTEND;TZID=America/Sao_Paulo:20260903T113000"),
  );
  check(
    "gerador inclui VTIMEZONE correspondente",
    linhasGeradas.includes("BEGIN:VTIMEZONE") && linhasGeradas.includes("TZID:America/Sao_Paulo"),
  );
  check("gerador escapa campos TEXT", linhasGeradas.includes("SUMMARY:Reuniao\\, vendas\\; sul"));
  check(
    "gerador inclui local, descricao e recorrencia",
    linhasGeradas.includes("LOCATION:Sala 1\\, matriz") &&
      linhasGeradas.includes("DESCRIPTION:Pauta A\\; Pauta B\\nFechamento") &&
      linhasGeradas.includes("RRULE:FREQ=WEEKLY;BYDAY=TH"),
  );
  check(
    "gerador inclui organizador e convidados",
    linhasGeradas.includes("ORGANIZER:mailto:dono@avilaops.com") &&
      linhasGeradas.includes('ATTENDEE;CN="Maria, Compras";PARTSTAT=ACCEPTED:mailto:maria@example.com') &&
      linhasGeradas.includes("ATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:joao@example.com"),
  );
  check(
    "gerador inclui VALARM e disponibilidade",
    linhasGeradas.includes("TRIGGER:-PT15M") && linhasGeradas.includes("TRANSP:TRANSPARENT"),
  );
  check("gerador termina com CRLF", icalGerado.endsWith("\r\n"));

  const relido = lerEvento(icalGerado);
  check(
    "ida e volta preserva identidade, titulo e janela",
    relido?.uid === "agenda-123@avilaops.com" &&
      relido.summary === "Reuniao, vendas; sul" &&
      relido.dtStart?.toISOString() === "2026-09-03T13:00:00.000Z" &&
      relido.dtEnd?.toISOString() === "2026-09-03T14:30:00.000Z",
  );
  check(
    "ida e volta preserva metadados do evento",
    relido?.sequence === 4 &&
      relido.location === "Sala 1, matriz" &&
      relido.description === "Pauta A; Pauta B\nFechamento" &&
      relido.rrule === "FREQ=WEEKLY;BYDAY=TH" &&
      relido.organizer === "dono@avilaops.com" &&
      relido.transparency === "TRANSPARENT",
  );
  check(
    "ida e volta preserva convidados e lembretes",
    relido?.attendees.length === 2 && relido.attendees[0]?.resposta === "aceito" && relido.reminders[0]?.minutosAntes === 15,
  );

  const icalDiaInteiro = gerarEventoIcal({
    uid: "feriado-1",
    titulo: "Feriado",
    inicio: "2026-09-07T00:00:00.000Z",
    fim: "2026-09-08T00:00:00.000Z",
    diaInteiro: true,
    fuso: "America/Sao_Paulo",
    criadoEm: "2026-08-01T10:00:00.000Z",
    modificadoEm: "2026-08-01T10:00:00.000Z",
    dtstamp: "2026-08-01T10:00:00.000Z",
    sequencia: 0,
    lembretes: [{ minutosAntes: 0 }],
    convidados: [],
    disponibilidade: "ocupado",
  });
  const linhasDiaInteiro = desdobrarLinhas(icalDiaInteiro);
  check(
    "evento de dia inteiro usa VALUE=DATE com fim exclusivo",
    linhasDiaInteiro.includes("DTSTART;VALUE=DATE:20260907") && linhasDiaInteiro.includes("DTEND;VALUE=DATE:20260908"),
  );
  check("SEQUENCE zero e preservado", linhasDiaInteiro.includes("SEQUENCE:0"));
  check("lembrete zero e preservado", linhasDiaInteiro.includes("TRIGGER:PT0M"));
  check("ocupado gera TRANSP opaco", linhasDiaInteiro.includes("TRANSP:OPAQUE"));
  check("DESCRIPTION do VALARM nao vira descricao do evento", lerEvento(icalDiaInteiro)?.description === null);

  const eventoOriginalComExtensoes = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:externo-1",
    "DTSTART:20260910T120000Z",
    "DTEND:20260910T130000Z",
    "SUMMARY:Evento externo",
    "X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS=Rua Muito Longa:https://",
    " maps.apple.com/?q=escritorio",
    "X-MICROSOFT-CDO-BUSYSTATUS:BUSY",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const dadosEditados = {
    uid: "externo-1",
    titulo: "Evento editado",
    inicio: "2026-09-10T12:00:00.000Z",
    fim: "2026-09-10T13:00:00.000Z",
    diaInteiro: false,
    fuso: "UTC",
    criadoEm: "2026-08-01T10:00:00.000Z",
    modificadoEm: "2026-08-03T10:00:00.000Z",
    dtstamp: "2026-08-03T10:00:00.000Z",
    sequencia: 1,
    lembretes: [],
    convidados: [],
    disponibilidade: "ocupado" as const,
  };
  const primeiraEdicao = gerarEventoIcal(dadosEditados, { original: eventoOriginalComExtensoes });
  const segundaEdicao = gerarEventoIcal({ ...dadosEditados, sequencia: 2 }, { original: primeiraEdicao });
  const linhasSegundaEdicao = desdobrarLinhas(segundaEdicao);
  check(
    "edicao preserva extensao X-APPLE dobrada",
    linhasSegundaEdicao.includes(
      "X-APPLE-STRUCTURED-LOCATION;VALUE=URI;X-ADDRESS=Rua Muito Longa:https://maps.apple.com/?q=escritorio",
    ),
  );
  check("edicao preserva extensao X-MICROSOFT", linhasSegundaEdicao.includes("X-MICROSOFT-CDO-BUSYSTATUS:BUSY"));
  check(
    "edicoes repetidas nao duplicam extensoes",
    linhasSegundaEdicao.filter((linha) => linha.startsWith("X-APPLE-STRUCTURED-LOCATION")).length === 1 &&
      linhasSegundaEdicao.filter((linha) => linha.startsWith("X-MICROSOFT-CDO-BUSYSTATUS")).length === 1,
  );

  const rejeitaEvento = (alteracoes: Record<string, unknown>): boolean => {
    try {
      gerarEventoIcal({ ...dadosEditados, ...alteracoes });
      return false;
    } catch {
      return true;
    }
  };
  check(
    "RRULE nao permite injecao de propriedade",
    rejeitaEvento({ recorrencia: "FREQ=DAILY\r\nATTENDEE:mailto:intruso@example.com" }),
  );
  check("organizador nao permite injecao", rejeitaEvento({ organizador: "dono@example.com\r\nX-INJETADO:sim" }));
  check(
    "email de convidado nao permite injecao",
    rejeitaEvento({ convidados: [{ email: "maria@example.com\r\nX-INJETADO:sim", resposta: "aceito" }] }),
  );
  check("TZID nao permite injecao", rejeitaEvento({ fuso: "America/Sao_Paulo\r\nX-INJETADO:sim" }));
  check("data civil impossivel e recusada", rejeitaEvento({ inicio: "2026-02-30T10:00:00.000Z" }));
  check("fim anterior ao inicio e recusado", rejeitaEvento({ fim: "2026-09-10T11:59:59.000Z" }));
  check("SEQUENCE negativo e recusado", rejeitaEvento({ sequencia: -1 }));
  check("SEQUENCE fracionario e recusado", rejeitaEvento({ sequencia: 0.5 }));
  check("RRULE invalida e recusada", rejeitaEvento({ recorrencia: "FREQ=INVALID" }));

  const convidadoEspecial = gerarEventoIcal({
    ...dadosEditados,
    convidados: [{ email: "maria@example.com", nome: "Maria: Compras; PARTSTAT=DECLINED, literal ^n e ^'", resposta: "aceito" }],
  });
  const relidoEspecial = lerEvento(convidadoEspecial);
  check(
    "parametro CN quoted preserva delimitadores e carets literais",
    relidoEspecial?.attendees[0]?.email === "maria@example.com" &&
      relidoEspecial.attendees[0].nome === "Maria: Compras; PARTSTAT=DECLINED, literal ^n e ^'" &&
      relidoEspecial.attendees[0].resposta === "aceito",
  );

  const eventoNaSegundaOcorrencia = gerarEventoIcal({
    ...dadosEditados,
    inicio: "2026-11-01T06:30:00.000Z",
    fim: "2026-11-01T07:30:00.000Z",
    fuso: "America/New_York",
  });
  const relidoNaSegundaOcorrencia = lerEvento(eventoNaSegundaOcorrencia);
  check(
    "ida e volta preserva segunda ocorrencia em sobreposicao DST",
    relidoNaSegundaOcorrencia?.dtStart?.toISOString() === "2026-11-01T06:30:00.000Z" &&
      relidoNaSegundaOcorrencia.dtEnd?.toISOString() === "2026-11-01T07:30:00.000Z",
  );

  const diaInteiro = lerEvento(
    ["BEGIN:VCALENDAR", "BEGIN:VEVENT", "UID:ev-2", "DTSTART;VALUE=DATE:20260821", "RRULE:FREQ=WEEKLY", "END:VEVENT", "END:VCALENDAR"].join(
      "\r\n",
    ),
  );
  check("dia inteiro sem DTEND dura o dia", diaInteiro?.dtEnd?.toISOString() === "2026-08-22T00:00:00.000Z");
  check("RRULE marca recorrencia", diaInteiro?.recurring === true);
  check("iCalendar sem VEVENT e recusado", lerEvento("BEGIN:VCALENDAR\r\nEND:VCALENDAR") === null);
}

console.log("\n[10] Expansao de recorrencia da agenda");
{
  const { expandirRecorrencias } = await import("../dav/recorrencia.js");
  const calendario = (dtstart: string, dtend: string, rrule: string, extras: string[] = []) =>
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "BEGIN:VEVENT",
      "UID:rec-1",
      "SUMMARY:Recorrente",
      `DTSTART:${dtstart}`,
      `DTEND:${dtend}`,
      `RRULE:${rrule}`,
      ...extras,
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
  const janela = { inicio: new Date("2026-01-01T00:00:00.000Z"), fim: new Date("2029-01-01T00:00:00.000Z") };
  const inicios = (ical: string) => expandirRecorrencias(ical, janela).map((ocorrencia) => ocorrencia.inicio.toISOString());

  check(
    "recorrencia diaria respeita COUNT",
    JSON.stringify(inicios(calendario("20260101T090000Z", "20260101T100000Z", "FREQ=DAILY;COUNT=3"))) ===
      JSON.stringify(["2026-01-01T09:00:00.000Z", "2026-01-02T09:00:00.000Z", "2026-01-03T09:00:00.000Z"]),
  );
  check(
    "recorrencia semanal escolhe os dias",
    JSON.stringify(inicios(calendario("20260101T090000Z", "20260101T100000Z", "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4"))) ===
      JSON.stringify([
        "2026-01-05T09:00:00.000Z",
        "2026-01-07T09:00:00.000Z",
        "2026-01-12T09:00:00.000Z",
        "2026-01-14T09:00:00.000Z",
      ]),
  );
  check(
    "recorrencia mensal encontra a segunda terca",
    JSON.stringify(inicios(calendario("20260113T090000Z", "20260113T100000Z", "FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2;COUNT=3"))) ===
      JSON.stringify(["2026-01-13T09:00:00.000Z", "2026-02-10T09:00:00.000Z", "2026-03-10T09:00:00.000Z"]),
  );
  check(
    "recorrencia anual preserva mes e dia",
    JSON.stringify(inicios(calendario("20260320T090000Z", "20260320T100000Z", "FREQ=YEARLY;COUNT=2"))) ===
      JSON.stringify(["2026-03-20T09:00:00.000Z", "2027-03-20T09:00:00.000Z"]),
  );
  check(
    "recorrencia respeita UNTIL inclusivo",
    JSON.stringify(inicios(calendario("20260101T090000Z", "20260101T100000Z", "FREQ=DAILY;UNTIL=20260103T090000Z"))) ===
      JSON.stringify(["2026-01-01T09:00:00.000Z", "2026-01-02T09:00:00.000Z", "2026-01-03T09:00:00.000Z"]),
  );
  check(
    "recorrencia infinita para no limite",
    (() => {
      try {
        expandirRecorrencias(calendario("20260101T090000Z", "20260101T100000Z", "FREQ=DAILY"), { ...janela, limite: 2 });
        return false;
      } catch (error) {
        return error instanceof Error && error.message.includes("limite");
      }
    })(),
  );

  check(
    "RDATE adiciona ocorrencia fora da RRULE",
    JSON.stringify(
      inicios(calendario("20260101T090000Z", "20260101T100000Z", "FREQ=DAILY;COUNT=2", ["RDATE:20260110T090000Z"])),
    ) === JSON.stringify(["2026-01-01T09:00:00.000Z", "2026-01-02T09:00:00.000Z", "2026-01-10T09:00:00.000Z"]),
  );
  check(
    "EXDATE remove ocorrencia da RRULE",
    JSON.stringify(
      inicios(calendario("20260101T090000Z", "20260101T100000Z", "FREQ=DAILY;COUNT=3", ["EXDATE:20260102T090000Z"])),
    ) === JSON.stringify(["2026-01-01T09:00:00.000Z", "2026-01-03T09:00:00.000Z"]),
  );

  const calendarioComExcecao = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:rec-excecao",
    "SUMMARY:Serie",
    "DTSTART:20260101T090000Z",
    "DTEND:20260101T100000Z",
    "RRULE:FREQ=DAILY;COUNT=3",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:rec-excecao",
    "RECURRENCE-ID:20260102T090000Z",
    "SUMMARY:Movida",
    "DTSTART:20260102T150000Z",
    "DTEND:20260102T160000Z",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  const ocorrenciasComExcecao = expandirRecorrencias(calendarioComExcecao, janela);
  check(
    "RECURRENCE-ID substitui a ocorrencia original pela movida",
    JSON.stringify(ocorrenciasComExcecao.map((ocorrencia) => ocorrencia.inicio.toISOString())) ===
      JSON.stringify(["2026-01-01T09:00:00.000Z", "2026-01-02T15:00:00.000Z", "2026-01-03T09:00:00.000Z"]),
  );
  check(
    "excecao movida preserva o identificador original",
    ocorrenciasComExcecao[1]?.recorrenciaId.toISOString() === "2026-01-02T09:00:00.000Z" &&
      ocorrenciasComExcecao[1]?.evento.summary === "Movida",
  );

  const excecaoForaDaJanela = calendarioComExcecao.replace("20260102T150000Z", "20260110T150000Z").replace(
    "20260102T160000Z",
    "20260110T160000Z",
  );
  const janelaCurta = { inicio: new Date("2026-01-01T00:00:00.000Z"), fim: new Date("2026-01-04T00:00:00.000Z") };
  check(
    "excecao movida para fora da janela remove a original",
    JSON.stringify(expandirRecorrencias(excecaoForaDaJanela, janelaCurta).map((ocorrencia) => ocorrencia.inicio.toISOString())) ===
      JSON.stringify(["2026-01-01T09:00:00.000Z", "2026-01-03T09:00:00.000Z"]),
  );

  const excecaoQueEntraNaJanela = calendarioComExcecao
    .replace("20260102T090000Z", "20260110T090000Z")
    .replace("20260102T150000Z", "20260102T150000Z")
    .replace("20260102T160000Z", "20260102T160000Z");
  check(
    "excecao cujo original esta fora pode entrar na janela",
    expandirRecorrencias(excecaoQueEntraNaJanela, janelaCurta).some(
      (ocorrencia) => ocorrencia.inicio.toISOString() === "2026-01-02T15:00:00.000Z",
    ),
  );

  const recorrenciaComDst = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:rec-dst",
    "SUMMARY:Semanal em Nova York",
    "DTSTART;TZID=America/New_York:20260301T090000",
    "DTEND;TZID=America/New_York:20260301T100000",
    "RRULE:FREQ=WEEKLY;COUNT=3",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  check(
    "recorrencia no fuso preserva hora civil ao atravessar DST",
    JSON.stringify(expandirRecorrencias(recorrenciaComDst, janela).map((ocorrencia) => ocorrencia.inicio.toISOString())) ===
      JSON.stringify(["2026-03-01T14:00:00.000Z", "2026-03-08T13:00:00.000Z", "2026-03-15T13:00:00.000Z"]),
  );
  const recorrenciaTokyoAte = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:rec-tokyo",
    "DTSTART;TZID=Asia/Tokyo:20260101T090000",
    "DTEND;TZID=Asia/Tokyo:20260101T100000",
    "RRULE:FREQ=DAILY;UNTIL=20260103T000000Z",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  check(
    "UNTIL UTC inclui a ocorrencia equivalente no fuso da serie",
    JSON.stringify(expandirRecorrencias(recorrenciaTokyoAte, janela).map((ocorrencia) => ocorrencia.inicio.toISOString())) ===
      JSON.stringify(["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"]),
  );
  check(
    "margem de conversao do fuso nao estoura limite valido",
    expandirRecorrencias(recorrenciaComDst.replace("COUNT=3", "COUNT=2"), {
      inicio: new Date("2026-03-01T00:00:00.000Z"),
      fim: new Date("2026-03-09T00:00:00.000Z"),
      limite: 2,
    }).length === 2,
  );
  check(
    "serie civil infinita nao conta candidatos auxiliares fora da janela",
    expandirRecorrencias(recorrenciaComDst.replace("COUNT=3", "INTERVAL=1"), {
      inicio: new Date("2026-03-01T00:00:00.000Z"),
      fim: new Date("2026-03-09T00:00:00.000Z"),
      limite: 2,
    }).length === 2,
  );

  const recorrenciaDiaInteiro = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:rec-dia-inteiro",
    "DTSTART;VALUE=DATE:20260101",
    "DTEND;VALUE=DATE:20260102",
    "RRULE:FREQ=DAILY;COUNT=3",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  check(
    "recorrencia de dia inteiro expande VALUE=DATE",
    JSON.stringify(inicios(recorrenciaDiaInteiro)) ===
      JSON.stringify(["2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z", "2026-01-03T00:00:00.000Z"]),
  );

  const horarioInexistente = recorrenciaComDst
    .replace("20260301T090000", "20260301T023000")
    .replace("20260301T100000", "20260301T033000");
  check(
    "horario inexistente no DST e ignorado sem consumir COUNT",
    JSON.stringify(expandirRecorrencias(horarioInexistente, janela).map((ocorrencia) => ocorrencia.inicio.toISOString())) ===
      JSON.stringify(["2026-03-01T07:30:00.000Z", "2026-03-15T06:30:00.000Z", "2026-03-22T06:30:00.000Z"]),
  );

  const excecaoComTzidQuoted = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:rec-quoted",
    "DTSTART;TZID=America/New_York:20260301T090000",
    "DTEND;TZID=America/New_York:20260301T100000",
    "RRULE:FREQ=WEEKLY;COUNT=2",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "UID:rec-quoted",
    'RECURRENCE-ID;TZID="America/New_York":20260308T090000',
    "DTSTART:20260308T180000Z",
    "DTEND:20260308T190000Z",
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
  check(
    "RECURRENCE-ID aceita TZID quoted",
    JSON.stringify(expandirRecorrencias(excecaoComTzidQuoted, janela).map((ocorrencia) => ocorrencia.inicio.toISOString())) ===
      JSON.stringify(["2026-03-01T14:00:00.000Z", "2026-03-08T18:00:00.000Z"]),
  );
  check(
    "RECURRENCE-ID RANGE nao e aceito como excecao isolada",
    (() => {
      try {
        expandirRecorrencias(excecaoComTzidQuoted.replace('RECURRENCE-ID;TZID="America/New_York"', "RECURRENCE-ID;RANGE=THISANDFUTURE"), janela);
        return false;
      } catch (error) {
        return error instanceof Error && error.message.includes("THISANDFUTURE");
      }
    })(),
  );

  const rdatePeriodo = calendario("20260101T090000Z", "20260101T100000Z", "FREQ=DAILY;COUNT=1", [
    "RDATE;VALUE=PERIOD:20260103T090000Z/20260103T113000Z",
  ]);
  const ocorrenciasPeriodo = expandirRecorrencias(rdatePeriodo, janela);
  check(
    "RDATE PERIOD usa a duracao especifica da ocorrencia",
    ocorrenciasPeriodo.length === 2 &&
      ocorrenciasPeriodo[1]?.inicio.toISOString() === "2026-01-03T09:00:00.000Z" &&
      ocorrenciasPeriodo[1]?.fim.toISOString() === "2026-01-03T11:30:00.000Z",
  );

  const eventoLongo = calendario("20260101T230000Z", "20260102T020000Z", "FREQ=DAILY;COUNT=1");
  check(
    "ocorrencia iniciada antes da janela aparece enquanto estiver em andamento",
    expandirRecorrencias(eventoLongo, {
      inicio: new Date("2026-01-02T01:00:00.000Z"),
      fim: new Date("2026-01-02T03:00:00.000Z"),
    }).length === 1,
  );
}

const serieEscopo = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:serie-escopo", "DTSTART:20261001T120000Z",
  "DTEND:20261001T130000Z", "RRULE:FREQ=DAILY;COUNT=5", "SUMMARY:Serie", "END:VEVENT", "END:VCALENDAR", "",
].join("\r\n");
const idEscopo = new Date("2026-10-03T12:00:00Z");
check("escopo esta ocorrencia adiciona EXDATE", adicionarExdate(serieEscopo, idEscopo, false).includes("EXDATE:20261003T120000Z"));
const serieLimitada = limitarSerieAntes(serieEscopo, idEscopo);
check("escopo seguintes limita a serie anterior", serieLimitada.includes("UNTIL=20261003T115959Z"));
check("serie limitada troca COUNT por UNTIL", !serieLimitada.includes("COUNT="));
check("serie limitada continua expansivel", expandirRecorrenciasEscopo(serieLimitada, { inicio: new Date("2026-10-01T00:00:00Z"), fim: new Date("2026-10-10T00:00:00Z") }).length === 2);
const serieDiaInteiro = serieEscopo.replace("DTSTART:20261001T120000Z", "DTSTART;VALUE=DATE:20261001").replace("DTEND:20261001T130000Z", "DTEND;VALUE=DATE:20261002");
check("serie dia inteiro recebe UNTIL do mesmo tipo", limitarSerieAntes(serieDiaInteiro, new Date("2026-10-03T00:00:00Z"), true).includes("UNTIL=20261002"));
const excecaoEscopo = componenteDeExcecao(serieEscopo.replace("SUMMARY:Serie", "SUMMARY:Excecao"), idEscopo, false);
const serieComExcecao = adicionarOuSubstituirExcecao(serieEscopo, excecaoEscopo, idEscopo, false);
check("escopo esta ocorrencia cria RECURRENCE-ID", serieComExcecao.includes("RECURRENCE-ID:20261003T120000Z"));
check("excecao isolada nao repete RRULE", serieComExcecao.match(/RRULE:/g)?.length === 1);
const excecaoTzid = ["BEGIN:VEVENT", "UID:serie-escopo", "RECURRENCE-ID;TZID=America/New_York:20261003T080000", "DTSTART;TZID=America/New_York:20261003T090000", "DTEND;TZID=America/New_York:20261003T100000", "SUMMARY:Antiga", "END:VEVENT"];
const comExcecaoTzid = serieEscopo.replace("END:VCALENDAR", `${excecaoTzid.join("\r\n")}\r\nEND:VCALENDAR`);
const substituida = adicionarOuSubstituirExcecao(comExcecaoTzid, excecaoEscopo, idEscopo, false);
check("substitui RECURRENCE-ID equivalente escrito com TZID", substituida.match(/RECURRENCE-ID(?:;|:)/g)?.length === 1 && !substituida.includes("SUMMARY:Antiga"));
const serieParticionavel = comExcecaoTzid.replace("RRULE:FREQ=DAILY;COUNT=5", "RRULE:FREQ=DAILY;COUNT=5\r\nEXDATE:20261002T120000Z,20261004T120000Z\r\nRDATE:20261002T180000Z,20261005T180000Z");
const particao = particionarSerie(serieParticionavel, idEscopo);
check("particao mantem datas anteriores no recurso antigo", particao.anterior.includes("EXDATE:20261002T120000Z") && particao.anterior.includes("RDATE:20261002T180000Z"));
check("particao remove datas futuras do recurso antigo", !particao.anterior.includes("20261004T120000Z") && !particao.anterior.includes("RECURRENCE-ID;TZID"));
const novaParticao = anexarParticaoFutura(serieEscopo, particao, "uid-novo", 3_600_000);
check("particao move datas e excecoes futuras para o novo UID", novaParticao.includes("EXDATE:20261004T130000Z") && novaParticao.includes("RDATE:20261005T190000Z") && novaParticao.includes("UID:uid-novo") && novaParticao.includes("RECURRENCE-ID:20261003T130000Z"));
const novaParticaoDiaInteiro = anexarParticaoFutura(serieDiaInteiro, particao, "uid-dia", -43_200_000, true);
check("split para dia inteiro preserva fim exclusivo do override", novaParticaoDiaInteiro.includes("DTSTART;VALUE=DATE:20261003") && novaParticaoDiaInteiro.includes("DTEND;VALUE=DATE:20261004"));
check("contagem bruta remove RDATE EXDATE e overrides", !serieSemExclusoes(serieParticionavel).includes("RDATE:") && !serieSemExclusoes(serieParticionavel).includes("EXDATE:") && !serieSemExclusoes(serieParticionavel).includes("RECURRENCE-ID"));
const serieDeslocada = deslocarRecorrencias(serieParticionavel, 3_600_000, "serie-escopo");
check("mover toda a serie desloca EXDATE RDATE e excecoes", serieDeslocada.includes("EXDATE:20261002T130000Z,20261004T130000Z") && serieDeslocada.includes("RDATE:20261002T190000Z,20261005T190000Z") && serieDeslocada.includes("RECURRENCE-ID:20261003T130000Z"));
const seriePeriodo = serieEscopo.replace("SUMMARY:Serie", "RDATE;VALUE=PERIOD:20261002T180000Z/20261002T200000Z,20261005T180000Z/PT2H\r\nSUMMARY:Serie");
const particaoPeriodo = particionarSerie(seriePeriodo, idEscopo);
const novaPeriodo = anexarParticaoFutura(serieEscopo, particaoPeriodo, "periodo-novo", 3_600_000);
check("RDATE PERIOD e classificado pelo inicio", particaoPeriodo.anterior.includes("20261002T180000Z/20261002T200000Z") && !particaoPeriodo.anterior.includes("20261005T180000Z/PT2H"));
check("RDATE PERIOD preserva tipo e desloca inicio e fim", novaPeriodo.includes("RDATE;VALUE=PERIOD:20261005T190000Z/PT2H") && !novaPeriodo.includes("20261005T180000Z"));
const serieDiaInteiroConvertida = deslocarRecorrencias(serieParticionavel, -43_200_000, "serie-escopo", true);
check("conversao para dia inteiro uniformiza identificadores e adicionais", serieDiaInteiroConvertida.includes("EXDATE;VALUE=DATE:") && serieDiaInteiroConvertida.includes("RDATE;VALUE=DATE:") && serieDiaInteiroConvertida.includes("RECURRENCE-ID;VALUE=DATE:"));
check("override temporizado convertido usa fim DATE exclusivo", serieDiaInteiroConvertida.includes("DTSTART;VALUE=DATE:20261003") && serieDiaInteiroConvertida.includes("DTEND;VALUE=DATE:20261004"));
const serieTemporizadaConvertida = deslocarRecorrencias(serieDiaInteiro.replace("SUMMARY:Serie", "EXDATE;VALUE=DATE:20261002\r\nRDATE;VALUE=DATE:20261004\r\nSUMMARY:Serie"), 32_400_000, "serie-escopo", false);
check("conversao para temporizado uniformiza datas adicionais", serieTemporizadaConvertida.includes("EXDATE:20261002T090000Z") && serieTemporizadaConvertida.includes("RDATE:20261004T090000Z"));

const eventoComLembrete = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:lembrete-1", "DTSTART:20261017T180500Z", "DTEND:20261017T190500Z", "RRULE:FREQ=DAILY;COUNT=2", "SUMMARY:Reuniao", "BEGIN:VALARM", "ACTION:DISPLAY", "TRIGGER:-PT5M", "DESCRIPTION:Reuniao", "END:VALARM", "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");
const agoraLembrete = new Date("2026-10-17T18:00:00Z");
check("lembrete simples vence na janela controlada", lembretesPendentesDoItem(eventoComLembrete.replace("RRULE:FREQ=DAILY;COUNT=2\r\n", ""), "lembrete.ics", agoraLembrete).length === 1);
check("lookback recupera lembrete vencido ha segundos", lembretesPendentesDoItem(eventoComLembrete.replace("RRULE:FREQ=DAILY;COUNT=2\r\n", ""), "lembrete.ics", new Date("2026-10-17T18:00:10Z")).length === 1);
check("lembrete recorrente encontra a ocorrencia seguinte", lembretesPendentesDoItem(eventoComLembrete, "lembrete.ics", new Date("2026-10-18T18:00:00Z")).length === 1);
check("evento editado fora da janela nao gera lembrete antigo", lembretesPendentesDoItem(eventoComLembrete.replace("20261017T180500Z", "20261017T200500Z").replace("20261017T190500Z", "20261017T210500Z"), "lembrete.ics", agoraLembrete).length === 0);
check("evento sem VALARM nao gera lembrete", lembretesPendentesDoItem(eventoComLembrete.replace(/BEGIN:VALARM[\s\S]*?END:VALARM\r\n/, ""), "lembrete.ics", agoraLembrete).length === 0);
const conviteIcal = eventoComLembrete.replace("VERSION:2.0", "VERSION:2.0\r\nMETHOD:REQUEST");
const mimeConvite = Buffer.from(["From: agenda@example.com", "To: dono@example.com", "Subject: Convite", "MIME-Version: 1.0", "Content-Type: text/calendar; method=REQUEST; charset=utf-8", "", conviteIcal].join("\r\n"));
check("parser MIME extrai parte text/calendar", (await extrairIcalDaMensagem(mimeConvite))?.includes("METHOD:REQUEST") === true);

console.log("\n[11] Servico JSON da agenda");
{
  const { eventoCalendarioSchema, normalizarBuscaAgenda } = await import("../services/calendar.js");
  const eventoValido = {
    titulo: "Reuniao de produto",
    inicio: "2026-10-20T13:00:00.000Z",
    fim: "2026-10-20T14:00:00.000Z",
    diaInteiro: false,
    fuso: "America/Sao_Paulo",
    disponibilidade: "ocupado",
    lembretes: [{ minutosAntes: 15 }],
    convidados: [{ email: "cliente@example.com", resposta: "pendente" }],
  };
  check("modelo JSON aceita evento completo", eventoCalendarioSchema.safeParse(eventoValido).success);
  check("titulo da agenda tem no maximo 500 caracteres", !eventoCalendarioSchema.safeParse({ ...eventoValido, titulo: "x".repeat(501) }).success);
  check("fuso da agenda precisa ser IANA valido", !eventoCalendarioSchema.safeParse({ ...eventoValido, fuso: "Fuso/Inexistente" }).success);
  check("alias IANA canonizado para UTC e valido", eventoCalendarioSchema.safeParse({ ...eventoValido, fuso: "GMT" }).success);
  check(
    "fim da agenda nao pode anteceder o inicio",
    !eventoCalendarioSchema.safeParse({ ...eventoValido, fim: "2026-10-20T12:59:59.000Z" }).success,
  );
  check("intervalo zero e aceito pelo contrato", eventoCalendarioSchema.safeParse({ ...eventoValido, fim: eventoValido.inicio }).success);
  check("busca da agenda ignora acentos", normalizarBuscaAgenda("Reunião") === normalizarBuscaAgenda("reuniao"));
  check("busca da agenda ignora maiusculas", normalizarBuscaAgenda("CLIENTE") === "cliente");
  check(
    "campos estruturados recusam quebra de linha",
    !eventoCalendarioSchema.safeParse({ ...eventoValido, fuso: "America/Sao_Paulo\r\nATTENDEE:intruso" }).success,
  );
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

console.log("\n[dns] Provedor de DNS pelos servidores de nome");
{
  const { provedorPelosNs } = await import("../lib/provedorDns.js");
  const cf = provedorPelosNs(["DONALD.NS.CLOUDFLARE.COM.", "dora.ns.cloudflare.com."], "Vedashow.com.br");
  check("Cloudflare reconhecida, com ponto final e maiusculas", cf?.id === "cloudflare");
  check(
    "link da Cloudflare abre a zona do dominio",
    cf?.url === "https://dash.cloudflare.com/?to=/:account/vedashow.com.br/dns/records" && cf.direto === true,
    cf?.url,
  );
  const rb = provedorPelosNs(["a.auto.dns.br", "b.auto.dns.br"], "exemplo.com.br");
  check("Registro.br reconhecido pelo DNS hospedado", rb?.id === "registrobr" && rb.direto === false && rb.preposicao === "no");
  check("NS da zona com.br nao e tratado como Registro.br", provedorPelosNs(["a.dns.br", "b.dns.br"], "com.br") === null);
  check(
    "GoDaddy leva o dominio no link",
    provedorPelosNs(["ns01.domaincontrol.com"], "loja.com")?.url === "https://dcc.godaddy.com/control/dnsmanagement?domainName=loja.com",
  );
  check("sufixo parecido nao engana", provedorPelosNs(["ns1.fakens.cloudflare.com.evil.io"], "x.com") === null);
  check("provedor desconhecido volta nulo", provedorPelosNs(["ns1.exemplo-dns.net"], "x.com") === null);
  check("sem servidores volta nulo", provedorPelosNs([], "x.com") === null);
}

console.log("\n[dns] Plano de publicacao na Cloudflare");
{
  const { planejarPublicacao, spfComInclude } = await import("../services/publicacaoDns.js");
  const { dnsRecordsFor } = await import("../services/provisioning.js");
  const dominio = "cliente.com.br";
  const desejados = dnsRecordsFor(dominio, "avila1");
  const cname = desejados.find((d) => d.type === "CNAME")!;
  const spfNosso = desejados.find((d) => d.type === "TXT" && d.host === "@")!.value;
  const include = spfNosso.split(" ").find((t) => t.startsWith("include:"))!;
  const estados = (p: { registro: string; estado: string }[]) => p.map((x) => `${x.registro}:${x.estado}`).join(" ");
  const reg = (type: string, name: string, content: string, id = `${type}-${name}-${content}`) => ({ id, type, name, content });

  const vazia = planejarPublicacao(dominio, desejados, [], { substituirMx: false });
  check("zona vazia: cria os quatro", estados(vazia) === "mx:criado spf:criado dkim:criado dmarc:criado", estados(vazia));
  check("zona vazia: quatro operacoes, todas de criar", vazia.flatMap((p) => p.operacoes).length === 4 && vazia.every((p) => p.operacoes.every((o) => o.tipo === "criar")));

  const pronta = planejarPublicacao(
    dominio,
    desejados,
    [
      reg("MX", dominio, "mail.avilaops.com"),
      reg("TXT", dominio, `"${spfNosso}"`),
      reg("TXT", dominio, "google-site-verification=abc"),
      reg("CNAME", `avila1._domainkey.${dominio}`, `${cname.value}.`),
      reg("TXT", `_dmarc.${dominio}`, "v=DMARC1; p=reject"),
    ],
    { substituirMx: false },
  );
  check("zona pronta: nada a fazer", pronta.flatMap((p) => p.operacoes).length === 0, estados(pronta));
  check("DMARC do cliente fica como esta", pronta.find((p) => p.registro === "dmarc")?.estado === "mantido");

  const comOutroMx = [reg("MX", dominio, "aspmx.l.google.com", "mx-google"), reg("TXT", dominio, "v=spf1 include:_spf.google.com ~all", "spf-google")];
  const semConfirmar = planejarPublicacao(dominio, desejados, comOutroMx, { substituirMx: false });
  const mx = semConfirmar.find((p) => p.registro === "mx")!;
  check("MX de outro provedor: pede confirmacao e nao mexe", mx.estado === "precisa_confirmar" && mx.operacoes.length === 0, mx.estado);
  const spf = semConfirmar.find((p) => p.registro === "spf")!;
  const opSpf = spf.operacoes[0];
  check(
    "SPF existente: atualiza o mesmo registro, mantendo o que havia",
    spf.operacoes.length === 1 && opSpf?.tipo === "atualizar" && opSpf.id === "spf-google" && opSpf.novo.content === `v=spf1 include:_spf.google.com ${include} ~all`,
    opSpf && "novo" in opSpf ? opSpf.novo.content : "",
  );

  const confirmado = planejarPublicacao(dominio, desejados, comOutroMx, { substituirMx: true }).find((p) => p.registro === "mx")!;
  check(
    "MX confirmado: apaga o antigo e cria o nosso",
    confirmado.estado === "atualizado" && confirmado.operacoes.map((o) => o.tipo).join(",") === "apagar,criar",
    confirmado.operacoes.map((o) => o.tipo).join(","),
  );

  const dkimVelho = planejarPublicacao(dominio, desejados, [reg("TXT", `avila1._domainkey.${dominio}`, "v=DKIM1; p=velha", "txt-velho")], { substituirMx: false }).find((p) => p.registro === "dkim")!;
  check("DKIM: registro de outro tipo no mesmo nome sai antes do CNAME", dkimVelho.operacoes.map((o) => o.tipo).join(",") === "apagar,criar");

  const dkimComSobra = planejarPublicacao(
    dominio,
    desejados,
    [reg("CNAME", `avila1._domainkey.${dominio}`, cname.value), reg("TXT", `avila1._domainkey.${dominio}`, "v=DKIM1; p=antiga")],
    { substituirMx: false },
  ).find((p) => p.registro === "dkim")!;
  check("DKIM: CNAME certo com TXT antigo ao lado nao e tocado", dkimComSobra.estado === "ja_estava" && dkimComSobra.operacoes.length === 0, dkimComSobra.estado);

  check("include entra antes do all", spfComInclude("v=spf1 ip4:1.2.3.4 -all", include) === `v=spf1 ip4:1.2.3.4 ${include} -all`);
  check("include nao e repetido", spfComInclude(spfNosso, include) === spfNosso);
  check("SPF sem all ganha o include no fim", spfComInclude("v=spf1 a mx", include) === `v=spf1 a mx ${include}`);
}

console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} verificacoes ok, ${failed} falhas\n`);
process.exit(failed === 0 ? 0 : 1);
