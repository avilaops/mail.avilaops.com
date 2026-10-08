"use client";

import type { Pasta, ResumoMensagem } from "@/lib/tipos";
import { LinhaDeslizavel } from "./LinhaDeslizavel";
import { Menu } from "./Menu";

export type Filtro = "todas" | "nao-lidas" | "favoritas" | "arquivos" | "imagens" | "pdfs";

function formatarData(iso: string): string {
  const data = new Date(iso);
  const agora = new Date();

  if (data.toDateString() === agora.toDateString()) {
    return data.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }

  const mesmoAno = data.getFullYear() === agora.getFullYear();
  return data.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "short",
    ...(mesmoAno ? {} : { year: "2-digit" }),
  });
}

function IconeLixeira() {
  return (
    <svg
      aria-hidden
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 6h18" />
      <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

const acaoLote =
  "rounded-md border border-[var(--color-borda)] bg-[var(--color-superficie)] px-2 py-1 text-xs transition hover:bg-[var(--color-fundo-suave)]";

interface Props {
  mensagens: ResumoMensagem[];
  selecionada: string | null;
  selecionados: string[];
  pastas: Pasta[];
  carregando: boolean;
  temMais: boolean;
  busca: string;
  emRascunhos: boolean;
  onBuscar: (termo: string) => void;
  onAbrir: (id: string) => void;
  onCarregarMais: () => void;
  onMarcarTudoLido: () => void;
  /** Busca de novo a pasta atual e as contagens, sem recarregar a página. */
  onAtualizar: () => void;
  onAlternarSelecao: (id: string) => void;
  onSelecionarTodos: (marcar: boolean) => void;
  onFavoritar: (id: string, favorita: boolean) => void;
  /**
   * Apagar uma mensagem direto da lista. Existe porque no celular a caixa de
   * selecao e minuscula e a barra de lote so aparece depois dela: quem queria
   * apagar um e-mail nao achava onde. Na lixeira, apaga de vez.
   */
  onApagar: (id: string) => void;
  onLoteLida: (lida: boolean) => void;
  onLoteMover: (folderId: string) => void;
  onLoteSpam: () => void;
  onLoteApagar: () => void;
  /** Arquivar em lote. Escondido dentro do proprio Arquivo. */
  onLoteArquivar: () => void;
  onLoteAdiar: (quando: "tarde" | "amanha" | "semana") => void;
  podeArquivar: boolean;
  /** Abre a barra de pastas no celular. */
  onAbrirPastas: () => void;
  /** Recorte ativo da lista. */
  filtro: Filtro;
  onFiltrar: (filtro: Filtro) => void;
  /** Lixeira aberta: libera a acao de esvaziar. */
  naLixeira: boolean;
  onEsvaziarLixeira: () => void;
}

/** [filtro, nome curto no gatilho, nome no menu]. */
const RECORTES_DE_ANEXO = [
  ["arquivos", "Arquivos", "Qualquer arquivo"],
  ["imagens", "Imagens", "Imagens"],
  ["pdfs", "PDFs", "PDFs"],
] as const;

const recorte = "shrink-0 rounded-full px-2.5 py-1 text-xs transition";
const recorteAtivo = "bg-[var(--color-realce)] font-medium text-white";
const recorteInativo = "text-[var(--color-texto-fraco)] hover:bg-[var(--color-fundo-suave)]";

export function ListaMensagens({
  mensagens,
  selecionada,
  selecionados,
  pastas,
  carregando,
  temMais,
  busca,
  emRascunhos,
  onBuscar,
  onAbrir,
  onCarregarMais,
  onMarcarTudoLido,
  onAtualizar,
  filtro,
  onFiltrar,
  naLixeira,
  onEsvaziarLixeira,
  onAlternarSelecao,
  onSelecionarTodos,
  onFavoritar,
  onApagar,
  onLoteLida,
  onLoteMover,
  onLoteSpam,
  onLoteApagar,
  onLoteArquivar,
  onLoteAdiar,
  podeArquivar,
  onAbrirPastas,
}: Props) {
  const emLote = selecionados.length > 0;
  const todosMarcados = mensagens.length > 0 && selecionados.length === mensagens.length;
  const proprias = pastas.filter((pasta) => pasta.kind === "custom");
  const anexoAtivo = RECORTES_DE_ANEXO.find(([chave]) => chave === filtro)?.[1];

  return (
    <section className="flex h-full w-full shrink-0 flex-col border-r border-[var(--color-borda)] md:w-[22rem] lg:w-[26rem]">
      <div className="flex items-center gap-2 border-b border-[var(--color-borda)] px-3 py-2.5">
        <button
          onClick={onAbrirPastas}
          aria-label="Abrir pastas"
          className="shrink-0 rounded-md border border-[var(--color-borda)] px-2 py-1.5 text-xs md:hidden"
        >
          ☰
        </button>

        <input
          type="search"
          defaultValue={busca}
          onChange={(evento) => onBuscar(evento.target.value)}
          placeholder="Buscar…"
          className="min-w-0 flex-1 rounded-md border border-[var(--color-borda)] px-3 py-1.5 text-sm outline-none transition focus:border-[var(--color-realce)]"
        />

        {/* Buscar mensagem nova sem recarregar a página. Recarregar perderia a
            leitura aberta, a busca digitada e a rolagem — e no celular ainda
            cobraria o download do aplicativo inteiro de novo. */}
        <button
          onClick={onAtualizar}
          disabled={carregando}
          title="Buscar mensagens novas"
          aria-label="Buscar mensagens novas"
          className="shrink-0 rounded-md border border-[var(--color-borda)] px-2 py-1.5 text-sm leading-none transition hover:bg-[var(--color-fundo-suave)] disabled:opacity-50"
        >
          <span className={carregando ? "inline-block animate-spin" : "inline-block"} aria-hidden>
            ↻
          </span>
        </button>

        <button
          onClick={onMarcarTudoLido}
          title="Marcar tudo como lido"
          className="shrink-0 rounded-md border border-[var(--color-borda)] px-2 py-1.5 text-xs transition hover:bg-[var(--color-fundo-suave)]"
        >
          Ler tudo
        </button>

        {/* So na lixeira. Botao destrutivo em pasta onde ele nao se aplica e
            convite a clique errado. */}
        {naLixeira && (
          <button
            onClick={onEsvaziarLixeira}
            title="Apagar de vez tudo que esta na lixeira"
            className="shrink-0 rounded-md border border-[var(--color-borda)] px-2 py-1.5 text-xs text-[var(--color-perigo)] transition hover:bg-red-50"
          >
            Esvaziar
          </button>
        )}
      </div>

      {/* Recorte da lista. Fica sempre visivel, e nao escondido atras de menu:
          "so as nao lidas" e a pergunta que se faz varias vezes por dia, e um
          recorte ativo precisa ficar obvio para ninguem achar que perdeu
          mensagem. */}
      <div className="flex items-center gap-1 border-b border-[var(--color-borda)] px-3 py-1.5">
        {(
          [
            ["todas", "Todas"],
            ["nao-lidas", "Não lidas"],
            ["favoritas", "Favoritas"],
          ] as const
        ).map(([chave, rotulo]) => (
          <button
            key={chave}
            onClick={() => onFiltrar(chave)}
            aria-pressed={filtro === chave}
            className={`${recorte} ${filtro === chave ? recorteAtivo : recorteInativo}`}
          >
            {rotulo}
          </button>
        ))}

        {/* Os tres recortes de anexo moram num menu: seis botoes lado a lado
            quebravam em duas linhas na coluna estreita. Com um deles ligado, o
            gatilho mostra qual, para o recorte ativo continuar obvio. */}
        <Menu
          titulo="Filtrar por anexo"
          classeGatilho={`${recorte} ${anexoAtivo ? recorteAtivo : recorteInativo}`}
          gatilho={<>{anexoAtivo ?? "Anexos"} ▾</>}
          itens={RECORTES_DE_ANEXO.map(([chave, , rotulo]) => ({
            chave,
            rotulo,
            ativo: filtro === chave,
            onEscolher: () => onFiltrar(filtro === chave ? "todas" : chave),
          }))}
        />
      </div>

      {/* Barra de lote: só aparece com algo selecionado. Ocupar espaço
          permanente com ações que exigem seleção seria desperdício de tela. */}
      {emLote && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-[var(--color-borda)] bg-[var(--color-fundo-suave)] px-3 py-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs font-medium">
            <input
              type="checkbox"
              checked={todosMarcados}
              onChange={(evento) => onSelecionarTodos(evento.target.checked)}
            />
            {selecionados.length} selecionada{selecionados.length > 1 ? "s" : ""}
          </label>

          <span className="mx-1 h-4 w-px bg-[var(--color-borda)]" aria-hidden />

          <button onClick={() => onLoteLida(true)} className={acaoLote}>
            Lida
          </button>
          <button onClick={() => onLoteLida(false)} className={acaoLote}>
            Não lida
          </button>

          {proprias.length > 0 && (
            <select
              aria-label="Mover selecionadas para pasta"
              value=""
              onChange={(evento) => evento.target.value && onLoteMover(evento.target.value)}
              className={`${acaoLote} cursor-pointer`}
            >
              <option value="">Mover…</option>
              {proprias.map((pasta) => (
                <option key={pasta.id} value={pasta.id}>
                  {pasta.name}
                </option>
              ))}
            </select>
          )}

          <button onClick={onLoteSpam} className={acaoLote}>
            Spam
          </button>
          {podeArquivar && (
            <button onClick={onLoteArquivar} className={acaoLote}>
              Arquivar
            </button>
          )}
          <select
            aria-label="Adiar selecionadas"
            value=""
            onChange={(evento) => {
              const v = evento.target.value as "tarde" | "amanha" | "semana" | "";
              if (v) onLoteAdiar(v);
              evento.target.value = "";
            }}
            className={`${acaoLote} cursor-pointer`}
          >
            <option value="">Adiar…</option>
            <option value="tarde">Mais tarde (3 h)</option>
            <option value="amanha">Amanhã, 8h</option>
            <option value="semana">Semana que vem</option>
          </select>
          <button
            onClick={onLoteApagar}
            className={`${acaoLote} text-[var(--color-perigo)] hover:bg-red-50`}
          >
            Apagar
          </button>
        </div>
      )}

      <ul className="rolagem-fina min-h-0 flex-1 overflow-y-auto">
        {mensagens.length === 0 && !carregando && (
          <li className="px-4 py-10 text-center text-sm text-[var(--color-texto-fraco)]">
            {busca || filtro !== "todas" ? "Nada encontrado." : "Nenhuma mensagem aqui."}
          </li>
        )}

        {mensagens.map((mensagem) => {
          const ativa = mensagem.id === selecionada;
          const marcada = selecionados.includes(mensagem.id);

          return (
            <LinhaDeslizavel
              key={mensagem.id}
              rotulo={naLixeira ? "Apagar de vez" : "Apagar"}
              onApagar={() => onApagar(mensagem.id)}
              className={`group flex items-start gap-2 pl-3 pr-2 transition ${
                ativa
                  ? "bg-blue-50"
                  : marcada
                    ? "bg-[var(--color-fundo-suave)]"
                    : "bg-[var(--color-fundo)] hover:bg-[var(--color-fundo-suave)]"
              }`}
            >
              <input
                type="checkbox"
                checked={marcada}
                onChange={() => onAlternarSelecao(mensagem.id)}
                aria-label={`Selecionar mensagem de ${mensagem.fromName || mensagem.fromAddress}`}
                // No desktop a caixa so aparece ao passar o mouse, ou quando ja
                // ha selecao em andamento: uma coluna de caixas vazias era
                // ruido em toda linha. No toque nao ha hover, fica visivel.
                className={`mt-4 shrink-0 transition md:focus-visible:opacity-100 md:group-hover:opacity-100 ${
                  emLote ? "" : "md:opacity-0"
                }`}
              />

              <button onClick={() => onAbrir(mensagem.id)} className="min-w-0 flex-1 py-3 text-left">
                <div className="mb-0.5 flex items-baseline gap-2">
                  {/* Nao lida: ponto azul e negrito no remetente e no assunto.
                      Lida: peso normal e tinta mais apagada. So o ponto nao
                      bastava para separar as duas numa passada de olho. */}
                  {!mensagem.seen && (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-realce)]"
                      aria-label="não lida"
                    />
                  )}
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${
                      mensagem.seen ? "text-[var(--color-tinta-suave)]" : "font-semibold"
                    }`}
                  >
                    {emRascunhos
                      ? mensagem.toAddresses[0]?.address ?? "(sem destinatário)"
                      : mensagem.fromName || mensagem.fromAddress}
                  </span>
                  <span className="shrink-0 text-[11px] text-[var(--color-texto-fraco)]">
                    {formatarData(mensagem.receivedAt)}
                  </span>
                </div>

                <p className={`truncate text-sm ${mensagem.seen ? "text-[var(--color-texto-fraco)]" : "font-semibold"}`}>
                  {mensagem.subject || "(sem assunto)"}
                </p>

                <div className="flex items-center gap-1.5">
                  <p className="min-w-0 flex-1 truncate text-xs text-[var(--color-texto-fraco)]">
                    {mensagem.snippet ?? ""}
                  </p>
                  {mensagem.hasAttachments && (
                    <span className="shrink-0 text-[11px] text-[var(--color-texto-fraco)]" title="Tem anexo">
                      ⎘
                    </span>
                  )}
                  {mensagem.answered && (
                    <span className="shrink-0 text-[11px] text-[var(--color-texto-fraco)]" title="Respondida">
                      ↩
                    </span>
                  )}
                </div>
              </button>

              <button
                onClick={() => onFavoritar(mensagem.id, !mensagem.flagged)}
                aria-pressed={mensagem.flagged}
                aria-label={mensagem.flagged ? "Tirar dos favoritos" : "Marcar como favorita"}
                className={`mt-3 shrink-0 rounded px-1 text-sm transition ${
                  mensagem.flagged
                    ? "text-[var(--color-atencao)]"
                    : "text-transparent group-hover:text-[var(--color-borda)] hover:!text-[var(--color-atencao)]"
                }`}
              >
                {mensagem.flagged ? "★" : "☆"}
              </button>

              {/* Sempre visivel no celular (nao ha hover no toque); no desktop
                  aparece ao passar o mouse, como a estrela. */}
              <button
                onClick={() => onApagar(mensagem.id)}
                aria-label={naLixeira ? "Apagar de vez" : "Apagar mensagem"}
                title={naLixeira ? "Apagar de vez" : "Apagar (vai para a lixeira)"}
                className="mt-2.5 shrink-0 rounded-md p-1.5 text-[var(--color-texto-fraco)] transition hover:bg-red-50 hover:text-[var(--color-perigo)] md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
              >
                <IconeLixeira />
              </button>
            </LinhaDeslizavel>
          );
        })}

        {temMais && (
          <li className="p-3">
            <button
              onClick={onCarregarMais}
              disabled={carregando}
              className="w-full rounded-md border border-[var(--color-borda)] py-2 text-sm transition hover:bg-[var(--color-fundo-suave)] disabled:opacity-50"
            >
              {carregando ? "Carregando…" : "Carregar mais"}
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}
