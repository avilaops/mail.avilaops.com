import { resolveMx, resolveTxt, resolveCname } from "node:dns/promises";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { hashPassword } from "../lib/password.js";
import { isValidDomain, isValidLocalPart, parseAddress } from "../lib/address.js";
import { deleteRaw } from "../lib/storage.js";
import { ensureSystemFolders } from "./folders.js";
import { sendWelcome } from "./welcome.js";
import { sincronizarValor } from "./billing.js";
import { dkimCnameTarget, dkimTxtValue, encryptDkimPrivateKey, generateDkimKeyPair } from "../mta/dkim.js";
import { cloudflareConfigurado, publicarTxt } from "../lib/cloudflare.js";

const log = createLogger("provisioning");

/** Zona raiz da Avila Ops, derivada do hostname do servidor. */
const ROOT_ZONE = config.hostname.replace(/^mail\./, "");

export interface DnsRecord {
  type: "MX" | "TXT" | "CNAME";
  host: string;
  value: string;
  priority?: number;
  /** Explicacao mostrada ao cliente no painel. */
  purpose: string;
}

export class ProvisioningError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "ProvisioningError";
  }
}

/**
 * Registros que o CLIENTE publica na zona dele.
 *
 * O DKIM sai como CNAME apontando para a nossa zona, e o SPF como include
 * central: os dois desenhos existem para que trocar chave ou trocar provedor
 * de saida nao exija pedir nada a nenhum cliente depois.
 */
export function dnsRecordsFor(domainName: string, selector: string): DnsRecord[] {
  return [
    {
      type: "MX",
      host: "@",
      value: config.hostname,
      priority: 10,
      purpose: "Direciona o e-mail recebido para o servidor da Avila Ops",
    },
    {
      type: "TXT",
      host: "@",
      value: `v=spf1 include:_spf.${ROOT_ZONE} -all`,
      purpose: "SPF: autoriza nosso servidor a enviar em nome do dominio",
    },
    {
      type: "CNAME",
      host: `${selector}._domainkey`,
      value: dkimCnameTarget(domainName),
      purpose: "DKIM: assina digitalmente as mensagens enviadas",
    },
    {
      type: "TXT",
      host: "_dmarc",
      value: `v=DMARC1; p=quarantine; rua=mailto:dmarc@${ROOT_ZONE}; adkim=r; aspf=r`,
      purpose: "DMARC: instrui o destinatario sobre o que fazer com falsificacoes",
    },
  ];
}

export async function createDomain(input: { domain: string; clientRef?: string }) {
  const name = input.domain.trim().toLowerCase();
  if (!isValidDomain(name)) throw new ProvisioningError(`Dominio invalido: ${input.domain}`);

  const existing = await prisma.mailDomain.findUnique({
    where: { name },
    select: { id: true, dkimSelector: true, dkimPublicKey: true },
  });
  if (existing) {
    // Idempotente: o portal pode reenviar o provisionamento sem gerar chave
    // nova. A publicacao do TXT e refeita mesmo assim, porque e ela que
    // conserta um dominio antigo cujo alvo ficou vazio — publicarTxt nao
    // duplica quando o conteudo ja e o mesmo.
    const registro = existing.dkimPublicKey
      ? { type: "TXT" as const, host: dkimCnameTarget(name), value: dkimTxtValue(existing.dkimPublicKey) }
      : null;

    return {
      id: existing.id,
      domain: name,
      dkimSelector: existing.dkimSelector,
      dnsRecords: dnsRecordsFor(name, existing.dkimSelector),
      ourZoneRecord: registro,
      ourZonePublished: registro ? await publicarDkimNaNossaZona(name, registro) : undefined,
      created: false,
    };
  }

  const keys = generateDkimKeyPair();

  const domain = await prisma.mailDomain.create({
    data: {
      name,
      clientRef: input.clientRef ?? null,
      status: "pending_dns",
      dkimSelector: keys.selector,
      dkimPrivateKey: encryptDkimPrivateKey(keys.privateKeyPem),
      dkimPublicKey: keys.publicKeyBase64,
    },
    select: { id: true, dkimSelector: true },
  });

  await prisma.mailEvent.create({
    data: { domainId: domain.id, type: "domain.created", payload: { domain: name, clientRef: input.clientRef ?? null } },
  });

  const nossoRegistro = {
    type: "TXT" as const,
    host: dkimCnameTarget(name),
    value: dkimTxtValue(keys.publicKeyBase64),
  };

  // O CNAME que o cliente publica aponta para ESTE TXT, na nossa zona. Deixar
  // a publicacao por conta de quem le a resposta da API nao funciona: o
  // dominio nasce parecendo certo (tres registros publicados, DNS verde) e so
  // semanas depois alguem descobre o e-mail em spam com "dkim=neutral (no
  // key)". Foi o que aconteceu com o despolarizamed.com.br em 31/08/2026.
  const publicacao = await publicarDkimNaNossaZona(name, nossoRegistro);

  log.info("dominio provisionado", { domain: name, domainId: domain.id, dkim: publicacao.estado });

  return {
    id: domain.id,
    domain: name,
    dkimSelector: domain.dkimSelector,
    dnsRecords: dnsRecordsFor(name, domain.dkimSelector),
    /** TXT que a Avila Ops publica na propria zona, alvo do CNAME do cliente. */
    ourZoneRecord: nossoRegistro,
    /** Se a publicacao automatica funcionou, ou o que impediu. */
    ourZonePublished: publicacao,
    created: true,
  };
}

