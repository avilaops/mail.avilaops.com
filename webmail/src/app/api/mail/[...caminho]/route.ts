import { NextResponse, type NextRequest } from "next/server";
import { chamarApi, chamarBrutoComSessao, chamarComSessao, origemDaRequisicao } from "@/lib/api";
import { csrfValido, limparSessao } from "@/lib/sessao";

/** Rotas que devolvem binario em vez de JSON. */
const EH_DOWNLOAD = /^\/me\/messages\/[\w-]+\/(attachments\/[\w-]+|raw)(\?|$)/;

/**
 * Rotas de recuperacao de senha: as unicas alcancaveis sem sessao.
 *
 * Login, refresh e logout NAO passam por aqui — eles vivem em /api/sessao,
 * onde os cookies sao escritos. Deixar `auth/*` inteiro aberto neste proxy
 * daria um segundo caminho para login, fora da camada que guarda o token.
 */
const SEM_SESSAO = new Set(["auth/forgot-password", "auth/reset-password"]);

/**
 * Proxy autenticado para a API do e-mail.
 *
 * O navegador chama /api/mail/... sem token nenhum; o token sai do cookie
 * httpOnly aqui no servidor. E o unico ponto por onde a pagina alcanca a API,
 * o que concentra a verificacao de CSRF num lugar so.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function encaminhar(request: NextRequest, caminho: string[]): Promise<NextResponse> {
  const rota = caminho.join("/");
  const publica = SEM_SESSAO.has(rota);

  // Defesa em profundidade: a API ja recusaria (o token de sessao nao serve
  // para provisionamento), mas o proxy nem deixa a tentativa sair daqui.
  if (caminho[0] !== "me" && caminho[0] !== "admin" && !publica) {
    return NextResponse.json({ erro: "Rota nao disponivel." }, { status: 404 });
  }

  // CSRF protege sessao existente de ser usada por outro site. Quem pede
  // recuperacao de senha ainda nao tem sessao — nao ha o que sequestrar, e
  // exigir o token la tornaria a tela impossivel de usar. O abuso e contido
  // pelo limite de 3 pedidos por hora, no servidor.
  if (!publica && !csrfValido(request)) {
    return NextResponse.json({ erro: "Token de verificacao ausente ou invalido." }, { status: 403 });
  }

  if (publica) {
    const semSessao = await chamarApi<unknown>(`/${rota}`, {
      method: request.method,
      body: await request.json().catch(() => ({})),
      origem: origemDaRequisicao(request),
    });

    return NextResponse.json(semSessao.ok ? semSessao.dados : { erro: semSessao.erro }, {
      status: semSessao.status,
    });
  }

  const busca = request.nextUrl.search;
  const destino = `/${caminho.join("/")}${busca}`;

  // Fluxo de eventos: o corpo fica aberto e chega aos poucos. Aguardar a
  // resposta inteira para reserializar em JSON, como as demais rotas, travaria
  // a conexao para sempre — o stream nunca "termina".
  if (request.method === "GET" && rota === "me/events") {
    const fluxo = await chamarBrutoComSessao(destino, { semTempoLimite: true });

    if (!fluxo?.ok || !fluxo.body) {
      return NextResponse.json({ erro: "Sessao encerrada. Entre novamente." }, { status: 401 });
    }

    return new NextResponse(fluxo.body, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  }

  // Download (anexo, .eml) passa cru, com os cabecalhos de seguranca que a API
  // define. Reserializar como JSON corromperia o arquivo e derrubaria o
  // Content-Disposition que impede um anexo HTML de abrir na nossa origem.
  if (request.method === "GET" && EH_DOWNLOAD.test(destino)) {
    const bruta = await chamarBrutoComSessao(destino);

    if (!bruta) {
      await limparSessao();
      return NextResponse.json({ erro: "Sessao encerrada. Entre novamente." }, { status: 401 });
    }

    if (!bruta.ok) {
      return NextResponse.json({ erro: "Arquivo indisponivel." }, { status: bruta.status });
    }

    return new NextResponse(bruta.body, {
      status: 200,
      headers: {
        "Content-Type": bruta.headers.get("content-type") ?? "application/octet-stream",
        "Content-Disposition": bruta.headers.get("content-disposition") ?? "attachment",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cache-Control": "private, no-store",
      },
    });
  }

  let corpo: unknown;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      const texto = await request.text();
      corpo = texto ? JSON.parse(texto) : {};
    } catch {
      return NextResponse.json({ erro: "Corpo da requisicao invalido." }, { status: 400 });
    }
  }

  const resposta = await chamarComSessao<unknown>(destino, { method: request.method, body: corpo });

  if (resposta.status === 401) {
    // Sessao morreu de vez: limpa os cookies para a proxima navegacao cair no
    // login em vez de repetir o ciclo de renovacao fracassada.
    await limparSessao();
    return NextResponse.json({ erro: "Sessao encerrada. Entre novamente." }, { status: 401 });
  }

  if (!resposta.ok) {
    return NextResponse.json({ erro: resposta.erro }, { status: resposta.status });
  }

  return NextResponse.json(resposta.dados, { status: resposta.status });
}

export async function GET(request: NextRequest, contexto: { params: Promise<{ caminho: string[] }> }) {
  return encaminhar(request, (await contexto.params).caminho);
}

export async function POST(request: NextRequest, contexto: { params: Promise<{ caminho: string[] }> }) {
  return encaminhar(request, (await contexto.params).caminho);
}

export async function PATCH(request: NextRequest, contexto: { params: Promise<{ caminho: string[] }> }) {
  return encaminhar(request, (await contexto.params).caminho);
}

export async function PUT(request: NextRequest, contexto: { params: Promise<{ caminho: string[] }> }) {
  return encaminhar(request, (await contexto.params).caminho);
}

export async function DELETE(request: NextRequest, contexto: { params: Promise<{ caminho: string[] }> }) {
  return encaminhar(request, (await contexto.params).caminho);
}
