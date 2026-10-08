import { NextResponse, type NextRequest } from "next/server";
import { chamarApi, origemDaRequisicao } from "@/lib/api";
import { csrfValido, gravarSessao, limparSessao, tokenDeRefresh } from "@/lib/sessao";

/**
 * Login e logout.
 *
 * O par de tokens da API nunca chega ao navegador como valor legivel: entra
 * direto em cookie httpOnly. A pagina recebe so o token CSRF e os dados da
 * caixa para exibir.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RespostaLogin {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  mailbox: { id: string; address: string; displayName: string | null; mustChangePassword?: boolean };
}

/** Caixa com 2FA: a senha passou, falta o codigo do autenticador. */
interface RespostaDuasEtapas {
  requiresTotp: true;
  totpToken: string;
}

export async function POST(request: NextRequest) {
  // O aparelho e o IP que a API vai gravar na sessao sao os de quem esta no
  // navegador — nao os deste processo.
  const origem = origemDaRequisicao(request);

  let corpo: unknown;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ erro: "Requisicao invalida." }, { status: 400 });
  }

  const { address, password, totpToken, code } = (corpo ?? {}) as {
    address?: string;
    password?: string;
    totpToken?: string;
    code?: string;
  };

  // Segunda etapa: o navegador volta com o token intermediario e o codigo.
  if (totpToken && code) {
    const resposta = await chamarApi<RespostaLogin>("/auth/totp", {
      method: "POST",
      body: { totpToken, code },
      origem,
    });
    if (!resposta.ok || !resposta.dados) {
      return NextResponse.json({ erro: resposta.erro ?? "Codigo invalido." }, { status: resposta.status });
    }
    const csrf = await gravarSessao(resposta.dados, {
      precisaTrocarSenha: resposta.dados.mailbox.mustChangePassword,
    });
    return NextResponse.json({ csrf, mailbox: resposta.dados.mailbox });
  }

  if (!address || !password) {
    return NextResponse.json({ erro: "Informe o endereco e a senha." }, { status: 400 });
  }

  const resposta = await chamarApi<RespostaLogin | RespostaDuasEtapas>("/auth/login", {
    method: "POST",
    body: { address, password },
    origem,
  });

  if (!resposta.ok || !resposta.dados) {
    // Repassa o status da API para preservar a distincao entre credencial
    // errada (401) e bloqueio por tentativas (429), que a tela trata diferente.
    return NextResponse.json({ erro: resposta.erro ?? "Nao foi possivel entrar." }, { status: resposta.status });
  }

  // 2FA ativa: nenhum cookie ainda — a sessao so nasce com o codigo.
  if ("requiresTotp" in resposta.dados) {
    return NextResponse.json({ requiresTotp: true, totpToken: resposta.dados.totpToken });
  }

  const csrf = await gravarSessao(resposta.dados, {
    precisaTrocarSenha: resposta.dados.mailbox.mustChangePassword,
  });

  return NextResponse.json({
    csrf,
    mailbox: resposta.dados.mailbox,
  });
}

export async function DELETE(request: NextRequest) {
  if (!csrfValido(request)) {
    return NextResponse.json({ erro: "Token de verificacao ausente." }, { status: 403 });
  }

  const refresh = await tokenDeRefresh();

  // Revoga no servidor antes de limpar aqui: apagar so o cookie deixaria o
  // refresh valido por 30 dias na mao de quem tivesse copiado.
  if (refresh) {
    await chamarApi("/auth/logout", { method: "POST", body: { refreshToken: refresh } });
  }

  await limparSessao();
  return NextResponse.json({ ok: true });
}
