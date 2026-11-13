"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/cliente";
import { CampoDestinatarios } from "@/components/CampoDestinatarios";
import { enviarAnexo, formatarTamanho, type AnexoEnviado } from "@/lib/upload";
import { EditorRico, htmlParaTextoSimples, textoParaHtml } from "@/components/EditorRico";
import type { Anexo } from "@/lib/tipos";
import { useViewportMovel } from "@/lib/useViewportMovel";

/**
 * Janela de composicao.
 *
 * Nasce como painel ancorado no canto, nao como modal de tela cheia: escrever
 * e-mail quase sempre exige consultar outra mensagem no meio, e modal que
 * cobre tudo obriga a fechar (e perder o texto) para conferir um detalhe.
 */

/**
 * Tudo que o compositor precisa para nascer preenchido.
 *
 * Um contexto so, em vez de um par de props por tipo de composicao: responder,
 * responder a todos, encaminhar e retomar rascunho diferem apenas nos campos
 * iniciais e em amarrar (ou nao) a mensagem original.
 */
export interface ContextoComposicao {
  tipo: "novo" | "resposta" | "encaminhamento" | "rascunho";
  /** Mensagem a que se responde. Encaminhamento NAO usa: nao e resposta. */
  messageId?: string;
  /** Rascunho sendo retomado — some ao enviar. */
  draftId?: string;
  mensagemComAnexos?: { id: string; anexos: Anexo[] };
  para?: string[];
  cc?: string[];
  cco?: string[];
  assunto?: string;
  corpo?: string;
}

interface EnderecoEnvio {
  address: string;
  name: string | null;
  primary: boolean;
}

interface AnexoNaTela {
  chave: string;
  nome: string;
  tamanho: number;
  progresso: number;
  enviado: AnexoEnviado | null;
  erro: string | null;
  cancelar: () => void;
}

interface Props {
  contexto: ContextoComposicao;
  onFechar: () => void;
  onEnviado: (enviado: { queuedId: string; rfcMessageId: string; desfazerAteMs: number }) => void;
}

const INTERVALO_RASCUNHO_MS = 4000;

const TITULOS: Record<ContextoComposicao["tipo"], string> = {
  novo: "Nova mensagem",
  resposta: "Responder",
  encaminhamento: "Encaminhar",
  rascunho: "Rascunho",
};

