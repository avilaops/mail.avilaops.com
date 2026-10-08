import { randomUUID } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { enqueueOutbound } from "../mta/queue.js";
import { verifyDomainDns } from "./provisioning.js";

const log = createLogger("conferencia-dns");
const ROOT_ZONE = config.hostname.split(".").slice(-2).join(".");

/**
 * Confere todo dia o SPF, o DKIM, o DMARC e o MX de cada dominio, e avisa
 * quando um deles cai.
 *
 * Existe por causa de um prejuizo concreto: em 31/08/2026 tres dominios de
 * cliente enviavam sem DKIM, dois deles com DMARC `p=reject` — ou seja, o
 * destinatario RECUSAVA a entrega, nao era so cair no spam. A chave estava no
 * servidor desde a criacao do dominio e nunca tinha ido para o DNS. Ninguem
 * percebeu por meses; apareceu porque um e-mail caiu no spam e o Nicolas viu.
 *
 * A conferencia em si ja existia inteira (`verifyDomainDns`), e o script
 * `dkim:auditar` ja sabia varrer os dominios. O que faltava era alguem chamar
 * isso sem ninguem pedir. Script que so roda quando alguem lembra nao protege
 * de um problema cuja marca registrada e justamente ninguem lembrar.
 *
 * Roda dentro da faxina diaria (`mta/maintenance.ts`) porque ela ja e a unica
 * rotina da casa que acontece todo dia sem depender de cron — um agendador
 * separado seria mais uma peca para manter e mais um lugar onde a variavel de
 * ambiente pode faltar.
 */

/** Os quatro registros que decidem se o e-mail do cliente chega. */
const CHECKS = ["mx", "spf", "dkim", "dmarc"] as const;
type Check = (typeof CHECKS)[number];
type Checks = Record<Check, boolean>;

/** Dias de silencio antes de repetir um aviso sobre problema que continua de pe. */
const DIAS_ENTRE_LEMBRETES = 7;

/**
 * So dominio em uso entra na varredura.
 *
 * Fora `active` e `pending_dns` de proposito: `verifyDomainDns` grava o status
 * do dominio, e varrer um dominio `disabled` o traria de volta para
 * `pending_dns` sozinho — desativado a mao voltaria a existir por conta de uma
 * rotina de fundo.
 */
const STATUS_VARRIDOS = ["active", "pending_dns"];

export type PoliticaDmarc = "none" | "quarantine" | "reject";

export type Gravidade = "ok" | "aviso" | "critico";

export interface ResultadoDoDominio {
  dominio: string;
  checks: Checks;
  /** Resultado da varredura anterior; `null` na primeira vez que o dominio e conferido. */
  anteriores: Checks | null;
  politica: PoliticaDmarc | null;
  gravidade: Gravidade;
  /** Registros que passavam na ultima conferencia e agora falham. */
  quebrou: Check[];
  /** Registros que falhavam na ultima conferencia e agora passam. */
  voltou: Check[];
  /** Status do dominio DEPOIS da conferencia: `active` ou `pending_dns`. */
  status: string;
}

/**
 * Le a politica declarada no DMARC do dominio.
 *
 * O `checks.dmarc` da verificacao existente responde "tem DMARC?", e isso nao
 * basta para medir o estrago: DKIM quebrado com `p=none` e um risco de spam,
 * com `p=reject` e entrega recusada. Sem ler o `p=` os dois casos chegariam com
 * a mesma cara no aviso, e o grave se perderia no meio do comum.
 */
export async function lerPoliticaDmarc(dominio: string): Promise<PoliticaDmarc | null> {
  try {
    const registros = await resolveTxt(`_dmarc.${dominio}`);
    return politicaNoRegistro(registros.map((partes) => partes.join("")));
  } catch {
    // Dominio sem DMARC publicado. Nao e erro — e o achado.
    return null;
  }
}

/**
 * Acha o `p=` entre os TXT de `_dmarc.<dominio>`.
 *
 * Separado da consulta para poder ser conferido sem rede, no smoke test: e
 * aqui que mora a regra, e regra que so da para testar contra o DNS de
 * verdade e regra que na pratica ninguem testa.
 */
export function politicaNoRegistro(registros: string[]): PoliticaDmarc | null {
  for (const bruto of registros) {
    const texto = bruto.trim();
    if (!texto.toLowerCase().startsWith("v=dmarc1")) continue;

    const achado = /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)/i.exec(texto);
    if (achado?.[1]) return achado[1].toLowerCase() as PoliticaDmarc;

    // Registro DMARC sem `p=` e invalido pela RFC 7489 e os provedores o
    // tratam como ausente. Contamos como `none`: e o efeito pratico, e
    // prometer mais do que isso viraria falsa tranquilidade.
    return "none";
  }
  return null;
}

