"use client";

/**
 * Aviso de mensagem nova fora da lista.
 *
 * Um webmail sem isto obriga a pessoa a ficar olhando a aba para saber se
 * chegou alguma coisa. Sao tres camadas, da mais barata para a mais cara:
 *
 *   1. contador no titulo da aba — funciona sempre, sem permissao nenhuma;
 *   2. notificacao do sistema — pede permissao, so aparece com a aba escondida
 *      (avisar do que ja esta na tela e ruido);
 *   3. push em segundo plano — com a aba fechada; mora no service worker.
 *
 * Aqui ficam as duas primeiras. A permissao NAO e pedida ao abrir a caixa: o
 * navegador trata pedido nao solicitado como abuso e o cliente nega para se
 * livrar do balao. Quem pede e a tela de conta, num botao que a pessoa clica.
 */

const TITULO_BASE = "E-mail Ávila Ops";

export function atualizarTituloDaAba(naoLidas: number): void {
  if (typeof document === "undefined") return;
  document.title = naoLidas > 0 ? `(${naoLidas > 99 ? "99+" : naoLidas}) ${TITULO_BASE}` : TITULO_BASE;
}

export type EstadoPermissao = "indisponivel" | "concedida" | "negada" | "nao-pedida";

export function estadoDaPermissao(): EstadoPermissao {
  if (typeof window === "undefined" || !("Notification" in window)) return "indisponivel";
  if (Notification.permission === "granted") return "concedida";
  if (Notification.permission === "denied") return "negada";
  return "nao-pedida";
}

export async function pedirPermissao(): Promise<EstadoPermissao> {
  if (estadoDaPermissao() === "indisponivel") return "indisponivel";
  const resposta = await Notification.requestPermission();
  return resposta === "granted" ? "concedida" : resposta === "denied" ? "negada" : "nao-pedida";
}

export interface MensagemParaAviso {
  id: string;
  fromName?: string | null;
  fromAddress: string;
  subject?: string | null;
}

/**
 * Mostra a notificacao do sistema.
 *
 * So dispara com a aba escondida: quem esta com a caixa aberta ja ve a
 * mensagem entrar na lista, e um balao por cima disso e ruido.
 *
 * Varias mensagens de uma vez viram UM aviso agrupado — dez baloes em
 * sequencia sao o caminho mais rapido para a pessoa desligar a permissao.
 */
export function avisarSistema(mensagens: MensagemParaAviso[], aoClicar: (id: string) => void): void {
  if (mensagens.length === 0) return;
  if (estadoDaPermissao() !== "concedida") return;
  if (typeof document !== "undefined" && document.visibilityState === "visible") return;

  const primeira = mensagens[0]!;
  const remetente = primeira.fromName?.trim() || primeira.fromAddress;

  const titulo = mensagens.length === 1 ? remetente : `${mensagens.length} mensagens novas`;
  const corpo =
    mensagens.length === 1
      ? primeira.subject?.trim() || "(sem assunto)"
      : `${remetente} e mais ${mensagens.length - 1}`;

  try {
    const aviso = new Notification(titulo, {
      body: corpo,
      icon: "/apple-touch-icon.png",
      badge: "/apple-touch-icon.png",
      // Uma notificacao por caixa: a nova substitui a anterior em vez de
      // empilhar avisos que dizem a mesma coisa.
      tag: "avila-mail-nova-mensagem",
      renotify: mensagens.length > 1,
    } as NotificationOptions);

    aviso.onclick = () => {
      window.focus();
      if (mensagens.length === 1) aoClicar(primeira.id);
      aviso.close();
    };
  } catch {
    // Navegador que recusa criar a notificacao (modo restrito, por exemplo)
    // nao pode derrubar o fluxo de mensagens.
  }
}
