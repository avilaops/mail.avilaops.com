"use client";

import { useId, useState } from "react";

/**
 * Campo de senha com o olho de "mostrar".
 *
 * Quem digita uma senha provisoria longa (as que a Avila Ops entrega) so
 * descobre que errou uma letra depois do "endereco ou senha invalidos" — e nao
 * consegue distinguir erro de digitacao de senha errada de verdade. O olho
 * resolve isso sem custo de seguranca: o valor ja esta na tela de quem digitou.
 *
 * O botao nao entra na tabulacao (`tabIndex={-1}`): depois da senha, o Tab
 * precisa cair no botao de entrar, nao num controle visual.
 */

interface Props {
  value: string;
  onChange: (valor: string) => void;
  label: string;
  id?: string;
  autoComplete?: string;
  minLength?: number;
  required?: boolean;
  autoFocus?: boolean;
  /** Classe do input; o padrao segue o restante do webmail. */
  className?: string;
  /** Texto de apoio abaixo do campo. */
  ajuda?: React.ReactNode;
}

const PADRAO =
  "w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] py-2.5 pl-3.5 pr-11 text-sm outline-none transition focus:border-[var(--color-realce)]";

export function CampoSenha({
  value,
  onChange,
  label,
  id,
  autoComplete = "current-password",
  minLength,
  required,
  autoFocus,
  className,
  ajuda,
}: Props) {
  const [visivel, setVisivel] = useState(false);
  const gerado = useId();
  const idCampo = id ?? gerado;

  return (
    <div>
      <label htmlFor={idCampo} className="mb-1.5 block text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <input
          id={idCampo}
          type={visivel ? "text" : "password"}
          value={value}
          onChange={(evento) => onChange(evento.target.value)}
          autoComplete={autoComplete}
          minLength={minLength}
          required={required}
          autoFocus={autoFocus}
          className={className ?? PADRAO}
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisivel((atual) => !atual)}
          aria-label={visivel ? "Ocultar senha" : "Mostrar senha"}
          aria-pressed={visivel}
          title={visivel ? "Ocultar senha" : "Mostrar senha"}
          className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-[var(--color-texto-fraco)] transition hover:text-[var(--color-tinta)]"
        >
          {visivel ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M10.6 10.6a2 2 0 0 0 2.8 2.8" />
              <path d="M16.7 16.7A9.5 9.5 0 0 1 12 18c-5 0-9-6-9-6a17 17 0 0 1 4.1-4.7" />
              <path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c5 0 9 6 9 6a17.4 17.4 0 0 1-2.4 3.1" />
              <path d="m3 3 18 18" />
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6Z" />
              <circle cx="12" cy="12" r="2.5" />
            </svg>
          )}
        </button>
      </div>
      {ajuda && <p className="mt-1.5 text-xs text-[var(--color-texto-fraco)]">{ajuda}</p>}
    </div>
  );
}
