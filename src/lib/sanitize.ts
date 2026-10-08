import sanitizeHtml from "sanitize-html";

/**
 * Sanitizacao do corpo HTML antes de entregar ao webmail.
 *
 * E-mail e conteudo hostil por definicao: qualquer um do planeta pode mandar
 * HTML para a caixa do seu cliente. Renderizar isso cru e XSS com sessao
 * autenticada do lado de dentro.
 *
 * A limpeza acontece na LEITURA, nao na gravacao — o .eml original fica
 * intacto em disco. Assim, quando a lista de permissao mudar (e ela vai
 * mudar), a correcao vale para as mensagens antigas tambem, sem reprocessar
 * nada.
 */

/** Imagem remota vira placeholder ate o usuario liberar (o classico "exibir imagens"). */
const PIXEL_TRANSPARENTE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const OPCOES: sanitizeHtml.IOptions = {
  allowedTags: [
    "p", "div", "span", "br", "hr",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "strong", "b", "em", "i", "u", "s", "sub", "sup", "small",
    "ul", "ol", "li", "dl", "dt", "dd",
    "blockquote", "pre", "code",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
    "a", "img", "figure", "figcaption",
  ],
  allowedAttributes: {
    // target e rel precisam estar aqui: o transformTags abaixo os injeta, e o
    // sanitizador remove qualquer atributo fora desta lista DEPOIS da
    // transformacao — sem isso o rel de seguranca era adicionado e descartado.
    a: ["href", "title", "target", "rel"],
    img: ["src", "alt", "title", "width", "height"],
    "*": ["style", "align", "colspan", "rowspan", "dir"],
  },
  // Sem javascript:, sem vbscript:, sem file:. cid: fica de fora porque anexo
  // embutido e servido pela rota propria de anexo, nao inline.
  allowedSchemes: ["http", "https", "mailto", "tel"],
  allowedSchemesByTag: { img: ["http", "https", "data"] },
  allowProtocolRelative: false,
  // Estilo inline e o que faz e-mail de marketing parecer e-mail de marketing;
  // remover tudo deixa a mensagem irreconhecivel. Permitimos so o que nao
  // reposiciona elemento nem carrega recurso externo.
  allowedStyles: {
    "*": {
      color: [/^#[0-9a-f]{3,8}$/i, /^rgba?\(/i, /^[a-z-]+$/i],
      "background-color": [/^#[0-9a-f]{3,8}$/i, /^rgba?\(/i, /^[a-z-]+$/i],
      "text-align": [/^(left|right|center|justify)$/],
      "font-size": [/^\d+(\.\d+)?(px|em|rem|pt|%)$/],
      "font-weight": [/^(normal|bold|bolder|lighter|\d{3})$/],
      "font-style": [/^(normal|italic|oblique)$/],
      "font-family": [/^[\w\s,'"-]+$/],
      "text-decoration": [/^[a-z\s-]+$/],
      padding: [/^[\d\s.a-z%]+$/],
      margin: [/^[\d\s.a-z%]+$/],
      border: [/^[\d\s.a-z#%(),]+$/],
      width: [/^\d+(\.\d+)?(px|em|rem|%)$/],
      "max-width": [/^\d+(\.\d+)?(px|em|rem|%)$/],
    },
  },
  transformTags: {
    // Link de e-mail sempre abre fora e sem vazar a URL do webmail no Referer.
    a: (tagName, attribs) => ({
      tagName,
      attribs: { ...attribs, target: "_blank", rel: "noopener noreferrer nofollow" },
    }),
  },
  disallowedTagsMode: "discard",
};

export interface HtmlSanitizado {
  html: string;
  /** Quantas imagens remotas foram bloqueadas — o webmail usa para o aviso. */
  imagensBloqueadas: number;
}

/**
 * @param exibirImagensRemotas quando falso, troca `src` externo por um pixel e
 * guarda o original em `data-src`. Imagem remota e o rastreador de leitura mais
 * comum que existe; o padrao e bloquear.
 */
export function sanitizeMessageHtml(html: string, exibirImagensRemotas = false): HtmlSanitizado {
  let imagensBloqueadas = 0;

  const opcoes: sanitizeHtml.IOptions = exibirImagensRemotas
    ? OPCOES
    : {
        ...OPCOES,
        allowedAttributes: { ...OPCOES.allowedAttributes, img: ["alt", "title", "width", "height", "data-src"] },
        transformTags: {
          ...OPCOES.transformTags,
          img: (tagName, attribs) => {
            const original = attribs.src ?? "";
            const remota = /^https?:/i.test(original);
            if (remota) imagensBloqueadas += 1;
            const { src: _descartado, ...resto } = attribs;
            return {
              tagName,
              attribs: remota
                ? { ...resto, src: PIXEL_TRANSPARENTE, "data-src": original }
                : { ...resto, src: original },
            };
          },
        },
      };

  return { html: sanitizeHtml(html, opcoes), imagensBloqueadas };
}

/** Versao texto para preview e busca, quando a mensagem so veio em HTML. */
export function htmlParaTexto(html: string): string {
  return sanitizeHtml(html, { allowedTags: [], allowedAttributes: {} })
    .replace(/\s+/g, " ")
    .trim();
}
