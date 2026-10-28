import { createPublicKey, type JsonWebKey } from "node:crypto";
import jwt from "jsonwebtoken";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "../lib/db.js";
import { AuthError } from "./authError.js";
import { authBase } from "./ssoContract.js";

const EVENTO_LOGOUT = "http://schemas.openid.net/event/backchannel-logout";
type ChavePublica = JsonWebKey & { kid?: string; alg?: string; use?: string };
let cache: { base: string; quando: number; chaves: ChavePublica[] } | null = null;

async function chaveDoEmissor(kid: string) {
  const base = authBase();
  const agora = Date.now();
  const conhecida = cache?.base === base ? cache.chaves.find((chave) => chave.kid === kid) : undefined;
  if (!cache || cache.base !== base || agora - cache.quando > 300_000 || (!conhecida && agora - cache.quando > 5000)) {
    try {
      const resposta = await fetch(`${base}/oauth/jwks`, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(2000) });
      if (!resposta.ok) throw new Error("emissor indisponivel");
      const dados = await resposta.json() as { keys?: ChavePublica[] };
      if (!Array.isArray(dados.keys) || dados.keys.length > 20) throw new Error("JWKS invalido");
      cache = { base, quando: agora, chaves: dados.keys };
    } catch {
      throw new AuthError("Nao foi possivel conferir o aviso do login unico.", 503);
    }
  }
  const chave = cache?.chaves.find((item) => item.kid === kid);
  if (!chave || chave.kty !== "RSA" || !chave.e || !chave.n || chave.d ||
      (chave.alg && chave.alg !== "RS256") || (chave.use && chave.use !== "sig")) {
    throw new AuthError("Assinatura do aviso invalida.");
  }
  return createPublicKey({ key: chave, format: "jwk" });
}

/** Mesmo lock para emitir, renovar e revogar a identidade entre instancias. */
export async function conferirRevogacaoSso(tx: Prisma.TransactionClient, subject: string, issuedAt: Date, email: string): Promise<void> {
  await tx.$executeRaw`INSERT INTO mail_sso_email_revocations (email, revoked_before)
    VALUES (${email}, ${new Date(0)}) ON CONFLICT (email) DO NOTHING`;
  await tx.$queryRaw`SELECT email FROM mail_sso_email_revocations WHERE email = ${email} FOR UPDATE`;
  const corteEmail = await tx.mailSsoEmailRevocation.findUniqueOrThrow({ where: { email } });
  if (issuedAt <= corteEmail.revokedBefore) throw new AuthError("Sessao do SSO revogada. Entre novamente.", 401, "sso_reauth_required");
  await tx.$executeRaw`INSERT INTO mail_sso_revocations (subject, revoked_before)
    VALUES (${subject}, ${new Date(0)}) ON CONFLICT (subject) DO NOTHING`;
  await tx.$queryRaw`SELECT subject FROM mail_sso_revocations WHERE subject = ${subject} FOR UPDATE`;
  const corte = await tx.mailSsoRevocation.findUniqueOrThrow({ where: { subject } });
  if (issuedAt <= corte.revokedBefore) throw new AuthError("Sessao do SSO revogada. Entre novamente.", 401, "sso_reauth_required");
}

