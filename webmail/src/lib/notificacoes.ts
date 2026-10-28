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
  if (typeof window === "undefined" || !("Notification" in window) || !("serviceWorker" in navigator)) return "indisponivel";
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
export async function avisarSistema(mensagens: MensagemParaAviso[], permitido: boolean, mailboxId: string): Promise<void> {
  // Decisao atual do servidor: preferencia da caixa e autorizacao do aparelho.
  if (!permitido) return;
  if (mensagens.length === 0 || !mailboxId) return;
  if (estadoDaPermissao() !== "concedida") return;
  if (typeof document !== "undefined" && document.visibilityState === "visible") return;

  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const registro = await navigator.serviceWorker.ready;
    if (!registro.active) return;
    const canal = new MessageChannel();
    await new Promise<void>((resolve) => {
      const terminar = () => { clearTimeout(limite); canal.port1.close(); resolve(); };
      const limite = setTimeout(terminar, 5000);
      canal.port1.onmessage = terminar;
      registro.active!.postMessage({ type: "mail:avisar", avisos: mensagens.map((mensagem) => ({
        mailboxId, eventId: mensagem.id, messageId: mensagem.id,
        titulo: mensagem.fromName?.trim() || mensagem.fromAddress,
        corpo: mensagem.subject?.trim() || "(sem assunto)",
      })) }, [canal.port2]);
    });
  } catch {
    // O contador e a lista continuam funcionando se o navegador recusar o aviso.
  }
}

let caixaAtualAvisos = "";
let escutandoWorker = false;

/** O worker consulta a caixa visivel antes de mostrar push, inclusive entre abas. */
export function definirCaixaAvisos(mailboxId: string): void {
  caixaAtualAvisos = mailboxId;
  if (escutandoWorker || !("serviceWorker" in navigator)) return;
  escutandoWorker = true;
  navigator.serviceWorker.addEventListener("message", (evento) => {
    if (evento.data?.type === "mail:consultar" && evento.ports[0]) {
      evento.ports[0].postMessage({ mailboxId: caixaAtualAvisos, visivel: document.visibilityState === "visible" });
    }
  });
}
