"use client";

/**
 * Inscricao do navegador no aviso em segundo plano (Web Push).
 *
 * O caminho e sempre o mesmo: registrar o service worker, pedir a inscricao
 * ao navegador com a nossa chave publica e mandar a inscricao para a API, que
 * a usa para cifrar cada aviso. Nada disso funciona sem HTTPS — em
 * desenvolvimento no localhost o navegador abre excecao.
 */

export interface AparelhoPush {
  id: string;
  endpoint: string;
  userAgent: string | null;
  lastSentAt: string | null;
  createdAt: string;
}

export interface EstadoPush {
  disponivel: boolean;
  chavePublica: string | null;
  aparelhos: AparelhoPush[];
}

export function suportaPush(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/** base64url (formato da chave VAPID) -> Uint8Array, que e o que o navegador aceita. */
function paraBytes(base64url: string): ArrayBuffer {
  const preenchido = base64url.padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), "=");
  const bruto = atob(preenchido.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(bruto.length));
  for (let i = 0; i < bruto.length; i += 1) bytes[i] = bruto.charCodeAt(i);
  return bytes.buffer;
}

async function registrarWorker(): Promise<ServiceWorkerRegistration> {
  const registro = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  await navigator.serviceWorker.ready;
  return registro;
}

/** Inscricao deste navegador, se ja existir. */
export async function inscricaoAtual(): Promise<PushSubscription | null> {
  if (!suportaPush()) return null;
  const registro = await navigator.serviceWorker.getRegistration("/");
  return (await registro?.pushManager.getSubscription()) ?? null;
}

export async function inscrever(chavePublica: string): Promise<PushSubscription> {
  const registro = await registrarWorker();
  const existente = await registro.pushManager.getSubscription();
  if (existente) return existente;

  return registro.pushManager.subscribe({
    // Exigido pelos navegadores: aviso de push tem que ser visivel ao usuario,
    // nao pode virar canal silencioso de execucao em segundo plano.
    userVisibleOnly: true,
    applicationServerKey: paraBytes(chavePublica),
  });
}

export async function desinscrever(): Promise<string | null> {
  const inscricao = await inscricaoAtual();
  if (!inscricao) return null;
  const endpoint = inscricao.endpoint;
  await inscricao.unsubscribe().catch(() => undefined);
  return endpoint;
}
