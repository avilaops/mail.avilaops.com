"use client";

/**
 * Porta da rua do mail.avilaops.com.
 *
 * Quem tem sessão não chega aqui: `app/page.tsx` manda para a caixa. Visitante
 * vê o produto, como no Gmail — sem cair direto no login de outro domínio.
 *
 * A CSP do webmail é `default-src 'self'` (`src/middleware.ts`). Não entra
 * fonte de fora, script de CDN nem imagem de servidor alheio. As cenas são
 * HTML e CSS, de propósito: um print envelhece a cada mudança da interface e
 * exigiria mostrar e-mail de alguém. Os nomes nas cenas são inventados.
 *
 * Só entra aqui o que o serviço realmente faz hoje (tabela do README).
 */

import { useState } from "react";
import Link from "next/link";

const CRIAR_CONTA = "https://app.avilaops.com/email";
const WHATSAPP =
  "https://wa.me/5517991053597?text=" +
  encodeURIComponent("Oi! Quero e-mail com o domínio da minha empresa.");

const PRECO_POR_CAIXA = 10;

type CenaId = "caixa" | "seguranca" | "celular" | "apps";

const CENAS: {
  id: CenaId;
  rotulo: string;
  titulo: string;
  texto: string;
  itens: { titulo: string; texto: string }[];
}[] = [
  {
    id: "caixa",
    rotulo: "A caixa",
    titulo: "A caixa, no navegador",
    texto:
      "Webmail em português, no servidor da Ávila Ops. Não é a única porta: Outlook, Apple Mail e o celular entram pelo mesmo endereço.",
    itens: [
      {
        titulo: "Busca, pastas e regras",
        texto:
          "A busca olha a caixa. As regras movem, marcam e encaminham cópia sozinhas.",
      },
      {
        titulo: "Quinze segundos para desfazer",
        texto:
          "O envio espera 15 segundos na fila. Dentro dessa janela, o botão desfaz. Dá também para adiar a mensagem e ela volta à Entrada na hora marcada.",
      },
      {
        titulo: "Assinatura e resposta automática",
        texto: "As duas moram na conta, não num complemento de navegador.",
      },
    ],
  },
  {
    id: "seguranca",
    rotulo: "Segurança",
    titulo: "Entrega conferida, não prometida",
    texto:
      "SPF, DKIM, DMARC e MX do seu domínio são conferidos todo dia. Se algum cair, a gente descobre antes do cliente que não respondeu.",
    itens: [
      {
        titulo: "O que chega é autenticado",
        texto:
          "Na entrada, a mensagem passa por SPF, DKIM e DMARC. O HTML é limpo antes de abrir: script e pixel de rastreio não entram.",
      },
      {
        titulo: "Anti-spam que aprende com a sua caixa",
        texto:
          "“É spam” e “não é spam” treinam o filtro desta caixa. O que é lixo para você não precisa ser lixo para todo mundo.",
      },
      {
        titulo: "Segunda etapa e aparelho novo",
        texto:
          "TOTP no autenticador que você já usa. Acesso de aparelho novo avisa por e-mail e por push. A lixeira guarda 30 dias antes de apagar.",
      },
    ],
  },
  {
    id: "celular",
    rotulo: "Celular",
    titulo: "No celular, sem loja de aplicativo",
    texto:
      "O webmail instala na tela de início. O aviso de mensagem nova respeita silêncio noturno e pode ficar só na Entrada.",
    itens: [
      {
        titulo: "Notificação na hora",
        texto: "Contador na aba, balão do sistema e Web Push. Dá para desligar.",
      },
      {
        titulo: "A mesma caixa no app que você já tem",
        texto:
          "IMAP e POP3 abertos. O app do Gmail no celular, o Outlook e o Apple Mail falam com a caixa sem gambiarra.",
      },
      {
        titulo: "Várias caixas, uma conta",
        texto:
          "Quem tem mais de uma caixa escolhe qual abrir. Sair de um aparelho não derruba os outros, a menos que você peça.",
      },
    ],
  },
  {
    id: "apps",
    rotulo: "Outros apps",
    titulo: "Aberta para o programa que a equipe já usa",
    texto:
      "A caixa não prende ninguém no navegador. Contatos e agenda viajam junto, no celular e no computador.",
    itens: [
      {
        titulo: "Outlook, Apple Mail e Thunderbird",
        texto: "IMAP e POP3, com o endereço e a senha da caixa, sobre TLS.",
      },
      {
        titulo: "Contatos e agenda",
        texto:
          "CardDAV e CalDAV. iPhone e Mac descobrem sozinhos. DAVx⁵ e Thunderbird aceitam o endereço direto.",
      },
      {
        titulo: "Alias e pega-tudo",
        texto:
          "vendas@ pode cair numa caixa ou num endereço de fora. O que não tiver dono pode ir para uma caixa só.",
      },
    ],
  },
];

