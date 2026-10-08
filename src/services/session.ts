import { createHash, randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import { Prisma } from "@prisma/client";
import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { parseAddress } from "../lib/address.js";
import { burnPasswordTime, hashPassword, verifyPassword } from "../lib/password.js";
import { upgradeHashIfNeeded } from "./passwordUpgrade.js";
import { signAccessToken, signTotpToken, verifyTotpToken } from "../lib/jwt.js";
import { decryptSecret, encryptSecret } from "../lib/crypto.js";
import { localizarIp } from "../lib/geoip.js";
import { descreverAparelho } from "../lib/userAgent.js";
import { alertarAcessoNovo, alertarMudanca } from "./alertas.js";
import {
  gerarCodigosDeRecuperacao,
  gerarSegredoTotp,
  otpauthUrl,
  verificarCodigoTotp,
} from "../lib/totp.js";

const log = createLogger("session");

/** Janela do contador de tentativas de login. */
const LOGIN_WINDOW_MINUTES = 15;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly statusCode = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function windowStart(): Date {
  const now = Date.now();
  const size = LOGIN_WINDOW_MINUTES * 60_000;
  return new Date(Math.floor(now / size) * size);
}

interface Trava {
  identifier: string;
  limit: number;
}

/**
 * Travas em camadas, cada uma com seu proprio limite.
 *
 * Travar o endereco no mesmo limite do par endereco+IP seria um tiro no pe:
 * qualquer um erraria a senha 8 vezes de propostio e deixaria a caixa do
 * cliente 15 minutos fora do ar. Por isso o limite por endereco e bem mais
 * alto — ele existe para conter ataque distribuido, nao para ser o gatilho
 * do dia a dia.
 */
function travasDe(address: string, ip?: string): Trava[] {
  const base = config.session.maxLoginFailures;
  const travas: Trava[] = [{ identifier: `addr:${address}`, limit: base * 5 }];

  if (ip) {
    // Camada principal: este atacante, contra esta caixa.
    travas.push({ identifier: `pair:${address}|${ip}`, limit: base });
    // Contem varredura de varias caixas a partir do mesmo IP.
    travas.push({ identifier: `ip:${ip}`, limit: base * 3 });
  }

  return travas;
}

async function estaTravado(travas: Trava[]): Promise<boolean> {
  const registros = await prisma.loginAttempt.findMany({
    where: { identifier: { in: travas.map((trava) => trava.identifier) }, windowStart: windowStart() },
    select: { identifier: true, failures: true },
  });

  const falhas = new Map(registros.map((registro) => [registro.identifier, registro.failures]));
  return travas.some((trava) => (falhas.get(trava.identifier) ?? 0) >= trava.limit);
}

async function registrarFalha(travas: Trava[]): Promise<void> {
  const inicio = windowStart();
  await Promise.all(
    travas.map((trava) =>
      prisma.loginAttempt.upsert({
        where: { identifier_windowStart: { identifier: trava.identifier, windowStart: inicio } },
        create: { identifier: trava.identifier, windowStart: inicio, failures: 1 },
        update: { failures: { increment: 1 } },
      }),
    ),
  );
}

async function limparFalhas(travas: Trava[]): Promise<void> {
  await prisma.loginAttempt.deleteMany({
    where: { identifier: { in: travas.map((trava) => trava.identifier) }, windowStart: windowStart() },
  });
}

export interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  mailbox: {
    id: string;
    address: string;
    displayName: string | null;
    quotaBytes: string;
    usedBytes: string;
    mustChangePassword: boolean;
  };
}

