import { resolveNs } from "node:dns/promises";

/**
 * Onde o DNS de um dominio esta hospedado, descoberto pelos servidores de nome.
 *
 * Quem cadastra um dominio recebe quatro registros para publicar e precisa
 * achar sozinho o painel certo. Os servidores de nome (NS) dizem qual e: a
 * tela mostra um botao que abre o DNS daquele dominio no provedor, como o
 * Google Search Console faz na verificacao de propriedade.
 *
 * So entram na lista provedores cujo endereco do painel e conhecido. Para os
 * outros a tela mostra os servidores de nome, sem link, em vez de chutar.
 */

export interface ProvedorDns {
  id: string;
  nome: string;
  /** "na Cloudflare", "no Registro.br": a tela escreve a frase com isto. */
  preposicao: "na" | "no";
  /** Painel de DNS do provedor; quando o provedor permite, ja no dominio. */
  url: string;
  /** O link abre direto no dominio, e nao so na entrada do painel. */
  direto: boolean;
}

export interface DnsDoDominio {
  provedor: ProvedorDns | null;
  /** Servidores de nome encontrados, em minusculas e sem o ponto final. */
  servidores: string[];
}

interface Regra {
  id: string;
  nome: string;
  preposicao: "na" | "no";
  /** O NS pertence ao provedor quando termina com um destes sufixos. */
  sufixos: string[];
  url: (dominio: string) => string;
  direto: boolean;
}

const REGRAS: Regra[] = [
  {
    id: "cloudflare",
    nome: "Cloudflare",
    preposicao: "na",
    sufixos: ["ns.cloudflare.com"],
    url: (d) => `https://dash.cloudflare.com/?to=/:account/${d}/dns/records`,
    direto: true,
  },
  {
    // So os NS do DNS hospedado do Registro.br. `a.dns.br` e os da propria
    // zona `com.br` ficam de fora: nao dizem nada sobre o dominio do cliente.
    id: "registrobr",
    nome: "Registro.br",
    preposicao: "no",
    sufixos: ["auto.dns.br", "sec.dns.br"],
    url: () => "https://registro.br/painel/",
    direto: false,
  },
  {
    id: "godaddy",
    nome: "GoDaddy",
    preposicao: "na",
    sufixos: ["domaincontrol.com"],
    url: (d) => `https://dcc.godaddy.com/control/dnsmanagement?domainName=${d}`,
    direto: true,
  },
  {
    id: "hostinger",
    nome: "Hostinger",
    preposicao: "na",
    sufixos: ["dns-parking.com"],
    url: (d) => `https://hpanel.hostinger.com/domain/${d}/dns`,
    direto: true,
  },
  {
    id: "namecheap",
    nome: "Namecheap",
    preposicao: "na",
    sufixos: ["registrar-servers.com"],
    url: (d) => `https://ap.www.namecheap.com/Domains/DomainControlPanel/${d}/advancedns`,
    direto: true,
  },
  {
    id: "porkbun",
    nome: "Porkbun",
    preposicao: "na",
    sufixos: ["porkbun.com"],
    url: () => "https://porkbun.com/account/domains",
    direto: false,
  },
];

function limpar(ns: string): string {
  return ns.trim().toLowerCase().replace(/\.$/, "");
}

/** O provedor dono destes servidores de nome, ou `null` se nao for conhecido. */
export function provedorPelosNs(servidores: string[], dominio: string): ProvedorDns | null {
  const nomes = servidores.map(limpar).filter(Boolean);
  const regra = REGRAS.find((r) => nomes.some((n) => r.sufixos.some((s) => n === s || n.endsWith(`.${s}`))));
  if (!regra) return null;
  return { id: regra.id, nome: regra.nome, preposicao: regra.preposicao, url: regra.url(encodeURIComponent(dominio.toLowerCase())), direto: regra.direto };
}

const TEMPO_LIMITE_MS = 3000;

/**
 * Consulta os NS do dominio e identifica o provedor.
 *
 * Nunca lanca e nunca demora mais que o limite: e um atalho na tela, e a tela
 * de dominio tem de abrir mesmo com o DNS fora do ar. Dominio sem NS proprio
 * (ainda nao delegado, ou subdominio) volta sem provedor.
 */
export async function descobrirDnsDoDominio(dominio: string): Promise<DnsDoDominio> {
  try {
    const servidores = await Promise.race([
      resolveNs(dominio),
      new Promise<string[]>((_, recusar) => setTimeout(() => recusar(new Error("tempo esgotado")), TEMPO_LIMITE_MS).unref()),
    ]);
    const nomes = servidores.map(limpar).sort();
    return { provedor: provedorPelosNs(nomes, dominio), servidores: nomes };
  } catch {
    return { provedor: null, servidores: [] };
  }
}
