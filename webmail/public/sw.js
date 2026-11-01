/**
 * Service worker do webmail — existe por um motivo só: entregar o aviso de
 * mensagem nova quando a aba está fechada.
 *
 * Ele não faz cache de nada. Webmail com cache agressivo mostra mensagem
 * velha e some com mensagem nova; o ganho de velocidade não paga o susto.
 */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (evento) => evento.waitUntil(self.clients.claim()));

// Push e SSE compartilham a reserva persistente. IndexedDB serializa duas
// abas e um push concorrentes e conserva a deduplicacao ao reiniciar o worker.
async function abrirRegistroAvisos() {
  return new Promise((resolve, reject) => {
    const abrir = indexedDB.open("avila-mail-avisos", 1);
    abrir.onupgradeneeded = () => {
      const store = abrir.result.createObjectStore("vistos", { keyPath: "key" });
      store.createIndex("quando", "quando");
    };
    abrir.onsuccess = () => resolve(abrir.result);
    abrir.onerror = () => reject(abrir.error);
  });
}

async function reservarAvisos(avisos) {
  const banco = await abrirRegistroAvisos();
  try {
    return await new Promise((resolve, reject) => {
      const transacao = banco.transaction("vistos", "readwrite");
      const store = transacao.objectStore("vistos");
      const novos = [];
      const vistosLote = new Set();
      for (const aviso of avisos) {
        if (vistosLote.has(aviso.key)) continue;
        vistosLote.add(aviso.key);
        const consulta = store.get(aviso.key);
        consulta.onsuccess = () => {
          if (!consulta.result) { store.put({ key: aviso.key, quando: Date.now() }); novos.push(aviso); }
        };
      }
      const antigos = store.index("quando").openCursor(IDBKeyRange.upperBound(Date.now() - 7 * 86400000));
      let removidos = 0;
      antigos.onsuccess = () => {
        const cursor = antigos.result;
        if (cursor && removidos++ < 100) { cursor.delete(); cursor.continue(); }
      };
      transacao.oncomplete = () => resolve(novos);
      transacao.onabort = () => reject(transacao.error);
      transacao.onerror = () => reject(transacao.error);
    });
  } finally { banco.close(); }
}

async function liberarAvisos(avisos) {
  const banco = await abrirRegistroAvisos();
  try {
    await new Promise((resolve, reject) => {
      const transacao = banco.transaction("vistos", "readwrite");
      for (const aviso of avisos) transacao.objectStore("vistos").delete(aviso.key);
      transacao.oncomplete = resolve;
      transacao.onabort = () => reject(transacao.error);
    });
  } finally { banco.close(); }
}

async function caixaEstaVisivel(mailboxId) {
  const janelas = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const estados = await Promise.all(janelas.filter((janela) => janela.visibilityState === "visible").map((janela) => new Promise((resolve) => {
    const canal = new MessageChannel();
    const limite = setTimeout(() => { canal.port1.close(); resolve(false); }, 300);
    canal.port1.onmessage = (evento) => {
      clearTimeout(limite); canal.port1.close();
      resolve(evento.data?.mailboxId === mailboxId && evento.data?.visivel === true);
    };
    janela.postMessage({ type: "mail:consultar" }, [canal.port2]);
  })));
  return estados.some(Boolean);
}

async function emitirAvisos(entrada) {
  const avisos = entrada.slice(0, 50).filter((aviso) => aviso && typeof aviso.titulo === "string").map((aviso) => {
    const mailboxId = typeof aviso.mailboxId === "string" ? aviso.mailboxId : "legado";
    const eventId = aviso.eventId || aviso.messageId || aviso.notificationTag || crypto.randomUUID();
    return { ...aviso, mailboxId, key: `${mailboxId}:${eventId}` };
  });
  const novos = await reservarAvisos(avisos);
  if (!novos.length) return;
  try {
    if (await caixaEstaVisivel(novos[0].mailboxId)) return;
    const primeiro = novos[0];
    await self.registration.showNotification(novos.length === 1 ? primeiro.titulo : `${novos.length} mensagens novas`, {
      body: novos.length === 1 ? primeiro.corpo : `${primeiro.titulo} e mais ${novos.length - 1}`,
      icon: "/apple-touch-icon.png", badge: "/apple-touch-icon.png",
      tag: primeiro.notificationTag || `mail:${primeiro.mailboxId}:mensagens`, renotify: true,
      data: { messageId: novos.length === 1 ? primeiro.messageId ?? null : null, url: novos.length === 1 ? primeiro.url ?? null : "/caixa" },
    });
  } catch (erro) { await liberarAvisos(novos); throw erro; }
}

self.addEventListener("message", (evento) => {
  if (evento.data?.type !== "mail:avisar" || !Array.isArray(evento.data.avisos)) return;
  evento.waitUntil(emitirAvisos(evento.data.avisos)
    .then(() => evento.ports[0]?.postMessage({ ok: true }))
    .catch(() => evento.ports[0]?.postMessage({ ok: false })));
});

self.addEventListener("push", (evento) => {
  let aviso = { titulo: "Mensagem nova", corpo: "Abra o webmail para ler.", messageId: null };
  try {
    if (evento.data) aviso = { ...aviso, ...evento.data.json() };
  } catch {
    // Payload ilegível não pode virar notificação em branco nem exceção.
  }

  evento.waitUntil(emitirAvisos([aviso]));
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
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (janelas) => {
      for (const janela of janelas) {
        if (new URL(janela.url).origin === self.location.origin && "navigate" in janela) {
          try {
            const aberta = await janela.navigate(destino);
            if (aberta) { await aberta.focus(); return; }
          } catch { /* Tenta outra aba ou abre uma nova. */ }
        }
      }
      return self.clients.openWindow(destino);
    }),
  );
});
