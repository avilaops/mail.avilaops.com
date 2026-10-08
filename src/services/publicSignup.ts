import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { dnsRecordsFor, verifyDomainDns } from "./provisioning.js";

const log = createLogger("signup-publico");

/**
 * Primeiro passo do autoatendimento: a pessoa informa o dominio, recebe os
 * registros de DNS e, depois de publicar, pede a verificacao.
 *
 * Publico de proposito — e o que permite comprar sem falar com ninguem. Por
 * isso tudo aqui assume ma-fe: sem limite, esta rota vira sonda para descobrir
 * quais dominios sao clientes da casa, e ferramenta de carga contra nosso
 * resolvedor de DNS.
 *
 * O que esta rota NAO faz, de proposito: nao cria dominio, nao cria caixa, nao
 * cobra. Ela so informa e confere. Provisionar antes do pagamento seria caixa
 * de graca para qualquer um.
 */

const JANELA_MS = 15 * 60 * 1000;

function inicioJanela(): Date {
  return new Date(Math.floor(Date.now() / JANELA_MS) * JANELA_MS);
}

/**
 * Duas travas com propositos diferentes: uma segura quem insiste no mesmo
 * dominio, outra segura quem varre muitos dominios do mesmo lugar. O limite
 * por IP e mais generoso porque escritorio inteiro sai por um IP so.
 */
function travas(dominio: string, ip: string): Array<{ id: string; limite: number }> {
  return [
    { id: `signup:dom:${dominio}`, limite: 10 },
    { id: `signup:ip:${ip}`, limite: 30 },
  ];
}

async function bloqueado(lista: ReturnType<typeof travas>): Promise<boolean> {
  const registros = await prisma.loginAttempt.findMany({
    where: { identifier: { in: lista.map((t) => t.id) }, windowStart: inicioJanela() },
    select: { identifier: true, failures: true },
  });
  const contagem = new Map(registros.map((r) => [r.identifier, r.failures]));
  return lista.some((t) => (contagem.get(t.id) ?? 0) >= t.limite);
}

async function registrarUso(lista: ReturnType<typeof travas>): Promise<void> {
  const janela = inicioJanela();
  await Promise.all(
    lista.map((t) =>
      prisma.loginAttempt.upsert({
        where: { identifier_windowStart: { identifier: t.id, windowStart: janela } },
        create: { identifier: t.id, windowStart: janela, failures: 1 },
        update: { failures: { increment: 1 } },
      }),
    ),
  );
}

/**
 * Trava do checkout: mais apertada que a da consulta de DNS, porque cada
 * tentativa aqui cria uma assinatura no Mercado Pago. Exportada para o
 * `signupCheckout.ts` usar sem duplicar a mecanica de janela.
 */
export async function travarCheckout(dominio: string, ip: string): Promise<void> {
  const lista = [
    { id: `checkout:dom:${dominio}`, limite: 5 },
    { id: `checkout:ip:${ip}`, limite: 10 },
  ];
  if (await bloqueado(lista)) {
    throw new SignupError("Muitas tentativas de compra seguidas. Tente de novo em alguns minutos.", 429);
  }
  await registrarUso(lista);
}

export class SignupError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "SignupError";
  }
}

