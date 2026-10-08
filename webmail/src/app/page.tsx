import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PaginaInicial } from "@/components/PaginaInicial";
import { temSessao } from "@/lib/sessao";

/** Dinâmica pelo nonce da CSP — ver comentário em `app/entrar/page.tsx`. */
export const dynamic = "force-dynamic";

/**
 * Esta é a única página do webmail que PODE aparecer em buscador.
 *
 * O layout marca o site inteiro como `noindex` de propósito: caixa de e-mail
 * não tem por que ser indexada. Mas isso também escondia a porta da rua, que é
 * justamente a página que precisa ser encontrada por quem ainda não é cliente.
 * A exceção vale só aqui; `/entrar`, `/caixa` e o resto seguem fora do índice.
 */
export const metadata: Metadata = {
  title: "E-mail com o domínio da sua empresa | Ávila Mail",
  description:
    "Caixa de e-mail profissional no servidor próprio da Ávila Ops: webmail, IMAP, contatos e agenda, com os e-mails antigos trazidos do provedor atual.",
  robots: { index: true, follow: true },
  alternates: { canonical: "/" },
};

/**
 * Antes, `/` redirecionava todo visitante para `/entrar` — que, com o SSO
 * ligado, salta direto para o `auth.avilaops.com`. Quem digitava o endereço
 * para conhecer o produto caía num login de outro domínio sem nunca ter visto
 * o que estava sendo vendido.
 *
 * Agora só quem tem sessão vai direto para a caixa. O visitante vê a página,
 * como no Gmail.
 */
export default async function Inicio() {
  if (await temSessao()) redirect("/caixa");
  return <PaginaInicial />;
}
