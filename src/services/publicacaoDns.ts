import {
  apagarRegistro,
  atualizarRegistro,
  cloudflareComCredencial,
  criarRegistro,
  registrosDoNome,
  zonaPorNome,
  type RegistroCloudflare,
  type RegistroNovo,
} from "../lib/cloudflare.js";
import { createLogger } from "../lib/logger.js";
import { prisma } from "../lib/db.js";
import { dnsRecordsFor, ProvisioningError, verifyDomainDns, type DnsRecord } from "./provisioning.js";

const log = createLogger("publicacao-dns");

/**
 * Publica os registros do dominio direto na Cloudflare, quando a zona esta na
 * conta da casa.
 *
 * O painel entregava quatro registros para alguem copiar. Para dominio que a
 * propria Avila Ops administra, quem copiava era a mesma pessoa que cadastrou:
 * trabalho manual com chance de erro, e dominio parado em `pending_dns`.
 *
 * A zona do cliente ja tem coisa dentro, e o plano respeita o que esta la:
 *
 * - **MX**: se ja existe MX apontando para outro lugar, o e-mail do cliente
 *   chega la hoje. Trocar desliga esse recebimento no mesmo instante, entao so
 *   acontece com confirmacao explicita (`substituirMx`).
 * - **SPF**: dois registros SPF invalidam os dois. Se ja ha um, o nosso
 *   `include` entra nele, e quem ja enviava pelo dominio continua autorizado.
 * - **DMARC**: politica que o cliente ja publicou fica como esta.
 * - **DKIM**: o nome leva o nosso seletor; o que estiver nele e substituido.
 */

export type EstadoDoRegistro = "criado" | "atualizado" | "ja_estava" | "mantido" | "precisa_confirmar" | "falhou";

export interface ResultadoDoRegistro {
  registro: "mx" | "spf" | "dkim" | "dmarc";
  estado: EstadoDoRegistro;
  detalhe?: string;
}

export type Operacao =
  | { tipo: "criar"; novo: RegistroNovo }
  | { tipo: "atualizar"; id: string; novo: RegistroNovo }
  | { tipo: "apagar"; id: string };

export interface PassoDoPlano {
  registro: ResultadoDoRegistro["registro"];
  estado: Exclude<EstadoDoRegistro, "falhou">;
  detalhe?: string;
  operacoes: Operacao[];
}

/** A Cloudflare devolve TXT com ou sem aspas, conforme a versao da API. */
function semAspas(conteudo: string): string {
  return conteudo.trim().replace(/^"(.*)"$/s, "$1").replace(/"\s+"/g, "");
}

function igual(a: string, b: string): boolean {
  return a.trim().toLowerCase().replace(/\.$/, "") === b.trim().toLowerCase().replace(/\.$/, "");
}

/** Poe o nosso `include` num SPF que ja existe, antes do mecanismo `all`. */
export function spfComInclude(spfAtual: string, include: string): string {
  const termos = spfAtual.trim().split(/\s+/);
  if (termos.some((t) => t.toLowerCase() === include.toLowerCase())) return termos.join(" ");
  const posAll = termos.findIndex((t) => /^[+\-~?]?all$/i.test(t));
  if (posAll === -1) return [...termos, include].join(" ");
  return [...termos.slice(0, posAll), include, ...termos.slice(posAll)].join(" ");
}

function nomeCompleto(host: string, dominio: string): string {
  return host === "@" ? dominio : `${host}.${dominio}`;
}

/**
 * Decide o que fazer com cada registro, a partir do que ja existe na zona.
 * Puro: nao fala com a rede, e e o que o teste de unidade cobre.
 *
 * `existentes` traz os registros dos tres nomes envolvidos (raiz, seletor do
 * DKIM e `_dmarc`), de qualquer tipo.
 */
