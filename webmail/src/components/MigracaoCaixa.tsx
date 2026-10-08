"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/cliente";

/**
 * "Traga seus e-mails antigos".
 *
 * A tela existe para uma pessoa que nao sabe o que e IMAP. Por isso ela pede o
 * provedor atual numa lista, e nao o endereco do servidor: quem sai do Zoho
 * sabe que usa Zoho, mas nao sabe que o servidor se chama imappro.zoho.com.
 *
 * A senha do provedor antigo nao fica no navegador nem volta em resposta
 * nenhuma: vai direto para o servidor, e de la sai do banco quando a copia
 * termina.
 */

interface Migracao {
  id: string;
  sourceHost: string;
  sourceUser: string;
  status: "pendente" | "copiando" | "concluida" | "falhou" | "cancelada";
  totalMessages: number;
  copiedMessages: number;
  skippedMessages: number;
  copiedBytes: string;
  currentFolder: string | null;
  lastError: string | null;
  percentual: number;
  finishedAt: string | null;
}

/** Servidores dos provedores que os clientes daqui realmente usam. */
const PROVEDORES = [
  { rotulo: "Zoho Mail", host: "imappro.zoho.com" },
  { rotulo: "Titan (via Hostinger, HostGator)", host: "imap.titan.email" },
  { rotulo: "Gmail / Google Workspace", host: "imap.gmail.com" },
  { rotulo: "Outlook / Microsoft 365", host: "outlook.office365.com" },
  { rotulo: "Locaweb", host: "imap.locaweb.com.br" },
  { rotulo: "UOL Host", host: "imap.uhserver.com" },
  { rotulo: "Outro (informar o servidor)", host: "" },
];

