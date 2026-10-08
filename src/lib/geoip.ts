import { createLogger } from "./logger.js";

const log = createLogger("geoip");

/**
 * Cidade e pais de um IP, para a tela de aparelhos conectados.
 *
 * "187.x.x.x" nao responde a pergunta que a tela existe para responder — "esse
 * acesso sou eu?" — e "Sao Jose do Rio Preto, SP · Brasil" responde.
 *
 * A consulta e feita UMA vez, quando a sessao nasce, e o resultado fica
 * gravado na linha da sessao: nada de chamar servico externo a cada abertura
 * da tela. Falha, timeout ou IP privado devolvem null, e a tela mostra so o
 * IP — a localizacao e um confortos, nunca um bloqueio.
 *
 * O provedor e trocavel por `MAIL_GEOIP_URL` (`{ip}` e substituido). O padrao
 * e o ipwho.is: HTTPS, sem cadastro e sem chave, o que evita mais um segredo
 * para guardar por causa de um rotulo de tela.
 */

const URL_PADRAO = "https://ipwho.is/{ip}";
const TEMPO_LIMITE_MS = 3_500;

/** IP que nao sai da rede: consultar provedor externo seria desperdicio. */
function privado(ip: string): boolean {
  if (!ip) return true;
  if (ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.")) return true;
  if (ip.startsWith("10.") || ip.startsWith("192.168.")) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80")) return true;
  return false;
}

interface Resposta {
  success?: boolean;
  city?: string;
  region?: string;
  region_code?: string;
  country?: string;
  country_code?: string;
}

/** @returns "Cidade, UF · Pais" ou null quando nao da para saber. */
export async function localizarIp(ip: string | null | undefined): Promise<string | null> {
  const endereco = (ip ?? "").trim();
  if (privado(endereco)) return null;

  const url = (process.env.MAIL_GEOIP_URL || URL_PADRAO).replace("{ip}", encodeURIComponent(endereco));

  try {
    const resposta = await fetch(url, {
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
      headers: { Accept: "application/json" },
    });
    if (!resposta.ok) return null;

    const dados = (await resposta.json()) as Resposta;
    if (dados.success === false) return null;

    const regiao = dados.region_code || dados.region;
    const cidade = [dados.city, regiao].filter(Boolean).join(", ");
    const pais = dados.country || dados.country_code;
    const texto = [cidade, pais].filter(Boolean).join(" · ");

    return texto.length > 0 ? texto.slice(0, 120) : null;
  } catch (erro) {
    // Provedor fora do ar nao pode atrapalhar login nenhum.
    log.debug?.("nao foi possivel localizar o ip", { erro: erro instanceof Error ? erro.message : String(erro) });
    return null;
  }
}
