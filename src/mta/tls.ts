import { readFileSync, statSync } from "node:fs";
import { createSecureContext, type SecureContext, type TlsOptions } from "node:tls";
import { config } from "../lib/config.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("tls");

/**
 * Material TLS que se atualiza sozinho quando o certificado e renovado.
 *
 * O certificado vem do Caddy, que renova ~30 dias antes de vencer, e um timer
 * copia os arquivos para /etc/avila-mail/tls. Se o MTA lesse o certificado
 * apenas na subida — como fazia — a renovacao so valeria no proximo restart:
 * na pratica, o certificado vencia em producao e Outlook e celular paravam de
 * conectar sem ninguem ter mudado nada.
 *
 * A releitura acontece pelo `SNICallback`: o Node o chama a cada handshake, e
 * ali conferimos o mtime do arquivo. Handshake nao paga leitura de disco fora
 * do momento em que o arquivo realmente mudou, e nenhuma conexao cai — quem ja
 * esta conectado segue no contexto antigo, quem chega depois pega o novo.
 *
 * O `cert`/`key` continuam nas opcoes como contexto padrao, para o cliente
 * raro que nao manda SNI. Esse cliente fica com o certificado da subida, o que
 * e seguro: a renovacao acontece com 30 dias de folga, e qualquer restart
 * (deploy, reboot) o atualiza muito antes de vencer.
 */

interface Cache {
  contexto: SecureContext;
  assinatura: string;
}

let cache: Cache | null = null;

/** mtime+tamanho dos dois arquivos: muda quando o certificado e trocado. */
function assinaturaDosArquivos(): string {
  const cert = statSync(config.tls.certPath);
  const chave = statSync(config.tls.keyPath);
  return `${cert.mtimeMs}:${cert.size}:${chave.mtimeMs}:${chave.size}`;
}

function contextoAtual(): SecureContext {
  const assinatura = assinaturaDosArquivos();
  if (cache && cache.assinatura === assinatura) return cache.contexto;

  const contexto = createSecureContext({
    cert: readFileSync(config.tls.certPath),
    key: readFileSync(config.tls.keyPath),
    minVersion: "TLSv1.2",
  });

  log.info(cache ? "certificado renovado recarregado sem reiniciar" : "certificado carregado", {
    caminho: config.tls.certPath,
  });
  cache = { contexto, assinatura };
  return contexto;
}

/**
 * @returns opcoes TLS para os servidores, ou undefined quando nao ha
 * certificado (desenvolvimento, ou primeira subida antes da emissao).
 */
export function carregarTls(): TlsOptions | undefined {
  if (!config.tls.certPath || !config.tls.keyPath) {
    log.warn("TLS nao configurado: entrada e submission sobem sem STARTTLS proprio. Use apenas em desenvolvimento.", {});
    return undefined;
  }

  let padrao: { cert: Buffer; key: Buffer };
  try {
    padrao = {
      cert: readFileSync(config.tls.certPath),
      key: readFileSync(config.tls.keyPath),
    };
  } catch (error) {
    const codigo = (error as NodeJS.ErrnoException).code;

    /**
     * Certificado que ainda nao foi emitido nao e erro de configuracao.
     *
     * Na primeira subida o DNS pode nem ter propagado, e o Caddy ainda nao
     * pediu o certificado. Derrubar o servidor por isso significaria nao
     * receber e-mail — sendo que a entrada na porta 25 funciona sem TLS.
     * O timer de sincronia reinicia o servico assim que o arquivo aparece.
     */
    if (codigo === "ENOENT") {
      log.warn("certificado ainda nao existe; subindo SEM TLS ate ele ser emitido", {
        caminho: config.tls.certPath,
      });
      return undefined;
    }

    // Arquivo existe mas nao da para ler: permissao errada ou conteudo
    // corrompido. Isso E erro de configuracao e precisa gritar.
    throw new Error(
      `Nao foi possivel ler o certificado TLS (${config.tls.certPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    ...padrao,
    minVersion: "TLSv1.2",
    SNICallback: (_servername, callback) => {
      try {
        callback(null, contextoAtual());
      } catch (error) {
        // Falha ao reler (arquivo sendo trocado neste instante, por exemplo):
        // segue com o ultimo contexto bom em vez de recusar o handshake.
        log.warn("nao foi possivel reler o certificado; mantendo o anterior", {
          erro: error instanceof Error ? error.message : String(error),
        });
        callback(null, cache?.contexto);
      }
    },
  };
}
