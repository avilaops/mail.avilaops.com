/** Destino de navegacao do Mail; nunca aceita URL externa ou rota de acao. */
export function destinoMail(valor: string | null | undefined): string {
  if (!valor || valor.length > 2000 || !valor.startsWith("/") || valor.startsWith("//") || valor.includes("\\")) return "/caixa";
  try {
    const url = new URL(valor, "https://mail.invalid");
    if (url.origin !== "https://mail.invalid" || !["/caixa", "/agenda", "/conta", "/admin"].includes(url.pathname)) return "/caixa";
    return `${url.pathname}${url.search}`;
  } catch {
    return "/caixa";
  }
}

export function caminhoEntrar(destino: string, local = false): string {
  const parametros = new URLSearchParams({ returnTo: destinoMail(destino) });
  if (local) parametros.set("local", "1");
  return `/entrar?${parametros}`;
}