async function emitirSessao(
  mailbox: { id: string; localPart: string; displayName: string | null; quotaBytes: bigint; usedBytes: bigint; mustChangePassword?: boolean; domain: { name: string } },
  contexto: { ip?: string; userAgent?: string },
): Promise<SessionTokens> {
  const refreshToken = randomBytes(48).toString("base64url");
  const expiresAt = new Date(Date.now() + config.session.refreshTokenDays * 86_400_000);

  const sessao = await prisma.mailSession.create({
    data: {
      mailboxId: mailbox.id,
      refreshHash: hashToken(refreshToken),
      ip: contexto.ip?.slice(0, 60) ?? null,
      userAgent: contexto.userAgent?.slice(0, 300) ?? null,
      expiresAt,
    },
    select: { id: true },
  });

  // Localizacao em segundo plano: o login nao espera um servico de terceiro,
  // e a tela mostra a cidade assim que a consulta volta (segundos depois).
  if (contexto.ip) {
    void localizarIp(contexto.ip)
      .then((local) =>
        local ? prisma.mailSession.update({ where: { id: sessao.id }, data: { location: local } }) : null,
      )
      .catch(() => undefined);
  }

  // Aparelho nunca visto vira alerta na caixa e push. Fora do caminho do
  // login de proposito: quem entrou nao espera por isso.
  void alertarAcessoNovo({
    mailboxId: mailbox.id,
    sessionId: sessao.id,
    ip: contexto.ip,
    userAgent: contexto.userAgent,
  });

  const address = `${mailbox.localPart}@${mailbox.domain.name}`;

  return {
    accessToken: signAccessToken({ sub: mailbox.id, adr: address, sid: sessao.id }),
    refreshToken,
    expiresInSeconds: config.session.accessTokenMinutes * 60,
    mailbox: {
      id: mailbox.id,
      address,
      displayName: mailbox.displayName,
      quotaBytes: mailbox.quotaBytes.toString(),
      usedBytes: mailbox.usedBytes.toString(),
      mustChangePassword: mailbox.mustChangePassword ?? false,
    },
  };
}

/**
 * Login com 2FA ativa para em `requiresTotp`: a senha foi provada, mas a
 * sessao so nasce depois do codigo. O `totpToken` e a ponte entre as duas
 * etapas — curto, com audience propria, inutil como access token.
 */
export type LoginResult = SessionTokens | { requiresTotp: true; totpToken: string };

export async function login(input: {
  address: string;
  password: string;
  ip?: string;
  userAgent?: string;
}): Promise<LoginResult> {
  const parsed = parseAddress(input.address);
  if (!parsed) throw new AuthError("Endereco ou senha invalidos.");

  const travas = travasDe(parsed.full, input.ip);

  if (await estaTravado(travas)) {
    log.warn("login bloqueado por excesso de tentativas", { address: parsed.full, ip: input.ip });
    throw new AuthError(
      `Muitas tentativas. Tente novamente em ate ${LOGIN_WINDOW_MINUTES} minutos.`,
      429,
    );
  }

  const mailbox = await prisma.mailbox.findFirst({
    where: { localPart: parsed.localPart, domain: { name: parsed.domain } },
    select: {
      id: true,
      localPart: true,
      displayName: true,
      passwordHash: true,
      status: true,
      quotaBytes: true,
      usedBytes: true,
      totpEnabledAt: true,
      mustChangePassword: true,
      domain: { select: { name: true } },
    },
  });

  // Mesma resposta E mesmo tempo para caixa inexistente e senha errada: sem
  // queimar o tempo do bcrypt, o relogio denuncia quais enderecos existem.
  const senhaConfere = mailbox
    ? await verifyPassword(input.password, mailbox.passwordHash)
    : (await burnPasswordTime(input.password), false);

  if (!mailbox || !senhaConfere) {
    await registrarFalha(travas);
    log.warn("login recusado", { address: parsed.full, ip: input.ip });
    throw new AuthError("Endereco ou senha invalidos.");
  }

  upgradeHashIfNeeded(mailbox.id, input.password, mailbox.passwordHash);

  if (mailbox.status === "disabled") {
    throw new AuthError("Esta caixa foi desativada. Fale com o suporte.", 403);
  }
  if (mailbox.status === "suspended") {
    // Mensagem especifica de proposito: aqui o objetivo e o cliente resolver o
    // pagamento, nao proteger contra enumeracao — ele ja provou a senha.
    throw new AuthError("Caixa suspensa por pendencia financeira. Regularize no painel para reativar.", 403);
  }

  await limparFalhas(travas);

  if (mailbox.totpEnabledAt) {
    log.info("senha conferida; aguardando codigo 2FA", { mailboxId: mailbox.id, ip: input.ip });
    return { requiresTotp: true, totpToken: signTotpToken({ sub: mailbox.id }) };
  }

  await prisma.mailbox.update({ where: { id: mailbox.id }, data: { lastLoginAt: new Date() } });

  log.info("login efetuado", { mailboxId: mailbox.id, ip: input.ip });
  return emitirSessao(mailbox, { ip: input.ip, userAgent: input.userAgent });
}

