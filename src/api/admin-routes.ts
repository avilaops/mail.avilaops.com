import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { descobrirDnsDoDominio } from "../lib/provedorDns.js";
import { dnsPublicavel, publicarDnsDoDominio } from "../services/publicacaoDns.js";
import { generatePassword } from "../lib/password.js";
import { orcamentoDeHoje } from "../mta/warmup.js";
import { fail, json, readBody } from "./http.js";
import { ehAdministrador } from "../services/apiKeys.js";
import { visaoGeral } from "../services/billing.js";
import {
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
  setMailboxOwner,
  setMailboxPassword,
  setMailboxQuota,
  setMailboxStatus,
  verifyDomainDns,
} from "../services/provisioning.js";
import { encaminharTudoDoDominio, getEncaminharTudo } from "../services/rules.js";

/**
 * Area administrativa do webmail (/v1/admin/*).
 *
 * Mesmas operacoes da API de provisionamento, mas autenticadas pela SESSAO de
 * uma caixa administradora (MAIL_ADMIN_ADDRESSES) em vez do token estatico —
 * e o que faz dominio, DNS, caixa, alias e catch-all existirem na tela, sem
 * curl e sem entrar no servidor. Chave de API nao entra aqui (VEDADO_A_CHAVE):
 * administrar e acao de gente logada, com 2FA se tiver.
 */

const dominioSchema = z.object({ domain: z.string().min(3).max(253) });

const caixaNovaSchema = z.object({
  domain: z.string().min(3),
  username: z.string().min(1).max(64),
  /** Vazio = gerar uma senha forte e devolver na resposta (uma vez). */
  password: z.string().min(12).max(200).optional(),
  displayName: z.string().max(120).optional(),
  quotaGb: z.number().int().positive().max(200).optional(),
  ownerEmail: z.string().email().optional(),
});

const caixaRefSchema = z.object({ domain: z.string().min(3), username: z.string().min(1) });
const senhaSchema = caixaRefSchema.extend({ password: z.string().min(12).max(200).optional() });
const quotaSchema = caixaRefSchema.extend({ quotaGb: z.number().int().positive().max(200) });
const donoSchema = caixaRefSchema.extend({ ownerEmail: z.string().email().nullable() });
const aliasSchema = z.object({ domain: z.string().min(3), alias: z.string().min(1), destination: z.string().min(5) });
const aliasRefSchema = z.object({ domain: z.string().min(3), alias: z.string().min(1) });
/** `substituirMx` so vem marcado depois de a tela avisar que o e-mail atual para de chegar. */
const publicarDnsSchema = z.object({ substituirMx: z.boolean().optional() });

const catchAllSchema = z.object({ username: z.string().min(1).nullable() });
/** destination nulo remove a regra de encaminhamento de todas as caixas. */
const encaminharTudoSchema = z.object({
  destination: z.string().min(5).max(200).nullable(),
  /** Caixas que ficam de fora (endereco inteiro ou so a parte local). */
  excluir: z.array(z.string().min(1).max(200)).max(200).optional(),
});

async function resumo() {
  const [dominios, caixas, queued, deferred, failed, pendentes, warmup, cobranca] = await Promise.all([
    prisma.mailDomain.count(),
    prisma.mailbox.count({ where: { status: "active" } }),
    prisma.outboundMessage.count({ where: { status: "queued" } }),
    prisma.outboundMessage.count({ where: { status: "deferred" } }),
    prisma.outboundMessage.count({ where: { status: "failed", createdAt: { gte: new Date(Date.now() - 86_400_000) } } }),
    prisma.mailDomain.count({ where: { status: "pending_dns" } }),
    orcamentoDeHoje(),
    visaoGeral().catch(() => null),
  ]);

  return {
    domains: dominios,
    activeMailboxes: caixas,
    domainsPendingDns: pendentes,
    queue: { queued, deferred, failed24h: failed },
    warmup,
    relayDriver: config.relay.driver,
    billing: cobranca,
  };
}