const PASSOS = [
  {
    numero: "1",
    titulo: "Informe o domínio",
    texto: "Mostramos na hora os quatro registros de DNS para publicar, com o que cada um faz.",
  },
  {
    numero: "2",
    titulo: "Publique e confira",
    texto: "O botão “já configurei” checa de verdade. Se faltar algo, dizemos o que falta — não “erro”.",
  },
  {
    numero: "3",
    titulo: "Assine e use",
    texto:
      "A caixa é criada depois que o pagamento confirma, e a senha provisória vai para o seu e-mail de contato.",
  },
];

const PERGUNTAS = [
  {
    pergunta: "Quanto custa?",
    resposta: `R$ ${PRECO_POR_CAIXA} por caixa, por mês, no cartão. Não há cobrança de instalação. O valor acompanha o número de caixas: criou mais uma, a cobrança acompanha; tirou, também.`,
  },
  {
    pergunta: "Posso usar o domínio da minha empresa?",
    resposta:
      "Sim. O endereço fica nome@suaempresa.com.br. Na hora do cadastro a página mostra os quatro registros (MX, SPF, DKIM e DMARC) e confere se eles estão no ar.",
  },
  {
    pergunta: "Consigo trazer o que já uso hoje?",
    resposta:
      "Sim. A migração puxa o histórico e as pastas do provedor atual por IMAP. Ninguém precisa começar do zero para trocar de servidor.",
  },
  {
    pergunta: "Funciona no Outlook e no celular?",
    resposta:
      "Funciona. IMAP e POP3 para Outlook, Apple Mail, Thunderbird e o app do Gmail no celular. Contatos e agenda entram por CardDAV e CalDAV. O webmail é mais uma porta, não a única.",
  },
  {
    pergunta: "Como ficam a segurança e os dados?",
    resposta:
      "TLS na conexão, DKIM na saída, SPF, DKIM e DMARC conferidos todo dia, segunda etapa por TOTP e HTML da mensagem limpo antes de abrir. A lixeira fica 30 dias. O dado é da sua empresa; a exclusão de conta segue a política da Ávila Ops.",
  },
  {
    pergunta: "E se eu não cuidar de DNS?",
    resposta:
      "Dá para fazer sozinho, com a checagem da própria página. Se preferir, a gente publica os registros por você — é o mesmo trabalho, pelo WhatsApp.",
  },
  {
    pergunta: "Como começo?",
    resposta:
      "Em “Criar uma conta”. Você informa o domínio, publica os registros, paga e a caixa nasce. Quem já é cliente entra por “Fazer login”.",
  },
];

const NUMEROS = [
  { valor: `R$ ${PRECO_POR_CAIXA}`, rotulo: "por caixa, por mês" },
  { valor: "30 dias", rotulo: "na lixeira, antes de apagar" },
  { valor: "4", rotulo: "registros de DNS conferidos todo dia" },
  { valor: "15 s", rotulo: "para desfazer o envio" },
];

