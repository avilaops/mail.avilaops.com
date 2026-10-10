"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/cliente";

/**
 * Área administrativa: domínios, DNS, caixas, aliases e catch-all.
 *
 * É a ferramenta de quem opera o serviço — e por isso ela evita dois vícios de
 * painel interno: caixa de diálogo do navegador e ação destrutiva a um clique.
 * Quota se edita na própria linha; excluir caixa vira uma faixa de confirmação
 * onde o endereço aparece escrito, para ninguém apagar a caixa errada.
 *
 * Senha de caixa nova (ou redefinida) aparece UMA vez: o servidor guarda só o
 * hash, então esta tela é o único lugar onde ela existe.
 */

interface Resumo {
  domains: number;
  activeMailboxes: number;
  domainsPendingDns: number;
  queue: { queued: number; deferred: number; failed24h: number };
  warmup: { dia: number; cap: number; enviadosHoje: number; restante: number } | null;
  relayDriver: string;
  billing: { mrrCents?: number; contas?: number } | null;
}

interface Checagem {
  mx: boolean;
  spf: boolean;
  dkim: boolean;
  dmarc: boolean;
}

interface DominioResumo {
  domain: string;
  status: string;
  dnsCheck: Checagem | null;
  dnsCheckedAt: string | null;
  mailboxes: number;
  aliases: number;
}

interface RegistroDns {
  type: string;
  host: string;
  value: string;
  priority?: number;
  purpose: string;
}

interface Caixa {
  address: string;
  displayName: string | null;
  status: string;
  quotaGb: number;
  usedMb: number;
  lastLoginAt: string | null;
  ownerEmail?: string | null;
}

interface Alias {
  address: string;
  destination: string;
}

interface Detalhe {
  domain: string;
  status: string;
  dnsRecords: RegistroDns[];
  /** Provedor onde o DNS do domínio está, identificado pelos servidores de nome. */
  dnsProvedor: { id: string; nome: string; preposicao: "na" | "no"; url: string; direto: boolean } | null;
  dnsServidores: string[];
  /** A zona está na conta da Cloudflare da casa: dá para publicar daqui. */
  dnsPublicavel: boolean;
  dnsCheck: Checagem | null;
  mailboxes: Caixa[];
  aliases: Alias[];
  catchAll: string | null;
  /** Caixa que recebe cópia de tudo que chega nas outras caixas do domínio. */
  encaminharTudo: string | null;
  /** Caixas que hoje NÃO encaminham, tirando a de destino. */
  encaminharTudoExcecoes: string[];
}

type Aviso = { tom: "ok" | "erro"; titulo: string; texto?: string; senha?: string };

const STATUS_DOMINIO: Record<string, string> = {
  active: "Ativo",
  pending_dns: "Aguardando DNS",
  suspended: "Suspenso",
  disabled: "Desativado",
};

/* ---------------------------------------------------------------- primitivos */

const CAMPO =
  "h-9 w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-3 text-sm outline-none transition placeholder:text-[var(--color-texto-fraco)] focus:border-[var(--color-realce)]";

const PRIMARIO =
  "inline-flex h-9 shrink-0 items-center justify-center rounded-lg bg-[var(--color-forte)] px-4 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] disabled:opacity-50";

const SECUNDARIO =
  "inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-[var(--color-borda)] px-2.5 text-xs font-medium transition hover:bg-[var(--color-hover-suave)] disabled:opacity-50";

const PERIGO =
  "inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-transparent px-2.5 text-xs font-medium text-[var(--color-perigo)] transition hover:border-[var(--color-perigo)]/40 hover:bg-[var(--color-perigo)]/10 disabled:opacity-50";

function Campo({ rotulo, ...props }: { rotulo: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-texto-fraco)]">{rotulo}</span>
      <input {...props} className={CAMPO} />
    </label>
  );
}

function data(iso: string | null | undefined, comHora = true): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return comHora ? d.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" }) : d.toLocaleDateString("pt-BR");
}

function Copiar({ texto, rotulo = "Copiar" }: { texto: string; rotulo?: string }) {
  const [copiado, setCopiado] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(texto).then(() => {
          setCopiado(true);
          setTimeout(() => setCopiado(false), 2000);
        });
      }}
      className={SECUNDARIO}
      aria-label={`${rotulo}: ${texto}`}
    >
      {copiado ? "Copiado ✓" : rotulo}
    </button>
  );
}

/** Selo de checagem de DNS: verde quando o registro está no ar. */
function SeloDns({ ok, rotulo }: { ok: boolean; rotulo: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
        ok
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
      }`}
      title={ok ? `${rotulo} publicado` : `${rotulo} ainda não encontrado no DNS`}
    >
      <span aria-hidden>{ok ? "✓" : "•"}</span>
      {rotulo}
    </span>
  );
}

function SeloStatus({ status }: { status: string }) {
  const ativo = status === "active";
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
        ativo
          ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ativo ? "bg-emerald-500" : "bg-amber-500"}`} aria-hidden />
      {STATUS_DOMINIO[status] ?? status}
    </span>
  );
}

