/**
 * Teste de integracao contra PostgreSQL real.
 *
 * Cobre o caminho completo do produto: provisionar dominio e caixa, receber
 * uma mensagem hostil de verdade, autenticar o dono, ler pela API, e conferir
 * que um cliente nao enxerga a caixa do outro.
 *
 * Sobe e derruba o banco sozinho — ver deploy/run-integration.sh.
 *
 *   MAIL_DATABASE_URL=... npx tsx src/scripts/integration.ts
 */

import { mkdtempSync, rmSync } from "node:fs";
import { SYSTEM_FOLDERS } from "../services/folders.js";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workDir = mkdtempSync(join(tmpdir(), "avila-mail-integ-"));
process.env.MAIL_STORAGE_DIR = workDir;
process.env.MAIL_DKIM_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.MAIL_JWT_SECRET ??= "b".repeat(64);
process.env.MAIL_HOSTNAME ??= "mail.avilaops.com";
process.env.MAIL_LOG_LEVEL ??= "warn";
process.env.MP_ACCESS_TOKEN ??= "TEST-token-de-teste";
process.env.MP_WEBHOOK_SECRET ??= "segredo-de-webhook-para-teste";
process.env.MP_BACK_URL ??= "https://portal.exemplo.test/assinatura";
process.env.MAIL_DIAS_TOLERANCIA ??= "5";
// Aquecimento de IP comecando hoje: a secao [41] confere a contagem e o teto.
process.env.MAIL_WARMUP_INICIO ??= new Date().toISOString().slice(0, 10);

if (!process.env.MAIL_DATABASE_URL) {
  console.error("MAIL_DATABASE_URL obrigatorio para o teste de integracao.");
  process.exit(1);
}

const { prisma } = await import("../lib/db.js");
const { createDomain, createMailbox, setMailboxStatus, listMailboxes, billableMailboxes } = await import(
  "../services/provisioning.js"
);
const { deliverToMailbox, resolveRecipient, storeCopyInMailbox } = await import("../mta/deliver-local.js");
const { login: loginBruto, refresh, changeOwnPassword, AuthError } = await import("../services/session.js");

/** Login que o teste espera terminar em sessao — 2FA aqui seria surpresa. */
const login = async (input: Parameters<typeof loginBruto>[0]) => {
  const resultado = await loginBruto(input);
  if ("requiresTotp" in resultado) throw new Error("login pediu 2FA onde o teste nao esperava");
  return resultado;
};
const {
  listFolders,
  listMessages,
  parseAttachmentFilter,
  getMessage,
  getRawMessage,
  getAttachment,
  updateMessages,
  deleteMessages,
  getOverview,
  MessageError,
} = await import("../services/messages.js");
const { sendMessage, saveDraft } = await import("../services/compose.js");

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

/** Exige que a chamada falhe COM a mensagem certa — erro generico nao passa. */
async function esperaErro(label: string, fn: () => Promise<unknown>, esperado: string): Promise<void> {
  try {
    await fn();
    check(label, false, "nao lancou erro");
  } catch (error) {
    const mensagem = error instanceof Error ? error.message : String(error);
    const temStatus = typeof (error as { statusCode?: unknown }).statusCode === "number";
    const bate = mensagem.toLowerCase().includes(esperado.toLowerCase());
    check(label, temStatus && bate, `erro recebido: ${mensagem}`);
  }
}

const SENHA = "SenhaForte123456";
const SENHA_NOVA = "OutraSenhaForte789";

