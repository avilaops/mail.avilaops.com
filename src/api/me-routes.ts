import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { verifyAccessToken } from "../lib/jwt.js";
import { prisma } from "../lib/db.js";
import { MAX_COMPOSE_BODY_BYTES, bearerToken, binary, clientIp, fail, json, readBody, userAgent } from "./http.js";
import { saveDraft, sendMessage, undoSend } from "../services/compose.js";
import { remainingQuota } from "../services/sendQuota.js";
import {
  AuthError,
  changeOwnPassword,
  completarLoginTotp,
  disableTotp,
  enableTotp,
  listSessions,
  firstPassword,
  login,
  loginSso,
  logout,
  logoutAll,
  refresh,
  revokeSession,
  setupTotp,
} from "../services/session.js";
import {
  deleteMessages,
  emptyTrash,
  getAttachment,
  getMessage,
  getOverview,
  getRawMessage,
  getThread,
  listFolders,
  listMessages,
  parseAttachmentFilter,
  markAllRead,
  reportSpam,
  unreadCounts,
  updateMessages,
  snoozeMessages,
} from "../services/messages.js";
import { createFolder, deleteFolder, renameFolder } from "../services/folders.js";
import { createRule, deleteRule, listRules, updateRule } from "../services/rules.js";
import { autenticarChave, criarChave, ehAdministrador, escopoDoToken, listarChaves, revogarChave } from "../services/apiKeys.js";
import { handleAdminRoute } from "./admin-routes.js";
import { chavePublica, listarInscricoes, pushDisponivel, registrarInscricao, removerInscricao } from "../services/push.js";
import { getSettings, updateProfile, updateSettings } from "../services/settings.js";
import { listSendAs, searchContacts } from "../services/contacts.js";
import { deleteUpload, listUploads, storeUpload } from "../services/uploads.js";
import { requestPasswordReset, resetPassword } from "../services/recovery.js";
import { agendarMigracao, cancelarMigracao, testarConexao, verMigracao } from "../services/migracao.js";
import type { SystemFolderKind } from "../services/folders.js";

/**
 * Rotas do dono da caixa (webmail).
 *
 * Autenticacao por JWT de sessao — diferente das rotas de provisionamento,
 * que usam o token estatico da Avila. Um token nunca serve para o outro:
 * o de provisionamento cria e apaga caixa de qualquer cliente; o de sessao
 * so enxerga a caixa dele.
 */

const loginSchema = z.object({
  address: z.string().min(3),
  password: z.string().min(1),
});

const refreshSchema = z.object({ refreshToken: z.string().min(10) });
const firstPasswordSchema = z.object({ newPassword: z.string().min(12).max(500) });

const ssoSchema = z.object({
  ssoToken: z.string().min(20),
  address: z.string().min(3).optional(),
});

const totpLoginSchema = z.object({
  totpToken: z.string().min(10),
  code: z.string().min(6).max(20),
});

const totpCodeSchema = z.object({ code: z.string().min(6).max(20) });

const passwordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(12),
});

const migracaoSchema = z.object({
  host: z.string().min(3).max(200),
  port: z.number().int().min(1).max(65535).optional(),
  user: z.string().min(3).max(320),
  password: z.string().min(1).max(500),
});

const FOLDER_KINDS = ["inbox", "sent", "drafts", "spam", "trash", "archive"] as const;

const updateSchema = z.object({
  messageIds: z.array(z.string().min(1)).min(1).max(200),
  seen: z.boolean().optional(),
  flagged: z.boolean().optional(),
  moveTo: z.enum(FOLDER_KINDS).optional(),
  moveToFolderId: z.string().optional(),
});

const spamSchema = z.object({ messageIds: z.array(z.string().min(1)).min(1).max(200) });

const settingsSchema = z.object({
  notifyEnabled: z.boolean().optional(),
  notifyQuietStart: z.number().int().min(0).max(23).nullable().optional(),
  notifyQuietEnd: z.number().int().min(0).max(23).nullable().optional(),
  notifyOnlyInbox: z.boolean().optional(),
  signatureHtml: z.string().max(20_000).nullable().optional(),
  autoReplyEnabled: z.boolean().optional(),
  autoReplySubject: z.string().max(200).nullable().optional(),
  autoReplyBody: z.string().max(5000).nullable().optional(),
  autoReplyUntil: z.string().nullable().optional(),
  showRemoteImages: z.boolean().optional(),
  messagesPerPage: z.number().int().optional(),
});