function CenaCaixa() {
  const linhas = [
    { nome: "Marina Costa", assunto: "Proposta de outubro", hora: "09:41", forte: true },
    { nome: "Oficina Lima", assunto: "Nota recebida", hora: "ontem", forte: false },
    { nome: "Você", assunto: "Rascunho: visita de quinta", hora: "seg", forte: false },
    { nome: "Carlos Neri", assunto: "Horário da entrega", hora: "seg", forte: false },
  ];
  return (
    <div className="overflow-hidden rounded-2xl border border-[var(--color-borda)] bg-[var(--color-superficie)] shadow-sm">
      <div className="flex items-center gap-2 border-b border-[var(--color-borda)] px-4 py-3">
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-borda-escura)]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-borda)]" />
        <span className="h-2.5 w-2.5 rounded-full bg-[var(--color-borda)]" />
        <span className="ml-3 truncate text-xs text-[var(--color-texto-fraco)]">mail.avilaops.com</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-[9.5rem_1fr]">
        <div className="hidden border-r border-[var(--color-borda)] p-3 sm:block">
          <span className="block rounded-lg bg-[var(--color-forte)] px-2 py-1.5 text-center text-xs font-medium text-[var(--color-sobre-forte)]">
            Escrever
          </span>
          {[
            ["Entrada", "3"],
            ["Enviados", ""],
            ["Rascunhos", "1"],
            ["Spam", ""],
            ["Lixeira", ""],
          ].map(([pasta, n], i) => (
            <span
              key={pasta}
              className={`mt-1 flex items-center justify-between rounded-md px-2 py-1.5 text-xs ${
                i === 0
                  ? "bg-[var(--color-fundo-suave)] font-semibold"
                  : "text-[var(--color-texto-fraco)]"
              }`}
            >
              {pasta}
              {n ? <span className="text-[var(--color-realce)]">{n}</span> : null}
            </span>
          ))}
        </div>
        <div className="min-w-0 p-2">
          <div className="mb-2 rounded-lg border border-[var(--color-borda)] px-3 py-2 text-xs text-[var(--color-texto-fraco)]">
            Buscar na caixa
          </div>
          {linhas.map((linha) => (
            <div key={linha.assunto} className="flex items-center gap-3 rounded-lg px-2 py-2">
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[var(--color-fundo-suave)] text-[11px] font-semibold text-[var(--color-realce)]">
                {linha.nome.slice(0, 1)}
              </span>
              <span className="min-w-0 flex-1">
                <span className={`block truncate text-sm ${linha.forte ? "font-semibold" : ""}`}>
                  {linha.nome}
                </span>
                <span className="block truncate text-xs text-[var(--color-texto-fraco)]">{linha.assunto}</span>
              </span>
              <span className="shrink-0 text-[11px] text-[var(--color-texto-fraco)]">{linha.hora}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CenaSeguranca() {
  const itens = [
    ["MX", "mail.avilaops.com", "no ar"],
    ["SPF", "include da Ávila Ops", "no ar"],
    ["DKIM", "assinatura do domínio", "no ar"],
    ["DMARC", "política publicada", "no ar"],
  ];
  return (
    <div className="rounded-2xl border border-[var(--color-borda)] bg-[var(--color-superficie)] p-4 shadow-sm sm:p-5">
      <p className="text-sm font-semibold">Conferência de hoje</p>
      <p className="mt-1 text-xs text-[var(--color-texto-fraco)]">suaempresa.com.br · todo dia, automático</p>
      <ul className="mt-4 space-y-2">
        {itens.map(([nome, detalhe, estado]) => (
          <li
            key={nome}
            className="flex items-center justify-between gap-3 rounded-xl border border-[var(--color-borda)] px-3 py-2.5"
          >
            <span>
              <span className="block text-sm font-semibold">{nome}</span>
              <span className="block text-xs text-[var(--color-texto-fraco)]">{detalhe}</span>
            </span>
            <span className="shrink-0 rounded-full bg-[var(--color-fundo-suave)] px-2 py-1 text-[11px] font-medium text-[var(--color-realce)]">
              {estado}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function CenaCelular() {
  return (
    <div className="mx-auto w-full max-w-[16rem] rounded-[1.75rem] border border-[var(--color-borda)] bg-[var(--color-superficie)] p-3 shadow-sm">
      <div className="rounded-2xl bg-[var(--color-fundo-suave)] p-3">
        <p className="text-center text-[11px] text-[var(--color-texto-fraco)]">09:41</p>
        <div className="mt-6 rounded-2xl border border-[var(--color-borda)] bg-[var(--color-superficie)] p-3 shadow-sm">
          <p className="text-[11px] font-semibold text-[var(--color-realce)]">Ávila Mail</p>
          <p className="mt-1 text-sm font-semibold">Marina Costa</p>
          <p className="text-xs text-[var(--color-texto-fraco)]">Proposta de outubro — pode confirmar o horário?</p>
        </div>
        <div className="mt-3 rounded-2xl border border-[var(--color-borda)] bg-[var(--color-superficie)] p-3">
          <p className="text-xs font-medium">Silêncio noturno ligado</p>
          <p className="mt-1 text-[11px] text-[var(--color-texto-fraco)]">Só a Entrada · dá para desligar</p>
        </div>
      </div>
    </div>
  );
}

function CenaApps() {
  const apps: [string, string][] = [
    ["Outlook", "IMAP · enviar e receber"],
    ["Apple Mail", "IMAP · iPhone e Mac"],
    ["Thunderbird", "IMAP e contatos"],
    ["Agenda e contatos", "CalDAV e CardDAV"],
  ];
  return (
    <ul className="space-y-2">
      {apps.map(([nome, detalhe]) => (
        <li
          key={nome}
          className="flex items-center gap-3 rounded-2xl border border-[var(--color-borda)] bg-[var(--color-superficie)] px-4 py-3 shadow-sm"
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[var(--color-fundo-suave)] text-xs font-semibold text-[var(--color-realce)]">
            {nome.slice(0, 1)}
          </span>
          <span>
            <span className="block text-sm font-semibold">{nome}</span>
            <span className="block text-xs text-[var(--color-texto-fraco)]">{detalhe}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function Cena({ id }: { id: CenaId }) {
  if (id === "seguranca") return <CenaSeguranca />;
  if (id === "celular") return <CenaCelular />;
  if (id === "apps") return <CenaApps />;
  return <CenaCaixa />;
}

export function PaginaInicial() {
  const [cena, setCena] = useState<CenaId>("caixa");
  const [abertas, setAbertas] = useState<boolean[]>(() => PERGUNTAS.map((_, i) => i === 0));
  const atual = CENAS.find((item) => item.id === cena) ?? CENAS[0]!;
  const todasAbertas = abertas.every(Boolean);

  return (
    <div className="flex min-h-full flex-col bg-[var(--color-fundo)]">
      <header className="topo-seguro sticky top-0 z-20 border-b border-[var(--color-borda)] bg-[var(--color-fundo)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link href="/" className="flex shrink-0 items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- ícone estático, sem otimização */}
            <img
              src="/web-app-manifest-192x192.png"
              alt="Ávila Mail"
              width={40}
              height={40}
              className="h-9 w-9 rounded-xl shadow-sm sm:h-10 sm:w-10"
            />
            <span className="text-sm font-semibold tracking-tight">Ávila Mail</span>
          </Link>

          <nav className="flex items-center gap-1 sm:gap-3">
            <a
              href="/entrar"
              className="rounded-full px-3 py-2 text-sm font-medium whitespace-nowrap text-[var(--color-realce)] transition hover:bg-[var(--color-fundo-suave)]"
            >
              Fazer login
            </a>
            <a
              href={CRIAR_CONTA}
              className="rounded-full bg-[var(--color-forte)] px-3 py-2 text-sm font-medium whitespace-nowrap text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] sm:px-4"
            >
              Criar uma conta
            </a>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto grid max-w-6xl items-center gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-2 lg:gap-16">
          <div>
            <p className="text-xs font-semibold tracking-[0.14em] text-[var(--color-realce)] uppercase">
              E-mail corporativo
            </p>
            <h1 className="mt-3 max-w-xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
              E-mail com o domínio da sua empresa
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-pretty text-[var(--color-texto-fraco)] sm:text-lg">
              Servidor próprio da Ávila Ops. Webmail, IMAP e os e-mails antigos trazidos do provedor
              atual. R$ {PRECO_POR_CAIXA} por caixa, por mês, sem cobrança de instalação.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a
                href={CRIAR_CONTA}
                className="rounded-full bg-[var(--color-forte)] px-6 py-3 text-center text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)]"
              >
                Criar uma conta
              </a>
              <a
                href={WHATSAPP}
                className="rounded-full border border-[var(--color-borda)] px-6 py-3 text-center text-sm font-medium transition hover:bg-[var(--color-fundo-suave)]"
              >
                Falar no WhatsApp
              </a>
            </div>
          </div>
          <CenaCaixa />
        </section>

        <section className="border-t border-[var(--color-borda)]">
          <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
            <dl className="grid grid-cols-2 gap-6 lg:grid-cols-4">
              {NUMEROS.map((item) => (
                <div key={item.rotulo}>
                  <dt className="text-sm text-[var(--color-texto-fraco)]">{item.rotulo}</dt>
                  <dd className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">{item.valor}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="border-t border-[var(--color-borda)] bg-[var(--color-fundo-suave)]">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
            <h2 className="text-center text-3xl font-semibold tracking-tight sm:text-4xl">
              O que a caixa faz de verdade
            </h2>
            <div className="mx-auto mt-8 flex max-w-xl flex-wrap justify-center gap-2" role="tablist">
              {CENAS.map((item) => {
                const ativo = item.id === cena;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={ativo}
                    onClick={() => setCena(item.id)}
                    className={`cursor-pointer rounded-full px-4 py-2 text-sm font-medium transition ${
                      ativo
                        ? "bg-[var(--color-forte)] text-[var(--color-sobre-forte)]"
                        : "bg-[var(--color-superficie)] text-[var(--color-tinta)] ring-1 ring-[var(--color-borda)] hover:bg-[var(--color-hover-suave)]"
                    }`}
                  >
                    {item.rotulo}
                  </button>
                );
              })}
            </div>

            <div className="mt-10 grid items-center gap-10 lg:grid-cols-2 lg:gap-16">
              <div className="order-2 lg:order-1">
                <Cena id={atual.id} />
              </div>
              <div className="order-1 lg:order-2">
                <h3 className="text-2xl font-semibold tracking-tight">{atual.titulo}</h3>
                <p className="mt-3 text-sm leading-relaxed text-[var(--color-texto-fraco)] sm:text-base">
                  {atual.texto}
                </p>
                <ul className="mt-6 divide-y divide-[var(--color-borda)] border-l-2 border-[var(--color-realce)]">
                  {atual.itens.map((item) => (
                    <li key={item.titulo} className="py-4 pl-4">
                      <p className="text-sm font-semibold">{item.titulo}</p>
                      <p className="mt-1 text-sm leading-relaxed text-[var(--color-texto-fraco)]">{item.texto}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </section>

        <section className="border-t border-[var(--color-borda)]">
          <div className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Como começa</h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-[var(--color-texto-fraco)] sm:text-base">
              Se você tem quem cuide do DNS, dá para fazer sozinho agora. Se preferir, a gente publica os
              registros por você — é o mesmo trabalho.
            </p>
            <ol className="mt-8 grid gap-6 sm:grid-cols-3">
              {PASSOS.map((passo) => (
                <li key={passo.numero}>
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[var(--color-forte)] text-sm font-semibold text-[var(--color-sobre-forte)]">
                    {passo.numero}
                  </span>
                  <h3 className="mt-4 text-base font-semibold tracking-tight">{passo.titulo}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--color-texto-fraco)]">{passo.texto}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="border-t border-[var(--color-borda)] bg-[var(--color-fundo-suave)]">
          <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[1fr_18rem] lg:items-start">
            <div>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <h2 className="text-3xl font-semibold tracking-tight">Perguntas frequentes</h2>
                <button
                  type="button"
                  className="cursor-pointer text-sm font-medium text-[var(--color-realce)]"
                  onClick={() => setAbertas(PERGUNTAS.map(() => !todasAbertas))}
                >
                  {todasAbertas ? "Fechar tudo" : "Abrir tudo"}
                </button>
              </div>
              <div className="mt-6 divide-y divide-[var(--color-borda)] border-y border-[var(--color-borda)]">
                {PERGUNTAS.map((item, indice) => {
                  const aberta = abertas[indice];
                  return (
                    <div key={item.pergunta}>
                      <button
                        type="button"
                        className="flex w-full cursor-pointer items-center justify-between gap-4 py-4 text-left text-sm font-semibold sm:text-base"
                        aria-expanded={aberta}
                        onClick={() =>
                          setAbertas((estado) => estado.map((valor, i) => (i === indice ? !valor : valor)))
                        }
                      >
                        {item.pergunta}
                        <span aria-hidden className="text-[var(--color-texto-fraco)]">
                          {aberta ? "–" : "+"}
                        </span>
                      </button>
                      {aberta ? (
                        <p className="pb-4 text-sm leading-relaxed text-[var(--color-texto-fraco)]">{item.resposta}</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
            <aside className="rounded-2xl border border-[var(--color-borda)] bg-[var(--color-superficie)] p-5">
              <h3 className="text-lg font-semibold tracking-tight">Precisa de mais ajuda?</h3>
              <p className="mt-2 text-sm leading-relaxed text-[var(--color-texto-fraco)]">
                Quem já tem a caixa configura Outlook e celular no próprio webmail, em Configurar.
              </p>
              <a
                href="/entrar"
                className="mt-4 inline-block text-sm font-medium text-[var(--color-realce)]"
              >
                Entrar e abrir o guia
              </a>
            </aside>
          </div>
        </section>

        <section className="border-t border-[var(--color-borda)]">
          <div className="mx-auto max-w-3xl px-4 py-16 text-center sm:px-6 sm:py-24">
            <p className="text-sm font-semibold tracking-tight text-[var(--color-realce)]">Ávila Mail</p>
            <h2 className="mt-3 text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
              O endereço da empresa, no servidor da empresa que te atende.
            </h2>
            <p className="mt-4 text-sm leading-relaxed text-[var(--color-texto-fraco)] sm:text-base">
              R$ {PRECO_POR_CAIXA} por caixa, por mês. A caixa nasce depois que o pagamento confirma.
            </p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <a
                href={CRIAR_CONTA}
                className="rounded-full bg-[var(--color-forte)] px-6 py-3 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)]"
              >
                Criar uma conta
              </a>
              <a
                href={WHATSAPP}
                className="rounded-full px-6 py-3 text-sm font-medium text-[var(--color-realce)] transition hover:bg-[var(--color-fundo-suave)]"
              >
                Falar no WhatsApp
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="rodape-seguro border-t border-[var(--color-borda)] bg-[var(--color-fundo-suave)]">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-8 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="text-[var(--color-texto-fraco)]">Ávila Ops Tecnologia · e-mail próprio, não revenda</p>
          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <a href="/entrar" className="transition hover:text-[var(--color-realce)]">
              Entrar
            </a>
            <a href={CRIAR_CONTA} className="transition hover:text-[var(--color-realce)]">
              Criar uma conta
            </a>
            <a href={WHATSAPP} className="transition hover:text-[var(--color-realce)]">
              WhatsApp
            </a>
            <a href="https://avilaops.com/mail" className="transition hover:text-[var(--color-realce)]">
              No site
            </a>
            <a
              href="https://avilaops.com/politica-de-privacidade"
              className="transition hover:text-[var(--color-realce)]"
            >
              Privacidade
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
