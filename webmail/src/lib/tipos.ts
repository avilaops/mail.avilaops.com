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
  convite: ConviteMensagem | null;
}

export interface ConviteMensagem {
  metodo: "REQUEST" | "CANCEL";
  uid: string;
  titulo: string;
  inicio: string;
  fim: string;
  diaInteiro: boolean;
  local?: string;
  organizador?: string;
  minhaResposta: "pendente" | "aceito" | "recusado" | "talvez";
  sequencia: number;
  conflito: boolean;
  cancelado: boolean;
  recorrenciaId?: string;
  cancelamento?: "aplicado" | "obsoleto" | "nao_confiavel" | "novo";
  alteracoes: string[];
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

export interface ConvidadoAgenda {
  email: string;
  nome?: string;
  resposta: "pendente" | "aceito" | "recusado" | "talvez";
}

export interface DadosEventoAgenda {
  agendaId?: string;
  titulo: string;
  inicio: string;
  fim: string;
  diaInteiro: boolean;
  fuso: string;
  local?: string;
  descricao?: string;
  recorrencia?: string;
  lembretes: Array<{ minutosAntes: number }>;
  convidados: ConvidadoAgenda[];
  organizador?: string;
  disponibilidade: "ocupado" | "livre";
  origem?: string;
  linkOrigem?: string;
}

export interface EventoAgenda extends DadosEventoAgenda {
  agendaId?: string;
  cor?: string;
  id: string;
  uid: string;
  href: string;
  etag: string;
  sequencia: number;
  criadoEm: string;
  modificadoEm: string;
  dtstamp: string;
  /** Presente nas respostas de janela, inclusive para a primeira ocorrência. */
  recorrenciaId?: string;
}

export interface AgendaCalendario {
  id: string;
  nome: string;
  cor: string;
  ordem: number;
  padrao: boolean;
  quantidadeEventos: number;
}

export interface PreferenciasAgenda {
  timezone: string;
  weekStart: 0 | 1;
  businessHoursStart: string;
  businessHoursEnd: string;
  defaultView: "day" | "week" | "month" | "list";
  defaultReminder: number;
  defaultAllDayReminder: number;
}
