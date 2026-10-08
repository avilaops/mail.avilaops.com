/**
 * Traducao do User-Agent para o que o dono da caixa reconhece: aparelho,
 * sistema e navegador.
 *
 * "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit..." nao diz nada a
 * ninguem; "Galaxy S23 · Android 14 · Chrome" diz. A tela de aparelhos
 * conectados so serve para uma pergunta — "esse aqui sou eu?" — e ela precisa
 * ser respondida de relance.
 *
 * Sem biblioteca de proposito: a lista de expressoes cabe em um arquivo, nao
 * envelhece rapido (marca e sistema mudam devagar) e nao adiciona dependencia
 * que precise ser auditada por causa de uma tela de leitura.
 */

export interface Aparelho {
  /** "iPhone", "Galaxy S23", "Windows", "Mac"… */
  aparelho: string;
  /** "Android 14", "iOS 17", "Windows 11"… */
  sistema: string | null;
  /** "Chrome", "Safari", "Outlook"… */
  navegador: string | null;
  /** Uma linha pronta: "Galaxy S23 · Android 14 · Chrome". */
  resumo: string;
}

/**
 * Codinomes que a Samsung, a Motorola e a Xiaomi usam no UA. A lista cobre o
 * que aparece na base instalada brasileira; modelo desconhecido cai no codigo
 * cru, que ainda e melhor que "Android".
 */
const MODELOS: Array<[RegExp, string]> = [
  [/SM-S9(1|2)\d\w*/i, "Galaxy S23"],
  [/SM-S92\d\w*/i, "Galaxy S24"],
  [/SM-S(90|91)\d\w*/i, "Galaxy S22"],
  [/SM-A\d{3}\w*/i, "Galaxy A"],
  [/SM-N\d{3}\w*/i, "Galaxy Note"],
  [/SM-[A-Z]\d+\w*/i, "Galaxy"],
  [/moto ?g[\w ]*/i, "Moto G"],
  [/moto ?e[\w ]*/i, "Moto E"],
  [/motorola[\w -]*edge[\w ]*/i, "Motorola Edge"],
  [/Redmi \w+[\w ]*/i, "Redmi"],
  [/POCO \w+/i, "POCO"],
  [/Mi \d+\w*/i, "Xiaomi"],
  [/Pixel \d\w*/i, "Pixel"],
];

function versao(ua: string, expressao: RegExp): string | null {
  const achado = expressao.exec(ua);
  return achado?.[1] ? achado[1].replace(/_/g, ".") : null;
}

function detectarSistema(ua: string): { sistema: string | null; aparelho: string | null } {
  if (/iPhone/i.test(ua)) {
    const v = versao(ua, /OS (\d+[._]\d+)/);
    return { sistema: v ? `iOS ${v}` : "iOS", aparelho: "iPhone" };
  }
  if (/iPad/i.test(ua)) {
    const v = versao(ua, /OS (\d+[._]\d+)/);
    return { sistema: v ? `iPadOS ${v}` : "iPadOS", aparelho: "iPad" };
  }
  if (/Android/i.test(ua)) {
    const v = versao(ua, /Android (\d+(?:\.\d+)?)/);
    let aparelho: string | null = null;
    for (const [expressao, nome] of MODELOS) {
      const achado = expressao.exec(ua);
      if (achado) {
        aparelho = nome;
        break;
      }
    }
    if (!aparelho) {
      // Ultimo campo antes do ")" costuma ser o codigo do modelo.
      const cru = /Android[^;)]*;\s*([^;)]+)\)/.exec(ua)?.[1]?.trim();
      aparelho = cru && cru.length <= 30 ? cru : "Android";
    }
    return { sistema: v ? `Android ${v}` : "Android", aparelho };
  }
  if (/Windows NT 10\.0/i.test(ua)) {
    // O UA nao distingue 10 de 11; a dica esta no client hint, que nem sempre vem.
    return { sistema: /Windows NT 10\.0; Win64/.test(ua) ? "Windows 10/11" : "Windows", aparelho: "Computador" };
  }
  if (/Windows/i.test(ua)) return { sistema: "Windows", aparelho: "Computador" };
  if (/Mac OS X/i.test(ua)) {
    const v = versao(ua, /Mac OS X (\d+[._]\d+)/);
    return { sistema: v ? `macOS ${v}` : "macOS", aparelho: "Mac" };
  }
  if (/CrOS/i.test(ua)) return { sistema: "ChromeOS", aparelho: "Chromebook" };
  if (/Linux/i.test(ua)) return { sistema: "Linux", aparelho: "Computador" };
  return { sistema: null, aparelho: null };
}

function detectarNavegador(ua: string): string | null {
  // A ordem importa: quase todo navegador se declara "Safari" e "Chrome".
  if (/Thunderbird/i.test(ua)) return "Thunderbird";
  if (/Outlook|Microsoft Office/i.test(ua)) return "Outlook";
  if (/Apple Mail|Mail\/\d/i.test(ua)) return "Mail (Apple)";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\/|Opera/i.test(ua)) return "Opera";
  if (/SamsungBrowser/i.test(ua)) return "Samsung Internet";
  if (/Firefox|FxiOS/i.test(ua)) return "Firefox";
  if (/CriOS/i.test(ua)) return "Chrome";
  if (/Chrome\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua)) return "Safari";
  if (/curl|wget|python|node|undici|axios|go-http/i.test(ua)) return "Script";
  return null;
}

export function descreverAparelho(userAgent: string | null | undefined): Aparelho {
  const ua = (userAgent ?? "").trim();
  if (!ua) {
    return { aparelho: "Aparelho desconhecido", sistema: null, navegador: null, resumo: "Aparelho desconhecido" };
  }

  // Clientes de e-mail e apps proprios costumam se identificar direto.
  if (/^avila-mail|^AvilaOps/i.test(ua)) {
    return { aparelho: "App da Ávila Ops", sistema: null, navegador: null, resumo: "App da Ávila Ops" };
  }

  const { sistema, aparelho } = detectarSistema(ua);
  const navegador = detectarNavegador(ua);
  const nome = aparelho ?? (navegador === "Script" ? "Script/automação" : "Aparelho desconhecido");
  const partes = [nome, sistema, navegador].filter((p): p is string => Boolean(p));

  return { aparelho: nome, sistema, navegador, resumo: partes.join(" · ") };
}
