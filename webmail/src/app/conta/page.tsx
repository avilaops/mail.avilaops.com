import { redirect } from "next/navigation";
import { PainelConta } from "@/components/PainelConta";
import { temSessao } from "@/lib/sessao";

/** Dinâmica pelo nonce da CSP — ver comentário em `app/entrar/page.tsx`. */
export const dynamic = "force-dynamic";

export default async function Conta() {
  if (!(await temSessao())) redirect("/api/sessao/retomar?returnTo=/conta");

  return <PainelConta />;
}