const profileSchema = z.object({
  displayName: z.string().max(120).nullable().optional(),
  recoveryEmail: z.string().max(200).nullable().optional(),
});

const uploadSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().max(150).optional(),
  contentBase64: z.string().min(1),
});

const folderSchema = z.object({ name: z.string().min(1).max(60) });

const ruleSchema = z.object({
  name: z.string().min(1).max(80),
  match: z.enum(["all", "any"]).default("all"),
  conditions: z
    .array(
      z.object({
        field: z.enum(["from", "to", "subject", "has_attachment"]),
        contains: z.string().min(1).max(200).optional(),
      }),
    )
    .min(1)
    .max(10),
  actions: z.object({
    folderId: z.string().min(1).max(60).nullish(),
    markRead: z.boolean().optional(),
    star: z.boolean().optional(),
    forwardTo: z.string().min(3).max(200).nullish(),
  }),
  enabled: z.boolean().optional(),
});

const forgotSchema = z.object({ address: z.string().min(3).max(200) });
const resetSchema = z.object({ token: z.string().min(10), newPassword: z.string().min(12) });

const deleteSchema = z.object({
  messageIds: z.array(z.string().min(1)).min(1).max(200),
  permanent: z.boolean().optional(),
});

const composeSchema = z.object({
  to: z.array(z.string().min(3)).max(50),
  cc: z.array(z.string().min(3)).max(50).optional(),
  bcc: z.array(z.string().min(3)).max(50).optional(),
  subject: z.string().max(500).optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  inReplyToMessageId: z.string().optional(),
  draftId: z.string().optional(),
  attachments: z
    .array(
      z.object({
        filename: z.string().min(1).max(200),
        contentType: z.string().max(150).optional(),
        contentBase64: z.string().min(1),
      }),
    )
    .max(20)
    .optional(),
  attachmentIds: z.array(z.string().min(1)).max(20).optional(),
  fromAddress: z.string().max(200).optional(),
  appendSignature: z.boolean().optional(),
});

/** Rascunho pode estar pela metade: destinatario e assunto sao opcionais. */
const snoozeSchema = z.object({
  messageIds: z.array(z.string().min(1)).min(1).max(200),
  until: z.string().datetime(),
});

const undoSendSchema = z.object({
  queuedId: z.string().min(1),
  rfcMessageId: z.string().min(1),
});

const draftSchema = composeSchema.extend({ to: z.array(z.string().min(3)).max(50).optional() });

interface Sessao {
  mailboxId: string;
  address: string;
  sessionId: string;
  mustChangePassword: boolean;
  /** Preenchido quando a autenticacao veio de chave de API, nao de login. */
  apiKeyId?: string;
}

/**
 * O que uma chave de API NAO pode fazer, mesmo agindo como o dono: mexer em
 * senha, 2FA, sessoes, migracao, perfil e nas proprias chaves. Sao as acoes
 * que transformam uma chave vazada em tomada de conta permanente.
 */
const VEDADO_A_CHAVE = [
  "/v1/me/password",
  "/v1/me/totp",
  "/v1/me/sessions",
  "/v1/me/migracao",
  "/v1/me/api-keys",
  "/v1/me/profile",
  "/v1/admin",
];

const pushSchema = z.object({
  endpoint: z.string().url().max(2000),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(10).max(200) }),
});

const pushRefSchema = z.object({ endpoint: z.string().url().max(2000) });

const apiKeySchema = z.object({
  name: z.string().min(1).max(60),
  scope: z.enum(["mailbox", "provisioning"]).default("mailbox"),
});

/** Intervalo entre consultas ao banco no fluxo de eventos. */
const SSE_POLL_MS = 8_000;
/** Duracao maxima da conexao. Depois disso o cliente reconecta sozinho. */
const SSE_MAX_MS = 5 * 60_000;

/**
 * Aviso de mensagem nova por Server-Sent Events.
 *
 * Poll no banco em vez de WebSocket ou fila de eventos: uma consulta a cada
 * 8 segundos, por caixa aberta, e barata no volume da Fase 1 e nao adiciona
 * nenhuma peca de infraestrutura para manter.
 *
 * A conexao se encerra sozinha em 5 minutos porque proxy no meio do caminho
 * derruba stream ocioso sem avisar; reconectar de tempos em tempos e mais
 * confiavel do que descobrir que o canal morreu calado.
 */
