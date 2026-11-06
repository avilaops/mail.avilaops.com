import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { destinoMail } from "@/lib/destinoMail";
import { authBase, webmailBase } from "@/lib/sso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const clientId = process.env.AUTH_CLIENT_ID?.trim();
  const secret = process.env.AUTH_CLIENT_SECRET?.trim();
  if (!clientId || !secret) return NextResponse.redirect(new URL("/entrar?local=1&erro=sso_invalido", webmailBase()));
  const destino = destinoMail(request.nextUrl.searchParams.get("returnTo"));
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const callback = `${webmailBase()}/api/sessao/sso`;
  const location = new URL(`${authBase()}/oauth/authorize`);
  location.search = new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: callback,
    scope: "openid profile email", state, nonce, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
  const jar = await cookies();
  jar.set("mail_oidc_flow", JSON.stringify({ state, nonce, verifier, destino, exp: Date.now() + 600_000 }), { httpOnly: true, secure: location.protocol === "https:", sameSite: "lax", path: "/", maxAge: 600 });
  return NextResponse.redirect(location, 303);
}
