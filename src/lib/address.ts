/**
 * Normalizacao de enderecos de e-mail.
 *
 * O SMTP trata a parte local como case-sensitive na especificacao, mas nenhum
 * provedor real faz isso e o cliente que digita "Contato@" espera cair em
 * "contato@". Normalizamos para minusculo dos dois lados e usamos essa forma
 * como chave unica.
 */

export interface ParsedAddress {
  localPart: string;
  domain: string;
  full: string;
}

/** RFC 5322 simplificado — restritivo de proposito, e o que aceitamos criar. */
const LOCAL_PART_RE = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

export function parseAddress(input: string): ParsedAddress | null {
  const trimmed = input.trim().toLowerCase();
  // Descarta o rotulo de exibicao, se vier no formato "Nome <a@b.com>".
  const angled = trimmed.match(/<([^>]+)>/);
  const bare = (angled?.[1] ?? trimmed).trim();

  const at = bare.lastIndexOf("@");
  if (at <= 0 || at === bare.length - 1) return null;

  const localPart = bare.slice(0, at);
  const domain = bare.slice(at + 1);

  if (!LOCAL_PART_RE.test(localPart) || !DOMAIN_RE.test(domain)) return null;

  return { localPart, domain, full: `${localPart}@${domain}` };
}

export function isValidAddress(input: string): boolean {
  return parseAddress(input) !== null;
}

/**
 * Remove sub-enderecamento (contato+nota@dominio → contato@dominio) para
 * resolver a caixa de destino. O endereco original e preservado no header.
 */
export function stripSubaddress(localPart: string): string {
  const plus = localPart.indexOf("+");
  return plus === -1 ? localPart : localPart.slice(0, plus);
}

export function isValidLocalPart(localPart: string): boolean {
  return LOCAL_PART_RE.test(localPart.trim().toLowerCase());
}

export function isValidDomain(domain: string): boolean {
  return DOMAIN_RE.test(domain.trim().toLowerCase());
}
