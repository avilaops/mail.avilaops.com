import { randomUUID } from "node:crypto";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { readRaw } from "../lib/storage.js";
import { storeCopyInMailbox } from "../mta/deliver-local.js";

const log = createLogger("bounce");

/**
 * Aviso de nao-entrega (DSN, RFC 3464).
 *
 * Sem isso o cliente digita o endereco errado, a mensagem morre na fila e ele
 * segue achando que foi entregue — a pior falha possivel num servico de
 * e-mail, porque o prejuizo aparece semanas depois, na forma de "mas eu te
 * mandei". O aviso volta com o motivo tecnico e a mensagem original anexada.
 *
 * Duas regras que o protocolo impoe e que existem por experiencia amarga:
 *
 * 1. Bounce nunca gera bounce. O envelope do aviso vai vazio (<>), e mensagem
 *    que falhou com envelope vazio nao produz novo aviso — senao dois
 *    servidores mal configurados ficam devolvendo a mesma mensagem um para o
 *    outro para sempre. Receber com envelope vazio, isso sim, e obrigatorio:
 *    e assim que os bounces dos outros servidores chegam ate nos.
 * 2. O aviso vai para o envelope-from, nao para o cabecalho From:. Sao coisas
 *    diferentes, e responder ao From: e como se entrega bounce no endereco
 *    errado (e como se ajuda spammer a usar o servidor como amplificador).
 */

const CRLF = "\r\n";

function remetenteDaemon(): string {
  return `mailer-daemon@${config.hostname}`;
}

/** Corta o cabecalho da mensagem original: o corpo inteiro nao volta. */
function apenasCabecalhos(bruto: Buffer): string {
  const texto = bruto.toString("utf8");
  const corte = texto.search(/\r?\n\r?\n/);
  return corte === -1 ? texto.slice(0, 8000) : texto.slice(0, corte);
}

/**
 * Extrai o codigo do erro SMTP ("550 5.1.1 ...") para o campo Status.
 * Sem codigo reconhecido assume 5.0.0 — falha permanente generica.
 */
function statusDoErro(erro: string): { status: string; codigo: string } {
  const smtp = /\b([45]\d\d)\b/.exec(erro);
  const detalhado = /\b([45]\.\d{1,3}\.\d{1,3})\b/.exec(erro);
  return {
    status: detalhado?.[1] ?? (smtp?.[1]?.startsWith("4") ? "4.0.0" : "5.0.0"),
    codigo: smtp?.[1] ?? "550",
  };
}

function dataRfc(data: Date): string {
  return data.toUTCString().replace("GMT", "+0000");
}

/**
 * Monta o corpo do DSN na estrutura que os clientes sabem ler:
 * multipart/report com tres partes — explicacao humana, relatorio de maquina e
 * a mensagem original. O Gmail e o Outlook so mostram o balao vermelho de
 * "nao foi entregue" quando o report-type=delivery-status esta correto.
 */
