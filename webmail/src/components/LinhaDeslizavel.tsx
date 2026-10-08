"use client";

import { useRef, useState, type ReactNode, type TouchEvent } from "react";

/**
 * Linha da lista que desliza para a esquerda e apaga, como no Mail do iPhone.
 *
 * So reage a toque: no mouse nada muda, e o botao de lixeira continua la.
 * Dois cuidados que separam gesto util de gesto irritante:
 *
 * - **Decide a direcao nos primeiros 10 px.** Movimento mais vertical que
 *   horizontal e rolagem, e a linha nao se mexe. Sem isso, rolar a lista com
 *   o dedo um pouco torto ia arrastando linhas pela metade.
 * - **Confirma pela distancia, nao pela velocidade.** Passou de 96 px, apaga
 *   ao soltar; menos que isso, volta ao lugar. Quem parou no meio ve o fundo
 *   vermelho e entende o que aconteceria.
 *
 * O desfazer nao mora aqui: quem apaga (PainelCaixa) mostra o aviso com
 * "Desfazer", porque e ele quem sabe de que pasta a mensagem saiu.
 */

const LIMIAR_DECISAO = 10;
const LIMIAR_APAGAR = 96;

interface Props {
  children: ReactNode;
  /** Chamado depois da animacao de saida. */
  onApagar: () => void;
  /** Texto do fundo vermelho: "Apagar" ou "Apagar de vez" (na lixeira). */
  rotulo: string;
  /** Classes da face visivel da linha (fundo, hover, espacamento). */
  className?: string;
}

export function LinhaDeslizavel({ children, onApagar, rotulo, className = "" }: Props) {
  const inicio = useRef<{ x: number; y: number } | null>(null);
  const modo = useRef<"indefinido" | "horizontal" | "vertical">("indefinido");
  const [dx, setDx] = useState(0);
  const [arrastando, setArrastando] = useState(false);
  const [saindo, setSaindo] = useState(false);

  function aoIniciar(evento: TouchEvent<HTMLLIElement>) {
    const toque = evento.touches[0];
    if (!toque || saindo) return;
    inicio.current = { x: toque.clientX, y: toque.clientY };
    modo.current = "indefinido";
  }

  function aoMover(evento: TouchEvent<HTMLLIElement>) {
    const toque = evento.touches[0];
    if (!toque || !inicio.current || saindo) return;
    const deltaX = toque.clientX - inicio.current.x;
    const deltaY = toque.clientY - inicio.current.y;

    if (modo.current === "indefinido") {
      if (Math.abs(deltaX) < LIMIAR_DECISAO && Math.abs(deltaY) < LIMIAR_DECISAO) return;
      modo.current = Math.abs(deltaX) > Math.abs(deltaY) ? "horizontal" : "vertical";
      if (modo.current === "horizontal") setArrastando(true);
    }
    if (modo.current !== "horizontal") return;

    // So para a esquerda. Alem do limiar a linha ainda acompanha o dedo, mas
    // com freio: sinaliza que ja passou do ponto sem sumir da tela.
    if (deltaX >= 0) {
      setDx(0);
      return;
    }
    const excedente = Math.max(0, -deltaX - LIMIAR_APAGAR);
    setDx(-(Math.min(-deltaX, LIMIAR_APAGAR) + excedente * 0.35));
  }

  function encerrar(confirmar: boolean) {
    if (modo.current === "horizontal" && confirmar && -dx >= LIMIAR_APAGAR) {
      setSaindo(true);
      setArrastando(false);
      window.setTimeout(onApagar, 180);
    } else {
      setArrastando(false);
      setDx(0);
    }
    inicio.current = null;
    modo.current = "indefinido";
  }

  const progresso = Math.min(1, -dx / LIMIAR_APAGAR);

  return (
    <li
      className="relative overflow-hidden border-b border-[var(--color-borda)]"
      style={{ touchAction: "pan-y" }}
      onTouchStart={aoIniciar}
      onTouchMove={aoMover}
      onTouchEnd={() => encerrar(true)}
      onTouchCancel={() => encerrar(false)}
    >
      <div
        aria-hidden
        className="absolute inset-0 flex items-center justify-end gap-2 bg-[var(--color-perigo)] pr-5 text-sm font-medium text-white"
        style={{ opacity: saindo ? 1 : progresso }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 6h18" />
          <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
          <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
        </svg>
        {rotulo}
      </div>
      <div
        className={`relative ${className}`}
        style={{
          transform: saindo ? "translateX(-100%)" : `translateX(${dx}px)`,
          transition: arrastando ? "none" : "transform 180ms ease-out",
        }}
      >
        {children}
      </div>
    </li>
  );
}
