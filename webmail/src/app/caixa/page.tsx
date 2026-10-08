import { redirect } from "next/navigation";
import { PainelCaixa } from "@/components/PainelCaixa";
import { temSessao } from "@/lib/sessao";

/** Dinamica pelo nonce da CSP — ver comentario em `app/entrar/page.tsx`. */
export const dynamic = "force-dynamic";

export default async function Caixa() {
  // Corta a viagem: sem cookie de sessao nao adianta montar a interface para
  // ela descobrir o 401 na primeira chamada e redirecionar depois.
  if (!(await temSessao())) redirect("/entrar");

  return <PainelCaixa />;
}
