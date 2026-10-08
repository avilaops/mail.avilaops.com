import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { scriptInicial } from "@/lib/tema-noturno";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://mail.avilaops.com";
const description = "Webmail corporativo da Ávila Ops.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "E-mail Ávila Ops",
  description,
  // Caixa de e-mail nao tem por que aparecer em buscador. O card do
  // WhatsApp e outra historia: e por la que o acesso e enviado.
  robots: { index: false, follow: false },
  openGraph: {
    title: "E-mail Ávila Ops",
    description,
    url: siteUrl,
    siteName: "Ávila Ops",
    locale: "pt_BR",
    type: "website",
    images: [
      {
        url: "/og-default.png",
        width: 1200,
        height: 630,
        alt: "E-mail Ávila Ops",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "E-mail Ávila Ops",
    description,
    images: ["/og-default.png"],
  },
  /**
   * Manifesto e icones: e o que permite instalar a caixa como aplicativo no
   * celular (e o pre-requisito de empacotar para a Play Store). Sem eles o
   * navegador nao oferece "instalar" e a notificacao aparece sem icone.
   */
  manifest: "/manifest.webmanifest",
  applicationName: "Ávila Mail",
  appleWebApp: { capable: true, title: "Ávila Mail", statusBarStyle: "black-translucent" },
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-96x96.png", sizes: "96x96", type: "image/png" },
      { url: "/web-app-manifest-192x192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Permite que o iOS informe as areas ocupadas pelo notch e pelo indicador
  // inferior. Os componentes usam esses valores para manter acoes tocaveis.
  viewportFit: "cover",
  themeColor: "#0f1115",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  /**
   * O nonce da requisição, posto pelo `src/middleware.ts`.
   *
   * O Next carimba sozinho os scripts que ele mesmo injeta, mas este `<script>`
   * é escrito à mão: sem o atributo, a CSP o recusa. E recusava — em TODAS as
   * páginas, desde sempre. O navegador bloqueava o script do tema, o
   * `data-theme` nunca era definido e o modo noturno da casa simplesmente não
   * acontecia; quem abria o e-mail à noite levava a tela branca na cara, que é
   * exatamente o que este script existe para evitar.
   *
   * Não aparece no build nem no teste: só olhando o console de um navegador de
   * verdade. É a mesma armadilha descrita no comentário do middleware, desta
   * vez no script que ele deveria proteger.
   */
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        {/*
          Modo noturno da casa: das 18h às 6h a caixa fica escura. Roda antes do
          CSS — quem abre o e-mail à noite não pode levar um flash branco na
          cara antes da página assentar.
        */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: scriptInicial() }} />
      </head>
      <body className="h-full">{children}</body>
    </html>
  );
}
