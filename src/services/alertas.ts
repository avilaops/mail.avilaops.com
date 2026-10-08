import { randomUUID } from "node:crypto";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { config } from "../lib/config.js";
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { descreverAparelho } from "../lib/userAgent.js";
import { storeCopyInMailbox } from "../mta/deliver-local.js";
import { enviarAviso } from "./push.js";

const log = createLogger("alertas");
const ROOT_ZONE = config.hostname.split(".").slice(-2).join(".");

/**
 * Alertas da propria conta: acesso de aparelho novo, caixa enchendo, mudanca
 * de senha ou de 2FA.
 *
 * Sao avisos que o cliente PRECISA ver, e por isso vao por dois caminhos:
 *
 *   • uma mensagem de verdade na Caixa de Entrada — fica registrada, da para
 *     reler semanas depois e sobrevive a notificacao ignorada;
 *   • um push imediato, para o caso de ser roubo de conta em andamento.
 *
 * Nenhum deles pode derrubar o que os originou: quem chama nao espera e nada
 * aqui lanca. Login que falha porque o alerta falhou seria trocar um problema
 * pequeno por um grande.
 */

function remetenteSistema(): string {
  return `naoresponda@${ROOT_ZONE}`;
}

const ESTILO_CAIXA = "font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;color:#1a1a1a;line-height:1.6;";

async function entregar(input: {
  mailboxId: string;
  endereco: string;
  assunto: string;
  texto: string;
  html: string;
  push: { titulo: string; corpo: string };
  evento: string;
  detalhe?: Record<string, unknown>;
}): Promise<void> {
  try {
    const composer = new MailComposer({
      from: { name: "Ávila Ops (segurança)", address: remetenteSistema() },
      to: input.endereco,
      subject: input.assunto,
      text: input.texto,
      html: input.html,
      messageId: `<${randomUUID()}@${ROOT_ZONE}>`,
      date: new Date(),
      headers: {
        // Marca de servico: cliente de e-mail nao deve responder automaticamente
        // nem contar isto como conversa.
        "Auto-Submitted": "auto-generated",
        "X-Avila-Alerta": input.evento,
      },
    });

    const bruta = await composer.compile().build();
    await storeCopyInMailbox(input.mailboxId, bruta, "inbox");

    await enviarAviso(input.mailboxId, { titulo: input.push.titulo, corpo: input.push.corpo, tipo: "seguranca" });

    await prisma.mailEvent.create({
      data: {
        mailboxId: input.mailboxId,
        type: input.evento,
        severity: "warn",
        payload: (input.detalhe ?? {}) as Prisma.InputJsonObject,
      },
    });

    log.info("alerta entregue", { mailboxId: input.mailboxId, evento: input.evento });
  } catch (erro) {
    log.warn("falha ao entregar alerta", {
      mailboxId: input.mailboxId,
      evento: input.evento,
      erro: erro instanceof Error ? erro.message : String(erro),
    });
  }
}

async function dadosDaCaixa(mailboxId: string) {
  const caixa = await prisma.mailbox.findUnique({
    where: { id: mailboxId },
    select: { localPart: true, quotaBytes: true, usedBytes: true, domain: { select: { name: true } } },
  });
  return caixa ? { ...caixa, endereco: `${caixa.localPart}@${caixa.domain.name}` } : null;
}

/* ------------------------------------------------------- acesso de aparelho novo */

/**
 * Avisa quando a caixa e aberta de um aparelho ou de uma cidade que nunca
 * apareceram antes.
 *
 * A comparacao usa o aparelho legivel ("Galaxy S23 · Android 14 · Chrome") e a
 * cidade, nao o User-Agent cru: navegador que se atualiza muda o UA toda
 * semana, e um alerta a cada atualizacao treina o cliente a ignorar o aviso.
 *
 * O primeiro acesso da caixa nunca alerta — nao ha com o que comparar, e
 * assustar alguem no proprio dia da entrega e o oposto do objetivo.
 */