const DOMINIO_VALIDO = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export function normalizarDominio(bruto: string): string {
  const d = String(bruto || "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  if (!DOMINIO_VALIDO.test(d)) throw new SignupError("Informe um dominio valido, como suaempresa.com.br", 422);
  return d;
}

/**
 * Mostra os registros de DNS que o dominio precisa.
 *
 * Dominio que ja existe na base recebe a MESMA resposta de um dominio novo,
 * sem dizer que ja e de alguem. Confirmar "este dominio ja e cliente" daria a
 * quem varre uma lista dos nossos clientes de graca.
 */
export async function instrucoesDeDns(dominioBruto: string, ip: string) {
  const dominio = normalizarDominio(dominioBruto);
  const lista = travas(dominio, ip);
  if (await bloqueado(lista)) {
    throw new SignupError("Muitas consultas seguidas. Tente de novo em alguns minutos.", 429);
  }
  await registrarUso(lista);

  return {
    dominio,
    registros: dnsRecordsFor(dominio, "avila"),
    proximoPasso:
      "Publique os registros acima no DNS do dominio e volte para conferir. A propagacao costuma levar de minutos a algumas horas.",
  };
}

/**
 * Confere o DNS e diz o que ainda falta.
 *
 * Nao ativa nem provisiona nada: so um dominio que ja existe na base pode ser
 * ativado, e criar a base e passo do checkout. Aqui a resposta serve para a
 * tela dizer "falta o MX" em vez de "deu erro".
 */
export async function conferirDns(dominioBruto: string, ip: string, opcoes: { contarTentativa?: boolean } = {}) {
  const dominio = normalizarDominio(dominioBruto);

  // O checkout confere o DNS de novo antes de cobrar, e passa
  // `contarTentativa: false`. Sem isso, quem conferiu algumas vezes ate o
  // DNS propagar chega no botao de pagar com a cota estourada e leva 429
  // justamente na hora de comprar. O checkout tem trava propria, mais
  // apertada, porque cada tentativa dele cria assinatura no Mercado Pago.
  if (opcoes.contarTentativa !== false) {
    const lista = travas(dominio, ip);
    if (await bloqueado(lista)) {
      throw new SignupError("Muitas verificacoes seguidas. Tente de novo em alguns minutos.", 429);
    }
    await registrarUso(lista);
  }

  const existente = await prisma.mailDomain.findFirst({
    where: { name: dominio },
    select: { id: true },
  });

  // Dominio ja cadastrado usa a verificacao de verdade, que tambem o ativa
  // quando passa. Dominio novo so consulta o DNS, sem gravar nada.
  const checks = existente
    ? (await verifyDomainDns(dominio)).checks
    : await conferirSemCadastro(dominio);

  const faltando = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([nome]) => nome);

  log.info("verificacao publica de dns", { dominio, ip, faltando });

  return {
    dominio,
    checks,
    pronto: faltando.length === 0,
    faltando,
    registros: faltando.length > 0 ? dnsRecordsFor(dominio, "avila") : [],
  };
}

/** Consulta o DNS de um dominio que ainda nao existe na base. */
async function conferirSemCadastro(dominio: string) {
  const { resolveMx, resolveTxt, resolveCname } = await import("node:dns/promises").then((m) => ({
    resolveMx: m.resolveMx,
    resolveTxt: m.resolveTxt,
    resolveCname: m.resolveCname,
  }));
  const { config } = await import("../lib/config.js");
  const { dkimCnameTarget } = await import("../mta/dkim.js");

  const checks = { mx: false, spf: false, dkim: false, dmarc: false };

  await Promise.all([
    resolveMx(dominio)
      .then((r) => {
        checks.mx = r.some((x) => x.exchange.toLowerCase() === config.hostname.toLowerCase());
      })
      .catch(() => undefined),
    resolveTxt(dominio)
      .then((r) => {
        checks.spf = r.some((p) => p.join("").toLowerCase().includes("include:_spf."));
      })
      .catch(() => undefined),
    // Dominio ainda sem cadastro nao tem chave nossa para comparar, entao aqui
    // basta o CNAME apontar para o alvo certo — a conferencia da chave em si
    // acontece depois, na verificacao completa.
    resolveCname(`avila._domainkey.${dominio}`)
      .then((r) => {
        checks.dkim = r.some((alvo) => alvo.toLowerCase() === dkimCnameTarget(dominio).toLowerCase());
      })
      .catch(() => undefined),
    resolveTxt(`_dmarc.${dominio}`)
      .then((r) => {
        checks.dmarc = r.some((p) => p.join("").toLowerCase().startsWith("v=dmarc1"));
      })
      .catch(() => undefined),
  ]);

  return checks;
}
