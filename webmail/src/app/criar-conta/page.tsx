import { permanentRedirect } from "next/navigation";

/**
 * `/criar-conta` virou atalho para a página inicial.
 *
 * Esta tela nasceu em 31/08/2026 dizendo a verdade da época: o autoatendimento
 * não existia, a caixa nascia pela ficha do cliente, e o caminho honesto era
 * mandar para o WhatsApp. Desde então o autoatendimento foi construído inteiro
 * — verificação de domínio, checkout e provisionamento — e a tela continuou
 * dizendo que ele não existe, empurrando para uma conversa de dez minutos quem
 * poderia resolver sozinho em três passos.
 *
 * A porta da rua (`/`) passou a contar essa história, com preço e com o botão
 * que leva ao fluxo que funciona. Manter aqui uma terceira cópia do mesmo texto
 * só criaria mais um lugar para envelhecer sem ninguém perceber — que foi
 * exatamente o que aconteceu com esta tela.
 *
 * `permanentRedirect` (308) e não 307: o destino não volta a ser esta rota. O
 * link "Ver como contratar" do login continua funcionando.
 */
export default function CriarConta() {
  permanentRedirect("/");
}
