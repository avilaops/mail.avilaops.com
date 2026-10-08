import type { NextConfig } from "next";

/**
 * Cabecalhos de seguranca do webmail.
 *
 * A CSP vive no middleware, nao aqui: ela precisa de um nonce diferente por
 * resposta, e header estatico nao consegue isso. Ver `src/middleware.ts`.
 *
 * Os cabecalhos abaixo sao os que nao mudam entre requisicoes.
 * `X-Frame-Options: DENY` duplica o `frame-ancestors 'none'` da CSP de
 * proposito — navegador antigo entende um, navegador atual entende o outro.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Empacota só o necessário para rodar. O VPS é compartilhado com 20
  // containers e sobram ~1,6 GB de RAM: compilar lá seria arriscado, e enviar
  // o node_modules inteiro do Next custaria ~300 MB de disco por deploy.
  output: "standalone",

  // O repo tem varios lockfiles (site, portal, mta). Sem fixar a raiz, o
  // Turbopack elege a do repo inteiro e resolve os imports pelo lugar errado.
  turbopack: { root: import.meta.dirname },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