async function streamEvents(req: IncomingMessage, res: ServerResponse, mailboxId: string): Promise<void> {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    // Desliga o buffer de proxy: sem isso o evento fica preso ate encher.
    "X-Accel-Buffering": "no",
  });

  const enviar = (evento: string, dados: unknown) => {
    res.write(`event: ${evento}\ndata: ${JSON.stringify(dados)}\n\n`);
  };

  let ultimoVisto = new Date();
  let ativo = true;

  const encerrar = () => {
    if (!ativo) return;
    ativo = false;
    clearInterval(timer);
    clearTimeout(limite);
    res.end();
  };

  req.on("close", encerrar);

  const timer = setInterval(() => {
    void (async () => {
      if (!ativo) return;
      try {
        const novas = await prisma.message.findMany({
          where: { mailboxId, receivedAt: { gt: ultimoVisto }, folder: { kind: "inbox" } },
          orderBy: { receivedAt: "asc" },
          select: { id: true, fromAddress: true, fromName: true, subject: true, receivedAt: true },
          take: 20,
        });

        if (novas.length > 0) {
          ultimoVisto = novas[novas.length - 1]?.receivedAt ?? ultimoVisto;
          enviar("message", { messages: novas, unread: (await unreadCounts(mailboxId)).total });
        } else {
          // Comentario SSE: mantem a conexao viva sem virar evento no cliente.
          res.write(": keep-alive\n\n");
        }
      } catch {
        encerrar();
      }
    })();
  }, SSE_POLL_MS);

  const limite = setTimeout(() => {
    enviar("reconnect", { reason: "limite de tempo da conexao" });
    encerrar();
  }, SSE_MAX_MS);

  enviar("ready", { mailboxId, pollMs: SSE_POLL_MS });

  await new Promise<void>((resolve) => {
    const checar = setInterval(() => {
      if (!ativo) {
        clearInterval(checar);
        resolve();
      }
    }, 500);
  });
}

/**
 * Valida o access token e confirma que a sessao continua viva.
 *
 * A consulta ao banco existe de proposito: sem ela, um JWT emitido antes de a
 * caixa ser suspensa (ou antes de o cliente clicar em "sair de todos os
 * dispositivos") continuaria valendo ate expirar.
 */