async function listarDominios() {
  const dominios = await prisma.mailDomain.findMany({
    orderBy: { name: "asc" },
    select: {
      name: true,
      status: true,
      dnsCheck: true,
      dnsCheckedAt: true,
      createdAt: true,
      _count: { select: { mailboxes: true, aliases: true } },
    },
  });
  return dominios.map((d) => ({
    domain: d.name,
    status: d.status,
    dnsCheck: d.dnsCheck,
    dnsCheckedAt: d.dnsCheckedAt,
    createdAt: d.createdAt,
    mailboxes: d._count.mailboxes,
    aliases: d._count.aliases,
  }));
}

async function detalheDominio(domainName: string) {
  const dominio = await prisma.mailDomain.findUnique({
    where: { name: domainName.toLowerCase() },
    select: { name: true, status: true, dkimSelector: true, dnsCheck: true, dnsCheckedAt: true },
  });
  if (!dominio) return null;
  const [mailboxes, aliases, catchAll, encaminharTudo, dns] = await Promise.all([
    listMailboxes(dominio.name),
    listAliases(dominio.name),
    getCatchAll(dominio.name),
    getEncaminharTudo(dominio.name),
    descobrirDnsDoDominio(dominio.name),
  ]);
  return {
    domain: dominio.name,
    status: dominio.status,
    dnsRecords: dnsRecordsFor(dominio.name, dominio.dkimSelector),
    // Onde publicar os registros: provedor identificado pelos servidores de nome.
    dnsProvedor: dns.provedor,
    dnsServidores: dns.servidores,
    // A zona esta na conta da Cloudflare da casa: o painel publica sozinho.
    dnsPublicavel: dns.provedor?.id === "cloudflare" ? await dnsPublicavel(dominio.name) : false,
    dnsCheck: dominio.dnsCheck,
    dnsCheckedAt: dominio.dnsCheckedAt,
    mailboxes,
    aliases,
    catchAll,
    // Achatado de propósito: a tela trata o destino e as exceções como dois
    // campos independentes, e aninhar obrigaria cada leitura a descer um nível
    // para nada.
    encaminharTudo: encaminharTudo.destino,
    encaminharTudoExcecoes: encaminharTudo.excluidas,
  };
}

/**
 * @returns true se a rota foi tratada; false se nao e /v1/admin.
 */
