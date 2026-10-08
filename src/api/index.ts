import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { SignupError, conferirDns, instrucoesDeDns } from "../services/publicSignup.js";
import { estadoDoPedido, iniciarCheckout } from "../services/signupCheckout.js";
import { z } from "zod";
import { assertConfig, config } from "../lib/config.js";
import { createLogger } from "../lib/logger.js";
import { disconnect, prisma } from "../lib/db.js";
import { safeCompare } from "../lib/password.js";
import { HttpError, bearerToken, fail, json, readBody, clientIp } from "./http.js";
import { handleUserRoute } from "./me-routes.js";
import { AuthError } from "../services/session.js";
import { MessageError } from "../services/messages.js";
import { MigracaoError } from "../services/migracao.js";
import { ComposeError } from "../services/compose.js";
import { FolderError } from "../services/folders.js";
import { RuleError } from "../services/rules.js";
import { ApiKeyError, autenticarChave, escopoDoToken } from "../services/apiKeys.js";
import { MercadoPagoError, assinaturaValida } from "../lib/mercadopago.js";
import { orcamentoDeHoje } from "../mta/warmup.js";
import { handleDav } from "../dav/server.js";
import {
  BillingError,
  cancelarAssinatura,
  garantirConta,
  iniciarAssinatura,
  processarNotificacao,
  resumoConta,
  sincronizarValor,
  visaoGeral,
} from "../services/billing.js";
import {
  ProvisioningError,
  billableMailboxes,
  createAlias,
  createDomain,
  createMailbox,
  deleteAlias,
  deleteMailbox,
  dnsRecordsFor,
  getCatchAll,
  listAliases,
  listMailboxes,
  setCatchAll,
  setMailboxPassword,
  setMailboxQuota,
  setMailboxOwner,
  setMailboxStatus,
  verifyDomainDns,
} from "../services/provisioning.js";

const log = createLogger("api");

/**
 * API de provisionamento.
 *
 * As rotas seguem exatamente o contrato que o portal do cliente ja fala em
 * src/lib/emailProvider.ts (POST /domains, /mailboxes, /mailboxes/suspend, ...).
 * Ou seja: o portal sai do modo mock apontando EMAIL_PROVIDER_API_URL para ca,
 * sem alterar uma linha de codigo do portal.
 *
 * Escuta so em loopback. Quem precisa falar com ela ou roda no mesmo host ou
 * entra por tunel/Caddy autenticado — nunca exposta na internet.
 */

/**
 * Provisionamento aceita dois portadores: o token estatico do .env (bootstrap
 * e contingencia) e qualquer chave `amk_p_` criada na area de desenvolvedor
 * por uma caixa administradora — e a que o n8n usa, e a que o dono revoga.
 */
async function authorized(req: IncomingMessage): Promise<boolean> {
  const token = bearerToken(req);
  if (token.length === 0) return false;
  if (safeCompare(token, config.api.token)) return true;
  if (escopoDoToken(token) !== "provisioning") return false;
  const chave = await autenticarChave(token);
  return chave !== null && chave.scope === "provisioning";
}

const signupSchema = z.object({ domain: z.string().min(4).max(253) });

const checkoutSchema = z.object({
  domain: z.string().min(4).max(253),
  payerEmail: z.string().min(5).max(200),
  payerName: z.string().max(160).optional(),
  localPart: z.string().min(1).max(32),
  mailboxCount: z.number().int().min(1).max(50).optional(),
});

const domainSchema = z.object({
  domain: z.string().min(3),
  clientRef: z.string().optional(),
});

const mailboxSchema = z.object({
  domain: z.string().min(3),
  username: z.string().min(1),
  password: z.string().min(12),
  quota_gb: z.number().int().positive().max(200).optional(),
  display_name: z.string().max(120).optional(),
  /** Contato do cliente que recebe o aviso de caixa pronta (sem a senha). */
  notify_to: z.string().email().optional(),
  /** Dono no SSO: e-mail da conta Avila Ops que abre a caixa sem senha. */
  owner_email: z.string().email().optional(),
  /** Forcar troca no primeiro acesso (padrao true). */
  must_change_password: z.boolean().optional(),
});

