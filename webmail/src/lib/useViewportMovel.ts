"use client";

import { useEffect, type RefObject } from "react";

export function useViewportMovel(painel: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const elemento = painel.current;
    const viewport = window.visualViewport;
    if (!elemento || !viewport) return;

    const atualizar = () => {
      // O teclado reduz a área visível sem reduzir a viewport de layout no iOS.
      // O zoom manual continua sob controle do navegador.
      if (viewport.scale === 1) {
        elemento.style.setProperty("--altura-viewport-movel", `${viewport.height}px`);
        elemento.style.setProperty("--topo-viewport-movel", `${viewport.offsetTop}px`);
      } else {
        elemento.style.removeProperty("--altura-viewport-movel");
        elemento.style.removeProperty("--topo-viewport-movel");
      }
    };

    atualizar();
    viewport.addEventListener("resize", atualizar);
    viewport.addEventListener("scroll", atualizar);
    return () => {
      viewport.removeEventListener("resize", atualizar);
      viewport.removeEventListener("scroll", atualizar);
    };
  }, [painel]);
}
