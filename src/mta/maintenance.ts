import { config } from "../lib/config.js";
import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { deleteRaw } from "../lib/storage.js";
import { cleanupExpired } from "../services/session.js";
import { cleanupExpiredTokens } from "../services/recovery.js";
import { cleanupAutoReplyLog } from "../services/autoreply.js";
import { cleanupStaleUploads } from "../services/uploads.js";
import { getSystemFolder } from "../services/folders.js";
import { manutencaoDoSelfService } from "../services/signupCheckout.js";
import { manutencaoDaConferenciaDeDns } from "../services/conferenciaDeDns.js";

const log = createLogger("manutencao");

/**
 * Faxina diaria.
 *
 * Cada servico ganhou sua rotina de limpeza, mas nenhuma era chamada por
 * ninguem , sessao vencida, token gasto e anexo abandonado ficariam no banco
 * e no disco para sempre. Num servidor com 12 GB reservados para e-mail, o
 * anexo abandonado sozinho basta para encher.
 *
 * Roda dentro do processo do MTA porque ele ja e o unico que fica de pe o
 * tempo todo; um cron separado seria mais uma peca para manter e mais um
 * lugar onde a variavel de ambiente pode faltar.
 */

/** Dias que uma mensagem fica na Lixeira antes de sumir de vez. */
const DIAS_NA_LIXEIRA = 30;

/**
 * Esvazia o que passou do prazo na Lixeira.
 *
 * Sem isso a lixeira e so uma pasta com nome bonito: o disco continua ocupado
 * e a quota do cliente nunca volta. Trinta dias e a janela em que alguem ainda
 * lembra que apagou algo por engano.
 */
async function esvaziarLixeiraAntiga(): Promise<{ mensagens: number; bytes: string }> {
  const limite = new Date(Date.now() - DIAS_NA_LIXEIRA * 86_400_000);

  const caixas = await prisma.mailbox.findMany({ select: { id: true } });
  let total = 0;
  let liberados = 0n;

  for (const caixa of caixas) {
    const lixeira = await getSystemFolder(caixa.id, "trash").catch(() => null);
    if (!lixeira) continue;

    const antigas = await prisma.message.findMany({
      where: { mailboxId: caixa.id, folderId: lixeira.id, trashedAt: { lt: limite } },
      select: { id: true, storageKey: true, sizeBytes: true },
    });
    if (antigas.length === 0) continue;

    const bytes = antigas.reduce((soma, msg) => soma + BigInt(msg.sizeBytes), 0n);

    await prisma.$transaction([
      prisma.message.deleteMany({ where: { id: { in: antigas.map((m) => m.id) }, mailboxId: caixa.id } }),
      prisma.mailbox.update({ where: { id: caixa.id }, data: { usedBytes: { decrement: bytes } } }),
    ]);

    // Blob depois da linha: cair no meio deixa arquivo orfao (recuperavel por
    // varredura), nao linha apontando para arquivo que nao existe.
    for (const msg of antigas) {
      if (msg.storageKey) await deleteRaw(msg.storageKey);
    }

    total += antigas.length;
    liberados += bytes;
  }

  return { mensagens: total, bytes: liberados.toString() };
}

/** Marca como falha o que ficou preso na fila alem do limite de tentativas. */
async function encerrarFilaTravada(): Promise<number> {
  const resultado = await prisma.outboundMessage.updateMany({
    where: {
      status: { in: ["queued", "deferred", "sending"] },
      attempts: { gte: config.limits.maxDeliveryAttempts },
    },
    data: { status: "failed", lastError: "excedeu o numero maximo de tentativas" },
  });
  return resultado.count;
}

export async function rodarManutencao(): Promise<void> {
  const inicio = Date.now();

  try {
    const [sessoes, tokens, respostas, uploads, lixeira, fila, selfService, dns] = await Promise.all([
      cleanupExpired(),
      cleanupExpiredTokens(),
      cleanupAutoReplyLog(),
      cleanupStaleUploads(),
      esvaziarLixeiraAntiga(),
      encerrarFilaTravada(),
      // Pedido nao pago expira, e caixa que cumpriu a quarentena recupera o
      // limite normal de envio. As duas coisas so acontecem com o tempo, e
      // esta e a unica rotina da casa que roda todo dia sem depender de cron.
      manutencaoDoSelfService(),
      // SPF, DKIM, DMARC e MX de cada dominio. Nao e faxina: e vigilancia, e
      // esta aqui porque a faxina e o unico lugar que roda todo dia sozinho.
      // Sem isso, DNS de cliente quebra em silencio — foi o que aconteceu com
      // tres dominios que passaram meses enviando sem DKIM.
      manutencaoDaConferenciaDeDns(),
    ]);

    log.info("faxina concluida", {
      sessoesRemovidas: sessoes.sessions,
      tentativasLogin: sessoes.attempts,
      tokensRemovidos: tokens.removed,
      respostasAutomaticas: respostas.removed,
      anexosAbandonados: uploads.removed,
      mensagensDaLixeira: lixeira.mensagens,
      bytesLiberados: lixeira.bytes,
      filaEncerrada: fila,
      pedidosExpirados: selfService.expirados,
      freiosDeNovatoSoltos: selfService.freiosSoltos,
      pedidosPagosRetomados: selfService.retomados,
      pedidosPagosTravados: selfService.travados,
      dominiosConferidos: dns.conferidos,
      dominiosComProblema: dns.comProblema,
      dominiosCriticos: dns.criticos,
      dnsRegressoes: dns.regressoes,
      dnsAvisoEnviado: dns.avisoEnviado,
      duracaoMs: Date.now() - inicio,
    });
  } catch (error) {
    // Faxina que falha nao pode derrubar o MTA: e-mail continua entrando.
    log.error("faxina falhou; sera tentada de novo no proximo ciclo", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Agenda a faxina. Devolve a funcao que a cancela.
 *
 * A primeira roda 5 minutos depois da subida, nao na hora: reiniciar o serviço
 * num incidente nao pode disparar varredura de disco justo quando o servidor
 * ja esta sob pressao.
 */
export function iniciarManutencao(intervaloMs = 24 * 3_600_000): () => void {
  const primeira = setTimeout(() => void rodarManutencao(), 5 * 60_000);
  const periodica = setInterval(() => void rodarManutencao(), intervaloMs);

  return () => {
    clearTimeout(primeira);
    clearInterval(periodica);
  };
}
