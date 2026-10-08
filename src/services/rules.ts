import { prisma } from "../lib/db.js";
import { parseAddress } from "../lib/address.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("rules");

/**
 * Regras de triagem da caixa (Fase 6): "quando chegar mensagem assim, faca
 * isto". O dono cria pela tela de conta; a entrega aplica antes de gravar.
 *
 * Duas decisoes de desenho que definem o comportamento:
 *
 * 1. A PRIMEIRA regra que casa decide, na ordem da lista. Acumular acoes de
 *    varias regras parece mais poderoso, mas torna impossivel responder "por
 *    que esta mensagem foi parar ali?" — e essa pergunta e o suporte inteiro
 *    de filtros. Quem precisa de duas acoes poe as duas na mesma regra.
 * 2. Spam nao passa por regra. A quarentena existe para proteger o cliente;
 *    uma regra "mover para Projetos" que resgatasse spam viraria o caminho
 *    padrao de phishing com assunto bem escolhido.
 */

export class RuleError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = "RuleError";
  }
}

export interface RuleCondition {
  field: "from" | "to" | "subject" | "has_attachment";
  /** Obrigatorio nos campos de texto; ignorado em has_attachment. */
  contains?: string;
}

export interface RuleActions {
  /** Pasta destino; ausente = fica na Entrada. */
  folderId?: string | null;
  markRead?: boolean;
  star?: boolean;
  /**
   * Encaminha uma COPIA para este endereco. A mensagem continua sendo
   * entregue na caixa (com as demais acoes) — regra de encaminhamento que
   * desvia sem guardar e mensagem perdida no primeiro erro de digitacao.
   */
  forwardTo?: string | null;
}

export interface RuleInput {
  name: string;
  match: "all" | "any";
  conditions: RuleCondition[];
  actions: RuleActions;
  enabled?: boolean;
}

/** Visao da mensagem que as condicoes enxergam. */
export interface MensagemParaRegra {
  from: string;
  /** To e Cc juntos: para o cliente, "para mim" inclui copia. */
  to: string[];
  subject: string;
  hasAttachments: boolean;
}

const MAX_REGRAS = 50;

/**
 * Avaliacao pura de uma regra — sem banco, para o teste de smoke exercitar
 * cada combinacao sem subir Postgres.
 */
export function regraCasa(
  match: "all" | "any",
  conditions: RuleCondition[],
  mensagem: MensagemParaRegra,
): boolean {
  if (conditions.length === 0) return false;

  const resultado = (condition: RuleCondition): boolean => {
    if (condition.field === "has_attachment") return mensagem.hasAttachments;

    const agulha = (condition.contains ?? "").toLowerCase();
    if (!agulha) return false;

    if (condition.field === "from") return mensagem.from.toLowerCase().includes(agulha);
    if (condition.field === "subject") return mensagem.subject.toLowerCase().includes(agulha);
    return mensagem.to.some((endereco) => endereco.toLowerCase().includes(agulha));
  };

  return match === "all" ? conditions.every(resultado) : conditions.some(resultado);
}

function validar(input: RuleInput): void {
  if (!input.name.trim()) throw new RuleError("A regra precisa de um nome.");
  if (input.conditions.length === 0) throw new RuleError("A regra precisa de ao menos uma condicao.");
  if (input.conditions.length > 10) throw new RuleError("Maximo de 10 condicoes por regra.");

  for (const condition of input.conditions) {
    if (condition.field !== "has_attachment") {
      const texto = condition.contains?.trim() ?? "";
      if (!texto) throw new RuleError("Condicao de texto precisa do que procurar.");
      if (texto.length > 200) throw new RuleError("Texto da condicao longo demais.");
    }
  }

  const acoes = input.actions;
  if (!acoes.folderId && !acoes.markRead && !acoes.star && !acoes.forwardTo) {
    throw new RuleError("A regra precisa de ao menos uma acao.");
  }
}

/**
 * Destino de encaminhamento valido, normalizado.
 *
 * Encaminhar para a propria caixa e recusado na criacao: a copia voltaria,
 * casaria com a mesma regra e encaminharia de novo — laco imediato. Cadeias
 * mais longas (via terceiros) sao cortadas na entrega pelo limite de saltos.
 */
