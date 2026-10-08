"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/cliente";
import { atualizarTituloDaAba, avisarSistema } from "@/lib/notificacoes";
import { ListaPastas } from "@/components/ListaPastas";
import { ListaMensagens, type Filtro } from "@/components/ListaMensagens";
import { LeitorMensagem, type ResumoConversa } from "@/components/LeitorMensagem";
import { Compositor, type ContextoComposicao } from "@/components/Compositor";
import { useAtalhos, type Atalho } from "@/lib/atalhos";
import type { Caixa, MensagemCompleta, PaginaMensagens, Pasta, ResumoMensagem } from "@/lib/tipos";

/**
 * Tela principal: pastas, lista e leitura.
 *
 * O estado da lista fica aqui, e nao dentro de cada coluna, porque abrir uma
 * mensagem muda o contador de nao lidas da pasta e o negrito da linha ao mesmo
 * tempo — dividir isso entre componentes deixaria as tres colunas discordando
 * entre si.
 *
 * No celular as tres colunas nao cabem lado a lado, entao `vista` decide qual
 * aparece. Acima de `md` as tres ficam visiveis e `vista` e ignorada.
 */

/** Recorte da lista. A API ja aceitava unread e flagged; faltava a porta. */

type Vista = "pastas" | "lista" | "leitura";

/** Citação no formato que todo cliente de e-mail entende. */
function citar(mensagem: MensagemCompleta): string {
  const data = new Date(mensagem.receivedAt).toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const autor = mensagem.fromName
    ? `${mensagem.fromName} <${mensagem.fromAddress}>`
    : mensagem.fromAddress;

  const original = (mensagem.bodyText ?? "")
    .split("\n")
    .map((linha) => `> ${linha}`)
    .join("\n");

  return `\n\nEm ${data}, ${autor} escreveu:\n${original}\n`;
}

/** Cabeçalho de encaminhamento: quem escreveu, quando e para quem. */
function cabecalhoEncaminhamento(mensagem: MensagemCompleta): string {
  const linhas = [
    "",
    "",
    "---------- Mensagem encaminhada ----------",
    `De: ${mensagem.fromName ? `${mensagem.fromName} <${mensagem.fromAddress}>` : mensagem.fromAddress}`,
    `Data: ${new Date(mensagem.receivedAt).toLocaleString("pt-BR")}`,
    `Assunto: ${mensagem.subject ?? "(sem assunto)"}`,
    `Para: ${mensagem.toAddresses.map((item) => item.address).join(", ")}`,
    "",
    mensagem.bodyText ?? "",
  ];

  return linhas.join("\n");
}

const PREFIXO_ENCAMINHAMENTO = /^(fwd|enc|fw)\s*:/i;

