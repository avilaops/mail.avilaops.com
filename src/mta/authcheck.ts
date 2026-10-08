import { authenticate } from "mailauth";
import { config } from "../lib/config.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("authcheck");

export interface InboundAuthResult {
  spf: string;
  dkim: string;
  dkimDomain: string | null;
  dmarc: string;
  dmarcPolicy: string | null;
  arc: string;
  /** Header Authentication-Results pronto para prefixar ao .eml armazenado. */
  headers: string;
}

/**
 * Verifica SPF, DKIM, DMARC e ARC da mensagem recebida.
 *
 * O resultado e guardado junto da mensagem: e o que sustenta a classificacao
 * de spam, o selo de "remetente verificado" no webmail e a investigacao
 * posterior de qualquer entrega duvidosa.
 *
 * Falha da propria verificacao (DNS fora do ar, timeout) nao pode derrubar a
 * entrega — devolvemos null e a mensagem entra sem selo.
 */
export async function checkInboundAuth(
  raw: Buffer,
  envelope: { ip: string; helo: string; mailFrom: string },
): Promise<InboundAuthResult | null> {
  try {
    const result = await authenticate(raw, {
      ip: envelope.ip,
      helo: envelope.helo,
      sender: envelope.mailFrom,
      mta: config.hostname,
      disableBimi: true,
    });

    const firstDkim = result.dkim?.results?.[0];

    return {
      spf: result.spf?.status?.result ?? "none",
      dkim: firstDkim?.status?.result ?? "none",
      dkimDomain: firstDkim?.signingDomain ?? null,
      dmarc: result.dmarc?.status?.result ?? "none",
      dmarcPolicy: result.dmarc?.policy ?? null,
      arc: result.arc?.status?.result ?? "none",
      headers: result.headers ?? "",
    };
  } catch (error) {
    log.warn("verificacao de autenticacao falhou; mensagem segue sem selo", {
      ip: envelope.ip,
      mailFrom: envelope.mailFrom,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