/**
 * Traduz o estado do DNS em quanto isso dói.
 *
 * A ordem importa: MX quebrado vem antes de tudo porque significa que o
 * cliente NAO ESTA RECEBENDO e-mail, que e pior do que enviar mal.
 */
export function gravidadeDe(checks: Checks, politica: PoliticaDmarc | null): Gravidade {
  if (!checks.mx) return "critico";

  // Este e o caso dos tres dominios de 31/08: assinatura quebrada somada a uma
  // politica que manda recusar. O destinatario obedece e a mensagem nao chega.
  if (!checks.dkim) {
    return politica === "reject" || politica === "quarantine" ? "critico" : "aviso";
  }

  if (!checks.spf || !checks.dmarc) return "aviso";
  return "ok";
}

/** Le o `dnsCheck` gravado pela ultima conferencia, que vem do banco como Json solto. */
function checksAnteriores(bruto: unknown): Checks | null {
  if (!bruto || typeof bruto !== "object" || Array.isArray(bruto)) return null;
  const objeto = bruto as Record<string, unknown>;
  if (!CHECKS.every((nome) => typeof objeto[nome] === "boolean")) return null;
  return {
    mx: objeto.mx as boolean,
    spf: objeto.spf as boolean,
    dkim: objeto.dkim as boolean,
    dmarc: objeto.dmarc as boolean,
  };
}

function faltando(checks: Checks): Check[] {
  return CHECKS.filter((nome) => !checks[nome]);
}

async function conferirUm(dominio: { name: string; dnsCheck: unknown }): Promise<ResultadoDoDominio> {
  // Lido ANTES da verificacao: `verifyDomainDns` grava o resultado novo por
  // cima, e sem guardar o anterior nao haveria como saber o que mudou hoje.
  const anteriores = checksAnteriores(dominio.dnsCheck);

  const [verificacao, politica] = await Promise.all([
    verifyDomainDns(dominio.name),
    lerPoliticaDmarc(dominio.name),
  ]);

  const checks = verificacao.checks as Checks;

  return {
    dominio: dominio.name,
    checks,
    anteriores,
    politica,
    gravidade: gravidadeDe(checks, politica),
    quebrou: anteriores ? CHECKS.filter((nome) => anteriores[nome] && !checks[nome]) : [],
    voltou: anteriores ? CHECKS.filter((nome) => !anteriores[nome] && checks[nome]) : [],
    status: verificacao.status,
  };
}

/**
 * Quais resultados viram aviso.
 *
 * So dominio `active`, isto e, que ja funcionou pelo menos uma vez. Um
 * `pending_dns` e cliente no meio do cadastro que ainda nao publicou o DNS —
 * avisar sobre ele seria alarme sobre algo que esta CORRETAMENTE incompleto, e
 * alarme falso diario e como um aviso de verdade passa despercebido. Ele
 * continua sendo conferido: e assim que e ativado sozinho quando o DNS chega.
 */
function merecemAviso(resultados: ResultadoDoDominio[]): ResultadoDoDominio[] {
  return resultados.filter((r) => r.status === "active" && r.gravidade !== "ok");
}

/**
 * Varre todos os dominios em uso.
 *
 * Um de cada vez, de proposito: e uma rotina diaria sem pressa, e disparar
 * dezenas de consultas simultaneas so daria ao nosso resolvedor um pico que
 * nao serve para nada.
 */
