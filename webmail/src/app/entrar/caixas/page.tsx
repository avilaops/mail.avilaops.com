import { redirect } from "next/navigation";
import { chamarApi } from "@/lib/api";
import { ssoAtivo, tokenSso, urlLoginSso } from "@/lib/sso";
import { Marca } from "@/components/Marca";

export const dynamic = "force-dynamic";

interface Caixa {
  address: string;
  displayName: string | null;
}

interface RespostaEscolha {
  choose: Caixa[];
}

/** Agrupa por domínio, na ordem em que a API devolveu. */
function agruparPorDominio(caixas: Caixa[]): { dominio: string; caixas: Caixa[] }[] {
  const grupos = new Map<string, Caixa[]>();
  for (const caixa of caixas) {
    const dominio = caixa.address.split("@")[1] ?? "";
    const lista = grupos.get(dominio) ?? [];
    lista.push(caixa);
    grupos.set(dominio, lista);
  }
  return [...grupos.entries()].map(([dominio, lista]) => ({ dominio, caixas: lista }));
}

/** Iniciais para o avatar: "Nicolas Ávila" → "NA"; sem nome, a primeira letra do endereço. */
function iniciais(caixa: Caixa): string {
  const nome = caixa.displayName?.trim();
  if (nome) {
    const partes = nome.split(/\s+/).filter(Boolean);
    const primeira = partes[0]?.[0] ?? "";
    const ultima = partes.length > 1 ? (partes[partes.length - 1]?.[0] ?? "") : "";
    if (primeira) return (primeira + ultima).toUpperCase();
  }
  return (caixa.address[0] ?? "?").toUpperCase();
}

/**
 * Seletor de caixa para quem tem mais de uma na mesma conta Avila Ops.
 * A lista vem da API a partir do cookie do SSO; o clique volta na rota de
 * ingestao com o endereco escolhido.
 *
 * Agrupado por domínio: quem cuida de várias empresas enxerga primeiro a
 * empresa, depois a caixa. Cada linha é um alvo de toque inteiro, com nome em
 * destaque e endereço embaixo, porque o nome é o que a pessoa reconhece.
 */
export default async function EscolherCaixa() {
  if (!ssoAtivo()) redirect("/entrar?local=1");
  const token = await tokenSso();
  if (!token) redirect(urlLoginSso());

  const resposta = await chamarApi<RespostaEscolha | { accessToken: string }>("/auth/sso", {
    method: "POST",
    body: { ssoToken: token },
  });

  if (!resposta.ok || !resposta.dados) redirect("/entrar?erro=sem_caixa");
  if (!("choose" in resposta.dados)) redirect("/api/sessao/sso");

  const grupos = agruparPorDominio(resposta.dados.choose);
  const total = resposta.dados.choose.length;

  return (
    <main className="flex min-h-full items-center justify-center bg-[var(--color-fundo-suave)] px-6 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8">
          <Marca />
          <h1 className="text-2xl font-semibold tracking-tight">Qual caixa abrir?</h1>
          <p className="mt-1 text-sm text-[var(--color-texto-fraco)]">
            Sua conta Avila Ops tem acesso a {total === 1 ? "esta caixa" : `estas ${total} caixas`}.
          </p>
        </div>

        <div className="space-y-6">
          {grupos.map((grupo) => (
            <section key={grupo.dominio} aria-labelledby={`dominio-${grupo.dominio}`}>
              <h2
                id={`dominio-${grupo.dominio}`}
                className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-[var(--color-texto-fraco)]"
              >
                {grupo.dominio}
              </h2>
              <ul className="divide-y divide-[var(--color-borda)] overflow-hidden rounded-xl border border-[var(--color-borda)] bg-[var(--color-superficie)] shadow-sm">
                {grupo.caixas.map((caixa) => (
                  <li key={caixa.address}>
                    <a
                      href={`/api/sessao/sso?address=${encodeURIComponent(caixa.address)}`}
                      className="flex items-center gap-3 px-4 py-3.5 transition hover:bg-[var(--color-hover-suave)] active:bg-[var(--color-fundo-suave)]"
                    >
                      <span
                        aria-hidden
                        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-forte)] text-xs font-semibold text-[var(--color-sobre-forte)]"
                      >
                        {iniciais(caixa)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{caixa.displayName ?? caixa.address}</span>
                        {caixa.displayName && (
                          <span className="block truncate text-xs text-[var(--color-texto-fraco)]">{caixa.address}</span>
                        )}
                      </span>
                      <svg
                        aria-hidden
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="shrink-0 text-[var(--color-texto-fraco)]"
                      >
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="mt-8 flex flex-col items-center gap-2 text-xs text-[var(--color-texto-fraco)]">
          <a href="/entrar?local=1" className="underline underline-offset-2 hover:text-[var(--color-tinta)]">
            Entrar com a senha da caixa
          </a>
          <a href="/configurar" className="underline underline-offset-2 hover:text-[var(--color-tinta)]">
            Configurar no celular ou no Outlook
          </a>
        </div>
      </div>
    </main>
  );
}
