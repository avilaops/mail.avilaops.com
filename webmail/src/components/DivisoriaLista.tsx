"use client";

import { useEffect, useRef, type RefObject } from "react";

const CHAVE_LARGURA = "avila-mail-largura-lista";
const MINIMO = 220;
const MAXIMO = 600;
const MINIMO_LEITURA = 320;

/** Redimensiona as colunas sem renderizar novamente a caixa a cada movimento. */
export function DivisoriaLista({ layout, lista, leitura, className }: {
  layout: RefObject<HTMLDivElement | null>;
  lista: RefObject<HTMLDivElement | null>;
  leitura: RefObject<HTMLElement | null>;
  className: string;
}) {
  const controle = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const painel = layout.current;
    const coluna = lista.current;
    const leitor = leitura.current;
    const separador = controle.current;
    if (!painel || !coluna || !leitor || !separador) return;

    let preferida: number | null = null;
    let arraste: { x: number; largura: number; cursor: string; selecao: string; pointerId: number } | null = null;
    try {
      const salva = localStorage.getItem(CHAVE_LARGURA);
      const numero = salva === null ? NaN : Number(salva);
      if (Number.isFinite(numero) && numero >= MINIMO && numero <= MAXIMO) preferida = numero;
    } catch { /* A largura continua ajustável quando o navegador bloqueia armazenamento. */ }

    const limite = () => Math.max(MINIMO, Math.min(MAXIMO, coluna.getBoundingClientRect().width + leitor.getBoundingClientRect().width - MINIMO_LEITURA));
    const aplicar = () => {
      if (!matchMedia("(min-width: 768px)").matches || !coluna.offsetWidth || !leitor.offsetWidth) return;
      const maximo = limite();
      if (preferida === null) painel.style.removeProperty("--mail-list-width");
      else painel.style.setProperty("--mail-list-width", `${Math.min(maximo, Math.max(MINIMO, preferida))}px`);
      const atual = Math.round(coluna.getBoundingClientRect().width);
      separador.setAttribute("aria-valuenow", String(atual));
      separador.setAttribute("aria-valuemax", String(Math.round(maximo)));
      separador.setAttribute("aria-valuetext", `${atual} pixels`);
    };
    const salvar = () => {
      try {
        if (preferida === null) localStorage.removeItem(CHAVE_LARGURA);
        else localStorage.setItem(CHAVE_LARGURA, String(preferida));
      } catch { /* Preferência válida só nesta sessão quando não há localStorage. */ }
    };
    const redefinir = () => { preferida = null; aplicar(); salvar(); };
    const terminar = () => {
      if (!arraste) return;
      const anterior = arraste;
      arraste = null;
      document.body.style.cursor = anterior.cursor;
      document.body.style.userSelect = anterior.selecao;
      separador.removeAttribute("data-arrastando");
      if (separador.hasPointerCapture(anterior.pointerId)) separador.releasePointerCapture(anterior.pointerId);
      salvar();
    };
    const iniciar = (evento: PointerEvent) => {
      if (evento.button !== 0 || arraste) return;
      evento.preventDefault();
      separador.focus();
      arraste = { x: evento.clientX, largura: coluna.getBoundingClientRect().width, cursor: document.body.style.cursor, selecao: document.body.style.userSelect, pointerId: evento.pointerId };
      separador.setPointerCapture(evento.pointerId);
      separador.setAttribute("data-arrastando", "true");
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    };
    const mover = (evento: PointerEvent) => {
      if (!arraste || evento.pointerId !== arraste.pointerId) return;
      preferida = Math.round(Math.min(limite(), Math.max(MINIMO, arraste.largura + evento.clientX - arraste.x)));
      aplicar();
    };
    const teclado = (evento: KeyboardEvent) => {
      const atual = coluna.getBoundingClientRect().width;
      const passo = evento.shiftKey ? 50 : 10;
      if (evento.key === "Enter") { evento.preventDefault(); redefinir(); return; }
      if (evento.key === "Home") preferida = MINIMO;
      else if (evento.key === "End") preferida = limite();
      else if (evento.key === "ArrowLeft") preferida = Math.max(MINIMO, atual - passo);
      else if (evento.key === "ArrowRight") preferida = Math.min(limite(), atual + passo);
      else return;
      evento.preventDefault();
      aplicar();
      salvar();
    };

    const observador = new ResizeObserver(aplicar);
    observador.observe(painel);
    observador.observe(coluna);
    observador.observe(leitor);
    separador.addEventListener("pointerdown", iniciar);
    separador.addEventListener("pointermove", mover);
    separador.addEventListener("pointerup", terminar);
    separador.addEventListener("pointercancel", terminar);
    separador.addEventListener("lostpointercapture", terminar);
    separador.addEventListener("keydown", teclado);
    separador.addEventListener("dblclick", redefinir);
    aplicar();
    return () => {
      terminar();
      observador.disconnect();
      separador.removeEventListener("pointerdown", iniciar);
      separador.removeEventListener("pointermove", mover);
      separador.removeEventListener("pointerup", terminar);
      separador.removeEventListener("pointercancel", terminar);
      separador.removeEventListener("lostpointercapture", terminar);
      separador.removeEventListener("keydown", teclado);
      separador.removeEventListener("dblclick", redefinir);
    };
  }, [layout, lista, leitura]);

  return (
    <div className={`relative z-20 w-0 shrink-0 ${className}`}>
      <div
        ref={controle}
        role="separator"
        tabIndex={0}
        aria-label="Ajustar largura da lista de e-mails"
        aria-orientation="vertical"
        aria-controls="mail-message-list"
        aria-valuemin={MINIMO}
        aria-valuemax={MAXIMO}
        aria-valuenow={288}
        title="Arraste para ajustar. Use as setas ou dê dois cliques para redefinir."
        className="group absolute inset-y-0 -left-1 flex w-2 touch-none cursor-col-resize items-center justify-center outline-none"
      >
        <span aria-hidden className="absolute inset-y-0 w-0.5 rounded-full transition-colors group-hover:bg-[var(--color-realce)] group-focus-visible:bg-[var(--color-realce)] group-data-[arrastando=true]:bg-[var(--color-realce)]" />
        <span aria-hidden className="relative h-9 w-1 rounded-full bg-[var(--color-borda)] transition-colors group-hover:bg-[var(--color-realce)] group-focus-visible:bg-[var(--color-realce)] group-data-[arrastando=true]:bg-[var(--color-realce)]" />
      </div>
    </div>
  );
}
