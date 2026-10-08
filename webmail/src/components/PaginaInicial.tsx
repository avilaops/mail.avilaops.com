/**
 * Porta da rua do mail.avilaops.com.
 *
 * Ate aqui, `/` mandava direto para `/entrar`, que com o SSO ligado salta para
 * o `auth.avilaops.com`. Ou seja: quem digitava o endereco para conhecer o
 * produto caia numa tela de login de outro dominio, sem nunca ter visto o que
 * estava sendo vendido. Formulario de login e para quem ja e cliente; quem
 * ainda nao e precisa de uma porta.
 *
 * Quem tem sessao continua indo direto para a caixa (ver `app/page.tsx`) — a
 * pagina so aparece para visitante, como no Gmail.
 *
 * Tudo aqui e proprio: a CSP do webmail e `default-src 'self'` (ver
 * `src/middleware.ts`), entao nao entra fonte do Google, script de CDN nem
 * pixel de rastreio. A ilustracao da caixa e HTML e CSS, nao imagem.
 */

const CRIAR_CONTA = "https://app.avilaops.com/email";
const WHATSAPP =
  "https://wa.me/5517991053597?text=" +
  encodeURIComponent("Oi! Quero e-mail com o domínio da minha empresa.");

const PRECO_POR_CAIXA = 10;

/** Só entra aqui o que o serviço realmente faz hoje (ver a tabela do README). */
const RECURSOS = [
  {
    titulo: "Funciona no app que você já usa",
    texto:
      "IMAP e POP3 abertos: Outlook, Apple Mail e o app do Gmail no celular falam com a caixa sem gambiarra. O webmail é só mais uma porta.",
  },
  {
    titulo: "Contatos e agenda junto",
    texto:
      "CardDAV e CalDAV no celular e no computador. A agenda da empresa não precisa morar em outro serviço.",
  },
  {
    titulo: "Entrega conferida todo dia",
    texto:
      "SPF, DKIM, DMARC e MX do seu domínio são conferidos diariamente. Se algum cair, a gente descobre antes de você perceber pelo cliente que não respondeu.",
  },
  {
    titulo: "Anti-spam que aprende",
    texto:
      "Os botões “é spam” e “não é spam” treinam o filtro da sua caixa. O que é lixo para você não precisa ser lixo para todo mundo.",
  },
  {
    titulo: "Verificação em duas etapas",
    texto:
      "TOTP no aplicativo autenticador que você preferir. E aviso por e-mail e push a cada acesso de aparelho novo.",
  },
  {
    titulo: "Seus e-mails antigos vêm junto",
    texto:
      "A migração do provedor atual traz o histórico e as pastas. Ninguém troca de e-mail para começar do zero.",
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
    texto:
      "O botão “já configurei” checa de verdade. Se faltar algo, dizemos o que falta — não “erro”.",
  },
  {
    numero: "3",
    titulo: "Assine e use",
    texto:
      "A caixa é criada depois que o pagamento confirma, e a senha provisória vai para o seu e-mail de contato.",
  },
];

/**
 * Representação da caixa, desenhada em HTML.
 *
 * Não é print de tela: é uma abstração, e de propósito — print envelhece a cada
 * mudança da interface e exigiria mostrar e-mail de alguém. `aria-hidden`
 * porque não acrescenta nada a quem usa leitor de tela; o texto ao lado já diz
 * o que precisa ser dito.
 */