async function conferirEncaminhamento(mailboxId: string, destino: string): Promise<string> {
  const parsed = parseAddress(destino);
  if (!parsed) throw new RuleError(`Destino de encaminhamento invalido: ${destino}`, 422);

  const caixa = await prisma.mailbox.findUniqueOrThrow({
    where: { id: mailboxId },
    select: { localPart: true, domain: { select: { name: true } } },
  });
  if (parsed.full === `${caixa.localPart}@${caixa.domain.name}`) {
    throw new RuleError("Encaminhar para a propria caixa criaria um laco.", 422);
  }

  return parsed.full;
}

/** Acoes prontas para gravar: pasta conferida e destino normalizado. */
async function normalizarAcoes(mailboxId: string, actions: RuleActions): Promise<RuleActions> {
  if (actions.folderId) await conferirPastaDestino(mailboxId, actions.folderId);
  if (!actions.forwardTo) return actions;
  return { ...actions, forwardTo: await conferirEncaminhamento(mailboxId, actions.forwardTo) };
}

/**
 * Pasta destino valida: existe, e da caixa, e nao e Enviados/Rascunhos —
 * mensagem que CHEGA nessas pastas quebra a semantica delas no IMAP.
 */
async function conferirPastaDestino(mailboxId: string, folderId: string): Promise<void> {
  const pasta = await prisma.mailFolder.findFirst({
    where: { id: folderId, mailboxId },
    select: { kind: true },
  });
  if (!pasta) throw new RuleError("Pasta destino nao encontrada.", 404);
  if (pasta.kind === "sent" || pasta.kind === "drafts") {
    throw new RuleError("Mensagem recebida nao pode ir para Enviados ou Rascunhos.", 422);
  }
}

export async function listRules(mailboxId: string) {
  return prisma.mailboxRule.findMany({
    where: { mailboxId },
    orderBy: { position: "asc" },
    select: {
      id: true,
      name: true,
      position: true,
      enabled: true,
      match: true,
      conditions: true,
      actions: true,
    },
  });
}

export async function createRule(mailboxId: string, input: RuleInput) {
  validar(input);
  const actions = await normalizarAcoes(mailboxId, input.actions);

  const total = await prisma.mailboxRule.count({ where: { mailboxId } });
  if (total >= MAX_REGRAS) throw new RuleError(`Limite de ${MAX_REGRAS} regras por caixa.`, 422);

  const ultima = await prisma.mailboxRule.findFirst({
    where: { mailboxId },
    orderBy: { position: "desc" },
    select: { position: true },
  });

  return prisma.mailboxRule.create({
    data: {
      mailboxId,
      name: input.name.trim(),
      match: input.match,
      conditions: input.conditions as object[],
      actions: actions as object,
      enabled: input.enabled ?? true,
      position: (ultima?.position ?? -1) + 1,
    },
    select: { id: true, name: true, position: true, enabled: true, match: true, conditions: true, actions: true },
  });
}

export async function updateRule(mailboxId: string, ruleId: string, input: RuleInput) {
  validar(input);
  const actions = await normalizarAcoes(mailboxId, input.actions);

  const existente = await prisma.mailboxRule.findFirst({
    where: { id: ruleId, mailboxId },
    select: { id: true },
  });
  if (!existente) throw new RuleError("Regra nao encontrada.", 404);

  return prisma.mailboxRule.update({
    where: { id: ruleId },
    data: {
      name: input.name.trim(),
      match: input.match,
      conditions: input.conditions as object[],
      actions: actions as object,
      enabled: input.enabled ?? true,
    },
    select: { id: true, name: true, position: true, enabled: true, match: true, conditions: true, actions: true },
  });
}

export async function deleteRule(mailboxId: string, ruleId: string) {
  const apagadas = await prisma.mailboxRule.deleteMany({ where: { id: ruleId, mailboxId } });
  if (apagadas.count === 0) throw new RuleError("Regra nao encontrada.", 404);
  return { ok: true };
}

export interface EfeitoDaRegra {
  folderId: string | null;
  seen: boolean;
  flagged: boolean;
  /** Endereco para onde encaminhar uma copia, ou null. */
  forwardTo: string | null;
  ruleName: string;
}

/**
 * Efeito das regras sobre uma mensagem que chegaria na Entrada.
 *
 * Regra que aponta para pasta que deixou de existir e pulada inteira — aplicar
 * so metade (as flags, sem o movimento) faria a regra "funcionar diferente"
 * sem o dono mudar nada, que e o pior tipo de surpresa.
 */
