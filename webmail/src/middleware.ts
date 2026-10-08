import { NextResponse, type NextRequest } from "next/server";

/**
 * CSP com nonce por requisicao.
 *
 * O Next injeta scripts inline para inicializar a pagina. Com
 * `script-src 'self'` puro, o navegador bloqueia esses scripts, a pagina nao
 * hidrata e a interface vira HTML morto — o formulario de login chega a fazer
 * submit nativo. Descobri isso rodando a tela num navegador de verdade; o
 * build passa igual.
 *
 * A saida NAO e liberar `'unsafe-inline'`, que abriria justamente o buraco que
 * a CSP existe para fechar num webmail. E gerar um nonce por resposta: o Next
 * reconhece o header e carimba os proprios scripts com ele. Script injetado
 * por um vetor de XSS nao tem como adivinhar o valor.
 *
 * `'strict-dynamic'` deixa os scripts carregados pelos scripts confiaveis
 * herdarem a confianca, o que e como o Next carrega seus proprios pedacos.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");

  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    // `https:` existe por causa do corpo do e-mail. Ele vai num iframe com
    // `srcdoc`, e documento `srcdoc` herda a CSP de quem o embute: com
    // `img-src 'self'` aqui, "Exibir imagens" liberava as imagens no servidor e
    // o navegador recusava todas — a mensagem ficava cheia de imagem quebrada.
    // A CSP do proprio iframe so consegue restringir mais, nunca abrir.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    // O corpo da mensagem vai num iframe sandbox com srcdoc — origem opaca.
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  const cabecalhos = new Headers(request.headers);
  cabecalhos.set("x-nonce", nonce);
  cabecalhos.set("Content-Security-Policy", csp);

  const resposta = NextResponse.next({ request: { headers: cabecalhos } });
  resposta.headers.set("Content-Security-Policy", csp);

  return resposta;
}

export const config = {
  matcher: [
    {
      // Estatico e rota de API ficam de fora: asset com nonce nao seria
      // cacheavel, e a API responde JSON, onde CSP nao tem efeito.
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