export async function handleAdminRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  method: string,
  sessao: { mailboxId: string; address: string },
): Promise<boolean> {
  if (!path.startsWith("/v1/admin")) return false;

  if (!(await ehAdministrador(sessao.mailboxId))) {
    fail(res, 403, "Area administrativa: sua caixa nao e administradora.");
    return true;
  }

  if (path === "/v1/admin/resumo" && method === "GET") {
    json(res, 200, await resumo());
    return true;
  }

  // --- Dominios ---

  if (path === "/v1/admin/domains" && method === "GET") {
    json(res, 200, { domains: await listarDominios() });
    return true;
  }

  if (path === "/v1/admin/domains" && method === "POST") {
    const input = dominioSchema.parse(await readBody(req));
    const criado = await createDomain({ domain: input.domain, clientRef: `admin:${sessao.address}` });
    json(res, criado.created ? 201 : 200, {
      domain: criado.domain,
      created: criado.created,
      dnsRecords: criado.dnsRecords,
      ourZoneRecord: "ourZoneRecord" in criado ? criado.ourZoneRecord : undefined,
    });
    return true;
  }

  const dominioMatch = path.match(
    /^\/v1\/admin\/domains\/([^/]+)(\/verify|\/publish-dns|\/catch-all|\/encaminhar-tudo)?$/,
  );
  if (dominioMatch) {
    const nome = decodeURIComponent(dominioMatch[1] ?? "").toLowerCase();
    const sufixo = dominioMatch[2] ?? "";

    if (sufixo === "" && method === "GET") {
      const detalhe = await detalheDominio(nome);
      if (!detalhe) {
        fail(res, 404, `Dominio nao provisionado: ${nome}`);
        return true;
      }
      json(res, 200, detalhe);
      return true;
    }
    if (sufixo === "/verify" && method === "POST") {
      json(res, 200, await verifyDomainDns(nome));
      return true;
    }
    if (sufixo === "/publish-dns" && method === "POST") {
      const input = publicarDnsSchema.parse(await readBody(req));
      json(res, 200, await publicarDnsDoDominio(nome, { substituirMx: input.substituirMx ?? false }));
      return true;
    }
    if (sufixo === "/catch-all" && method === "POST") {
      const input = catchAllSchema.parse(await readBody(req));
      json(res, 200, await setCatchAll(nome, input.username));
      return true;
    }
    if (sufixo === "/encaminhar-tudo" && method === "POST") {
      const input = encaminharTudoSchema.parse(await readBody(req));
      json(res, 200, await encaminharTudoDoDominio(nome, input.destination, input.excluir ?? []));
      return true;
    }
  }

  // --- Caixas ---

  if (path === "/v1/admin/mailboxes" && method === "POST") {
    const input = caixaNovaSchema.parse(await readBody(req));
    const senha = input.password ?? generatePassword(20);
    const criada = await createMailbox({
      domain: input.domain,
      username: input.username,
      password: senha,
      quotaGb: input.quotaGb,
      displayName: input.displayName,
    });
    if (input.ownerEmail) await setMailboxOwner(input.domain, input.username, input.ownerEmail);
    // A senha volta UMA vez, so quando foi gerada aqui: quem a digitou ja a tem.
    json(res, 201, { ...criada, password: input.password ? undefined : senha });
    return true;
  }

  if (path === "/v1/admin/mailboxes/suspend" && method === "POST") {
    const input = caixaRefSchema.parse(await readBody(req));
    json(res, 200, await setMailboxStatus(input.domain, input.username, "suspended"));
    return true;
  }
  if (path === "/v1/admin/mailboxes/reactivate" && method === "POST") {
    const input = caixaRefSchema.parse(await readBody(req));
    json(res, 200, await setMailboxStatus(input.domain, input.username, "active"));
    return true;
  }
  if (path === "/v1/admin/mailboxes/delete" && method === "POST") {
    const input = caixaRefSchema.parse(await readBody(req));
    json(res, 200, await deleteMailbox(input.domain, input.username));
    return true;
  }
  if (path === "/v1/admin/mailboxes/password" && method === "POST") {
    const input = senhaSchema.parse(await readBody(req));
    const senha = input.password ?? generatePassword(20);
    await setMailboxPassword(input.domain, input.username, senha);
    json(res, 200, { ok: true, password: input.password ? undefined : senha });
    return true;
  }
  if (path === "/v1/admin/mailboxes/quota" && method === "POST") {
    const input = quotaSchema.parse(await readBody(req));
    json(res, 200, await setMailboxQuota(input.domain, input.username, input.quotaGb));
    return true;
  }
  if (path === "/v1/admin/mailboxes/owner" && method === "POST") {
    const input = donoSchema.parse(await readBody(req));
    json(res, 200, await setMailboxOwner(input.domain, input.username, input.ownerEmail));
    return true;
  }

  // --- Aliases ---

  if (path === "/v1/admin/aliases" && method === "POST") {
    const input = aliasSchema.parse(await readBody(req));
    json(res, 201, await createAlias(input));
    return true;
  }
  if (path === "/v1/admin/aliases/delete" && method === "POST") {
    const input = aliasRefSchema.parse(await readBody(req));
    json(res, 200, await deleteAlias(input.domain, input.alias));
    return true;
  }

  fail(res, 404, "Rota administrativa nao encontrada.");
  return true;
}