const ownerSchema = z.object({
  domain: z.string().min(3),
  username: z.string().min(1),
  owner_email: z.string().email().nullable(),
});

const mailboxRefSchema = z.object({
  domain: z.string().min(3),
  username: z.string().min(1),
});

const passwordSchema = mailboxRefSchema.extend({ password: z.string().min(12) });
const quotaSchema = mailboxRefSchema.extend({ quota_gb: z.number().int().positive().max(200) });

const aliasSchema = z.object({
  domain: z.string().min(3),
  alias: z.string().min(1),
  destination: z.string().min(5),
});

const aliasRefSchema = z.object({
  domain: z.string().min(3),
  alias: z.string().min(1),
});

/** username nulo desliga o catch-all. */
const catchAllSchema = z.object({
  username: z.string().min(1).nullable(),
});

const contaSchema = z.object({
  client_ref: z.string().min(1).max(80),
  payer_email: z.string().min(5).max(200),
  payer_name: z.string().max(160).optional(),
});

/**
 * CORS do autoatendimento.
 *
 * A tela publica mora no app.avilaops.com e fala com esta API direto do
 * navegador. Sem isto o navegador nem chega a mandar o POST: ele manda um
 * OPTIONS antes, o gate de token responde 401, e a tela quebra sem dizer por
 * que. O curl nao faz preflight, entao escondia o problema.
 *
 * So os nossos enderecos entram na lista. Nao e defesa contra abuso — quem
 * chama de fora do navegador ignora CORS, e para isso existe o limite de
 * tentativas — e sim para outro site nao embutir o nosso formulario.
 */
const ORIGENS_DO_AUTOATENDIMENTO = new Set(["https://app.avilaops.com", "https://avilaops.com", "https://www.avilaops.com"]);

