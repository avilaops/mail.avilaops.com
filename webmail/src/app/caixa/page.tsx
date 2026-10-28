import { redirect } from "next/navigation";
import { PainelCaixa } from "@/components/PainelCaixa";
import { temSessao } from "@/lib/sessao";
import { agendaDisponivel } from "@/lib/agendaFeature";
import { destinoMail } from "@/lib/destinoMail";

/** Dinamica pelo nonce da CSP — ver comentario em `app/entrar/page.tsx`. */
export const dynamic = "force-dynamic";

export default async function Caixa({ searchParams }: { searchParams: Promise<{ mensagem?: string }> }) {
  const { mensagem } = await searchParams;
  const mensagemInicial = mensagem && /^[\w-]{1,128}$/.test(mensagem) ? mensagem : undefined;
  const destino = destinoMail(mensagemInicial ? `/caixa?mensagem=${encodeURIComponent(mensagemInicial)}` : "/caixa");
  // Corta a viagem: sem cookie de sessao nao adianta montar a interface para
  // ela descobrir o 401 na primeira chamada e redirecionar depois.
  if (!(await temSessao())) redirect(`/api/sessao/retomar?${new URLSearchParams({ returnTo: destino })}`);

  return <PainelCaixa agendaHabilitada={await agendaDisponivel()} mensagemInicial={mensagemInicial} />;
}