// Mensagem propositalmente hostil: script, link javascript: e rastreador.
const LIMITE = "FRONTEIRA123";
const MENSAGEM_BRUTA = Buffer.from(
  [
    "From: Cliente Teste <cliente@exemplo.com>",
    "To: contato@brilhax.com.br",
    "Subject: Orcamento aprovado",
    "Date: Thu, 13 Aug 2026 09:00:00 +0000",
    "Message-ID: <integ-1@exemplo.com>",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${LIMITE}"`,
    "",
    `--${LIMITE}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Ola <b>time</b>, segue o aceite.</p>" +
      "<script>alert('xss')</script>" +
      '<img src="https://rastreador.exemplo.com/pixel.gif" alt="pixel">' +
      '<a href="javascript:alert(1)">clique aqui</a>' +
      '<a href="https://avilaops.com">site</a>',
    "",
    `--${LIMITE}`,
    'Content-Type: text/plain; name="nota.txt"',
    'Content-Disposition: attachment; filename="nota.txt"',
    "",
    "conteudo do anexo de teste",
    "",
    `--${LIMITE}--`,
    "",
  ].join("\r\n"),
);

console.log("\n[1] Provisionamento de dominio");
const dominio = await createDomain({ domain: "brilhax.com.br", clientRef: "cli_brilhax" });
check("cria o dominio", dominio.created && dominio.domain === "brilhax.com.br");
check("gera 4 registros de DNS", dominio.dnsRecords.length === 4);
check(
  "MX aponta para o nosso servidor",
  dominio.dnsRecords.some((r) => r.type === "MX" && r.value === "mail.avilaops.com" && r.priority === 10),
);
check(
  "SPF usa include central",
  dominio.dnsRecords.some((r) => r.type === "TXT" && r.value.includes("include:_spf.avilaops.com")),
);
check(
  "DKIM sai como CNAME delegado",
  dominio.dnsRecords.some((r) => r.type === "CNAME" && r.value === "brilhax-com-br.dkim.avilaops.com"),
);
check("guarda a chave privada cifrada", (await prisma.mailDomain.findUnique({
  where: { name: "brilhax.com.br" },
  select: { dkimPrivateKey: true },
}))?.dkimPrivateKey?.startsWith("v1:") === true);

const repetido = await createDomain({ domain: "brilhax.com.br" });
check("provisionar de novo e idempotente (nao gera chave nova)", !repetido.created);

console.log("\n[2] Provisionamento de caixa");
const caixa = await createMailbox({
  domain: "brilhax.com.br",
  username: "contato",
  password: SENHA,
  quotaGb: 5,
  displayName: "Contato Brilhax",
});
check("cria a caixa", caixa.address === "contato@brilhax.com.br");
check("devolve config de acesso", caixa.pop3.port === 995 && caixa.smtp.port === 587);

const pastas = await listFolders(caixa.id);
check(`cria as ${SYSTEM_FOLDERS.length} pastas de sistema`, pastas.length === SYSTEM_FOLDERS.length);
check("tem Caixa de Entrada", pastas.some((p) => p.kind === "inbox"));

check("grava a mensagem de boas-vindas na caixa", caixa.welcome.storedInMailbox === true);
check("nao notifica ninguem quando nao ha contato informado", caixa.welcome.notified === false);

const boasVindas = await prisma.message.findFirstOrThrow({
  where: { mailboxId: caixa.id },
  select: { subject: true, bodyText: true, sizeBytes: true },
});
// A instrucao precisa refletir o que existe: porta anunciada sem servidor
// atras manda o cliente configurar algo que nunca vai conectar.
check("boas-vindas traz o IMAP na 993", (boasVindas.bodyText ?? "").includes("993"));
check("boas-vindas traz o POP3 na 995", (boasVindas.bodyText ?? "").includes("995"));
check("boas-vindas traz o envio na 587", (boasVindas.bodyText ?? "").includes("587"));
// IMAP primeiro: quem seguir a ordem do e-mail cai no protocolo que sincroniza
// os aparelhos, e nao no que baixa tudo para um so.
check(
  "IMAP aparece antes do POP3",
  (boasVindas.bodyText ?? "").indexOf("IMAP") < (boasVindas.bodyText ?? "").indexOf("POP3"),
);
// A senha nunca pode aparecer no e-mail: ela viaja e fica arquivada em
// servidor de terceiro. Vai so na resposta da API, para quem provisiona.
check("boas-vindas NAO contem a senha", !(boasVindas.bodyText ?? "").includes(SENHA));

const bytesBoasVindas = BigInt(boasVindas.sizeBytes);

await esperaErro("recusa caixa duplicada", () =>
  createMailbox({ domain: "brilhax.com.br", username: "contato", password: SENHA }), "ja existe");
await esperaErro("recusa senha curta", () =>
  createMailbox({ domain: "brilhax.com.br", username: "curta", password: "123" }), "12 caracteres");

console.log("\n[3] Recebimento de mensagem");
const destino = await resolveRecipient("contato@brilhax.com.br");
check("resolve o destinatario para a caixa", destino.kind === "mailbox");
check("sub-enderecamento cai na mesma caixa", (await resolveRecipient("contato+nota@brilhax.com.br")).kind === "mailbox");
check("endereco inexistente e recusado", (await resolveRecipient("naoexiste@brilhax.com.br")).kind === "unknown");
check("dominio de fora e recusado", (await resolveRecipient("alguem@outrodominio.com")).kind === "unknown");

if (destino.kind !== "mailbox") throw new Error("destinatario nao resolveu; teste nao pode seguir");

const entrega = await deliverToMailbox(destino, MENSAGEM_BRUTA, {
  spf: "pass",
  dkim: "pass",
  dkimDomain: "exemplo.com",
  dmarc: "pass",
  dmarcPolicy: "none",
  arc: "none",
  headers: "",
});
check("entrega na Caixa de Entrada", entrega.status === "delivered" && entrega.folder === "inbox");

const aposEntrega = await prisma.mailbox.findUniqueOrThrow({
  where: { id: caixa.id },
  select: { usedBytes: true },
});
check(
  "quota consumida = boas-vindas + mensagem recebida",
  aposEntrega.usedBytes === bytesBoasVindas + BigInt(MENSAGEM_BRUTA.byteLength),
);

console.log("\n[4] Login do dono da caixa");
await esperaErro("senha errada e recusada", () =>
  login({ address: "contato@brilhax.com.br", password: "errada", ip: "203.0.113.1" }), "invalidos");

const sessao = await login({ address: "contato@brilhax.com.br", password: SENHA, ip: "203.0.113.9" });
check("login devolve access token", sessao.accessToken.split(".").length === 3);
check("login devolve refresh token", sessao.refreshToken.length > 40);
check("login devolve dados da caixa", sessao.mailbox.address === "contato@brilhax.com.br");

const { verifyAccessToken } = await import("../lib/jwt.js");
check("access token valida e carrega a caixa", verifyAccessToken(sessao.accessToken)?.sub === sessao.mailbox.id);
check("token adulterado e rejeitado", verifyAccessToken(`${sessao.accessToken}x`) === null);

console.log("\n[5] Rotacao e reuso de refresh token");
const renovada = await refresh({ refreshToken: sessao.refreshToken, ip: "203.0.113.9" });
check("refresh emite par novo", renovada.accessToken !== sessao.accessToken);
await esperaErro("refresh antigo nao serve mais", () =>
  refresh({ refreshToken: sessao.refreshToken }), "invalida");
await esperaErro("apos reuso, o refresh novo tambem cai", () =>
  refresh({ refreshToken: renovada.refreshToken }), "invalida");

const eventoReuso = await prisma.mailEvent.findFirst({ where: { type: "session.reuse_detected" } });
check("reuso vira evento de auditoria", eventoReuso !== null);

console.log("\n[6] Forca bruta: bloqueia o atacante sem trancar o cliente");
await createMailbox({ domain: "brilhax.com.br", username: "alvo", password: SENHA });

for (let i = 0; i < 8; i += 1) {
  await login({ address: "alvo@brilhax.com.br", password: "errada", ip: "198.51.100.7" }).catch(() => undefined);
}
await esperaErro("bloqueia o atacante apos 8 tentativas", () =>
  login({ address: "alvo@brilhax.com.br", password: SENHA, ip: "198.51.100.7" }), "muitas tentativas");

// Regressao do vetor de negacao de servico: se o bloqueio fosse so por
// endereco, o dono legitimo ficaria trancado fora junto com o atacante.
check(
  "dono legitimo, de outro IP, continua entrando",
  (await login({ address: "alvo@brilhax.com.br", password: SENHA, ip: "203.0.113.55" })).accessToken.length > 0,
);

console.log("\n[7] Leitura pela API da caixa");
const mailboxId = sessao.mailbox.id;

const visao = await getOverview(mailboxId);
// usoPercentual arredonda para 0,00 com poucos bytes em 5 GB — e o correto.
// O que precisa ser exato e o numero de bytes.
check("visao geral traz o endereco", visao.address === "contato@brilhax.com.br");
check(
  "visao geral traz o uso em bytes",
  BigInt(visao.usedBytes) === bytesBoasVindas + BigInt(MENSAGEM_BRUTA.byteLength),
);
check("visao geral traz a quota", BigInt(visao.quotaBytes) === 5n * 1024n * 1024n * 1024n);

const listagem = await listMessages({ mailboxId, folder: "inbox" });
check("lista boas-vindas e mensagem recebida", listagem.messages.length === 2);

const recebida = listagem.messages.find((m) => m.subject === "Orcamento aprovado");
check("mensagem recebida aparece na listagem", recebida !== undefined);
check("marca remetente como verificado", recebida?.senderVerified === true);
check("nao vaza authResult cru na listagem", recebida?.authResult === undefined);

const busca = await listMessages({ mailboxId, query: "orcamento" });
check("busca encontra por assunto", busca.messages.length === 1);
check("busca sem resultado devolve vazio", (await listMessages({ mailboxId, query: "zzzznadaaqui" })).messages.length === 0);

const mensagemId = recebida?.id ?? "";
const mensagem = await getMessage(mailboxId, mensagemId);

console.log("\n[8] Sanitizacao do HTML (anti-XSS)");
check("remove a tag script", !(mensagem.bodyHtml ?? "").toLowerCase().includes("<script"));
check("remove href javascript:", !(mensagem.bodyHtml ?? "").toLowerCase().includes("javascript:"));
check("preserva o conteudo legitimo", (mensagem.bodyHtml ?? "").includes("<b>time</b>"));
check("preserva link legitimo", (mensagem.bodyHtml ?? "").includes("https://avilaops.com"));
check("adiciona rel de seguranca nos links", (mensagem.bodyHtml ?? "").includes("noopener"));
check("bloqueia imagem remota (rastreador)", mensagem.blockedRemoteImages === 1);
check("guarda a origem da imagem para liberar depois", (mensagem.bodyHtml ?? "").includes("data-src"));

const comImagens = await getMessage(mailboxId, mensagemId, { showRemoteImages: true });
check("libera imagem remota quando pedido", (comImagens.bodyHtml ?? "").includes("rastreador.exemplo.com"));
check("mesmo liberando imagem, script continua fora", !(comImagens.bodyHtml ?? "").toLowerCase().includes("<script"));

console.log("\n[9] Anexos");
check("registra o anexo", mensagem.attachments.length === 1);
check("nome do anexo preservado", mensagem.attachments[0]?.filename === "nota.txt");
const anexo = await getAttachment(mailboxId, mensagemId, mensagem.attachments[0]?.id ?? "");
check("extrai o binario do .eml original", anexo.content.toString("utf8").includes("conteudo do anexo de teste"));

console.log("\n[10] Flags e movimentacao");
check("abrir a mensagem marca como lida", mensagem.seen === true);
await updateMessages({ mailboxId, messageIds: [mensagemId], flagged: true });
check("marca como favorita", (await listMessages({ mailboxId, flaggedOnly: true })).messages.length === 1);
check(
  "contador de nao lidas cai para 1 (so a de boas-vindas)",
  (await listFolders(mailboxId)).find((p) => p.kind === "inbox")?.unread === 1,
);

console.log("\n[11] Isolamento entre caixas (IDOR)");
await createMailbox({ domain: "brilhax.com.br", username: "financeiro", password: SENHA });
const outraCaixa = await prisma.mailbox.findFirstOrThrow({
  where: { localPart: "financeiro" },
  select: { id: true },
});
await esperaErro("outra caixa nao le a mensagem", () =>
  getMessage(outraCaixa.id, mensagemId), "nao encontrada");
await esperaErro("outra caixa nao baixa o anexo", () =>
  getAttachment(outraCaixa.id, mensagemId, mensagem.attachments[0]?.id ?? ""), "nao encontrado");
// A outra caixa so enxerga a propria mensagem de boas-vindas — nada da vizinha.
const listagemVizinha = await listMessages({ mailboxId: outraCaixa.id });
check("outra caixa so ve a propria boas-vindas", listagemVizinha.messages.length === 1);
check(
  "nenhuma mensagem da vizinha aparece",
  !listagemVizinha.messages.some((m) => m.subject === "Orcamento aprovado"),
);
check(
  "alterar mensagem alheia nao afeta nada",
  (await updateMessages({ mailboxId: outraCaixa.id, messageIds: [mensagemId], seen: false })).updated === 0,
);

console.log("\n[12] Exclusao em dois tempos e devolucao de quota");
const paraLixeira = await deleteMessages(mailboxId, [mensagemId]);
check("primeira exclusao manda para a lixeira", paraLixeira.trashed === 1 && paraLixeira.purged === 0);
check("mensagem aparece na lixeira", (await listMessages({ mailboxId, folder: "trash" })).messages.length === 1);
check("quota ainda ocupada na lixeira", (await prisma.mailbox.findUniqueOrThrow({
  where: { id: mailboxId },
  select: { usedBytes: true },
})).usedBytes > 0n);

const definitiva = await deleteMessages(mailboxId, [mensagemId]);
check("segunda exclusao remove de vez", definitiva.purged === 1);
check("quota devolvida ao patamar anterior", (await prisma.mailbox.findUniqueOrThrow({
  where: { id: mailboxId },
  select: { usedBytes: true },
})).usedBytes === bytesBoasVindas);
check(
  "sobra apenas a mensagem de boas-vindas",
  (await listMessages({ mailboxId })).messages.length === 1,
);

console.log("\n[13] Troca de senha pelo dono");
const sessaoAtiva = await login({ address: "contato@brilhax.com.br", password: SENHA, ip: "203.0.113.20" });
await esperaErro("recusa troca com senha atual errada", () =>
  changeOwnPassword({ mailboxId, currentPassword: "errada", newPassword: SENHA_NOVA }), "incorreta");
await changeOwnPassword({ mailboxId, currentPassword: SENHA, newPassword: SENHA_NOVA });
check("senha nova funciona", (await login({ address: "contato@brilhax.com.br", password: SENHA_NOVA, ip: "203.0.113.21" })).accessToken.length > 0);
await esperaErro("senha antiga parou de funcionar", () =>
  login({ address: "contato@brilhax.com.br", password: SENHA, ip: "203.0.113.22" }), "invalidos");
await esperaErro("troca de senha derruba sessoes antigas", () =>
  refresh({ refreshToken: sessaoAtiva.refreshToken }), "invalida");

console.log("\n[14] Envio pelo webmail");
const envio = await sendMessage({
  mailboxId,
  to: ["destino@exemplo.com", "DESTINO@exemplo.com"],
  cc: ["copia@exemplo.com"],
  bcc: ["oculta@exemplo.com"],
  subject: "Proposta comercial",
  text: "Segue a proposta em anexo.",
  html: "<p>Segue a proposta <b>em anexo</b>.</p>",
  attachments: [{ filename: "proposta.txt", contentBase64: Buffer.from("valor: R$ 10").toString("base64") }],
});
check("envio aceito", envio.queuedId.length > 0);
check("destinatario repetido conta uma vez so", envio.recipients === 3);
check("informa quanto resta da cota", envio.remainingThisHour === 197);

const naFila = await prisma.outboundMessage.findUniqueOrThrow({
  where: { id: envio.queuedId },
  select: { envelopeFrom: true, recipients: true, status: true, storageKey: true },
});
check("remetente do envelope e a caixa", naFila.envelopeFrom === "contato@brilhax.com.br");
check("bcc entra no envelope", (naFila.recipients as string[]).includes("oculta@exemplo.com"));
check("fica em fila aguardando entrega", naFila.status === "queued");


const { readRaw } = await import("../lib/storage.js");
const mimeEnviado = (await readRaw(naFila.storageKey)).toString("utf8");
check("mensagem sai assinada com DKIM", mimeEnviado.includes("DKIM-Signature:"));
check("DKIM usa o dominio do cliente", mimeEnviado.includes("d=brilhax.com.br"));
// Cco no header seria vazamento: todo destinatario veria a copia oculta.
check("bcc NAO aparece nos headers", !mimeEnviado.toLowerCase().includes("oculta@exemplo.com"));
check("anexo embarcado no MIME", mimeEnviado.includes("proposta.txt"));

const enviados = await listMessages({ mailboxId, folder: "sent" });
check("copia guardada em Enviados", enviados.messages.length === 1);
check("assunto correto em Enviados", enviados.messages[0]?.subject === "Proposta comercial");

await esperaErro("recusa envio sem destinatario", () =>
  sendMessage({ mailboxId, to: [], text: "oi" }), "ao menos um destinatario");
await esperaErro("recusa endereco invalido", () =>
  sendMessage({ mailboxId, to: ["arroba-faltando"], text: "oi" }), "invalido");
await esperaErro("recusa mensagem sem corpo", () =>
  sendMessage({ mailboxId, to: ["a@b.com"] }), "texto ou HTML");

console.log("\n[15] Resposta com threading");
const destinoResposta = await resolveRecipient("contato@brilhax.com.br");
if (destinoResposta.kind !== "mailbox") throw new Error("caixa sumiu");
await deliverToMailbox(destinoResposta, MENSAGEM_BRUTA, null);

const original = (await listMessages({ mailboxId, query: "orcamento" })).messages[0];
const resposta = await sendMessage({
  mailboxId,
  to: ["cliente@exemplo.com"],
  text: "Recebido, obrigado!",
  inReplyToMessageId: original?.id ?? "",
});
check("assunto ganha prefixo Re:", resposta.subject === "Re: Orcamento aprovado");

const mimeResposta = (await readRaw(
  (await prisma.outboundMessage.findUniqueOrThrow({
    where: { id: resposta.queuedId },
    select: { storageKey: true },
  })).storageKey,
)).toString("utf8");
check("resposta traz In-Reply-To do original", mimeResposta.includes("<integ-1@exemplo.com>"));
check("resposta traz References", mimeResposta.toLowerCase().includes("references:"));

const originalDepois = await prisma.message.findUniqueOrThrow({
  where: { id: original?.id ?? "" },
  select: { answered: true, threadKey: true },
});
check("original marcado como respondido", originalDepois.answered === true);

const copiaResposta = (await listMessages({ mailboxId, folder: "sent" })).messages.find(
  (m) => m.subject === "Re: Orcamento aprovado",
);
check("resposta entra na mesma conversa", copiaResposta?.threadKey === originalDepois.threadKey);

console.log("\n[16] Rascunhos");
const rascunho = await saveDraft({
  mailboxId,
  to: ["pendente@exemplo.com"],
  subject: "Ainda escrevendo",
  text: "primeira versao",
});
check("salva o rascunho", rascunho.draftId.length > 0);
check("rascunho vai para a pasta Rascunhos", (await listMessages({ mailboxId, folder: "drafts" })).messages.length === 1);

const rascunhoAtualizado = await saveDraft({
  mailboxId,
  draftId: rascunho.draftId,
  to: ["pendente@exemplo.com"],
  subject: "Ainda escrevendo",
  text: "segunda versao",
});
const rascunhos = await listMessages({ mailboxId, folder: "drafts" });
check("autosave substitui em vez de acumular", rascunhos.messages.length === 1);
check("rascunho antigo nao foi para a lixeira", (await listMessages({ mailboxId, folder: "trash" })).messages.length === 0);
check("conteudo atualizado", (await getMessage(mailboxId, rascunhoAtualizado.draftId)).bodyText?.includes("segunda versao") === true);

await sendMessage({
  mailboxId,
  draftId: rascunhoAtualizado.draftId,
  to: ["pendente@exemplo.com"],
  subject: "Ainda escrevendo",
  text: "versao final",
});
check("enviar o rascunho o remove da pasta", (await listMessages({ mailboxId, folder: "drafts" })).messages.length === 0);

console.log("\n[17] Boas-vindas com aviso ao contato do cliente");
const caixaComAviso = await createMailbox({
  domain: "brilhax.com.br",
  username: "comercial",
  password: SENHA,
  notifyTo: "dono@empresadocliente.com.br",
});
check("marca que notificou o contato", caixaComAviso.welcome.notified === true);

const avisoNaFila = await prisma.outboundMessage.findFirst({
  where: { recipients: { array_contains: ["dono@empresadocliente.com.br"] } },
  select: { envelopeFrom: true, subject: true, storageKey: true },
});
check("aviso foi para a fila de saida", avisoNaFila !== null);
check("aviso sai de naoresponda@", avisoNaFila?.envelopeFrom === "naoresponda@avilaops.com");
if (avisoNaFila) {
  const corpoAviso = (await readRaw(avisoNaFila.storageKey)).toString("utf8");
  check("aviso NAO contem a senha", !corpoAviso.includes(SENHA));
  check("aviso traz o endereco novo", corpoAviso.includes("comercial@brilhax.com.br"));
}

console.log("\n[18] Cota de envio compartilhada");
const { remainingQuota } = await import("../services/sendQuota.js");
const restante = await remainingQuota(mailboxId, 200);
check("cota desconta todos os envios da janela", restante === 200 - 3 - 1 - 1);

// --- Desfazer envio ---
//
// A janela existe para o cancelamento ser real: enquanto nextAttemptAt esta no
// futuro o worker nem enxerga a mensagem, porque ele busca por <= agora.
const { undoSend, JANELA_DESFAZER_SEGUNDOS } = await import("../services/compose.js");

const seguraAte = (await prisma.outboundMessage.findUniqueOrThrow({
  where: { id: envio.queuedId },
  select: { nextAttemptAt: true },
})).nextAttemptAt;
check("envio fica segurado pela janela", seguraAte.getTime() > Date.now() + (JANELA_DESFAZER_SEGUNDOS - 5) * 1000);

const copiasAntesDeDesfazer = await prisma.message.count({
  where: { mailboxId, folder: { kind: "sent" } },
});
const desfeito = await undoSend(mailboxId, envio.queuedId, envio.rfcMessageId);
check("desfazer dentro da janela cancela", desfeito.cancelado === true);
check("sai da fila de saida", (await prisma.outboundMessage.count({ where: { id: envio.queuedId } })) === 0);
check(
  "a copia em Enviados sai junto",
  (await prisma.message.count({ where: { mailboxId, folder: { kind: "sent" } } })) === copiasAntesDeDesfazer - 1,
);
check("desfazer de novo nao quebra", (await undoSend(mailboxId, envio.queuedId, envio.rfcMessageId).catch(() => ({ cancelado: false }))).cancelado === false);

// Fora da janela o worker ja pode ter pegado a mensagem: cancelar aqui seria
// prometer o que nao da para cumprir.
const envioVencido = await sendMessage({
  mailboxId,
  to: ["tarde@exemplo.com"],
  subject: "Fora da janela",
  text: "ja era",
});
await prisma.outboundMessage.update({
  where: { id: envioVencido.queuedId },
  data: { nextAttemptAt: new Date(Date.now() - 1000) },
});
check(
  "desfazer depois da janela nao cancela",
  (await undoSend(mailboxId, envioVencido.queuedId, envioVencido.rfcMessageId)).cancelado === false,
);
check(
  "e a mensagem continua na fila",
  (await prisma.outboundMessage.count({ where: { id: envioVencido.queuedId } })) === 1,
);

// --- Adiar mensagem ---
const { snoozeMessages, wakeSnoozed } = await import("../services/messages.js");

const paraAdiar = (await listMessages({ mailboxId, folder: "inbox" })).messages[0];
if (!paraAdiar) throw new Error("Entrada vazia: o teste de adiar precisa de uma mensagem.");
const daquiUmaHora = new Date(Date.now() + 3600_000);
const adiada = await snoozeMessages(mailboxId, [paraAdiar.id], daquiUmaHora);
check("adiar move a mensagem", adiada.adiadas === 1);
check(
  "sai da Entrada",
  !(await listMessages({ mailboxId, folder: "inbox" })).messages.some((m) => m.id === paraAdiar.id),
);
check(
  "aparece em Adiadas",
  (await listMessages({ mailboxId, folder: "snoozed" })).messages.some((m) => m.id === paraAdiar.id),
);

// Prazo no futuro: o varredor nao pode devolver antes da hora.
check("nao volta antes da hora", (await wakeSnoozed()) === 0);

await esperaErro(
  "recusa horario no passado",
  () => snoozeMessages(mailboxId, [paraAdiar.id], new Date(Date.now() - 1000)),
  "futuro",
);

// Vence o prazo na marra e deixa o varredor trabalhar.
await prisma.message.update({
  where: { id: paraAdiar.id },
  data: { snoozedUntil: new Date(Date.now() - 1000), seen: true },
});
check("varredor devolve a vencida", (await wakeSnoozed()) === 1);
const devolvida = await prisma.message.findUniqueOrThrow({
  where: { id: paraAdiar.id },
  select: { snoozedUntil: true, seen: true, folder: { select: { kind: true } } },
});
check("volta para a Entrada", devolvida.folder.kind === "inbox");
check("limpa o prazo", devolvida.snoozedUntil === null);
// Voltar como lida faria a mensagem reaparecer sem ninguem notar.
check("volta como nao lida", devolvida.seen === false);
check("nada sobra para devolver", (await wakeSnoozed()) === 0);


console.log("\n[19] Endpoints da Onda 1 do webmail");
const { markAllRead, unreadCounts } = await import("../services/messages.js");
const { revokeSession, listSessions } = await import("../services/session.js");

const contagem = await unreadCounts(mailboxId);
check("contagem de nao lidas responde por pasta", contagem.byFolder.length === SYSTEM_FOLDERS.length);
check("total bate com a soma", contagem.total === contagem.byFolder.reduce((s, p) => s + p.unread, 0));

const marcadas = await markAllRead(mailboxId, "inbox");
check("marca a pasta inteira como lida", marcadas.updated > 0);
check("nao sobra nao lida na entrada", (await unreadCounts(mailboxId)).byFolder.find((p) => p.kind === "inbox")?.unread === 0);
await esperaErro("recusa pasta inexistente", () => markAllRead(mailboxId, "inventada"), "nao encontrada");

const sessaoParaRevogar = await login({ address: "contato@brilhax.com.br", password: SENHA_NOVA, ip: "203.0.113.77" });
const dispositivos = await listSessions(mailboxId);
check("lista os dispositivos conectados", dispositivos.length >= 1);
await revokeSession(mailboxId, dispositivos[0]?.id ?? "");
check("revogar derruba so aquele dispositivo", (await listSessions(mailboxId)).length === dispositivos.length - 1);
await esperaErro("nao revoga sessao de outra caixa", () =>
  revokeSession(outraCaixa.id, dispositivos[1]?.id ?? "nao-existe"), "nao encontrada");
void sessaoParaRevogar;

console.log("\n[20] Enumeracao de conta por tempo de resposta");
async function medir(endereco: string): Promise<number> {
  const inicio = process.hrtime.bigint();
  await login({ address: endereco, password: "senhaQualquerErrada", ip: "192.0.2.99" }).catch(() => undefined);
  return Number(process.hrtime.bigint() - inicio) / 1_000_000;
}

/**
 * Mediana de tres medicoes, alternando os dois casos.
 *
 * Uma medicao unica com limite absoluto em milissegundos e fragil: sob carga,
 * o proprio ruido da maquina estoura o limite e o teste acusa vazamento onde
 * nao ha. O que denuncia o vazamento de verdade e a PROPORCAO — sem queimar o
 * tempo do bcrypt, o caminho "caixa inexistente" volta quase instantaneo,
 * ficando dezenas de vezes mais rapido, nao 20% mais rapido.
 */
function mediana(valores: number[]): number {
  const ordenados = [...valores].sort((a, b) => a - b);
  return ordenados[Math.floor(ordenados.length / 2)] ?? 0;
}

// Aquece para o primeiro bcrypt nao distorcer a medicao.
await medir("aquecimento@brilhax.com.br");

const existentes: number[] = [];
const inexistentes: number[] = [];
for (let volta = 0; volta < 3; volta += 1) {
  existentes.push(await medir("financeiro@brilhax.com.br"));
  inexistentes.push(await medir("naoexiste@brilhax.com.br"));
}

const tExistente = mediana(existentes);
const tInexistente = mediana(inexistentes);
const proporcao = tExistente / Math.max(tInexistente, 1);

check(
  `caixa existente e inexistente levam tempo comparavel (${tExistente.toFixed(0)}ms vs ${tInexistente.toFixed(0)}ms)`,
  proporcao > 0.5 && proporcao < 2,
  `proporcao de ${proporcao.toFixed(2)}x — acima de 2x indica vazamento`,
);

console.log("\n[21] Preferencias e perfil");
const { getSettings, updateSettings, updateProfile } = await import("../services/settings.js");

check("preferencias tem padrao seguro", (await getSettings(mailboxId)).showRemoteImages === false);

const prefs = await updateSettings(mailboxId, {
  signatureHtml: '<p>Nicolas<script>alert(1)</script><a href="https://avilaops.com">site</a></p>',
  showRemoteImages: true,
  messagesPerPage: 50,
});
// A assinatura e escrita pelo dono, mas cola em toda mensagem que sai com o
// nosso DKIM — conta comprometida nao pode virar veiculo de payload assinado.
check("assinatura passa pelo sanitizador", !(prefs.signatureHtml ?? "").includes("<script"));
check("assinatura preserva o legitimo", (prefs.signatureHtml ?? "").includes("avilaops.com"));
check("gera versao texto da assinatura", (prefs.signatureText ?? "").includes("Nicolas"));
check("salva demais preferencias", prefs.showRemoteImages === true && prefs.messagesPerPage === 50);

await esperaErro("recusa itens por pagina fora da faixa", () =>
  updateSettings(mailboxId, { messagesPerPage: 500 }), "entre 10 e 100");
await esperaErro("recusa ausencia sem mensagem", () =>
  updateSettings(mailboxId, { autoReplyEnabled: true }), "escreva a mensagem");
await esperaErro("recusa data de retorno invalida", () =>
  updateSettings(mailboxId, { autoReplyUntil: "nao-e-data" }), "invalida");

const perfil = await updateProfile(mailboxId, { displayName: "Contato Brilhax", recoveryEmail: "Dono@Empresa.com.BR" });
check("salva nome de exibicao", perfil.displayName === "Contato Brilhax");
check("normaliza e-mail de recuperacao", perfil.recoveryEmail === "dono@empresa.com.br");
// CRLF aqui viraria injecao de cabecalho no From: de toda mensagem enviada.
await esperaErro("recusa CRLF no nome de exibicao", () =>
  updateProfile(mailboxId, { displayName: "Fulano\r\nBcc: vitima@alvo.com" }), "invalido");
await esperaErro("recusa e-mail de recuperacao invalido", () =>
  updateProfile(mailboxId, { recoveryEmail: "sem-arroba" }), "invalido");

console.log("\n[22] Contatos e enviar-como");
const { searchContacts, listSendAs, canSendAs } = await import("../services/contacts.js");

const contatos = await searchContacts(mailboxId, "exemplo");
check("monta a agenda a partir do historico", contatos.length > 0);
check("contato traz frequencia como numero", typeof contatos[0]?.frequency === "number");
check("busca por nome tambem funciona", (await searchContacts(mailboxId, "cliente")).length > 0);
check("busca sem resultado devolve vazio", (await searchContacts(mailboxId, "zzznaoexiste")).length === 0);

await prisma.mailAlias.create({
  data: {
    domainId: (await prisma.mailDomain.findUniqueOrThrow({ where: { name: "brilhax.com.br" }, select: { id: true } })).id,
    localPart: "vendas",
    destination: "contato@brilhax.com.br",
  },
});
const enderecos = await listSendAs(mailboxId);
check("lista o proprio endereco como principal", enderecos.some((e) => e.primary && e.address === "contato@brilhax.com.br"));
check("lista o alias como enviar-como", enderecos.some((e) => e.address === "vendas@brilhax.com.br"));
check("autoriza envio pelo alias", await canSendAs(mailboxId, "vendas@brilhax.com.br"));
check("nao autoriza endereco alheio", !(await canSendAs(mailboxId, "chefe@brilhax.com.br")));

const envioAlias = await sendMessage({
  mailboxId,
  to: ["cliente@exemplo.com"],
  subject: "Pelo alias",
  text: "corpo",
  fromAddress: "vendas@brilhax.com.br",
  appendSignature: true,
});
const mimeAlias = (await readRaw((await prisma.outboundMessage.findUniqueOrThrow({
  where: { id: envioAlias.queuedId }, select: { storageKey: true },
})).storageKey)).toString("utf8");
check("envia com o endereco do alias", mimeAlias.includes("vendas@brilhax.com.br"));
check("assinatura anexada quando pedido", mimeAlias.includes("Nicolas"));
await esperaErro("recusa enviar como endereco nao autorizado", () =>
  sendMessage({ mailboxId, to: ["a@b.com"], text: "x", fromAddress: "chefe@brilhax.com.br" }), "nao pode enviar como");

console.log("\n[23] Anexos enviados antes da mensagem");
const { storeUpload, listUploads, deleteUpload } = await import("../services/uploads.js");

const upload = await storeUpload({
  mailboxId,
  filename: "contrato.pdf",
  contentType: "application/pdf",
  contentBase64: Buffer.from("conteudo do contrato").toString("base64"),
});
check("guarda o anexo pendente", upload.sizeBytes === 20);
check("aparece na lista de pendentes", (await listUploads(mailboxId)).length === 1);

await esperaErro("bloqueia extensao executavel", () =>
  storeUpload({ mailboxId, filename: "virus.exe", contentBase64: Buffer.from("x").toString("base64") }), "nao sao aceitos");
// Caminho no nome e neutralizado, nao rejeitado: o que importa e nao escapar
// do diretorio. Rejeitar puniria nome legitimo com barra por engano.
const nomePerigoso = await storeUpload({
  mailboxId,
  filename: "../../etc/passwd",
  contentBase64: Buffer.from("x").toString("base64"),
});
check(
  "neutraliza caminho no nome do anexo",
  !nomePerigoso.filename.includes("/") && !nomePerigoso.filename.startsWith("."),
  `resultou em: ${nomePerigoso.filename}`,
);
await deleteUpload(mailboxId, nomePerigoso.id);
await esperaErro("bloqueia base64 vazio", () =>
  storeUpload({ mailboxId, filename: "vazio.txt", contentBase64: "!!!" }), "invalido");

const envioComUpload = await sendMessage({
  mailboxId,
  to: ["cliente@exemplo.com"],
  subject: "Com anexo previo",
  text: "segue",
  attachmentIds: [upload.id],
});
check("anexo previo entra na mensagem", envioComUpload.queuedId.length > 0);
check("anexo previo sai da lista de pendentes", (await listUploads(mailboxId)).length === 0);
await esperaErro("anexo de outra caixa nao pode ser usado", () =>
  sendMessage({ mailboxId: outraCaixa.id, to: ["a@b.com"], text: "x", attachmentIds: [upload.id] }), "expirou ou nao pertence");

const paraApagar = await storeUpload({ mailboxId, filename: "temp.txt", contentBase64: Buffer.from("x").toString("base64") });
await deleteUpload(mailboxId, paraApagar.id);
check("remove anexo pendente", (await listUploads(mailboxId)).length === 0);

console.log("\n[24] Pastas proprias");
const { createFolder, renameFolder, deleteFolder } = await import("../services/folders.js");

const pastaNova = await createFolder(mailboxId, "Clientes");
check("cria pasta propria", pastaNova.kind === "custom" && pastaNova.name === "Clientes");
check("pasta aparece na listagem", (await listFolders(mailboxId)).length === SYSTEM_FOLDERS.length + 1);
await esperaErro("recusa nome repetido", () => createFolder(mailboxId, "Clientes"), "ja existe");
await esperaErro("recusa nome vazio", () => createFolder(mailboxId, "   "), "informe o nome");

const entrada = (await listFolders(mailboxId)).find((p) => p.kind === "inbox");
await esperaErro("nao renomeia pasta de sistema", () =>
  renameFolder(mailboxId, entrada?.id ?? "", "Minha Entrada"), "nao pode ser renomeada");
await esperaErro("nao exclui pasta de sistema", () =>
  deleteFolder(mailboxId, entrada?.id ?? ""), "nao pode ser excluida");
await esperaErro("nao mexe em pasta de outra caixa", () =>
  renameFolder(outraCaixa.id, pastaNova.id, "Roubada"), "nao encontrada");

const renomeada = await renameFolder(mailboxId, pastaNova.id, "Clientes VIP");
check("renomeia pasta propria", renomeada.name === "Clientes VIP");

const boasVindasId = (await listMessages({ mailboxId, folder: "inbox" })).messages[0]?.id ?? "";
await updateMessages({ mailboxId, messageIds: [boasVindasId], moveToFolderId: pastaNova.id });
check("move mensagem para pasta propria", (await listMessages({ mailboxId, folder: pastaNova.id })).messages.length === 1);
const mensagemVizinha = (await listMessages({ mailboxId: outraCaixa.id })).messages[0]?.id ?? "";
await esperaErro("nao move para pasta de outra caixa", () =>
  updateMessages({ mailboxId: outraCaixa.id, messageIds: [mensagemVizinha], moveToFolderId: pastaNova.id }),
  "nao encontrada");

// Excluir a organizacao nao pode significar excluir a correspondencia.
const excluida = await deleteFolder(mailboxId, pastaNova.id);
check("excluir pasta devolve as mensagens a entrada", excluida.movedToInbox === 1);
check("mensagem sobreviveu a exclusao da pasta", (await listMessages({ mailboxId, folder: "inbox" })).messages.length >= 1);

console.log("\n[25] Marcar spam e tirar do spam");
const { reportSpam } = await import("../services/messages.js");
const alvoSpam = (await listMessages({ mailboxId, folder: "inbox" })).messages[0]?.id ?? "";

await reportSpam(mailboxId, [alvoSpam], true);
check("mensagem vai para o Spam", (await listMessages({ mailboxId, folder: "spam" })).messages.length === 1);
check("registra o evento para treino futuro", (await prisma.mailEvent.count({ where: { type: "message.reported_spam" } })) === 1);

await reportSpam(mailboxId, [alvoSpam], false);
check("tirar do spam devolve a entrada", (await listMessages({ mailboxId, folder: "spam" })).messages.length === 0);
check("nao mexe em mensagem de outra caixa", (await reportSpam(outraCaixa.id, [alvoSpam], true)).moved === 0);

console.log("\n[26] Recuperacao de senha");
const { requestPasswordReset, resetPassword } = await import("../services/recovery.js");

const semRecuperacao = await requestPasswordReset({ address: "financeiro@brilhax.com.br", ip: "203.0.113.90" });
check("caixa sem e-mail de recuperacao responde igual", semRecuperacao.accepted === true && semRecuperacao.sentTo === null);
const inexistente = await requestPasswordReset({ address: "naoexiste@brilhax.com.br", ip: "203.0.113.90" });
check("caixa inexistente responde igual", inexistente.accepted === true && inexistente.sentTo === null);

await updateProfile(outraCaixa.id, { recoveryEmail: "pessoal@gmail.com" });
const pedido = await requestPasswordReset({ address: "financeiro@brilhax.com.br", ip: "203.0.113.91" });
check("com e-mail cadastrado, confirma o envio", pedido.sentTo !== null);
check("mascara o endereco de destino", pedido.sentTo?.includes("*") === true && !pedido.sentTo?.includes("pessoal@"));

const tokenRegistro = await prisma.passwordResetToken.findFirstOrThrow({
  where: { mailboxId: outraCaixa.id, usedAt: null },
  select: { id: true, tokenHash: true },
});
check("token guardado como hash, nao em claro", tokenRegistro.tokenHash.length === 64);

const emailReset = await prisma.outboundMessage.findFirst({
  where: { recipients: { array_contains: ["pessoal@gmail.com"] } },
  select: { storageKey: true },
});
const corpoReset = (await readRaw(emailReset?.storageKey ?? "")).toString("utf8");
// O corpo vai em quoted-printable: a quebra suave (=\r\n) parte o token no
// meio e o "?" vira =3F. Sem desfazer isso, o token sai truncado.
const corpoDecodificado = corpoReset
  .replace(/=\r?\n/g, "")
  .replace(/=3F/gi, "?")
  .replace(/=3D/gi, "=");
const tokenCru = corpoDecodificado.match(/redefinir\?token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
// 32 bytes em base64url dao exatamente 43 caracteres — token curto e sinal de
// truncamento, nao de token valido.
check("link de redefinicao chegou inteiro no e-mail", tokenCru.length === 43, `veio com ${tokenCru.length} caracteres`);

await esperaErro("token invalido e recusado", () =>
  resetPassword({ token: "token-inventado-qualquer", newPassword: "NovaSenhaSegura9" }), "invalido ou expirado");
await esperaErro("recusa senha curta na redefinicao", () =>
  resetPassword({ token: tokenCru, newPassword: "curta" }), "12 caracteres");

const redefinida = await resetPassword({ token: tokenCru, newPassword: "NovaSenhaSegura9" });
check("redefine a senha", redefinida.address === "financeiro@brilhax.com.br");
check("senha nova funciona", (await login({ address: "financeiro@brilhax.com.br", password: "NovaSenhaSegura9", ip: "203.0.113.92" })).accessToken.length > 0);
await esperaErro("token nao pode ser reutilizado", () =>
  resetPassword({ token: tokenCru, newPassword: "OutraSenhaSegura9" }), "invalido ou expirado");

console.log("\n[27] Resposta automatica e protecao contra loop");
const { shouldAutoReply } = await import("../services/autoreply.js");
const { simpleParser: parse } = await import("mailparser");

async function decidir(headersExtras: string, envelope = "remetente@exemplo.com") {
  const bruto = Buffer.from(
    [
      "From: Remetente <remetente@exemplo.com>",
      "To: contato@brilhax.com.br",
      "Subject: teste",
      headersExtras,
      "",
      "corpo",
      "",
    ].filter(Boolean).join("\r\n"),
  );
  return shouldAutoReply(await parse(bruto), envelope, "contato@brilhax.com.br");
}

check("responde mensagem humana normal", (await decidir("")).reply === true);
// Cada um destes e um convite a pingue-pongue infinito entre dois servidores.
check("nao responde a envelope nulo (bounce)", (await decidir("", "")).reply === false);
check("nao responde a auto-submitted", (await decidir("Auto-Submitted: auto-replied")).reply === false);
check("nao responde a precedence bulk", (await decidir("Precedence: bulk")).reply === false);
check("nao responde a lista de discussao", (await decidir("List-Id: <lista.exemplo.com>")).reply === false);
check("nao responde a pedido de supressao", (await decidir("X-Auto-Response-Suppress: All")).reply === false);
check("nao responde a mailer-daemon", (await decidir("", "mailer-daemon@exemplo.com")).reply === false);
check("nao responde a noreply", (await decidir("", "noreply@exemplo.com")).reply === false);
check("nao responde a si mesma", (await decidir("", "contato@brilhax.com.br")).reply === false);

await updateSettings(mailboxId, {
  autoReplyEnabled: true,
  autoReplyBody: "Estou de ferias ate dia 20.",
  autoReplySubject: "Ausente",
});
const destinoAuto = await resolveRecipient("contato@brilhax.com.br");
if (destinoAuto.kind !== "mailbox") throw new Error("caixa sumiu");

const antesAuto = await prisma.outboundMessage.count();
await deliverToMailbox(destinoAuto, MENSAGEM_BRUTA, null, { envelopeFrom: "cliente@exemplo.com" });
check("dispara resposta automatica", (await prisma.outboundMessage.count()) === antesAuto + 1);

// Segunda mensagem do mesmo remetente nao gera segunda resposta.
await deliverToMailbox(destinoAuto, MENSAGEM_BRUTA, null, { envelopeFrom: "cliente@exemplo.com" });
check("nao responde duas vezes ao mesmo remetente", (await prisma.outboundMessage.count()) === antesAuto + 1);

const automatica = await prisma.outboundMessage.findFirstOrThrow({
  orderBy: { createdAt: "desc" },
  select: { envelopeFrom: true, storageKey: true },
});
check("resposta automatica sai com envelope nulo", automatica.envelopeFrom === "");
const corpoAuto = (await readRaw(automatica.storageKey)).toString("utf8");
check("marca a saida como automatica", corpoAuto.includes("Auto-Submitted: auto-replied"));

await updateSettings(mailboxId, { autoReplyEnabled: false });

console.log("\n[28] POP3 — o que o Gmail usa para buscar e-mail de outra conta");
const { criarServidorPop3 } = await import("../mta/pop3.js");
const { execFileSync } = await import("node:child_process");
const tls = await import("node:tls");
const net = await import("node:net");
const { writeFileSync, readFileSync: lerArquivo } = await import("node:fs");

// Certificado autoassinado so para o teste: o POP3 e o IMAP recusam senha sem
// TLS, e essa recusa e justamente uma das coisas que precisamos verificar.
//
// Quando o runner ja gerou um (deploy/run-integration.sh), usamos o dele: e o
// que esta no NODE_EXTRA_CA_CERTS, e sem isso o teste de migracao nao
// confiaria no nosso proprio servidor fazendo papel de provedor antigo.
const certPath = process.env.MAIL_TESTE_CERT ?? join(workDir, "teste.crt");
const keyPath = process.env.MAIL_TESTE_KEY ?? join(workDir, "teste.key");
if (!process.env.MAIL_TESTE_CERT) {
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-days", "1",
    "-subj", "/CN=127.0.0.1",
    "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
  ], { stdio: "ignore" });
}

const opcoesTls = { cert: lerArquivo(certPath), key: lerArquivo(keyPath) };
const servidorPop3 = criarServidorPop3({ seguro: true, tls: opcoesTls });
const servidorPop3Plano = criarServidorPop3({ seguro: false });
await new Promise<void>((r) => servidorPop3.listen(0, "127.0.0.1", () => r()));
await new Promise<void>((r) => servidorPop3Plano.listen(0, "127.0.0.1", () => r()));
const portaTls = (servidorPop3.address() as { port: number }).port;
const portaPlana = (servidorPop3Plano.address() as { port: number }).port;

/** Conversa POP3: manda um comando por vez e devolve a resposta completa. */
function criarCliente(socket: NodeJS.ReadWriteStream) {
  let buffer = "";
  const esperando: Array<{ multilinha: boolean; resolve: (v: string) => void }> = [];

  socket.on("data", (pedaco: Buffer) => {
    buffer += pedaco.toString("utf8");

    while (esperando.length > 0) {
      const alvo = esperando[0]!;
      const fimSimples = buffer.indexOf("\r\n");
      if (fimSimples === -1) return;

      const primeira = buffer.slice(0, fimSimples);
      const negativa = primeira.startsWith("-ERR");

      if (!alvo.multilinha || negativa) {
        buffer = buffer.slice(fimSimples + 2);
        esperando.shift()!.resolve(primeira);
        continue;
      }

      const fimMulti = buffer.indexOf("\r\n.\r\n");
      if (fimMulti === -1) return;
      const bloco = buffer.slice(0, fimMulti);
      buffer = buffer.slice(fimMulti + 5);
      esperando.shift()!.resolve(bloco);
    }
  });

  return {
    ler: (multilinha = false) =>
      new Promise<string>((resolve) => {
        esperando.push({ multilinha, resolve });
        // Reprocessa o que ja chegou no buffer.
        socket.emit("data", Buffer.alloc(0));
      }),
    enviar(comando: string, multilinha = false) {
      const p = new Promise<string>((resolve) => esperando.push({ multilinha, resolve }));
      socket.write(`${comando}\r\n`);
      return p;
    },
  };
}

// --- Recusa senha sem TLS ---
const planoSocket = net.connect(portaPlana, "127.0.0.1");
await new Promise<void>((r) => planoSocket.once("connect", () => r()));
const plano = criarCliente(planoSocket);
await plano.ler();
await plano.enviar("USER contato@brilhax.com.br");
const semTls = await plano.enviar(`PASS ${SENHA_NOVA}`);
// Senha em texto claro entrega a caixa para quem estiver no caminho.
check("POP3 recusa senha sem TLS", semTls.startsWith("-ERR") && semTls.includes("995"));
const capaPlana = await plano.enviar("CAPA", true);
check("anuncia STLS quando ainda nao esta cifrado", capaPlana.includes("STLS"));
planoSocket.end();

// --- Sessao real sobre TLS ---
const seguroSocket = tls.connect({ port: portaTls, host: "127.0.0.1", rejectUnauthorized: false });
await new Promise<void>((r) => seguroSocket.once("secureConnect", () => r()));
const pop = criarCliente(seguroSocket);
check("saudacao inicial", (await pop.ler()).startsWith("+OK"));

check("recusa comando antes de autenticar", (await pop.enviar("STAT")).startsWith("-ERR"));
check("senha errada e recusada", (await (async () => {
  await pop.enviar("USER contato@brilhax.com.br");
  return pop.enviar("PASS senhaErrada123");
})()).startsWith("-ERR"));

await pop.enviar("USER contato@brilhax.com.br");
const autenticado = await pop.enviar(`PASS ${SENHA_NOVA}`);
check("autentica com a senha certa", autenticado.startsWith("+OK"));

const stat = await pop.enviar("STAT");
const [, qtd, bytes] = stat.split(/\s+/);
check("STAT devolve quantidade e tamanho", Number(qtd) > 0 && Number(bytes) > 0);

const linhasLista = (await pop.enviar("LIST", true)).split("\r\n").slice(1);
check("LIST numera as mensagens a partir de 1", linhasLista.some((l) => /^1 \d+$/.test(l)));
check("LIST traz uma linha por mensagem", linhasLista.length === Number(qtd));

const uidl = await pop.enviar("UIDL", true);
// O identificador precisa ser estavel: e por ele que o Gmail sabe o que ja baixou.
check("UIDL devolve identificador estavel por mensagem", /\b1 [a-z0-9]{20,}/.test(uidl));

const topo = await pop.enviar("TOP 1 2", true);
check("TOP devolve cabecalhos", /(?:^|\r\n)Subject:/i.test(topo));

const retr = await pop.enviar("RETR 1", true);
check("RETR devolve a mensagem inteira", retr.includes("Subject:") && retr.length > 100);

check("DELE marca para remocao", (await pop.enviar("DELE 1")).startsWith("+OK"));
check("mensagem marcada some do LIST", !(await pop.enviar("LIST", true)).split("\r\n").slice(1).some((l) => l.startsWith("1 ")));
check("RSET desfaz a marcacao", (await pop.enviar("RSET")).startsWith("+OK"));
check("mensagem volta ao LIST depois do RSET", (await pop.enviar("LIST", true)).split("\r\n").slice(1).some((l) => l.startsWith("1 ")));

// Apaga de novo e encerra: o DELE so vira realidade no QUIT.
const lixeiraAntesPop = (await listMessages({ mailboxId, folder: "trash" })).messages.length;
await pop.enviar("DELE 1");
await pop.enviar("QUIT");
await new Promise<void>((r) => seguroSocket.once("close", () => r()));

// Mover para a Lixeira em vez de destruir: o Gmail marca para apagar por
// padrao, e destruir aqui apagaria do webmail o que ele acabou de puxar.
check(
  "apagado no POP3 vai para a Lixeira, nao some",
  (await listMessages({ mailboxId, folder: "trash" })).messages.length === lixeiraAntesPop + 1,
);

await new Promise<void>((r) => servidorPop3.close(() => r()));
await new Promise<void>((r) => servidorPop3Plano.close(() => r()));

console.log("\n[29] IMAP — o que Outlook, Apple Mail e apps de celular falam");
const { criarServidorImap } = await import("../mta/imap.js");

const servidorImap = criarServidorImap({ seguro: true, tls: opcoesTls });
await new Promise<void>((r) => servidorImap.listen(0, "127.0.0.1", () => r()));
const portaImap = (servidorImap.address() as { port: number }).port;

/** Cliente IMAP: acumula ate ver a linha marcada com a tag do comando. */
function criarClienteImap(socket: NodeJS.ReadWriteStream) {
  let buffer = "";
  let sequencia = 0;
  let aguardando: { tag: string; resolve: (v: string) => void } | null = null;

  socket.on("data", (pedaco: Buffer) => {
    buffer += pedaco.toString("utf8");
    if (!aguardando) return;

    // A resposta termina na linha "<tag> OK|NO|BAD ..."
    const fim = new RegExp(`^${aguardando.tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`, "m").exec(buffer);
    if (!fim) return;

    const corte = buffer.indexOf(fim[0]) + fim[0].length;
    const resposta = buffer.slice(0, corte);
    buffer = buffer.slice(corte);
    const pendente = aguardando;
    aguardando = null;
    pendente.resolve(resposta);
  });

  return {
    saudacao: () =>
      new Promise<string>((resolve) => {
        const conferir = setInterval(() => {
          if (buffer.includes("\r\n")) {
            clearInterval(conferir);
            const linha = buffer.slice(0, buffer.indexOf("\r\n"));
            buffer = buffer.slice(buffer.indexOf("\r\n") + 2);
            resolve(linha);
          }
        }, 10);
      }),
    /**
     * Comando terminado em literal: anuncia {N}, espera o "+" do servidor e so
     * entao despeja os bytes. E assim que o APPEND de verdade acontece.
     */
    enviarComLiteral(prefixo: string, conteudo: string) {
      sequencia += 1;
      const tag = `A${String(sequencia).padStart(3, "0")}`;
      const p = new Promise<string>((resolve) => {
        aguardando = { tag, resolve };
      });
      const bytes = Buffer.byteLength(conteudo);
      socket.write(`${tag} ${prefixo}{${bytes}}
`);
      // Mandamos o corpo sem esperar o "+": e o que clientes reais fazem, e o
      // servidor tem de aguentar o literal chegando junto com o anuncio.
      socket.write(conteudo + "\r\n");
      return p;
    },
    enviar(comando: string) {
      sequencia += 1;
      const tag = `A${String(sequencia).padStart(3, "0")}`;
      const p = new Promise<string>((resolve) => {
        aguardando = { tag, resolve };
      });
      socket.write(`${tag} ${comando}\r\n`);
      return p;
    },
  };
}

const socketImap = tls.connect({ port: portaImap, host: "127.0.0.1", rejectUnauthorized: false });
await new Promise<void>((r) => socketImap.once("secureConnect", () => r()));
const imap = criarClienteImap(socketImap);

const saudacaoImap = await imap.saudacao();
check("anuncia IMAP4rev1 na saudacao", saudacaoImap.includes("IMAP4rev1"));

const capImap = await imap.enviar("CAPABILITY");
check("anuncia IDLE (push no celular)", capImap.includes("IDLE"));
check("anuncia MOVE e UIDPLUS", capImap.includes("MOVE") && capImap.includes("UIDPLUS"));

check("recusa senha errada", (await imap.enviar(`LOGIN contato@brilhax.com.br senhaErrada1`)).includes("NO"));
check("autentica", (await imap.enviar(`LOGIN contato@brilhax.com.br ${SENHA_NOVA}`)).includes("OK"));

const listaPastas = await imap.enviar('LIST "" "*"');
// O cliente descobre a Lixeira e os Enviados pelos atributos, nao pelo nome —
// senao "Lixeira" em portugues nunca seria reconhecida como Trash.
check("Caixa de Entrada aparece como INBOX", listaPastas.includes("INBOX"));
check("marca a Lixeira com \\Trash", listaPastas.includes("\\Trash"));
check("marca os Enviados com \\Sent", listaPastas.includes("\\Sent"));

// LIST tem de respeitar a referencia e o padrao. Devolver tudo sempre faz o
// cliente inventar pastas: ele pergunta "o que ha dentro de Lixeira?" e, ao
// receber a lista inteira, passa a acreditar numa Lixeira/Enviados.
const listaFilhas = await imap.enviar('LIST "Lixeira/" "%"');
check("nao inventa subpasta de pasta sem filhos", !listaFilhas.includes("Enviados"));

const listaExata = await imap.enviar('LIST "" "INBOX"');
check("padrao exato traz so a pasta pedida", listaExata.includes("INBOX"));
check("e nao traz as outras", !listaExata.includes("Enviados"));

// LIST "" "" e a pergunta "qual e o separador?" - o cliente monta a arvore
// de pastas com essa resposta.
const separador = await imap.enviar('LIST "" ""');
check("informa o separador de hierarquia", separador.includes('"/"'));

const statusInbox = await imap.enviar("STATUS INBOX (MESSAGES UNSEEN UIDNEXT UIDVALIDITY)");
check("STATUS traz UIDVALIDITY e UIDNEXT", /UIDVALIDITY \d+/.test(statusInbox) && /UIDNEXT \d+/.test(statusInbox));

const selecao = await imap.enviar("SELECT INBOX");
check("SELECT informa quantas existem", /\* \d+ EXISTS/.test(selecao));
check("SELECT informa UIDVALIDITY", selecao.includes("UIDVALIDITY"));
check("SELECT abre para escrita", selecao.includes("READ-WRITE"));

const fetch1 = await imap.enviar("UID FETCH 1:* (UID FLAGS RFC822.SIZE ENVELOPE)");
check("UID FETCH devolve UID", /UID \d+/.test(fetch1));
check("UID FETCH devolve ENVELOPE com assunto", fetch1.includes("ENVELOPE"));
check("UID FETCH devolve tamanho", /RFC822\.SIZE \d+/.test(fetch1));

const primeiroUid = Number(/UID (\d+)/.exec(fetch1)?.[1] ?? 0);
check("os UIDs comecam em 1", primeiroUid >= 1);

// O UID e unico DENTRO da pasta, nao dentro da caixa: a mensagem de UID 1 dos
// Enviados e outra mensagem. Toda conferencia daqui em diante precisa dizer a
// qual pasta se refere, senao encontra a mensagem errada.
const inboxId = (
  await prisma.mailFolder.findFirstOrThrow({ where: { mailboxId, kind: "inbox" }, select: { id: true } })
).id;

const corpo = await imap.enviar(`UID FETCH ${primeiroUid} (BODY.PEEK[])`);
check("BODY.PEEK devolve a mensagem inteira", corpo.includes("Subject:") || corpo.includes("subject:"));

check("STORE marca como favorita", (await imap.enviar(`UID STORE ${primeiroUid} +FLAGS (\\Flagged)`)).includes("OK"));

// O Outlook novo manda ID, NAMESPACE e ENABLE logo depois de logar e desiste
// da conta ("INVALIDCREDENTIALS INTERACTIONREQUIRED") se algum voltar NO/BAD.
check("ID responde OK", (await imap.enviar('ID ("name" "Microsoft Outlook")')).includes("OK"));
check("NAMESPACE responde OK", (await imap.enviar("NAMESPACE")).includes("OK"));
check("ENABLE responde OK", (await imap.enviar("ENABLE CONDSTORE")).includes("OK"));
check(
  "a marcacao chegou no banco",
  (
    await prisma.message.findFirstOrThrow({
      where: { folderId: inboxId, uid: primeiroUid },
      select: { flagged: true },
    })
  ).flagged,
);

const buscaImap = await imap.enviar("UID SEARCH UNSEEN");
check("SEARCH responde a lista de nao lidas", buscaImap.includes("* SEARCH"));

// MOVE tem de tirar o UID novo da sequencia DO DESTINO. Reaproveitar o numero
// da origem faria o cliente exibir a mensagem errada; por isso a conferencia e
// contra o `uidNext` da Lixeira, e nao contra o UID antigo — os dois numeros
// podem coincidir por acaso sem que nada esteja errado.
const antesMove = await prisma.message.findFirstOrThrow({
  where: { folderId: inboxId, uid: primeiroUid },
  select: { id: true, uid: true },
});
const lixeiraAntesImap = await prisma.mailFolder.findFirstOrThrow({
  where: { mailboxId, kind: "trash" },
  select: { id: true, uidNext: true },
});
check("MOVE aceito", (await imap.enviar(`UID MOVE ${primeiroUid} Lixeira`)).includes("OK"));
const depoisMove = await prisma.message.findUniqueOrThrow({
  where: { id: antesMove.id },
  select: { uid: true, folderId: true, folder: { select: { kind: true, uidNext: true } } },
});
check("mensagem foi para a Lixeira", depoisMove.folder.kind === "trash");
check("recebeu o UID da sequencia do destino", depoisMove.uid === lixeiraAntesImap.uidNext);
check("a sequencia do destino avancou", depoisMove.folder.uidNext === lixeiraAntesImap.uidNext + 1);
check("sumiu da Caixa de Entrada", depoisMove.folderId !== inboxId);
check(
  "nao ficou UID repetido na Lixeira",
  (await prisma.message.count({ where: { folderId: lixeiraAntesImap.id, uid: depoisMove.uid } })) === 1,
);

check("CREATE cria pasta pelo cliente", (await imap.enviar('CREATE "Projetos"')).includes("OK"));
check("a pasta aparece no LIST", (await imap.enviar('LIST "" "*"')).includes("Projetos"));
check("DELETE remove a pasta", (await imap.enviar('DELETE "Projetos"')).includes("OK"));

// APPEND e como o Outlook guarda a copia do que enviou e como o celular salva
// rascunho. Sem ele o cliente acusa erro a cada envio.
const mensagemAppend = [
  "From: Contato Brilhax <contato@brilhax.com.br>",
  "To: cliente@exemplo.com",
  "Subject: Copia enviada pelo Outlook",
  "Message-ID: <append-teste@brilhax.com.br>",
  "",
  "Corpo com (parenteses), \"aspas\" e ate {chaves} para confundir o analisador.",
  "",
].join("\r\n");

const enviadosAntes = await prisma.mailFolder.findFirstOrThrow({
  where: { mailboxId, kind: "sent" },
  select: { id: true, uidNext: true },
});

const respostaAppend = await imap.enviarComLiteral(
  // A barra faz parte da flag: "(Seen)" sem barra e palavra-chave do usuario,
  //  e o servidor tem razao em nao trata-la como Seen.
  `APPEND Enviados (\\Seen) `,
  mensagemAppend,
);
check("APPEND aceito", respostaAppend.includes("OK"));
check("APPEND devolve APPENDUID (o cliente precisa saber o UID)", respostaAppend.includes("APPENDUID"));

const guardada = await prisma.message.findFirst({
  where: { folderId: enviadosAntes.id, rfcMessageId: "<append-teste@brilhax.com.br>" },
  select: { uid: true, seen: true, subject: true, sizeBytes: true },
});
check("mensagem foi parar nos Enviados", guardada !== null);
check("assunto foi lido do corpo enviado", guardada?.subject === "Copia enviada pelo Outlook");
check("a flag \Seen do APPEND foi respeitada", guardada?.seen === true);
check("recebeu UID da sequencia dos Enviados", guardada?.uid === enviadosAntes.uidNext);

// O corpo tem parenteses e chaves de proposito: se o servidor tivesse embutido
// o literal no texto do comando, ele teria lido o e-mail como sintaxe.
check("o corpo nao virou comando", (await imap.enviar("NOOP")).includes("OK"));

check(
  "APPEND em pasta inexistente pede TRYCREATE",
  (await imap.enviarComLiteral("APPEND NaoExiste ", `From: a@b.c\r\n\r\noi\r\n`)).includes(
    "TRYCREATE",
  ),
);

check("comando desconhecido responde BAD", (await imap.enviar("INVENTADO xyz")).includes("BAD"));
check("LOGOUT encerra", (await imap.enviar("LOGOUT")).includes("OK"));

// Apple Mail prefere AUTHENTICATE PLAIN ao LOGIN. Anunciamos AUTH=PLAIN no
// CAPABILITY, entao ele precisa funcionar de verdade.
const socketAuth = tls.connect({ port: portaImap, host: "127.0.0.1", rejectUnauthorized: false });
await new Promise<void>((r) => socketAuth.once("secureConnect", () => r()));
const imapAuth = criarClienteImap(socketAuth);
await imapAuth.saudacao();

const credencial = Buffer.from(`\0contato@brilhax.com.br\0${SENHA_NOVA}`, "utf8").toString("base64");
check("AUTHENTICATE PLAIN autentica", (await imapAuth.enviar(`AUTHENTICATE PLAIN ${credencial}`)).includes("OK"));
check("e a sessao funciona depois disso", (await imapAuth.enviar("SELECT INBOX")).includes("OK"));

const ruim = Buffer.from("\0contato@brilhax.com.br\0senhaErrada", "utf8").toString("base64");
const socketRuim = tls.connect({ port: portaImap, host: "127.0.0.1", rejectUnauthorized: false });
await new Promise<void>((r) => socketRuim.once("secureConnect", () => r()));
const imapRuim = criarClienteImap(socketRuim);
await imapRuim.saudacao();
check("AUTHENTICATE PLAIN recusa senha errada", (await imapRuim.enviar(`AUTHENTICATE PLAIN ${ruim}`)).includes("NO"));
socketRuim.destroy();
socketAuth.destroy();
await new Promise<void>((r) => servidorImap.close(() => r()));

console.log("\n[30] Cobranca recorrente no Mercado Pago");
const {
  garantirConta,
  iniciarAssinatura,
  sincronizarValor,
  processarNotificacao,
  resumoConta,
  visaoGeral,
  cancelarAssinatura,
} = await import("../services/billing.js");
const { assinaturaValida } = await import("../lib/mercadopago.js");
const { createHmac } = await import("node:crypto");

/**
 * Mercado Pago simulado. Intercepta o `fetch` global, então o código real do
 * cliente HTTP roda inteiro — URL, corpo, cabeçalho de autorização — e só a
 * resposta é fabricada. Testar contra um mock do serviço deixaria de fora
 * justamente a parte que costuma estar errada: o formato da requisição.
 */
const chamadasMp: Array<{ url: string; metodo: string; corpo: unknown }> = [];
let estadoAssinatura = "pending";
let pagamentoAprovado = true;

const fetchOriginal = globalThis.fetch;
globalThis.fetch = (async (entrada: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = String(entrada);
  if (!url.startsWith("https://api.mercadopago.com")) return fetchOriginal(entrada, init);

  const corpo = init?.body ? JSON.parse(String(init.body)) : null;
  chamadasMp.push({ url, metodo: init?.method ?? "GET", corpo });

  const responder = (dados: unknown) =>
    new Response(JSON.stringify(dados), { status: 200, headers: { "Content-Type": "application/json" } });

  if (url.includes("/authorized_payments/")) {
    return responder({
      id: 987654321,
      preapproval_id: "PREAPPROVAL-TESTE",
      status: pagamentoAprovado ? "processed" : "recycling",
      payment: { id: 111, status: pagamentoAprovado ? "approved" : "rejected", status_detail: "cc_rejected_insufficient_amount" },
      transaction_amount: 20,
    });
  }

  if (init?.method === "PUT") {
    if (corpo?.status) estadoAssinatura = corpo.status;
    return responder({ id: "PREAPPROVAL-TESTE", status: estadoAssinatura });
  }

  return responder({
    id: "PREAPPROVAL-TESTE",
    status: estadoAssinatura,
    init_point: "https://www.mercadopago.com.br/subscriptions/checkout?preapproval_id=PREAPPROVAL-TESTE",
    external_reference: "cli_brilhax",
    next_payment_date: "2026-09-13T10:00:00.000-03:00",
  });
}) as typeof fetch;

const conta = await garantirConta({
  clientRef: "cli_brilhax",
  payerEmail: "Financeiro@Brilhax.com.BR",
  payerName: "Brilhax LTDA",
});
check("cria a conta de cobranca", conta.clientRef === "cli_brilhax");
check("normaliza o e-mail do pagador", conta.payerEmail === "financeiro@brilhax.com.br");
check("nasce aguardando cartao", conta.status === "pending_card");
await esperaErro("recusa e-mail de pagador invalido", () =>
  garantirConta({ clientRef: "x", payerEmail: "sem-arroba" }), "invalido");

// Quatro caixas existem nesta altura: contato, financeiro, alvo e comercial.
const assinatura = await iniciarAssinatura("cli_brilhax");
check("devolve o link do cartao", assinatura.initPoint?.includes("mercadopago.com.br") === true);
check("cobra R$ 10 por caixa", assinatura.amountCents === assinatura.mailboxCount * 1000);

const criacao = chamadasMp.find((c) => c.metodo === "POST" && c.url.endsWith("/preapproval"));
const corpoCriacao = criacao?.corpo as Record<string, any>;
check("envia frequencia mensal", corpoCriacao?.auto_recurring?.frequency_type === "months");
check("envia o valor em reais, nao centavos", corpoCriacao?.auto_recurring?.transaction_amount === assinatura.mailboxCount * 10);
check("envia moeda BRL", corpoCriacao?.auto_recurring?.currency_id === "BRL");
check("amarra a assinatura ao cliente", corpoCriacao?.external_reference === "cli_brilhax");
// Sem card_token_id o MP devolve init_point e o cartao e cadastrado la:
// nenhum dado de cartao passa por aqui.
check("NAO envia dado de cartao", corpoCriacao?.card_token_id === undefined);

// O webhook confirmaria isso; aqui simulamos o cartão já cadastrado.
await prisma.billingAccount.update({ where: { clientRef: "cli_brilhax" }, data: { status: "authorized" } });
await esperaErro("nao assina duas vezes", () => iniciarAssinatura("cli_brilhax"), "ja tem assinatura ativa");

console.log("\n[30] Valor acompanha o numero de caixas");
const antesSync = (await resumoConta("cli_brilhax")).mailboxCount;
await createMailbox({ domain: "brilhax.com.br", username: "suporte", password: SENHA });
const depoisSync = await resumoConta("cli_brilhax");
check("caixa nova entra na conta sozinha", depoisSync.mailboxCount === antesSync + 1);
check("valor sobe junto", depoisSync.amountCents === depoisSync.mailboxCount * 1000);

const ajuste = chamadasMp.filter((c) => c.metodo === "PUT" && (c.corpo as any)?.auto_recurring).pop();
check("avisa o Mercado Pago do novo valor", (ajuste?.corpo as any)?.auto_recurring?.transaction_amount === depoisSync.mailboxCount * 10);
check("sincronizar sem mudanca nao chama o MP", (await sincronizarValor("cli_brilhax")).alterado === false);

console.log("\n[31] Assinatura do webhook");
function assinar(dataId: string, requestId: string, ts: number): string {
  const manifesto = `id:${dataId};request-id:${requestId};ts:${ts};`;
  return createHmac("sha256", process.env.MP_WEBHOOK_SECRET!).update(manifesto).digest("hex");
}
const agora = Math.floor(Date.now() / 1000);

check(
  "aceita notificacao legitima",
  assinaturaValida({ xSignature: `ts=${agora},v1=${assinar("123", "req-1", agora)}`, xRequestId: "req-1", dataId: "123" }),
);
check(
  "recusa assinatura forjada",
  !assinaturaValida({ xSignature: `ts=${agora},v1=${"0".repeat(64)}`, xRequestId: "req-1", dataId: "123" }),
);
check(
  "recusa id trocado com assinatura valida de outro id",
  !assinaturaValida({ xSignature: `ts=${agora},v1=${assinar("123", "req-1", agora)}`, xRequestId: "req-1", dataId: "999" }),
);
// Replay: repetir uma notificacao antiga de "pagamento aprovado" reativaria
// uma conta suspensa.
const velho = agora - 3600;
check(
  "recusa notificacao antiga (replay)",
  !assinaturaValida({ xSignature: `ts=${velho},v1=${assinar("123", "req-1", velho)}`, xRequestId: "req-1", dataId: "123" }),
);
check("recusa cabecalho sem v1", !assinaturaValida({ xSignature: `ts=${agora}`, xRequestId: "req-1", dataId: "123" }));

console.log("\n[32] Notificacoes e idempotencia");
const primeira = await processarNotificacao({
  topic: "subscription_authorized_payment",
  action: "payment.created",
  dataId: "987654321",
});
check("processa a cobranca aprovada", primeira.processada === true);
check("registra o pagamento", (await resumoConta("cli_brilhax")).payments.length === 1);
check("guarda o valor cobrado", (await resumoConta("cli_brilhax")).payments[0]?.amountCents === 2000);

// O MP reenvia por dias qualquer notificacao que nao receba 200 rapido.
const repetida = await processarNotificacao({ topic: "subscription_authorized_payment", dataId: "987654321" });
check("notificacao repetida nao entra duas vezes", repetida.processada === false);
check("continua com um pagamento so", (await resumoConta("cli_brilhax")).payments.length === 1);

console.log("\n[33] Inadimplencia suspende, pagamento reativa");
const ativasAntes = await prisma.mailbox.count({ where: { status: "active", domain: { clientRef: "cli_brilhax" } } });
check("caixas ativas antes da recusa", ativasAntes > 0);

// Recusa dentro da tolerancia: nao pode derrubar quem trocou o cartao ontem.
pagamentoAprovado = false;
await processarNotificacao({ topic: "subscription_authorized_payment", dataId: "recusa-1" });
check(
  "recusa dentro da tolerancia nao suspende",
  (await prisma.mailbox.count({ where: { status: "active", domain: { clientRef: "cli_brilhax" } } })) === ativasAntes,
);

// Passada a tolerancia, o acesso cai.
await prisma.billingAccount.update({
  where: { clientRef: "cli_brilhax" },
  data: { lastPaymentAt: new Date(Date.now() - 30 * 86_400_000) },
});
await processarNotificacao({ topic: "subscription_authorized_payment", dataId: "recusa-2" });
check(
  "passada a tolerancia, suspende o acesso",
  (await prisma.mailbox.count({ where: { status: "active", domain: { clientRef: "cli_brilhax" } } })) === 0,
);
// Suspensa perde o acesso, nao o recebimento — decisao ja tomada no provisionamento.
check(
  "caixa suspensa continua recebendo",
  (await resolveRecipient("suporte@brilhax.com.br")).kind === "mailbox",
);
check("marca a data da suspensao", (await resumoConta("cli_brilhax")).suspendedAt !== null);

pagamentoAprovado = true;
await processarNotificacao({ topic: "subscription_authorized_payment", dataId: "pagamento-ok" });
check(
  "pagamento reativa as caixas",
  (await prisma.mailbox.count({ where: { status: "active", domain: { clientRef: "cli_brilhax" } } })) === ativasAntes,
);
check("zera as tentativas falhas", (await resumoConta("cli_brilhax")).failedAttempts === 0);

// Caixa desativada de proposito nao pode voltar so porque a fatura foi paga.
await setMailboxStatus("brilhax.com.br", "suporte", "disabled");
await processarNotificacao({ topic: "subscription_authorized_payment", dataId: "pagamento-ok-2" });
check(
  "caixa desativada permanece desativada",
  (await prisma.mailbox.findFirstOrThrow({ where: { localPart: "suporte" }, select: { status: true } })).status === "disabled",
);

console.log("\n[34] Cancelamento e visao geral");
// O id notificado e o da assinatura, o mesmo do comeco ao fim. A primeira
// notificacao (cartao ainda nao cadastrado) nao pode fazer as seguintes serem
// descartadas como repetidas: sao elas que provisionam e que cancelam.
estadoAssinatura = "pending";
await processarNotificacao({ topic: "subscription_preapproval", dataId: "PREAPPROVAL-TESTE" });
check("espelha a assinatura ainda sem cartao", (await resumoConta("cli_brilhax")).status === "pending");

estadoAssinatura = "authorized";
const autorizada = await processarNotificacao({ topic: "subscription_preapproval", dataId: "PREAPPROVAL-TESTE" });
check("segunda notificacao da mesma assinatura e processada", autorizada.processada === true);
check("espelha a autorizacao", (await resumoConta("cli_brilhax")).status === "authorized");

estadoAssinatura = "cancelled";
await processarNotificacao({ topic: "subscription_preapproval", dataId: "PREAPPROVAL-TESTE" });
check("cancelamento no MP suspende o acesso", (await resumoConta("cli_brilhax")).suspendedAt !== null);
check("espelha o status cancelado", (await resumoConta("cli_brilhax")).status === "cancelled");

const painel = await visaoGeral();
check("visao geral lista a conta", painel.accounts.length === 1);
check("nao conta cancelada como receita", painel.totals.mrrCents === 0);

estadoAssinatura = "authorized";
await prisma.billingAccount.update({ where: { clientRef: "cli_brilhax" }, data: { status: "authorized" } });
const painelAtivo = await visaoGeral();
check("MRR soma as assinaturas ativas", painelAtivo.totals.mrrCents > 0);
check("conta as caixas cobraveis", painelAtivo.totals.mailboxes > 0);

check("cancela a assinatura", (await cancelarAssinatura("cli_brilhax")).status === "cancelled");
check("topico desconhecido e ignorado sem erro", (await processarNotificacao({ topic: "merchant_order", dataId: "1" })).processada === true);

globalThis.fetch = fetchOriginal;

console.log("\n[35] Faxina periodica");
const { rodarManutencao } = await import("../mta/maintenance.js");

// Sessao vencida e token gasto: plantados no passado para a faxina achar.
await prisma.mailSession.create({
  data: {
    mailboxId,
    refreshHash: "hash-vencido-de-teste",
    expiresAt: new Date(Date.now() - 86_400_000),
  },
});
await prisma.passwordResetToken.create({
  data: { mailboxId, tokenHash: "token-gasto-de-teste", expiresAt: new Date(Date.now() - 3_600_000) },
});

const lixeiraAntes = await listMessages({ mailboxId, folder: "trash" });
const sessoesAntes = await prisma.mailSession.count({ where: { expiresAt: { lt: new Date() } } });
check("ha sessao vencida antes da faxina", sessoesAntes > 0);

await rodarManutencao();

check(
  "faxina remove sessao vencida",
  (await prisma.mailSession.count({ where: { expiresAt: { lt: new Date() } } })) === 0,
);
check(
  "faxina remove token de recuperacao gasto",
  (await prisma.passwordResetToken.count({ where: { tokenHash: "token-gasto-de-teste" } })) === 0,
);
// Mensagem recem-apagada NAO pode sumir: a lixeira precisa dos 30 dias.
check(
  "faxina nao toca em lixeira recente",
  (await listMessages({ mailboxId, folder: "trash" })).messages.length === lixeiraAntes.messages.length,
);

// O prazo conta da entrada na lixeira, inclusive para e-mails antigos.
const mensagemNaLixeira = await prisma.message.findFirstOrThrow({ where: { mailboxId, folder: { kind: "trash" } } });
check("entrada na lixeira registra seu proprio horario", mensagemNaLixeira.trashedAt !== null);
await prisma.message.update({ where: { id: mensagemNaLixeira.id }, data: { receivedAt: new Date(Date.now() - 90 * 86_400_000) } });
await rodarManutencao();
check("email antigo recem-apagado permanece recuperavel", !!await prisma.message.findUnique({ where: { id: mensagemNaLixeira.id } }));
await prisma.message.update({ where: { id: mensagemNaLixeira.id }, data: { trashedAt: new Date(Date.now() - 31 * 86_400_000) } });
await rodarManutencao();
check("email com 31 dias na lixeira e removido", !await prisma.message.findUnique({ where: { id: mensagemNaLixeira.id } }));

console.log("\n[36] Suspensao e faturamento");
await setMailboxStatus("brilhax.com.br", "contato", "suspended");
await esperaErro("caixa suspensa nao loga", () =>
  login({ address: "contato@brilhax.com.br", password: SENHA_NOVA, ip: "203.0.113.30" }), "suspensa");

const destinoSuspenso = await resolveRecipient("contato@brilhax.com.br");
check("caixa suspensa CONTINUA recebendo e-mail", destinoSuspenso.kind === "mailbox");

// Cinco caixas existem: contato, financeiro, alvo, comercial e suporte — mas
// "suporte" foi desativada nos testes de cobrança, e desativada não se cobra.
const faturamento = await billableMailboxes();
check("faturamento conta as quatro cobraveis", faturamento.length === 4);
check("caixa desativada fica de fora da cobranca", !faturamento.some((m) => m.address.startsWith("suporte@")));
check("caixa suspensa continua cobravel", faturamento.some((m) => m.status === "suspended"));
check("faturamento carrega o cliente do portal", faturamento.every((m) => m.clientRef === "cli_brilhax"));
check("total mensal bate (4 x R$ 10)", faturamento.length * 10 === 40);

check("listagem administrativa mostra as cinco", (await listMailboxes("brilhax.com.br")).length === 5);

console.log("\n[37] Aviso de nao-entrega (bounce)");
const { avisarRemetente } = await import("../services/bounce.js");
const { enqueueOutbound } = await import("../mta/queue.js");

// Reativa a caixa: a secao anterior a suspendeu, e caixa suspensa nao recebe
// nada - nem o aviso que estamos testando.
await setMailboxStatus("brilhax.com.br", "contato", "active");

const originalBounce = Buffer.from(
  [
    "From: Contato Brilhax <contato@brilhax.com.br>",
    "To: endereco-que-nao-existe@exemplo-invalido.com",
    "Subject: Orcamento de janeiro",
    "",
    "Segue o orcamento combinado.",
    "",
  ].join("\r\n"),
  "utf8",
);

const naFilaBounce = await enqueueOutbound({
  envelopeFrom: "contato@brilhax.com.br",
  recipients: ["endereco-que-nao-existe@exemplo-invalido.com"],
  raw: originalBounce,
  subject: "Orcamento de janeiro",
  sign: false,
});

const antesDoAviso = (await listMessages({ mailboxId, folder: "inbox" })).messages.length;

const desfecho = await avisarRemetente({
  outboundId: naFilaBounce.id,
  envelopeFrom: "contato@brilhax.com.br",
  destinatarios: ["endereco-que-nao-existe@exemplo-invalido.com"],
  erro: "550 5.1.1 <endereco-que-nao-existe@exemplo-invalido.com>: Recipient address rejected: User unknown",
  storageKey: (
    await prisma.outboundMessage.findUniqueOrThrow({
      where: { id: naFilaBounce.id },
      select: { storageKey: true },
    })
  ).storageKey,
  assunto: "Orcamento de janeiro",
  definitivo: true,
});

// Com a porta 25 de saida ainda bloqueada, enfileirar o aviso seria o mesmo
// que nao avisar: ele so pode ser entregue direto na caixa do cliente.
check("aviso entregue direto na caixa do remetente", desfecho === "entregue");

const caixaDepois = await listMessages({ mailboxId, folder: "inbox" });
check("chegou uma mensagem nova", caixaDepois.messages.length === antesDoAviso + 1);

const aviso = caixaDepois.messages[0];
check("veio do mailer-daemon", (aviso?.fromAddress ?? "").startsWith("mailer-daemon@"));
check("assunto diz que nao foi entregue", (aviso?.subject ?? "").includes("Nao entregue"));

const avisoCompleto = await getMessage(mailboxId, aviso?.id ?? "");
const corpoAviso = avisoCompleto.bodyText ?? "";
check("explica em portugues o que houve", corpoAviso.includes("NAO foi entregue"));
check("mostra o destinatario que falhou", corpoAviso.includes("endereco-que-nao-existe@exemplo-invalido.com"));
check("mostra o motivo tecnico do servidor remoto", corpoAviso.includes("User unknown"));

// O balao vermelho de "nao entregue" no Gmail e no Outlook depende do
// report-type correto; sem ele o aviso vira um e-mail comum e passa batido.
const brutoAviso = (await getRawMessage(mailboxId, aviso?.id ?? "")).content.toString("utf8");
check("estrutura de DSN (multipart/report)", brutoAviso.includes("report-type=delivery-status"));
check("traz o relatorio de maquina", brutoAviso.includes("message/delivery-status"));
check("identifica o destinatario final", brutoAviso.includes("Final-Recipient: rfc822;"));
check("marca a acao como falha", brutoAviso.includes("Action: failed"));
check("traz o codigo de status", brutoAviso.includes("Status: 5.1.1"));
check("devolve os cabecalhos originais", brutoAviso.includes("Subject: Orcamento de janeiro"));
// Corpo inteiro de volta desperdicaria a quota do cliente com uma copia do
// que ele mesmo escreveu; o cabecalho basta para ele identificar a mensagem.
check("NAO devolve o corpo original", !brutoAviso.includes("Segue o orcamento combinado"));
check("marcado como automatico", brutoAviso.includes("Auto-Submitted: auto-replied"));

// A regra que evita corrente infinita: aviso que falha nao gera outro aviso.
check(
  "envelope vazio nao gera aviso",
  (await avisarRemetente({
    outboundId: naFilaBounce.id,
    envelopeFrom: "",
    destinatarios: ["alguem@exemplo.com"],
    erro: "550 sem caixa",
    storageKey: "",
    assunto: null,
    definitivo: true,
  })) === "ignorado",
);
check(
  "aviso do proprio daemon nao gera outro",
  (await avisarRemetente({
    outboundId: naFilaBounce.id,
    envelopeFrom: `mailer-daemon@${process.env.MAIL_HOSTNAME}`,
    destinatarios: ["alguem@exemplo.com"],
    erro: "550 sem caixa",
    storageKey: "",
    assunto: null,
    definitivo: true,
  })) === "ignorado",
);

// Aviso de atraso e diferente do definitivo: ele pede para NAO reenviar.
const atraso = await avisarRemetente({
  outboundId: naFilaBounce.id,
  envelopeFrom: "contato@brilhax.com.br",
  destinatarios: ["destino@exemplo.com"],
  erro: "451 4.7.1 Greylisted, try again later",
  storageKey: "",
  assunto: "Segunda mensagem",
  definitivo: false,
});
check("aviso de atraso tambem chega", atraso === "entregue");
const listaAtraso = await listMessages({ mailboxId, folder: "inbox" });
const msgAtraso = listaAtraso.messages[0];
check("assunto de atraso e diferente do definitivo", (msgAtraso?.subject ?? "").includes("Atraso"));
const brutoAtraso = (await getRawMessage(mailboxId, msgAtraso?.id ?? "")).content.toString("utf8");
check("acao marcada como atraso, nao falha", brutoAtraso.includes("Action: delayed"));
check("status temporario (4.x.x)", brutoAtraso.includes("Status: 4.7.1"));


console.log("\n[38] Migracao assistida do provedor antigo");
const { agendarMigracao, executarMigracao, testarConexao, verMigracao, cancelarMigracao } =
  await import("../services/migracao.js");

// A "origem" e o nosso proprio servidor IMAP servindo outra caixa. Testar
// contra um IMAP de verdade e o ponto: e na conversa com o servidor alheio
// que uma migracao quebra, nao na gravacao no banco.
const servidorOrigem = criarServidorImap({ seguro: true, tls: opcoesTls });
await new Promise<void>((r) => servidorOrigem.listen(0, "127.0.0.1", () => r()));
const portaOrigem = (servidorOrigem.address() as { port: number }).port;

const antiga = await createMailbox({
  domain: "brilhax.com.br",
  username: "antiga",
  password: "SenhaDaAntiga123",
  quotaGb: 5,
});

// Historico plausivel: duas na entrada, uma nos enviados.
const historico = [
  { pasta: "inbox" as const, assunto: "Contrato assinado" },
  { pasta: "inbox" as const, assunto: "Nota fiscal de marco" },
  { pasta: "sent" as const, assunto: "Resposta ao fornecedor" },
];

for (const item of historico) {
  const bruto = Buffer.from(
    [
      "From: Alguem <alguem@exemplo.com>",
      "To: antiga@brilhax.com.br",
      "Subject: " + item.assunto,
      "Message-ID: <" + item.assunto.split(" ").join("-") + "@antigo.exemplo>",
      "",
      "Conteudo de " + item.assunto + ".",
      "",
    ].join("\r\n"),
    "utf8",
  );
  await storeCopyInMailbox(antiga.id, bruto, item.pasta);
}

// Marca uma como lida na origem, para conferir se a flag atravessa.
await prisma.message.updateMany({
  where: { mailboxId: antiga.id, subject: "Nota fiscal de marco" },
  data: { seen: true },
});

const credenciais = {
  host: "127.0.0.1",
  port: portaOrigem,
  user: "antiga@brilhax.com.br",
  password: "SenhaDaAntiga123",
};

// A caixa de origem tem as mensagens acima MAIS a de boas-vindas que toda
// caixa nova recebe - ela e historico igual ao resto e vem junto.
const totalNaOrigem = await prisma.message.count({ where: { mailboxId: antiga.id } });
const naEntradaDaOrigem = await prisma.message.count({
  where: { mailboxId: antiga.id, folder: { kind: "inbox" } },
});

const sonda = await testarConexao(credenciais);
check(
  "conecta no provedor antigo e conta as mensagens",
  sonda.mensagens === totalNaOrigem,
  `contou ${sonda.mensagens}, a origem tem ${totalNaOrigem}`,
);
check("enxerga as pastas com conteudo", sonda.pastas >= 2);

await esperaErro(
  "senha errada no provedor antigo e recusada",
  () => testarConexao({ ...credenciais, password: "senhaErrada" }),
  "recusados",
);

// A caixa de destino e a do cliente, que ja tem mensagens proprias.
const antesDaMigracao = (await listMessages({ mailboxId, folder: "inbox" })).messages.length;

const agendada = await agendarMigracao({ mailboxId, ...credenciais });
check(
  "migracao agendada com a estimativa certa",
  agendada.mensagensEstimadas === totalNaOrigem,
  `estimou ${agendada.mensagensEstimadas}`,
);

// A senha do provedor antigo fica cifrada em repouso - nunca em claro.
const migracaoGuardada = await prisma.mailMigration.findUniqueOrThrow({
  where: { id: agendada.id },
  select: { sourceSecret: true, status: true },
});
check(
  "senha do provedor antigo NAO fica em claro",
  !(migracaoGuardada.sourceSecret ?? "").includes("SenhaDaAntiga123"),
);
check("senha fica cifrada com versao", (migracaoGuardada.sourceSecret ?? "").startsWith("v1:"));

await esperaErro(
  "nao aceita duas migracoes ao mesmo tempo",
  () => agendarMigracao({ mailboxId, ...credenciais }),
  "andamento",
);

await executarMigracao(agendada.id);

const depois = await verMigracao(mailboxId);
check("migracao concluida", depois?.status === "concluida");
check(
  "copiou todas as mensagens da origem",
  depois?.copiedMessages === totalNaOrigem,
  `copiou ${depois?.copiedMessages} de ${totalNaOrigem}`,
);
check("chegou a 100%", depois?.percentual === 100);
// Terminou: a credencial do provedor antigo perde a razao de existir.
check(
  "senha apagada do banco no fim",
  (
    await prisma.mailMigration.findUniqueOrThrow({
      where: { id: agendada.id },
      select: { sourceSecret: true },
    })
  ).sourceSecret === null,
);

const entradaDepois = await listMessages({ mailboxId, folder: "inbox" });
check(
  "as da entrada foram para a entrada",
  entradaDepois.messages.length === antesDaMigracao + naEntradaDaOrigem,
  `entrada tinha ${antesDaMigracao}, ficou com ${entradaDepois.messages.length}, origem tinha ${naEntradaDaOrigem}`,
);
check(
  "o assunto atravessou intacto",
  entradaDepois.messages.some((m) => m.subject === "Contrato assinado"),
);

// Pasta importa: e-mail enviado que aparece na entrada faz o cliente achar
// que recebeu o que na verdade ele mandou.
const enviadosDepois = await listMessages({ mailboxId, folder: "sent" });
check(
  "o que estava em Enviados continuou em Enviados",
  enviadosDepois.messages.some((m) => m.subject === "Resposta ao fornecedor"),
);

const lidaImportada = entradaDepois.messages.find((m) => m.subject === "Nota fiscal de marco");
check("mensagem lida na origem chegou lida", lidaImportada?.seen === true);
const naoLidaImportada = entradaDepois.messages.find((m) => m.subject === "Contrato assinado");
check("mensagem nao lida continuou nao lida", naoLidaImportada?.seen === false);

// Rodar de novo nao pode dobrar a caixa: e o que acontece quando o cliente
// clica duas vezes ou a copia e retomada depois de cair.
const segunda = await agendarMigracao({ mailboxId, ...credenciais });
await executarMigracao(segunda.id);
const entradaFinal = await listMessages({ mailboxId, folder: "inbox" });
check("segunda passada nao duplica", entradaFinal.messages.length === entradaDepois.messages.length);
// Nada novo para copiar: todas ja estavam aqui, entao todas sao ignoradas.
check(
  "e conta todas como ignoradas",
  (await verMigracao(mailboxId))?.skippedMessages === totalNaOrigem,
);

const terceira = await agendarMigracao({ mailboxId, ...credenciais });
await cancelarMigracao(mailboxId, terceira.id);
check("cancelamento registra o status", (await verMigracao(mailboxId))?.status === "cancelada");
check(
  "cancelamento tambem apaga a senha",
  (
    await prisma.mailMigration.findUniqueOrThrow({
      where: { id: terceira.id },
      select: { sourceSecret: true },
    })
  ).sourceSecret === null,
);
await esperaErro(
  "cancelar de novo nao faz nada",
  () => cancelarMigracao(mailboxId, terceira.id),
  "encerrada",
);

// Uma caixa nao pode mandar cancelar a migracao da caixa de outro cliente.
const quarta = await agendarMigracao({ mailboxId, ...credenciais });
await esperaErro(
  "uma caixa nao cancela a migracao da outra",
  () => cancelarMigracao(outraCaixa.id, quarta.id),
  "nao encontrada",
);
await cancelarMigracao(mailboxId, quarta.id);

await new Promise<void>((r) => servidorOrigem.close(() => r()));



console.log("\n[39] IMAP conferido por um cliente independente (imapflow)");

/**
 * Ate aqui, quem falava com o servidor era um cliente escrito por mim: os dois
 * lados combinavam o mesmo engano e o teste passava. O unico erro de protocolo
 * que apareceu sozinho hoje foi o do LIST, e apareceu porque o imapflow
 * reclamou. Esta secao existe para que o proximo apareca do mesmo jeito.
 */
const { ImapFlow } = await import("imapflow");

const servidorReal = criarServidorImap({ seguro: true, tls: opcoesTls });
await new Promise<void>((r) => servidorReal.listen(0, "127.0.0.1", () => r()));
const portaReal = (servidorReal.address() as { port: number }).port;

const cliente = new ImapFlow({
  host: "127.0.0.1",
  port: portaReal,
  secure: true,
  auth: { user: "contato@brilhax.com.br", pass: SENHA_NOVA },
  logger: false,
});
await cliente.connect();

// --- APPEND com literal, do jeito que o cliente faz sozinho ---
const corpoAnexo = Buffer.from("conteudo-do-anexo-em-pdf").toString("base64");
const comAnexo = [
  "From: Fornecedor <financeiro@fornecedor.com.br>",
  "To: contato@brilhax.com.br",
  "Subject: Boleto de fevereiro",
  "Message-ID: <boleto-fev@fornecedor.com.br>",
  "MIME-Version: 1.0",
  'Content-Type: multipart/mixed; boundary="fronteira123"',
  "",
  "--fronteira123",
  "Content-Type: text/plain; charset=utf-8",
  "Content-Transfer-Encoding: 8bit",
  "",
  "Segue o boleto em anexo, com a devida atenção.",
  "",
  "--fronteira123",
  'Content-Type: application/pdf; name="boleto.pdf"',
  "Content-Transfer-Encoding: base64",
  'Content-Disposition: attachment; filename="boleto.pdf"',
  "",
  corpoAnexo,
  "",
  "--fronteira123--",
  "",
].join("\r\n");

const anexado = await cliente.append("INBOX", comAnexo, ["\\Seen"]);
check("APPEND aceito por cliente real", anexado !== false);
check("APPEND devolve o UID atribuido", typeof (anexado as { uid?: number }).uid === "number");

const trava = await cliente.getMailboxLock("INBOX");
try {
  const uidBoleto = (anexado as { uid: number }).uid;

  // --- BODYSTRUCTURE: o anexo precisa ser visivel ---
  const comEstrutura = await cliente.fetchOne(String(uidBoleto), { bodyStructure: true }, { uid: true });
  const estrutura = (comEstrutura as { bodyStructure?: { childNodes?: Array<Record<string, unknown>> } })
    .bodyStructure;
  const filhos = estrutura?.childNodes ?? [];
  check("cliente enxerga a mensagem como multipart", filhos.length >= 2);
  // Anexo invisivel no BODYSTRUCTURE e anexo que o cliente nunca oferece para
  // baixar: a pessoa simplesmente nao ve que existe boleto.
  check(
    "o anexo aparece na estrutura",
    filhos.some((parte) => String(parte.type ?? "").toLowerCase() === "application/pdf"),
  );

  // --- Download parcial ---
  const pedaco = await cliente.download(String(uidBoleto), undefined, { uid: true, maxBytes: 40 });
  const lidos: Buffer[] = [];
  for await (const parte of (pedaco as { content: AsyncIterable<Buffer> }).content) lidos.push(parte);
  const baixado = Buffer.concat(lidos);
  // Sem respeitar <inicio.tamanho>, o servidor manda a mensagem inteira e o
  // cliente de celular baixa megabytes para exibir uma previa.
  check("respeita o recorte parcial", baixado.byteLength <= 40, `veio ${baixado.byteLength} bytes`);

  // --- Parte por numero e a parte, nao a mensagem inteira ---
  // iPhone Mail e o app do Gmail leem pelo BODYSTRUCTURE e pedem BODY[1],
  // BODY[2]. Ate 11/09/2026 qualquer secao numerada devolvia o .eml completo
  // e os cabecalhos apareciam dentro do corpo. A numeracao segue a estrutura
  // anunciada: no multipart/mixed do boleto, 1 e o texto e 2 e o PDF.
  const lerParte = async (parte: string) => {
    const baixada = await cliente.download(String(uidBoleto), parte, { uid: true });
    const pedacos: Buffer[] = [];
    for await (const p of (baixada as { content: AsyncIterable<Buffer> }).content) pedacos.push(p);
    return Buffer.concat(pedacos);
  };
  const parteTexto = await lerParte("1");
  check("BODY[1] e so o texto", parteTexto.toString("utf8").trim() === "Segue o boleto em anexo, com a devida atenção.", parteTexto.toString("utf8").slice(0, 80));
  check("BODY[1] nao traz cabecalho", !/^(From|Received|Content-Type):/im.test(parteTexto.toString("utf8")));
  const partePdf = await lerParte("2");
  // imapflow decodifica o base64 conforme o BODYSTRUCTURE: o que chega e o
  // conteudo original do anexo, byte a byte.
  check("BODY[2] e o anexo decodificado", partePdf.toString("utf8") === "conteudo-do-anexo-em-pdf", partePdf.toString("utf8").slice(0, 40));

  // --- \Deleted e uma flag, nao uma acao ---
  await cliente.messageFlagsAdd(String(uidBoleto), ["\\Deleted"], { uid: true });
  const marcada = await cliente.fetchOne(String(uidBoleto), { flags: true }, { uid: true });
  const flagsVoltaram = [...((marcada as { flags?: Set<string> }).flags ?? [])];
  check("a marca \\Deleted volta no FETCH", flagsVoltaram.includes("\\Deleted"));

  const aindaNaEntrada = await prisma.message.findFirst({
    where: { folderId: inboxId, uid: uidBoleto },
    select: { id: true, deleted: true },
  });
  // O ponto todo: marcar NAO move. Mover na marcacao quebra a sequencia da
  // sessao e impede desmarcar.
  check("marcada continua na pasta", aindaNaEntrada !== null);
  check("a marca ficou gravada", aindaNaEntrada?.deleted === true);

  await cliente.messageFlagsRemove(String(uidBoleto), ["\\Deleted"], { uid: true });
  check(
    "desmarcar funciona",
    (
      await prisma.message.findFirstOrThrow({
        where: { folderId: inboxId, uid: uidBoleto },
        select: { deleted: true },
      })
    ).deleted === false,
  );

  // --- EXPUNGE executa o que a marca pediu ---
  const idAntesDoExpunge = aindaNaEntrada?.id ?? "";
  await cliente.messageFlagsAdd(String(uidBoleto), ["\\Deleted"], { uid: true });
  await cliente.messageDelete(String(uidBoleto), { uid: true });

  const depoisDoExpunge = await prisma.message.findUnique({
    where: { id: idAntesDoExpunge },
    select: { folder: { select: { kind: true } }, deleted: true },
  });
  check("EXPUNGE leva para a Lixeira", depoisDoExpunge?.folder.kind === "trash");
  check("e a marca nao viaja junto", depoisDoExpunge?.deleted === false);

  // --- SEARCH ---
  const naoLidas = await cliente.search({ seen: false }, { uid: true });
  check("busca por nao lidas responde", Array.isArray(naoLidas));

  const porAssunto = await cliente.search({ header: { subject: "Contrato" } }, { uid: true });
  void porAssunto;
} finally {
  trava.release();
}

// --- IDLE recebe aviso de mensagem nova ---
{
  const ouvinte = new ImapFlow({
    host: "127.0.0.1",
    port: portaReal,
    secure: true,
    auth: { user: "contato@brilhax.com.br", pass: SENHA_NOVA },
    logger: false,
    // O padrao e entrar em IDLE apos 15s parado; no teste nao da para esperar.
    autoIdleDelay: 300,
  });
  await ouvinte.connect();
  // Sem trava: o imapflow so entra em IDLE quando nenhuma operacao segura a
  // caixa - e assim que o app de celular se comporta com a tela aberta.
  await ouvinte.mailboxOpen("INBOX");

  const avisou = new Promise<boolean>((resolve) => {
    const relogio = setTimeout(() => resolve(false), 8000);
    ouvinte.on("exists", () => {
      clearTimeout(relogio);
      resolve(true);
    });
  });

  // Entrega enquanto o cliente espera - e o caso do celular com o app aberto.
  setTimeout(() => {
    void storeCopyInMailbox(
      mailboxId,
      Buffer.from(
        [
          "From: Cliente <cliente@exemplo.com>",
          "To: contato@brilhax.com.br",
          "Subject: Chegou durante o IDLE",
          "",
          "oi",
          "",
        ].join("\r\n"),
        "utf8",
      ),
      "inbox",
    );
  }, 2000);

  // Anunciar IDLE sem nunca avisar e pior que nao anunciar: o cliente para de
  // perguntar porque confia no aviso.
  check("IDLE avisa quando chega mensagem", await avisou);
  await ouvinte.logout();
}


// --- STARTTLS: o que vem colado no comando nao pode ser executado ---
{
  /**
   * Injecao de comando no STARTTLS.
   *
   * O atacante manda, no MESMO pacote, o STARTTLS e um comando extra. Esses
   * bytes chegaram em texto claro, antes de qualquer autenticacao, mas se o
   * servidor os guardar no buffer eles serao executados DENTRO da sessao
   * cifrada que o cliente legitimo abrir em seguida.
   */
  const servidorPlano = criarServidorImap({ seguro: false, tls: opcoesTls });
  await new Promise<void>((r) => servidorPlano.listen(0, "127.0.0.1", () => r()));
  const portaPlana = (servidorPlano.address() as { port: number }).port;

  const cru = (await import("node:net")).connect({ port: portaPlana, host: "127.0.0.1" });
  await new Promise<void>((r) => cru.once("connect", () => r()));

  let recebido = "";
  cru.on("data", (pedaco: Buffer) => {
    recebido += pedaco.toString("latin1");
  });

  await new Promise<void>((r) => setTimeout(r, 200));
  // STARTTLS e, colado, um comando que o atacante quer ver executado depois.
  cru.write("a1 STARTTLS\r\na2 CAPABILITY\r\n");
  await new Promise<void>((r) => setTimeout(r, 500));

  check("STARTTLS aceito", recebido.includes("a1 OK"));
  // Se a resposta da a2 aparecer, o comando injetado foi executado.
  check("comando colado no STARTTLS NAO e executado", !recebido.includes("a2 OK"));

  cru.destroy();
  await new Promise<void>((r) => servidorPlano.close(() => r()));
}

await cliente.logout();
await new Promise<void>((r) => servidorReal.close(() => r()));



console.log("\n[40] Entrega pela porta 25, do jeito que chega de fora");

/**
 * Ate agora todo teste de recebimento chamava `deliverToMailbox` direto.
 * Isso pula justamente a parte que o servidor faz sozinho: carimbar Received,
 * Received-SPF e Authentication-Results antes da mensagem. Um erro de UMA
 * quebra de linha nesse carimbo separa os cabecalhos originais do resto, e a
 * mensagem chega sem assunto, sem remetente, com os proprios cabecalhos
 * aparecendo no corpo. Foi o que aconteceu - e nenhum teste viu, porque nenhum
 * passava por aqui.
 */
const { createInboundServer } = await import("../mta/inbound.js");
const { createTransport } = await import("nodemailer");

const servidorEntrada = createInboundServer();
await new Promise<void>((r) => servidorEntrada.listen(0, "127.0.0.1", () => r()));
const portaEntrada = (servidorEntrada.server.address() as { port: number }).port;

const carteiro = createTransport({
  host: "127.0.0.1",
  port: portaEntrada,
  secure: false,
  ignoreTLS: true,
});

const assuntoExterno = "Pedido 4471 confirmado";
await carteiro.sendMail({
  envelope: { from: "vendas@fornecedor-externo.com", to: "contato@brilhax.com.br" },
  from: "Vendas Fornecedor <vendas@fornecedor-externo.com>",
  to: "contato@brilhax.com.br",
  subject: assuntoExterno,
  text: "Seu pedido foi confirmado e sera despachado amanha.",
  messageId: "<pedido-4471@fornecedor-externo.com>",
});

// A entrega e assincrona do ponto de vista do cliente SMTP: ele recebe o 250 e
// segue. Espera curta ate a linha aparecer.
let chegouPelaPorta25 = null;
for (let tentativa = 0; tentativa < 40 && !chegouPelaPorta25; tentativa += 1) {
  chegouPelaPorta25 = await prisma.message.findFirst({
    where: { mailboxId, rfcMessageId: "<pedido-4471@fornecedor-externo.com>" },
    select: { id: true, subject: true, fromAddress: true, fromName: true, bodyText: true, storageKey: true },
  });
  if (!chegouPelaPorta25) await new Promise<void>((r) => setTimeout(r, 100));
}

check("a mensagem entregue pela porta 25 chega ao banco", chegouPelaPorta25 !== null);
check("o assunto sobrevive ao carimbo dos cabecalhos", chegouPelaPorta25?.subject === assuntoExterno, String(chegouPelaPorta25?.subject));
check("o remetente sobrevive", chegouPelaPorta25?.fromAddress === "vendas@fornecedor-externo.com", String(chegouPelaPorta25?.fromAddress));
check("o nome do remetente sobrevive", (chegouPelaPorta25?.fromName ?? "").includes("Vendas"));
check("o corpo e o corpo", (chegouPelaPorta25?.bodyText ?? "").includes("despachado amanha"));
// Se os cabecalhos originais vazarem para o corpo, e porque o bloco carimbado
// terminou com linha em branco.
check("os cabecalhos NAO vazaram para o corpo", !(chegouPelaPorta25?.bodyText ?? "").includes("Subject:"));

const brutoEntrada = (await readRaw(chegouPelaPorta25?.storageKey ?? "")).toString("utf8");
const fimCabecalho = brutoEntrada.indexOf("\r\n\r\n");
const cabecalhoEntrada = brutoEntrada.slice(0, fimCabecalho);
check("o Received foi carimbado", cabecalhoEntrada.startsWith("Received: from"));
check("o Authentication-Results foi carimbado", cabecalhoEntrada.includes("Authentication-Results:"));
// O teste central: assunto e carimbo no MESMO bloco de cabecalhos.
check("assunto original esta no bloco de cabecalhos, nao no corpo", cabecalhoEntrada.includes(assuntoExterno));

await new Promise<void>((r) => servidorEntrada.close(() => r()));


console.log("\n[41] Aquecimento de IP");
const { orcamentoDeHoje, proximaJanelaUtc } = await import("../mta/warmup.js");

// Mensagem mista: um destinatario nosso, dois de fora. So os de fora contam —
// entrega entre caixas nossas nao gasta reputacao do IP.
const mensagemMista = await enqueueOutbound({
  envelopeFrom: "contato@brilhax.com.br",
  recipients: ["contato@brilhax.com.br", "a@exemplo.com", "b@exemplo.com"],
  raw: Buffer.from("Subject: aquecimento\r\n\r\noi\r\n", "utf8"),
  subject: "aquecimento",
  sign: false,
});
const linhaMista = await prisma.outboundMessage.findUniqueOrThrow({
  where: { id: mensagemMista.id },
  select: { externalRecipients: true },
});
check("so destinatario de fora conta para o teto", linhaMista.externalRecipients === 2);

const mensagemInterna = await enqueueOutbound({
  envelopeFrom: "contato@brilhax.com.br",
  recipients: ["contato@brilhax.com.br"],
  raw: Buffer.from("Subject: interna\r\n\r\noi\r\n", "utf8"),
  subject: "interna",
  sign: false,
});
check(
  "mensagem interna nao gasta orcamento",
  (
    await prisma.outboundMessage.findUniqueOrThrow({
      where: { id: mensagemInterna.id },
      select: { externalRecipients: true },
    })
  ).externalRecipients === 0,
);

const orcamentoAntes = await orcamentoDeHoje();
check("aquecimento ativo comeca no teto da primeira semana", orcamentoAntes?.cap === 30, JSON.stringify(orcamentoAntes));
check("nada saiu ainda: orcamento cheio", orcamentoAntes?.enviadosHoje === 0 && orcamentoAntes?.restante === 30);

// Simula a entrega: e a soma no banco que o teto le — um contador em memoria
// mentiria depois de um restart do MTA.
await prisma.outboundMessage.update({
  where: { id: mensagemMista.id },
  data: { status: "sent", sentAt: new Date(), relayDriver: "direct" },
});
const orcamentoDepois = await orcamentoDeHoje();
check(
  "entrega de hoje debita os dois externos do orcamento",
  orcamentoDepois?.enviadosHoje === 2 && orcamentoDepois?.restante === 28,
  JSON.stringify(orcamentoDepois),
);
check("janela seguinte fica no futuro", proximaJanelaUtc().getTime() > Date.now());


console.log("\n[42] Aliases e catch-all pela API de provisionamento");
const { createAlias, listAliases, deleteAlias, setCatchAll, getCatchAll } = await import("../services/provisioning.js");

const aliasNovo = await createAlias({
  domain: "brilhax.com.br",
  alias: "Parcerias",
  destination: "contato@brilhax.com.br",
});
check("cria o alias normalizando o nome", aliasNovo.address === "parcerias@brilhax.com.br" && aliasNovo.created);

const aliasRepetido = await createAlias({
  domain: "brilhax.com.br",
  alias: "parcerias",
  destination: "contato@brilhax.com.br",
});
check("recriar igual e idempotente", !aliasRepetido.created);

const aliasTrocado = await createAlias({
  domain: "brilhax.com.br",
  alias: "parcerias",
  destination: "parceiro@exemplo-de-fora.com",
});
check("trocar o destino atualiza sem recriar", !aliasTrocado.created && aliasTrocado.destination === "parceiro@exemplo-de-fora.com");

const aliasesDoDominio = await listAliases("brilhax.com.br");
check(
  "listagem mostra o destino atual",
  aliasesDoDominio.some((a) => a.address === "parcerias@brilhax.com.br" && a.destination === "parceiro@exemplo-de-fora.com"),
);

await esperaErro(
  "recusa alias com nome de caixa existente",
  () => createAlias({ domain: "brilhax.com.br", alias: "contato", destination: "x@fora.com" }),
  "ja existe a caixa",
);
await esperaErro(
  "recusa destino nosso que nao e caixa (anti-laco)",
  () => createAlias({ domain: "brilhax.com.br", alias: "loop", destination: "naoexiste@brilhax.com.br" }),
  "nao e uma caixa",
);
await esperaErro(
  "alias apontando para si mesmo cai na mesma regra",
  () => createAlias({ domain: "brilhax.com.br", alias: "espelho", destination: "espelho@brilhax.com.br" }),
  "nao e uma caixa",
);
await esperaErro(
  "caixa nova nao passa por cima de alias",
  () => createMailbox({ domain: "brilhax.com.br", username: "parcerias", password: "SenhaSegura123" }),
  "remova o alias",
);

const resolvido = await resolveRecipient("parcerias@brilhax.com.br");
check("a entrega resolve o alias", resolvido.kind === "alias" && resolvido.destination === "parceiro@exemplo-de-fora.com");

const catchAllLigado = await setCatchAll("brilhax.com.br", "contato");
check("catch-all ligado", catchAllLigado.catchAll === "contato@brilhax.com.br");
check("consulta devolve o catch-all atual", (await getCatchAll("brilhax.com.br")) === "contato@brilhax.com.br");
const enderecoAleatorio = await resolveRecipient("qualquer-coisa-9931@brilhax.com.br");
check("endereco desconhecido cai na caixa do catch-all", enderecoAleatorio.kind === "mailbox");

await esperaErro(
  "catch-all so aceita caixa do proprio dominio",
  () => setCatchAll("brilhax.com.br", "naoexiste"),
  "caixa nao encontrada",
);

const catchAllDesligado = await setCatchAll("brilhax.com.br", null);
check("catch-all desligado", catchAllDesligado.catchAll === null);
check("consulta reflete o desligamento", (await getCatchAll("brilhax.com.br")) === null);
check(
  "sem catch-all o endereco volta a ser desconhecido",
  (await resolveRecipient("qualquer-coisa-9931@brilhax.com.br")).kind === "unknown",
);

const aliasRemovido = await deleteAlias("brilhax.com.br", "parcerias");
check("remove o alias", aliasRemovido.address === "parcerias@brilhax.com.br");
await esperaErro(
  "remover de novo e 404",
  () => deleteAlias("brilhax.com.br", "parcerias"),
  "alias nao encontrado",
);


console.log("\n[43] Regra com encaminhamento de copia");
const { createRule } = await import("../services/rules.js");

await createMailbox({ domain: "brilhax.com.br", username: "triagem", password: "SenhaDaTriagem1" });
const destinoTriagem = await resolveRecipient("triagem@brilhax.com.br");
if (destinoTriagem.kind !== "mailbox") throw new Error("caixa de triagem nao resolveu");

await esperaErro(
  "encaminhar para a propria caixa e recusado",
  () =>
    createRule(destinoTriagem.mailboxId, {
      name: "Laco",
      match: "all",
      conditions: [{ field: "subject", contains: "x" }],
      actions: { forwardTo: "triagem@brilhax.com.br" },
    }),
  "laco",
);
await esperaErro(
  "destino de encaminhamento precisa ser endereco valido",
  () =>
    createRule(destinoTriagem.mailboxId, {
      name: "Quebrada",
      match: "all",
      conditions: [{ field: "subject", contains: "x" }],
      actions: { forwardTo: "sem-arroba" },
    }),
  "invalido",
);

const regraForward = await createRule(destinoTriagem.mailboxId, {
  name: "Copia para o chefe",
  match: "all",
  conditions: [{ field: "subject", contains: "urgente" }],
  actions: { forwardTo: "Chefe <CHEFE@Empresa-Externa.com>" },
});
check(
  "so encaminhar ja e acao suficiente, e o destino sai normalizado",
  (regraForward.actions as { forwardTo?: string }).forwardTo === "chefe@empresa-externa.com",
);

const antesForward = await prisma.outboundMessage.count();
const msgUrgente = Buffer.from(
  [
    "From: Cliente <cliente@exemplo.com>",
    "To: triagem@brilhax.com.br",
    "Subject: URGENTE: contrato",
    "Message-ID: <urg-1@exemplo.com>",
    "",
    "Precisa assinar hoje.",
    "",
  ].join("\r\n"),
  "utf8",
);
const entregaForward = await deliverToMailbox(destinoTriagem, msgUrgente, null, {
  envelopeFrom: "cliente@exemplo.com",
});
check("mensagem continua entregue na caixa", entregaForward.status === "delivered");
check("copia enfileirada para o destino", (await prisma.outboundMessage.count()) === antesForward + 1);

const filaForward = await prisma.outboundMessage.findFirst({ orderBy: { createdAt: "desc" } });
check("envelope nulo, como todo encaminhamento", filaForward?.envelopeFrom === "");
check(
  "destinatario e o do encaminhamento",
  Array.isArray(filaForward?.recipients) && (filaForward?.recipients as string[])[0] === "chefe@empresa-externa.com",
);
check("copia conta como externa no aquecimento", filaForward?.externalRecipients === 1);

// Laco por terceiros: mensagem que ja rodou 25 servidores esta em circulo.
const destinoLaco = await resolveRecipient("triagem@brilhax.com.br");
if (destinoLaco.kind !== "mailbox") throw new Error("caixa de triagem sumiu");
const saltos = Array.from(
  { length: 25 },
  (_, i) => `Received: from salto${i}.exemplo.com by mail.avilaops.com; Tue, 19 Aug 2026 10:00:00 +0000`,
);
const msgLaco = Buffer.from(
  [
    ...saltos,
    "From: Cliente <cliente@exemplo.com>",
    "To: triagem@brilhax.com.br",
    "Subject: urgente em circulo",
    "Message-ID: <urg-loop@exemplo.com>",
    "",
    "Rodando.",
    "",
  ].join("\r\n"),
  "utf8",
);
const antesLaco = await prisma.outboundMessage.count();
const entregaLaco = await deliverToMailbox(destinoLaco, msgLaco, null, { envelopeFrom: "cliente@exemplo.com" });
check("mensagem em circulo ainda e entregue na caixa", entregaLaco.status === "delivered");
check("mas o encaminhamento e suprimido no limite de saltos", (await prisma.outboundMessage.count()) === antesLaco);
check(
  "supressao registrada em evento",
  (await prisma.mailEvent.count({ where: { type: "rule.forward_loop" } })) === 1,
);


console.log("\n[44] Anti-spam que aprende com o dono");
await createMailbox({ domain: "brilhax.com.br", username: "aprende", password: "SenhaAprende123" });

const caixaAprende = async () => {
  const destino = await resolveRecipient("aprende@brilhax.com.br");
  if (destino.kind !== "mailbox") throw new Error("caixa aprende nao resolveu");
  return destino;
};
const mailboxAprende = (await caixaAprende()).mailboxId;

const ofertaDe = (assunto: string) =>
  Buffer.from(
    [
      "From: Loja Gigante <promo@lojagigante.com>",
      "To: aprende@brilhax.com.br",
      `Subject: ${assunto}`,
      `Message-ID: <${assunto.replace(/\W+/g, "-")}@lojagigante.com>`,
      "",
      "Ofertas imperdiveis.",
      "",
    ].join("\r\n"),
    "utf8",
  );

const oferta1 = await deliverToMailbox(await caixaAprende(), ofertaDe("Oferta 1"), null, {
  envelopeFrom: "promo@lojagigante.com",
});
if (oferta1.status !== "delivered") throw new Error("oferta1 oferta nao entregue");
check("sem historico, mensagem limpa cai na entrada", oferta1.folder === "inbox");

await reportSpam(mailboxAprende, [oferta1.messageId], true);
check(
  "o botao vira reputacao de bloqueio",
  (
    await prisma.mailSenderReputation.findUniqueOrThrow({
      where: {
        mailboxId_senderAddress: { mailboxId: mailboxAprende, senderAddress: "promo@lojagigante.com" },
      },
    })
  ).verdict === "block",
);

const oferta2 = await deliverToMailbox(await caixaAprende(), ofertaDe("Oferta 2"), null, {
  envelopeFrom: "promo@lojagigante.com",
});
if (oferta2.status !== "delivered") throw new Error("oferta2 oferta nao entregue");
check("proxima mensagem do remetente vai direto para a quarentena", oferta2.folder === "spam");
check(
  "com motivo que o suporte consegue explicar",
  (
    await prisma.message.findUniqueOrThrow({
      where: { id: oferta2.messageId },
      select: { quarantineReason: true },
    })
  ).quarantineReason === "remetente marcado como spam por voce",
);

// Mudou de ideia: tirar do spam vira confianca — a decisao mais recente vence.
await reportSpam(mailboxAprende, [oferta2.messageId], false);
const oferta3 = await deliverToMailbox(await caixaAprende(), ofertaDe("Oferta 3"), null, {
  envelopeFrom: "promo@lojagigante.com",
});
if (oferta3.status !== "delivered") throw new Error("oferta3 oferta nao entregue");
check("depois do nao-e-spam, volta a cair na entrada", oferta3.folder === "inbox");
check(
  "a reputacao registrou a mudanca de ideia",
  (
    await prisma.mailSenderReputation.findUniqueOrThrow({
      where: {
        mailboxId_senderAddress: { mailboxId: mailboxAprende, senderAddress: "promo@lojagigante.com" },
      },
    })
  ).verdict === "trust",
);

// Confianca nao resgata falsificacao dura: DMARC fail com politica reject e
// exatamente o phishing que a quarentena existe para segurar.
const falsificada = await deliverToMailbox(await caixaAprende(), ofertaDe("Oferta falsificada"), {
  spf: "fail",
  dkim: "fail",
  dkimDomain: null,
  dmarc: "fail",
  dmarcPolicy: "reject",
  arc: "none",
  headers: "",
});
if (falsificada.status !== "delivered") throw new Error("falsificada nao entregue");
check("remetente confiavel FALSIFICADO continua na quarentena", falsificada.folder === "spam");


console.log("\n[45] Verificacao em duas etapas (TOTP)");
const { setupTotp, enableTotp, disableTotp, completarLoginTotp } = await import("../services/session.js");
const { codigoDoContador, contadorAtual } = await import("../lib/totp.js");
const { getOverview: visaoDaCaixa } = await import("../services/messages.js");

await createMailbox({ domain: "brilhax.com.br", username: "segura", password: "SenhaSegura2FA1" });
const caixaSegura = await prisma.mailbox.findFirstOrThrow({
  where: { localPart: "segura" },
  select: { id: true },
});

check("visao da caixa comeca sem 2FA", (await visaoDaCaixa(caixaSegura.id)).twoFactorEnabled === false);

const configuracao = await setupTotp(caixaSegura.id);
check("setup devolve o segredo em base32", /^[A-Z2-7]{32}$/.test(configuracao.secret));
check("e a URL que o autenticador importa", configuracao.otpauth.startsWith("otpauth://totp/segura%40brilhax.com.br"));
check(
  "segredo NAO fica em claro no banco",
  (
    await prisma.mailbox.findUniqueOrThrow({ where: { id: caixaSegura.id }, select: { totpSecret: true } })
  ).totpSecret?.includes(configuracao.secret) === false,
);

// Antes de provar um codigo, a 2FA nao vale: o login segue direto.
const loginAntes = await loginBruto({ address: "segura@brilhax.com.br", password: "SenhaSegura2FA1", ip: "203.0.113.30" });
check("setup sem enable ainda nao exige codigo", !("requiresTotp" in loginAntes));

await esperaErro(
  "enable com codigo errado e recusado",
  () => enableTotp(caixaSegura.id, "000000"),
  "codigo invalido",
);

const ativacao = await enableTotp(caixaSegura.id, codigoDoContador(configuracao.secret, contadorAtual()));
check("ativacao devolve 8 codigos de recuperacao", ativacao.recoveryCodes.length === 8);
check("visao da caixa mostra 2FA ativa", (await visaoDaCaixa(caixaSegura.id)).twoFactorEnabled === true);

const loginDepois = await loginBruto({ address: "segura@brilhax.com.br", password: "SenhaSegura2FA1", ip: "203.0.113.31" });
if (!("requiresTotp" in loginDepois)) throw new Error("login com 2FA nao pediu codigo");
check("login para na segunda etapa", loginDepois.requiresTotp === true && loginDepois.totpToken.length > 10);

await esperaErro(
  "codigo errado na segunda etapa e recusado",
  () => completarLoginTotp({ totpToken: loginDepois.totpToken, code: "999999", ip: "203.0.113.31" }),
  "codigo invalido",
);

// O enable consumiu o contador atual; o proximo codigo (janela +1) entra na
// tolerancia de relogio e prova o anti-replay sem esperar 30 segundos.
const codigoSeguinte = codigoDoContador(configuracao.secret, contadorAtual() + 1);
const sessaoTotp = await completarLoginTotp({
  totpToken: loginDepois.totpToken,
  code: codigoSeguinte,
  ip: "203.0.113.31",
});
check("codigo certo emite a sessao", sessaoTotp.accessToken.length > 0 && sessaoTotp.mailbox.address === "segura@brilhax.com.br");

const loginReplay = await loginBruto({ address: "segura@brilhax.com.br", password: "SenhaSegura2FA1", ip: "203.0.113.32" });
if (!("requiresTotp" in loginReplay)) throw new Error("login de replay nao pediu codigo");
await esperaErro(
  "o MESMO codigo nao vale duas vezes (anti-replay)",
  () => completarLoginTotp({ totpToken: loginReplay.totpToken, code: codigoSeguinte, ip: "203.0.113.32" }),
  "codigo invalido",
);

const codigoRecuperacao = ativacao.recoveryCodes[0] ?? "";
const sessaoRecuperacao = await completarLoginTotp({
  totpToken: loginReplay.totpToken,
  code: codigoRecuperacao,
  ip: "203.0.113.32",
});
check("codigo de recuperacao tambem emite sessao", sessaoRecuperacao.accessToken.length > 0);

const loginRecuperacao2 = await loginBruto({ address: "segura@brilhax.com.br", password: "SenhaSegura2FA1", ip: "203.0.113.33" });
if (!("requiresTotp" in loginRecuperacao2)) throw new Error("login pos-recuperacao nao pediu codigo");
await esperaErro(
  "codigo de recuperacao e de uso UNICO",
  () => completarLoginTotp({ totpToken: loginRecuperacao2.totpToken, code: codigoRecuperacao, ip: "203.0.113.33" }),
  "codigo invalido",
);

await esperaErro(
  "desativar exige codigo valido",
  () => disableTotp(caixaSegura.id, "111111"),
  "codigo invalido",
);
await disableTotp(caixaSegura.id, codigoDoContador(configuracao.secret, contadorAtual()));
check("desativada, o login volta a ser direto", !("requiresTotp" in (await loginBruto({ address: "segura@brilhax.com.br", password: "SenhaSegura2FA1", ip: "203.0.113.34" }))));
check("visao da caixa reflete o desligamento", (await visaoDaCaixa(caixaSegura.id)).twoFactorEnabled === false);


console.log("\n[46] CardDAV e CalDAV conferidos por um cliente independente (tsdav)");
const { handleDav } = await import("../dav/server.js");
const { createDAVClient } = await import("tsdav");
const { createServer: criarServidorHttp } = await import("node:http");

await createMailbox({ domain: "brilhax.com.br", username: "davteste", password: "SenhaDoDav12345" });

const servidorDav = criarServidorHttp((req, res) => {
  const caminho = new URL(req.url ?? "/", "http://localhost").pathname;
  void handleDav(req, res, caminho).then((tratada) => {
    if (!tratada) {
      res.statusCode = 404;
      res.end();
    }
  });
});
await new Promise<void>((r) => servidorDav.listen(0, "127.0.0.1", () => r()));
const portaDav = (servidorDav.address() as { port: number }).port;
const baseDav = `http://127.0.0.1:${portaDav}`;

// Sem credencial, nada existe.
const semAuth = await fetch(`${baseDav}/dav/`, { method: "PROPFIND" });
check("PROPFIND sem credencial leva 401", semAuth.status === 401);
check("com o desafio Basic no header", (semAuth.headers.get("www-authenticate") ?? "").includes("Basic"));

const bemConhecido = await fetch(`${baseDav}/.well-known/carddav`, { redirect: "manual" });
check("well-known redireciona para /dav/", bemConhecido.status === 301 && bemConhecido.headers.get("location") === "/dav/");

const credenciaisDav = { username: "davteste@brilhax.com.br", password: "SenhaDoDav12345" };

// --- CardDAV, pelo cliente independente ---
const clienteCard = await createDAVClient({
  serverUrl: `${baseDav}/dav`,
  credentials: credenciaisDav,
  authMethod: "Basic",
  defaultAccountType: "carddav",
});

const agendasDeContato = await clienteCard.fetchAddressBooks();
check("descoberta acha exatamente uma agenda de contatos", agendasDeContato.length === 1);
check("com o nome em portugues", String(agendasDeContato[0]?.displayName) === "Contatos");

const vcardCliente = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "UID:cli-0001",
  "FN:Cliente Um",
  "EMAIL:cliente1@exemplo.com",
  "END:VCARD",
  "",
].join("\r\n");

const criacaoVcard = await clienteCard.createVCard({
  addressBook: agendasDeContato[0]!,
  filename: "cli-0001.vcf",
  vCardString: vcardCliente,
});
check("cliente cria o contato", criacaoVcard.ok);

const contatosBaixados = await clienteCard.fetchVCards({ addressBook: agendasDeContato[0]! });
check("cliente le o contato de volta", contatosBaixados.length === 1);
check("o vCard volta intacto", String(contatosBaixados[0]?.data).includes("FN:Cliente Um"));
check("com etag para o sync", String(contatosBaixados[0]?.etag ?? "").length > 0);

// --- CalDAV, pelo mesmo caminho ---
const clienteCal = await createDAVClient({
  serverUrl: `${baseDav}/dav`,
  credentials: credenciaisDav,
  authMethod: "Basic",
  defaultAccountType: "caldav",
});

const agendas = await clienteCal.fetchCalendars();
check("descoberta acha exatamente uma agenda", agendas.length === 1);
check("que anuncia so VEVENT", JSON.stringify(agendas[0]?.components ?? []).includes("VEVENT"));

const eventoCliente = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Teste//PT//",
  "BEGIN:VEVENT",
  "UID:ev-0001",
  "SUMMARY:Reuniao com fornecedor",
  "DTSTART:20260901T130000Z",
  "DTEND:20260901T140000Z",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");

const criacaoEvento = await clienteCal.createCalendarObject({
  calendar: agendas[0]!,
  filename: "ev-0001.ics",
  iCalString: eventoCliente,
});
check("cliente cria o compromisso", criacaoEvento.ok);

const dentroDaJanela = await clienteCal.fetchCalendarObjects({
  calendar: agendas[0]!,
  timeRange: { start: "2026-09-01T00:00:00.000Z", end: "2026-09-02T00:00:00.000Z" },
});
check("time-range que cobre o evento o devolve", dentroDaJanela.length === 1);

const foraDaJanela = await clienteCal.fetchCalendarObjects({
  calendar: agendas[0]!,
  timeRange: { start: "2026-10-01T00:00:00.000Z", end: "2026-10-02T00:00:00.000Z" },
});
check("time-range fora nao devolve nada", foraDaJanela.length === 0);

// --- Preconditions e posse, no arame ---
const authDav = `Basic ${Buffer.from("davteste@brilhax.com.br:SenhaDoDav12345").toString("base64")}`;
const urlContato = `${baseDav}/dav/addressbooks/davteste%40brilhax.com.br/contatos/cli-0001.vcf`;

const putConflito = await fetch(urlContato, {
  method: "PUT",
  headers: { Authorization: authDav, "If-Match": '"etag-que-nao-existe"', "Content-Type": "text/vcard" },
  body: vcardCliente,
});
check("If-Match errado leva 412 (edicao concorrente)", putConflito.status === 412);

const putDuplicado = await fetch(urlContato, {
  method: "PUT",
  headers: { Authorization: authDav, "If-None-Match": "*", "Content-Type": "text/vcard" },
  body: vcardCliente,
});
check("If-None-Match:* sobre existente leva 412", putDuplicado.status === 412);

const caixaAlheia = await fetch(`${baseDav}/dav/addressbooks/contato%40brilhax.com.br/contatos/`, {
  method: "PROPFIND",
  headers: { Authorization: authDav, Depth: "1" },
});
check("URL de outra caixa nao existe para este login", caixaAlheia.status === 404);

// --- sync-collection: o que mudou desde o token ---
const syncInicial = await fetch(`${baseDav}/dav/addressbooks/davteste%40brilhax.com.br/contatos/`, {
  method: "REPORT",
  headers: { Authorization: authDav, "Content-Type": "application/xml", Depth: "0" },
  body: '<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token/><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>',
});
const corpoSyncInicial = await syncInicial.text();
check("sync inicial devolve o contato", syncInicial.status === 207 && corpoSyncInicial.includes("cli-0001.vcf"));
const tokenSync = corpoSyncInicial.match(/<d:sync-token>([^<]+)<\/d:sync-token>/)?.[1] ?? "";
check("e um sync-token", tokenSync.startsWith("avila-mail-sync-"));

const remocao = await fetch(urlContato, { method: "DELETE", headers: { Authorization: authDav } });
check("DELETE responde 204", remocao.status === 204);

const syncDepois = await fetch(`${baseDav}/dav/addressbooks/davteste%40brilhax.com.br/contatos/`, {
  method: "REPORT",
  headers: { Authorization: authDav, "Content-Type": "application/xml", Depth: "0" },
  body: `<?xml version="1.0"?><d:sync-collection xmlns:d="DAV:"><d:sync-token>${tokenSync}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`,
});
const corpoSyncDepois = await syncDepois.text();
check(
  "sync com token conta a exclusao como 404 do href",
  corpoSyncDepois.includes("cli-0001.vcf") && corpoSyncDepois.includes("404"),
);
check("GET do excluido e 404", (await fetch(urlContato, { headers: { Authorization: authDav } })).status === 404);

await new Promise<void>((r) => servidorDav.close(() => r()));

console.log("\n[47] Conferencia diaria de DNS");
{
  const { conferirTodosOsDominios, manutencaoDaConferenciaDeDns } = await import(
    "../services/conferenciaDeDns.js"
  );

  /**
   * A protecao central desta rotina: dominio desativado a mao NAO pode ser
   * varrido. `verifyDomainDns` grava o status, e varrer um `disabled` o traria
   * de volta para `pending_dns` sozinho — ou seja, uma rotina de fundo
   * desfazendo uma decisao da operacao, de madrugada, sem ninguem ver.
   */
  await prisma.mailDomain.create({
    data: { name: "desativado-teste.com.br", status: "disabled", dkimSelector: "avila" },
  });

  // Dominio recem-criado, ainda sem nenhuma conferencia gravada: e com ele que
  // da para provar o comportamento da PRIMEIRA passada. O brilhax.com.br nao
  // serve para isso porque as secoes anteriores ja o verificaram.
  await prisma.mailDomain.create({
    data: { name: "novo-teste.com.br", status: "pending_dns", dkimSelector: "avila" },
  });

  const resultados = await conferirTodosOsDominios();
  check("a varredura conferiu pelo menos um dominio", resultados.length > 0);
  check(
    "dominio desativado fica de fora da varredura",
    !resultados.some((r) => r.dominio === "desativado-teste.com.br"),
  );
  check(
    "dominio desativado continua desativado depois da varredura",
    (await prisma.mailDomain.findUnique({
      where: { name: "desativado-teste.com.br" },
      select: { status: true },
    }))?.status === "disabled",
  );

  const brilhax = resultados.find((r) => r.dominio === "brilhax.com.br");
  check("o dominio ativo entrou na varredura", brilhax !== undefined);
  check(
    "a varredura classifica a gravidade",
    brilhax !== undefined && ["ok", "aviso", "critico"].includes(brilhax.gravidade),
  );
  check(
    "a conferencia grava quando foi feita",
    (await prisma.mailDomain.findUnique({
      where: { name: "brilhax.com.br" },
      select: { dnsCheckedAt: true },
    }))?.dnsCheckedAt !== null,
  );

  // Primeira passada de um dominio novo: nada com que comparar, entao nada
  // pode ser apontado como "quebrou hoje". Sem isto, todo dominio recem-criado
  // com DNS ainda nao publicado viraria alarme no dia seguinte.
  const novo = resultados.find((r) => r.dominio === "novo-teste.com.br");
  check("dominio novo entra na varredura", novo !== undefined);
  check(
    "primeira conferencia nao inventa regressao",
    novo !== undefined && novo.anteriores === null && novo.quebrou.length === 0 && novo.voltou.length === 0,
  );

  // Segunda passada: agora ha um resultado anterior gravado para comparar.
  const segunda = await conferirTodosOsDominios();
  const novoDeNovo = segunda.find((r) => r.dominio === "novo-teste.com.br");
  check("a segunda conferencia ja tem com o que comparar", novoDeNovo?.anteriores !== null);
  check(
    "DNS estavel nao gera regressao nem recuperacao",
    novoDeNovo !== undefined && novoDeNovo.quebrou.length === 0 && novoDeNovo.voltou.length === 0,
  );

  // A rotina que a faxina chama nunca pode lancar: vigilancia que derruba o
  // que vigia inverte o proprio proposito.
  const resumo = await manutencaoDaConferenciaDeDns();
  check("a rotina da faxina devolve resumo sem lancar", typeof resumo.conferidos === "number");
  check("o resumo conta os dominios conferidos", resumo.conferidos > 0);
  check(
    "o resumo nao conta o dominio desativado",
    resumo.conferidos === (await prisma.mailDomain.count({ where: { status: { in: ["active", "pending_dns"] } } })),
  );
  // Sem endereco de operacao configurado nao ha para quem avisar — e isso nao
  // pode virar excecao no meio da faxina.
  check("sem MAIL_ADMIN_ADDRESSES nao envia e nao quebra", resumo.avisoEnviado === false);

  /**
   * Cliente no meio do cadastro, que ainda nao publicou o DNS, nao pode contar
   * como problema: ele esta corretamente incompleto. Se contasse, a operacao
   * receberia alarme todo dia por cada cadastro em andamento — e alarme falso
   * diario e como um aviso de verdade passa despercebido.
   */
  const ativosNoBanco = await prisma.mailDomain.count({ where: { status: "active" } });
  check(
    "dominio ainda publicando o DNS nao entra na conta de problemas",
    resumo.comProblema <= ativosNoBanco,
    `comProblema=${resumo.comProblema} ativos=${ativosNoBanco}`,
  );

  await prisma.mailDomain.delete({ where: { name: "desativado-teste.com.br" } });
  await prisma.mailDomain.delete({ where: { name: "novo-teste.com.br" } });
}

console.log("\n[48] Busca por anexo: arquivos, imagens e PDFs");
{
  const caixa48 = await prisma.mailbox.findFirstOrThrow({ select: { id: true } });
  const pasta48 = await prisma.mailFolder.findFirstOrThrow({
    where: { mailboxId: caixa48.id, kind: "inbox" },
    select: { id: true },
  });
  const ultimoUid = await prisma.message.aggregate({ where: { folderId: pasta48.id }, _max: { uid: true } });
  let uid48 = (ultimoUid._max.uid ?? 0) + 1000;

  type Anexo48 = { filename: string; contentType: string; sizeBytes: number; contentId?: string };
  const criar = async (subject: string, anexos: Anexo48[]) => {
    const criada = await prisma.message.create({
      data: {
        mailboxId: caixa48.id,
        folderId: pasta48.id,
        fromAddress: "anexos48@exemplo.com",
        subject,
        sizeBytes: 100,
        storageKey: `t48/${subject}.eml.gz`,
        uid: uid48++,
        hasAttachments: anexos.length > 0,
        attachments: { create: anexos.map((anexo, partIndex) => ({ ...anexo, partIndex })) },
      },
      select: { id: true },
    });
    return criada.id;
  };

  const semAnexo = await criar("t48 sem anexo", []);
  const comPdf = await criar("t48 contrato", [{ filename: "Contrato.PDF", contentType: "application/octet-stream", sizeBytes: 9000 }]);
  const comFoto = await criar("t48 foto", [{ filename: "obra.jpg", contentType: "image/jpeg", sizeBytes: 300_000 }]);
  const comPlanilha = await criar("t48 planilha", [{ filename: "custos.xlsx", contentType: "application/vnd.ms-excel", sizeBytes: 4000 }]);
  // Logo de assinatura: imagem pequena embutida no corpo. Nao e "arquivo".
  const soLogo = await criar("t48 assinatura", [{ filename: "logo.png", contentType: "image/png", sizeBytes: 3000, contentId: "logo@x" }]);
  // Foto colada no corpo: embutida, mas grande. Continua sendo imagem.
  const fotoNoCorpo = await criar("t48 colada", [{ filename: "print.png", contentType: "image/png", sizeBytes: 400_000, contentId: "print@x" }]);

  const ids = async (attachment: "any" | "image" | "pdf" | undefined, query = "t48") =>
    (await listMessages({ mailboxId: caixa48.id, query, attachment })).messages.map((m) => m.id).sort();
  const iguais = (a: string[], b: string[]) => JSON.stringify(a) === JSON.stringify([...b].sort());

  check("sem filtro traz as seis", (await ids(undefined)).length === 6);
  check("arquivos: tudo com anexo de verdade, sem o logo de assinatura", iguais(await ids("any"), [comPdf, comFoto, comPlanilha, fotoNoCorpo]));
  check("imagens: foto anexada e foto colada no corpo, sem o logo", iguais(await ids("image"), [comFoto, fotoNoCorpo]));
  check("PDFs: acha pelo nome mesmo com tipo generico e extensao maiuscula", iguais(await ids("pdf"), [comPdf]));
  check("filtro combina com o texto da busca", iguais(await ids("any", "t48 planilha"), [comPlanilha]));
  check("busca acha pelo nome do arquivo", iguais(await ids(undefined, "custos.xl"), [comPlanilha]));
  check("valor desconhecido de filtro e ignorado", parseAttachmentFilter("exe") === undefined && parseAttachmentFilter("pdf") === "pdf");

  await prisma.message.deleteMany({ where: { id: { in: [semAnexo, comPdf, comFoto, comPlanilha, soLogo, fotoNoCorpo] } } });
}

console.log("\n[49] Autoatendimento: pagar, receber a caixa e criar a senha");
{
  const { manutencaoDoSelfService, estadoDoPedido } = await import("../services/signupCheckout.js");

  // O checkout em si consulta DNS e RDAP de verdade; o que se testa aqui e o
  // que vem depois do pagamento, que e onde o cliente paga e fica sem caixa.
  let estadoAuto = "pending";
  const referenciaAuto = "auto:token-pedido-49";
  globalThis.fetch = (async (entrada: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(entrada);
    if (!url.startsWith("https://api.mercadopago.com")) return fetchOriginal(entrada, init);
    return new Response(
      JSON.stringify({ id: "PREAPPROVAL-49", status: estadoAuto, external_reference: referenciaAuto }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  const criarPedido = (token: string, dominio: string, pagador: string, status = "aguardando_pagamento") =>
    prisma.mailSignup.create({
      data: {
        token,
        domain: dominio,
        payerEmail: pagador,
        payerName: "Dona da Loja",
        localPart: "contato",
        mailboxCount: 1,
        unitPriceCents: 1000,
        clientRef: `auto:${token}`,
        status,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });

  await criarPedido("token-pedido-49", "lojanova49.com.br", "dona49@gmail.com");

  // O MP avisa da assinatura antes de o cartao ser cadastrado.
  await processarNotificacao({ topic: "subscription_preapproval", dataId: "PREAPPROVAL-49" });
  check(
    "assinatura sem cartao nao cria dominio",
    (await prisma.mailDomain.count({ where: { name: "lojanova49.com.br" } })) === 0,
  );
  check("pedido segue aguardando pagamento", (await estadoDoPedido("token-pedido-49")).status === "aguardando_pagamento");

  // Mesmo id de assinatura, agora autorizada: e esta que nao pode ser descartada.
  estadoAuto = "authorized";
  await processarNotificacao({ topic: "subscription_preapproval", dataId: "PREAPPROVAL-49" });

  const pedidoPago = await estadoDoPedido("token-pedido-49");
  check("pagamento confirmado provisiona o pedido", pedidoPago.status === "provisionado");
  check("devolve o endereco da caixa", pedidoPago.endereco === "contato@lojanova49.com.br");

  const caixa49 = await prisma.mailbox.findFirstOrThrow({
    where: { localPart: "contato", domain: { name: "lojanova49.com.br" } },
    select: { id: true, recoveryEmail: true, mustChangePassword: true, sendLimitPerHour: true, probationUntil: true },
  });
  check("e-mail do pagador vira o de recuperacao", caixa49.recoveryEmail === "dona49@gmail.com");
  check("caixa nasce com o freio de novato", caixa49.sendLimitPerHour === 20 && caixa49.probationUntil !== null);
  check("nao pede troca da senha que o dono acabou de criar", caixa49.mustChangePassword === false);

  const paraOPagador = await prisma.outboundMessage.findMany({
    where: { recipients: { array_contains: ["dona49@gmail.com"] } },
    select: { storageKey: true },
  });
  check("pagador recebe um unico e-mail", paraOPagador.length === 1, `recebeu ${paraOPagador.length}`);

  const corpo49 = (await readRaw(paraOPagador[0]?.storageKey ?? ""))
    .toString("utf8")
    .replace(/=\r?\n/g, "")
    .replace(/=3F/gi, "?")
    .replace(/=3D/gi, "=");
  const token49 = corpo49.match(/redefinir\?token=([A-Za-z0-9_-]+)/)?.[1] ?? "";
  check("o e-mail leva o link para criar a senha", token49.length === 43, `veio com ${token49.length} caracteres`);
  check("o e-mail nao promete senha por outro canal", !corpo49.includes("entregue separadamente"));

  const tokenGuardado = await prisma.passwordResetToken.findFirstOrThrow({
    where: { mailboxId: caixa49.id, usedAt: null },
    select: { expiresAt: true },
  });
  check(
    "link de primeiro acesso vale mais de um dia",
    tokenGuardado.expiresAt.getTime() - Date.now() > 24 * 3_600_000,
  );

  await resetPassword({ token: token49, newPassword: "SenhaDaDona12345" });
  const sessao49 = await login({ address: "contato@lojanova49.com.br", password: "SenhaDaDona12345", ip: "203.0.113.149" });
  check("dono entra com a senha que criou pelo link", sessao49.accessToken.length > 0);

  // O MP reenvia: a caixa nao pode nascer de novo nem o link ser trocado.
  await processarNotificacao({ topic: "subscription_preapproval", dataId: "PREAPPROVAL-49" });
  check(
    "notificacao repetida nao manda outro e-mail",
    (await prisma.outboundMessage.count({ where: { recipients: { array_contains: ["dona49@gmail.com"] } } })) === 1,
  );
  check(
    "notificacao repetida nao troca a senha do dono",
    (await login({ address: "contato@lojanova49.com.br", password: "SenhaDaDona12345", ip: "203.0.113.149" })).accessToken.length > 0,
  );

  // Pedido que caiu no meio: dominio e caixa ja existem, o link nunca saiu.
  await criarPedido("token-retomada-49", "retomada49.com.br", "retomada49@gmail.com", "falhou");
  await createDomain({ domain: "retomada49.com.br", clientRef: "auto:token-retomada-49" });
  await createMailbox({ domain: "retomada49.com.br", username: "contato", password: SENHA });

  // Pedido pago para um dominio que outro cliente levou antes.
  await criarPedido("token-alheio-49", "alheio49.com.br", "invasor49@gmail.com", "falhou");
  await createDomain({ domain: "alheio49.com.br", clientRef: "cli_dono_de_verdade" });
  await createMailbox({ domain: "alheio49.com.br", username: "contato", password: SENHA });

  const faxina49 = await manutencaoDoSelfService();
  check("faxina retoma o pedido pago que tinha falhado", faxina49.retomados === 1, `retomou ${faxina49.retomados}`);
  check("pedido retomado fica provisionado", (await estadoDoPedido("token-retomada-49")).status === "provisionado");
  check(
    "pedido retomado recebe o link de primeiro acesso",
    (await prisma.outboundMessage.count({ where: { recipients: { array_contains: ["retomada49@gmail.com"] } } })) === 1,
  );

  check("pedido para dominio de outro cliente fica travado", faxina49.travados === 1, `travou ${faxina49.travados}`);
  check("pedido travado continua marcado como falha", (await estadoDoPedido("token-alheio-49")).status === "falhou");
  const caixaAlheia = await prisma.mailbox.findFirstOrThrow({
    where: { localPart: "contato", domain: { name: "alheio49.com.br" } },
    select: { recoveryEmail: true },
  });
  check("caixa do outro cliente nao ganha o e-mail de quem pagou depois", caixaAlheia.recoveryEmail === null);
  check(
    "quem pagou depois nao recebe link para a caixa do outro",
    (await prisma.outboundMessage.count({ where: { recipients: { array_contains: ["invasor49@gmail.com"] } } })) === 0,
  );

  globalThis.fetch = fetchOriginal;
}

await prisma.$disconnect();
rmSync(workDir, { recursive: true, force: true });

console.log(`\n${failed === 0 ? "PASSOU" : "FALHOU"} — ${passed} verificacoes ok, ${failed} falhas\n`);
process.exit(failed === 0 ? 0 : 1);
