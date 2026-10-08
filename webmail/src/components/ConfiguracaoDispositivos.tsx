"use client";

import { useState } from "react";

/**
 * "Como coloco esse e-mail no meu celular?" — a pergunta numero 1 do suporte.
 *
 * Os dados ficam aqui dentro do webmail, com botao de copiar, porque o cliente
 * esta sempre digitando em duas telas ao mesmo tempo: a do computador com estes
 * valores e a do celular onde precisa preencher. Errar uma letra do servidor ou
 * esquecer o dominio no usuario e o que mais gera chamado.
 *
 * O host vem de `window.location.hostname`: o webmail e o servidor de e-mail
 * respondem pelo mesmo nome, entao nao ha nada para configurar aqui — e nao ha
 * como a tela mostrar um servidor diferente do que realmente esta no ar.
 */

interface Protocolo {
  nome: string;
  porta: number;
  seguranca: string;
  explicacao: string;
  recomendado?: boolean;
}

function CampoCopiavel({ rotulo, valor }: { rotulo: string; valor: string }) {
  const [copiado, setCopiado] = useState(false);

  async function copiar() {
    try {
      await navigator.clipboard.writeText(valor);
      setCopiado(true);
      window.setTimeout(() => setCopiado(false), 1500);
    } catch {
      // Sem permissao de area de transferencia (http, navegador antigo): o
      // valor continua visivel e selecionavel na tela, entao nada quebra.
    }
  }

  return (
    <div className="flex items-center gap-2">
      <span className="w-24 shrink-0 text-xs text-[var(--color-texto-fraco)]">{rotulo}</span>
      <code className="min-w-0 flex-1 truncate rounded-md bg-[var(--color-fundo-suave)] px-2 py-1 font-mono text-sm">
        {valor}
      </code>
      <button
        onClick={() => void copiar()}
        aria-label={`Copiar ${rotulo}`}
        className="shrink-0 rounded-md border border-[var(--color-borda)] px-2 py-1 text-xs transition hover:bg-[var(--color-fundo-suave)]"
      >
        {copiado ? "copiado" : "copiar"}
      </button>
    </div>
  );
}

function Cartao({
  protocolo,
  host,
  endereco,
}: {
  protocolo: Protocolo;
  host: string;
  endereco: string;
}) {
  return (
    <div
      className={`rounded-lg border p-3 ${
        protocolo.recomendado
          ? "border-[var(--color-realce)] bg-[var(--color-realce)]/5"
          : "border-[var(--color-borda)]"
      }`}
    >
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-sm font-semibold">{protocolo.nome}</h3>
        {protocolo.recomendado && (
          <span className="rounded-full bg-[var(--color-realce)] px-2 py-0.5 text-[11px] font-medium text-white">
            recomendado
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-[var(--color-texto-fraco)]">{protocolo.explicacao}</p>
      <div className="space-y-1.5">
        <CampoCopiavel rotulo="Servidor" valor={host} />
        <CampoCopiavel rotulo="Porta" valor={String(protocolo.porta)} />
        <CampoCopiavel rotulo="Usuário" valor={endereco} />
        <div className="flex items-center gap-2">
          <span className="w-24 shrink-0 text-xs text-[var(--color-texto-fraco)]">Segurança</span>
          <span className="text-sm">{protocolo.seguranca}</span>
        </div>
      </div>
    </div>
  );
}

export function ConfiguracaoDispositivos({ endereco }: { endereco: string }) {
  const [mostrarPop, setMostrarPop] = useState(false);
  const host = typeof window === "undefined" ? "" : window.location.hostname;

  return (
    <div className="space-y-3">
      <Cartao
        protocolo={{
          nome: "Receber — IMAP",
          porta: 993,
          seguranca: "SSL/TLS",
          explicacao:
            "As mensagens ficam no servidor. O que você lê ou apaga no celular aparece igual no computador.",
          recomendado: true,
        }}
        host={host}
        endereco={endereco}
      />

      <Cartao
        protocolo={{
          nome: "Enviar — SMTP",
          porta: 587,
          seguranca: "STARTTLS",
          explicacao: "Mesma senha do webmail. Marque a opção de autenticação no programa de e-mail.",
        }}
        host={host}
        endereco={endereco}
      />

      {mostrarPop ? (
        <Cartao
          protocolo={{
            nome: "Receber — POP3",
            porta: 995,
            seguranca: "SSL/TLS",
            explicacao:
              "Baixa as mensagens para um aparelho só. Use apenas se o programa não aceitar IMAP — é o caso do Gmail em “verificar e-mails de outras contas”.",
          }}
          host={host}
          endereco={endereco}
        />
      ) : (
        <button
          onClick={() => setMostrarPop(true)}
          className="text-xs text-[var(--color-texto-fraco)] underline underline-offset-2"
        >
          Preciso de POP3 (Gmail, programas antigos)
        </button>
      )}

      <p className="pt-1 text-xs text-[var(--color-texto-fraco)]">
        O usuário é sempre o endereço completo, com o <code>@</code> e o domínio. A senha é a mesma
        que você usa aqui no webmail.
      </p>
    </div>
  );
}