export function Compositor({ contexto, onFechar, onEnviado }: Props) {
  const painel = useRef<HTMLElement>(null);
  const seletorAnexos = useRef<HTMLInputElement>(null);
  const profundidadeArraste = useRef(0);
  const [arrastandoArquivos, setArrastandoArquivos] = useState(false);
  useViewportMovel(painel);
  const [ampliado, setAmpliado] = useState(false);
  const [para, setPara] = useState<string[]>(contexto.para ?? []);
  const [cc, setCc] = useState<string[]>(contexto.cc ?? []);
  const [cco, setCco] = useState<string[]>(contexto.cco ?? []);
  const [mostrarCopias, setMostrarCopias] = useState(Boolean(contexto.cc?.length || contexto.cco?.length));

  const [assunto, setAssunto] = useState(contexto.assunto ?? "");
  // O corpo vive como HTML. A citação chega em texto puro e é convertida uma
  // vez, na montagem — daí em diante quem manda no conteúdo é o editor.
  const [corpo, setCorpo] = useState(() => textoParaHtml(contexto.corpo ?? ""));

  const [anexos, setAnexos] = useState<AnexoNaTela[]>([]);
  const [anexosDaMensagem, setAnexosDaMensagem] = useState(contexto.mensagemComAnexos?.anexos ?? []);
  // As chaves da tela ficam estáveis; os IDs do MIME mudam a cada autosave.
  const origemAnexos = useRef({
    messageId: contexto.mensagemComAnexos?.id ?? "",
    ids: new Map((contexto.mensagemComAnexos?.anexos ?? []).map((anexo) => [anexo.id, anexo.id])),
  });
  const salvamento = useRef<Promise<void>>(Promise.resolve());
  const envioEmCurso = useRef(false);
  const [enderecos, setEnderecos] = useState<EnderecoEnvio[]>([]);
  const [remetente, setRemetente] = useState<string | null>(null);
  const [comAssinatura, setComAssinatura] = useState(true);

  const [enviando, setEnviando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [estadoRascunho, setEstadoRascunho] = useState<"parado" | "salvando" | "salvo">("parado");

  // Retomar rascunho comeca com o id dele: assim o autosave SUBSTITUI o
  // existente em vez de criar um segundo na pasta a cada 4 segundos.
  const rascunhoId = useRef<string | null>(contexto.draftId ?? null);
  const temporizador = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void api<{ addresses: EnderecoEnvio[] }>("/me/send-as")
      .then((dados) => {
        setEnderecos(dados.addresses);
        setRemetente(dados.addresses.find((item) => item.primary)?.address ?? null);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    // Impede que o navegador abra o arquivo e substitua o rascunho quando a
    // queda acontece fora do painel. Texto e links continuam com uso nativo.
    function protegerArraste(evento: DragEvent) {
      if (evento.dataTransfer?.types.includes("Files")) evento.preventDefault();
    }
    function limparArraste() {
      profundidadeArraste.current = 0;
      setArrastandoArquivos(false);
    }
    function protegerQueda(evento: DragEvent) {
      if (!evento.dataTransfer?.types.includes("Files")) return;
      evento.preventDefault();
      limparArraste();
      if (!(evento.target instanceof Node) || !painel.current?.contains(evento.target)) {
        setErro("Solte os arquivos dentro da janela da mensagem para anexar.");
      }
    }
    window.addEventListener("dragover", protegerArraste, true);
    window.addEventListener("drop", protegerQueda, true);
    window.addEventListener("dragend", limparArraste);
    return () => {
      window.removeEventListener("dragover", protegerArraste, true);
      window.removeEventListener("drop", protegerQueda, true);
      window.removeEventListener("dragend", limparArraste);
    };
  }, []);


  const referenciasAnexos = useCallback(() => anexosDaMensagem.length > 0 ? {
    messageId: origemAnexos.current.messageId,
    attachmentIds: anexosDaMensagem.map((anexo) => origemAnexos.current.ids.get(anexo.id) ?? anexo.id),
  } : undefined, [anexosDaMensagem]);

  const salvarRascunho = useCallback(() => {
    // Serializa autosaves para não apagar o MIME que outro salvamento lê.
    const tarefa = salvamento.current.then(async () => {
      if (envioEmCurso.current) return;
      // O editor deixa "<div><br></div>" num corpo vazio, então a checagem tem
      // de olhar o texto extraído, não o HTML.
      if (para.length === 0 && !assunto.trim() && !htmlParaTextoSimples(corpo)) return;

      setEstadoRascunho("salvando");
      try {
        const dados = await api<{ draftId: string; attachments: Anexo[] }>("/me/drafts", {
          method: "POST",
          body: {
            draftId: rascunhoId.current ?? undefined,
            to: para,
            cc,
            bcc: cco,
            subject: assunto,
            // Sempre as duas versões: cliente antigo, leitor de tela e filtro de
            // spam preferem o texto — mensagem só-HTML pontua pior no antispam.
            text: htmlParaTextoSimples(corpo),
            html: corpo,
            inReplyToMessageId: contexto.messageId,
            messageAttachments: referenciasAnexos(),
          },
        });
        rascunhoId.current = dados.draftId;
        if (anexosDaMensagem.length > 0) {
          if (dados.attachments?.length !== anexosDaMensagem.length) {
            throw new Error("Não foi possível confirmar os anexos do rascunho.");
          }
          origemAnexos.current = {
            messageId: dados.draftId,
            ids: new Map(anexosDaMensagem.map((anexo, indice) => [anexo.id, dados.attachments[indice]!.id])),
          };
        }
        setEstadoRascunho("salvo");
      } catch {
        // Falha de rascunho nao interrompe quem esta escrevendo.
        setEstadoRascunho("parado");
      }
    });
    salvamento.current = tarefa;
    return tarefa;
  }, [para, cc, cco, assunto, corpo, contexto.messageId, referenciasAnexos, anexosDaMensagem]);

  useEffect(() => {
    if (temporizador.current) clearTimeout(temporizador.current);
    temporizador.current = setTimeout(() => void salvarRascunho(), INTERVALO_RASCUNHO_MS);

    return () => {
      if (temporizador.current) clearTimeout(temporizador.current);
    };
  }, [salvarRascunho]);

  function anexar(arquivos: FileList | null) {
    if (!arquivos || envioEmCurso.current) return;

    for (const arquivo of Array.from(arquivos)) {
      const chave = `${arquivo.name}-${arquivo.size}-${anexos.length}-${arquivo.lastModified}`;
      const { promessa, cancelar } = enviarAnexo(arquivo, (percentual) => {
        setAnexos((atual) =>
          atual.map((item) => (item.chave === chave ? { ...item, progresso: percentual } : item)),
        );
      });

      setAnexos((atual) => [
        ...atual,
        { chave, nome: arquivo.name, tamanho: arquivo.size, progresso: 0, enviado: null, erro: null, cancelar },
      ]);

      void promessa
        .then((enviado) =>
          setAnexos((atual) =>
            atual.map((item) => (item.chave === chave ? { ...item, enviado, progresso: 100 } : item)),
          ),
        )
        .catch((falha: Error) => {
          if (falha.message === "cancelado") {
            setAnexos((atual) => atual.filter((item) => item.chave !== chave));
            return;
          }
          setAnexos((atual) =>
            atual.map((item) => (item.chave === chave ? { ...item, erro: falha.message } : item)),
          );
        });
    }
  }

  function removerAnexo(chave: string) {
    const alvo = anexos.find((item) => item.chave === chave);
    if (alvo && !alvo.enviado) alvo.cancelar();

    if (alvo?.enviado) {
      void api(`/me/attachments/${alvo.enviado.id}`, { method: "DELETE" }).catch(() => undefined);
    }

    setAnexos((atual) => atual.filter((item) => item.chave !== chave));
  }

  async function enviar() {
    if (envioEmCurso.current) return;
    setErro(null);

    if (para.length === 0) {
      setErro("Informe ao menos um destinatário.");
      return;
    }

    if (anexos.some((item) => item.erro)) {
      setErro("Remova ou envie novamente os anexos com falha antes de enviar.");
      return;
    }
    const subindo = anexos.filter((item) => !item.enviado);
    if (subindo.length > 0) {
      setErro("Aguarde os anexos terminarem de subir.");
      return;
    }

    envioEmCurso.current = true;
    setEnviando(true);
    if (temporizador.current) clearTimeout(temporizador.current);

    try {
      await salvamento.current;
      const enviado = await api<{ queuedId: string; rfcMessageId: string; desfazerAteMs: number }>("/me/messages/send", {
        method: "POST",
        body: {
          to: para,
          cc,
          bcc: cco,
          subject: assunto,
          // Sempre as duas versões: cliente antigo, leitor de tela e filtro de
          // spam preferem o texto — mensagem só-HTML pontua pior no antispam.
          text: htmlParaTextoSimples(corpo),
          html: corpo,
          fromAddress: remetente ?? undefined,
          appendSignature: comAssinatura,
          attachmentIds: anexos.filter((item) => item.enviado).map((item) => item.enviado!.id),
          messageAttachments: referenciasAnexos(),
          inReplyToMessageId: contexto.messageId,
          draftId: rascunhoId.current ?? undefined,
        },
      });

      onEnviado(enviado);
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Falha ao enviar.");
      setEnviando(false);
      envioEmCurso.current = false;
    }
  }

  const prontosParaEnviar = anexos.every((item) => item.enviado && !item.erro);
  const anexosVisiveis = [
    ...anexosDaMensagem.map((anexo) => ({
      chave: anexo.id, nome: anexo.filename ?? "anexo", tamanho: anexo.sizeBytes,
      progresso: 100, pronto: true, erro: null,
      remover: () => setAnexosDaMensagem((atual) => atual.filter((item) => item.id !== anexo.id)),
    })),
    ...anexos.map((anexo) => ({ ...anexo, pronto: Boolean(anexo.enviado), remover: () => removerAnexo(anexo.chave) })),
  ];
  const acoes = (
    <>
      <button
        type="button"
        onClick={() => void enviar()}
        disabled={enviando || !prontosParaEnviar}
        className="min-h-11 rounded-lg bg-[var(--color-forte)] px-4 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] disabled:opacity-50 md:min-h-0 md:px-5 md:py-2"
      >
        {enviando ? "Enviando…" : "Enviar"}
      </button>
      <button
        type="button"
        onClick={() => seletorAnexos.current?.click()}
        disabled={enviando}
        className="min-h-11 rounded-md border border-[var(--color-borda)] px-2.5 text-sm transition hover:bg-[var(--color-fundo-suave)] md:min-h-0 md:py-1.5 md:text-xs"
      >
        Anexar
      </button>
      <label className="flex min-h-11 cursor-pointer items-center gap-1.5 text-xs text-[var(--color-texto-fraco)] md:min-h-0">
        <input type="checkbox" checked={comAssinatura} onChange={(evento) => setComAssinatura(evento.target.checked)} />
        Assinatura
      </label>
    </>
  );

  return (
    <section
      ref={painel}
      role="dialog"
      aria-label={TITULOS[contexto.tipo]}
      onDragEnterCapture={(evento) => {
        if (!evento.dataTransfer.types.includes("Files")) return;
        evento.preventDefault();
        profundidadeArraste.current++;
        if (!envioEmCurso.current) setArrastandoArquivos(true);
      }}
      onDragOverCapture={(evento) => {
        if (!evento.dataTransfer.types.includes("Files")) return;
        evento.preventDefault();
        evento.dataTransfer.dropEffect = envioEmCurso.current ? "none" : "copy";
      }}
      onDragLeaveCapture={(evento) => {
        if (!evento.dataTransfer.types.includes("Files")) return;
        profundidadeArraste.current = Math.max(0, profundidadeArraste.current - 1);
        if (profundidadeArraste.current === 0) setArrastandoArquivos(false);
      }}
      onDropCapture={(evento) => {
        if (!evento.dataTransfer.types.includes("Files")) return;
        evento.preventDefault();
        evento.stopPropagation();
        profundidadeArraste.current = 0;
        setArrastandoArquivos(false);
        anexar(evento.dataTransfer.files);
      }}
      onKeyDown={(evento) => {
        // Ctrl+Enter envia — convenção de todo cliente de e-mail. Enter puro
        // não pode enviar: quebra de linha é o uso normal da tecla no corpo.
        if ((evento.ctrlKey || evento.metaKey) && evento.key === "Enter") {
          evento.preventDefault();
          void enviar();
        }
        if (evento.key === "Escape") onFechar();
      }}
      // No celular ocupa a tela toda: painel ancorado de 340 px deixaria o
      // campo de texto com três linhas visíveis e o teclado cobrindo o resto.
      className={`topo-seguro fixed inset-x-0 top-[var(--topo-viewport-movel,0px)] z-30 flex h-[var(--altura-viewport-movel,100dvh)] min-w-0 flex-col overflow-hidden border-[var(--color-borda)] bg-[var(--color-superficie)] md:border md:shadow-2xl ${ampliado
        ? "md:inset-4 md:mx-auto md:h-auto md:w-[min(64rem,calc(100vw-2rem))] md:rounded-xl"
        : "md:inset-auto md:bottom-0 md:right-6 md:h-[min(42rem,85dvh)] md:w-[min(42rem,calc(100vw-3rem))] md:rounded-t-xl"}`}
    >
      {arrastandoArquivos && (
        <div role="status" className="pointer-events-none absolute inset-0 z-40 flex items-center justify-center rounded-[inherit] border-2 border-dashed border-[var(--color-realce)] bg-[var(--color-superficie)]/95 p-6 text-center text-sm font-medium">
          Solte os arquivos aqui para anexar à mensagem
        </div>
      )}
      <header className="flex shrink-0 items-center justify-between bg-[var(--color-forte)] px-4 text-[var(--color-sobre-forte)] md:rounded-t-xl md:py-2.5">
        <h2 className="text-sm font-medium">{TITULOS[contexto.tipo]}</h2>
        <div className="flex items-center gap-3">
          {estadoRascunho !== "parado" && (
            <span className="text-[11px] text-[var(--color-sobre-forte)]/60">
              {estadoRascunho === "salvando" ? "salvando…" : "rascunho salvo"}
            </span>
          )}
          <button
            type="button"
            onClick={() => setAmpliado((atual) => !atual)}
            aria-label={ampliado ? "Restaurar composição" : "Ampliar composição"}
            aria-pressed={ampliado}
            className="hidden rounded border border-current/30 px-2 py-1 text-xs transition hover:bg-[var(--color-sobre-forte)]/10 md:inline-flex"
          >
            {ampliado ? "Restaurar" : "Ampliar"}
          </button>
          <button
            onClick={onFechar}
            aria-label="Fechar"
            className="min-h-11 min-w-11 rounded text-[var(--color-sobre-forte)]/70 transition hover:bg-[var(--color-sobre-forte)]/10 hover:text-[var(--color-sobre-forte)] md:min-h-0 md:min-w-0 md:px-1.5"
          >
            ×
          </button>
        </div>
      </header>
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--color-borda)] px-4 py-1.5 md:hidden">{acoes}</div>
      <input ref={seletorAnexos} type="file" multiple hidden onChange={(evento) => {
        anexar(evento.target.files);
        evento.target.value = "";
      }} />
      {erro && (
        <p role="alert" className="shrink-0 border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-[var(--color-perigo)]">
          {erro}
        </p>
      )}

      <div className="rolagem-fina flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom,0px)] [&>*]:shrink-0 md:pb-0">
        {enderecos.length > 1 && (
          <div className="flex items-center gap-2 border-b border-[var(--color-borda)] px-4 py-2">
            <span className="text-xs text-[var(--color-texto-fraco)]">De</span>
            <select
              value={remetente ?? ""}
              onChange={(evento) => setRemetente(evento.target.value)}
              aria-label="De"
              className="min-w-0 flex-1 truncate bg-transparent py-1 text-base outline-none md:text-sm"
            >
              {enderecos.map((endereco) => (
                <option key={endereco.address} value={endereco.address}>
                  {endereco.address}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="relative">
          <div className={mostrarCopias ? undefined : "pr-20 md:pr-0"}>
            <CampoDestinatarios rotulo="Para" valores={para} onMudar={setPara} autoFocus={contexto.tipo === "novo" || contexto.tipo === "encaminhamento"} />
          </div>
          {!mostrarCopias && <button
            type="button"
            onClick={() => setMostrarCopias(true)}
            className="absolute right-2 top-0 min-h-11 px-2 text-xs text-[var(--color-texto-fraco)] underline underline-offset-2 md:static md:min-h-0 md:px-4 md:py-1.5"
          >
            Cc / Cco
          </button>}
        </div>

        {mostrarCopias && (
          <>
            <CampoDestinatarios rotulo="Cc" valores={cc} onMudar={setCc} />
            <CampoDestinatarios rotulo="Cco" valores={cco} onMudar={setCco} />
          </>
        )}

        <div className="border-b border-[var(--color-borda)] px-4 py-2">
          <input
            type="text"
            value={assunto}
            onChange={(evento) => setAssunto(evento.target.value)}
            placeholder={contexto.tipo === "resposta" ? "(mantém o assunto original)" : "Assunto"}
            aria-label="Assunto"
            className="w-full bg-transparent py-1 text-base outline-none md:text-sm"
          />
        </div>

        <EditorRico
          valorInicial={corpo}
          onMudar={setCorpo}
          focarNoTopo={contexto.tipo === "resposta" || contexto.tipo === "encaminhamento"}
        />

        {anexosVisiveis.length > 0 && (
          <section aria-label="Anexos para enviar" className="shrink-0 border-t border-[var(--color-borda)]">
            <p className="px-4 pt-2 text-xs font-medium">{anexosVisiveis.length} anexo{anexosVisiveis.length > 1 ? "s" : ""}</p>
            <ul className="rolagem-fina max-h-32 overflow-y-auto overscroll-contain px-4 py-2">
              {anexosVisiveis.map((anexo) => (
                <li key={anexo.chave} className="flex items-center gap-2 py-1">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span title={anexo.nome} className="truncate text-xs font-medium">{anexo.nome}</span>
                      <span className="shrink-0 text-[11px] text-[var(--color-texto-fraco)]">
                        {formatarTamanho(anexo.tamanho)}
                      </span>
                    </div>

                    {anexo.erro ? (
                      <p className="text-[11px] text-[var(--color-perigo)]">{anexo.erro}</p>
                    ) : (
                      !anexo.pronto && (
                        <div className="mt-1 h-0.5 overflow-hidden rounded-full bg-[var(--color-borda)]">
                          <div
                            className="h-full bg-[var(--color-realce)] transition-[width]"
                            style={{ width: `${anexo.progresso}%` }}
                          />
                        </div>
                      )
                    )}
                  </div>

                  <button
                    onClick={anexo.remover}
                    disabled={enviando}
                    aria-label={`Remover ${anexo.nome}`}
                    className="shrink-0 rounded px-1.5 text-xs text-[var(--color-texto-fraco)] transition hover:text-[var(--color-perigo)]"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

      </div>
      <footer className="hidden shrink-0 items-center gap-3 border-t border-[var(--color-borda)] px-4 py-2.5 md:flex">{acoes}</footer>
    </section>
  );
}
