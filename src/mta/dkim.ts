import { generateKeyPairSync } from "node:crypto";
import { dkimSign } from "mailauth/lib/dkim/sign.js";
import { prisma } from "../lib/db.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { config } from "../lib/config.js";

/**
 * DKIM por dominio.
 *
 * Cada dominio hospedado ganha seu proprio par de chaves. A privada e cifrada
 * em repouso; a publica e publicada no DNS.
 *
 * O registro publicado no DNS do cliente e um CNAME apontando para a nossa
 * zona (mesmo modelo do SES e do Postmark):
 *
 *   avila._domainkey.clientex.com.br  CNAME  clientex-com-br.dkim.avilaops.com
 *
 * Isso permite rotacionar chave sem pedir nada ao cliente — mexemos so na
 * nossa zona. O custo e publicar tambem o TXT do lado de ca.
 */

export interface DkimKeyPair {
  selector: string;
  /** PEM PKCS#8, em claro. So circula na memoria. */
  privateKeyPem: string;
  /** Base64 do SPKI DER, pronto para o campo p= do TXT. */
  publicKeyBase64: string;
}

export function generateDkimKeyPair(selector = "avila"): DkimKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

  return {
    selector,
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
  };
}

/** Nome do host CNAME que o cliente publica na zona dele. */
export function dkimCnameTarget(domainName: string): string {
  return `${domainName.replace(/\./g, "-")}.dkim.${config.hostname.replace(/^mail\./, "")}`;
}

/** Conteudo do registro TXT (publicado na nossa zona, alvo do CNAME). */
export function dkimTxtValue(publicKeyBase64: string): string {
  return `v=DKIM1; k=rsa; p=${publicKeyBase64}`;
}

export function encryptDkimPrivateKey(privateKeyPem: string): string {
  return encryptSecret(privateKeyPem);
}

/**
 * Assina a mensagem com a chave do dominio remetente.
 * Devolve o bloco de headers DKIM-Signature para prefixar ao .eml.
 *
 * Dominio sem chave nao e erro fatal: a mensagem sai sem DKIM (e vai cair em
 * spam, e o alerta disso e problema do monitoramento). Falhar aqui prenderia
 * a fila inteira por um dominio mal provisionado.
 */
export async function signMessage(domainName: string, raw: Buffer): Promise<Buffer> {
  const domain = await prisma.mailDomain.findUnique({
    where: { name: domainName },
    select: { dkimSelector: true, dkimPrivateKey: true },
  });

  if (!domain?.dkimPrivateKey) return raw;

  const signResult = await dkimSign(raw, {
    canonicalization: "relaxed/relaxed",
    algorithm: "rsa-sha256",
    signTime: new Date(),
    signatureData: [
      {
        signingDomain: domainName,
        selector: domain.dkimSelector,
        privateKey: decryptSecret(domain.dkimPrivateKey),
        algorithm: "rsa-sha256",
      },
    ],
  });

  const headers: string = signResult?.signatures ?? "";
  if (!headers) return raw;

  return Buffer.concat([Buffer.from(headers), raw]);
}