// ---------------------------------------------------------------------------
// Verificacao em duas etapas (TOTP)
// ---------------------------------------------------------------------------

function travasTotp(mailboxId: string, ip?: string): Trava[] {
  const base = config.session.maxLoginFailures;
  const travas: Trava[] = [{ identifier: `totp:${mailboxId}`, limit: base * 5 }];
  if (ip) travas.push({ identifier: `totp:${mailboxId}|${ip}`, limit: base });
  return travas;
}

function hashCodigoRecuperacao(codigo: string): string {
  return createHash("sha256").update(codigo.trim().toLowerCase()).digest("hex");
}

/**
 * Segunda etapa do login. Aceita o codigo do autenticador ou um codigo de
 * recuperacao (consumido no uso). Mesmas travas em camadas do login — seis
 * digitos sem trava seriam forca bruta de um milhao de tentativas.
 */
export async function completarLoginTotp(input: {
  totpToken: string;
  code: string;
  ip?: string;
  userAgent?: string;
}): Promise<SessionTokens> {
  const payload = verifyTotpToken(input.totpToken);
  if (!payload) throw new AuthError("Verificacao expirada. Faca login novamente.");

  const travas = travasTotp(payload.sub, input.ip);
  if (await estaTravado(travas)) {
    throw new AuthError(`Muitas tentativas. Tente novamente em ate ${LOGIN_WINDOW_MINUTES} minutos.`, 429);
  }

  const mailbox = await prisma.mailbox.findUnique({
    where: { id: payload.sub },
    select: {
      id: true,
      localPart: true,
      displayName: true,
      status: true,
      quotaBytes: true,
      usedBytes: true,
      totpSecret: true,
      totpEnabledAt: true,
      totpLastCounter: true,
      totpRecoveryCodes: true,
      domain: { select: { name: true } },
    },
  });
  if (!mailbox?.totpEnabledAt || !mailbox.totpSecret) {
    throw new AuthError("Verificacao expirada. Faca login novamente.");
  }
  if (mailbox.status !== "active") throw new AuthError("Caixa indisponivel no momento.", 403);

  const codigo = input.code.trim();
  let valido = false;

  if (/^\d{6}$/.test(codigo.replace(/\s/g, ""))) {
    const contador = verificarCodigoTotp(decryptSecret(mailbox.totpSecret), codigo);
    /**
     * Anti-replay: o contador aceito fica guardado e codigo de janela ja
     * usada e recusado. Quem espiou o codigo por cima do ombro tem que
     * espiar de novo — e dentro de 30 segundos.
     */
    if (contador !== null && contador > (mailbox.totpLastCounter ?? -1)) {
      await prisma.mailbox.update({ where: { id: mailbox.id }, data: { totpLastCounter: contador } });
      valido = true;
    }
  } else {
    const restantes = Array.isArray(mailbox.totpRecoveryCodes)
      ? (mailbox.totpRecoveryCodes as string[])
      : [];
    const hash = hashCodigoRecuperacao(codigo);
    if (restantes.includes(hash)) {
      await prisma.mailbox.update({
        where: { id: mailbox.id },
        data: { totpRecoveryCodes: restantes.filter((registro) => registro !== hash) },
      });
      await prisma.mailEvent.create({
        data: {
          mailboxId: mailbox.id,
          type: "totp.recovery_code_used",
          severity: "warn",
          payload: { restantes: restantes.length - 1, ip: input.ip ?? null },
        },
      });
      valido = true;
    }
  }

  if (!valido) {
    await registrarFalha(travas);
    log.warn("codigo 2FA recusado", { mailboxId: mailbox.id, ip: input.ip });
    throw new AuthError("Codigo invalido.");
  }

  await limparFalhas(travas);
  await prisma.mailbox.update({ where: { id: mailbox.id }, data: { lastLoginAt: new Date() } });

  log.info("login efetuado com 2FA", { mailboxId: mailbox.id, ip: input.ip });
  return emitirSessao(mailbox, { ip: input.ip, userAgent: input.userAgent });
}

