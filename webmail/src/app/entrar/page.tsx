import { redirect } from "next/navigation";
import { FormularioEntrar } from "@/components/FormularioEntrar";
import { ssoAtivo, urlLoginSso } from "@/lib/sso";

/**
 * Renderizacao dinamica e obrigatoria, nao preferencia.
 *
 * A CSP carrega um nonce diferente por requisicao (ver `src/middleware.ts`), e
 * pagina pre-renderizada no build tem HTML fixo — nao ha onde carimbar o nonce.
 * Sem isso o navegador bloqueia os scripts do Next, a pagina nao hidrata e o
 * formulario faz submit nativo, sem passar pelo BFF.
 *
 * Com o SSO ligado, a porta de entrada e o auth.avilaops.com: esta tela so
 * fica para quem entra com a senha da caixa (`?local=1`) — cliente sem conta
 * Avila Ops, ou quando o SSO nao encontrou caixa para a conta.
 */
export const dynamic = "force-dynamic";

const AVISOS: Record<string, string> = {
  sem_caixa: "Sua conta Avila Ops ainda nao tem caixa de e-mail. Entre com a senha da caixa ou fale com a equipe.",
  caixa_indisponivel: "A caixa esta suspensa ou desativada. Regularize no painel ou fale com o suporte.",
  sso_invalido: "Nao foi possivel confirmar sua sessao Avila Ops. Entre de novo.",
};

export default async function Entrar({
  searchParams,
}: {
  searchParams: Promise<{ local?: string; erro?: string; detalhe?: string }>;
}) {
  const { local, erro, detalhe } = await searchParams;

  if (ssoAtivo() && local !== "1" && !erro) redirect(urlLoginSso());

  const aviso = erro ? (detalhe || AVISOS[erro] || AVISOS.sso_invalido) : null;
  return <FormularioEntrar aviso={aviso} />;
}
