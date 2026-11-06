import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { identidadeOidc } from "../services/ssoContract.js";
import { prisma } from "../lib/db.js";
import { json, readBody } from "./http.js";
import { listFolders, listMessages, getMessage, getAttachment, updateMessages, deleteMessages, emptyTrash } from "../services/messages.js";
import { createFolder, renameFolder, deleteFolder } from "../services/folders.js";
import { sendMessage, saveDraft } from "../services/compose.js";
import { searchContacts, listSendAs } from "../services/contacts.js";
import { listarJanela, obterEvento, criarEvento, atualizarEvento, excluirEvento, buscarEventos } from "../services/calendar.js";
import { listarAgendas, criarAgenda, atualizarAgenda, excluirAgenda } from "../services/calendars.js";
import { responderConvite } from "../services/calendar-invites.js";

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MAX_MCP_BODY_BYTES = 2 * 1024 * 1024;

type JsonRpcRequest = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
type Context = { mailboxId: string; address: string; subject: string };

const empty = z.object({}).strict();
const mailboxArg = z.object({ address: z.string().email().optional() }).strict();
const listMessagesArgs = mailboxArg.extend({ folder: z.string().max(80).optional(), query: z.string().max(500).optional(), limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(1000).optional(), unreadOnly: z.boolean().optional(), flaggedOnly: z.boolean().optional(), attachment: z.string().max(200).optional() }).strict();
const idsArgs = mailboxArg.extend({ messageIds: z.array(z.string().min(1).max(100)).min(1).max(200) }).strict();
const messageArgs = mailboxArg.extend({ messageId: z.string().min(1).max(100), markRead: z.boolean().optional() }).strict();
const attachmentArgs = messageArgs.extend({ attachmentId: z.string().min(1).max(100) }).strict();
const sendArgs = mailboxArg.extend({ to: z.array(z.string().email()).min(1).max(50), cc: z.array(z.string().email()).max(50).optional(), bcc: z.array(z.string().email()).max(50).optional(), subject: z.string().max(998).optional(), text: z.string().max(1_000_000).optional(), html: z.string().max(2_000_000).optional(), fromAddress: z.string().email().optional(), appendSignature: z.boolean().optional(), idempotencyKey: z.string().min(8).max(200), attachments: z.array(z.object({ filename: z.string().min(1).max(255), contentType: z.string().max(200).optional(), contentBase64: z.string().max(10_000_000) })).max(20).optional() }).strict();
const draftArgs = sendArgs.extend({ draftId: z.string().min(1).max(100).optional() }).strict();
const folderArgs = mailboxArg.extend({ name: z.string().trim().min(1).max(60) }).strict();
const folderIdArgs = mailboxArg.extend({ folderId: z.string().min(1).max(100) }).strict();
const contactsArgs = mailboxArg.extend({ query: z.string().trim().min(1).max(200) }).strict();
const calendarWindowArgs = mailboxArg.extend({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }).strict();
const calendarSearchArgs = mailboxArg.extend({ query: z.string().trim().min(1).max(500) }).strict();
const eventIdArgs = mailboxArg.extend({ eventId: z.string().min(1).max(100) }).strict();
const createEventArgs = mailboxArg.extend({ event: z.record(z.string(), z.unknown()), notifyGuests: z.boolean().optional() }).strict();
const updateEventArgs = eventIdArgs.extend({ etag: z.string().min(1).max(500), changes: z.record(z.string(), z.unknown()), scope: z.enum(["this", "following", "all"]).optional(), recurrenceId: z.string().datetime({ offset: true }).optional(), notifyGuests: z.boolean().optional() }).strict();
const deleteEventArgs = eventIdArgs.extend({ etag: z.string().min(1).max(500), scope: z.enum(["this", "following", "all"]).optional(), recurrenceId: z.string().datetime({ offset: true }).optional(), notifyGuests: z.boolean().optional() }).strict();
const inviteArgs = mailboxArg.extend({ eventId: z.string().min(1).max(100), response: z.enum(["aceito", "recusado", "talvez", "pendente"]), comment: z.string().max(5000).optional() }).strict();
const calendarArgs = mailboxArg.extend({ calendarId: z.string().min(1).max(100).optional(), name: z.string().trim().min(1).max(120).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).strict();

const tools = [
  ["list_folders", "Lista as pastas da caixa de e-mail.", mailboxArg],
  ["list_messages", "Lista mensagens com paginação e filtros.", listMessagesArgs],
  ["search_messages", "Busca mensagens por assunto, remetente, corpo ou anexo.", listMessagesArgs.extend({ query: z.string().trim().min(1).max(500) })],
  ["get_message", "Lê uma mensagem da própria caixa.", messageArgs],
  ["get_attachment", "Baixa um anexo da própria caixa em base64.", attachmentArgs],
  ["update_messages", "Marca mensagens como lidas, sinalizadas ou move-as.", idsArgs.extend({ seen: z.boolean().optional(), flagged: z.boolean().optional(), moveTo: z.enum(["inbox", "sent", "drafts", "spam", "trash", "archive"]).optional(), moveToFolderId: z.string().optional() })],
  ["delete_messages", "Move mensagens para a lixeira ou remove-as permanentemente.", idsArgs.extend({ permanent: z.boolean().optional() })],
  ["empty_trash", "Esvazia a lixeira da caixa.", mailboxArg],
  ["create_folder", "Cria uma pasta própria.", folderArgs],
  ["rename_folder", "Renomeia uma pasta própria.", folderIdArgs.extend({ name: z.string().trim().min(1).max(60) })],
  ["delete_folder", "Remove uma pasta própria.", folderIdArgs],
  ["send_message", "Envia uma mensagem usando a cota da caixa.", sendArgs],
  ["save_draft", "Salva ou atualiza um rascunho.", draftArgs],
  ["search_contacts", "Busca contatos e endereços autorizados.", contactsArgs],
  ["list_send_as", "Lista endereços que a caixa pode usar como remetente.", mailboxArg],
  ["list_calendars", "Lista as agendas da caixa.", mailboxArg],
  ["create_calendar", "Cria uma agenda da caixa.", calendarArgs.extend({ name: z.string().trim().min(1).max(120), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) })],
  ["update_calendar", "Atualiza uma agenda da caixa.", calendarArgs.extend({ calendarId: z.string().min(1).max(100), name: z.string().trim().min(1).max(120).optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() })],
  ["delete_calendar", "Exclui uma agenda da caixa.", calendarArgs.extend({ calendarId: z.string().min(1).max(100) })],
  ["list_events", "Lista ocorrências em uma janela de calendário.", calendarWindowArgs],
  ["search_events", "Busca eventos da agenda.", calendarSearchArgs],
  ["get_event", "Lê um evento da agenda.", eventIdArgs],
  ["create_event", "Cria um evento na agenda.", createEventArgs],
  ["update_event", "Atualiza um evento com controle de concorrência.", updateEventArgs],
  ["delete_event", "Exclui um evento com controle de concorrência.", deleteEventArgs],
  ["reply_to_invite", "Responde a um convite da agenda.", inviteArgs],
] as const;