/** Eventos de seguranca do transmissor SSF atual: mesma chave, outro tipo JWT. */
export async function receberSinalSso(token: string): Promise<{ ok: true; revoked: number }> {
  const envelope = jwt.decode(token, { complete: true });
  if (!envelope || envelope.header.alg !== "RS256" || envelope.header.typ !== "secevent+jwt" ||
      typeof envelope.header.kid !== "string" || envelope.header.kid.length > 128) {
    throw new AuthError("Sinal do login unico invalido.");
  }
  const chave = await chaveDoEmissor(envelope.header.kid);
  let dados: jwt.JwtPayload;
  try {
    const verificado = jwt.verify(token, chave, { algorithms: ["RS256"], issuer: "https://auth.avilaops.com",
      audience: process.env.MAIL_SSO_LOGOUT_AUDIENCE ?? "mail" });
    if (typeof verificado === "string" || typeof verificado.iat !== "number" || !Number.isSafeInteger(verificado.iat) ||
        verificado.iat > Date.now() / 1000 + 30 || typeof verificado.jti !== "string" || !verificado.jti ||
        verificado.exp !== undefined || verificado.nonce !== undefined || typeof verificado.events !== "object" ||
        !verificado.events || Array.isArray(verificado.events) || Object.keys(verificado.events).length !== 1) throw new Error("claims invalidos");
    dados = verificado;
  } catch {
    throw new AuthError("Sinal do login unico invalido.");
  }
  const [tipo, conteudo] = Object.entries(dados.events as Record<string, unknown>)[0]!;
  if (tipo === "https://schemas.openid.net/secevent/ssf/event-type/verification") return { ok: true, revoked: 0 };
  if (!["https://schemas.openid.net/secevent/caep/event-type/session-revoked",
    "https://schemas.openid.net/secevent/caep/event-type/credential-change",
    "https://schemas.openid.net/secevent/risc/event-type/account-disabled"].includes(tipo)) {
    throw new AuthError("Tipo de sinal nao suportado.", 400);
  }
  const sujeito = z.object({ format: z.literal("complex"), user: z.object({ format: z.literal("email"), email: z.string().trim().email().max(320) }) }).safeParse(dados.sub_id);
  const evento = z.object({ event_timestamp: z.number().int().nonnegative() }).safeParse(conteudo);
  if (!sujeito.success || !evento.success || evento.data.event_timestamp > Date.now() / 1000 + 30 ||
      evento.data.event_timestamp > dados.iat! + 30) throw new AuthError("Sujeito ou horario do sinal invalido.");
  const email = sujeito.data.user.email.toLowerCase();
  const corte = new Date(evento.data.event_timestamp * 1000);
  const revoked = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO mail_sso_email_revocations (email, revoked_before) VALUES (${email}, ${corte})
      ON CONFLICT (email) DO UPDATE SET revoked_before = GREATEST(mail_sso_email_revocations.revoked_before, EXCLUDED.revoked_before)`;
    const atual = await tx.mailSsoEmailRevocation.findUniqueOrThrow({ where: { email } });
    const resultado = await tx.mailSession.updateMany({ where: { authSource: "sso", ssoEmail: email,
      ssoIssuedAt: { lte: atual.revokedBefore }, revokedAt: null }, data: { revokedAt: new Date(), replacementRefresh: null } });
    await tx.mailSession.updateMany({ where: { authSource: "sso", ssoEmail: email, ssoIssuedAt: { lte: atual.revokedBefore } },
      data: { replacementRefresh: null } });
    return resultado.count;
  });
  return { ok: true, revoked };
}

export async function receberLogoutSso(token: string): Promise<{ ok: true; revoked: number }> {
  const envelope = jwt.decode(token, { complete: true });
  if (!envelope || envelope.header.alg !== "RS256" || envelope.header.typ !== "logout+jwt" ||
      typeof envelope.header.kid !== "string" || envelope.header.kid.length > 128) {
    throw new AuthError("Aviso do login unico invalido.");
  }
  const chave = await chaveDoEmissor(envelope.header.kid);
  let subject: string;
  let corte: Date;
  try {
    const dados = jwt.verify(token, chave, { algorithms: ["RS256"], issuer: "https://auth.avilaops.com",
      audience: process.env.MAIL_SSO_LOGOUT_AUDIENCE ?? "mail" });
    if (typeof dados === "string" || typeof dados.sub !== "string" || !dados.sub || dados.sub.length > 200 ||
        typeof dados.iat !== "number" || !Number.isSafeInteger(dados.iat) || dados.iat > Date.now() / 1000 + 30 ||
        typeof dados.exp !== "number" || dados.exp <= dados.iat || dados.exp - dados.iat > 300 ||
        typeof dados.jti !== "string" || !dados.jti || dados.nonce !== undefined ||
        typeof dados.events !== "object" || !dados.events || Array.isArray(dados.events) ||
        Object.keys(dados.events).length !== 1 || !(EVENTO_LOGOUT in dados.events)) throw new Error("claims invalidos");
    subject = dados.sub;
    corte = new Date(dados.iat * 1000);
  } catch {
    throw new AuthError("Aviso do login unico invalido.");
  }
  const revoked = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO mail_sso_revocations (subject, revoked_before) VALUES (${subject}, ${corte})
      ON CONFLICT (subject) DO UPDATE SET revoked_before = GREATEST(mail_sso_revocations.revoked_before, EXCLUDED.revoked_before)`;
    const corteAtual = await tx.mailSsoRevocation.findUniqueOrThrow({ where: { subject } });
    const resultado = await tx.mailSession.updateMany({
      where: { ssoSubject: subject, ssoIssuedAt: { lte: corteAtual.revokedBefore }, revokedAt: null },
      data: { revokedAt: new Date(), replacementRefresh: null },
    });
    await tx.mailSession.updateMany({ where: { ssoSubject: subject, ssoIssuedAt: { lte: corteAtual.revokedBefore } },
      data: { replacementRefresh: null } });
    return resultado.count;
  });
  return { ok: true, revoked };
}
