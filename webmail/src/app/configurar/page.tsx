import { GuiaConfiguracao } from "@/components/GuiaConfiguracao";

/**
 * Guia público de configuração — sem login de propósito: quem mais precisa
 * dele é quem ainda não conseguiu entrar (celular novo, Outlook recém
 * instalado). Dinâmica pelo nonce da CSP — ver `app/entrar/page.tsx`.
 */
export const dynamic = "force-dynamic";

export default function Configurar() {
  return <GuiaConfiguracao host={process.env.NEXT_PUBLIC_MAIL_HOST ?? "mail.avilaops.com"} />;
}