export async function alertarAcessoNovo(input: {
  mailboxId: string;
  sessionId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    const anteriores = await prisma.mailSession.findMany({
      where: { mailboxId: input.mailboxId, id: { not: input.sessionId } },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { userAgent: true, location: true },
    });

    if (anteriores.length === 0) return;

    const aparelho = descreverAparelho(input.userAgent).resumo;
    const conhecido = anteriores.some((sessao) => descreverAparelho(sessao.userAgent).resumo === aparelho);
    if (conhecido) return;

    const caixa = await dadosDaCaixa(input.mailboxId);
    if (!caixa) return;

    // A localizacao e resolvida em segundo plano no login; se ainda nao chegou,
    // o alerta sai com o IP — melhor avisar sem cidade do que avisar tarde.
    const sessao = await prisma.mailSession.findUnique({
      where: { id: input.sessionId },
      select: { location: true, ip: true },
    });
    const origem = [sessao?.location, sessao?.ip ?? input.ip].filter(Boolean).join(" · ") || "origem desconhecida";
    const quando = new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

    await entregar({
      mailboxId: input.mailboxId,
      endereco: caixa.endereco,
      assunto: `Novo acesso à sua caixa: ${aparelho}`,
      texto: [
        `Sua caixa ${caixa.endereco} foi aberta de um aparelho que ainda nao tinhamos visto.`,
        "",
        `Aparelho: ${aparelho}`,
        `Origem:   ${origem}`,
        `Quando:   ${quando}`,
        "",
        "Foi voce? Entao nao precisa fazer nada.",
        "",
        "Nao foi voce? Troque a senha agora em Conta > Senha e use",
        "'Sair de todos os aparelhos' para derrubar quem estiver conectado.",
        `https://${config.hostname}/conta`,
      ].join("\r\n"),
      html: `<div style="${ESTILO_CAIXA}">
<p style="font-size:18px;margin:0 0 4px;">Novo acesso à sua caixa</p>
<p style="margin:0 0 16px;color:#666;">${caixa.endereco} foi aberta de um aparelho que ainda não tínhamos visto.</p>
<table style="border-collapse:collapse;font-size:14px;">
<tr><td style="padding:4px 16px 4px 0;color:#666;">Aparelho</td><td style="padding:4px 0;"><strong>${aparelho}</strong></td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#666;">Origem</td><td style="padding:4px 0;"><strong>${origem}</strong></td></tr>
<tr><td style="padding:4px 16px 4px 0;color:#666;">Quando</td><td style="padding:4px 0;"><strong>${quando}</strong></td></tr>
</table>
<p style="margin:16px 0 0;">Foi você? Não precisa fazer nada.</p>
<p style="margin:8px 0 0;"><strong>Não foi você?</strong> Troque a senha e derrube as outras sessões em
<a href="https://${config.hostname}/conta">Conta &rsaquo; Senha</a>.</p>
</div>`,
      push: { titulo: "Novo acesso à sua caixa", corpo: `${aparelho} · ${origem}` },
      evento: "seguranca.acesso_novo",
      detalhe: { aparelho, origem },
    });
  } catch (erro) {
    log.warn("falha ao avaliar acesso novo", { erro: erro instanceof Error ? erro.message : String(erro) });
  }
}

/* ---------------------------------------------------------------- quota cheia */

/** Acima disto vale avisar: ainda da tempo de limpar antes de perder mensagem. */
const LIMITE_AVISO = 0.9;
/** Um aviso por semana, no maximo: caixa cheia enche de novo todo dia. */
const JANELA_REAVISO_MS = 7 * 86_400_000;

/**
 * Avisa o dono quando a caixa passa de 90% da quota.
 *
 * Sem isto, o primeiro sinal de caixa cheia e a mensagem que NAO chegou — o
 * remetente recebe a devolucao e o dono nao fica sabendo de nada.
 */
