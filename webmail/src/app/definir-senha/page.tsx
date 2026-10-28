import { redirect } from "next/navigation";
import { DefinirSenha } from "@/components/DefinirSenha";
import { precisaTrocarSenha, temSessao } from "@/lib/sessao";
import { destinoMail } from "@/lib/destinoMail";

/** Dinâmica pelo nonce da CSP — ver comentário em `app/entrar/page.tsx`. */
export const dynamic = "force-dynamic";

/**
 * Primeiro acesso: o dono define a própria senha antes de usar a caixa.
 *
 * Sem sessão, volta ao login. Com sessão mas sem a marca de primeira troca,
 * não há o que fazer aqui — segue para a caixa. A trava de verdade é a API,
 * que recusa tudo (409) enquanto a senha não for definida; esta checagem só
 * evita a tela aparecer à toa.
 */
export default async function DefinirSenhaPage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const destino = destinoMail((await searchParams).returnTo);
  if (!(await temSessao())) redirect(`/api/sessao/retomar?${new URLSearchParams({ returnTo: destino })}`);
  if (!(await precisaTrocarSenha())) redirect(destino);
  return <DefinirSenha destino={destino} />;
}
