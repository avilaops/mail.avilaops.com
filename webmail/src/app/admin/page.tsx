import { redirect } from "next/navigation";
import { PainelAdmin } from "@/components/PainelAdmin";
import { temSessao } from "@/lib/sessao";

/** Dinamica pelo nonce da CSP — ver comentario em `app/entrar/page.tsx`. */
export const dynamic = "force-dynamic";

export default async function Admin() {
  if (!(await temSessao())) redirect("/entrar");

  return <PainelAdmin />;
}
