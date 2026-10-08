import type { IncomingMessage, ServerResponse } from "node:http";

/** Utilitarios compartilhados pelas rotas de provisionamento e de caixa. */

/** Padrao enxuto: rota de JSON comum nao tem por que aceitar corpo grande. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Teto das rotas de envio, que carregam anexo em base64.
 * Base64 infla ~33%, entao precisa folgar sobre o limite da mensagem.
 */
export const MAX_COMPOSE_BODY_BYTES = 40 * 1024 * 1024;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** BigInt vira string: JSON.stringify lanca em BigInt e o Prisma devolve varios. */
export function json(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

export function fail(res: ServerResponse, status: number, message: string): void {
  json(res, status, { error: { message } });
}

/**
 * Resposta binaria (anexo, .eml).
 *
 * `Content-Disposition: attachment` e `X-Content-Type-Options: nosniff` sao
 * obrigatorios aqui: sem eles, um anexo HTML enviado por terceiro seria
 * renderizado na origem do webmail — XSS com sessao valida.
 */
export function binary(
  res: ServerResponse,
  payload: { filename: string; contentType: string; content: Buffer },
): void {
  const nomeSeguro = payload.filename.replace(/["\r\n]/g, "_");
  res.writeHead(200, {
    "Content-Type": payload.contentType,
    "Content-Length": payload.content.byteLength,
    "Content-Disposition": `attachment; filename="${nomeSeguro}"`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; sandbox",
    "Cache-Control": "private, max-age=300",
  });
  res.end(payload.content);
}

export async function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of req) {
    total += (chunk as Buffer).byteLength;
    if (total > maxBytes) throw new HttpError("Corpo da requisicao maior que o limite.", 413);
    chunks.push(chunk as Buffer);
  }

  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError("Corpo da requisicao nao e JSON valido.", 400);
  }
}

export function bearerToken(req: IncomingMessage): string {
  const header = req.headers.authorization ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

/** IP do cliente, respeitando o proxy do Caddy. */
export function clientIp(req: IncomingMessage): string {
  const encaminhado = req.headers["x-forwarded-for"];
  const primeiro = Array.isArray(encaminhado) ? encaminhado[0] : encaminhado?.split(",")[0];
  return (primeiro ?? req.socket.remoteAddress ?? "").trim();
}

export function userAgent(req: IncomingMessage): string {
  const valor = req.headers["user-agent"];
  return Array.isArray(valor) ? (valor[0] ?? "") : (valor ?? "");
}