export async function alertarQuota(mailboxId: string): Promise<void> {
  try {
    const caixa = await dadosDaCaixa(mailboxId);
    if (!caixa || caixa.quotaBytes <= 0n) return;

    const proporcao = Number(caixa.usedBytes) / Number(caixa.quotaBytes);
    if (proporcao < LIMITE_AVISO) return;

    const jaAvisado = await prisma.mailEvent.findFirst({
      where: {
        mailboxId,
        type: "alerta.quota",
        createdAt: { gte: new Date(Date.now() - JANELA_REAVISO_MS) },
      },
      select: { id: true },
    });
    if (jaAvisado) return;

    const usado = Math.round(Number(caixa.usedBytes) / (1024 * 1024));
    const total = Number(caixa.quotaBytes / (1024n * 1024n * 1024n));
    const percentual = Math.round(proporcao * 100);

    await entregar({
      mailboxId,
      endereco: caixa.endereco,
      assunto: `Sua caixa está ${percentual}% cheia`,
      texto: [
        `A caixa ${caixa.endereco} esta usando ${usado} MB de ${total} GB (${percentual}%).`,
        "",
        "Quando encher de vez, as mensagens novas passam a ser recusadas e o",
        "remetente recebe uma devolucao — por isso o aviso vem antes.",
        "",
        "O que costuma resolver rapido:",
        "  - esvaziar a Lixeira e a pasta de Spam;",
        "  - apagar mensagens antigas com anexo grande;",
        "  - pedir mais espaco a Avila Ops.",
        `https://${config.hostname}/caixa`,
      ].join("\r\n"),
      html: `<div style="${ESTILO_CAIXA}">
<p style="font-size:18px;margin:0 0 4px;">Sua caixa está ${percentual}% cheia</p>
<p style="margin:0 0 16px;color:#666;">${caixa.endereco} — ${usado} MB de ${total} GB.</p>
<p style="margin:0 0 12px;">Quando encher de vez, mensagem nova passa a ser <strong>recusada</strong> e o remetente recebe devolução. Por isso o aviso vem antes.</p>
<p style="margin:0;">O que resolve rápido: esvaziar a Lixeira e o Spam, apagar mensagens antigas com anexo grande, ou pedir mais espaço à Ávila Ops.</p>
</div>`,
      push: { titulo: `Caixa ${percentual}% cheia`, corpo: `${usado} MB de ${total} GB usados` },
      evento: "alerta.quota",
      detalhe: { percentual, usadoMb: usado, quotaGb: total },
    });
  } catch (erro) {
    log.warn("falha ao avaliar quota", { mailboxId, erro: erro instanceof Error ? erro.message : String(erro) });
  }
}

/* ------------------------------------------------- mudancas sensiveis da conta */

type MudancaSensivel = "senha" | "2fa-ligado" | "2fa-desligado" | "chave-api";

const TEXTO_MUDANCA: Record<MudancaSensivel, { assunto: string; frase: string }> = {
  senha: { assunto: "Senha da sua caixa alterada", frase: "A senha da sua caixa foi alterada." },
  "2fa-ligado": {
    assunto: "Verificação em duas etapas ativada",
    frase: "A verificação em duas etapas foi ativada na sua caixa.",
  },
  "2fa-desligado": {
    assunto: "Verificação em duas etapas desativada",
    frase: "A verificação em duas etapas foi DESATIVADA na sua caixa.",
  },
  "chave-api": {
    assunto: "Nova chave de API criada",
    frase: "Uma chave de API foi criada para a sua caixa na área de desenvolvedor.",
  },
};

/**
 * Avisa o dono de mudancas que um invasor faria para se manter dentro: trocar
 * a senha, desligar o 2FA, criar chave de API.
 *
 * Quem fez a mudanca recebe o aviso tambem — redundante para ele, essencial
 * para quem NAO fez.
 */
export async function alertarMudanca(mailboxId: string, mudanca: MudancaSensivel): Promise<void> {
  try {
    const caixa = await dadosDaCaixa(mailboxId);
    if (!caixa) return;

    const { assunto, frase } = TEXTO_MUDANCA[mudanca];
    const quando = new Date().toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });

    await entregar({
      mailboxId,
      endereco: caixa.endereco,
      assunto,
      texto: [
        `${frase}`,
        `Caixa: ${caixa.endereco}`,
        `Quando: ${quando}`,
        "",
        "Foi voce? Nao precisa fazer nada.",
        "",
        "Nao foi voce? Sua conta pode estar comprometida: troque a senha,",
        "saia de todos os aparelhos e fale com a Avila Ops.",
        `https://${config.hostname}/conta`,
      ].join("\r\n"),
      html: `<div style="${ESTILO_CAIXA}">
<p style="font-size:18px;margin:0 0 4px;">${assunto}</p>
<p style="margin:0 0 16px;color:#666;">${frase} (${quando})</p>
<p style="margin:0;">Foi você? Não precisa fazer nada. <strong>Não foi você?</strong> Troque a senha, saia de todos os aparelhos em
<a href="https://${config.hostname}/conta">Conta</a> e fale com a Ávila Ops.</p>
</div>`,
      push: { titulo: assunto, corpo: caixa.endereco },
      evento: `seguranca.${mudanca.replace("-", "_")}`,
    });
  } catch (erro) {
    log.warn("falha ao avisar mudanca sensivel", { mailboxId, erro: erro instanceof Error ? erro.message : String(erro) });
  }
}
