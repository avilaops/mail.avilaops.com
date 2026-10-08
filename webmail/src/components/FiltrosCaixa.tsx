"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/cliente";

/**
 * Filtros da caixa: "quando chegar mensagem assim, faça isto".
 *
 * A ordem da lista importa e a tela diz isso ao cliente: a primeira regra que
 * casa decide. Editar reaproveita o mesmo formulário de criar — dois
 * formulários que fazem a mesma coisa sempre acabam diferentes um do outro.
 */

interface Condicao {
  field: "from" | "to" | "subject" | "has_attachment";
  contains?: string;
}

interface Acoes {
  folderId?: string | null;
  markRead?: boolean;
  star?: boolean;
  /** Encaminha uma cópia para este endereço; a mensagem continua na caixa. */
  forwardTo?: string | null;
}

interface Regra {
  id: string;
  name: string;
  position: number;
  enabled: boolean;
  match: "all" | "any";
  conditions: Condicao[];
  actions: Acoes;
}

interface Pasta {
  id: string;
  name: string;
  kind: string;
}

const NOME_CAMPO: Record<Condicao["field"], string> = {
  from: "Remetente contém",
  to: "Destinatário contém",
  subject: "Assunto contém",
  has_attachment: "Tem anexo",
};

const CONDICAO_NOVA: Condicao = { field: "from", contains: "" };

const campo =
  "rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-3 py-2 text-sm outline-none transition focus:border-[var(--color-realce)]";

function resumo(regra: Regra, pastas: Pasta[]): string {
  const condicoes = regra.conditions
    .map((condicao) =>
      condicao.field === "has_attachment"
        ? "tem anexo"
        : `${NOME_CAMPO[condicao.field].toLowerCase()} “${condicao.contains}”`,
    )
    .join(regra.match === "all" ? " e " : " ou ");

  const acoes: string[] = [];
  if (regra.actions.folderId) {
    const pasta = pastas.find((p) => p.id === regra.actions.folderId);
    acoes.push(`mover para ${pasta?.name ?? "pasta removida"}`);
  }
  if (regra.actions.markRead) acoes.push("marcar como lida");
  if (regra.actions.star) acoes.push("favoritar");
  if (regra.actions.forwardTo) acoes.push(`encaminhar cópia para ${regra.actions.forwardTo}`);

  return `Se ${condicoes} → ${acoes.join(", ")}`;
}

