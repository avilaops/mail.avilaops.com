"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/cliente";
import { estadoDaPermissao, pedirPermissao, type EstadoPermissao } from "@/lib/notificacoes";
import { desinscrever, inscrever, inscricaoAtual, suportaPush, type EstadoPush } from "@/lib/push";

interface Preferencias {
  notifyEnabled: boolean;
  notifyQuietStart: number | null;
  notifyQuietEnd: number | null;
  notifyOnlyInbox: boolean;
}

/**
 * "Quero saber quando chegar e-mail" — a configuração de aviso.
 *
 * Duas coisas diferentes, que a tela precisa distinguir sem jargão:
 *
 *   • aviso com o webmail ABERTO: contador na aba e balão do sistema. Custa
 *     só a permissão do navegador;
 *   • aviso com o webmail FECHADO: push de verdade, que exige inscrever este
 *     aparelho no serviço do navegador (Google/Mozilla/Apple).
 *
 * A permissão é pedida aqui, no clique, e nunca ao abrir a caixa: navegador
 * trata pedido não solicitado como abuso, e a pessoa nega para se livrar do
 * balão — depois disso não dá para pedir de novo.
 */

const BOTAO =
  "inline-flex h-9 items-center justify-center rounded-lg bg-[var(--color-forte)] px-4 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] disabled:opacity-50";
const BOTAO_LEVE =
  "inline-flex h-9 items-center justify-center rounded-lg border border-[var(--color-borda)] px-3 text-sm font-medium transition hover:bg-[var(--color-fundo-suave)] disabled:opacity-50";

function nomeDoAparelho(userAgent: string | null): string {
  const ua = userAgent ?? "";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows";
  if (/Mac OS X/i.test(ua)) return "Mac";
  if (/Linux/i.test(ua)) return "Linux";
  return "Aparelho";
}

function navegadorDoAparelho(userAgent: string | null): string {
  const ua = userAgent ?? "";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\/|Opera/i.test(ua)) return "Opera";
  if (/Firefox/i.test(ua)) return "Firefox";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua)) return "Safari";
  return "navegador";
}