function montarDsn(input: {
  para: string;
  destinatarios: string[];
  erro: string;
  cabecalhosOriginais: string;
  assuntoOriginal: string | null;
  definitivo: boolean;
}): Buffer {
  const fronteira = `=_avila_${randomUUID().replace(/-/g, "")}`;
  const { status, codigo } = statusDoErro(input.erro);
  const agora = new Date();

  const humano = input.definitivo
    ? [
        "Sua mensagem NAO foi entregue.",
        "",
        `Destinatario: ${input.destinatarios.join(", ")}`,
        input.assuntoOriginal ? `Assunto: ${input.assuntoOriginal}` : "",
        "",
        "Motivo informado pelo servidor de destino:",
        `  ${input.erro}`,
        "",
        "O que costuma resolver:",
        "  - conferir se o endereco esta escrito corretamente;",
        "  - confirmar com o destinatario por outro meio se a caixa existe;",
        "  - se o erro fala em spam ou bloqueio, falar com a Avila Ops.",
        "",
        "Nao e preciso reenviar esta mensagem: ela nao sera entregue como esta.",
      ]
    : [
        "Sua mensagem ainda NAO foi entregue, mas continuamos tentando.",
        "",
        `Destinatario: ${input.destinatarios.join(", ")}`,
        input.assuntoOriginal ? `Assunto: ${input.assuntoOriginal}` : "",
        "",
        "Ultimo motivo informado pelo servidor de destino:",
        `  ${input.erro}`,
        "",
        "Este e apenas um aviso. Se a entrega falhar em definitivo, voce recebe",
        "outro e-mail avisando. Nao reenvie a mensagem por enquanto.",
      ];

  const partes = [
    `--${fronteira}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    ...humano.filter((linha) => linha !== "" || true),
    "",
    `--${fronteira}`,
    "Content-Type: message/delivery-status",
    "",
    `Reporting-MTA: dns; ${config.hostname}`,
    `Arrival-Date: ${dataRfc(agora)}`,
    "",
    ...input.destinatarios.flatMap((destinatario) => [
      `Final-Recipient: rfc822; ${destinatario}`,
      `Action: ${input.definitivo ? "failed" : "delayed"}`,
      `Status: ${status}`,
      `Diagnostic-Code: smtp; ${codigo} ${input.erro.slice(0, 400)}`,
      "",
    ]),
    `--${fronteira}`,
    "Content-Type: text/rfc822-headers",
    "",
    input.cabecalhosOriginais,
    "",
    `--${fronteira}--`,
    "",
  ];

  const cabecalho = [
    `From: Mail Delivery System <${remetenteDaemon()}>`,
    `To: ${input.para}`,
    `Subject: ${input.definitivo ? "Nao entregue" : "Atraso na entrega"}: ${
      input.assuntoOriginal ?? "sua mensagem"
    }`,
    `Date: ${dataRfc(agora)}`,
    `Message-ID: <${randomUUID()}@${config.hostname}>`,
    "Auto-Submitted: auto-replied",
    "MIME-Version: 1.0",
    `Content-Type: multipart/report; report-type=delivery-status; boundary="${fronteira}"`,
    "",
  ];

  return Buffer.from([...cabecalho, ...partes].join(CRLF), "utf8");
}

/**
 * Avisa o remetente. Devolve o que foi feito para o chamador registrar.
 *
 * O aviso e entregue direto na caixa quando o remetente e nosso — e o caso
 * normal, ja que quem envia por aqui e cliente. Isso importa hoje mais do que
 * amanha: com a porta 25 de saida ainda bloqueada, um DSN enfileirado nunca
 * chegaria, e o cliente continuaria sem saber da falha.
 */
export async function avisarRemetente(input: {
  outboundId: string;
  envelopeFrom: string;
  destinatarios: string[];
  erro: string;
  storageKey: string;
  assunto: string | null;
  definitivo: boolean;
}): Promise<"entregue" | "enfileirado" | "ignorado"> {
  // Regra 1: bounce de bounce nao existe.
  if (!input.envelopeFrom || input.envelopeFrom === "<>") {
    log.info("falha com envelope vazio: nao gera aviso", { outboundId: input.outboundId });
    return "ignorado";
  }

  if (input.envelopeFrom.toLowerCase().startsWith("mailer-daemon@")) {
    log.warn("falha de um proprio aviso: nao gera outro", { outboundId: input.outboundId });
    return "ignorado";
  }

  let cabecalhos = "";
  let bruto: Buffer | null = null;
  try {
    bruto = await readRaw(input.storageKey);
    cabecalhos = apenasCabecalhos(bruto);
  } catch {
    // Mensagem original sumiu do disco: o aviso ainda vale mais que o silencio.
    cabecalhos = `To: ${input.destinatarios.join(", ")}`;
  }

  const dsn = montarDsn({
    para: input.envelopeFrom,
    destinatarios: input.destinatarios,
    erro: input.erro,
    cabecalhosOriginais: cabecalhos,
    assuntoOriginal: input.assunto,
    definitivo: input.definitivo,
  });

  const [local = "", dominio = ""] = input.envelopeFrom.toLowerCase().split("@");
  const caixa = await prisma.mailbox.findFirst({
    where: { localPart: local, domain: { name: dominio } },
    select: { id: true },
  });

  if (caixa) {
    await storeCopyInMailbox(caixa.id, dsn, "inbox");
    log.info("remetente avisado na propria caixa", {
      outboundId: input.outboundId,
      para: input.envelopeFrom,
      definitivo: input.definitivo,
    });
    return "entregue";
  }

  // Remetente de fora (encaminhamento, por exemplo): o aviso sai pela fila,
  // com envelope vazio para nao virar corrente de devolucoes.
  const { enqueueOutbound } = await import("../mta/queue.js");
  await enqueueOutbound({
    envelopeFrom: "",
    recipients: [input.envelopeFrom],
    raw: dsn,
    subject: "Aviso de nao-entrega",
  });

  log.info("aviso de nao-entrega enfileirado", {
    outboundId: input.outboundId,
    para: input.envelopeFrom,
  });
  return "enfileirado";
}
