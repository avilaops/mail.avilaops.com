import { redirect } from "next/navigation";
import { PainelAgenda } from "@/components/PainelAgenda";
import { temSessao } from "@/lib/sessao";
import { agendaDisponivel } from "@/lib/agendaFeature";

export const dynamic = "force-dynamic";

export default async function Agenda() {
  if (!(await temSessao())) redirect("/api/sessao/retomar?returnTo=/agenda");
  if (!(await agendaDisponivel())) redirect("/caixa");
  return <PainelAgenda />;
}
