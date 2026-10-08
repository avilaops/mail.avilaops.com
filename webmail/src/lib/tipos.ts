/** Formatos devolvidos pela API do servidor de e-mail. */

export interface Pasta {
  id: string;
  name: string;
  kind: string;
  total: number;
  unread: number;
}

export interface ResumoMensagem {
  id: string;
  folderId: string;
  threadKey: string | null;
  fromAddress: string;
  fromName: string | null;
  /** Em Rascunhos e Enviados, quem importa na lista é o destinatário. */
  toAddresses: Array<{ address: string; name: string }>;
  subject: string | null;
  snippet: string | null;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  sizeBytes: number;
  spamScore: number | null;
  quarantineReason: string | null;
  senderVerified: boolean;
  receivedAt: string;
}

export interface Anexo {
  id: string;
  filename: string | null;
  contentType: string;
  sizeBytes: number;
  contentId: string | null;
}

export interface MensagemCompleta extends ResumoMensagem {
  ccAddresses: Array<{ address: string; name: string }>;
  bodyText: string | null;
  bodyHtml: string | null;
  blockedRemoteImages: number;
  attachments: Anexo[];
}

export interface Caixa {
  address: string;
  displayName: string | null;
  status: string;
  domainStatus: string;
  quotaBytes: string;
  usedBytes: string;
  usoPercentual: number;
  /** Caixa listada em MAIL_ADMIN_ADDRESSES: ve o link da area administrativa. */
  isAdmin?: boolean;
}

export interface PaginaMensagens {
  messages: ResumoMensagem[];
  nextCursor: string | null;
}
