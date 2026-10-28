/**
 * Service worker do webmail — existe por um motivo só: entregar o aviso de
 * mensagem nova quando a aba está fechada.
 *
 * Ele não faz cache de nada. Webmail com cache agressivo mostra mensagem
 * velha e some com mensagem nova; o ganho de velocidade não paga o susto.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (evento) => evento.waitUntil(self.clients.claim()));

self.addEventListener("push", (evento) => {
  let aviso = { titulo: "Mensagem nova", corpo: "Abra o webmail para ler.", messageId: null };
  try {
    if (evento.data) aviso = { ...aviso, ...evento.data.json() };
  } catch {
    // Payload ilegível não pode virar notificação em branco nem exceção.
  }

  evento.waitUntil(
    self.registration.showNotification(aviso.titulo, {
      body: aviso.corpo,
      icon: "/apple-touch-icon.png",
      badge: "/apple-touch-icon.png",
      // Uma notificação por caixa: a nova substitui a anterior em vez de
      // empilhar dez avisos dizendo a mesma coisa.
      tag: aviso.notificationTag || "mail:mensagem-nova",
      renotify: true,
      data: { messageId: aviso.messageId ?? null, url: aviso.url ?? null },
    }),
  );
});

self.addEventListener("notificationclick", (evento) => {
  evento.notification.close();

  const id = evento.notification.data && evento.notification.data.messageId;
  const url = evento.notification.data && evento.notification.data.url;
  const padrao = id ? `/caixa?mensagem=${encodeURIComponent(id)}` : "/caixa";
  let destino = padrao;
  try {
    const candidato = new URL(url || padrao, self.location.origin);
    if (candidato.origin === self.location.origin && ["/caixa", "/agenda", "/conta"].includes(candidato.pathname)) destino = `${candidato.pathname}${candidato.search}`;
  } catch { /* Usa o destino interno da mensagem. */ }

  // Reaproveita a aba já aberta do webmail em vez de abrir a décima cópia.
  evento.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((janelas) => {
      for (const janela of janelas) {
        if (new URL(janela.url).origin === self.location.origin) {
          return janela.focus()
            .then(() => (url || id) && "navigate" in janela ? janela.navigate(destino) : undefined)
            .then(() => undefined)
            .catch(() => undefined);
        }
      }
      return self.clients.openWindow(destino);
    }),
  );
});