export function AvisosDeMensagem() {
  const [permissao, setPermissao] = useState<EstadoPermissao>("indisponivel");
  const [estado, setEstado] = useState<EstadoPush | null>(null);
  const [inscritoAqui, setInscritoAqui] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<Preferencias | null>(null);

  const carregar = useCallback(async () => {
    const [dados, preferencias] = await Promise.all([
      api<EstadoPush>("/me/push"),
      api<Preferencias>("/me/settings"),
    ]);
    setEstado(dados);
    setPrefs(preferencias);
    setInscritoAqui(Boolean(await inscricaoAtual()));
  }, []);

  /** Salva na hora: preferência de aviso com botão "Salvar" é esquecida ligada. */
  async function salvarPrefs(mudanca: Partial<Preferencias>) {
    if (!prefs) return;
    const anterior = prefs;
    setPrefs({ ...prefs, ...mudanca });
    try {
      const salvo = await api<Preferencias>("/me/settings", { method: "PUT", body: mudanca });
      setPrefs(salvo);
    } catch (falha) {
      setPrefs(anterior);
      setErro(falha instanceof Error ? falha.message : "Não foi possível salvar a preferência.");
    }
  }

  useEffect(() => {
    setPermissao(estadoDaPermissao());
    void carregar().catch((falha) => setErro(falha instanceof Error ? falha.message : "Falha ao carregar."));
  }, [carregar]);

  async function ligarNesteAparelho() {
    setErro(null);
    setOcupado(true);
    try {
      const resposta = await pedirPermissao();
      setPermissao(resposta);
      if (resposta !== "concedida") return;

      if (estado?.disponivel && estado.chavePublica) {
        const inscricao = await inscrever(estado.chavePublica);
        const bruta = inscricao.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
        await api("/me/push", {
          method: "POST",
          body: { endpoint: bruta.endpoint, keys: { p256dh: bruta.keys?.p256dh, auth: bruta.keys?.auth } },
        });
        await carregar();
      }
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Não foi possível ligar os avisos.");
    } finally {
      setOcupado(false);
    }
  }

  async function desligarNesteAparelho() {
    setErro(null);
    setOcupado(true);
    try {
      const endpoint = await desinscrever();
      if (endpoint) await api("/me/push", { method: "DELETE", body: { endpoint } });
      await carregar();
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Não foi possível desligar.");
    } finally {
      setOcupado(false);
    }
  }

  const semSuporte = !suportaPush();

  return (
    <div className="space-y-4">
      {erro && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-[var(--color-perigo)]">
          {erro}
        </p>
      )}

      <div className="rounded-lg border border-[var(--color-borda)] px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Avisar neste aparelho</p>
            <p className="mt-0.5 text-xs text-[var(--color-texto-fraco)]">
              {inscritoAqui && permissao === "concedida"
                ? "Ligado: você recebe o aviso mesmo com o webmail fechado."
                : permissao === "negada"
                  ? "O navegador está bloqueando avisos deste site. Libere nas permissões do cadeado, ao lado do endereço, e volte aqui."
                  : semSuporte
                    ? "Este navegador não suporta avisos em segundo plano."
                    : "Aviso do sistema quando chegar mensagem — inclusive com a aba fechada."}
            </p>
          </div>

          {inscritoAqui && permissao === "concedida" ? (
            <button type="button" onClick={() => void desligarNesteAparelho()} disabled={ocupado} className={BOTAO_LEVE}>
              {ocupado ? "…" : "Desligar aqui"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void ligarNesteAparelho()}
              disabled={ocupado || semSuporte || permissao === "negada"}
              className={BOTAO}
            >
              {ocupado ? "Ligando…" : "Ligar avisos"}
            </button>
          )}
        </div>

        {estado && !estado.disponivel && (
          <p className="mt-2 text-xs text-[var(--color-atencao)]">
            O aviso com a aba fechada ainda não está ligado no servidor. Com a aba aberta, o contador no título e o
            balão do sistema já funcionam.
          </p>
        )}
      </div>

      {prefs && (
        <div className="space-y-3 rounded-lg border border-[var(--color-borda)] px-4 py-3">
          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={prefs.notifyEnabled}
              onChange={(evento) => void salvarPrefs({ notifyEnabled: evento.target.checked })}
            />
            <span className="min-w-0">
              <span className="block text-sm">Avisar quando chegar mensagem</span>
              <span className="block text-xs text-[var(--color-texto-fraco)]">
                Desligado, você só recebe alertas de segurança — acesso novo, troca de senha.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5"
              disabled={!prefs.notifyEnabled}
              checked={prefs.notifyOnlyInbox}
              onChange={(evento) => void salvarPrefs({ notifyOnlyInbox: evento.target.checked })}
            />
            <span className="min-w-0">
              <span className="block text-sm">Só o que chega na Entrada</span>
              <span className="block text-xs text-[var(--color-texto-fraco)]">
                O que um filtro mandou para outra pasta foi arquivado de propósito — não interrompe.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span className={prefs.notifyEnabled ? "" : "opacity-50"}>Silêncio das</span>
            <select
              value={prefs.notifyQuietStart ?? ""}
              disabled={!prefs.notifyEnabled}
              onChange={(evento) =>
                void salvarPrefs({ notifyQuietStart: evento.target.value === "" ? null : Number(evento.target.value) })
              }
              className="rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-2 py-1.5 text-sm"
            >
              <option value="">—</option>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{String(h).padStart(2, "0")}h</option>
              ))}
            </select>
            <span className={prefs.notifyEnabled ? "" : "opacity-50"}>às</span>
            <select
              value={prefs.notifyQuietEnd ?? ""}
              disabled={!prefs.notifyEnabled}
              onChange={(evento) =>
                void salvarPrefs({ notifyQuietEnd: evento.target.value === "" ? null : Number(evento.target.value) })
              }
              className="rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-2 py-1.5 text-sm"
            >
              <option value="">—</option>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>{String(h).padStart(2, "0")}h</option>
              ))}
            </select>
            <span className="text-xs text-[var(--color-texto-fraco)]">
              {prefs.notifyQuietStart !== null && prefs.notifyQuietEnd !== null
                ? "Nesse intervalo a mensagem chega, mas o aparelho fica quieto."
                : "Deixe em branco para ser avisado a qualquer hora."}
            </span>
          </div>
        </div>
      )}

      {estado && estado.aparelhos.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-texto-fraco)]">
            Aparelhos que recebem aviso
          </p>
          <ul className="divide-y divide-[var(--color-borda)] rounded-lg border border-[var(--color-borda)]">
            {estado.aparelhos.map((aparelho) => (
              <li key={aparelho.id} className="flex items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    {nomeDoAparelho(aparelho.userAgent)} · {navegadorDoAparelho(aparelho.userAgent)}
                  </p>
                  <p className="text-[11px] text-[var(--color-texto-fraco)]">
                    autorizado em {new Date(aparelho.createdAt).toLocaleDateString("pt-BR")}
                    {aparelho.lastSentAt
                      ? ` · último aviso ${new Date(aparelho.lastSentAt).toLocaleString("pt-BR")}`
                      : " · nenhum aviso enviado ainda"}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={ocupado}
                  onClick={() =>
                    void (async () => {
                      setOcupado(true);
                      try {
                        await api("/me/push", { method: "DELETE", body: { endpoint: aparelho.endpoint } });
                        await carregar();
                      } finally {
                        setOcupado(false);
                      }
                    })()
                  }
                  className="shrink-0 rounded-md border border-[var(--color-borda)] px-2.5 py-1 text-xs transition hover:bg-red-50 hover:text-[var(--color-perigo)]"
                >
                  Remover
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-[var(--color-texto-fraco)]">
        No celular, o aplicativo de e-mail (Gmail, Mail da Apple) avisa sozinho pelo IMAP — não precisa disto. Isto
        aqui é para quem usa o webmail no navegador.
      </p>
    </div>
  );
}