/**
 * Passo 1 da ativacao: gera e guarda o segredo (cifrado), ainda SEM valer.
 * So o `enableTotp`, com um codigo correto, liga de verdade — ativar sem
 * provar o codigo trancaria para fora o proprio dono no login seguinte.
 */
export async function setupTotp(mailboxId: string): Promise<{ secret: string; otpauth: string }> {
  const mailbox = await prisma.mailbox.findUniqueOrThrow({
    where: { id: mailboxId },
    select: { totpEnabledAt: true, localPart: true, domain: { select: { name: true } } },
  });
  if (mailbox.totpEnabledAt) {
    throw new AuthError("A verificacao em duas etapas ja esta ativa. Desative antes de reconfigurar.", 409);
  }

  const secret = gerarSegredoTotp();
  await prisma.mailbox.update({
    where: { id: mailboxId },
    data: { totpSecret: encryptSecret(secret), totpLastCounter: null, totpRecoveryCodes: Prisma.DbNull },
  });

  const endereco = `${mailbox.localPart}@${mailbox.domain.name}`;
  return { secret, otpauth: otpauthUrl(endereco, secret) };
}

/** Passo 2: o dono prova um codigo e a 2FA passa a valer. */
export async function enableTotp(mailboxId: string, code: string): Promise<{ recoveryCodes: string[] }> {
  const mailbox = await prisma.mailbox.findUniqueOrThrow({
    where: { id: mailboxId },
    select: { totpSecret: true, totpEnabledAt: true },
  });
  if (mailbox.totpEnabledAt) throw new AuthError("A verificacao em duas etapas ja esta ativa.", 409);
  if (!mailbox.totpSecret) throw new AuthError("Gere o segredo primeiro (setup).", 422);

  const contador = verificarCodigoTotp(decryptSecret(mailbox.totpSecret), code);
  if (contador === null) {
    throw new AuthError("Codigo invalido. Confira o relogio do celular e tente de novo.", 422);
  }

  const recoveryCodes = gerarCodigosDeRecuperacao();
  await prisma.mailbox.update({
    where: { id: mailboxId },
    data: {
      totpEnabledAt: new Date(),
      totpLastCounter: contador,
      totpRecoveryCodes: recoveryCodes.map(hashCodigoRecuperacao),
    },
  });

  void alertarMudanca(mailboxId, "2fa-ligado");
  await prisma.mailEvent.create({
    data: { mailboxId, type: "totp.enabled", payload: {} },
  });

  log.info("2FA ativada", { mailboxId });
  // A UNICA vez que os codigos de recuperacao existem em claro.
  return { recoveryCodes };
}

