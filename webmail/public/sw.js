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
      tag: "avila-mail-nova-mensagem",
      renotify: true,
      data: { messageId: aviso.messageId ?? null },
    }),
  );
});

self.addEventListener("notificationclick", (evento) => {
  evento.notification.close();

  const id = evento.notification.data && evento.notification.data.messageId;
  const destino = id ? `/caixa?mensagem=${encodeURIComponent(id)}` : "/caixa";

  // Reaproveita a aba já aberta do webmail em vez de abrir a décima cópia.
  evento.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((janelas) => {
      for (const janela of janelas) {
        if (janela.url.includes("/caixa")) {
          janela.focus();
          if (id && "navigate" in janela) janela.navigate(destino).catch(() => undefined);
          return undefined;
        }
      }
      return self.clients.openWindow(destino);
    }),
  );
});
