import type { IncomingMessage, ServerResponse } from "node:http";
import { XMLParser } from "fast-xml-parser";
import { createLogger } from "../lib/logger.js";
import { autenticarCaixa, type CaixaAutenticada } from "../services/mailboxAuth.js";
import {
  DavError,
  type Colecao,
  ctag,
  excluirItem,
  gravarItem,
  listarItens,
  listarComDados,
  mudancasDesde,
  obterItem,
  obterVarios,
} from "./store.js";

const log = createLogger("dav");

/**
 * Servidor CardDAV (RFC 6352) e CalDAV (RFC 4791) — o subconjunto que
 * cliente real usa: descoberta por PROPFIND, os REPORTs multiget/query e
 * sync-collection (RFC 6578), e GET/PUT/DELETE com ETag.
 *
 * Mesma regra do IMAP: capability anunciada e capability cumprida. O que nao
 * esta aqui (agendas multiplas, compartilhamento, scheduling) nao e anunciado
 * em lugar nenhum — cliente que nao ve, nao pede.
 *
 * Autentica por Basic sobre o TLS do Caddy, com as MESMAS travas de forca
 * bruta dos outros protocolos (autenticarCaixa). A 2FA nao se aplica aqui
 * pelo mesmo motivo do IMAP: e o que os aplicativos sabem falar.
 */

const NS = 'xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/"';

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // XML e de quem chama: nada de entidades externas ou expansao esperta.
  processEntities: false,
});

