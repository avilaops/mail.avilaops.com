"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Editor de texto com formatação básica.
 *
 * `contentEditable` com `execCommand`. A API é oficialmente obsoleta, mas
 * continua sendo a única implementada por todos os navegadores para edição
 * rica — o substituto padronizado nunca saiu do papel. Trocar isso por uma
 * biblioteca de editor traria centenas de KB para negrito, itálico e link.
 *
 * A formatação disponível é de propósito curta: e-mail comercial não precisa
 * de tipografia, precisa de ênfase e link. Menos botões também significa menos
 * HTML esquisito chegando no sanitizador do outro lado.
 */

interface Props {
  valorInicial: string;
  onMudar: (html: string) => void;
  /** Foca no começo, antes da citação, ao responder ou encaminhar. */
  focarNoTopo: boolean;
}

interface Comando {
  chave: string;
  rotulo: string;
  titulo: string;
  comando: string;
  classe?: string;
}

const COMANDOS: Comando[] = [
  { chave: "b", rotulo: "B", titulo: "Negrito (Ctrl+B)", comando: "bold", classe: "font-bold" },
  { chave: "i", rotulo: "I", titulo: "Itálico (Ctrl+I)", comando: "italic", classe: "italic" },
  { chave: "u", rotulo: "U", titulo: "Sublinhado (Ctrl+U)", comando: "underline", classe: "underline" },
  { chave: "ul", rotulo: "•", titulo: "Lista", comando: "insertUnorderedList" },
  { chave: "ol", rotulo: "1.", titulo: "Lista numerada", comando: "insertOrderedList" },
];

export function EditorRico({ valorInicial, onMudar, focarNoTopo }: Props) {
  const area = useRef<HTMLDivElement>(null);
  const [ativos, setAtivos] = useState<Set<string>>(new Set());

  useEffect(() => {
    const elemento = area.current;
    if (!elemento) return;

    // Só na montagem: reescrever o HTML a cada tecla destruiria a posição do
    // cursor. Daqui para frente o DOM é a fonte da verdade do conteúdo.
    elemento.innerHTML = valorInicial;

    elemento.focus();

    if (focarNoTopo) {
      const selecao = window.getSelection();
      const intervalo = document.createRange();
      intervalo.setStart(elemento, 0);
      intervalo.collapse(true);
      selecao?.removeAllRanges();
      selecao?.addRange(intervalo);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sincronizarEstado() {
    const novos = new Set<string>();
    for (const comando of COMANDOS) {
      try {
        if (document.queryCommandState(comando.comando)) novos.add(comando.chave);
      } catch {
        // queryCommandState lança em alguns comandos fora de contexto editável.
      }
    }
    setAtivos(novos);
  }

  function aplicar(comando: string) {
    area.current?.focus();
    document.execCommand(comando, false);
    sincronizarEstado();
    onMudar(area.current?.innerHTML ?? "");
  }

  function inserirLink() {
    const selecao = window.getSelection();
    const texto = selecao?.toString().trim();

    const url = window.prompt(
      texto ? `Endereço para "${texto}"` : "Endereço do link",
      "https://",
    );
    if (!url || url === "https://") return;

    // Só http(s): javascript: aqui viraria XSS na caixa de quem recebe — e o
    // sanitizador do destinatário pode não ser tão rígido quanto o nosso.
    if (!/^https?:\/\//i.test(url)) {
      window.alert("O endereço precisa começar com http:// ou https://");
      return;
    }

    area.current?.focus();
    if (texto) {
      document.execCommand("createLink", false, url);
    } else {
      document.execCommand("insertHTML", false, `<a href="${url}">${url}</a>`);
    }
    onMudar(area.current?.innerHTML ?? "");
  }

  const botao =
    "h-7 min-w-7 rounded px-1.5 text-xs transition hover:bg-[var(--color-hover-suave)]";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-[var(--color-borda)] bg-[var(--color-fundo-suave)] px-2 py-1">
        {COMANDOS.map((comando) => (
          <button
            key={comando.chave}
            type="button"
            title={comando.titulo}
            aria-label={comando.titulo}
            aria-pressed={ativos.has(comando.chave)}
            // onMouseDown com preventDefault: o clique normal tiraria o foco do
            // texto e a seleção sumiria antes do comando ser aplicado.
            onMouseDown={(evento) => {
              evento.preventDefault();
              aplicar(comando.comando);
            }}
            className={`${botao} ${comando.classe ?? ""} ${
              ativos.has(comando.chave) ? "bg-[var(--color-superficie)] ring-1 ring-[var(--color-borda)]" : ""
            }`}
          >
            {comando.rotulo}
          </button>
        ))}

        <button
          type="button"
          title="Inserir link"
          aria-label="Inserir link"
          onMouseDown={(evento) => {
            evento.preventDefault();
            inserirLink();
          }}
          className={botao}
        >
          🔗
        </button>

        <span className="ml-auto pr-1 text-[10px] text-[var(--color-texto-fraco)]">
          Ctrl+Enter envia
        </span>
      </div>

      <div
        ref={area}
        contentEditable
        role="textbox"
        aria-multiline="true"
        aria-label="Corpo da mensagem"
        suppressContentEditableWarning
        onInput={() => onMudar(area.current?.innerHTML ?? "")}
        onKeyUp={sincronizarEstado}
        onMouseUp={sincronizarEstado}
        className="rolagem-fina min-h-40 flex-1 overflow-y-auto px-4 py-3 text-sm leading-relaxed outline-none [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-[var(--color-borda)] [&_blockquote]:pl-3 [&_blockquote]:text-[var(--color-texto-fraco)] [&_a]:text-[var(--color-realce)] [&_a]:underline [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5"
      />
    </div>
  );
}

/**
 * Alternativa em texto puro do corpo HTML.
 *
 * Toda mensagem sai com as duas versões: cliente antigo, leitor de tela e
 * filtro de spam preferem o texto — mensagem só-HTML pontua pior em quase
 * todo antispam.
 */
export function htmlParaTextoSimples(html: string): string {
  const molde = document.createElement("div");
  molde.innerHTML = html;

  // Quebras precisam virar quebras antes de extrair o texto, senão o corpo
  // inteiro vira um parágrafo só.
  for (const elemento of molde.querySelectorAll("br")) {
    elemento.replaceWith("\n");
  }
  for (const elemento of molde.querySelectorAll("p, div, li, blockquote")) {
    elemento.append("\n");
  }

  return (molde.textContent ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/** Converte o texto citado (resposta/encaminhamento) para o corpo do editor. */
export function textoParaHtml(texto: string): string {
  const escapado = texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escapado
    .split("\n")
    .map((linha) => (linha.trim() === "" ? "<div><br></div>" : `<div>${linha}</div>`))
    .join("");
}
