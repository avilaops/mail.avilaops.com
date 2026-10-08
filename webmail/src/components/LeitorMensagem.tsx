"use client";

import { useEffect, useMemo, useState } from "react";
import type { MensagemCompleta, Pasta } from "@/lib/tipos";
import { Menu, type ItemDeMenu } from "@/components/Menu";

/**
 * Painel de leitura.
 *
 * O corpo HTML vai para um iframe com `sandbox` SEM `allow-scripts` e SEM
 * `allow-same-origin`. Isso e a segunda barreira contra XSS — a primeira e a
 * sanitizacao no servidor. Sem `allow-same-origin` o iframe roda numa origem
 * opaca: mesmo que algo executasse la dentro, nao alcancaria o cookie nem o
 * DOM do webmail.
 *
 * `allow-popups` fica ligado para que link de e-mail continue abrindo.
 */

const SANDBOX = "allow-popups allow-popups-to-escape-sandbox";

function formatarData(iso: string): string {
  const data = new Date(iso);
  const hoje = new Date();
  const mesmoDia = data.toDateString() === hoje.toDateString();

  return data.toLocaleString("pt-BR", {
    ...(mesmoDia ? {} : { day: "2-digit", month: "short", year: "numeric" }),
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatarTamanho(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Texto puro vira HTML com os endereços clicáveis.
 *
 * Mensagem sem parte HTML era despejada dentro de um `<pre>` escapado, então um
 * link de recuperação de senha chegava como texto morto: quem recebia tinha de
 * selecionar, copiar e colar na barra do navegador. Em e-mail transacional isso
 * é o caminho inteiro do usuário — e no celular, onde selecionar texto longo é
 * ruim, é onde a pessoa desiste.
 *
 * A ordem importa: escapa primeiro, procura link depois. Fazer o contrário
 * deixaria o `<a>` recém-criado ser escapado junto e apareceria a tag na tela.
 * Como só entram endereços que já saíram do escape, o que vai no `href` não tem
 * `<`, `>`, `"` nem `&` cru.
 *
 * A pontuação final fica de fora do link de propósito: "abra https://x.com/y."
 * termina a frase, e o ponto não é parte do endereço.
 */
export function textoComLinks(texto: string): string {
  const escapado = texto
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const comLinks = escapado.replace(
    /\bhttps?:\/\/[^\s<]+/g,
    (bruto) => {
      const fim = bruto.match(/[.,;:!?)\]]+$/);
      const url = fim ? bruto.slice(0, -fim[0].length) : bruto;
      const sobra = fim ? fim[0] : "";
      return `<a href="${url}" target="_blank" rel="noopener noreferrer nofollow">${url}</a>${sobra}`;
    },
  );

  return `<pre style="white-space:pre-wrap;font-family:inherit;margin:0">${comLinks}</pre>`;
}

/**
 * Nome do arquivo .eml a partir do assunto.
 *
 * Assunto vira nome de arquivo, entao passa por peneira: fora tudo que nao e
 * letra, numero, espaco, ponto ou hifen. Duas armadilhas tratadas aqui, as duas
 * achadas testando com assunto real:
 *
 * - assunto so de pontuacao ("....") sobrava como ".....eml", arquivo oculto e
 *   sem nome no Linux e no Mac;
 * - assunto vazio, ou que sobra vazio depois da peneira, vira "mensagem".
 *
 * Acento e alfabeto nao latino ficam: \p{L} cobre japones e cirilico, e o
 * navegador da conta disso no cabecalho de download.
 */
function nomeDoArquivo(assunto: string | null): string {
  const limpo = (assunto ?? "")
    .replace(/[^\p{L}\p{N} .-]/gu, "")
    .slice(0, 60)
    .replace(/^[.\s-]+|[.\s-]+$/g, "")
    .trim();
  return limpo || "mensagem";
}

// Altura fixa nas duas: botao de texto, botao de icone e gatilho de menu
// precisam alinhar na mesma linha. Com altura vinda do padding, cada tipo de
// elemento saia com um tamanho e a barra parecia desmontada.
const acao =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-[var(--color-borda)] px-2.5 text-xs font-medium transition hover:bg-[var(--color-fundo-suave)]";
const acaoIcone =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[var(--color-borda)] text-sm transition hover:bg-[var(--color-fundo-suave)]";

function Icone({ children }: { children: React.ReactNode }) {
  return (
    <svg
      aria-hidden
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export interface ResumoConversa {
  threadKey: string;
  count: number;
  messages: Array<{
    id: string;
    fromAddress: string;
    fromName: string | null;
    subject: string | null;
    snippet: string | null;
    seen: boolean;
    receivedAt: string;
  }>;
}

interface Props {
  mensagem: MensagemCompleta | null;
  conversa: ResumoConversa | null;
  carregando: boolean;
  emSpam: boolean;
  pastas: Pasta[];
  onLiberarImagens: () => void;
  onResponder: (mensagem: MensagemCompleta, todos: boolean) => void;
  onEncaminhar: (mensagem: MensagemCompleta) => void;
  onFavoritar: (id: string, favorita: boolean) => void;
  onMover: (id: string, folderId: string) => void;
  onApagar: (id: string) => void;
  /** Arquivar: sai da Entrada sem apagar nem sujar o filtro de spam. */
  onArquivar: (id: string) => void;
  onAdiar: (id: string, quando: "tarde" | "amanha" | "semana") => void;
  podeArquivar: boolean;
  onSpam: (id: string, spam: boolean) => void;
  /** Volta para a lista no celular, onde as colunas não cabem lado a lado. */
  onVoltar: () => void;
  onAbrirDaConversa: (id: string) => void;
}

export function LeitorMensagem({
  mensagem,
  conversa,
  carregando,
  emSpam,
  pastas,
  onLiberarImagens,
  onResponder,
  onEncaminhar,
  onFavoritar,
  onMover,
  onApagar,
  onArquivar,
  onAdiar,
  podeArquivar,
  onSpam,
  onVoltar,
  onAbrirDaConversa,
}: Props) {
  const [imagensLiberadas, setImagensLiberadas] = useState(false);
  const [historicoAberto, setHistoricoAberto] = useState(false);

  // Ao trocar de mensagem, o conteudo atual volta a ser o protagonista. Antes,
  // conversas longas chegavam depois da mensagem e empurravam o corpo inteiro
  // para fora da tela, parecendo que o e-mail tinha fechado sozinho.
  useEffect(() => {
    setHistoricoAberto(false);
    setImagensLiberadas(false);
  }, [mensagem?.id]);

  /**
   * Documento do iframe montado por inteiro aqui, com CSP propria: mesmo com
   * o sandbox, negar `script-src` fecha a porta antes de ela ser testada.
   */
  const documento = useMemo(() => {
    if (!mensagem) return "";

    const corpo = mensagem.bodyHtml ?? textoComLinks(mensagem.bodyText ?? "");

    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https: data:; style-src 'unsafe-inline'; font-src data:">
<style>
  body{margin:0;padding:20px;font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.65;color:#1a1a1a;overflow-wrap:break-word}
  img{max-width:100%;height:auto}
  /* Tabela com largura natural, e nao espremida na largura do iframe. E-mail
     de marca (Facebook, newsletter) e montado com tabela aninhada de largura
     fixa; forcar max-width:100% colapsa a celula ate a largura de um caractere
     e, junto com a quebra de palavra, o texto sai uma letra por linha. Melhor
     rolar de lado do que nao conseguir ler. */
  table{max-width:none}
  /* A quebra agressiva fica so onde ela resolve: endereco e palavra gigante,
     que senao estouram a largura. */
  a,code,pre{overflow-wrap:anywhere}
  blockquote{margin:0 0 0 12px;padding-left:12px;border-left:3px solid #e4e6eb;color:#555}
  pre{white-space:pre-wrap}
  /* O iframe nao herda estilo da pagina: sem isto o link fica preto e nao
     parece clicavel, que era metade do problema original. */
  /* CTAs de e-mails costumam depender de imagens ou de CSS externo. Como
     ambos podem ser bloqueados, todo link precisa continuar reconhecível e
     acionável mesmo quando o HTML original chega incompleto. */
  a{display:inline-block;max-width:100%;box-sizing:border-box;margin:2px 0;padding:9px 16px;border-radius:7px;background:#2563eb;color:#fff!important;text-decoration:none;font-weight:650;line-height:1.35;overflow-wrap:anywhere;box-shadow:0 1px 2px rgba(15,23,42,.18)}
  a:hover{background:#1d4ed8;color:#fff!important}
  a:focus-visible{outline:3px solid #93c5fd;outline-offset:2px}
  /* Link que envolve imagem nao vira botao: o botao desenhava uma moldura azul
     em volta de cada foto e de cada logo da mensagem. */
  a:has(img),a:has(img):hover{display:inline;margin:0;padding:0;border-radius:0;background:none;box-shadow:none;color:#2563eb!important;font-weight:inherit}
  /* Imagem bloqueada some em vez de deixar um retangulo vazio do tamanho que o
     remetente declarou. O aviso acima do corpo ja conta que ha imagens. */
  img[data-src]{display:none!important}
</style></head><body>${corpo}</body></html>`;
  }, [mensagem]);

  if (carregando) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-texto-fraco)]">
        Abrindo…
      </div>
    );
  }

  if (!mensagem) {
    return (
      <div className="hidden h-full flex-col items-center justify-center gap-2 px-8 text-center md:flex">
        <div className="h-10 w-10 rounded-lg border border-[var(--color-borda)]" aria-hidden />
        <p className="text-sm text-[var(--color-texto-fraco)]">Escolha uma mensagem para ler.</p>
      </div>
    );
  }

  const remetente = mensagem.fromName || mensagem.fromAddress;
  const proprias = pastas.filter((pasta) => pasta.kind === "custom");
  const haMaisDestinatarios =
    mensagem.toAddresses.length + mensagem.ccAddresses.length > 1 || mensagem.ccAddresses.length > 0;

  const maisAcoes: ItemDeMenu[] = [
    ...(haMaisDestinatarios
      ? [{ chave: "todos", rotulo: "Responder a todos", onEscolher: () => onResponder(mensagem, true) }]
      : []),
    ...proprias.map((pasta) => ({
      chave: `mover-${pasta.id}`,
      rotulo: `Mover para ${pasta.name}`,
      onEscolher: () => onMover(mensagem.id, pasta.id),
    })),
    {
      chave: "spam",
      rotulo: emSpam ? "Não é spam" : "Marcar como spam",
      onEscolher: () => onSpam(mensagem.id, !emSpam),
    },
    // Link, e nao botao com fetch: o proxy injeta o Authorization lendo o
    // cookie httpOnly, entao o navegador baixa direto. Mesmo caminho do anexo.
    {
      chave: "original",
      rotulo: "Baixar original (.eml)",
      href: `/api/mail/me/messages/${mensagem.id}/raw`,
      download: `${nomeDoArquivo(mensagem.subject)}.eml`,
    },
  ];

  return (
    <article className="flex h-full flex-col">
      <header className="border-b border-[var(--color-borda)] px-4 py-4 md:px-5">
        <div className="mb-3 flex items-start gap-3">
          <button
            onClick={onVoltar}
            aria-label="Voltar para a lista"
            className={`${acao} shrink-0 md:hidden`}
          >
            ←
          </button>
          <h1 className="min-w-0 flex-1 text-base font-semibold leading-snug md:text-lg">
            {mensagem.subject || "(sem assunto)"}
          </h1>
          {/* No celular a barra de acoes quebra em tres linhas e "Apagar" se
              perde no fim dela. Aqui ele fica fixo, ao lado do titulo. */}
          <button
            onClick={() => onApagar(mensagem.id)}
            aria-label="Apagar mensagem"
            title="Apagar (vai para a lixeira)"
            className={`${acao} shrink-0 text-[var(--color-perigo)] hover:bg-red-50 md:hidden`}
          >
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
          </button>
        </div>

        {/* Uma linha so, tudo na mesma altura. O que se usa toda hora tem
            lugar fixo; mover, spam e baixar o original ficam no menu. */}
        <div className="mb-3 flex flex-wrap items-center gap-1">
          <button
            onClick={() => onResponder(mensagem, false)}
            className={`${acao} border-transparent bg-[var(--color-forte)] text-[var(--color-sobre-forte)] hover:bg-[var(--color-forte-hover)]`}
          >
            Responder
          </button>
          {/* Só aparece quando há mais alguém para incluir — botão que não muda
              nada em 90% das mensagens é ruído permanente na barra. Em tela
              estreita fica só no menu. */}
          {haMaisDestinatarios && (
            <button onClick={() => onResponder(mensagem, true)} className={`${acao} max-xl:hidden`}>
              Responder a todos
            </button>
          )}
          {/* Abaixo de `lg` o painel de leitura e estreito: o rotulo some e
              fica so o icone, para a barra continuar numa linha. */}
          <button
            onClick={() => onEncaminhar(mensagem)}
            aria-label="Encaminhar"
            title="Encaminhar"
            className={`${acao} max-lg:w-8 max-lg:justify-center max-lg:px-0`}
          >
            <span className="lg:hidden">
              <Icone>
                <path d="M15 5l6 6-6 6" />
                <path d="M21 11H9a6 6 0 0 0-6 6v2" />
              </Icone>
            </span>
            <span className="max-lg:hidden">Encaminhar</span>
          </button>

          <span className="mx-0.5 h-5 w-px bg-[var(--color-borda)]" aria-hidden />

          <button
            onClick={() => onFavoritar(mensagem.id, !mensagem.flagged)}
            aria-pressed={mensagem.flagged}
            aria-label={mensagem.flagged ? "Tirar dos favoritos" : "Marcar como favorita"}
            title={mensagem.flagged ? "Tirar dos favoritos" : "Marcar como favorita"}
            className={`${acaoIcone} ${mensagem.flagged ? "border-amber-300 bg-amber-50 text-[var(--color-atencao)]" : ""}`}
          >
            {mensagem.flagged ? "★" : "☆"}
          </button>

          {podeArquivar && (
            <button
              onClick={() => onArquivar(mensagem.id)}
              aria-label="Arquivar"
              title="Arquivar"
              className={acaoIcone}
            >
              <Icone>
                <rect x="3" y="4" width="18" height="4" rx="1" />
                <path d="M5 8v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
                <path d="M10 12h4" />
              </Icone>
            </button>
          )}

          <Menu
            titulo="Adiar"
            classeGatilho={acaoIcone}
            alinhar="direita"
            gatilho={
              <Icone>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </Icone>
            }
            itens={[
              { chave: "tarde", rotulo: "Mais tarde (3 h)", onEscolher: () => onAdiar(mensagem.id, "tarde") },
              { chave: "amanha", rotulo: "Amanhã, 8h", onEscolher: () => onAdiar(mensagem.id, "amanha") },
              { chave: "semana", rotulo: "Semana que vem", onEscolher: () => onAdiar(mensagem.id, "semana") },
            ]}
          />

          {/* No celular o Apagar ja esta fixo ao lado do titulo. */}
          <button
            onClick={() => onApagar(mensagem.id)}
            aria-label="Apagar"
            title="Apagar (vai para a lixeira)"
            className={`${acaoIcone} text-[var(--color-perigo)] hover:bg-red-50 max-md:hidden`}
          >
            <Icone>
              <path d="M3 6h18" />
              <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
              <path d="M10 11v6M14 11v6" />
            </Icone>
          </button>

          <Menu titulo="Mais ações" classeGatilho={acaoIcone} gatilho="⋯" alinhar="direita" itens={maisAcoes} />
        </div>

        {/* Duas linhas: quem e quando; depois de onde e para quem. */}
        <div className="flex items-center gap-2 text-sm">
          {/* `min-w-0` + `truncate`: endereço de e-mail é uma palavra só, sem
              ponto de quebra. Sem isso ele empurra a linha para fora da coluna
              — some no desktop largo e aparece quando a coluna aperta. */}
          <span className="min-w-0 truncate font-medium">{remetente}</span>
          {mensagem.senderVerified && (
            <span
              title="SPF, DKIM e DMARC conferidos: o remetente é mesmo quem diz ser."
              className="shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700"
            >
              verificado
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs text-[var(--color-texto-fraco)]">
            {formatarData(mensagem.receivedAt)}
          </span>
        </div>

        <p className="mt-0.5 truncate text-xs text-[var(--color-texto-fraco)]">
          {mensagem.fromName && `${mensagem.fromAddress} · `}
          para {mensagem.toAddresses.map((destino) => destino.address).join(", ") || "—"}
          {mensagem.ccAddresses.length > 0 &&
            ` · cc ${mensagem.ccAddresses.map((destino) => destino.address).join(", ")}`}
        </p>
      </header>

      {/* Conversa: recolhida por padrão para nunca encobrir o e-mail que acabou
          de ser aberto. Quando expandida, ganha rolagem própria e altura
          limitada — até uma conversa de monitoramento com dezenas de alertas
          mantém o corpo atual visível. */}
      {conversa && conversa.count > 1 && (
        <div className="shrink-0 border-b border-[var(--color-borda)] bg-[var(--color-fundo-suave)]">
          <button
            type="button"
            onClick={() => setHistoricoAberto((atual) => !atual)}
            aria-expanded={historicoAberto}
            className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left transition hover:bg-[var(--color-hover-suave)] md:px-6"
          >
            <span className="text-[11px] font-medium uppercase tracking-wide text-[var(--color-texto-fraco)]">
              {conversa.count} mensagens nesta conversa
            </span>
            <span className="shrink-0 text-xs font-medium text-[var(--color-realce)]">
              {historicoAberto ? "Ocultar histórico" : "Ver histórico"}
            </span>
          </button>

          {historicoAberto && (
            <ul className="rolagem-fina max-h-[40dvh] space-y-0.5 overflow-y-auto border-t border-[var(--color-borda)] px-4 py-2 md:px-6">
              {conversa.messages
                .filter((item) => item.id !== mensagem.id)
                .map((item) => (
                  <li key={item.id}>
                    <button
                      onClick={() => onAbrirDaConversa(item.id)}
                      className="flex w-full items-baseline gap-2 rounded px-1.5 py-1 text-left text-xs transition hover:bg-[var(--color-hover-suave)]"
                    >
                      <span className={`shrink-0 ${item.seen ? "text-[var(--color-texto-fraco)]" : "font-semibold"}`}>
                        {item.fromName || item.fromAddress}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[var(--color-texto-fraco)]">
                        {item.snippet ?? ""}
                      </span>
                      <span className="shrink-0 text-[10px] text-[var(--color-texto-fraco)]">
                        {formatarData(item.receivedAt)}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      {mensagem.blockedRemoteImages > 0 && !imagensLiberadas && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-200 bg-amber-50 px-4 py-2.5 md:px-6">
          <p className="text-xs text-[var(--color-atencao)]">
            {mensagem.blockedRemoteImages === 1
              ? "1 imagem externa foi bloqueada"
              : `${mensagem.blockedRemoteImages} imagens externas foram bloqueadas`}{" "}
            — elas avisam o remetente que você abriu a mensagem.
          </p>
          <button
            onClick={() => {
              setImagensLiberadas(true);
              onLiberarImagens();
            }}
            className="shrink-0 rounded-md bg-[var(--color-superficie)] px-2.5 py-1 text-xs font-medium ring-1 ring-amber-300 transition hover:bg-amber-100"
          >
            Exibir imagens
          </button>
        </div>
      )}

      {mensagem.quarantineReason && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2.5 md:px-6">
          <p className="text-xs text-[var(--color-perigo)]">
            Esta mensagem caiu no Spam: {mensagem.quarantineReason}.
          </p>
        </div>
      )}

      {/* O corpo vai num cartao com margem: colado nas bordas, o branco do
          e-mail virava um bloco solto no meio da interface escura. */}
      <div className="min-h-0 flex-1 bg-[var(--color-fundo-suave)] p-2 md:p-4">
      <iframe
        // A chave forca o iframe a remontar ao trocar de mensagem: sem isso o
        // navegador reaproveita o documento anterior em alguns casos.
        key={`${mensagem.id}-${imagensLiberadas}`}
        title="Conteúdo da mensagem"
        sandbox={SANDBOX}
        srcDoc={documento}
        // O corpo do e-mail é HTML de terceiro, escrito para fundo branco:
        // manter `bg-white` aqui é o que impede texto preto sobre preto quando
        // a interface está no tema escuro.
        className="h-full w-full rounded-lg border border-[var(--color-borda)] bg-white"
      />
      </div>

      {mensagem.attachments.length > 0 && (
        <footer className="border-t border-[var(--color-borda)] px-4 py-3 md:px-6">
          <p className="mb-2 text-xs font-medium text-[var(--color-texto-fraco)]">
            {mensagem.attachments.length} anexo{mensagem.attachments.length > 1 ? "s" : ""}
          </p>
          <ul className="flex flex-wrap gap-2">
            {mensagem.attachments.map((anexo) => (
              <li key={anexo.id}>
                <a
                  href={`/api/mail/me/messages/${mensagem.id}/attachments/${anexo.id}`}
                  className="flex items-center gap-2 rounded-lg border border-[var(--color-borda)] px-3 py-2 text-xs transition hover:bg-[var(--color-fundo-suave)]"
                >
                  <span className="font-medium">{anexo.filename ?? "anexo"}</span>
                  <span className="text-[var(--color-texto-fraco)]">{formatarTamanho(anexo.sizeBytes)}</span>
                </a>
              </li>
            ))}
          </ul>
        </footer>
      )}
    </article>
  );
}
