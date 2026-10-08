import { randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { enqueueOutbound } from "../mta/queue.js";
import { storeCopyInMailbox } from "../mta/deliver-local.js";

const log = createLogger("welcome");

/**
 * Boas-vindas da caixa nova.
 *
 * Duas entregas:
 *   1. uma mensagem DENTRO da caixa, para a primeira visita nao ser uma tela
 *      vazia — e ainda serve de prova de que o recebimento funciona;
 *   2. um aviso ao endereco de contato do cliente (o pessoal dele), com o
 *      endereco novo e o guia de configuracao.
 *
 * A SENHA NAO VAI EM NENHUMA DAS DUAS. E-mail trafega e fica arquivado em
 * servidor de terceiro; senha em corpo de e-mail e credencial vazada com data
 * marcada. Ela e devolvida uma unica vez na resposta da API de provisionamento,
 * para quem esta criando a caixa repassar pelo canal que preferir.
 */

const ROOT_ZONE = config.hostname.replace(/^mail\./, "");

function remetenteSistema(): string {
  return `naoresponda@${ROOT_ZONE}`;
}

interface DadosCaixa {
  address: string;
  displayName: string | null;
  quotaGb: number;
}

function corpoTexto(caixa: DadosCaixa): string {
  return [
    `Sua caixa de e-mail ${caixa.address} esta pronta.`,
    "",
    "COMO ACESSAR",
    `  Webmail: https://${config.hostname}`,
    `  Usuario: ${caixa.address}`,
    "  Senha:   entregue separadamente pela Avila Ops",
    "",
    "CONFIGURACAO EM OUTRO PROGRAMA DE E-MAIL",
    "  Recebimento (IMAP) - recomendado",
    `    Servidor: ${config.hostname}`,
    "    Porta:    993",
    "    Seguranca: SSL/TLS",
    "",
    "  Recebimento (POP3) - use so se o programa nao aceitar IMAP",
    `    Servidor: ${config.hostname}`,
    "    Porta:    995",
    "    Seguranca: SSL/TLS",
    "",
    "  Envio (SMTP)",
    `    Servidor: ${config.hostname}`,
    "    Porta:    587",
    "    Seguranca: STARTTLS",
    "",
    `  Usuario: ${caixa.address} (o endereco completo)`,
    `  Passo a passo por aplicativo: https://${config.hostname}/configurar`,
    "",
    `ESPACO: ${caixa.quotaGb} GB`,
    "",
    "No primeiro acesso ao webmail voce vai definir a sua propria senha.",
    "",
    "Avila Ops Tecnologia",
    `https://${ROOT_ZONE}`,
  ].join("\r\n");
}

function corpoHtml(caixa: DadosCaixa): string {
  const linha = (rotulo: string, valor: string) =>
    `<tr><td style="padding:4px 16px 4px 0;color:#666;">${rotulo}</td><td style="padding:4px 0;font-family:monospace;"><strong>${valor}</strong></td></tr>`;

  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;color:#1a1a1a;line-height:1.6;">
<p style="font-size:18px;margin:0 0 4px;">Sua caixa <strong>${caixa.address}</strong> esta pronta.</p>

<h3 style="margin:24px 0 8px;font-size:15px;">Como acessar</h3>
<table style="border-collapse:collapse;font-size:14px;">
${linha("Webmail", `https://${config.hostname}`)}
${linha("Usuario", caixa.address)}
<tr><td style="padding:4px 16px 4px 0;color:#666;">Senha</td><td style="padding:4px 0;">entregue separadamente pela Avila Ops</td></tr>
</table>

<h3 style="margin:24px 0 8px;font-size:15px;">Configuracao no celular ou no Outlook</h3>
<table style="border-collapse:collapse;font-size:14px;">
${linha("IMAP (recebimento)", `${config.hostname} &middot; porta 993 &middot; SSL/TLS`)}
${linha("POP3 (alternativa)", `${config.hostname} &middot; porta 995 &middot; SSL/TLS`)}
${linha("SMTP (envio)", `${config.hostname} &middot; porta 587 &middot; STARTTLS`)}
${linha("Usuario", caixa.address)}
${linha("Espaco", `${caixa.quotaGb} GB`)}
</table>

<p style="margin:8px 0 0;font-size:14px;">Passo a passo para iPhone, Android, Outlook e Gmail: <a href="https://${config.hostname}/configurar">${config.hostname}/configurar</a></p>

<p style="margin:12px 0 0;font-size:13px;color:#666;">
Prefira IMAP: as mensagens ficam no servidor e aparecem iguais no celular e no
computador. O POP3 baixa e tira do servidor, entao so serve para um aparelho.
</p>

<p style="margin:24px 0 0;padding:12px 16px;background:#fff8e1;border-left:3px solid #f0b429;font-size:14px;">
Por seguranca, troque a senha no primeiro acesso.
</p>

<p style="margin:24px 0 0;font-size:13px;color:#666;">
Avila Ops Tecnologia &middot; <a href="https://${ROOT_ZONE}" style="color:#666;">${ROOT_ZONE}</a>
</p>
</div>`;
}

async function montar(
  destinatario: string,
  assunto: string,
  caixa: DadosCaixa,
): Promise<Buffer> {
  const composer = new MailComposer({
    from: { name: "Avila Ops", address: remetenteSistema() },
    to: destinatario,
    subject: assunto,
    text: corpoTexto(caixa),
    html: corpoHtml(caixa),
    messageId: `<${randomUUID()}@${ROOT_ZONE}>`,
    date: new Date(),
    textEncoding: "quoted-printable",
  });

  return composer.compile().build();
}

/**
 * Nunca lanca: caixa provisionada com sucesso nao pode ser reportada como
 * falha so porque o e-mail de boas-vindas nao saiu. O erro vira evento.
 */
export async function sendWelcome(input: {
  mailboxId: string;
  notifyTo?: string;
}): Promise<{ storedInMailbox: boolean; notified: boolean }> {
  const resultado = { storedInMailbox: false, notified: false };

  try {
    const mailbox = await prisma.mailbox.findUnique({
      where: { id: input.mailboxId },
      select: {
        localPart: true,
        displayName: true,
        quotaBytes: true,
        domain: { select: { name: true } },
      },
    });

    if (!mailbox) return resultado;

    const caixa: DadosCaixa = {
      address: `${mailbox.localPart}@${mailbox.domain.name}`,
      displayName: mailbox.displayName,
      quotaGb: Number(mailbox.quotaBytes / (1024n * 1024n * 1024n)),
    };

    const interna = await montar(caixa.address, "Bem-vindo a sua nova caixa de e-mail", caixa);
    resultado.storedInMailbox = (await storeCopyInMailbox(input.mailboxId, interna, "inbox")) !== null;

    if (input.notifyTo) {
      const externa = await montar(input.notifyTo, `Sua caixa ${caixa.address} esta pronta`, caixa);
      await enqueueOutbound({
        envelopeFrom: remetenteSistema(),
        recipients: [input.notifyTo],
        raw: externa,
        subject: `Sua caixa ${caixa.address} esta pronta`,
        sign: true,
      });
      resultado.notified = true;
    }

    await prisma.mailEvent.create({
      data: {
        mailboxId: input.mailboxId,
        type: "mailbox.welcome_sent",
        payload: { ...resultado, notifyTo: input.notifyTo ?? null },
      },
    });

    log.info("boas-vindas enviadas", { mailboxId: input.mailboxId, ...resultado });
  } catch (error) {
    log.error("falha ao enviar boas-vindas; a caixa segue criada", {
      mailboxId: input.mailboxId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return resultado;
}
