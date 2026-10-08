import { FormularioRecuperar } from "@/components/FormularioRecuperar";

/** Dinâmica pelo nonce da CSP — ver comentário em `app/entrar/page.tsx`. */
export const dynamic = "force-dynamic";

export default function Recuperar() {
  return <FormularioRecuperar />;
}