/** Desativa — exige um codigo valido (autenticador ou recuperacao). */
export async function disableTotp(mailboxId: string, code: string): Promise<void> {
  const mailbox = await prisma.mailbox.findUniqueOrThrow({
    where: { id: mailboxId },
    select: { totpSecret: true, totpEnabledAt: true, totpRecoveryCodes: true },
  });
  if (!mailbox.totpEnabledAt || !mailbox.totpSecret) {
    throw new AuthError("A verificacao em duas etapas nao esta ativa.", 409);
  }

  const codigo = code.trim();
  const porTotp = verificarCodigoTotp(decryptSecret(mailbox.totpSecret), codigo) !== null;
  const restantes = Array.isArray(mailbox.totpRecoveryCodes) ? (mailbox.totpRecoveryCodes as string[]) : [];
  const porRecuperacao = restantes.includes(hashCodigoRecuperacao(codigo));

  if (!porTotp && !porRecuperacao) throw new AuthError("Codigo invalido.", 422);

  await prisma.mailbox.update({
    where: { id: mailboxId },
    data: { totpSecret: null, totpEnabledAt: null, totpLastCounter: null, totpRecoveryCodes: Prisma.DbNull },
  });

  void alertarMudanca(mailboxId, "2fa-desligado");
  await prisma.mailEvent.create({
    data: { mailboxId, type: "totp.disabled", severity: "warn", payload: {} },
  });

  log.info("2FA desativada", { mailboxId });
}

/**
 * Troca o refresh por um par novo, invalidando o anterior (rotacao).
 *
 * Se chegar um refresh que ja foi usado, o cenario mais provavel e roubo de
 * token: o legitimo e o ladrao estao alternando. A resposta e derrubar todas
 * as sessoes da caixa e obrigar login novo.
 */