export function PainelCaixa() {
  const [caixa, setCaixa] = useState<Caixa | null>(null);
  const [pastas, setPastas] = useState<Pasta[]>([]);
  const [pastaAtual, setPastaAtual] = useState("inbox");

  const [mensagens, setMensagens] = useState<ResumoMensagem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [carregandoLista, setCarregandoLista] = useState(true);

  const [selecionada, setSelecionada] = useState<string | null>(null);
  const [aberta, setAberta] = useState<MensagemCompleta | null>(null);
  const [conversa, setConversa] = useState<ResumoConversa | null>(null);
  const [carregandoLeitura, setCarregandoLeitura] = useState(false);
  const [ajuda, setAjuda] = useState(false);

  const [selecionados, setSelecionados] = useState<string[]>([]);
  const [busca, setBusca] = useState("");
  const [filtro, setFiltro] = useState<Filtro>("todas");
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  /** Envio dentro da janela de arrependimento; nulo quando o prazo vence. */
  const [desfazivel, setDesfazivel] = useState<{
    queuedId: string;
    rfcMessageId: string;
    ateMs: number;
  } | null>(null);
  const [segundosParaEnviar, setSegundosParaEnviar] = useState(0);
  /**
   * Ultima remocao para a lixeira, enquanto ainda da para desfazer. Guarda a
   * pasta de origem porque a lixeira nao lembra de onde a mensagem veio.
   * Apagar de dentro da lixeira e definitivo e nao passa por aqui.
   */
  const [apagadaRecente, setApagadaRecente] = useState<{ ids: string[]; pastaOrigemId: string } | null>(null);
  const temporizadorApagar = useRef<number | null>(null);
  const [vista, setVista] = useState<Vista>("lista");

  const [composicao, setComposicao] = useState<ContextoComposicao | null>(null);

  const buscaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const emRascunhos = pastaAtual === "drafts";

  function avisar(texto: string) {
    setAviso(texto);
    setTimeout(() => setAviso(null), 4000);
  }

  const carregarPastas = useCallback(async () => {
    try {
      const dados = await api<{ folders: Pasta[] }>("/me/folders");
      setPastas(dados.folders);
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Falha ao carregar pastas.");
    }
  }, []);

  const carregarLista = useCallback(
    async (pasta: string, termo: string, recorte: Filtro, proximoCursor?: string) => {
    setCarregandoLista(true);
    try {
      const parametros = new URLSearchParams({ folder: pasta });
      if (termo.trim()) parametros.set("q", termo.trim());
      // A API ja aceitava os dois recortes; faltava a porta na tela.
      if (recorte === "nao-lidas") parametros.set("unread", "true");
      if (recorte === "favoritas") parametros.set("flagged", "true");
      if (recorte === "arquivos") parametros.set("attachment", "any");
      if (recorte === "imagens") parametros.set("attachment", "image");
      if (recorte === "pdfs") parametros.set("attachment", "pdf");
      if (proximoCursor) parametros.set("cursor", proximoCursor);

      const dados = await api<PaginaMensagens>(`/me/messages?${parametros}`);
      setMensagens((atual) => (proximoCursor ? [...atual, ...dados.messages] : dados.messages));
      setCursor(dados.nextCursor);
      setErro(null);
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Falha ao carregar mensagens.");
    } finally {
      setCarregandoLista(false);
    }
  },
    [],
  );

  useEffect(() => {
    void (async () => {
      try {
        setCaixa(await api<Caixa>("/me"));
      } catch {
        // O helper já redireciona para /entrar quando a sessão morreu.
      }
    })();
    void carregarPastas();
  }, [carregarPastas]);

  useEffect(() => {
    setSelecionados([]);
    void carregarLista(pastaAtual, busca, filtro);
  }, [pastaAtual, busca, filtro, carregarLista]);

  /**
   * Atualiza a pasta aberta e as contagens das pastas.
   *
   * Sem cursor de propósito: pedir a partir do cursor traria a página seguinte,
   * e mensagem nova chega no topo. As duas chamadas vão juntas porque o número
   * de não lidas na barra lateral envelhece junto com a lista.
   */
  /**
   * Esvazia a lixeira de uma vez.
   *
   * A API ja fazia isso; a tela so oferecia apagar uma a uma, entao lixeira
   * com centenas de mensagens era quota presa sem caminho pratico para soltar.
   * Pede confirmacao porque aqui nao ha desfazer: apagar da lixeira e o unico
   * lugar do webmail onde a mensagem sai de vez.
   */
  const esvaziarLixeira = useCallback(async () => {
    const total = pastas.find((pasta) => pasta.kind === "trash")?.total ?? 0;
    if (total === 0) return;
    const aviso =
      total === 1
        ? "Apagar de vez a mensagem da lixeira? Nao da para desfazer."
        : `Apagar de vez as ${total} mensagens da lixeira? Nao da para desfazer.`;
    if (!window.confirm(aviso)) return;

    try {
      const r = await api<{ purged: number; freedBytes: string }>("/me/trash/empty", {
        method: "POST",
      });
      setMensagens([]);
      setAberta(null);
      setSelecionada(null);
      setSelecionados([]);
      void carregarPastas();
      avisar(
        r.purged === 1
          ? "1 mensagem apagada de vez."
          : `${r.purged} mensagens apagadas de vez.`,
      );
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Falha ao esvaziar a lixeira.");
    }
  }, [pastas, carregarPastas]);

  /**
   * Conta o prazo do desfazer e some quando ele vence.
   *
   * O aviso tem que sumir sozinho: botao de desfazer que continua na tela
   * depois da mensagem sair promete o que nao pode cumprir.
   */
  useEffect(() => {
    if (!desfazivel) return;
    const tique = () => {
      const resta = Math.ceil((desfazivel.ateMs - Date.now()) / 1000);
      if (resta <= 0) {
        setDesfazivel(null);
        setSegundosParaEnviar(0);
        return;
      }
      setSegundosParaEnviar(resta);
    };
    tique();
    const timer = window.setInterval(tique, 250);
    return () => window.clearInterval(timer);
  }, [desfazivel]);

  const desfazerEnvio = useCallback(async () => {
    if (!desfazivel) return;
    try {
      const r = await api<{ cancelado: boolean }>("/me/messages/undo-send", {
        method: "POST",
        body: { queuedId: desfazivel.queuedId, rfcMessageId: desfazivel.rfcMessageId },
      });
      setDesfazivel(null);
      if (r.cancelado) {
        avisar("Envio cancelado. A mensagem nao saiu.");
        void carregarPastas();
        void carregarLista(pastaAtual, busca, filtro);
      } else {
        // A corrida com o worker e possivel: dizer que cancelou seria mentira.
        avisar("Tarde demais: a mensagem ja saiu.");
      }
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Falha ao desfazer o envio.");
    }
  }, [desfazivel, carregarPastas, carregarLista, pastaAtual, busca, filtro]);

  const atualizar = useCallback(async () => {
    await Promise.all([carregarLista(pastaAtual, busca, filtro), carregarPastas()]);
  }, [carregarLista, carregarPastas, pastaAtual, busca, filtro]);

  // --- Leitura ---

  const abrir = useCallback(
    async (id: string, comImagens = false) => {
      setSelecionada(id);
      setCarregandoLeitura(true);
      setVista("leitura");

      try {
        const mensagem = await api<MensagemCompleta>(`/me/messages/${id}?images=${comImagens}`);

        // Rascunho não se lê: retoma-se. Abrir no leitor deixaria o cliente
        // olhando o próprio texto sem conseguir continuar de onde parou.
        if (emRascunhos) {
          setComposicao({
            tipo: "rascunho",
            draftId: mensagem.id,
            para: mensagem.toAddresses.map((item) => item.address),
            cc: mensagem.ccAddresses.map((item) => item.address),
            assunto: mensagem.subject ?? "",
            corpo: mensagem.bodyText ?? "",
          });
          setSelecionada(null);
          setVista("lista");
          return;
        }

        setAberta(mensagem);
        setMensagens((atual) => atual.map((item) => (item.id === id ? { ...item, seen: true } : item)));
        void carregarPastas();

        // A conversa carrega depois e sem travar a leitura: a mensagem já está
        // na tela, e o histórico é contexto, não o conteúdo principal.
        setConversa(null);
        if (mensagem.threadKey) {
          void api<ResumoConversa>(`/me/threads/${mensagem.threadKey}`)
            .then(setConversa)
            .catch(() => setConversa(null));
        }
      } catch (falha) {
        setErro(falha instanceof Error ? falha.message : "Falha ao abrir a mensagem.");
      } finally {
        setCarregandoLeitura(false);
      }
    },
    [carregarPastas, emRascunhos],
  );

  /** Some da lista e fecha o painel — usado por apagar, spam e mover. */
  const removerDaLista = useCallback((ids: string[]) => {
    setMensagens((atual) => atual.filter((item) => !ids.includes(item.id)));
    setSelecionados((atual) => atual.filter((id) => !ids.includes(id)));
    setAberta((atual) => (atual && ids.includes(atual.id) ? null : atual));
    setSelecionada((atual) => (atual && ids.includes(atual) ? null : atual));
  }, []);

  const favoritar = useCallback(async (id: string, favorita: boolean) => {
    // Otimista: a estrela responde na hora e volta atrás se o servidor recusar.
    setMensagens((atual) => atual.map((item) => (item.id === id ? { ...item, flagged: favorita } : item)));
    setAberta((atual) => (atual?.id === id ? { ...atual, flagged: favorita } : atual));

    try {
      await api("/me/messages", { method: "PATCH", body: { messageIds: [id], flagged: favorita } });
    } catch (falha) {
      setMensagens((atual) => atual.map((item) => (item.id === id ? { ...item, flagged: !favorita } : item)));
      setAberta((atual) => (atual?.id === id ? { ...atual, flagged: !favorita } : atual));
      setErro(falha instanceof Error ? falha.message : "Falha ao marcar favorita.");
    }
  }, []);

  const mover = useCallback(
    async (ids: string[], folderId: string) => {
      try {
        await api("/me/messages", { method: "PATCH", body: { messageIds: ids, moveToFolderId: folderId } });
        removerDaLista(ids);
        void carregarPastas();
        const destino = pastas.find((pasta) => pasta.id === folderId);
        avisar(`${ids.length === 1 ? "Mensagem movida" : `${ids.length} mensagens movidas`} para ${destino?.name ?? "a pasta"}.`);
      } catch (falha) {
        setErro(falha instanceof Error ? falha.message : "Falha ao mover.");
      }
    },
    [carregarPastas, pastas, removerDaLista],
  );

  /**
   * Arquivar e mover para a pasta Arquivo, nada mais.
   *
   * Existe porque o unico jeito de tirar mensagem da Entrada era apagar ou
   * marcar spam. Quem so queria a Entrada limpa acabava apagando o que ainda
   * precisava, ou marcando como spam algo legitimo, o que ainda envenena o
   * filtro para as proximas.
   *
   * A pasta e de sistema e nasce sozinha: getSystemFolder cria a que faltar,
   * entao caixa antiga ganha o Arquivo na primeira vez que precisar dele.
   */
  /**
   * Adia: a mensagem sai da Entrada e volta sozinha na hora escolhida.
   *
   * As opcoes sao relativas (mais tarde, amanha, semana que vem) e nao um
   * seletor de data: quem adia esta limpando a Entrada, e parar para escolher
   * dia e hora custa mais atencao do que o problema merece.
   */
  const adiar = useCallback(
    async (ids: string[], quando: "tarde" | "amanha" | "semana") => {
      const ate = new Date();
      if (quando === "tarde") {
        ate.setHours(ate.getHours() + 3);
      } else if (quando === "amanha") {
        ate.setDate(ate.getDate() + 1);
        ate.setHours(8, 0, 0, 0);
      } else {
        ate.setDate(ate.getDate() + 7);
        ate.setHours(8, 0, 0, 0);
      }

      try {
        await api("/me/messages/snooze", {
          method: "POST",
          body: { messageIds: ids, until: ate.toISOString() },
        });
        removerDaLista(ids);
        setSelecionados([]);
        void carregarPastas();
        const rotulo = ate.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
        avisar(`${ids.length === 1 ? "Mensagem adiada" : `${ids.length} mensagens adiadas`} ate ${rotulo}.`);
      } catch (falha) {
        setErro(falha instanceof Error ? falha.message : "Falha ao adiar.");
      }
    },
    [carregarPastas, removerDaLista],
  );

  const arquivar = useCallback(
    async (ids: string[]) => {
      const arquivo = pastas.find((pasta) => pasta.kind === "archive");
      if (!arquivo) {
        setErro("A pasta Arquivo ainda nao apareceu. Atualize e tente de novo.");
        return;
      }
      await mover(ids, arquivo.id);
    },
    [pastas, mover],
  );

  const apagar = useCallback(
    async (ids: string[]) => {
      // Pasta de origem, lida antes de a lista esquecer a mensagem. Na lixeira
      // nao ha volta, entao nao oferece desfazer.
      const origem = pastaAtual === "trash" ? null : (mensagens.find((item) => ids.includes(item.id))?.folderId ?? null);
      try {
        await api("/me/messages/delete", { method: "POST", body: { messageIds: ids } });
        removerDaLista(ids);
        void carregarPastas();
        if (origem) {
          if (temporizadorApagar.current) window.clearTimeout(temporizadorApagar.current);
          setApagadaRecente({ ids, pastaOrigemId: origem });
          temporizadorApagar.current = window.setTimeout(() => setApagadaRecente(null), 7000);
        }
      } catch (falha) {
        setErro(falha instanceof Error ? falha.message : "Falha ao apagar.");
      }
    },
    [carregarPastas, mensagens, pastaAtual, removerDaLista],
  );

  /** Tira da lixeira e devolve a pasta de onde saiu; depois recarrega a lista. */
  const desfazerApagar = useCallback(async () => {
    const alvo = apagadaRecente;
    if (!alvo) return;
    if (temporizadorApagar.current) window.clearTimeout(temporizadorApagar.current);
    setApagadaRecente(null);
    try {
      await api("/me/messages", { method: "PATCH", body: { messageIds: alvo.ids, moveToFolderId: alvo.pastaOrigemId } });
      void carregarPastas();
      void carregarLista(pastaAtual, busca, filtro);
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Falha ao restaurar a mensagem.");
    }
  }, [apagadaRecente, busca, carregarLista, carregarPastas, filtro, pastaAtual]);

  const marcarSpam = useCallback(
    async (ids: string[], spam: boolean) => {
      try {
        await api(`/me/messages/${spam ? "report-spam" : "not-spam"}`, {
          method: "POST",
          body: { messageIds: ids },
        });
        removerDaLista(ids);
        void carregarPastas();
      } catch (falha) {
        setErro(falha instanceof Error ? falha.message : "Falha ao mover a mensagem.");
      }
    },
    [carregarPastas, removerDaLista],
  );

  const marcarLida = useCallback(
    async (ids: string[], lida: boolean) => {
      try {
        await api("/me/messages", { method: "PATCH", body: { messageIds: ids, seen: lida } });
        setMensagens((atual) =>
          atual.map((item) => (ids.includes(item.id) ? { ...item, seen: lida } : item)),
        );
        setSelecionados([]);
        void carregarPastas();
      } catch (falha) {
        setErro(falha instanceof Error ? falha.message : "Falha ao marcar.");
      }
    },
    [carregarPastas],
  );

  const marcarTudoLido = useCallback(async () => {
    try {
      await api("/me/messages/mark-all-read", { method: "POST", body: { folder: pastaAtual } });
      setMensagens((atual) => atual.map((item) => ({ ...item, seen: true })));
      void carregarPastas();
    } catch (falha) {
      setErro(falha instanceof Error ? falha.message : "Falha ao marcar como lido.");
    }
  }, [pastaAtual, carregarPastas]);

  /** Espera a digitação parar: uma consulta por tecla castigaria o banco. */
  const buscarComPausa = useCallback((termo: string) => {
    if (buscaTimer.current) clearTimeout(buscaTimer.current);
    buscaTimer.current = setTimeout(() => setBusca(termo), 300);
  }, []);

  // --- Composição ---

  function responder(mensagem: MensagemCompleta, todos: boolean) {
    const proprio = caixa?.address.toLowerCase() ?? "";

    // Responder a todos mantém quem estava na conversa, menos você mesmo —
    // senão a cada resposta a pessoa recebe uma cópia da própria mensagem.
    const copias = todos
      ? [...mensagem.toAddresses, ...mensagem.ccAddresses]
          .map((item) => item.address.toLowerCase())
          .filter((endereco) => endereco && endereco !== proprio && endereco !== mensagem.fromAddress)
      : [];

    setComposicao({
      tipo: "resposta",
      messageId: mensagem.id,
      para: [mensagem.fromAddress],
      cc: [...new Set(copias)],
      // Assunto vazio: quem monta o "Re:" é o servidor, a partir da original.
      assunto: "",
      corpo: citar(mensagem),
    });
  }

  function encaminhar(mensagem: MensagemCompleta) {
    const base = mensagem.subject ?? "(sem assunto)";
    setComposicao({
      tipo: "encaminhamento",
      // Sem `messageId`: encaminhar não é responder, e amarrar In-Reply-To
      // colocaria a mensagem na conversa errada do destinatário.
      assunto: PREFIXO_ENCAMINHAMENTO.test(base) ? base : `Fwd: ${base}`,
      corpo: cabecalhoEncaminhamento(mensagem),
    });
  }

  // Contador no titulo da aba: e o aviso que funciona sem permissao nenhuma,
  // inclusive com a aba em segundo plano e o computador em silencio.
  useEffect(() => {
    const entrada = pastas.find((pasta) => pasta.kind === "inbox");
    atualizarTituloDaAba(entrada?.unread ?? 0);
    return () => atualizarTituloDaAba(0);
  }, [pastas]);

  // --- Aviso de mensagem nova ---

  useEffect(() => {
    // EventSource não aceita cabeçalho customizado, mas manda o cookie da
    // origem — que é justamente onde o token vive. O proxy repassa o fluxo.
    const fonte = new EventSource("/api/mail/me/events", { withCredentials: true });

    fonte.addEventListener("message", (evento) => {
      const dados = JSON.parse((evento as MessageEvent<string>).data) as { messages: ResumoMensagem[] };
      void carregarPastas();

      // Notificacao do sistema vale para qualquer pasta aberta: o que importa
      // e que chegou, nao o que a pessoa esta olhando. A propria funcao se
      // cala quando a aba esta visivel.
      avisarSistema(
        dados.messages.map((m) => ({
          id: m.id,
          fromName: m.fromName,
          fromAddress: m.fromAddress,
          subject: m.subject,
        })),
        (id) => void abrir(id),
      );
      // So mexe na lista se o cliente estiver olhando a Entrada sem recorte.
      // Injetar mensagem nova numa busca em andamento bagunca o resultado, e
      // numa lista de favoritas colocaria no topo o que nao e favorito.
      if (pastaAtual === "inbox" && !busca && filtro === "todas") {
        setMensagens((atual) => {
          const conhecidas = new Set(atual.map((item) => item.id));
          const novas = dados.messages.filter((item) => !conhecidas.has(item.id));
          return novas.length > 0 ? [...novas, ...atual] : atual;
        });

        if (dados.messages.length > 0) {
          avisar(
            dados.messages.length === 1
              ? "Chegou uma mensagem nova."
              : `Chegaram ${dados.messages.length} mensagens novas.`,
          );
        }
      }
    });

    // O servidor encerra o fluxo a cada 5 min de propósito; o EventSource
    // reconecta sozinho, o que também cobre queda de rede.
    fonte.onerror = () => undefined;

    return () => fonte.close();
  }, [pastaAtual, busca, filtro, carregarPastas]);

  // --- Atalhos de teclado ---

  /** Anda pela lista sem tirar a mão do teclado. */
  const navegar = useCallback(
    (passo: number) => {
      if (mensagens.length === 0) return;

      const indiceAtual = mensagens.findIndex((item) => item.id === selecionada);
      const proximo = indiceAtual === -1 ? 0 : indiceAtual + passo;
      const alvo = mensagens[Math.min(Math.max(proximo, 0), mensagens.length - 1)];

      if (alvo) void abrir(alvo.id);
    },
    [mensagens, selecionada, abrir],
  );

  const atalhos: Atalho[] = [
    { tecla: "j", descricao: "Próxima mensagem", acao: () => navegar(1) },
    { tecla: "k", descricao: "Mensagem anterior", acao: () => navegar(-1) },
    { tecla: "u", descricao: "Voltar para a lista", acao: () => setVista("lista") },
    { tecla: "c", descricao: "Escrever", acao: () => setComposicao({ tipo: "novo" }) },
    { tecla: "r", descricao: "Responder", acao: () => aberta && responder(aberta, false) },
    { tecla: "a", descricao: "Responder a todos", acao: () => aberta && responder(aberta, true) },
    { tecla: "f", descricao: "Encaminhar", acao: () => aberta && encaminhar(aberta) },
    { tecla: "s", descricao: "Favoritar", acao: () => aberta && void favoritar(aberta.id, !aberta.flagged) },
    { tecla: "#", descricao: "Apagar", acao: () => aberta && void apagar([aberta.id]) },
    { tecla: "!", descricao: "Marcar como spam", acao: () => aberta && void marcarSpam([aberta.id], true) },
    {
      tecla: "/",
      descricao: "Buscar",
      acao: () => document.querySelector<HTMLInputElement>("input[type='search']")?.focus(),
    },
    { tecla: "?", descricao: "Mostrar atalhos", acao: () => setAjuda((atual) => !atual) },
    { tecla: "Escape", descricao: "Fechar", acao: () => setAjuda(false) },
  ];

  // Desligado enquanto o compositor está aberto: lá as teclas são texto.
  useAtalhos(atalhos, composicao === null);

  // --- Pastas próprias ---

  const criarPasta = useCallback(
    async (nome: string) => {
      try {
        await api("/me/folders", { method: "POST", body: { name: nome } });
        await carregarPastas();
      } catch (falha) {
        setErro(falha instanceof Error ? falha.message : "Falha ao criar a pasta.");
      }
    },
    [carregarPastas],
  );

  const renomearPasta = useCallback(
    async (id: string, nome: string) => {
      try {
        await api(`/me/folders/${id}`, { method: "PATCH", body: { name: nome } });
        await carregarPastas();
      } catch (falha) {
        setErro(falha instanceof Error ? falha.message : "Falha ao renomear a pasta.");
      }
    },
    [carregarPastas],
  );

  const excluirPasta = useCallback(
    async (id: string, nome: string) => {
      // Confirmação porque a ação some com a organização do cliente. As
      // mensagens sobrevivem — o texto diz isso para tirar o medo.
      if (!window.confirm(`Excluir a pasta "${nome}"? As mensagens voltam para a Caixa de Entrada.`)) {
        return;
      }

      try {
        await api(`/me/folders/${id}`, { method: "DELETE" });
        if (pastaAtual === id) setPastaAtual("inbox");
        await carregarPastas();
      } catch (falha) {
        setErro(falha instanceof Error ? falha.message : "Falha ao excluir a pasta.");
      }
    },
    [carregarPastas, pastaAtual],
  );

  return (
    <div className="topo-seguro flex h-dvh max-h-dvh min-h-0 overflow-hidden">
      <div className={`${vista === "pastas" ? "flex" : "hidden"} h-full md:flex`}>
        <ListaPastas
          caixa={caixa}
          pastas={pastas}
          pastaAtual={pastaAtual}
          onEscolher={(chave) => {
            setPastaAtual(chave);
            setAberta(null);
            setSelecionada(null);
            setVista("lista");
          }}
          onEscrever={() => setComposicao({ tipo: "novo" })}
          onCriarPasta={criarPasta}
          onRenomearPasta={renomearPasta}
          onExcluirPasta={excluirPasta}
        />
      </div>

      <div className={`${vista === "lista" ? "flex" : "hidden"} min-w-0 flex-1 md:flex md:flex-none`}>
        <ListaMensagens
          mensagens={mensagens}
          selecionada={selecionada}
          selecionados={selecionados}
          pastas={pastas}
          carregando={carregandoLista}
          temMais={cursor !== null}
          busca={busca}
          emRascunhos={emRascunhos}
          onBuscar={buscarComPausa}
          onAbrir={(id) => void abrir(id)}
          onCarregarMais={() => void carregarLista(pastaAtual, busca, filtro, cursor ?? undefined)}
          onMarcarTudoLido={() => void marcarTudoLido()}
          onAtualizar={() => void atualizar()}
          naLixeira={pastaAtual === "trash"}
          onEsvaziarLixeira={() => void esvaziarLixeira()}
          filtro={filtro}
          onFiltrar={setFiltro}
          onAlternarSelecao={(id) =>
            setSelecionados((atual) =>
              atual.includes(id) ? atual.filter((item) => item !== id) : [...atual, id],
            )
          }
          onSelecionarTodos={(marcar) =>
            setSelecionados(marcar ? mensagens.map((item) => item.id) : [])
          }
          onFavoritar={(id, favorita) => void favoritar(id, favorita)}
          onApagar={(id) => void apagar([id])}
          onLoteLida={(lida) => void marcarLida(selecionados, lida)}
          onLoteMover={(folderId) => void mover(selecionados, folderId)}
          onLoteSpam={() => void marcarSpam(selecionados, pastaAtual !== "spam")}
          onLoteApagar={() => void apagar(selecionados)}
          onLoteArquivar={() => void arquivar(selecionados)}
          onLoteAdiar={(quando) => void adiar(selecionados, quando)}
          podeArquivar={pastaAtual !== "archive"}
          onAbrirPastas={() => setVista("pastas")}
        />
      </div>

      <main className={`${vista === "leitura" ? "flex" : "hidden"} min-w-0 flex-1 flex-col md:flex`}>
        {erro && (
          <div className="border-b border-amber-200 bg-amber-50 px-6 py-2 text-sm text-[var(--color-atencao)]">
            {erro}
          </div>
        )}
        {aviso && (
          <div className="border-b border-emerald-200 bg-emerald-50 px-6 py-2 text-sm text-emerald-800">
            {aviso}
          </div>
        )}

        <div className="min-h-0 flex-1">
          <LeitorMensagem
            mensagem={aberta}
            conversa={conversa}
            carregando={carregandoLeitura}
            emSpam={pastaAtual === "spam"}
            pastas={pastas}
            onLiberarImagens={() => selecionada && void abrir(selecionada, true)}
            onResponder={responder}
            onEncaminhar={encaminhar}
            onFavoritar={(id, favorita) => void favoritar(id, favorita)}
            onMover={(id, folderId) => void mover([id], folderId)}
            onApagar={(id) => void apagar([id])}
            onArquivar={(id) => void arquivar([id])}
            onAdiar={(id, quando) => void adiar([id], quando)}
            podeArquivar={pastaAtual !== "archive"}
            onSpam={(id, spam) => void marcarSpam([id], spam)}
            onVoltar={() => setVista("lista")}
            onAbrirDaConversa={(id) => void abrir(id)}
          />
        </div>
      </main>

      {ajuda && (
        <div
          role="dialog"
          aria-label="Atalhos de teclado"
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-6"
          onClick={() => setAjuda(false)}
        >
          <div
            onClick={(evento) => evento.stopPropagation()}
            className="w-full max-w-sm rounded-xl bg-[var(--color-superficie)] p-6 shadow-2xl"
          >
            <h2 className="mb-4 text-base font-semibold">Atalhos de teclado</h2>
            <dl className="space-y-1.5">
              {atalhos
                .filter((atalho) => atalho.tecla !== "Escape")
                .map((atalho) => (
                  <div key={atalho.tecla} className="flex items-baseline justify-between gap-4">
                    <dt className="text-sm text-[var(--color-texto-fraco)]">{atalho.descricao}</dt>
                    <dd>
                      <kbd className="rounded border border-[var(--color-borda)] bg-[var(--color-fundo-suave)] px-1.5 py-0.5 font-mono text-xs">
                        {atalho.tecla}
                      </kbd>
                    </dd>
                  </div>
                ))}
              <div className="flex items-baseline justify-between gap-4 border-t border-[var(--color-borda)] pt-1.5">
                <dt className="text-sm text-[var(--color-texto-fraco)]">Enviar (no compositor)</dt>
                <dd>
                  <kbd className="rounded border border-[var(--color-borda)] bg-[var(--color-fundo-suave)] px-1.5 py-0.5 font-mono text-xs">
                    Ctrl+Enter
                  </kbd>
                </dd>
              </div>
            </dl>
            <button
              onClick={() => setAjuda(false)}
              className="mt-5 w-full rounded-lg bg-[var(--color-forte)] px-4 py-2 text-sm font-medium text-[var(--color-sobre-forte)]"
            >
              Fechar
            </button>
          </div>
        </div>
      )}

      {composicao && (
        <Compositor
          // A chave remonta o compositor ao trocar de contexto: sem isso,
          // clicar em "Encaminhar" com uma resposta aberta manteria os campos
          // da resposta, porque o estado inicial só é lido na montagem.
          key={`${composicao.tipo}-${composicao.messageId ?? composicao.draftId ?? "novo"}`}
          contexto={composicao}
          onFechar={() => setComposicao(null)}
          onEnviado={(enviado) => {
            setComposicao(null);
            setDesfazivel({
              queuedId: enviado.queuedId,
              rfcMessageId: enviado.rfcMessageId,
              ateMs: enviado.desfazerAteMs,
            });
            void carregarPastas();
            void carregarLista(pastaAtual, busca, filtro);
          }}
        />
      )}
      {/* Fixa no rodape, e nao dentro da coluna de leitura: no celular a
          leitura fica escondida depois de enviar, e o botao de desfazer nunca
          apareceria justamente em quem mais erra o envio, o telefone.
          O respiro extra do iOS vem da mesma classe do resto do app. */}
      {(desfazivel || apagadaRecente) && (
        <div className="rodape-seguro pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 px-4">
          {desfazivel && (
            <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-[var(--color-borda)] bg-[var(--color-superficie)] px-4 py-2.5 text-sm shadow-lg">
              <span>Enviando em {segundosParaEnviar}s…</span>
              <button
                onClick={() => void desfazerEnvio()}
                className="rounded-md border border-[var(--color-borda)] px-2.5 py-1 text-xs font-medium transition hover:bg-[var(--color-fundo-suave)]"
              >
                Desfazer
              </button>
            </div>
          )}
          {apagadaRecente && (
            <div
              role="status"
              className="pointer-events-auto flex items-center gap-3 rounded-xl border border-[var(--color-borda)] bg-[var(--color-superficie)] px-4 py-2.5 text-sm shadow-lg"
            >
              <span>
                {apagadaRecente.ids.length === 1
                  ? "Mensagem movida para a lixeira."
                  : `${apagadaRecente.ids.length} mensagens movidas para a lixeira.`}
              </span>
              <button
                onClick={() => void desfazerApagar()}
                className="rounded-md border border-[var(--color-borda)] px-2.5 py-1 text-xs font-medium transition hover:bg-[var(--color-fundo-suave)]"
              >
                Desfazer
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