export async function conferirTodosOsDominios(): Promise<ResultadoDoDominio[]> {
  const dominios = await prisma.mailDomain.findMany({
    where: { status: { in: STATUS_VARRIDOS } },
    select: { name: true, dnsCheck: true },
    orderBy: { name: "asc" },
  });

  const resultados: ResultadoDoDominio[] = [];
  for (const dominio of dominios) {
    try {
      resultados.push(await conferirUm(dominio));
    } catch (error) {
      // Um dominio que falha nao pode levar a varredura junto: os outros ainda
      // precisam ser conferidos, e justamente hoje pode ser o dia em que um
      // deles quebrou.
      log.error("nao consegui conferir o dominio", {
        dominio: dominio.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return resultados;
}

/** Registra na trilha do dominio o que mudou, para a mudanca ter data depois. */
async function registrarMudanca(resultado: ResultadoDoDominio): Promise<void> {
  const registro = await prisma.mailDomain.findFirst({
    where: { name: resultado.dominio },
    select: { id: true },
  });
  if (!registro) return;

  const regrediu = resultado.quebrou.length > 0;

  await prisma.mailEvent.create({
    data: {
      domainId: registro.id,
      type: regrediu ? "dns.regrediu" : "dns.recuperado",
      severity: regrediu ? (resultado.gravidade === "critico" ? "critical" : "warning") : "info",
      payload: {
        quebrou: resultado.quebrou,
        voltou: resultado.voltou,
        checks: resultado.checks,
        politicaDmarc: resultado.politica,
        gravidade: resultado.gravidade,
      },
    },
  });
}

const NOME_DO_CHECK: Record<Check, string> = {
  mx: "MX (recebe e-mail)",
  spf: "SPF (autoriza o envio)",
  dkim: "DKIM (assina as mensagens)",
  dmarc: "DMARC (politica de falsificacao)",
};

/** Diz, em uma linha, o que o cliente esta sentindo — nao o que o registro se chama. */
function consequencia(resultado: ResultadoDoDominio): string {
  if (!resultado.checks.mx) return "NAO esta recebendo e-mail";
  if (!resultado.checks.dkim) {
    if (resultado.politica === "reject") return "envio RECUSADO no destino (DKIM quebrado + DMARC p=reject)";
    if (resultado.politica === "quarantine") return "envio jogado no spam (DKIM quebrado + DMARC p=quarantine)";
    return "envia sem assinatura; tende a cair no spam";
  }
  if (!resultado.checks.spf) return "envio sem SPF; parte dos destinos recusa";
  if (!resultado.checks.dmarc) return "sem DMARC; o dominio pode ser falsificado";
  return "ok";
}

function corpoDoAviso(problemas: ResultadoDoDominio[], recuperados: ResultadoDoDominio[]): { texto: string; html: string } {
  const linhas: string[] = [];

  if (problemas.length > 0) {
    linhas.push("Dominios com problema no DNS:", "");
    for (const p of problemas) {
      const marca = p.gravidade === "critico" ? "[CRITICO]" : "[aviso]";
      linhas.push(`${marca} ${p.dominio} — ${consequencia(p)}`);
      linhas.push(`   falta: ${faltando(p.checks).map((n) => NOME_DO_CHECK[n]).join(", ")}`);
      if (p.quebrou.length > 0) {
        linhas.push(`   quebrou hoje: ${p.quebrou.join(", ")} (passava na conferencia anterior)`);
      }
      linhas.push("");
    }
  }

  if (recuperados.length > 0) {
    linhas.push("Voltaram ao normal:", "");
    for (const r of recuperados) {
      linhas.push(`  ${r.dominio} — ${r.voltou.join(", ")}`);
    }
    linhas.push("");
  }

  linhas.push(
    "Conferido pela faxina diaria do mail. Para ver de perto:",
    "  npm run dkim:auditar",
  );

  const texto = linhas.join("\n");
  const html = `<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;line-height:1.6;color:#1a1a1a;white-space:pre-wrap;">${texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")}</div>`;

  return { texto, html };
}

async function avisarOperacao(
  problemas: ResultadoDoDominio[],
  recuperados: ResultadoDoDominio[],
): Promise<boolean> {
  const destinatarios = config.admin.addresses;
  if (destinatarios.length === 0) {
    // Vale um log alto: uma conferencia que nao tem para quem falar e
    // exatamente o tipo de coisa configurada pela metade que este arquivo
    // existe para evitar.
    log.warn("ha o que avisar, mas MAIL_ADMIN_ADDRESSES esta vazio; ninguem sera notificado", {
      problemas: problemas.length,
      recuperados: recuperados.length,
    });
    return false;
  }

  const criticos = problemas.filter((p) => p.gravidade === "critico").length;
  const assunto =
    criticos > 0
      ? `[mail] ${criticos} dominio(s) com DNS critico`
      : problemas.length > 0
        ? `[mail] ${problemas.length} dominio(s) com DNS a corrigir`
        : "[mail] DNS dos dominios voltou ao normal";

  const { texto, html } = corpoDoAviso(problemas, recuperados);
  const remetente = `naoresponda@${ROOT_ZONE}`;

  const bruto = await new MailComposer({
    from: { name: "Avila Mail (conferencia de DNS)", address: remetente },
    to: destinatarios.join(", "),
    subject: assunto,
    text: texto,
    html,
    messageId: `<${randomUUID()}@${ROOT_ZONE}>`,
    date: new Date(),
    textEncoding: "quoted-printable",
  })
    .compile()
    .build();

  await enqueueOutbound({
    envelopeFrom: remetente,
    recipients: destinatarios,
    raw: bruto,
    subject: assunto,
    sign: true,
  });

  return true;
}

/** Quando saiu o ultimo aviso, para nao repetir todo dia o mesmo problema. */
async function ultimoAviso(): Promise<Date | null> {
  const evento = await prisma.mailEvent.findFirst({
    where: { type: "dns.aviso_enviado", domainId: null },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return evento?.createdAt ?? null;
}

export interface ResumoDaConferencia {
  conferidos: number;
  comProblema: number;
  criticos: number;
  regressoes: number;
  recuperacoes: number;
  avisoEnviado: boolean;
}

/**
 * O que a faxina diaria chama.
 *
 * Nunca lanca: a conferencia e vigilancia, e vigilancia que derruba o que
 * vigia inverte o proprio proposito. Falha vira log e a proxima faxina tenta
 * de novo.
 *
 * Avisa quando algo MUDA, e repete a cada `DIAS_ENTRE_LEMBRETES` enquanto o
 * problema continuar. Aviso diario sobre o mesmo dominio quebrado vira ruido,
 * e ruido diario e ignorado — que e como o buraco do DKIM sobreviveu meses.
 */
export async function manutencaoDaConferenciaDeDns(): Promise<ResumoDaConferencia> {
  const vazio: ResumoDaConferencia = {
    conferidos: 0,
    comProblema: 0,
    criticos: 0,
    regressoes: 0,
    recuperacoes: 0,
    avisoEnviado: false,
  };

  try {
    const resultados = await conferirTodosOsDominios();

    const problemas = merecemAviso(resultados);
    // Regressao e recuperacao so contam para dominio que ja funcionava: ver
    // `merecemAviso`. Cliente publicando o DNS aos poucos mexe nos registros o
    // tempo todo, e cada passo dele nao e um incidente nosso.
    const ativos = resultados.filter((r) => r.status === "active");
    const regressoes = ativos.filter((r) => r.quebrou.length > 0);
    const recuperados = ativos.filter((r) => r.voltou.length > 0);

    // A ativacao de um dominio novo ja tem evento proprio (`dns.verified`, em
    // `verifyDomainDns`); aqui a trilha e sobre dominio que estava de pe.
    for (const mudou of ativos.filter((r) => r.quebrou.length > 0 || r.voltou.length > 0)) {
      await registrarMudanca(mudou);
    }

    const houveMudanca = regressoes.length > 0 || recuperados.length > 0;
    const ultimo = await ultimoAviso();
    const lembreteVencido =
      problemas.length > 0 &&
      (ultimo === null || Date.now() - ultimo.getTime() >= DIAS_ENTRE_LEMBRETES * 86_400_000);

    let avisoEnviado = false;
    if (houveMudanca || lembreteVencido) {
      // Em try proprio: se o aviso nao sair, a varredura ja feita continua
      // valendo e o que mudou ja esta gravado na trilha. Perder o resumo
      // inteiro porque o e-mail falhou seria apagar o trabalho por causa do
      // recado.
      try {
        avisoEnviado = await avisarOperacao(problemas, recuperados);
        if (avisoEnviado) {
          await prisma.mailEvent.create({
            data: {
              type: "dns.aviso_enviado",
              severity: problemas.some((p) => p.gravidade === "critico") ? "critical" : "warning",
              payload: {
                problemas: problemas.map((p) => ({
                  dominio: p.dominio,
                  gravidade: p.gravidade,
                  faltando: faltando(p.checks),
                  politicaDmarc: p.politica,
                })),
                recuperados: recuperados.map((r) => r.dominio),
              },
            },
          });
        }
      } catch (error) {
        // Sem gravar `dns.aviso_enviado`: a proxima faxina tenta de novo, em
        // vez de achar que ja avisou e ficar sete dias em silencio.
        log.error("nao consegui enviar o aviso da conferencia de dns", {
          error: error instanceof Error ? error.message : String(error),
          problemas: problemas.length,
        });
      }
    }

    const resumo: ResumoDaConferencia = {
      conferidos: resultados.length,
      comProblema: problemas.length,
      criticos: problemas.filter((p) => p.gravidade === "critico").length,
      regressoes: regressoes.length,
      recuperacoes: recuperados.length,
      avisoEnviado,
    };

    log.info("conferencia de dns concluida", {
      ...resumo,
      dominiosComProblema: problemas.map((p) => `${p.dominio}:${faltando(p.checks).join("+")}`),
    });

    return resumo;
  } catch (error) {
    log.error("conferencia de dns falhou; sera tentada na proxima faxina", {
      error: error instanceof Error ? error.message : String(error),
    });
    return vazio;
  }
}
