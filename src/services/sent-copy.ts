/**
 * Clientes como Outlook ja salvam Enviados por IMAP APPEND.
 * Opt-in por caixa: as demais continuam com a copia automatica de seguranca.
 */
export function serverSavesSent(address: string, clientSavedMailboxes: string): boolean {
  const configured = clientSavedMailboxes.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  return !configured.includes(address.trim().toLowerCase());
}