function esc(texto: string): string {
  return texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function arr<T>(valor: T | T[] | undefined): T[] {
  if (valor === undefined) return [];
  return Array.isArray(valor) ? valor : [valor];
}

function enviarXml(res: ServerResponse, status: number, corpo: string): void {
  const bytes = Buffer.from(corpo, "utf8");
  res.writeHead(status, {
    "Content-Type": 'application/xml; charset="utf-8"',
    "Content-Length": bytes.byteLength,
  });
  res.end(bytes);
}

function enviarStatus(res: ServerResponse, status: number, headers: Record<string, string | number> = {}): void {
  res.writeHead(status, { "Content-Length": 0, ...headers });
  res.end();
}

async function lerCorpo(req: IncomingMessage, maxBytes: number): Promise<string> {
  const partes: Buffer[] = [];
  let total = 0;
  for await (const pedaco of req) {
    const buf = pedaco as Buffer;
    total += buf.byteLength;
    if (total > maxBytes) throw new DavError("Corpo grande demais.", 413);
    partes.push(buf);
  }
  return Buffer.concat(partes).toString("utf8");
}

// ---------------------------------------------------------------------------
// Espaco de URLs
// ---------------------------------------------------------------------------

type Recurso =
  | { tipo: "root" }
  | { tipo: "principal" }
  | { tipo: "home"; colecao: Colecao }
  | { tipo: "colecao"; colecao: Colecao }
  | { tipo: "item"; colecao: Colecao; href: string };

const NOME_COLECAO: Record<Colecao, string> = { contacts: "contatos", calendar: "agenda" };
const RAMO: Record<Colecao, string> = { contacts: "addressbooks", calendar: "calendars" };
const ROTULO: Record<Colecao, string> = { contacts: "Contatos", calendar: "Agenda" };
const CONTENT_TYPE: Record<Colecao, string> = {
  contacts: "text/vcard; charset=utf-8",
  calendar: "text/calendar; charset=utf-8",
};

function urlPrincipal(addr: string): string {
  return `/dav/principals/${encodeURIComponent(addr)}/`;
}
function urlHome(colecao: Colecao, addr: string): string {
  return `/dav/${RAMO[colecao]}/${encodeURIComponent(addr)}/`;
}
function urlColecao(colecao: Colecao, addr: string): string {
  return `${urlHome(colecao, addr)}${NOME_COLECAO[colecao]}/`;
}
function urlItem(colecao: Colecao, addr: string, href: string): string {
  return `${urlColecao(colecao, addr)}${encodeURIComponent(href)}`;
}

/**
 * Resolve o caminho e confere a posse: o endereco embutido na URL precisa
 * ser o da caixa autenticada — sem isso, qualquer senha valida navegaria a
 * agenda dos outros trocando o endereco na URL.
 */
function resolver(path: string, addr: string): Recurso | null {
  const partes = path
    .replace(/^\/dav\/?/, "")
    .split("/")
    .filter((parte) => parte !== "")
    .map(decodeURIComponent);

  if (partes.length === 0) return { tipo: "root" };

  const [raiz, dono, nomeColecao, itemHref, sobra] = partes;
  if (sobra !== undefined) return null;

  if (raiz === "principals") {
    if (dono !== addr || nomeColecao !== undefined) return null;
    return { tipo: "principal" };
  }

  const colecao: Colecao | null = raiz === "addressbooks" ? "contacts" : raiz === "calendars" ? "calendar" : null;
  if (!colecao || dono !== addr) return null;

  if (nomeColecao === undefined) return { tipo: "home", colecao };
  if (nomeColecao !== NOME_COLECAO[colecao]) return null;
  if (itemHref === undefined) return { tipo: "colecao", colecao };
  return { tipo: "item", colecao, href: itemHref };
}

// ---------------------------------------------------------------------------
// PROPFIND
// ---------------------------------------------------------------------------

interface Prop {
  nome: string;
  xml: string;
}

function propsDoRecurso(recurso: Recurso, addr: string, ctagAtual: string | null): Prop[] {
  const principal = `<d:current-user-principal><d:href>${urlPrincipal(addr)}</d:href></d:current-user-principal>`;
  const dono = `<d:owner><d:href>${urlPrincipal(addr)}</d:href></d:owner>`;
  const privilegios =
    "<d:current-user-privilege-set><d:privilege><d:all/></d:privilege><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set>";

  const comuns: Prop[] = [
    { nome: "current-user-principal", xml: principal },
    { nome: "current-user-privilege-set", xml: privilegios },
  ];

  if (recurso.tipo === "root") {
    return [
      { nome: "resourcetype", xml: "<d:resourcetype><d:collection/></d:resourcetype>" },
      { nome: "displayname", xml: "<d:displayname>Avila Mail DAV</d:displayname>" },
      ...comuns,
    ];
  }

  if (recurso.tipo === "principal") {
    return [
      { nome: "resourcetype", xml: "<d:resourcetype><d:principal/></d:resourcetype>" },
      { nome: "displayname", xml: `<d:displayname>${esc(addr)}</d:displayname>` },
      { nome: "principal-URL", xml: `<d:principal-URL><d:href>${urlPrincipal(addr)}</d:href></d:principal-URL>` },
      {
        nome: "addressbook-home-set",
        xml: `<card:addressbook-home-set><d:href>${urlHome("contacts", addr)}</d:href></card:addressbook-home-set>`,
      },
      {
        nome: "calendar-home-set",
        xml: `<cal:calendar-home-set><d:href>${urlHome("calendar", addr)}</d:href></cal:calendar-home-set>`,
      },
      ...comuns,
    ];
  }

  if (recurso.tipo === "home") {
    return [
      { nome: "resourcetype", xml: "<d:resourcetype><d:collection/></d:resourcetype>" },
      { nome: "displayname", xml: `<d:displayname>${ROTULO[recurso.colecao]}</d:displayname>` },
      { nome: "owner", xml: dono },
      ...comuns,
    ];
  }

  if (recurso.tipo === "colecao") {
    const tipoExtra = recurso.colecao === "contacts" ? "<card:addressbook/>" : "<cal:calendar/>";
    const reports =
      recurso.colecao === "contacts"
        ? "<d:supported-report><d:report><card:addressbook-multiget/></d:report></d:supported-report><d:supported-report><d:report><card:addressbook-query/></d:report></d:supported-report>"
        : "<d:supported-report><d:report><cal:calendar-multiget/></d:report></d:supported-report><d:supported-report><d:report><cal:calendar-query/></d:report></d:supported-report>";

    const props: Prop[] = [
      { nome: "resourcetype", xml: `<d:resourcetype><d:collection/>${tipoExtra}</d:resourcetype>` },
      { nome: "displayname", xml: `<d:displayname>${ROTULO[recurso.colecao]}</d:displayname>` },
      { nome: "owner", xml: dono },
      {
        nome: "supported-report-set",
        xml: `<d:supported-report-set>${reports}<d:supported-report><d:report><d:sync-collection/></d:report></d:supported-report></d:supported-report-set>`,
      },
      { nome: "getctag", xml: `<cs:getctag>${ctagAtual ?? "0"}</cs:getctag>` },
      { nome: "sync-token", xml: `<d:sync-token>avila-mail-sync-${ctagAtual ?? "0"}</d:sync-token>` },
      ...comuns,
    ];

    if (recurso.colecao === "calendar") {
      props.push({
        nome: "supported-calendar-component-set",
        xml: '<cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>',
      });
    }

    return props;
  }

  return comuns;
}

function propsDeItem(colecao: Colecao, etag: string): Prop[] {
  return [
    { nome: "resourcetype", xml: "<d:resourcetype/>" },
    { nome: "getetag", xml: `<d:getetag>"${etag}"</d:getetag>` },
    { nome: "getcontenttype", xml: `<d:getcontenttype>${CONTENT_TYPE[colecao]}</d:getcontenttype>` },
  ];
}

/** Nomes de propriedade pedidos no corpo do PROPFIND; null = allprop. */
function propsPedidas(corpo: string): string[] | null {
  if (!corpo.trim()) return null;
  let raiz: unknown;
  try {
    raiz = parser.parse(corpo);
  } catch {
    throw new DavError("XML invalido.", 400);
  }

  const propfind = (raiz as Record<string, unknown>).propfind as Record<string, unknown> | undefined;
  if (!propfind || "allprop" in propfind) return null;
  const prop = propfind.prop as Record<string, unknown> | undefined;
  if (!prop) return null;
  return Object.keys(prop).filter((nome) => !nome.startsWith("@_"));
}

function montarResposta(href: string, disponiveis: Prop[], pedidas: string[] | null): string {
  const achadas = pedidas === null ? disponiveis : disponiveis.filter((prop) => pedidas.includes(prop.nome));
  const perdidas = pedidas === null ? [] : pedidas.filter((nome) => !disponiveis.some((prop) => prop.nome === nome));

  let corpo = `<d:response><d:href>${esc(href)}</d:href>`;
  corpo += `<d:propstat><d:prop>${achadas.map((prop) => prop.xml).join("")}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>`;
  if (perdidas.length > 0) {
    // Propriedade que nao existe leva 404 no propstat — cliente que pediu
    // quota-available-bytes precisa da resposta, nao de um palpite.
    corpo += `<d:propstat><d:prop>${perdidas.map((nome) => `<d:${esc(nome)}/>`).join("")}</d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat>`;
  }
  return `${corpo}</d:response>`;
}

async function propfind(
  res: ServerResponse,
  recurso: Recurso,
  addr: string,
  mailboxId: string,
  profundidade: string,
  corpo: string,
): Promise<void> {
  const pedidas = propsPedidas(corpo);

  const ctagAtual =
    recurso.tipo === "colecao" || recurso.tipo === "item"
      ? await ctag(mailboxId, recurso.tipo === "colecao" ? recurso.colecao : recurso.colecao)
      : null;

  const respostas: string[] = [];

  if (recurso.tipo === "item") {
    const item = await obterItem(mailboxId, recurso.colecao, recurso.href);
    if (!item) throw new DavError("Recurso nao encontrado.", 404);
    respostas.push(
      montarResposta(urlItem(recurso.colecao, addr, recurso.href), propsDeItem(recurso.colecao, item.etag), pedidas),
    );
  } else {
    const hrefProprio =
      recurso.tipo === "root"
        ? "/dav/"
        : recurso.tipo === "principal"
          ? urlPrincipal(addr)
          : recurso.tipo === "home"
            ? urlHome(recurso.colecao, addr)
            : urlColecao(recurso.colecao, addr);

    respostas.push(montarResposta(hrefProprio, propsDoRecurso(recurso, addr, ctagAtual), pedidas));

    if (profundidade !== "0") {
      if (recurso.tipo === "home") {
        const filho: Recurso = { tipo: "colecao", colecao: recurso.colecao };
        const ctagFilho = await ctag(mailboxId, recurso.colecao);
        respostas.push(
          montarResposta(urlColecao(recurso.colecao, addr), propsDoRecurso(filho, addr, ctagFilho), pedidas),
        );
      }
      if (recurso.tipo === "colecao") {
        for (const item of await listarItens(mailboxId, recurso.colecao)) {
          respostas.push(
            montarResposta(urlItem(recurso.colecao, addr, item.href), propsDeItem(recurso.colecao, item.etag), pedidas),
          );
        }
      }
    }
  }

  enviarXml(res, 207, `<?xml version="1.0" encoding="utf-8"?><d:multistatus ${NS}>${respostas.join("")}</d:multistatus>`);
}

// ---------------------------------------------------------------------------
// REPORT
// ---------------------------------------------------------------------------

function respostaComDados(colecao: Colecao, addr: string, href: string, etag: string, dados: string): string {
  const elemento = colecao === "contacts" ? "card:address-data" : "cal:calendar-data";
  return (
    `<d:response><d:href>${esc(urlItem(colecao, addr, href))}</d:href><d:propstat><d:prop>` +
    `<d:getetag>"${etag}"</d:getetag><${elemento}>${esc(dados)}</${elemento}>` +
    `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`
  );
}

/** Procura um time-range em qualquer nivel do filtro do calendar-query. */
function acharTimeRange(no: unknown): { start: Date | null; end: Date | null } | null {
  if (typeof no !== "object" || no === null) return null;
  const objeto = no as Record<string, unknown>;

  if (objeto["time-range"] !== undefined) {
    const tr = objeto["time-range"] as Record<string, unknown>;
    const lerData = (valor: unknown): Date | null => {
      if (typeof valor !== "string") return null;
      const m = valor.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
      if (!m) return null;
      return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])));
    };
    return { start: lerData(tr["@_start"]), end: lerData(tr["@_end"]) };
  }

  for (const valor of Object.values(objeto)) {
    if (typeof valor === "object" && valor !== null) {
      const achado = acharTimeRange(valor);
      if (achado) return achado;
    }
  }
  return null;
}