/**
 * Publica o TXT do DKIM na zona da Avila Ops.
 *
 * Falhar aqui **nao** desfaz o dominio: a chave ja esta no banco e o registro
 * volta em `ourZoneRecord` para publicacao manual. Derrubar o provisionamento
 * inteiro porque a Cloudflare piscou seria pior que entregar um dominio que
 * precisa de um passo a mao.
 */
async function publicarDkimNaNossaZona(
  domainName: string,
  registro: { host: string; value: string },
): Promise<{ estado: "publicado" | "ja_existia" | "manual"; motivo?: string }> {
  if (!cloudflareConfigurado()) {
    log.warn("DKIM nao publicado: Cloudflare sem credenciais; publique a mao", {
      domain: domainName,
      host: registro.host,
    });
    return { estado: "manual", motivo: "cloudflare nao configurado" };
  }

  const r = await publicarTxt({
    nome: registro.host,
    valor: registro.value,
    comentario: `DKIM de ${domainName} (avila-mail)`,
  });

  if (!r.ok) {
    log.error("DKIM nao publicado; publique a mao antes de liberar envio", {
      domain: domainName,
      host: registro.host,
      motivo: r.motivo,
    });
    return { estado: "manual", motivo: r.motivo };
  }

  return { estado: r.criado ? "publicado" : "ja_existia" };
}

/**
 * Reajusta a assinatura depois de criar ou remover caixa.
 *
 * Silencioso de proposito: caixa provisionada com sucesso nao pode virar erro
 * porque o Mercado Pago estava fora do ar. A divergencia e recuperavel — a
 * rota /sync recalcula a partir do banco a qualquer momento.
 */