export async function refresh(input: {
  refreshToken: string;
  ip?: string;
  userAgent?: string;
}): Promise<SessionTokens> {
  const hash = hashToken(input.refreshToken);

  const sessao = await prisma.mailSession.findUnique({
    where: { refreshHash: hash },
    select: {
      id: true,
      mailboxId: true,
      revokedAt: true,
      expiresAt: true,
      mailbox: {
        select: {
          id: true,
          localPart: true,
          displayName: true,
          status: true,
          quotaBytes: true,
          usedBytes: true,
          domain: { select: { name: true } },
        },
      },
    },
  });

  if (!sessao) throw new AuthError("Sessao invalida. Faca login novamente.");

  if (sessao.revokedAt) {
    await prisma.mailSession.updateMany({
      where: { mailboxId: sessao.mailboxId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await prisma.mailEvent.create({
      data: {
        mailboxId: sessao.mailboxId,
        type: "session.reuse_detected",
        severity: "error",
        payload: { sessionId: sessao.id, ip: input.ip ?? null },
      },
    });
    log.error("refresh token reutilizado; todas as sessoes da caixa foram revogadas", {
      mailboxId: sessao.mailboxId,
      ip: input.ip,
    });
    throw new AuthError("Sessao invalida. Faca login novamente.");
  }

  if (sessao.expiresAt <= new Date()) throw new AuthError("Sessao expirada. Faca login novamente.");
  if (sessao.mailbox.status !== "active") throw new AuthError("Caixa indisponivel no momento.", 403);

  await prisma.mailSession.update({ where: { id: sessao.id }, data: { revokedAt: new Date() } });

  return emitirSessao(sessao.mailbox, { ip: input.ip, userAgent: input.userAgent });
}

export async function logout(refreshToken: string): Promise<void> {
  await prisma.mailSession.updateMany({
    where: { refreshHash: hashToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function logoutAll(mailboxId: string): Promise<{ revoked: number }> {
  const resultado = await prisma.mailSession.updateMany({
    where: { mailboxId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return { revoked: resultado.count };
}

/**
 * Revoga um dispositivo especifico.
 *
 * O `mailboxId` no `where` nao e decoracao: sem ele, qualquer sessao autenticada
 * derrubaria a sessao de qualquer outra caixa passando o id certo.
 */
export async function revokeSession(mailboxId: string, sessionId: string): Promise<{ revoked: boolean }> {
  const resultado = await prisma.mailSession.updateMany({
    where: { id: sessionId, mailboxId, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  if (resultado.count === 0) throw new AuthError("Sessao nao encontrada.", 404);
  return { revoked: true };
}

export async function listSessions(mailboxId: string) {
  const sessoes = await prisma.mailSession.findMany({
    where: { mailboxId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { lastUsedAt: "desc" },
    select: { id: true, ip: true, userAgent: true, location: true, lastUsedAt: true, createdAt: true },
  });

  // O User-Agent e traduzido na leitura, nao na gravacao: sessao antiga
  // tambem passa a aparecer legivel, sem migrar dado nenhum.
  return sessoes.map((sessao) => {
    const aparelho = descreverAparelho(sessao.userAgent);
    return {
      ...sessao,
      device: aparelho.resumo,
      deviceName: aparelho.aparelho,
      os: aparelho.sistema,
      browser: aparelho.navegador,
    };
  });
}

/**
 * Troca de senha pelo proprio dono. Exige a senha atual e derruba as outras
 * sessoes: se a troca aconteceu porque a senha vazou, deixar sessao antiga
 * viva anula o motivo da troca.
 */
export async function changeOwnPassword(input: {
  mailboxId: string;
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  if (input.newPassword.length < 12) {
    throw new AuthError("A nova senha precisa ter no minimo 12 caracteres.", 422);
  }
  if (input.newPassword === input.currentPassword) {
    throw new AuthError("A nova senha precisa ser diferente da atual.", 422);
  }

  const mailbox = await prisma.mailbox.findUnique({
    where: { id: input.mailboxId },
    select: { passwordHash: true },
  });
  if (!mailbox || !(await verifyPassword(input.currentPassword, mailbox.passwordHash))) {
    throw new AuthError("Senha atual incorreta.");
  }

  await prisma.mailbox.update({
    where: { id: input.mailboxId },
    data: { passwordHash: await hashPassword(input.newPassword), mustChangePassword: false },
  });

  // O dono precisa saber que a senha mudou mesmo quando nao foi ele quem
  // mudou — e o unico aviso possivel de conta tomada.
  void alertarMudanca(input.mailboxId, "senha");

  await logoutAll(input.mailboxId);

  await prisma.mailEvent.create({
    data: { mailboxId: input.mailboxId, type: "mailbox.password_changed_by_owner", payload: {} },
  });

  log.info("senha trocada pelo proprio dono", { mailboxId: input.mailboxId });
}

/** Limpeza periodica: sessoes vencidas e contadores de login antigos. */
export async function cleanupExpired(): Promise<{ sessions: number; attempts: number }> {
  const [sessions, attempts] = await Promise.all([
    prisma.mailSession.deleteMany({ where: { expiresAt: { lt: new Date() } } }),
    prisma.loginAttempt.deleteMany({ where: { windowStart: { lt: new Date(Date.now() - 86_400_000) } } }),
  ]);
  return { sessions: sessions.count, attempts: attempts.count };
}

// ---------------------------------------------------------------------------
// Login pelo SSO (auth.avilaops.com)
// ---------------------------------------------------------------------------

/**
 * Sessao emitida a partir do cookie `avila_sso`, sem senha da caixa.
 *
 * A prova de identidade e o JWT do auth server, verificado aqui com o
 * `SSO_JWT_SECRET` compartilhado. Quem entra e o dono: caixa cujo endereco e
 * o proprio e-mail da conta, ou caixa com `ownerEmail` igual a ele. Com mais
 * de uma caixa e nenhum `address` pedido, devolve a lista para o webmail
 * mostrar o seletor.
 *
 * 2FA da caixa nao e exigida neste caminho de proposito: o segundo fator
 * protege a senha da caixa, e aqui nenhuma senha foi usada — a confianca vem
 * do SSO, que tem os proprios controles.
 */
export type SsoLoginResult = SessionTokens | { choose: { address: string; displayName: string | null }[] };

export async function loginSso(input: {
  ssoToken: string;
  address?: string;
  ip?: string;
  userAgent?: string;
}): Promise<SsoLoginResult> {
  const segredo = process.env.SSO_JWT_SECRET ?? "";
  if (segredo.length < 32) throw new AuthError("Login pelo SSO nao esta habilitado.", 503);

  let email: string;
  try {
    const decoded = jwt.verify(input.ssoToken, segredo, { algorithms: ["HS256"], issuer: "auth.avilaops.com" });
    if (typeof decoded === "string" || typeof decoded.email !== "string") throw new Error("sem email");
    email = decoded.email.toLowerCase();
  } catch {
    throw new AuthError("Sessao do SSO invalida ou expirada.");
  }

  const parsed = parseAddress(email);
  const caixas = await prisma.mailbox.findMany({
    where: {
      status: { in: ["active", "suspended", "disabled"] },
      OR: [
        { ownerEmail: email },
        ...(parsed ? [{ localPart: parsed.localPart, domain: { name: parsed.domain } }] : []),
      ],
    },
    select: {
      id: true,
      localPart: true,
      displayName: true,
      status: true,
      quotaBytes: true,
      usedBytes: true,
      mustChangePassword: true,
      domain: { select: { name: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  if (caixas.length === 0) throw new AuthError("Sua conta Avila Ops nao possui caixa de e-mail.", 404);

  const pedido = input.address?.trim().toLowerCase();
  const escolhida = pedido
    ? caixas.find((c) => `${c.localPart}@${c.domain.name}` === pedido)
    : caixas.length === 1
      ? caixas[0]
      : undefined;

  if (!escolhida) {
    if (pedido) throw new AuthError("Essa caixa nao pertence a sua conta.", 403);
    return { choose: caixas.map((c) => ({ address: `${c.localPart}@${c.domain.name}`, displayName: c.displayName })) };
  }

  if (escolhida.status === "disabled") throw new AuthError("Esta caixa foi desativada. Fale com o suporte.", 403);
  if (escolhida.status === "suspended") {
    throw new AuthError("Caixa suspensa por pendencia financeira. Regularize no painel para reativar.", 403);
  }

  await prisma.mailbox.update({ where: { id: escolhida.id }, data: { lastLoginAt: new Date() } });
  log.info("login via SSO", { mailboxId: escolhida.id, owner: email, ip: input.ip });
  return emitirSessao(escolhida, { ip: input.ip, userAgent: input.userAgent });
}


/**
 * Define a senha no primeiro acesso, sem exigir a senha atual.
 *
 * So funciona enquanto `mustChangePassword` estiver marcado — a senha que
 * entregamos ao criar a caixa. Depois disso, trocar exige a senha atual
 * (`changeOwnPassword`). Nao derruba a sessao corrente: o dono acabou de
 * entrar e segue direto para a caixa.
 */
export async function firstPassword(input: { mailboxId: string; newPassword: string }): Promise<void> {
  if (input.newPassword.length < 12) {
    throw new AuthError("A senha precisa ter no minimo 12 caracteres.", 422);
  }
  const mailbox = await prisma.mailbox.findUnique({
    where: { id: input.mailboxId },
    select: { mustChangePassword: true, passwordHash: true },
  });
  if (!mailbox) throw new AuthError("Caixa nao encontrada.", 404);
  if (!mailbox.mustChangePassword) {
    throw new AuthError("A senha ja foi definida. Para trocar, use a tela de senha.", 409);
  }
  if (await verifyPassword(input.newPassword, mailbox.passwordHash)) {
    throw new AuthError("Escolha uma senha diferente da provisoria.", 422);
  }
  await prisma.mailbox.update({
    where: { id: input.mailboxId },
    data: { passwordHash: await hashPassword(input.newPassword), mustChangePassword: false },
  });
  await prisma.mailEvent.create({
    data: { mailboxId: input.mailboxId, type: "mailbox.first_password_set", payload: {} },
  });
  log.info("senha definida no primeiro acesso", { mailboxId: input.mailboxId });
}