export function planejarPublicacao(
  dominio: string,
  desejados: DnsRecord[],
  existentes: RegistroCloudflare[],
  opcoes: { substituirMx: boolean },
): PassoDoPlano[] {
  const doNome = (nome: string, tipo?: string) =>
    existentes.filter((e) => igual(e.name, nome) && (!tipo || e.type === tipo));
  const passos: PassoDoPlano[] = [];

  for (const d of desejados) {
    const nome = nomeCompleto(d.host, dominio);

    if (d.type === "MX") {
      const novo: RegistroNovo = { type: "MX", name: nome, content: d.value, priority: d.priority ?? 10 };
      const atuais = doNome(nome, "MX");
      const nossos = atuais.filter((e) => igual(e.content, d.value));
      const outros = atuais.filter((e) => !igual(e.content, d.value));
      if (outros.length === 0) {
        passos.push(nossos.length > 0 ? { registro: "mx", estado: "ja_estava", operacoes: [] } : { registro: "mx", estado: "criado", operacoes: [{ tipo: "criar", novo }] });
      } else if (!opcoes.substituirMx) {
        passos.push({
          registro: "mx",
          estado: "precisa_confirmar",
          detalhe: `O e-mail deste dominio chega hoje em ${outros.map((e) => e.content).join(", ")}. Trocar o MX desliga esse recebimento na hora.`,
          operacoes: [],
        });
      } else {
        passos.push({
          registro: "mx",
          estado: "atualizado",
          detalhe: `MX anterior removido: ${outros.map((e) => e.content).join(", ")}`,
          operacoes: [...outros.map((e) => ({ tipo: "apagar" as const, id: e.id })), ...(nossos.length > 0 ? [] : [{ tipo: "criar" as const, novo }])],
        });
      }
      continue;
    }

    if (d.type === "CNAME") {
      const novo: RegistroNovo = { type: "CNAME", name: nome, content: d.value };
      const atuais = doNome(nome);
      // CNAME certo no ar: nao se mexe, mesmo com outro registro sobrando no
      // nome. O saudepet.app.br tem o CNAME e um TXT antigo lado a lado na
      // Cloudflare; apagar e recriar o CNAME abriria uma janela sem DKIM.
      if (atuais.some((e) => e.type === "CNAME" && igual(e.content, d.value))) {
        passos.push({ registro: "dkim", estado: "ja_estava", operacoes: [] });
      } else if (atuais.length === 0) {
        passos.push({ registro: "dkim", estado: "criado", operacoes: [{ tipo: "criar", novo }] });
      } else {
        // CNAME nao convive com outro registro no mesmo nome.
        passos.push({
          registro: "dkim",
          estado: "atualizado",
          operacoes: [...atuais.map((e) => ({ tipo: "apagar" as const, id: e.id })), { tipo: "criar", novo }],
        });
      }
      continue;
    }

    const ehDmarc = d.host === "_dmarc";
    const textos = doNome(nome, "TXT").map((e) => ({ ...e, content: semAspas(e.content) }));

    if (ehDmarc) {
      const atual = textos.find((e) => /^v=dmarc1/i.test(e.content));
      passos.push(
        atual
          ? { registro: "dmarc", estado: "mantido", detalhe: `Politica ja publicada: ${atual.content}`, operacoes: [] }
          : { registro: "dmarc", estado: "criado", operacoes: [{ tipo: "criar", novo: { type: "TXT", name: nome, content: d.value } }] },
      );
      continue;
    }

    const include = d.value.split(/\s+/).find((t) => t.toLowerCase().startsWith("include:")) ?? "";
    const spf = textos.find((e) => /^v=spf1(\s|$)/i.test(e.content));
    if (!spf) {
      passos.push({ registro: "spf", estado: "criado", operacoes: [{ tipo: "criar", novo: { type: "TXT", name: nome, content: d.value } }] });
    } else if (spf.content.toLowerCase().split(/\s+/).includes(include.toLowerCase())) {
      passos.push({ registro: "spf", estado: "ja_estava", operacoes: [] });
    } else {
      passos.push({
        registro: "spf",
        estado: "atualizado",
        detalhe: `SPF existente mantido, com o nosso include: ${spfComInclude(spf.content, include)}`,
        operacoes: [{ tipo: "atualizar", id: spf.id, novo: { type: "TXT", name: nome, content: spfComInclude(spf.content, include) } }],
      });
    }
  }

  return passos;
}

/** A zona deste dominio esta na conta da casa? Nunca lanca: e so um botao na tela. */
export async function dnsPublicavel(dominio: string): Promise<boolean> {
  if (!cloudflareComCredencial()) return false;
  try {
    return (await zonaPorNome(dominio)) !== null;
  } catch (erro) {
    log.warn("nao consegui consultar a zona na Cloudflare", { dominio, erro: String(erro) });
    return false;
  }
}

export async function publicarDnsDoDominio(dominioInformado: string, opcoes: { substituirMx: boolean }) {
  const dominio = await prisma.mailDomain.findUnique({
    where: { name: dominioInformado.toLowerCase() },
    select: { id: true, name: true, dkimSelector: true },
  });
  if (!dominio) throw new ProvisioningError(`Dominio nao provisionado: ${dominioInformado}`, 404);
  if (!cloudflareComCredencial()) throw new ProvisioningError("Cloudflare sem credenciais neste servidor.", 409);

  const zoneId = await zonaPorNome(dominio.name);
  if (!zoneId) throw new ProvisioningError(`A zona ${dominio.name} nao esta na conta da Cloudflare da Avila Ops.`, 409);

  const desejados = dnsRecordsFor(dominio.name, dominio.dkimSelector);
  const nomes = [...new Set(desejados.map((d) => nomeCompleto(d.host, dominio.name)))];
  const existentes = (await Promise.all(nomes.map((n) => registrosDoNome(zoneId, n)))).flat();
  const plano = planejarPublicacao(dominio.name, desejados, existentes, opcoes);

  const registros: ResultadoDoRegistro[] = [];
  for (const passo of plano) {
    try {
      for (const op of passo.operacoes) {
        if (op.tipo === "criar") await criarRegistro(zoneId, op.novo);
        else if (op.tipo === "atualizar") await atualizarRegistro(zoneId, op.id, op.novo);
        else await apagarRegistro(zoneId, op.id);
      }
      registros.push({ registro: passo.registro, estado: passo.estado, detalhe: passo.detalhe });
    } catch (erro) {
      // Um registro que falha nao impede os outros: cada um e independente.
      registros.push({ registro: passo.registro, estado: "falhou", detalhe: erro instanceof Error ? erro.message : String(erro) });
    }
  }

  const mudou = registros.some((r) => r.estado === "criado" || r.estado === "atualizado");
  log.info("dns publicado na cloudflare", { dominio: dominio.name, registros: registros.map((r) => `${r.registro}:${r.estado}`).join(" ") });
  await prisma.mailEvent.create({
    data: { domainId: dominio.id, type: "domain.dns_published", payload: { domain: dominio.name, substituirMx: opcoes.substituirMx, registros: registros.map((r) => ({ registro: r.registro, estado: r.estado })) } },
  });

  // Confere logo em seguida. A Cloudflare responde em segundos, mas quem
  // consulta pode ter a resposta antiga guardada: "ainda nao" aqui nao e erro.
  const verificacao = await verifyDomainDns(dominio.name);
  return { domain: dominio.name, registros, mudou, ready: verificacao.ready, checks: verificacao.checks };
}