function formatarBytes(valor: string): string {
  const bytes = Number(valor);
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const campo =
  "w-full rounded-lg border border-[var(--color-borda)] bg-[var(--color-superficie)] px-3 py-2 text-sm outline-none transition focus:border-[var(--color-realce)]";

export function MigracaoCaixa({ endereco }: { endereco: string }) {
  const [migracao, setMigracao] = useState<Migracao | null>(null);
  const [carregando, setCarregando] = useState(true);

  const [provedor, setProvedor] = useState(PROVEDORES[0]!.host);
  const [hostManual, setHostManual] = useState("");
  const [usuario, setUsuario] = useState(endereco);
  const [senha, setSenha] = useState("");

  const [estado, setEstado] = useState<"parado" | "testando" | "enviando">("parado");
  const [sonda, setSonda] = useState<{ pastas: number; mensagens: number } | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const host = provedor || hostManual;

  const carregar = useCallback(async () => {
    try {
      const dados = await api<{ migracao: Migracao | null }>("/me/migracao");
      setMigracao(dados.migracao);
    } catch {
      // Sem migracao ainda: a tela mostra o formulario, e nao um erro.
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // Enquanto copia, atualiza sozinho: quem esta esperando fica olhando a tela.
  useEffect(() => {
    if (migracao?.status !== "copiando" && migracao?.status !== "pendente") return;
    const timer = setInterval(() => void carregar(), 5000);
    return () => clearInterval(timer);
  }, [migracao?.status, carregar]);

  async function testar() {
    setEstado("testando");
    setErro(null);
    setSonda(null);
    try {
      const dados = await api<{ pastas: number; mensagens: number }>("/me/migracao/testar", {
        method: "POST",
        body: JSON.stringify({ host, user: usuario, password: senha }),
      });
      setSonda(dados);
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Nao consegui conectar.");
    } finally {
      setEstado("parado");
    }
  }

  async function começar() {
    setEstado("enviando");
    setErro(null);
    try {
      await api("/me/migracao", {
        method: "POST",
        body: JSON.stringify({ host, user: usuario, password: senha }),
      });
      // A senha some da memoria do navegador assim que deixa de ser necessaria.
      setSenha("");
      setSonda(null);
      await carregar();
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Nao consegui agendar a migracao.");
    } finally {
      setEstado("parado");
    }
  }

  async function cancelar() {
    if (!migracao) return;
    try {
      await api(`/me/migracao/${migracao.id}`, { method: "DELETE" });
      await carregar();
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Nao consegui cancelar.");
    }
  }

  if (carregando) {
    return <p className="text-sm text-[var(--color-texto-fraco)]">Carregando…</p>;
  }

  const emCurso = migracao?.status === "pendente" || migracao?.status === "copiando";

  if (emCurso) {
    return (
      <div className="space-y-3">
        <div className="rounded-lg border border-[var(--color-borda)] p-4">
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <p className="text-sm font-medium">
              {migracao.status === "pendente" ? "Na fila…" : "Copiando suas mensagens…"}
            </p>
            <span className="font-mono text-sm">{migracao.percentual}%</span>
          </div>

          <div
            role="progressbar"
            aria-valuenow={migracao.percentual}
            aria-valuemin={0}
            aria-valuemax={100}
            className="h-2 overflow-hidden rounded-full bg-[var(--color-fundo-suave)]"
          >
            <div
              className="h-full rounded-full bg-[var(--color-realce)] transition-[width] duration-500"
              style={{ width: `${migracao.percentual}%` }}
            />
          </div>

          <p className="mt-2 text-xs text-[var(--color-texto-fraco)]">
            {migracao.copiedMessages} de {migracao.totalMessages} mensagens
            {migracao.currentFolder ? ` · pasta ${migracao.currentFolder}` : ""}
            {Number(migracao.copiedBytes) > 0 ? ` · ${formatarBytes(migracao.copiedBytes)}` : ""}
          </p>
        </div>

        {/* Ninguem precisa ficar de aba aberta esperando. */}
        <p className="text-xs text-[var(--color-texto-fraco)]">
          Pode fechar esta página: a cópia continua sozinha e as mensagens vão aparecendo na sua
          caixa aos poucos.
        </p>

        <button
          onClick={() => void cancelar()}
          className="text-xs text-[var(--color-perigo)] underline underline-offset-2"
        >
          Cancelar a migração
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {migracao?.status === "concluida" && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm">
          <p className="font-medium text-emerald-900">
            Migração concluída: {migracao.copiedMessages} mensagens trazidas de{" "}
            {migracao.sourceHost}.
          </p>
          {migracao.skippedMessages > 0 && (
            <p className="mt-1 text-xs text-emerald-800">
              {migracao.skippedMessages}{" "}
              {migracao.skippedMessages === 1 ? "foi ignorada" : "foram ignoradas"} por já existirem
              aqui ou por serem grandes demais.
            </p>
          )}
        </div>
      )}

      {migracao?.status === "falhou" && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
          <p className="font-medium text-[var(--color-perigo)]">
            A migração parou no meio ({migracao.copiedMessages} já foram copiadas).
          </p>
          <p className="mt-1 text-xs text-red-900">
            Pode tentar de novo: o que já veio não será duplicado.
          </p>
        </div>
      )}

      {erro && (
        <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-[var(--color-perigo)]">
          {erro}
        </p>
      )}

      <div>
        <label htmlFor="provedor" className="mb-1.5 block text-sm font-medium">
          Onde está seu e-mail hoje?
        </label>
        <select
          id="provedor"
          className={campo}
          value={provedor}
          onChange={(evento) => {
            setProvedor(evento.target.value);
            setSonda(null);
          }}
        >
          {PROVEDORES.map((item) => (
            <option key={item.rotulo} value={item.host}>
              {item.rotulo}
            </option>
          ))}
        </select>
      </div>

      {provedor === "" && (
        <div>
          <label htmlFor="host" className="mb-1.5 block text-sm font-medium">
            Servidor IMAP do provedor atual
          </label>
          <input
            id="host"
            className={campo}
            value={hostManual}
            onChange={(evento) => setHostManual(evento.target.value)}
            placeholder="imap.seuprovedor.com.br"
          />
        </div>
      )}

      <div>
        <label htmlFor="usuario-antigo" className="mb-1.5 block text-sm font-medium">
          Usuário no provedor antigo
        </label>
        <input
          id="usuario-antigo"
          className={campo}
          value={usuario}
          onChange={(evento) => setUsuario(evento.target.value)}
          autoComplete="off"
        />
      </div>

      <div>
        <label htmlFor="senha-antiga" className="mb-1.5 block text-sm font-medium">
          Senha no provedor antigo
        </label>
        <input
          id="senha-antiga"
          type="password"
          className={campo}
          value={senha}
          onChange={(evento) => {
            setSenha(evento.target.value);
            setSonda(null);
          }}
          autoComplete="off"
        />
        {/* Gmail e Microsoft nao aceitam a senha normal em programa de e-mail. */}
        <p className="mt-1.5 text-xs text-[var(--color-texto-fraco)]">
          Usamos essa senha só para copiar suas mensagens e a apagamos no fim.
          {(host === "imap.gmail.com" || host === "outlook.office365.com") && (
            <>
              {" "}
              Neste provedor é preciso gerar uma <strong>senha de aplicativo</strong> — a senha
              normal da conta não funciona aqui.
            </>
          )}
        </p>
      </div>

      {sonda && (
        <div className="rounded-lg border border-[var(--color-borda)] bg-[var(--color-fundo-suave)] p-3 text-sm">
          Encontrei <strong>{sonda.mensagens}</strong>{" "}
          {sonda.mensagens === 1 ? "mensagem" : "mensagens"} em {sonda.pastas}{" "}
          {sonda.pastas === 1 ? "pasta" : "pastas"}. Pode trazer tudo.
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={() => void testar()}
          disabled={estado !== "parado" || !host || !usuario || !senha}
          className="rounded-lg border border-[var(--color-borda)] px-4 py-2 text-sm font-medium transition hover:bg-[var(--color-fundo-suave)] disabled:opacity-50"
        >
          {estado === "testando" ? "Conferindo…" : "Conferir acesso"}
        </button>

        {/* So libera depois do teste passar: descobrir que a senha estava errada
            depois de agendar seria descobrir tarde demais. */}
        <button
          onClick={() => void começar()}
          disabled={estado !== "parado" || !sonda}
          className="rounded-lg bg-[var(--color-forte)] px-4 py-2 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] disabled:opacity-50"
        >
          {estado === "enviando" ? "Agendando…" : "Trazer minhas mensagens"}
        </button>
      </div>
    </div>
  );
}