function Indicador({
  rotulo,
  valor,
  nota,
  alerta,
}: {
  rotulo: string;
  valor: string;
  nota: string;
  alerta?: boolean;
}) {
  return (
    <div className="rounded-xl border border-[var(--color-borda)] bg-[var(--color-superficie)] px-4 py-3.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-texto-fraco)]">{rotulo}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{valor}</p>
      <p className={`mt-0.5 text-xs ${alerta ? "text-[var(--color-perigo)]" : "text-[var(--color-texto-fraco)]"}`}>
        {nota}
      </p>
    </div>
  );
}

/** Barra de uso da caixa — vermelha perto do teto, que é quando importa. */
function Uso({ usadoMb, quotaGb }: { usadoMb: number; quotaGb: number }) {
  const total = quotaGb * 1024;
  const proporcao = total > 0 ? Math.min((usadoMb / total) * 100, 100) : 0;
  const cheio = proporcao >= 90;
  return (
    <div className="w-28">
      <div className="h-1 overflow-hidden rounded-full bg-[var(--color-borda)]">
        <div
          className={`h-full rounded-full ${cheio ? "bg-[var(--color-perigo)]" : "bg-[var(--color-realce)]"}`}
          style={{ width: `${Math.max(proporcao, 1.5)}%` }}
        />
      </div>
      <p className="mt-1 text-[11px] tabular-nums text-[var(--color-texto-fraco)]">
        {usadoMb.toLocaleString("pt-BR")} MB de {quotaGb} GB
      </p>
    </div>
  );
}

