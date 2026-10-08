import { createHash, randomBytes } from "node:crypto";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { alertarMudanca } from "./alertas.js";

const log = createLogger("api-keys");

/**
 * Chaves de API da area de desenvolvedor.
 *
 * A regra da casa: o cliente busca a chave e revoga a chave pela interface,
 * sem ninguem precisar entrar no servidor. Por isso o token so existe em
 * claro no instante da criacao — guardamos o hash, como senha — e a lista
 * mostra prefixo, ultimo uso e o botao de revogar.
 *
 * Dois escopos, dois prefixos, para o dono reconhecer de longe o que tem na
 * mao (e para um vazamento de chave de caixa nunca virar acesso de
 * provisionamento):
 *
 *   amk_m_...  caixa          — age como o dono nas rotas /v1/me
 *   amk_p_...  provisionamento — cria dominio e caixa (rotas do operador)
 *
 * Chave de provisionamento so nasce de uma caixa administradora
 * (MAIL_ADMIN_ADDRESSES); e a mesma que o n8n usa.
 */

export type ApiKeyScope = "mailbox" | "provisioning";

export class ApiKeyError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ApiKeyError";
  }
}

const PREFIXO: Record<ApiKeyScope, string> = { mailbox: "amk_m_", provisioning: "amk_p_" };
const MAX_CHAVES_POR_CAIXA = 20;

/** sha256 em hex — o que vai para o banco. Sem sal: o token ja tem 160 bits aleatorios. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function gerarToken(scope: ApiKeyScope): string {
  return PREFIXO[scope] + randomBytes(20).toString("hex");
}

/** Escopo a partir do prefixo; null para qualquer coisa que nao seja chave nossa. */
export function escopoDoToken(token: string): ApiKeyScope | null {
  if (token.startsWith(PREFIXO.provisioning)) return "provisioning";
  if (token.startsWith(PREFIXO.mailbox)) return "mailbox";
  return null;
}

/** O que aparece na lista: "amk_m_1a2b3c…" — suficiente para reconhecer, inutil para usar. */
export function prefixoVisivel(token: string): string {
  return token.slice(0, 12) + "…";
}

/**
 * Administrador = caixa listada em MAIL_ADMIN_ADDRESSES, pelo endereco ou
 * pelo dono no SSO. Consulta o banco de proposito: o e-mail do dono pode
 * mudar depois de a sessao nascer.
 */
export async function ehAdministrador(mailboxId: string): Promise<boolean> {
  if (config.admin.addresses.length === 0) return false;
  const caixa = await prisma.mailbox.findUnique({
    where: { id: mailboxId },
    select: { localPart: true, ownerEmail: true, domain: { select: { name: true } } },
  });
  if (!caixa) return false;
  const endereco = `${caixa.localPart}@${caixa.domain.name}`.toLowerCase();
  const dono = caixa.ownerEmail?.toLowerCase();
  return config.admin.addresses.includes(endereco) || (dono !== undefined && config.admin.addresses.includes(dono));
}

const SELECAO = {
  id: true,
  name: true,
  scope: true,
  prefix: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

export async function listarChaves(mailboxId: string) {
  return prisma.mailApiKey.findMany({
    where: { mailboxId },
    orderBy: [{ revokedAt: "asc" }, { createdAt: "desc" }],
    select: SELECAO,
  });
}

/**
 * Cria a chave e devolve o token em claro — a unica vez em que ele existe
 * fora da memoria do cliente.
 */
export async function criarChave(input: { mailboxId: string; name: string; scope: ApiKeyScope }) {
  const name = input.name.trim();
  if (!name) throw new ApiKeyError("De um nome a chave (ex.: n8n, script de relatorios).");
  if (name.length > 60) throw new ApiKeyError("Nome longo demais (maximo 60).");

  if (input.scope === "provisioning" && !(await ehAdministrador(input.mailboxId))) {
    throw new ApiKeyError("Chave de provisionamento so pode ser criada por uma caixa administradora.", 403);
  }

  const ativas = await prisma.mailApiKey.count({ where: { mailboxId: input.mailboxId, revokedAt: null } });
  if (ativas >= MAX_CHAVES_POR_CAIXA) {
    throw new ApiKeyError(`Limite de ${MAX_CHAVES_POR_CAIXA} chaves ativas. Revogue alguma antes.`, 422);
  }

  const token = gerarToken(input.scope);
  const chave = await prisma.mailApiKey.create({
    data: {
      mailboxId: input.mailboxId,
      name,
      scope: input.scope,
      prefix: prefixoVisivel(token),
      tokenHash: hashToken(token),
    },
    select: SELECAO,
  });

  log.info("chave de api criada", { mailboxId: input.mailboxId, keyId: chave.id, scope: input.scope });
  // Chave nova e uma das formas de manter acesso apos roubar a conta.
  void alertarMudanca(input.mailboxId, "chave-api");
  return { chave, token };
}

export async function revogarChave(mailboxId: string, keyId: string) {
  const atualizadas = await prisma.mailApiKey.updateMany({
    where: { id: keyId, mailboxId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (atualizadas.count === 0) throw new ApiKeyError("Chave nao encontrada ou ja revogada.", 404);
  log.info("chave de api revogada", { mailboxId, keyId });
  return { ok: true };
}

export interface ChaveAutenticada {
  keyId: string;
  scope: ApiKeyScope;
  mailboxId: string;
  address: string;
}

/**
 * Resolve um token de chave de API. Devolve null para token desconhecido,
 * revogado ou de caixa que nao esta ativa — o chamador trata todos igual
 * (401), sem dizer qual foi o caso.
 */
export async function autenticarChave(token: string): Promise<ChaveAutenticada | null> {
  const scope = escopoDoToken(token);
  if (!scope) return null;

  const chave = await prisma.mailApiKey.findUnique({
    where: { tokenHash: hashToken(token) },
    select: {
      id: true,
      scope: true,
      revokedAt: true,
      mailboxId: true,
      mailbox: { select: { status: true, localPart: true, domain: { select: { name: true } } } },
    },
  });

  if (!chave || chave.revokedAt || chave.scope !== scope) return null;
  if (chave.mailbox.status !== "active") return null;

  // Chave de provisionamento continua exigindo que a caixa seja admin HOJE:
  // tirar o endereco da lista revoga o poder sem precisar cacar as chaves.
  if (scope === "provisioning" && !(await ehAdministrador(chave.mailboxId))) return null;

  void prisma.mailApiKey
    .update({ where: { id: chave.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return {
    keyId: chave.id,
    scope,
    mailboxId: chave.mailboxId,
    address: `${chave.mailbox.localPart}@${chave.mailbox.domain.name}`,
  };
}