async function report(
  res: ServerResponse,
  recurso: Recurso,
  addr: string,
  mailboxId: string,
  corpo: string,
): Promise<void> {
  if (recurso.tipo !== "colecao") throw new DavError("REPORT so vale em colecao.", 403);
  const colecao = recurso.colecao;

  let raiz: Record<string, unknown>;
  try {
    raiz = parser.parse(corpo) as Record<string, unknown>;
  } catch {
    throw new DavError("XML invalido.", 400);
  }

  const respostas: string[] = [];

  const multiget = (raiz["addressbook-multiget"] ?? raiz["calendar-multiget"]) as
    | Record<string, unknown>
    | undefined;
  if (multiget) {
    const hrefs = arr(multiget.href as string | string[] | undefined)
      .map((completo) => decodeURIComponent(String(completo).split("/").filter(Boolean).pop() ?? ""))
      .filter((nome) => nome !== "");

    const achados = new Map((await obterVarios(mailboxId, colecao, hrefs)).map((item) => [item.href, item]));
    for (const href of hrefs) {
      const item = achados.get(href);
      if (item) {
        respostas.push(respostaComDados(colecao, addr, item.href, item.etag, item.data));
      } else {
        respostas.push(
          `<d:response><d:href>${esc(urlItem(colecao, addr, href))}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`,
        );
      }
    }

    enviarXml(res, 207, `<?xml version="1.0" encoding="utf-8"?><d:multistatus ${NS}>${respostas.join("")}</d:multistatus>`);
    return;
  }

  const query = (raiz["addressbook-query"] ?? raiz["calendar-query"]) as Record<string, unknown> | undefined;
  if (query) {
    /**
     * Filtro aplicado como SUPERCONJUNTO: texto do addressbook-query e
     * ignorado (devolve tudo) e o time-range corta pela janela indexada,
     * mantendo sempre os recorrentes. Devolver a mais nunca perde dado do
     * cliente; devolver a menos faria compromisso sumir do celular.
     */
    const janela = colecao === "calendar" ? acharTimeRange(query.filter) : null;
    let itens = await listarComDados(mailboxId, colecao);

    if (janela?.start || janela?.end) {
      itens = itens.filter((item) => {
        if (item.recurring || !item.dtStart) return true;
        const fim = item.dtEnd ?? item.dtStart;
        if (janela.end && item.dtStart >= janela.end) return false;
        if (janela.start && fim <= janela.start) return false;
        return true;
      });
    }

    for (const item of itens) respostas.push(respostaComDados(colecao, addr, item.href, item.etag, item.data));
    enviarXml(res, 207, `<?xml version="1.0" encoding="utf-8"?><d:multistatus ${NS}>${respostas.join("")}</d:multistatus>`);
    return;
  }

  const sync = raiz["sync-collection"] as Record<string, unknown> | undefined;
  if (sync) {
    const token = typeof sync["sync-token"] === "string" ? (sync["sync-token"] as string) : null;
    const mudancas = await mudancasDesde(mailboxId, colecao, token);

    for (const item of mudancas.alterados) {
      respostas.push(
        `<d:response><d:href>${esc(urlItem(colecao, addr, item.href))}</d:href><d:propstat><d:prop>` +
          `<d:getetag>"${item.etag}"</d:getetag><d:getcontenttype>${CONTENT_TYPE[colecao]}</d:getcontenttype>` +
          `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
      );
    }
    for (const href of mudancas.excluidos) {
      respostas.push(
        `<d:response><d:href>${esc(urlItem(colecao, addr, href))}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`,
      );
    }

    enviarXml(
      res,
      207,
      `<?xml version="1.0" encoding="utf-8"?><d:multistatus ${NS}>${respostas.join("")}<d:sync-token>${esc(mudancas.syncToken)}</d:sync-token></d:multistatus>`,
    );
    return;
  }

  throw new DavError("REPORT desconhecido.", 403);
}

// ---------------------------------------------------------------------------
// Entrada
// ---------------------------------------------------------------------------

async function autenticar(req: IncomingMessage): Promise<CaixaAutenticada | null> {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return null;

  let usuario = "";
  let senha = "";
  try {
    const decodificado = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separador = decodificado.indexOf(":");
    if (separador === -1) return null;
    usuario = decodificado.slice(0, separador);
    senha = decodificado.slice(separador + 1);
  } catch {
    return null;
  }

  const ip = req.socket.remoteAddress ?? "desconhecido";
  const resultado = await autenticarCaixa(usuario, senha, ip, "dav");
  return resultado.ok ? resultado.caixa : null;
}

function exigirAutenticacao(res: ServerResponse): void {
  res.writeHead(401, {
    "WWW-Authenticate": 'Basic realm="Avila Mail", charset="UTF-8"',
    "Content-Length": 0,
  });
  res.end();
}

/**
 * Trata a requisicao se ela for do espaco DAV.
 * @returns true quando tratada; false para o roteador da API seguir adiante.
 */
export async function handleDav(req: IncomingMessage, res: ServerResponse, path: string): Promise<boolean> {
  // Descoberta padrao dos clientes (RFC 6764): well-known redireciona.
  if (path === "/.well-known/carddav" || path === "/.well-known/caldav") {
    res.writeHead(301, { Location: "/dav/", "Content-Length": 0 });
    res.end();
    return true;
  }

  if (path !== "/dav" && !path.startsWith("/dav/")) return false;

  const method = (req.method ?? "GET").toUpperCase();

  try {
    const caixa = await autenticar(req);
    if (!caixa) {
      exigirAutenticacao(res);
      return true;
    }

    const recurso = resolver(path, caixa.address);
    if (!recurso) throw new DavError("Recurso nao encontrado.", 404);

    if (method === "OPTIONS") {
      res.writeHead(200, {
        DAV: "1, 3, addressbook, calendar-access",
        Allow: "OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, REPORT",
        "Content-Length": 0,
      });
      res.end();
      return true;
    }

    if (method === "PROPFIND") {
      const corpo = await lerCorpo(req, 1024 * 1024);
      const profundidade = String(req.headers.depth ?? "0");
      await propfind(res, recurso, caixa.address, caixa.id, profundidade, corpo);
      return true;
    }

    if (method === "REPORT") {
      const corpo = await lerCorpo(req, 1024 * 1024);
      await report(res, recurso, caixa.address, caixa.id, corpo);
      return true;
    }

    // Cliente que tenta gravar displayname ou cor da agenda: recusar com
    // educacao (207 com 403 por propriedade) em vez de quebrar o sync.
    if (method === "PROPPATCH") {
      await lerCorpo(req, 1024 * 1024);
      const hrefProprio = path.endsWith("/") ? path : `${path}/`;
      enviarXml(
        res,
        207,
        `<?xml version="1.0" encoding="utf-8"?><d:multistatus ${NS}><d:response><d:href>${esc(hrefProprio)}</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response></d:multistatus>`,
      );
      return true;
    }

    if (method === "MKCOL" || method === "MKCALENDAR") {
      // As colecoes sao fixas (uma de contatos, uma de agenda por caixa).
      throw new DavError("Colecoes sao fixas nesta conta.", 405);
    }

    if (recurso.tipo !== "item") {
      if (method === "GET" || method === "HEAD") throw new DavError("Recurso nao encontrado.", 404);
      throw new DavError("Metodo nao permitido.", 405);
    }

    if (method === "GET" || method === "HEAD") {
      const item = await obterItem(caixa.id, recurso.colecao, recurso.href);
      if (!item) throw new DavError("Recurso nao encontrado.", 404);
      const bytes = Buffer.from(item.data, "utf8");
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPE[recurso.colecao],
        ETag: `"${item.etag}"`,
        "Content-Length": bytes.byteLength,
      });
      res.end(method === "HEAD" ? undefined : bytes);
      return true;
    }

    if (method === "PUT") {
      const corpo = await lerCorpo(req, 1024 * 1024);
      const ifMatch = req.headers["if-match"];
      const ifNoneMatch = req.headers["if-none-match"];

      const resultado = await gravarItem({
        mailboxId: caixa.id,
        colecao: recurso.colecao,
        href: recurso.href,
        corpo,
        ifMatch: typeof ifMatch === "string" ? ifMatch.replace(/^"|"$/g, "") : undefined,
        ifNoneMatchAll: ifNoneMatch === "*",
      });

      enviarStatus(res, resultado.created ? 201 : 204, { ETag: `"${resultado.etag}"` });
      return true;
    }

    if (method === "DELETE") {
      await excluirItem(caixa.id, recurso.colecao, recurso.href);
      enviarStatus(res, 204);
      return true;
    }

    throw new DavError("Metodo nao permitido.", 405);
  } catch (error) {
    if (error instanceof DavError) {
      enviarStatus(res, error.statusCode);
      return true;
    }

    log.error("erro no DAV", {
      method,
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    enviarStatus(res, 500);
    return true;
  }
}
