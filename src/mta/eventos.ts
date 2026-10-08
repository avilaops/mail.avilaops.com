import { EventEmitter } from "node:events";

/**
 * Avisos de entrega, para o IDLE do IMAP.
 *
 * Anunciar IDLE sem notificar nada e pior do que nao anunciar: o cliente para
 * de perguntar "chegou algo?" justamente porque confia que sera avisado, e o
 * e-mail fica parado no servidor ate a proxima sincronia manual. Era esse o
 * estado antes deste arquivo existir.
 *
 * Limite conhecido e assumido: isto e um sinal DENTRO do processo. Funciona
 * para o que importa — mensagem que chega pela porta 25 e entregue no mesmo
 * processo que atende o IMAP. Nao cobre entrega feita por outro processo (a
 * copia em Enviados gravada pela API, por exemplo); nesse caso o cliente
 * descobre na proxima sincronia, como antes. Trocar por Postgres LISTEN/NOTIFY
 * resolveria, e e o passo natural quando o MTA sair para host proprio.
 */

const barramento = new EventEmitter();

// Uma sessao IMAP por caixa aberta em cada aparelho: celular, desktop e o
// webmail somam rapido, e o teto padrao de 10 ouvintes vira aviso no log.
barramento.setMaxListeners(200);

const CHEGOU = "chegou";

export interface AvisoEntrega {
  mailboxId: string;
  folderId: string;
}

export function avisarEntrega(aviso: AvisoEntrega): void {
  barramento.emit(CHEGOU, aviso);
}

/** Devolve a funcao que cancela a inscricao — chamar sempre que a sessao cair. */
export function ouvirEntregas(ouvinte: (aviso: AvisoEntrega) => void): () => void {
  barramento.on(CHEGOU, ouvinte);
  return () => barramento.off(CHEGOU, ouvinte);
}