async function reajustarCobranca(domainId: string): Promise<void> {
  try {
    const domain = await prisma.mailDomain.findUnique({
      where: { id: domainId },
      select: { clientRef: true },
    });
    if (!domain?.clientRef) return;

    const temConta = await prisma.billingAccount.findUnique({
      where: { clientRef: domain.clientRef },
      select: { id: true },
    });
    if (!temConta) return;

    await sincronizarValor(domain.clientRef);
  } catch (error) {
    log.error("nao foi possivel reajustar a cobranca; rode /billing/accounts/{ref}/sync", {
      domainId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function requireDomain(domainName: string) {
  const name = domainName.trim().toLowerCase();
  const domain = await prisma.mailDomain.findUnique({
    where: { name },
    select: { id: true, name: true, status: true, dkimSelector: true, dkimPublicKey: true },
  });
  if (!domain) throw new ProvisioningError(`Dominio nao provisionado: ${name}`, 404);
  return domain;
}

/**
 * Confere no DNS publico se os quatro registros ja propagaram.
 * Quando MX e DKIM estao de pe, o dominio vira `active` sozinho — e o que o
 * workflow de verificacao do n8n chama de 30 em 30 minutos.
 */
export async function verifyDomainDns(domainName: string) {
  const domain = await requireDomain(domainName);

  const checks = {
    mx: false,
    spf: false,
    dkim: false,
    dmarc: false,
  };

  await Promise.all([
    resolveMx(domain.name)
      .then((records) => {
        checks.mx = records.some((record) => record.exchange.toLowerCase() === config.hostname.toLowerCase());
      })
      .catch(() => undefined),

    resolveTxt(domain.name)
      .then((records) => {
        checks.spf = records.some((parts) => parts.join("").toLowerCase().includes(`include:_spf.${ROOT_ZONE}`));
      })
      .catch(() => undefined),

    resolveCname(`${domain.dkimSelector}._domainkey.${domain.name}`)
      .then(async (targets) => {
        const alvo = dkimCnameTarget(domain.name);
        const apontaCerto = targets.some((t) => t.toLowerCase() === alvo.toLowerCase());
        if (!apontaCerto) {
          checks.dkim = false;
          return;
        }

        /**
         * CNAME certo nao basta: o alvo mora na NOSSA zona e pode estar vazio.
         * Enquanto isto so conferia o CNAME, o painel dava DKIM verde para um
         * dominio cujo alvo nao tinha chave nenhuma, e o e-mail saia assinado
         * com uma chave que ninguem conseguia verificar — "dkim=neutral (no
         * key)" no destinatario. Aconteceu com o despolarizamed.com.br.
         */
        if (!domain.dkimPublicKey) {
          checks.dkim = false;
          return;
        }

        try {
          const noAlvo = await resolveTxt(alvo);
          checks.dkim = noAlvo.some((parts) => parts.join("").includes(domain.dkimPublicKey!));
        } catch {
          checks.dkim = false;
        }
      })
      .catch(async () => {
        // Cliente que publicou TXT direto em vez do CNAME tambem vale.
        try {
          /**
           * Sem chave publica guardada nao ha com o que comparar, e "nao da
           * para verificar" nunca pode virar "verificado".
           *
           * Isto ja esteve escrito como `?? ""`, e `includes("")` e sempre
           * verdadeiro: qualquer TXT no lugar certo, ate um errado, faria o
           * painel dizer que o DKIM estava correto — e o cliente descobriria o
           * contrario quando o e-mail dele caisse no spam.
           */
          const esperada = domain.dkimPublicKey;
          if (!esperada) {
            checks.dkim = false;
            return;
          }

          const records = await resolveTxt(`${domain.dkimSelector}._domainkey.${domain.name}`);
          checks.dkim = records.some((parts) => parts.join("").includes(esperada));
        } catch {
          checks.dkim = false;
        }
      }),

    resolveTxt(`_dmarc.${domain.name}`)
      .then((records) => {
        checks.dmarc = records.some((parts) => parts.join("").toLowerCase().startsWith("v=dmarc1"));
      })
      .catch(() => undefined),
  ]);

  // MX e DKIM sao o minimo para operar: recebe e assina. SPF e DMARC entram na
  // pontuacao de entregabilidade, mas nao travam a ativacao.
  const ready = checks.mx && checks.dkim;
  const status = ready ? "active" : domain.status === "active" ? "active" : "pending_dns";

  await prisma.mailDomain.update({
    where: { id: domain.id },
    data: { dnsCheck: checks, dnsCheckedAt: new Date(), status },
  });

  if (ready && domain.status !== "active") {
    await prisma.mailEvent.create({
      data: { domainId: domain.id, type: "dns.verified", payload: { ...checks } },
    });
    log.info("dominio ativado apos verificacao de DNS", { domain: domain.name, checks });
  }

  return { domain: domain.name, status, checks, ready };
}

export async function createMailbox(input: {
  domain: string;
  username: string;
  password: string;
  quotaGb?: number;
  displayName?: string;
  /** Endereco de contato do cliente que recebe o aviso de caixa pronta. */
  notifyTo?: string;
  /** Dono no SSO (auth.avilaops.com): quem pode abrir a caixa sem senha. */
  ownerEmail?: string;
  /**
   * Forcar a troca da senha no primeiro acesso. Padrao true: a senha que
   * criamos e provisoria, o cliente define a dele ao entrar. So passar false
   * quando o proprio dono ja escolheu a senha (ex.: cadastro self-service).
   */
  mustChangePassword?: boolean;
}) {
  const domain = await requireDomain(input.domain);
  const localPart = input.username.trim().toLowerCase();

  if (!isValidLocalPart(localPart)) throw new ProvisioningError(`Nome de caixa invalido: ${input.username}`);
  if (input.password.length < 12) {
    throw new ProvisioningError("A senha da caixa precisa ter no minimo 12 caracteres.");
  }

  const existing = await prisma.mailbox.findUnique({
    where: { domainId_localPart: { domainId: domain.id, localPart } },
    select: { id: true },
  });
  if (existing) throw new ProvisioningError(`A caixa ${localPart}@${domain.name} ja existe.`, 409);

  // O espelho da regra do alias: caixa criada por cima de um alias ganharia a
  // resolucao e mataria o encaminhamento em silencio. Quem quer o nome decide
  // primeiro o que fazer com o alias.
  const aliasHomonimo = await prisma.mailAlias.findUnique({
    where: { domainId_localPart: { domainId: domain.id, localPart } },
    select: { destination: true },
  });
  if (aliasHomonimo) {
    throw new ProvisioningError(
      `Ja existe o alias ${localPart}@${domain.name} → ${aliasHomonimo.destination}. ` +
        "Remova o alias antes de criar a caixa com este nome.",
      409,
    );
  }

  const quotaBytes = input.quotaGb
    ? BigInt(input.quotaGb) * 1024n * 1024n * 1024n
    : BigInt(config.limits.defaultQuotaBytes);

  const mailbox = await prisma.mailbox.create({
    data: {
      domainId: domain.id,
      localPart,
      passwordHash: await hashPassword(input.password),
      displayName: input.displayName ?? null,
      ownerEmail: input.ownerEmail?.trim().toLowerCase() ?? null,
      mustChangePassword: input.mustChangePassword ?? true,
      quotaBytes,
      status: "active",
      sendLimitPerHour: config.limits.defaultSendLimitPerHour,
    },
    select: { id: true },
  });

  await ensureSystemFolders(mailbox.id);

  await prisma.mailEvent.create({
    data: {
      domainId: domain.id,
      mailboxId: mailbox.id,
      type: "mailbox.created",
      payload: { address: `${localPart}@${domain.name}`, quotaBytes: quotaBytes.toString() },
    },
  });

  log.info("caixa provisionada", { address: `${localPart}@${domain.name}`, mailboxId: mailbox.id });

  const welcome = await sendWelcome({ mailboxId: mailbox.id, notifyTo: input.notifyTo });
  await reajustarCobranca(domain.id);

  return {
    id: mailbox.id,
    address: `${localPart}@${domain.name}`,
    quotaGb: Number(quotaBytes / (1024n * 1024n * 1024n)),
    imap: { host: config.hostname, port: 993, security: "SSL/TLS" },
    pop3: { host: config.hostname, port: 995, security: "SSL/TLS" },
    smtp: { host: config.hostname, port: 587, security: "STARTTLS" },
    webmail: `https://${config.hostname}`,
    welcome,
  };
}

async function requireMailbox(domainName: string, username: string) {
  const domain = await requireDomain(domainName);
  const localPart = username.trim().toLowerCase();

  const mailbox = await prisma.mailbox.findUnique({
    where: { domainId_localPart: { domainId: domain.id, localPart } },
    select: { id: true, status: true },
  });
  if (!mailbox) throw new ProvisioningError(`Caixa nao encontrada: ${localPart}@${domain.name}`, 404);

  return { domain, mailbox, address: `${localPart}@${domain.name}` };
}

/**
 * Suspensao por inadimplencia bloqueia o ACESSO, nao o recebimento.
 *
 * Decisao de produto deliberada: quem atrasa tres dias nao pode perder e-mail
 * de cliente. A mensagem continua chegando e reaparece assim que o pagamento
 * entra. Corte definitivo so no ciclo de desativacao.
 */
export async function setMailboxStatus(domainName: string, username: string, status: "active" | "suspended" | "disabled") {
  const { mailbox, address, domain } = await requireMailbox(domainName, username);

  await prisma.mailbox.update({ where: { id: mailbox.id }, data: { status } });
  await prisma.mailEvent.create({
    data: {
      domainId: domain.id,
      mailboxId: mailbox.id,
      type: `mailbox.${status === "active" ? "reactivated" : status}`,
      severity: status === "active" ? "info" : "warn",
      payload: { address },
    },
  });

  log.info("status da caixa alterado", { address, status });
  return { address, status };
}

export async function setMailboxPassword(domainName: string, username: string, password: string) {
  if (password.length < 12) throw new ProvisioningError("A senha da caixa precisa ter no minimo 12 caracteres.");
  const { mailbox, address, domain } = await requireMailbox(domainName, username);

  await prisma.mailbox.update({ where: { id: mailbox.id }, data: { passwordHash: await hashPassword(password) } });
  await prisma.mailEvent.create({
    data: { domainId: domain.id, mailboxId: mailbox.id, type: "mailbox.password_changed", payload: { address } },
  });

  return { address };
}

/** Define (ou limpa, com null) o dono da caixa no SSO. */
export async function setMailboxOwner(domainName: string, username: string, ownerEmail: string | null) {
  const domain = await requireDomain(domainName);
  const localPart = username.trim().toLowerCase();
  const mailbox = await prisma.mailbox.findUnique({
    where: { domainId_localPart: { domainId: domain.id, localPart } },
    select: { id: true },
  });
  if (!mailbox) throw new ProvisioningError(`Caixa nao encontrada: ${localPart}@${domain.name}`, 404);
  await prisma.mailbox.update({
    where: { id: mailbox.id },
    data: { ownerEmail: ownerEmail ? ownerEmail.trim().toLowerCase() : null },
  });
  return { address: `${localPart}@${domain.name}`, ownerEmail: ownerEmail?.trim().toLowerCase() ?? null };
}

export async function setMailboxQuota(domainName: string, username: string, quotaGb: number) {
  const { mailbox, address } = await requireMailbox(domainName, username);
  const quotaBytes = BigInt(quotaGb) * 1024n * 1024n * 1024n;

  await prisma.mailbox.update({ where: { id: mailbox.id }, data: { quotaBytes } });
  return { address, quotaGb };
}

/** Remocao definitiva: apaga blobs em disco antes das linhas do banco. */
export async function deleteMailbox(domainName: string, username: string) {
  const { mailbox, address, domain } = await requireMailbox(domainName, username);

  const messages = await prisma.message.findMany({
    where: { mailboxId: mailbox.id },
    select: { storageKey: true },
  });

  for (const message of messages) {
    if (message.storageKey) await deleteRaw(message.storageKey);
  }

  await prisma.mailbox.delete({ where: { id: mailbox.id } });
  await prisma.mailEvent.create({
    data: { domainId: domain.id, type: "mailbox.deleted", severity: "warn", payload: { address, messages: messages.length } },
  });

  await reajustarCobranca(domain.id);

  log.warn("caixa removida", { address, messages: messages.length });
  return { address, removedMessages: messages.length };
}

export async function listMailboxes(domainName: string) {
  const domain = await requireDomain(domainName);
  const mailboxes = await prisma.mailbox.findMany({
    where: { domainId: domain.id },
    orderBy: { localPart: "asc" },
    select: {
      id: true,
      localPart: true,
      displayName: true,
      status: true,
      quotaBytes: true,
      usedBytes: true,
      lastLoginAt: true,
      createdAt: true,
    },
  });

  return mailboxes.map((mailbox) => ({
    id: mailbox.id,
    address: `${mailbox.localPart}@${domain.name}`,
    displayName: mailbox.displayName,
    status: mailbox.status,
    quotaGb: Number(mailbox.quotaBytes / (1024n * 1024n * 1024n)),
    usedMb: Number(mailbox.usedBytes / (1024n * 1024n)),
    lastLoginAt: mailbox.lastLoginAt,
    createdAt: mailbox.createdAt,
  }));
}

/**
 * Base de faturamento: uma linha por caixa cobravel.
 * Caixa suspensa continua na lista — ela ocupa disco e ainda recebe e-mail; o
 * que define se cobra ou nao e o portal, nao o servidor.
 */
export async function billableMailboxes() {
  const mailboxes = await prisma.mailbox.findMany({
    where: { status: { in: ["active", "suspended"] } },
    select: {
      id: true,
      localPart: true,
      status: true,
      usedBytes: true,
      createdAt: true,
      domain: { select: { name: true, clientRef: true } },
    },
  });

  return mailboxes.map((mailbox) => ({
    mailboxId: mailbox.id,
    address: `${mailbox.localPart}@${mailbox.domain.name}`,
    domain: mailbox.domain.name,
    clientRef: mailbox.domain.clientRef,
    status: mailbox.status,
    usedMb: Number(mailbox.usedBytes / (1024n * 1024n)),
    createdAt: mailbox.createdAt,
  }));
}

// --------------------------------------------------------------------------
// Aliases e catch-all
// --------------------------------------------------------------------------

/**
 * Cria ou atualiza um alias (vendas@ → caixa nossa ou endereco externo).
 *
 * Upsert de proposito: "trocar o destino" e a operacao mais comum depois de
 * criar, e o portal nao deveria precisar de apagar-e-recriar para isso.
 *
 * Duas recusas deliberadas:
 * - **Alias com o nome de uma caixa existente**: a caixa sempre ganha na
 *   resolucao de destinatario, entao o alias seria letra morta — melhor
 *   recusar do que deixar o cliente acreditar que funcionou.
 * - **Destino local que nao e caixa real** (outro alias, catch-all): corrente
 *   de alias pode virar laco (a→b, b→a) e entregar a mesma mensagem para
 *   sempre. Alias aponta para caixa de verdade ou para fora. O laco imediato
 *   (alias apontando para si) cai nesta mesma regra.
 */
export async function createAlias(input: { domain: string; alias: string; destination: string }) {
  const domain = await requireDomain(input.domain);
  const localPart = input.alias.trim().toLowerCase();
  if (!isValidLocalPart(localPart)) throw new ProvisioningError(`Nome de alias invalido: ${input.alias}`);

  const destino = parseAddress(input.destination);
  if (!destino) throw new ProvisioningError(`Destino invalido: ${input.destination}`);

  const address = `${localPart}@${domain.name}`;

  const caixaHomonima = await prisma.mailbox.findUnique({
    where: { domainId_localPart: { domainId: domain.id, localPart } },
    select: { id: true },
  });
  if (caixaHomonima) {
    throw new ProvisioningError(`Ja existe a caixa ${address}; o alias nunca seria usado.`, 409);
  }

  const dominioDestino = await prisma.mailDomain.findUnique({
    where: { name: destino.domain },
    select: { id: true },
  });
  if (dominioDestino) {
    const caixaDestino = await prisma.mailbox.findUnique({
      where: { domainId_localPart: { domainId: dominioDestino.id, localPart: destino.localPart } },
      select: { id: true },
    });
    if (!caixaDestino) {
      throw new ProvisioningError(
        `O destino ${destino.full} esta num dominio nosso mas nao e uma caixa. ` +
          "Alias aponta para caixa real ou para endereco de fora — corrente de alias pode virar laco.",
        422,
      );
    }
  }

  const existente = await prisma.mailAlias.findUnique({
    where: { domainId_localPart: { domainId: domain.id, localPart } },
    select: { id: true, destination: true },
  });

  if (existente) {
    if (existente.destination !== destino.full) {
      await prisma.mailAlias.update({ where: { id: existente.id }, data: { destination: destino.full } });
      await prisma.mailEvent.create({
        data: {
          domainId: domain.id,
          type: "alias.updated",
          payload: { address, de: existente.destination, para: destino.full },
        },
      });
      log.info("destino do alias alterado", { address, destination: destino.full });
    }
    return { address, destination: destino.full, created: false };
  }

  await prisma.mailAlias.create({
    data: { domainId: domain.id, localPart, destination: destino.full },
  });
  await prisma.mailEvent.create({
    data: { domainId: domain.id, type: "alias.created", payload: { address, destination: destino.full } },
  });

  log.info("alias criado", { address, destination: destino.full });
  return { address, destination: destino.full, created: true };
}

export async function listAliases(domainName: string) {
  const domain = await requireDomain(domainName);
  const aliases = await prisma.mailAlias.findMany({
    where: { domainId: domain.id },
    orderBy: { localPart: "asc" },
    select: { localPart: true, destination: true, createdAt: true },
  });

  return aliases.map((alias) => ({
    address: `${alias.localPart}@${domain.name}`,
    destination: alias.destination,
    createdAt: alias.createdAt,
  }));
}

/** Endereco da caixa pega-tudo do dominio, ou null quando desligado. */
export async function getCatchAll(domainName: string): Promise<string | null> {
  const domain = await requireDomain(domainName);
  const registro = await prisma.mailDomain.findUnique({
    where: { id: domain.id },
    select: { catchAllMailboxId: true },
  });
  if (!registro?.catchAllMailboxId) return null;

  const caixa = await prisma.mailbox.findUnique({
    where: { id: registro.catchAllMailboxId },
    select: { localPart: true },
  });
  return caixa ? `${caixa.localPart}@${domain.name}` : null;
}

export async function deleteAlias(domainName: string, aliasName: string) {
  const domain = await requireDomain(domainName);
  const localPart = aliasName.trim().toLowerCase();
  const address = `${localPart}@${domain.name}`;

  const alias = await prisma.mailAlias.findUnique({
    where: { domainId_localPart: { domainId: domain.id, localPart } },
    select: { id: true, destination: true },
  });
  if (!alias) throw new ProvisioningError(`Alias nao encontrado: ${address}`, 404);

  await prisma.mailAlias.delete({ where: { id: alias.id } });
  await prisma.mailEvent.create({
    data: { domainId: domain.id, type: "alias.deleted", payload: { address, destination: alias.destination } },
  });

  log.info("alias removido", { address });
  return { address, destination: alias.destination };
}

/**
 * Catch-all: tudo que nao casa com caixa nem alias cai numa caixa escolhida.
 * `username` nulo desliga. So caixa do PROPRIO dominio serve — catch-all
 * apontando para caixa de outro cliente seria vazamento de correspondencia.
 */
export async function setCatchAll(domainName: string, username: string | null) {
  const domain = await requireDomain(domainName);

  if (username === null) {
    await prisma.mailDomain.update({ where: { id: domain.id }, data: { catchAllMailboxId: null } });
    await prisma.mailEvent.create({
      data: { domainId: domain.id, type: "domain.catchall_cleared", payload: { domain: domain.name } },
    });
    log.info("catch-all desligado", { domain: domain.name });
    return { domain: domain.name, catchAll: null };
  }

  const localPart = username.trim().toLowerCase();
  const mailbox = await prisma.mailbox.findUnique({
    where: { domainId_localPart: { domainId: domain.id, localPart } },
    select: { id: true },
  });
  if (!mailbox) {
    throw new ProvisioningError(`Caixa nao encontrada no dominio: ${localPart}@${domain.name}`, 404);
  }

  await prisma.mailDomain.update({ where: { id: domain.id }, data: { catchAllMailboxId: mailbox.id } });
  await prisma.mailEvent.create({
    data: {
      domainId: domain.id,
      mailboxId: mailbox.id,
      type: "domain.catchall_set",
      payload: { domain: domain.name, address: `${localPart}@${domain.name}` },
    },
  });

  log.info("catch-all definido", { domain: domain.name, address: `${localPart}@${domain.name}` });
  return { domain: domain.name, catchAll: `${localPart}@${domain.name}` };
}