async function autenticar(req: IncomingMessage, path = ""): Promise<Sessao> {
  const token = bearerToken(req);
  if (!token) throw new AuthError("Token de sessao ausente.");

  // Chave de API da area de desenvolvedor: age como o dono, com as vedacoes acima.
  if (escopoDoToken(token) === "mailbox") {
    const chave = await autenticarChave(token);
    if (!chave) throw new AuthError("Chave de API invalida ou revogada.");
    if (VEDADO_A_CHAVE.some((prefixo) => path.startsWith(prefixo))) {
      throw new AuthError("Esta operacao nao pode ser feita com chave de API — entre no webmail.", 403);
    }
    return {
      mailboxId: chave.mailboxId,
      address: chave.address,
      sessionId: `apikey:${chave.keyId}`,
      mustChangePassword: false,
      apiKeyId: chave.keyId,
    };
  }

  const payload = verifyAccessToken(token);
  if (!payload) throw new AuthError("Sessao invalida ou expirada.");

  const sessao = await prisma.mailSession.findFirst({
    where: { id: payload.sid, mailboxId: payload.sub, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { id: true, mailbox: { select: { status: true, mustChangePassword: true } } },
  });

  if (!sessao) throw new AuthError("Sessao encerrada. Faca login novamente.");
  if (sessao.mailbox.status !== "active") throw new AuthError("Caixa indisponivel no momento.", 403);

  void prisma.mailSession
    .update({ where: { id: sessao.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return { mailboxId: payload.sub, address: payload.adr, sessionId: payload.sid, mustChangePassword: sessao.mailbox.mustChangePassword };
}

/**
 * Rotas liberadas enquanto a senha do primeiro acesso nao foi definida.
 * Tudo o mais e recusado com 409 `must_change_password` — a interface leva o
 * dono para a tela de definir senha antes de qualquer coisa.
 */
const LIBERADAS_ANTES_DA_SENHA = new Set(["/v1/me/first-password"]);

/**
 * @returns true se a rota foi tratada aqui; false para o roteador seguir adiante.
 */
export async function handleUserRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  url: URL,
): Promise<boolean> {
  // --- Autenticacao (sem token) ---

  if (path === "/v1/auth/login" && method === "POST") {
    const input = loginSchema.parse(await readBody(req));
    json(res, 200, await login({ ...input, ip: clientIp(req), userAgent: userAgent(req) }));
    return true;
  }

  // Segunda etapa do login quando a caixa tem 2FA.
  if (path === "/v1/auth/totp" && method === "POST") {
    const input = totpLoginSchema.parse(await readBody(req));
    json(res, 200, await completarLoginTotp({ ...input, ip: clientIp(req), userAgent: userAgent(req) }));
    return true;
  }

  // Login pelo SSO (auth.avilaops.com): o webmail repassa o cookie avila_sso.
  if (path === "/v1/auth/sso" && method === "POST") {
    const input = ssoSchema.parse(await readBody(req));
    json(res, 200, await loginSso({ ...input, ip: clientIp(req), userAgent: userAgent(req) }));
    return true;
  }

  if (path === "/v1/auth/refresh" && method === "POST") {
    const input = refreshSchema.parse(await readBody(req));
    json(res, 200, await refresh({ ...input, ip: clientIp(req), userAgent: userAgent(req) }));
    return true;
  }

  if (path === "/v1/auth/logout" && method === "POST") {
    const input = refreshSchema.parse(await readBody(req));
    await logout(input.refreshToken);
    json(res, 200, { ok: true });
    return true;
  }

  if (path === "/v1/auth/forgot-password" && method === "POST") {
    const input = forgotSchema.parse(await readBody(req));
    json(res, 200, await requestPasswordReset({ address: input.address, ip: clientIp(req) }));
    return true;
  }

  if (path === "/v1/auth/reset-password" && method === "POST") {
    const input = resetSchema.parse(await readBody(req));
    json(res, 200, await resetPassword(input));
    return true;
  }

  if (!path.startsWith("/v1/me") && !path.startsWith("/v1/admin")) return false;

  // --- Daqui para baixo exige sessao valida ---

  const sessao = await autenticar(req, path);

  // --- Aviso de mensagem nova no aparelho (Web Push) ---

  if (path === "/v1/me/push" && method === "GET") {
    json(res, 200, {
      disponivel: pushDisponivel(),
      chavePublica: chavePublica(),
      aparelhos: await listarInscricoes(sessao.mailboxId),
    });
    return true;
  }

  if (path === "/v1/me/push" && method === "POST") {
    const input = pushSchema.parse(await readBody(req));
    json(res, 201, await registrarInscricao(sessao.mailboxId, input, userAgent(req)));
    return true;
  }

  if (path === "/v1/me/push" && method === "DELETE") {
    const input = pushRefSchema.parse(await readBody(req));
    json(res, 200, await removerInscricao(sessao.mailboxId, input.endpoint));
    return true;
  }

  // --- Area de desenvolvedor: chaves de API ---

  if (path === "/v1/me/api-keys" && method === "GET") {
    json(res, 200, {
      keys: await listarChaves(sessao.mailboxId),
      canProvision: await ehAdministrador(sessao.mailboxId),
    });
    return true;
  }

  if (path === "/v1/me/api-keys" && method === "POST") {
    const input = apiKeySchema.parse(await readBody(req));
    const { chave, token } = await criarChave({ mailboxId: sessao.mailboxId, name: input.name, scope: input.scope });
    // O token so existe nesta resposta: nao entra em log, nao volta em GET.
    json(res, 201, { key: chave, token });
    return true;
  }

  const chaveMatch = path.match(/^\/v1\/me\/api-keys\/([\w-]+)$/);
  if (chaveMatch && method === "DELETE") {
    json(res, 200, await revogarChave(sessao.mailboxId, chaveMatch[1] ?? ""));
    return true;
  }

  if (sessao.mustChangePassword && !LIBERADAS_ANTES_DA_SENHA.has(path)) {
    json(res, 409, { error: { message: "Defina a senha da sua caixa antes de continuar.", code: "must_change_password" } });
    return true;
  }

  // Area administrativa (caixas em MAIL_ADMIN_ADDRESSES): provisionamento pela
  // tela. Vem DEPOIS da trava de primeira senha: administrar com a senha que o
  // operador escolheu seria pular justamente a etapa que a trava existe para exigir.
  if (await handleAdminRoute(req, res, path, method, sessao)) return true;

  if (path === "/v1/me/first-password" && method === "POST") {
    const input = firstPasswordSchema.parse(await readBody(req));
    await firstPassword({ mailboxId: sessao.mailboxId, newPassword: input.newPassword });
    json(res, 200, { ok: true });
    return true;
  }

  if (path === "/v1/me" && method === "GET") {
    const [overview, isAdmin] = await Promise.all([getOverview(sessao.mailboxId), ehAdministrador(sessao.mailboxId)]);
    json(res, 200, { ...overview, isAdmin });
    return true;
  }

  if (path === "/v1/me/password" && method === "POST") {
    const input = passwordSchema.parse(await readBody(req));
    await changeOwnPassword({ mailboxId: sessao.mailboxId, ...input });
    json(res, 200, { ok: true, message: "Senha alterada. As demais sessoes foram encerradas." });
    return true;
  }

  // --- Verificacao em duas etapas ---

  if (path === "/v1/me/totp/setup" && method === "POST") {
    json(res, 200, await setupTotp(sessao.mailboxId));
    return true;
  }

  if (path === "/v1/me/totp/enable" && method === "POST") {
    const input = totpCodeSchema.parse(await readBody(req));
    json(res, 200, await enableTotp(sessao.mailboxId, input.code));
    return true;
  }

  if (path === "/v1/me/totp/disable" && method === "POST") {
    const input = totpCodeSchema.parse(await readBody(req));
    await disableTotp(sessao.mailboxId, input.code);
    json(res, 200, { ok: true });
    return true;
  }

  if (path === "/v1/me/sessions" && method === "GET") {
    json(res, 200, { sessions: await listSessions(sessao.mailboxId), current: sessao.sessionId });
    return true;
  }

  if (path === "/v1/me/sessions/revoke-all" && method === "POST") {
    json(res, 200, await logoutAll(sessao.mailboxId));
    return true;
  }

  const sessaoMatch = path.match(/^\/v1\/me\/sessions\/([\w-]+)$/);
  if (sessaoMatch && method === "DELETE") {
    json(res, 200, await revokeSession(sessao.mailboxId, sessaoMatch[1] ?? ""));
    return true;
  }

  if (path === "/v1/me/unread-count" && method === "GET") {
    json(res, 200, await unreadCounts(sessao.mailboxId));
    return true;
  }

  if (path === "/v1/me/messages/mark-all-read" && method === "POST") {
    const input = z.object({ folder: z.string().optional() }).parse(await readBody(req));
    json(res, 200, await markAllRead(sessao.mailboxId, input.folder));
    return true;
  }

  if (path === "/v1/me/folders" && method === "GET") {
    json(res, 200, { folders: await listFolders(sessao.mailboxId) });
    return true;
  }

  if (path === "/v1/me/messages" && method === "GET") {
    const limite = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    json(
      res,
      200,
      await listMessages({
        mailboxId: sessao.mailboxId,
        folder: url.searchParams.get("folder") ?? undefined,
        cursor: url.searchParams.get("cursor") ?? undefined,
        limit: Number.isFinite(limite) ? limite : undefined,
        query: url.searchParams.get("q") ?? undefined,
        unreadOnly: url.searchParams.get("unread") === "true",
        flaggedOnly: url.searchParams.get("flagged") === "true",
        attachment: parseAttachmentFilter(url.searchParams.get("attachment")),
      }),
    );
    return true;
  }

  if (path === "/v1/me/messages" && method === "PATCH") {
    const input = updateSchema.parse(await readBody(req));
    json(
      res,
      200,
      await updateMessages({
        mailboxId: sessao.mailboxId,
        messageIds: input.messageIds,
        seen: input.seen,
        flagged: input.flagged,
        moveTo: input.moveTo as SystemFolderKind | undefined,
        moveToFolderId: input.moveToFolderId,
      }),
    );
    return true;
  }

  if (path === "/v1/me/messages/delete" && method === "POST") {
    const input = deleteSchema.parse(await readBody(req));
    json(res, 200, await deleteMessages(sessao.mailboxId, input.messageIds, { permanent: input.permanent }));
    return true;
  }

  // Envio e rascunho leem com teto maior: o anexo vem em base64 no corpo.
  if (path === "/v1/me/messages/send" && method === "POST") {
    const input = composeSchema.parse(await readBody(req, MAX_COMPOSE_BODY_BYTES));
    json(res, 202, await sendMessage({ mailboxId: sessao.mailboxId, ...input }));
    return true;
  }

  if (path === "/v1/me/messages/undo-send" && method === "POST") {
    const input = undoSendSchema.parse(await readBody(req));
    json(res, 200, await undoSend(sessao.mailboxId, input.queuedId, input.rfcMessageId));
    return true;
  }

  if (path === "/v1/me/messages/snooze" && method === "POST") {
    const input = snoozeSchema.parse(await readBody(req));
    json(res, 200, await snoozeMessages(sessao.mailboxId, input.messageIds, new Date(input.until)));
    return true;
  }

  if (path === "/v1/me/drafts" && method === "POST") {
    const input = draftSchema.parse(await readBody(req, MAX_COMPOSE_BODY_BYTES));
    json(res, 200, await saveDraft({ mailboxId: sessao.mailboxId, ...input, to: input.to ?? [] }));
    return true;
  }

  // --- Preferencias e perfil ---

  if (path === "/v1/me/settings" && method === "GET") {
    json(res, 200, await getSettings(sessao.mailboxId));
    return true;
  }

  if (path === "/v1/me/settings" && method === "PUT") {
    const input = settingsSchema.parse(await readBody(req));
    json(res, 200, await updateSettings(sessao.mailboxId, input));
    return true;
  }

  if (path === "/v1/me/profile" && method === "PATCH") {
    const input = profileSchema.parse(await readBody(req));
    json(res, 200, await updateProfile(sessao.mailboxId, input));
    return true;
  }

  // --- Contatos e enderecos de envio ---

  if (path === "/v1/me/contacts" && method === "GET") {
    const limite = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
    json(res, 200, {
      contacts: await searchContacts(
        sessao.mailboxId,
        url.searchParams.get("q") ?? "",
        Number.isFinite(limite) ? limite : 20,
      ),
    });
    return true;
  }

  if (path === "/v1/me/send-as" && method === "GET") {
    json(res, 200, { addresses: await listSendAs(sessao.mailboxId) });
    return true;
  }

  // --- Anexos enviados antes da mensagem ---

  if (path === "/v1/me/attachments" && method === "POST") {
    const input = uploadSchema.parse(await readBody(req, MAX_COMPOSE_BODY_BYTES));
    json(res, 201, await storeUpload({ mailboxId: sessao.mailboxId, ...input }));
    return true;
  }

  if (path === "/v1/me/attachments" && method === "GET") {
    json(res, 200, { attachments: await listUploads(sessao.mailboxId) });
    return true;
  }

  const uploadMatch = path.match(/^\/v1\/me\/attachments\/([\w-]+)$/);
  if (uploadMatch && method === "DELETE") {
    await deleteUpload(sessao.mailboxId, uploadMatch[1] ?? "");
    json(res, 200, { ok: true });
    return true;
  }

  // --- Spam ---

  if (path === "/v1/me/messages/report-spam" && method === "POST") {
    const input = spamSchema.parse(await readBody(req));
    json(res, 200, await reportSpam(sessao.mailboxId, input.messageIds, true));
    return true;
  }

  if (path === "/v1/me/messages/not-spam" && method === "POST") {
    const input = spamSchema.parse(await readBody(req));
    json(res, 200, await reportSpam(sessao.mailboxId, input.messageIds, false));
    return true;
  }

  // --- Pastas proprias ---

  if (path === "/v1/me/folders" && method === "POST") {
    const input = folderSchema.parse(await readBody(req));
    json(res, 201, await createFolder(sessao.mailboxId, input.name));
    return true;
  }

  const pastaMatch = path.match(/^\/v1\/me\/folders\/([\w-]+)$/);
  if (pastaMatch && method === "PATCH") {
    const input = folderSchema.parse(await readBody(req));
    json(res, 200, await renameFolder(sessao.mailboxId, pastaMatch[1] ?? "", input.name));
    return true;
  }
  if (pastaMatch && method === "DELETE") {
    json(res, 200, await deleteFolder(sessao.mailboxId, pastaMatch[1] ?? ""));
    return true;
  }

  // --- Regras de triagem ---

  if (path === "/v1/me/rules" && method === "GET") {
    json(res, 200, { rules: await listRules(sessao.mailboxId) });
    return true;
  }

  if (path === "/v1/me/rules" && method === "POST") {
    const input = ruleSchema.parse(await readBody(req));
    json(res, 201, await createRule(sessao.mailboxId, input));
    return true;
  }

  const regraMatch = path.match(/^\/v1\/me\/rules\/([\w-]+)$/);
  if (regraMatch && method === "PUT") {
    const input = ruleSchema.parse(await readBody(req));
    json(res, 200, await updateRule(sessao.mailboxId, regraMatch[1] ?? "", input));
    return true;
  }
  if (regraMatch && method === "DELETE") {
    json(res, 200, await deleteRule(sessao.mailboxId, regraMatch[1] ?? ""));
    return true;
  }

  // --- Aviso de mensagem nova ---

  if (path === "/v1/me/events" && method === "GET") {
    await streamEvents(req, res, sessao.mailboxId);
    return true;
  }

  if (path === "/v1/me/send-quota" && method === "GET") {
    const caixa = await prisma.mailbox.findUniqueOrThrow({
      where: { id: sessao.mailboxId },
      select: { sendLimitPerHour: true },
    });
    json(res, 200, {
      limitPerHour: caixa.sendLimitPerHour,
      remainingThisHour: await remainingQuota(sessao.mailboxId, caixa.sendLimitPerHour),
    });
    return true;
  }

  /**
   * Migracao da caixa antiga.
   *
   * A senha do provedor anterior entra por aqui e nunca volta: nao aparece em
   * nenhuma resposta, nao entra em log e sai do banco quando a copia termina.
   */
  if (path === "/v1/me/migracao" && method === "GET") {
    json(res, 200, { migracao: await verMigracao(sessao.mailboxId) });
    return true;
  }

  if (path === "/v1/me/migracao/testar" && method === "POST") {
    const input = migracaoSchema.parse(await readBody(req));
    json(res, 200, await testarConexao({ ...input, port: input.port ?? 993 }));
    return true;
  }

  if (path === "/v1/me/migracao" && method === "POST") {
    const input = migracaoSchema.parse(await readBody(req));
    json(res, 202, await agendarMigracao({ mailboxId: sessao.mailboxId, ...input }));
    return true;
  }

  const migracaoMatch = path.match(/^\/v1\/me\/migracao\/([\w-]+)$/);
  if (migracaoMatch && method === "DELETE") {
    await cancelarMigracao(sessao.mailboxId, migracaoMatch[1] ?? "");
    json(res, 200, { ok: true });
    return true;
  }

  if (path === "/v1/me/trash/empty" && method === "POST") {
    json(res, 200, await emptyTrash(sessao.mailboxId));
    return true;
  }

  const anexoMatch = path.match(/^\/v1\/me\/messages\/([\w-]+)\/attachments\/([\w-]+)$/);
  if (anexoMatch && method === "GET") {
    const [, messageId, attachmentId] = anexoMatch;
    binary(res, await getAttachment(sessao.mailboxId, messageId ?? "", attachmentId ?? ""));
    return true;
  }

  const rawMatch = path.match(/^\/v1\/me\/messages\/([\w-]+)\/raw$/);
  if (rawMatch && method === "GET") {
    const original = await getRawMessage(sessao.mailboxId, rawMatch[1] ?? "");
    binary(res, { ...original, contentType: "message/rfc822" });
    return true;
  }

  const mensagemMatch = path.match(/^\/v1\/me\/messages\/([\w-]+)$/);
  if (mensagemMatch && method === "GET") {
    json(
      res,
      200,
      await getMessage(sessao.mailboxId, mensagemMatch[1] ?? "", {
        showRemoteImages: url.searchParams.get("images") === "true",
        markAsRead: url.searchParams.get("markRead") !== "false",
      }),
    );
    return true;
  }

  const threadMatch = path.match(/^\/v1\/me\/threads\/([\w-]+)$/);
  if (threadMatch && method === "GET") {
    json(res, 200, await getThread(sessao.mailboxId, threadMatch[1] ?? ""));
    return true;
  }

  fail(res, 404, `Rota nao encontrada: ${method} ${path}`);
  return true;
}