function liberarOrigem(req: IncomingMessage, res: ServerResponse, path: string): void {
  if (!path.startsWith("/v1/public/")) return;
  const bruto = req.headers.origin;
  const origem = Array.isArray(bruto) ? bruto[0] : bruto;
  if (!origem || !ORIGENS_DO_AUTOATENDIMENTO.has(origem)) return;
  res.setHeader("Access-Control-Allow-Origin", origem);
  res.setHeader("Vary", "Origin");
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${config.api.bind}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";

  liberarOrigem(req, res, path);

  // O navegador pergunta antes de postar. Responder aqui, antes de qualquer
  // checagem de token, e o que permite a tela publica existir.
  if (method === "OPTIONS" && path.startsWith("/v1/public/")) {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Max-Age", "86400");
    res.writeHead(204);
    res.end();
    return;
  }

  // CardDAV/CalDAV — autentica por Basic (senha da caixa), nao pelos tokens.
  if (await handleDav(req, res, path)) return;

  if (path === "/v1/health" && method === "GET") {
    await prisma.$queryRaw`SELECT 1`;
    return json(res, 200, { status: "ok", hostname: config.hostname, relayDriver: config.relay.driver });
  }

  /**
   * Webhook do Mercado Pago.
   *
   * Publico de proposito — quem chama e o MP, que nao tem como carregar nosso
   * token. A autenticidade e provada pela assinatura HMAC no header
   * `x-signature`. Sem essa checagem, qualquer um postaria "pagamento
   * aprovado" para reativar uma caixa suspensa, ou "assinatura cancelada"
   * para derrubar a caixa de um cliente em dia.
   */
  if (path === "/v1/webhooks/mercadopago" && method === "POST") {
    const corpo = (await readBody(req)) as {
      type?: string;
      topic?: string;
      action?: string;
      data?: { id?: string | number };
    };

    // O MP manda o id tanto na query quanto no corpo; o manifesto assinado usa
    // o da query quando ela existe.
    const dataId = url.searchParams.get("data.id") ?? url.searchParams.get("id") ?? String(corpo?.data?.id ?? "");
    const topic = url.searchParams.get("type") ?? url.searchParams.get("topic") ?? corpo?.type ?? corpo?.topic ?? "";

    const assinatura = req.headers["x-signature"];
    const requisicao = req.headers["x-request-id"];

    const valida = assinaturaValida({
      xSignature: Array.isArray(assinatura) ? (assinatura[0] ?? "") : (assinatura ?? ""),
      xRequestId: Array.isArray(requisicao) ? (requisicao[0] ?? "") : (requisicao ?? ""),
      dataId,
    });

    if (!valida) {
      log.warn("notificacao do Mercado Pago com assinatura invalida", { topic, dataId });
      return fail(res, 401, "Assinatura invalida.");
    }

    if (!dataId || !topic) return json(res, 200, { ignorada: true, motivo: "sem topico ou id" });

    const resultado = await processarNotificacao({ topic, action: corpo?.action, dataId, payload: corpo });

    // 200 sempre que conseguimos processar: o MP reenvia por dias qualquer
    // notificacao que nao receba 200, e a idempotencia ja cobre repeticao.
    return json(res, 200, resultado);
  }
  // --- Autoatendimento (publico, sem token) ---
  //
  // Ficam antes da checagem de token de proposito: sao a porta de quem ainda
  // nao e cliente. Nao criam dominio, nao criam caixa e nao cobram — so
  // informam os registros de DNS e conferem se ja estao no ar. O limite de
  // tentativas mora no proprio servico.
  if (path === "/v1/public/signup/dns" && method === "POST") {
    const input = signupSchema.parse(await readBody(req));
    return json(res, 200, await instrucoesDeDns(input.domain, clientIp(req)));
  }

  if (path === "/v1/public/signup/verify" && method === "POST") {
    const input = signupSchema.parse(await readBody(req));
    return json(res, 200, await conferirDns(input.domain, clientIp(req)));
  }

  /**
   * Fecha a compra: cria a assinatura no Mercado Pago e devolve o link de
   * pagamento. NAO cria dominio nem caixa — isso acontece no webhook, depois
   * do pagamento confirmado. A ordem inversa daria caixa de graca a qualquer
   * um que chamasse esta rota.
   */
  if (path === "/v1/public/signup/checkout" && method === "POST") {
    const input = checkoutSchema.parse(await readBody(req));
    return json(
      res,
      200,
      await iniciarCheckout({
        domain: input.domain,
        payerEmail: input.payerEmail,
        payerName: input.payerName,
        localPart: input.localPart,
        mailboxCount: input.mailboxCount ?? 1,
        ip: clientIp(req),
      }),
    );
  }

  /** Estado do pedido, para a tela que espera a confirmacao do pagamento. */
  if (path.startsWith("/v1/public/signup/pedido/") && method === "GET") {
    const token = path.slice("/v1/public/signup/pedido/".length);
    return json(res, 200, await estadoDoPedido(token));
  }


  // Rotas do dono da caixa: autenticam por JWT de sessao, nao pelo token de
  // provisionamento. Precisam vir antes da checagem abaixo.
  if (await handleUserRoute(req, res, path, method, url)) return;

  if (!(await authorized(req))) return fail(res, 401, "Token de autorizacao ausente ou invalido.");

  // --- Dominios ---

  if (path === "/v1/domains" && method === "POST") {
    const input = domainSchema.parse(await readBody(req));
    const result = await createDomain(input);
    // dns_records em snake_case: e o nome que o emailProvider.ts do portal le.
    return json(res, result.created ? 201 : 200, {
      id: result.id,
      domain: result.domain,
      dns_records: result.dnsRecords,
      our_zone_record: "ourZoneRecord" in result ? result.ourZoneRecord : undefined,
      // "publicado" | "ja_existia" = o DKIM ja esta de pe; "manual" = alguem
      // precisa publicar o our_zone_record na zona da Avila Ops antes que o
      // dominio consiga assinar.
      our_zone_published: "ourZonePublished" in result ? result.ourZonePublished : undefined,
    });
  }

  const domainMatch = path.match(/^\/v1\/domains\/([^/]+)(\/verify|\/mailboxes|\/dns|\/aliases|\/catch-all)?$/);
  if (domainMatch) {
    const domainName = decodeURIComponent(domainMatch[1] ?? "");
    const suffix = domainMatch[2] ?? "";

    if (suffix === "/verify" && method === "POST") {
      return json(res, 200, await verifyDomainDns(domainName));
    }

    if (suffix === "/mailboxes" && method === "GET") {
      return json(res, 200, { mailboxes: await listMailboxes(domainName) });
    }

    if (suffix === "/aliases" && method === "GET") {
      const [aliases, catchAll] = await Promise.all([listAliases(domainName), getCatchAll(domainName)]);
      return json(res, 200, { aliases, catch_all: catchAll });
    }

    if (suffix === "/catch-all" && method === "POST") {
      const input = catchAllSchema.parse(await readBody(req));
      return json(res, 200, await setCatchAll(domainName, input.username));
    }

    if (suffix === "/dns" && method === "GET") {
      const domain = await prisma.mailDomain.findUnique({
        where: { name: domainName.toLowerCase() },
        select: { dkimSelector: true, dnsCheck: true, dnsCheckedAt: true, status: true },
      });
      if (!domain) return fail(res, 404, `Dominio nao provisionado: ${domainName}`);
      return json(res, 200, {
        domain: domainName,
        status: domain.status,
        dns_records: dnsRecordsFor(domainName.toLowerCase(), domain.dkimSelector),
        last_check: domain.dnsCheck,
        checked_at: domain.dnsCheckedAt,
      });
    }
  }

  // --- Caixas ---

  if (path === "/v1/mailboxes" && method === "POST") {
    const input = mailboxSchema.parse(await readBody(req));
    const result = await createMailbox({
      domain: input.domain,
      username: input.username,
      password: input.password,
      quotaGb: input.quota_gb,
      displayName: input.display_name,
      notifyTo: input.notify_to,
      ownerEmail: input.owner_email,
      mustChangePassword: input.must_change_password,
    });
    return json(res, 201, result);
  }

  if (path === "/v1/mailboxes/suspend" && method === "POST") {
    const input = mailboxRefSchema.parse(await readBody(req));
    return json(res, 200, await setMailboxStatus(input.domain, input.username, "suspended"));
  }

  if (path === "/v1/mailboxes/reactivate" && method === "POST") {
    const input = mailboxRefSchema.parse(await readBody(req));
    return json(res, 200, await setMailboxStatus(input.domain, input.username, "active"));
  }

  if (path === "/v1/mailboxes/password" && method === "POST") {
    const input = passwordSchema.parse(await readBody(req));
    return json(res, 200, await setMailboxPassword(input.domain, input.username, input.password));
  }

  if (path === "/v1/mailboxes/owner" && method === "POST") {
    const input = ownerSchema.parse(await readBody(req));
    return json(res, 200, await setMailboxOwner(input.domain, input.username, input.owner_email));
  }

  if (path === "/v1/mailboxes/quota" && method === "POST") {
    const input = quotaSchema.parse(await readBody(req));
    return json(res, 200, await setMailboxQuota(input.domain, input.username, input.quota_gb));
  }

  if (path === "/v1/mailboxes/delete" && method === "POST") {
    const input = mailboxRefSchema.parse(await readBody(req));
    return json(res, 200, await deleteMailbox(input.domain, input.username));
  }

  // --- Aliases ---

  if (path === "/v1/aliases" && method === "POST") {
    const input = aliasSchema.parse(await readBody(req));
    const result = await createAlias(input);
    return json(res, result.created ? 201 : 200, result);
  }

  if (path === "/v1/aliases/delete" && method === "POST") {
    const input = aliasRefSchema.parse(await readBody(req));
    return json(res, 200, await deleteAlias(input.domain, input.alias));
  }

  // --- Cobranca recorrente ---

  if (path === "/v1/billing/accounts" && method === "POST") {
    const input = contaSchema.parse(await readBody(req));
    const conta = await garantirConta({
      clientRef: input.client_ref,
      payerEmail: input.payer_email,
      payerName: input.payer_name,
    });
    return json(res, 200, { clientRef: conta.clientRef, status: conta.status });
  }

  if (path === "/v1/billing/overview" && method === "GET") {
    return json(res, 200, await visaoGeral());
  }

  const contaMatch = path.match(/^\/v1\/billing\/accounts\/([\w-]+)(\/subscribe|\/sync|\/cancel)?$/);
  if (contaMatch) {
    const clientRef = contaMatch[1] ?? "";
    const acao = contaMatch[2] ?? "";

    if (!acao && method === "GET") return json(res, 200, await resumoConta(clientRef));
    if (acao === "/subscribe" && method === "POST") return json(res, 201, await iniciarAssinatura(clientRef));
    if (acao === "/sync" && method === "POST") return json(res, 200, await sincronizarValor(clientRef));
    if (acao === "/cancel" && method === "POST") return json(res, 200, await cancelarAssinatura(clientRef));
  }

  // --- Operacao e faturamento (consumido pelos workflows do n8n) ---

  if (path === "/v1/billing/mailboxes" && method === "GET") {
    const mailboxes = await billableMailboxes();
    return json(res, 200, {
      unit_price_brl: 10,
      count: mailboxes.length,
      total_brl: mailboxes.length * 10,
      mailboxes,
    });
  }

  if (path === "/v1/ops/status" && method === "GET") {
    const [queued, deferred, failed, domainsPending, quotaAlerts, warmup] = await Promise.all([
      prisma.outboundMessage.count({ where: { status: "queued" } }),
      prisma.outboundMessage.count({ where: { status: "deferred" } }),
      prisma.outboundMessage.count({ where: { status: "failed", createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
      prisma.mailDomain.count({ where: { status: "pending_dns" } }),
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM mail_mailboxes WHERE used_bytes > quota_bytes * 0.9
      `,
      orcamentoDeHoje(),
    ]);

    return json(res, 200, {
      queue: { queued, deferred, failed24h: failed },
      domainsPendingDns: domainsPending,
      mailboxesNearQuota: Number(quotaAlerts[0]?.count ?? 0),
      relayDriver: config.relay.driver,
      // Null quando o aquecimento esta desligado ou a rampa ja terminou.
      warmup,
    });
  }

  if (path === "/v1/ops/domains-pending" && method === "GET") {
    const domains = await prisma.mailDomain.findMany({
      where: { status: "pending_dns" },
      select: { name: true, createdAt: true, dnsCheckedAt: true, clientRef: true },
      orderBy: { createdAt: "asc" },
    });
    return json(res, 200, { domains });
  }

  return fail(res, 404, `Rota nao encontrada: ${method} ${path}`);
}

function start(): void {
  assertConfig("api");

  const server = createServer((req, res) => {
    const started = Date.now();

    route(req, res)
      .catch((error) => {
        if (
          error instanceof ProvisioningError ||
          error instanceof AuthError ||
          error instanceof MessageError ||
          error instanceof MigracaoError ||
          error instanceof ComposeError ||
          error instanceof FolderError ||
          error instanceof RuleError ||
          error instanceof ApiKeyError ||
          error instanceof BillingError ||
          error instanceof SignupError ||
          error instanceof HttpError
        ) {
          return fail(res, error.statusCode, error.message);
        }
        /**
         * Falha do Mercado Pago vira 502, nao 500.
         *
         * O detalhe fica so no log: "Unauthorized access to resource" e
         * problema de configuracao NOSSA, e mostrar isso ao cliente nao ajuda
         * ele em nada — pior, expoe como a integracao funciona.
         */
        if (error instanceof MercadoPagoError) {
          log.error("Mercado Pago recusou a operacao", {
            path: req.url,
            status: error.statusCode,
            detalhe: error.message,
          });
          return fail(
            res,
            502,
            "A cobranca esta temporariamente indisponivel. Tente novamente em alguns minutos.",
          );
        }

        if (error instanceof z.ZodError) {
          const first = error.issues[0];
          return fail(res, 422, `Campo invalido: ${first?.path.join(".") ?? "?"} — ${first?.message ?? "invalido"}`);
        }
        log.error("erro nao tratado", {
          path: req.url,
          error: error instanceof Error ? error.message : String(error),
        });
        return fail(res, 500, "Erro interno ao processar a requisicao.");
      })
      .finally(() => {
        log.info("requisicao", {
          method: req.method,
          path: req.url,
          status: res.statusCode,
          durationMs: Date.now() - started,
        });
      });
  });

  server.listen(config.api.port, config.api.bind, () => {
    log.info("api de provisionamento no ar", { bind: config.api.bind, port: config.api.port });
  });

  const shutdown = async () => {
    server.close();
    await disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

start();
