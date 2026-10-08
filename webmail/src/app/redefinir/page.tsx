import { FormularioRedefinir } from "@/components/FormularioRedefinir";

/** Dinâmica pelo nonce da CSP — ver comentário em `app/entrar/page.tsx`. */
export const dynamic = "force-dynamic";

export default async function Redefinir({
  searchParams,
}: {
  searchParams: Promise<{ token?: string | string[] }>;
}) {
  const { token } = await searchParams;

  // O token vem do link do e-mail. Ele NAO e validado aqui de proposito: quem
  // decide se vale e o servidor, no momento de trocar a senha. Validar antes
  // criaria um oraculo para descobrir se um token existe sem gastá-lo.
  const valor = Array.isArray(token) ? (token[0] ?? "") : (token ?? "");

  return <FormularioRedefinir token={valor} />;
}