function IlustracaoDaCaixa() {
  /**
   * Os dois únicos tons usados aqui.
   *
   * `--color-fundo-suave` seria o natural para um marcador de conteúdo, mas no
   * tema escuro ele vale exatamente o mesmo que `--color-superficie`
   * (`#161a20`): as barras sumiam dentro do cartão e a ilustração aparecia
   * vazia à noite. `--color-borda` e `--color-texto-fraco` contrastam com a
   * superfície nos dois temas, que é o que um marcador precisa fazer.
   */
  const TOM_FRACO = "bg-[var(--color-borda)]";
  const TOM_FORTE = "bg-[var(--color-texto-fraco)] opacity-60";

  const linhas = [
    { largura: "w-[72%]", naoLida: true },
    { largura: "w-[54%]", naoLida: false },
    { largura: "w-[63%]", naoLida: false },
    { largura: "w-[45%]", naoLida: false },
  ];

  return (
    <div
      aria-hidden
      className="mx-auto w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--color-borda)] bg-[var(--color-superficie)] shadow-sm"
    >
      <div className="flex items-center gap-2 border-b border-[var(--color-borda)] px-4 py-3">
        <span className={`h-2.5 w-2.5 rounded-full ${TOM_FRACO}`} />
        <span className={`h-2.5 w-2.5 rounded-full ${TOM_FRACO}`} />
        <span className={`h-2.5 w-2.5 rounded-full ${TOM_FRACO}`} />
        <span className={`ml-3 h-4 w-40 rounded ${TOM_FRACO}`} />
      </div>

      <div className="flex">
        <div className="hidden w-40 shrink-0 border-r border-[var(--color-borda)] p-3 sm:block">
          <span className="block h-7 w-full rounded-lg bg-[var(--color-forte)] opacity-90" />
          {["Entrada", "Enviados", "Rascunhos", "Lixeira"].map((pasta, i) => (
            <span
              key={pasta}
              className={`mt-2 block h-3.5 rounded ${i === 0 ? `w-[70%] ${TOM_FORTE}` : `w-[58%] ${TOM_FRACO}`}`}
            />
          ))}
        </div>

        <div className="min-w-0 flex-1 p-3">
          {linhas.map((linha, i) => (
            // A primeira linha é a "não lida": marcada pelo peso da barra, não
            // por um fundo — fundo sutil é justamente o que não sobrevive à
            // troca de tema.
            <div key={i} className="flex items-center gap-3 rounded-lg px-2 py-2.5">
              <span className={`h-7 w-7 shrink-0 rounded-full ${TOM_FRACO}`} />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span
                  className={`block h-3 rounded ${linha.largura} ${linha.naoLida ? TOM_FORTE : TOM_FRACO}`}
                />
                <span className={`block h-2.5 w-[38%] rounded ${TOM_FRACO}`} />
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function PaginaInicial() {
  return (
    <div className="flex min-h-full flex-col bg-[var(--color-fundo)]">
      <header className="topo-seguro border-b border-[var(--color-borda)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-3 sm:px-6">
          {/*
            A marca vai escrita aqui, e não pelo componente `Marca`: ele carrega
            um `mb-6` pensado para a coluna do login, e a legenda dele é sempre
            visível. Num cabeçalho de 390px, "Ávila Mail" ao lado de dois botões
            quebra em duas linhas — no celular fica só o ícone, com o nome no
            `alt` para quem usa leitor de tela.
          */}
          <a href="/" className="flex shrink-0 items-center gap-3">
            {/* eslint-disable-next-line @next/next/no-img-element -- ícone estático, sem otimização */}
            <img
              src="/web-app-manifest-192x192.png"
              alt="Ávila Mail"
              width={40}
              height={40}
              className="h-9 w-9 rounded-xl shadow-sm sm:h-10 sm:w-10"
            />
            <span className="hidden text-sm font-semibold tracking-tight sm:inline">Ávila Mail</span>
          </a>

          <nav className="flex items-center gap-1 sm:gap-3">
            <a
              href="/entrar"
              className="rounded-lg px-3 py-2 text-sm font-medium whitespace-nowrap text-[var(--color-realce)] transition hover:bg-[var(--color-fundo-suave)]"
            >
              Fazer login
            </a>
            <a
              href={CRIAR_CONTA}
              className="rounded-lg bg-[var(--color-forte)] px-3 py-2 text-sm font-medium whitespace-nowrap text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] sm:px-4"
            >
              Criar uma conta
            </a>
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <section className="mx-auto max-w-5xl px-4 py-14 text-center sm:px-6 sm:py-20">
          <h1 className="mx-auto max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl">
            E-mail com o domínio da sua empresa
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-pretty text-[var(--color-texto-fraco)] sm:text-lg">
            Servidor próprio da Ávila Ops, com os seus e-mails antigos trazidos do provedor
            atual. R$ {PRECO_POR_CAIXA} por caixa, por mês, sem cobrança de instalação.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href={CRIAR_CONTA}
              className="w-full rounded-lg bg-[var(--color-forte)] px-6 py-3 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)] sm:w-auto"
            >
              Criar uma conta
            </a>
            <a
              href={WHATSAPP}
              className="w-full rounded-lg border border-[var(--color-borda)] px-6 py-3 text-sm font-medium transition hover:bg-[var(--color-fundo-suave)] sm:w-auto"
            >
              Falar no WhatsApp
            </a>
          </div>

          <div className="mt-14 sm:mt-16">
            <IlustracaoDaCaixa />
          </div>
        </section>

        <section className="border-t border-[var(--color-borda)] bg-[var(--color-fundo-suave)]">
          <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              O que vem com a caixa
            </h2>

            <ul className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {RECURSOS.map((recurso) => (
                <li
                  key={recurso.titulo}
                  className="rounded-xl border border-[var(--color-borda)] bg-[var(--color-superficie)] p-5"
                >
                  <h3 className="text-sm font-semibold tracking-tight">{recurso.titulo}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--color-texto-fraco)]">
                    {recurso.texto}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="border-t border-[var(--color-borda)]">
          <div className="mx-auto max-w-5xl px-4 py-14 sm:px-6 sm:py-20">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Como começa</h2>
            <p className="mt-3 max-w-xl text-sm leading-relaxed text-[var(--color-texto-fraco)]">
              Se você tem quem cuide do DNS, dá para fazer sozinho agora. Se preferir, a gente
              publica os registros por você — é o mesmo trabalho.
            </p>

            <ol className="mt-8 grid gap-6 sm:grid-cols-3">
              {PASSOS.map((passo) => (
                <li key={passo.numero}>
                  <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-forte)] text-sm font-semibold text-[var(--color-sobre-forte)]">
                    {passo.numero}
                  </span>
                  <h3 className="mt-4 text-sm font-semibold tracking-tight">{passo.titulo}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-[var(--color-texto-fraco)]">
                    {passo.texto}
                  </p>
                </li>
              ))}
            </ol>

            <a
              href={CRIAR_CONTA}
              className="mt-10 inline-block rounded-lg bg-[var(--color-forte)] px-6 py-3 text-sm font-medium text-[var(--color-sobre-forte)] transition hover:bg-[var(--color-forte-hover)]"
            >
              Começar agora
            </a>
          </div>
        </section>
      </main>

      <footer className="rodape-seguro border-t border-[var(--color-borda)] bg-[var(--color-fundo-suave)]">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-8 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <p className="text-[var(--color-texto-fraco)]">
            Ávila Ops Tecnologia · e-mail próprio, não revenda
          </p>

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
            <a href="https://avilaops.com" className="transition hover:text-[var(--color-realce)]">
              avilaops.com
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