export function FiltrosCaixa() {
  const [regras, setRegras] = useState<Regra[]>([]);
  const [pastas, setPastas] = useState<Pasta[]>([]);
  const [carregado, setCarregado] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);

  // null = formulário fechado; "" = criando; id = editando aquela regra.
  const [editando, setEditando] = useState<string | null>(null);
  const [nome, setNome] = useState("");
  const [match, setMatch] = useState<"all" | "any">("all");
  const [condicoes, setCondicoes] = useState<Condicao[]>([{ ...CONDICAO_NOVA }]);
  const [pastaDestino, setPastaDestino] = useState("");
  const [marcarLida, setMarcarLida] = useState(false);
  const [favoritar, setFavoritar] = useState(false);
  const [encaminharPara, setEncaminharPara] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const [dadosRegras, dadosPastas] = await Promise.all([
          api<{ rules: Regra[] }>("/me/rules"),
          api<{ folders: Pasta[] }>("/me/folders"),
        ]);
        setRegras(dadosRegras.rules);
        // Enviados e Rascunhos não recebem mensagem que chega — o servidor
        // recusaria; nem oferecer.
        setPastas(dadosPastas.folders.filter((pasta) => pasta.kind !== "sent" && pasta.kind !== "drafts"));
      } catch (falha) {
        setErro(falha instanceof Error ? falha.message : "Falha ao carregar os filtros.");
      } finally {
        setCarregado(true);
      }
    })();
  }, []);

  function abrirCriacao() {
    setEditando("");
    setNome("");
    setMatch("all");
    setCondicoes([{ ...CONDICAO_NOVA }]);
    setPastaDestino("");
    setMarcarLida(false);
    setFavoritar(false);
    setEncaminharPara("");
  }

  function abrirEdicao(regra: Regra) {
    setEditando(regra.id);
    setNome(regra.name);
    setMatch(regra.match);
    setCondicoes(regra.conditions.map((condicao) => ({ ...condicao })));
    setPastaDestino(regra.actions.folderId ?? "");
    setMarcarLida(regra.actions.markRead === true);
    setFavoritar(regra.actions.star === true);
    setEncaminharPara(regra.actions.forwardTo ?? "");
  }

  async function recarregar() {
    const dados = await api<{ rules: Regra[] }>("/me/rules");
    setRegras(dados.rules);
  }

  function corpoDaRegra(enabled: boolean) {
    return {
      name: nome.trim(),
      match,
      conditions: condicoes.map((condicao) =>
        condicao.field === "has_attachment"
          ? { field: condicao.field }
          : { field: condicao.field, contains: condicao.contains?.trim() },
      ),
      actions: {
        folderId: pastaDestino || null,
        markRead: marcarLida,
        star: favoritar,
        forwardTo: encaminharPara.trim() || null,
      },
      enabled,
    };
  }

  async function salvarRegra() {
    setErro(null);
    setOcupado(true);
    try {
      if (editando === "") {
        await api("/me/rules", { method: "POST", body: corpoDaRegra(true) });
      } else {
        const atual = regras.find((regra) => regra.id === editando);
        await api(`/me/rules/${editando}`, {
          method: "PUT",
          body: corpoDaRegra(atual?.enabled ?? true),
        });
      }
      await recarregar();
      setEditando(null);
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Não foi possível salvar o filtro.");
    } finally {
      setOcupado(false);
    }
  }

  async function alternar(regra: Regra) {
    setErro(null);
    try {
      await api(`/me/rules/${regra.id}`, {
        method: "PUT",
        body: {
          name: regra.name,
          match: regra.match,
          conditions: regra.conditions,
          actions: regra.actions,
          enabled: !regra.enabled,
        },
      });
      await recarregar();
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Não foi possível alterar o filtro.");
    }
  }

  async function excluir(regra: Regra) {
    if (!window.confirm(`Excluir o filtro "${regra.name}"? Mensagens já entregues ficam onde estão.`)) return;
    setErro(null);
    try {
      await api(`/me/rules/${regra.id}`, { method: "DELETE" });
      await recarregar();
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Não foi possível excluir o filtro.");
    }
  }

  if (!carregado) return <p className="text-sm text-[var(--color-texto-fraco)]">Carregando…</p>;

  return (
    <div className="space-y-4">
      {erro && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-[var(--color-perigo)]">
          {erro}
        </p>
      )}

      {regras.length > 0 && (
        <ul className="space-y-2">
          {regras.map((regra) => (
            <li key={regra.id} className="rounded-lg border border-[var(--color-borda)] px-3 py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className={`text-sm font-medium ${regra.enabled ? "" : "opacity-50"}`}>{regra.name}</p>
                  <p className={`mt-0.5 text-xs text-[var(--color-texto-fraco)] ${regra.enabled ? "" : "opacity-50"}`}>
                    {resumo(regra, pastas)}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2 text-xs">
                  <button
                    onClick={() => void alternar(regra)}
                    className="underline underline-offset-2 hover:text-[var(--color-tinta)]"
                  >
                    {regra.enabled ? "Pausar" : "Ativar"}
                  </button>
                  <button
                    onClick={() => abrirEdicao(regra)}
                    className="underline underline-offset-2 hover:text-[var(--color-tinta)]"
                  >
                    Editar
                  </button>
                  <button
                    onClick={() => void excluir(regra)}
                    className="text-[var(--color-perigo)] underline underline-offset-2"
                  >
                    Excluir
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {regras.length > 1 && (
        <p className="text-xs text-[var(--color-texto-fraco)]">
          A primeira regra que casar com a mensagem decide — a ordem da lista importa.
        </p>
      )}

      {editando === null ? (
        <button
          onClick={abrirCriacao}
          className="rounded-lg border border-[var(--color-borda)] px-3 py-2 text-sm font-medium transition hover:bg-[var(--color-fundo-suave)]"
        >
          Novo filtro
        </button>
      ) : (
        <div className="space-y-3 rounded-lg border border-[var(--color-borda)] p-4">
          <input
            type="text"
            value={nome}
            onChange={(evento) => setNome(evento.target.value)}
            placeholder="Nome do filtro (ex.: Boletos)"
            maxLength={80}
            className={`${campo} w-full`}
          />

          <div className="flex items-center gap-2 text-sm">
            <span>Quando</span>
            <select value={match} onChange={(evento) => setMatch(evento.target.value as "all" | "any")} className={campo}>
              <option value="all">todas as condições</option>
              <option value="any">qualquer condição</option>
            </select>
            <span>valerem:</span>
          </div>

          {condicoes.map((condicao, indice) => (
            <div key={indice} className="flex items-center gap-2">
              <select
                value={condicao.field}
                onChange={(evento) => {
                  const campoNovo = evento.target.value as Condicao["field"];
                  setCondicoes((atuais) =>
                    atuais.map((c, i) => (i === indice ? { field: campoNovo, contains: c.contains } : c)),
                  );
                }}
                className={campo}
              >
                {(Object.keys(NOME_CAMPO) as Condicao["field"][]).map((field) => (
                  <option key={field} value={field}>
                    {NOME_CAMPO[field]}
                  </option>
                ))}
              </select>
              {condicao.field !== "has_attachment" && (
                <input
                  type="text"
                  value={condicao.contains ?? ""}
                  onChange={(evento) =>
                    setCondicoes((atuais) =>
                      atuais.map((c, i) => (i === indice ? { ...c, contains: evento.target.value } : c)),
                    )
                  }
                  placeholder="texto"
                  maxLength={200}
                  className={`${campo} min-w-0 flex-1`}
                />
              )}
              {condicoes.length > 1 && (
                <button
                  onClick={() => setCondicoes((atuais) => atuais.filter((_, i) => i !== indice))}
                  className="text-xs text-[var(--color-texto-fraco)] underline underline-offset-2"
                >
                  remover
                </button>
              )}
            </div>
          ))}

          {condicoes.length < 10 && (
            <button
              onClick={() => setCondicoes((atuais) => [...atuais, { ...CONDICAO_NOVA }])}
              className="text-xs underline underline-offset-2 hover:text-[var(--color-tinta)]"
            >
              + condição
            </button>
          )}

          <div className="space-y-2 border-t border-[var(--color-borda)] pt-3 text-sm">
            <div className="flex items-center gap-2">
              <span>Mover para</span>
              <select value={pastaDestino} onChange={(evento) => setPastaDestino(evento.target.value)} className={campo}>
                <option value="">— manter na Entrada —</option>
                {pastas
                  .filter((pasta) => pasta.kind !== "inbox")
                  .map((pasta) => (
                    <option key={pasta.id} value={pasta.id}>
                      {pasta.name}
                    </option>
                  ))}
              </select>
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={marcarLida} onChange={(evento) => setMarcarLida(evento.target.checked)} />
              Marcar como lida
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={favoritar} onChange={(evento) => setFavoritar(evento.target.checked)} />
              Favoritar
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <span>Encaminhar cópia para</span>
              <input
                type="email"
                value={encaminharPara}
                onChange={(evento) => setEncaminharPara(evento.target.value)}
                placeholder="ninguém — deixe vazio"
                maxLength={200}
                className={`${campo} min-w-0 flex-1`}
              />
            </div>
            {encaminharPara.trim() && (
              <p className="text-xs text-[var(--color-texto-fraco)]">
                A mensagem continua na sua caixa; o destino recebe uma cópia.
              </p>
            )}
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => void salvarRegra()}
              disabled={ocupado}
              className="rounded-lg bg-[var(--color-forte)] px-4 py-2 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] disabled:opacity-50"
            >
              {ocupado ? "Salvando…" : editando === "" ? "Criar filtro" : "Salvar filtro"}
            </button>
            <button
              onClick={() => setEditando(null)}
              className="text-sm underline underline-offset-2 hover:text-[var(--color-tinta)]"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