export async function aplicarRegras(
  mailboxId: string,
  mensagem: MensagemParaRegra,
): Promise<EfeitoDaRegra | null> {
  const regras = await prisma.mailboxRule.findMany({
    where: { mailboxId, enabled: true },
    orderBy: { position: "asc" },
    select: { name: true, match: true, conditions: true, actions: true },
  });

  for (const regra of regras) {
    const match = regra.match === "any" ? "any" : "all";
    const conditions = (regra.conditions ?? []) as unknown as RuleCondition[];
    const actions = (regra.actions ?? {}) as unknown as RuleActions;

    if (!Array.isArray(conditions) || !regraCasa(match, conditions, mensagem)) continue;

    let folderId: string | null = null;
    if (actions.folderId) {
      const pasta = await prisma.mailFolder.findFirst({
        where: { id: actions.folderId, mailboxId },
        select: { id: true, kind: true },
      });
      if (!pasta || pasta.kind === "sent" || pasta.kind === "drafts") {
        log.warn("regra aponta para pasta invalida; pulada", { mailboxId, regra: regra.name });
        continue;
      }
      folderId = pasta.id;
    }

    return {
      folderId,
      seen: actions.markRead === true,
      flagged: actions.star === true,
      forwardTo: typeof actions.forwardTo === "string" && actions.forwardTo ? actions.forwardTo : null,
      ruleName: regra.name,
    };
  }

  return null;
}

/**
 * Nome fixo da regra criada pelo "encaminhar tudo" do painel. Serve de
 * marcador: e por ele que a operacao encontra a propria regra para atualizar
 * ou remover, sem confundir com regra que o dono da caixa escreveu.
 */
export const REGRA_ENCAMINHAR_TUDO = "Encaminhar tudo (painel)";

/**
 * Condicao que casa com qualquer mensagem.
 *
 * `validar()` exige ao menos uma condicao com texto, entao nao existe "regra
 * sem condicao". Todo endereco de remetente tem arroba, logo `from contains @`
 * e verdadeiro para qualquer mensagem real — e com `match: "any"` basta ela.
 */
const CONDICAO_TUDO: RuleCondition[] = [
  { field: "from", contains: "@" },
  { field: "to", contains: "@" },
];

export interface ResultadoEncaminharTudo {
  destino: string | null;
  aplicadas: string[];
  puladas: { address: string; motivo: string }[];
  /** Caixas que ja tinham regra propria e agora ficam atras desta. */
  comRegrasProprias: string[];
  /** Caixas deixadas de fora a pedido, e que tiveram a regra removida. */
  excluidas: string[];
}

/**
 * Cria (ou remove, com `destino` nulo) a regra "encaminha uma copia de tudo"
 * em todas as caixas ativas de um dominio.
 *
 * Duas coisas que quem for mexer aqui precisa saber:
 *
 * 1. A regra entra na **posicao 0**. A primeira regra que casa decide, e esta
 *    casa com tudo — se entrasse no fim, qualquer regra anterior do dono a
 *    tornaria letra morta. O preco e que as regras proprias da caixa deixam de
 *    valer enquanto esta existir; por isso o retorno lista quem estava nessa
 *    situacao, para a tela avisar em vez de o dono descobrir sozinho.
 * 2. A caixa de destino e pulada. `conferirEncaminhamento()` ja recusaria o
 *    laco, mas pular antes evita transformar um caso esperado em erro.
 *
 * O encaminhamento e sempre por COPIA: a mensagem continua na caixa original.
 */