function authHeader(req: IncomingMessage): string {
  const value = req.headers.authorization;
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function authenticate(req: IncomingMessage, args: { address?: string }): Promise<Context> {
  const header = authHeader(req);
  if (!header.startsWith("Bearer ")) throw new McpError("unauthorized", "Bearer OAuth ausente", 401);
  const identidade = await authorizeMcp(header.slice(7).trim());
  const email = identidade.email.toLowerCase();
  const caixas = await prisma.mailbox.findMany({
    where: { status: "active", OR: [{ ownerEmail: email }, { localPart: email.split("@")[0] ?? "", domain: { name: email.split("@")[1] ?? "" } }] },
    select: { id: true, localPart: true, domain: { select: { name: true } } }, orderBy: { createdAt: "asc" },
  });
  const requested = args.address?.trim().toLowerCase();
  const selected = requested ? caixas.find((c) => `${c.localPart}@${c.domain.name}`.toLowerCase() === requested) : caixas.length === 1 ? caixas[0] : undefined;
  if (!selected) throw new McpError(caixas.length > 1 ? "mailbox_required" : "forbidden", caixas.length > 1 ? "Informe address porque sua conta possui mais de uma caixa." : "Sua conta não possui uma caixa de e-mail ativa.", caixas.length > 1 ? 400 : 403);
  return { mailboxId: selected.id, address: `${selected.localPart}@${selected.domain.name}`, subject: identidade.subject };
}

async function authorizeMcp(token: string) {
  if (!token) throw new McpError("unauthorized", "Bearer OAuth ausente", 401);
  const identidade = await identidadeOidc(token);
  if (!identidade.apps?.includes("mail")) throw new McpError("forbidden", "O token OAuth não está autorizado para o aplicativo Mail.", 403);
  return identidade;
}

export class McpError extends Error { constructor(readonly code: string, message: string, readonly status = 400) { super(message); } }
function result(id: unknown, value: unknown) { return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(value) }] } }; }
function error(id: unknown, code: string, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }
function toolList() { return tools.map(([name, description, schema]) => ({ name, description, inputSchema: { type: "object", additionalProperties: false, properties: Object.fromEntries(Object.keys(schema.shape).map((key) => [key, { type: "string" }])), } })); }

