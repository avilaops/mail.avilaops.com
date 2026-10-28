import { redirect } from "next/navigation";
import { PainelAgenda } from "@/components/PainelAgenda";
import { temSessao } from "@/lib/sessao";
import { agendaDisponivel } from "@/lib/agendaFeature";
import { destinoMail } from "@/lib/destinoMail";

export const dynamic = "force-dynamic";

export default async function Agenda({ searchParams }: { searchParams: Promise<{ data?: string; evento?: string }> }) {
  const { data, evento } = await searchParams;
  const parametros = new URLSearchParams();
  if (data) parametros.set("data", data);
  if (evento) parametros.set("evento", evento);
  const destino = destinoMail(`/agenda${parametros.size ? `?${parametros}` : ""}`);
  if (!(await temSessao())) redirect(`/api/sessao/retomar?${new URLSearchParams({ returnTo: destino })}`);
  if (!(await agendaDisponivel())) redirect("/caixa");
  return <PainelAgenda />;
}