export async function encaminharTudoDoDominio(
  domainName: string,
  destino: string | null,
  /**
   * Caixas que ficam de fora. Aceita o endereco inteiro ou so a parte local.
   *
   * Existe para caixa de automacao: `n8n@` recebe callback de integracao o dia
   * todo, e espelhar isso na caixa de uma pessoa nao e transparencia, e
   * entupimento — e caixa entupida e onde a mensagem que importa se perde.
   *
   * Excluir tambem REMOVE a regra de quem ja a tinha: sem isso, desmarcar uma
   * caixa na tela nao desfaria nada e o encaminhamento continuaria de pe.
   */
  excluir: string[] = [],
): Promise<ResultadoEncaminharTudo> {
  const dominio = await prisma.mailDomain.findUnique({
    where: { name: domainName.trim().toLowerCase() },
    select: { id: true, name: true },
  });
  if (!dominio) throw new RuleError(`Dominio nao encontrado: ${domainName}`, 404);

  const caixas = await prisma.mailbox.findMany({
    where: { domainId: dominio.id, status: "active" },
    select: { id: true, localPart: true },
    orderBy: { localPart: "asc" },
  });

  const enderecoDestino = destino ? parseAddress(destino)?.full : null;
  if (destino && !enderecoDestino) {
    throw new RuleError(`Destino de encaminhamento invalido: ${destino}`, 422);
  }

  // Aceita "n8n" e "n8n@avilaops.com" como a mesma coisa: quem digita na tela
  // pensa no nome da caixa, quem chama pela API costuma ter o endereco inteiro.
  const excluidas = new Set(
    excluir
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .map((item) => (item.includes("@") ? item : `${item}@${dominio.name}`)),
  );

  const resultado: ResultadoEncaminharTudo = {
    destino: enderecoDestino ?? null,
    aplicadas: [],
    puladas: [],
    comRegrasProprias: [],
    excluidas: [],
  };

  for (const caixa of caixas) {
    const address = `${caixa.localPart}@${dominio.name}`;

    const existente = await prisma.mailboxRule.findFirst({
      where: { mailboxId: caixa.id, name: REGRA_ENCAMINHAR_TUDO },
      select: { id: true },
    });

    if (!enderecoDestino) {
      if (existente) {
        await prisma.mailboxRule.delete({ where: { id: existente.id } });
        resultado.aplicadas.push(address);
      }
      continue;
    }

    if (address === enderecoDestino) {
      resultado.puladas.push({ address, motivo: "e a propria caixa de destino" });
      continue;
    }

    if (excluidas.has(address)) {
      // Apaga a regra se a caixa ja encaminhava: desmarcar na tela precisa
      // desfazer de verdade, senao o encaminhamento seguiria de pe em silencio.
      if (existente) await prisma.mailboxRule.delete({ where: { id: existente.id } });
      resultado.excluidas.push(address);
      continue;
    }

    const proprias = await prisma.mailboxRule.count({
      where: { mailboxId: caixa.id, name: { not: REGRA_ENCAMINHAR_TUDO } },
    });
    if (proprias > 0) resultado.comRegrasProprias.push(address);

    const dados = {
      name: REGRA_ENCAMINHAR_TUDO,
      match: "any",
      conditions: CONDICAO_TUDO as object[],
      actions: { forwardTo: enderecoDestino } as object,
      enabled: true,
      position: 0,
    };

    if (existente) {
      await prisma.mailboxRule.update({ where: { id: existente.id }, data: dados });
    } else {
      // Abre espaco na posicao 0 sem reordenar o resto entre si.
      await prisma.mailboxRule.updateMany({
        where: { mailboxId: caixa.id },
        data: { position: { increment: 1 } },
      });
      await prisma.mailboxRule.create({ data: { mailboxId: caixa.id, ...dados } });
    }

    resultado.aplicadas.push(address);
  }

  log.info("encaminhar tudo", {
    domain: dominio.name,
    destino: resultado.destino,
    aplicadas: resultado.aplicadas.length,
  });

  return resultado;
}

/** Endereço para onde o domínio encaminha hoje, ou null se ninguém encaminha. */
export interface EstadoEncaminharTudo {
  destino: string | null;
  /**
   * Caixas ativas do dominio que NAO encaminham, tirando a propria caixa de
   * destino. A tela precisa disso para reabrir com as exclusoes marcadas — sem
   * o estado, toda edicao seguinte apagaria as exclusoes anteriores.
   */
  excluidas: string[];
}

export async function getEncaminharTudo(domainName: string): Promise<EstadoEncaminharTudo> {
  const vazio: EstadoEncaminharTudo = { destino: null, excluidas: [] };

  const dominio = await prisma.mailDomain.findUnique({
    where: { name: domainName.trim().toLowerCase() },
    select: { id: true, name: true },
  });
  if (!dominio) return vazio;

  const comRegra = await prisma.mailboxRule.findMany({
    where: { name: REGRA_ENCAMINHAR_TUDO, mailbox: { domainId: dominio.id } },
    select: { actions: true, mailbox: { select: { localPart: true } } },
  });
  if (comRegra.length === 0) return vazio;

  const destino = (comRegra[0]?.actions as RuleActions | null | undefined)?.forwardTo ?? null;
  if (!destino) return vazio;

  const encaminham = new Set(comRegra.map((r) => `${r.mailbox.localPart}@${dominio.name}`));

  const caixas = await prisma.mailbox.findMany({
    where: { domainId: dominio.id, status: "active" },
    select: { localPart: true },
    orderBy: { localPart: "asc" },
  });

  return {
    destino,
    excluidas: caixas
      .map((c) => `${c.localPart}@${dominio.name}`)
      .filter((address) => address !== destino && !encaminham.has(address)),
  };
}