async function callTool(name: string, raw: unknown, ctx: Context): Promise<unknown> {
  const spec = tools.find(([tool]) => tool === name);
  if (!spec) throw new McpError("unknown_tool", `Ferramenta desconhecida: ${name}`, 404);
  const input = spec[2].parse(raw) as Record<string, unknown>;
  const id = ctx.mailboxId;
  switch (name) {
    case "list_folders": return listFolders(id);
    case "list_messages": return listMessages({ mailboxId: id, ...input } as never);
    case "search_messages": return listMessages({ mailboxId: id, ...input } as never);
    case "get_message": return getMessage(id, String(input.messageId), { markAsRead: input.markRead !== false });
    case "get_attachment": { const a = await getAttachment(id, String(input.messageId), String(input.attachmentId)); return { ...a, content: a.content.toString("base64") }; }
    case "update_messages": return updateMessages({ mailboxId: id, ...input } as never);
    case "delete_messages": return deleteMessages(id, input.messageIds as string[], { permanent: input.permanent === true });
    case "empty_trash": return emptyTrash(id);
    case "create_folder": return createFolder(id, String(input.name));
    case "rename_folder": return renameFolder(id, String(input.folderId), String(input.name));
    case "delete_folder": return deleteFolder(id, String(input.folderId));
    case "send_message": return sendMessage({ mailboxId: id, ...input } as never);
    case "save_draft": return saveDraft({ mailboxId: id, ...input } as never);
    case "search_contacts": return searchContacts(id, String(input.query));
    case "list_send_as": return listSendAs(id);
    case "list_calendars": return listarAgendas(id);
    case "create_calendar": return criarAgenda(id, { name: input.name, color: input.color });
    case "update_calendar": return atualizarAgenda(id, String(input.calendarId), { name: input.name, color: input.color });
    case "delete_calendar": return excluirAgenda(id, String(input.calendarId));
    case "list_events": return listarJanela(id, new Date(String(input.from)), new Date(String(input.to)));
    case "search_events": return buscarEventos(id, String(input.query));
    case "get_event": return obterEvento(id, String(input.eventId));
    case "create_event": return criarEvento(id, input.event, { notificarConvidados: input.notifyGuests === true });
    case "update_event": return atualizarEvento(id, String(input.eventId), input.changes, String(input.etag), { scope: input.scope as never, recurrenceId: input.recurrenceId as string | undefined, notificarConvidados: input.notifyGuests === true });
    case "delete_event": return excluirEvento(id, String(input.eventId), String(input.etag), { scope: input.scope as never, recurrenceId: input.recurrenceId as string | undefined, notificarConvidados: input.notifyGuests === true });
    case "reply_to_invite": return responderConvite(id, String(input.eventId), input.response as never, input.comment as string | undefined);
    default: throw new McpError("unknown_tool", `Ferramenta desconhecida: ${name}`, 404);
  }
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  if (path === "/.well-known/oauth-protected-resource" && req.method === "GET") {
    json(res, 200, { resource: "https://mail.avilaops.com/mcp", authorization_servers: ["https://auth.avilaops.com"], scopes_supported: ["openid", "profile", "email", "offline_access"] });
    return true;
  }
  if (path !== "/mcp") return false;
  if (req.method === "GET") { res.writeHead(405, { Allow: "POST" }); res.end(); return true; }
  if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); res.end(); return true; }
  let rpcId: unknown = null;
  try {
    const body = await readBody(req, MAX_MCP_BODY_BYTES) as JsonRpcRequest;
    rpcId = body.id ?? null;
    if (body.jsonrpc !== "2.0" || typeof body.method !== "string") throw new McpError("invalid_request", "Requisição JSON-RPC inválida.", 400);
    if (body.method === "initialize") { const header = authHeader(req); if (!header.startsWith("Bearer ")) throw new McpError("unauthorized", "Bearer OAuth ausente", 401); await authorizeMcp(header.slice(7).trim()); json(res, 200, result(body.id, { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "avila-mail", version: "0.1.0" } })); return true; }
    if (body.method === "notifications/initialized") { res.writeHead(202); res.end(); return true; }
    if (body.method === "tools/list") { const header = authHeader(req); if (!header.startsWith("Bearer ")) throw new McpError("unauthorized", "Bearer OAuth ausente", 401); await authorizeMcp(header.slice(7).trim()); json(res, 200, result(body.id, { tools: toolList() })); return true; }
    if (body.method !== "tools/call") throw new McpError("method_not_found", `Método não suportado: ${body.method}`, 404);
    const params = z.object({ name: z.string().min(1).max(100), arguments: z.record(z.string(), z.unknown()).default({}) }).parse(body.params);
    const ctx = await authenticate(req, params.arguments);
    json(res, 200, result(body.id, await callTool(params.name, params.arguments, ctx))); return true;
  } catch (e) {
    const id = rpcId;
    if (e instanceof McpError) { if (e.status === 401) res.setHeader("WWW-Authenticate", 'Bearer resource_metadata="https://mail.avilaops.com/.well-known/oauth-protected-resource"'); json(res, e.status, error(id, e.code, e.message)); return true; }
    if (e instanceof z.ZodError) { json(res, 400, error(id, "invalid_params", e.issues[0]?.message ?? "Parâmetros inválidos.")); return true; }
    json(res, 500, error(id, "internal_error", "Falha interna ao executar a ferramenta.")); return true;
  }
}