function Secao({
  titulo,
  descricao,
  acao,
  children,
}: {
  titulo: string;
  descricao?: string;
  acao?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">{titulo}</h3>
          {descricao && <p className="mt-0.5 text-xs text-[var(--color-texto-fraco)]">{descricao}</p>}
        </div>
        {acao}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Vazio({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-[var(--color-borda)] px-4 py-6 text-center text-xs text-[var(--color-texto-fraco)]">
      {children}
    </p>
  );
}

/* ------------------------------------------------------------------- painel */

export function PainelAdmin() {
  const [resumo, setResumo] = useState<Resumo | null>(null);
  const [dominios, setDominios] = useState<DominioResumo[]>([]);
  const [aberto, setAberto] = useState<string | null>(null);
  const [detalhe, setDetalhe] = useState<Detalhe | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [semAcesso, setSemAcesso] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);

  const [novoDominio, setNovoDominio] = useState("");

  const carregarTopo = useCallback(async () => {
    const [r, d] = await Promise.all([
      api<Resumo>("/admin/resumo"),
      api<{ domains: DominioResumo[] }>("/admin/domains"),
    ]);
    setResumo(r);
    setDominios(d.domains);
  }, []);

  const carregarDetalhe = useCallback(async (nome: string) => {
    setDetalhe(await api<Detalhe>(`/admin/domains/${encodeURIComponent(nome)}`));
  }, []);

  useEffect(() => {
    void carregarTopo()
      .catch((falha) => {
        const mensagem = falha instanceof Error ? falha.message : "Falha ao carregar.";
        if (/administradora|403/.test(mensagem)) setSemAcesso(true);
        else setAviso({ tom: "erro", titulo: mensagem });
      })
      .finally(() => setCarregando(false));
  }, [carregarTopo]);

  async function executar(acao: () => Promise<void>) {
    setOcupado(true);
    try {
      await acao();
    } catch (falha) {
      setAviso({ tom: "erro", titulo: falha instanceof Error ? falha.message : "Não foi possível concluir." });
    } finally {
      setOcupado(false);
    }
  }

  async function recarregarTudo() {
    await carregarTopo();
    if (aberto) await carregarDetalhe(aberto);
  }

  async function abrir(nome: string) {
    if (aberto === nome) {
      setAberto(null);
      setDetalhe(null);
      return;
    }
    setAberto(nome);
    setDetalhe(null);
    await executar(() => carregarDetalhe(nome));
  }

  if (semAcesso) {
    return (
      <main className="mx-auto max-w-lg px-8 py-20">
        <h1 className="text-lg font-semibold">Área administrativa</h1>
        <p className="mt-2 text-sm text-[var(--color-texto-fraco)]">
          Sua caixa não é administradora. Quem administra é definido no servidor, em{" "}
          <code className="font-mono text-xs">MAIL_ADMIN_ADDRESSES</code>.
        </p>
        <a href="/caixa" className={`${SECUNDARIO} mt-6`}>
          Voltar à caixa
        </a>
      </main>
    );
  }

  return (
    <div className="rolagem-fina h-full overflow-y-auto bg-[var(--color-fundo-suave)]">
      <header className="sticky top-0 z-10 border-b border-[var(--color-borda)] bg-[var(--color-fundo)]/95 px-8 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Administração</h1>
            <p className="text-xs text-[var(--color-texto-fraco)]">
              Domínios, DNS, caixas, aliases e catch-all do servidor de e-mail.
            </p>
          </div>
          <nav className="flex items-center gap-2">
            <a href="/conta" className={SECUNDARIO}>
              Conta
            </a>
            <a href="/caixa" className={SECUNDARIO}>
              Voltar à caixa
            </a>
          </nav>
        </div>
      </header>

      <div className="mx-auto max-w-5xl px-8 py-6">
        {aviso && (
          <div
            role={aviso.tom === "erro" ? "alert" : "status"}
            className={`mb-6 rounded-xl border px-4 py-3 text-sm ${
              aviso.tom === "erro"
                ? "border-[var(--color-perigo)]/30 bg-[var(--color-perigo)]/10 text-[var(--color-perigo)]"
                : "border-emerald-500/30 bg-emerald-500/10"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium">{aviso.titulo}</p>
                {aviso.texto && <p className="mt-0.5 text-xs opacity-90">{aviso.texto}</p>}
                {aviso.senha && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <code className="rounded-lg bg-black/10 px-3 py-1.5 font-mono text-sm dark:bg-white/10">
                      {aviso.senha}
                    </code>
                    <Copiar texto={aviso.senha} rotulo="Copiar senha" />
                    <span className="text-[11px] opacity-80">Salve agora: não aparece de novo.</span>
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => setAviso(null)}
                aria-label="Fechar aviso"
                className="shrink-0 rounded-md px-2 text-lg leading-none opacity-60 transition hover:opacity-100"
              >
                ×
              </button>
            </div>
          </div>
        )}

        {/* ---------------- indicadores ---------------- */}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {carregando || !resumo ? (
            Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="h-[92px] animate-pulse rounded-xl border border-[var(--color-borda)] bg-[var(--color-superficie)]" />
            ))
          ) : (
            <>
              <Indicador
                rotulo="Domínios"
                valor={String(resumo.domains)}
                nota={resumo.domainsPendingDns ? `${resumo.domainsPendingDns} aguardando DNS` : "todos ativos"}
                alerta={resumo.domainsPendingDns > 0}
              />
              <Indicador
                rotulo="Caixas ativas"
                valor={String(resumo.activeMailboxes)}
                nota={`R$ ${(resumo.activeMailboxes * 10).toLocaleString("pt-BR")}/mês`}
              />
              <Indicador
                rotulo="Fila de saída"
                valor={String(resumo.queue.queued + resumo.queue.deferred)}
                nota={resumo.queue.failed24h ? `${resumo.queue.failed24h} falhas em 24 h` : "sem falhas em 24 h"}
                alerta={resumo.queue.failed24h > 0}
              />
              <Indicador
                rotulo="Aquecimento de IP"
                valor={resumo.warmup ? `${resumo.warmup.enviadosHoje}/${resumo.warmup.cap}` : "concluído"}
                nota={
                  resumo.warmup
                    ? `dia ${resumo.warmup.dia} · restam ${resumo.warmup.restante} hoje`
                    : `entrega ${resumo.relayDriver}`
                }
              />
            </>
          )}
        </div>

        {/* ---------------- domínios ---------------- */}
        <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold">Domínios</h2>
            <p className="text-xs text-[var(--color-texto-fraco)]">
              Abra um domínio para ver o DNS, as caixas e os aliases dele.
            </p>
          </div>
          <form
            onSubmit={(evento) => {
              evento.preventDefault();
              void executar(async () => {
                const alvo = novoDominio.trim().toLowerCase();
                const criado = await api<{ domain: string; created: boolean }>("/admin/domains", {
                  method: "POST",
                  body: { domain: alvo },
                });
                setNovoDominio("");
                setAviso({
                  tom: "ok",
                  titulo: criado.created ? `Domínio ${criado.domain} provisionado` : `Domínio ${criado.domain} já existia`,
                  texto: "Publique os registros DNS abaixo e clique em Verificar agora.",
                });
                await carregarTopo();
                setAberto(criado.domain);
                await carregarDetalhe(criado.domain);
              });
            }}
            className="flex items-end gap-2"
          >
            <div className="w-56">
              <Campo
                rotulo="Novo domínio"
                value={novoDominio}
                onChange={(e) => setNovoDominio(e.target.value)}
                placeholder="clientenovo.com.br"
                required
              />
            </div>
            <button type="submit" disabled={ocupado} className={PRIMARIO}>
              Provisionar
            </button>
          </form>
        </div>

        <ul className="mt-4 space-y-2 pb-12">
          {carregando &&
            Array.from({ length: 3 }, (_, i) => (
              <li key={i} className="h-14 animate-pulse rounded-xl border border-[var(--color-borda)] bg-[var(--color-superficie)]" />
            ))}

          {!carregando && dominios.length === 0 && <Vazio>Nenhum domínio provisionado ainda.</Vazio>}

          {dominios.map((d) => {
            const expandido = aberto === d.domain;
            return (
              <li
                key={d.domain}
                className="overflow-hidden rounded-xl border border-[var(--color-borda)] bg-[var(--color-superficie)]"
              >
                <button
                  type="button"
                  onClick={() => void abrir(d.domain)}
                  aria-expanded={expandido}
                  className="flex w-full items-center gap-4 px-4 py-3.5 text-left transition hover:bg-[var(--color-hover-suave)]"
                >
                  <span
                    className={`text-xs text-[var(--color-texto-fraco)] transition-transform ${expandido ? "rotate-90" : ""}`}
                    aria-hidden
                  >
                    ▶
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{d.domain}</span>
                  <span className="hidden shrink-0 text-xs text-[var(--color-texto-fraco)] sm:block">
                    {d.mailboxes} caixa{d.mailboxes === 1 ? "" : "s"} · {d.aliases} alias{d.aliases === 1 ? "" : "es"}
                  </span>
                  <SeloStatus status={d.status} />
                </button>

                {expandido && (
                  <div className="border-t border-[var(--color-borda)] bg-[var(--color-fundo-suave)] px-5 py-5">
                    {!detalhe ? (
                      <div className="h-24 animate-pulse rounded-lg bg-[var(--color-superficie)]" />
                    ) : (
                      <DetalheDominio
                        detalhe={detalhe}
                        ocupado={ocupado}
                        executar={executar}
                        recarregar={recarregarTudo}
                        setAviso={setAviso}
                      />
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- detalhe do domínio */

interface DetalheProps {
  detalhe: Detalhe;
  ocupado: boolean;
  executar: (acao: () => Promise<void>) => Promise<void>;
  recarregar: () => Promise<void>;
  setAviso: (aviso: Aviso | null) => void;
}

function DetalheDominio({ detalhe, ocupado, executar, recarregar, setAviso }: DetalheProps) {
  const dominio = detalhe.domain;
  const ref = (address: string) => ({ domain: dominio, username: address.split("@")[0] });

  const [caixaNome, setCaixaNome] = useState("");
  const [caixaExibicao, setCaixaExibicao] = useState("");
  const [caixaDono, setCaixaDono] = useState("");
  const [aliasNome, setAliasNome] = useState("");
  const [aliasDestino, setAliasDestino] = useState("");

  // Edição inline: nada de prompt() e confirm() do navegador nesta tela.
  const [editandoQuota, setEditandoQuota] = useState<string | null>(null);
  const [quotaNova, setQuotaNova] = useState("");
  const [confirmandoExclusao, setConfirmandoExclusao] = useState<string | null>(null);
  /** Aviso do MX que já existe; preenchido quando a publicação pede confirmação. */
  const [confirmarMx, setConfirmarMx] = useState<string | null>(null);

  const ROTULO: Record<string, string> = {
    criado: "criado",
    atualizado: "atualizado",
    ja_estava: "já estava",
    mantido: "mantido como estava",
    precisa_confirmar: "aguardando confirmação",
    falhou: "falhou",
  };

  /** Publica os registros na Cloudflare. O MX que aponta para outro lugar só é trocado com `substituirMx`. */
  function publicar(substituirMx: boolean) {
    void executar(async () => {
      const r = await api<{
        ready: boolean;
        registros: { registro: string; estado: string; detalhe?: string }[];
      }>(`/admin/domains/${encodeURIComponent(dominio)}/publish-dns`, { method: "POST", body: JSON.stringify({ substituirMx }) });
      const mx = r.registros.find((x) => x.estado === "precisa_confirmar");
      setConfirmarMx(mx?.detalhe ?? null);
      const falhas = r.registros.filter((x) => x.estado === "falhou");
      setAviso({
        tom: falhas.length > 0 || mx ? "erro" : "ok",
        titulo: mx
          ? `${dominio}: publicado, menos o MX`
          : falhas.length > 0
            ? `${dominio}: nem tudo foi publicado`
            : r.ready
              ? `${dominio}: DNS publicado e domínio ativo`
              : `${dominio}: DNS publicado; a verificação pode levar alguns minutos`,
        texto: r.registros.map((x) => `${x.registro.toUpperCase()} ${ROTULO[x.estado] ?? x.estado}${x.estado === "falhou" && x.detalhe ? ` (${x.detalhe})` : ""}`).join(" · "),
      });
      await recarregar();
    });
  }

  return (
    <div className="space-y-7">
      {/* ------------------------------ DNS ------------------------------ */}
      <Secao
        titulo="Registros DNS"
        descricao="Publique na zona do domínio; o e-mail só chega depois que o MX e o DKIM estiverem no ar."
        acao={
          <div className="flex flex-wrap items-center gap-1.5">
            {detalhe.dnsCheck && (
              <>
                <SeloDns ok={detalhe.dnsCheck.mx} rotulo="MX" />
                <SeloDns ok={detalhe.dnsCheck.spf} rotulo="SPF" />
                <SeloDns ok={detalhe.dnsCheck.dkim} rotulo="DKIM" />
                <SeloDns ok={detalhe.dnsCheck.dmarc} rotulo="DMARC" />
              </>
            )}
            {detalhe.dnsPublicavel && (
              <button type="button" disabled={ocupado} className={SECUNDARIO} onClick={() => publicar(false)}>
                Publicar na Cloudflare
              </button>
            )}
            {detalhe.dnsProvedor && (
              <a href={detalhe.dnsProvedor.url} target="_blank" rel="noreferrer" className={SECUNDARIO}>
                Abrir o DNS {detalhe.dnsProvedor.preposicao} {detalhe.dnsProvedor.nome}
              </a>
            )}
            <button
              type="button"
              disabled={ocupado}
              className={SECUNDARIO}
              onClick={() =>
                void executar(async () => {
                  const r = await api<{ ready: boolean; checks: Checagem }>(
                    `/admin/domains/${encodeURIComponent(dominio)}/verify`,
                    { method: "POST" },
                  );
                  setAviso({
                    tom: r.ready ? "ok" : "erro",
                    titulo: r.ready ? `${dominio}: DNS no ar — domínio ativo` : `${dominio}: DNS ainda incompleto`,
                    texto: Object.entries(r.checks)
                      .map(([k, v]) => `${k.toUpperCase()} ${v ? "✓" : "✗"}`)
                      .join(" · "),
                  });
                  await recarregar();
                })
              }
            >
              Verificar agora
            </button>
          </div>
        }
      >
        {confirmarMx && (
          <div role="alert" className="mb-2 rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] p-3 text-xs">
            <p className="font-medium">O MX não foi trocado.</p>
            <p className="mt-1 text-[var(--color-texto-fraco)]">
              {confirmarMx} Crie as caixas aqui antes de trocar, para nenhuma mensagem voltar.
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <button type="button" disabled={ocupado} className={PERIGO} onClick={() => publicar(true)}>
                Trocar o MX agora
              </button>
              <button type="button" className={SECUNDARIO} onClick={() => setConfirmarMx(null)}>
                Deixar como está
              </button>
            </div>
          </div>
        )}
        <p className="mb-2 text-[11px] text-[var(--color-texto-fraco)]">
          {detalhe.dnsPublicavel && "Esta zona está na conta da Cloudflare da Avila Ops: “Publicar na Cloudflare” grava os registros e verifica em seguida. "}
          {detalhe.dnsProvedor
            ? detalhe.dnsProvedor.direto
              ? `O DNS deste domínio está ${detalhe.dnsProvedor.preposicao} ${detalhe.dnsProvedor.nome}. O botão abre a zona dele; é preciso estar logado na conta dona do domínio.`
              : `O DNS deste domínio está ${detalhe.dnsProvedor.preposicao} ${detalhe.dnsProvedor.nome}. O botão abre o painel; escolha o domínio e a edição de DNS.`
            : detalhe.dnsServidores.length > 0
              ? `Servidores de nome deste domínio: ${detalhe.dnsServidores.join(", ")}. Publique os registros no painel de quem os administra.`
              : "Este domínio ainda não tem servidores de nome no ar. Aponte-o para um provedor de DNS antes de publicar os registros."}
        </p>
        <div className="overflow-hidden rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)]">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[var(--color-borda)] text-[11px] uppercase tracking-wide text-[var(--color-texto-fraco)]">
                <th className="px-3 py-2 font-medium">Tipo</th>
                <th className="px-3 py-2 font-medium">Nome</th>
                <th className="px-3 py-2 font-medium">Valor</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {detalhe.dnsRecords.map((r) => (
                <tr key={`${r.type}-${r.host}`} className="border-b border-[var(--color-borda)] last:border-0 align-top">
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono">
                    {r.type}
                    {r.priority !== undefined && (
                      <span className="ml-1 text-[var(--color-texto-fraco)]">prio {r.priority}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono">{r.host}</td>
                  <td className="px-3 py-2.5">
                    <span className="block max-w-[26rem] overflow-x-auto whitespace-nowrap font-mono">{r.value}</span>
                    <span className="mt-0.5 block text-[11px] text-[var(--color-texto-fraco)]">{r.purpose}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Copiar texto={r.value} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Secao>

      {/* ---------------------------- caixas ----------------------------- */}
      <Secao titulo={`Caixas (${detalhe.mailboxes.length})`} descricao="R$ 10 por caixa, por mês.">
        <div className="overflow-hidden rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)]">
          {detalhe.mailboxes.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-[var(--color-texto-fraco)]">
              Nenhuma caixa neste domínio ainda.
            </p>
          ) : (
            <ul className="divide-y divide-[var(--color-borda)]">
              {detalhe.mailboxes.map((c) => {
                const editando = editandoQuota === c.address;
                const confirmando = confirmandoExclusao === c.address;
                return (
                  <li key={c.address} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium">
                          {c.address}
                          {c.status !== "active" && (
                            <span className="ml-2 rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
                              {c.status === "suspended" ? "suspensa" : c.status}
                            </span>
                          )}
                        </p>
                        <p className="truncate text-[11px] text-[var(--color-texto-fraco)]">
                          {c.displayName ? `${c.displayName} · ` : ""}último acesso {data(c.lastLoginAt)}
                          {c.ownerEmail ? ` · dono ${c.ownerEmail}` : ""}
                        </p>
                      </div>

                      <Uso usadoMb={c.usedMb} quotaGb={c.quotaGb} />

                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          disabled={ocupado}
                          className={SECUNDARIO}
                          onClick={() =>
                            void executar(async () => {
                              const r = await api<{ password?: string }>("/admin/mailboxes/password", {
                                method: "POST",
                                body: ref(c.address),
                              });
                              setAviso({
                                tom: "ok",
                                titulo: `Senha de ${c.address} redefinida`,
                                texto: "A senha anterior deixou de valer neste instante.",
                                senha: r.password,
                              });
                            })
                          }
                        >
                          Nova senha
                        </button>
                        <button
                          type="button"
                          disabled={ocupado}
                          className={SECUNDARIO}
                          onClick={() => {
                            setConfirmandoExclusao(null);
                            setEditandoQuota(editando ? null : c.address);
                            setQuotaNova(String(c.quotaGb));
                          }}
                        >
                          Quota
                        </button>
                        <button
                          type="button"
                          disabled={ocupado}
                          className={SECUNDARIO}
                          onClick={() =>
                            void executar(async () => {
                              await api(
                                c.status === "suspended" ? "/admin/mailboxes/reactivate" : "/admin/mailboxes/suspend",
                                { method: "POST", body: ref(c.address) },
                              );
                              await recarregar();
                            })
                          }
                        >
                          {c.status === "suspended" ? "Reativar" : "Suspender"}
                        </button>
                        <button
                          type="button"
                          disabled={ocupado}
                          className={PERIGO}
                          onClick={() => {
                            setEditandoQuota(null);
                            setConfirmandoExclusao(confirmando ? null : c.address);
                          }}
                        >
                          Excluir
                        </button>
                      </div>
                    </div>

                    {editando && (
                      <form
                        onSubmit={(evento) => {
                          evento.preventDefault();
                          void executar(async () => {
                            await api("/admin/mailboxes/quota", {
                              method: "POST",
                              body: { ...ref(c.address), quotaGb: Number(quotaNova) },
                            });
                            setEditandoQuota(null);
                            await recarregar();
                          });
                        }}
                        className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-[var(--color-borda)] bg-[var(--color-fundo-suave)] px-3 py-2.5"
                      >
                        <div className="w-32">
                          <Campo
                            rotulo="Quota (GB)"
                            type="number"
                            min={1}
                            max={200}
                            value={quotaNova}
                            onChange={(e) => setQuotaNova(e.target.value)}
                            required
                          />
                        </div>
                        <button type="submit" disabled={ocupado} className={PRIMARIO}>
                          Salvar
                        </button>
                        <button type="button" className={SECUNDARIO} onClick={() => setEditandoQuota(null)}>
                          Cancelar
                        </button>
                        <p className="ml-auto max-w-xs text-[11px] text-[var(--color-texto-fraco)]">
                          Reduzir abaixo do uso atual não apaga mensagem: a caixa apenas para de receber até liberar
                          espaço.
                        </p>
                      </form>
                    )}

                    {confirmando && (
                      <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-perigo)]/40 bg-[var(--color-perigo)]/10 px-3 py-2.5">
                        <p className="min-w-0 flex-1 text-xs">
                          Excluir <strong>{c.address}</strong>? Todas as mensagens somem do servidor — não tem volta.
                        </p>
                        <button
                          type="button"
                          className={SECUNDARIO}
                          onClick={() => setConfirmandoExclusao(null)}
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          disabled={ocupado}
                          className="inline-flex h-8 items-center rounded-lg bg-[var(--color-perigo)] px-3 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-50"
                          onClick={() =>
                            void executar(async () => {
                              await api("/admin/mailboxes/delete", { method: "POST", body: ref(c.address) });
                              setConfirmandoExclusao(null);
                              setAviso({ tom: "ok", titulo: `Caixa ${c.address} excluída` });
                              await recarregar();
                            })
                          }
                        >
                          Excluir mesmo assim
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <form
          onSubmit={(evento) => {
            evento.preventDefault();
            void executar(async () => {
              const criada = await api<{ address: string; password?: string }>("/admin/mailboxes", {
                method: "POST",
                body: {
                  domain: dominio,
                  username: caixaNome.trim(),
                  displayName: caixaExibicao.trim() || undefined,
                  ownerEmail: caixaDono.trim() || undefined,
                },
              });
              setCaixaNome("");
              setCaixaExibicao("");
              setCaixaDono("");
              setAviso({
                tom: "ok",
                titulo: `Caixa ${criada.address} criada`,
                texto: "Entregue a senha ao dono junto com o guia de configuração (mail.avilaops.com/configurar).",
                senha: criada.password,
              });
              await recarregar();
            });
          }}
          className="mt-3 rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] p-4"
        >
          <p className="text-xs font-medium">Nova caixa</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_minmax(0,1fr)_auto]">
            <div className="flex items-end gap-1">
              <Campo
                rotulo="Nome"
                value={caixaNome}
                onChange={(e) => setCaixaNome(e.target.value.toLowerCase())}
                placeholder="contato"
                required
              />
              <span className="pb-2 text-xs text-[var(--color-texto-fraco)]">@{dominio}</span>
            </div>
            <Campo
              rotulo="Exibição (opcional)"
              value={caixaExibicao}
              onChange={(e) => setCaixaExibicao(e.target.value)}
              placeholder="Contato Comercial"
            />
            <Campo
              rotulo="Dono no SSO (opcional)"
              type="email"
              value={caixaDono}
              onChange={(e) => setCaixaDono(e.target.value)}
              placeholder="cliente@empresa.com"
            />
            <div className="flex items-end">
              <button type="submit" disabled={ocupado} className={PRIMARIO}>
                Criar caixa
              </button>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-[var(--color-texto-fraco)]">
            A senha é gerada pelo servidor e aparece uma única vez, aqui em cima.
          </p>
        </form>
      </Secao>

      {/* ------------------------ aliases e catch-all --------------------- */}
      <Secao
        titulo="Aliases e catch-all"
        descricao="Alias entrega numa caixa nossa ou num e-mail externo, sem custo de caixa."
      >
        <div className="overflow-hidden rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)]">
          {detalhe.aliases.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-[var(--color-texto-fraco)]">Nenhum alias neste domínio.</p>
          ) : (
            <ul className="divide-y divide-[var(--color-borda)]">
              {detalhe.aliases.map((a) => (
                <li key={a.address} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {a.address}
                    <span className="mx-2 text-[var(--color-texto-fraco)]" aria-hidden>
                      →
                    </span>
                    <span className="text-[var(--color-texto-fraco)]">{a.destination}</span>
                  </span>
                  <button
                    type="button"
                    disabled={ocupado}
                    className={PERIGO}
                    onClick={() =>
                      void executar(async () => {
                        await api("/admin/aliases/delete", {
                          method: "POST",
                          body: { domain: dominio, alias: a.address.split("@")[0] },
                        });
                        await recarregar();
                      })
                    }
                  >
                    Remover
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <form
          onSubmit={(evento) => {
            evento.preventDefault();
            void executar(async () => {
              await api("/admin/aliases", {
                method: "POST",
                body: { domain: dominio, alias: aliasNome.trim(), destination: aliasDestino.trim() },
              });
              setAliasNome("");
              setAliasDestino("");
              await recarregar();
            });
          }}
          className="mt-3 rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] p-4"
        >
          <p className="text-xs font-medium">Novo alias</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_auto]">
            <div className="flex items-end gap-1">
              <Campo
                rotulo="Endereço"
                value={aliasNome}
                onChange={(e) => setAliasNome(e.target.value.toLowerCase())}
                placeholder="vendas"
                required
              />
              <span className="pb-2 text-xs text-[var(--color-texto-fraco)]">@{dominio}</span>
            </div>
            <Campo
              rotulo="Entrega em"
              value={aliasDestino}
              onChange={(e) => setAliasDestino(e.target.value)}
              placeholder="caixa nossa ou e-mail externo"
              required
            />
            <div className="flex items-end">
              <button type="submit" disabled={ocupado} className={PRIMARIO}>
                Criar alias
              </button>
            </div>
          </div>
        </form>

        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium">Catch-all</p>
            <p className="text-[11px] text-[var(--color-texto-fraco)]">
              Recebe tudo que não casa com caixa nem alias — útil na virada de provedor, mas também junta spam.
            </p>
          </div>
          <select
            value={detalhe.catchAll ? detalhe.catchAll.split("@")[0] : ""}
            disabled={ocupado || detalhe.mailboxes.length === 0}
            onChange={(e) =>
              void executar(async () => {
                await api(`/admin/domains/${encodeURIComponent(dominio)}/catch-all`, {
                  method: "POST",
                  body: { username: e.target.value || null },
                });
                await recarregar();
              })
            }
            className={`${CAMPO} w-56`}
          >
            <option value="">desligado</option>
            {detalhe.mailboxes.map((c) => (
              <option key={c.address} value={c.address.split("@")[0]}>
                {c.address}
              </option>
            ))}
          </select>
        </div>

        <EncaminharTudo
          dominio={dominio}
          detalhe={detalhe}
          ocupado={ocupado}
          executar={executar}
          recarregar={recarregar}
          setAviso={setAviso}
        />
      </Secao>
    </div>
  );
}

/* ------------------------------------------------ encaminhar tudo, com exceções */

/**
 * "Encaminha tudo para esta caixa, menos estas aqui".
 *
 * Virou componente próprio porque a exclusão precisa de estado entre o clique e
 * o salvar: marcar três caixas e só então gravar é uma requisição, enquanto
 * gravar a cada clique seriam três, cada uma reescrevendo as regras do domínio
 * inteiro.
 *
 * O caso que motivou: `n8n@` recebe callback de integração o dia todo, e
 * espelhar isso na caixa de uma pessoa não é transparência, é entupimento. E
 * caixa entupida é onde a mensagem que importa se perde.
 */
function EncaminharTudo({
  dominio,
  detalhe,
  ocupado,
  executar,
  recarregar,
  setAviso,
}: {
  dominio: string;
  detalhe: Detalhe;
  ocupado: boolean;
  executar: (acao: () => Promise<void>) => Promise<void>;
  recarregar: () => Promise<void>;
  setAviso: (aviso: Aviso | null) => void;
}) {
  const [destino, setDestino] = useState(detalhe.encaminharTudo ?? "");
  const [excluidas, setExcluidas] = useState<string[]>(detalhe.encaminharTudoExcecoes ?? []);

  // O servidor é a verdade: depois de salvar, a tela reflete o que ficou
  // gravado, e não o que o usuário clicou.
  useEffect(() => {
    setDestino(detalhe.encaminharTudo ?? "");
    setExcluidas(detalhe.encaminharTudoExcecoes ?? []);
  }, [detalhe.encaminharTudo, detalhe.encaminharTudoExcecoes]);

  const candidatas = detalhe.mailboxes.filter((c) => c.address !== destino);
  const sujo =
    destino !== (detalhe.encaminharTudo ?? "") ||
    excluidas.slice().sort().join(",") !==
      (detalhe.encaminharTudoExcecoes ?? []).slice().sort().join(",");

  async function salvar() {
    await executar(async () => {
      const r = await api<{
        destino: string | null;
        aplicadas: string[];
        excluidas: string[];
        comRegrasProprias: string[];
      }>(`/admin/domains/${encodeURIComponent(dominio)}/encaminhar-tudo`, {
        method: "POST",
        body: { destination: destino || null, excluir: excluidas },
      });
      await recarregar();
      setAviso({
        tom: "ok",
        titulo: r.destino
          ? `${r.aplicadas.length} caixa(s) encaminham para ${r.destino}` +
            (r.excluidas.length ? `, ${r.excluidas.length} de fora.` : ".")
          : "Encaminhamento removido de todas as caixas.",
        // Regra que casa com tudo fica em primeiro lugar e cala as outras:
        // quem tinha triagem própria precisa saber disso.
        texto: r.comRegrasProprias.length
          ? `Atenção: ${r.comRegrasProprias.join(", ")} já tinham regras próprias, que ficam sem efeito enquanto o encaminhamento estiver ligado.`
          : undefined,
      });
    });
  }

  return (
    <div className="mt-3 space-y-3 rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">Encaminhar tudo para uma caixa</p>
          <p className="text-[11px] text-[var(--color-texto-fraco)]">
            Põe uma cópia de tudo que chega em <strong>qualquer</strong> caixa do domínio
            numa caixa só. O catch-all sozinho não faz isso: ele só pega endereço que não
            existe. Spam continua na quarentena e não é encaminhado.
          </p>
        </div>
        <select
          value={destino}
          disabled={ocupado || detalhe.mailboxes.length < 2}
          onChange={(e) => setDestino(e.target.value)}
          className={`${CAMPO} w-56`}
        >
          <option value="">desligado</option>
          {detalhe.mailboxes.map((c) => (
            <option key={c.address} value={c.address}>
              {c.address}
            </option>
          ))}
        </select>
      </div>

      {destino ? (
        <div className="space-y-1.5 border-t border-[var(--color-borda)] pt-3">
          <p className="text-[11px] text-[var(--color-texto-fraco)]">
            Deixar de fora (caixa de automação costuma entrar aqui):
          </p>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {candidatas.map((c) => (
              <label key={c.address} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  disabled={ocupado}
                  checked={excluidas.includes(c.address)}
                  onChange={(e) =>
                    setExcluidas((atual) =>
                      e.target.checked
                        ? [...atual, c.address]
                        : atual.filter((a) => a !== c.address),
                    )
                  }
                />
                {c.address}
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {sujo ? (
        <div className="flex justify-end border-t border-[var(--color-borda)] pt-3">
          <button type="button" disabled={ocupado} onClick={() => void salvar()} className={PRIMARIO}>
            {ocupado ? "Salvando…" : "Salvar encaminhamento"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
