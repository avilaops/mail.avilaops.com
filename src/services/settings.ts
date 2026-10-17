import { prisma } from "../lib/db.js";
import { createLogger } from "../lib/logger.js";
import { isValidAddress } from "../lib/address.js";
import { sanitizeMessageHtml } from "../lib/sanitize.js";
import { MessageError } from "./messages.js";

const log = createLogger("settings");

/**
 * Preferencias e perfil do dono da caixa.
 *
 * A linha de preferencias e criada sob demanda, no primeiro acesso — assim
 * caixa provisionada nao carrega registro que talvez nunca seja usado, e
 * mudanca de padrao vale para quem ainda nao personalizou nada.
 */

/** Um lugar so para os campos devolvidos: lista duplicada foi o que fez o PUT
 * responder sem as preferencias de aviso, apagando os controles na tela. */
const CAMPOS = {
  signatureHtml: true,
  signatureText: true,
  autoReplyEnabled: true,
  autoReplySubject: true,
  autoReplyBody: true,
  autoReplyUntil: true,
  showRemoteImages: true,
  messagesPerPage: true,
  notifyEnabled: true,
  notifyQuietStart: true,
  notifyQuietEnd: true,
  notifyOnlyInbox: true,
} as const;

const PADROES = {
  signatureHtml: null,
  signatureText: null,
  autoReplyEnabled: false,
  autoReplySubject: null,
  autoReplyBody: null,
  autoReplyUntil: null,
  showRemoteImages: false,
  messagesPerPage: 30,
  notifyEnabled: true,
  notifyQuietStart: null,
  notifyQuietEnd: null,
  notifyOnlyInbox: true,
};

export async function getSettings(mailboxId: string) {
  const existente = await prisma.mailboxSettings.findUnique({
    where: { mailboxId },
    select: CAMPOS,
  });

  return existente ?? PADROES;
}

export interface UpdateSettingsInput {
  notifyEnabled?: boolean;
  notifyQuietStart?: number | null;
  notifyQuietEnd?: number | null;
  notifyOnlyInbox?: boolean;
  signatureHtml?: string | null;
  autoReplyEnabled?: boolean;
  autoReplySubject?: string | null;
  autoReplyBody?: string | null;
  autoReplyUntil?: string | null;
  showRemoteImages?: boolean;
  messagesPerPage?: number;
}

export async function updateSettings(mailboxId: string, input: UpdateSettingsInput) {
  const dados: Record<string, unknown> = {};

  if (input.signatureHtml !== undefined) {
    if (input.signatureHtml === null || input.signatureHtml.trim() === "") {
      dados.signatureHtml = null;
      dados.signatureText = null;
    } else {
      // A assinatura e escrita pelo dono da caixa, mas vai colada em toda
      // mensagem que ele mandar. Passa pelo mesmo sanitizador do corpo: conta
      // comprometida nao pode virar veiculo de payload assinado com nosso DKIM.
      const { html } = sanitizeMessageHtml(input.signatureHtml, true);
      dados.signatureHtml = html;
      dados.signatureText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
  }

  if (input.autoReplyEnabled !== undefined) dados.autoReplyEnabled = input.autoReplyEnabled;
  if (input.autoReplySubject !== undefined) dados.autoReplySubject = input.autoReplySubject?.slice(0, 200) ?? null;
  if (input.autoReplyBody !== undefined) dados.autoReplyBody = input.autoReplyBody?.slice(0, 5000) ?? null;

  if (input.autoReplyUntil !== undefined) {
    if (input.autoReplyUntil === null) {
      dados.autoReplyUntil = null;
    } else {
      const data = new Date(input.autoReplyUntil);
      if (Number.isNaN(data.getTime())) throw new MessageError("Data de retorno invalida.", 422);
      dados.autoReplyUntil = data;
    }
  }

  if (input.notifyEnabled !== undefined) dados.notifyEnabled = input.notifyEnabled;
  if (input.notifyOnlyInbox !== undefined) dados.notifyOnlyInbox = input.notifyOnlyInbox;

  for (const campo of ["notifyQuietStart", "notifyQuietEnd"] as const) {
    const valor = input[campo];
    if (valor === undefined) continue;
    if (valor === null) {
      dados[campo] = null;
      continue;
    }
    if (!Number.isInteger(valor) || valor < 0 || valor > 23) {
      throw new MessageError("Hora do silencio noturno deve ser um numero de 0 a 23.", 422);
    }
    dados[campo] = valor;
  }

  if (input.showRemoteImages !== undefined) dados.showRemoteImages = input.showRemoteImages;

  if (input.messagesPerPage !== undefined) {
    if (input.messagesPerPage < 10 || input.messagesPerPage > 100) {
      throw new MessageError("Mensagens por pagina deve ficar entre 10 e 100.", 422);
    }
    dados.messagesPerPage = input.messagesPerPage;
  }

  if (dados.autoReplyEnabled === true) {
    const atual = await getSettings(mailboxId);
    const corpo = (dados.autoReplyBody ?? atual.autoReplyBody) as string | null;
    if (!corpo || corpo.trim() === "") {
      throw new MessageError("Escreva a mensagem antes de ligar a resposta automatica.", 422);
    }
  }

  const salvo = await prisma.mailboxSettings.upsert({
    where: { mailboxId },
    create: { mailboxId, ...dados },
    update: dados,
    select: CAMPOS,
  });

  log.info("preferencias atualizadas", { mailboxId, campos: Object.keys(dados) });
  return salvo;
}

const CAMPOS_AGENDA = {
  calendarTimezone: true,
  calendarWeekStart: true,
  calendarBusinessHoursStart: true,
  calendarBusinessHoursEnd: true,
  calendarDefaultView: true,
  calendarDefaultReminder: true,
  calendarDefaultAllDayReminder: true,
} as const;

const PADROES_AGENDA = {
  timezone: "America/Sao_Paulo",
  weekStart: 0 as 0 | 1,
  businessHoursStart: "09:00",
  businessHoursEnd: "18:00",
  defaultView: "week" as const,
  defaultReminder: 10,
  defaultAllDayReminder: 1440,
};

export interface CalendarSettingsInput {
  timezone?: string;
  weekStart?: 0 | 1;
  businessHoursStart?: string;
  businessHoursEnd?: string;
  defaultView?: "day" | "week" | "month" | "list";
  defaultReminder?: number;
  defaultAllDayReminder?: number;
}

function respostaAgenda(valor: Record<string, unknown>) {
  return {
    timezone: String(valor.calendarTimezone),
    weekStart: Number(valor.calendarWeekStart) as 0 | 1,
    businessHoursStart: String(valor.calendarBusinessHoursStart),
    businessHoursEnd: String(valor.calendarBusinessHoursEnd),
    defaultView: String(valor.calendarDefaultView) as "day" | "week" | "month" | "list",
    defaultReminder: Number(valor.calendarDefaultReminder),
    defaultAllDayReminder: Number(valor.calendarDefaultAllDayReminder),
  };
}

function minutosHorario(valor: string): number | null {
  const encontrado = valor.match(/^(\d{2}):(\d{2})$/);
  if (!encontrado) return null;
  const hora = Number(encontrado[1]);
  const minuto = Number(encontrado[2]);
  return hora <= 23 && minuto <= 59 ? hora * 60 + minuto : null;
}

export async function getCalendarSettings(mailboxId: string) {
  const existente = await prisma.mailboxSettings.findUnique({ where: { mailboxId }, select: CAMPOS_AGENDA });
  return existente ? respostaAgenda(existente) : PADROES_AGENDA;
}

export async function updateCalendarSettings(mailboxId: string, input: CalendarSettingsInput) {
  const atual = await getCalendarSettings(mailboxId);
  const proximo = { ...atual, ...input };
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: proximo.timezone }).format();
  } catch {
    throw new MessageError("Fuso horario invalido.", 422);
  }
  const inicio = minutosHorario(proximo.businessHoursStart);
  const fim = minutosHorario(proximo.businessHoursEnd);
  if (inicio === null || fim === null || inicio >= fim) {
    throw new MessageError("Horario de expediente invalido: o inicio deve vir antes do fim.", 422);
  }
  for (const valor of [proximo.defaultReminder, proximo.defaultAllDayReminder]) {
    if (!Number.isInteger(valor) || valor < 0 || valor > 525_600) {
      throw new MessageError("Lembrete padrao deve ficar entre 0 e 525600 minutos.", 422);
    }
  }
  const salvo = await prisma.mailboxSettings.upsert({
    where: { mailboxId },
    create: {
      mailboxId,
      calendarTimezone: proximo.timezone,
      calendarWeekStart: proximo.weekStart,
      calendarBusinessHoursStart: proximo.businessHoursStart,
      calendarBusinessHoursEnd: proximo.businessHoursEnd,
      calendarDefaultView: proximo.defaultView,
      calendarDefaultReminder: proximo.defaultReminder,
      calendarDefaultAllDayReminder: proximo.defaultAllDayReminder,
    },
    update: {
      calendarTimezone: proximo.timezone,
      calendarWeekStart: proximo.weekStart,
      calendarBusinessHoursStart: proximo.businessHoursStart,
      calendarBusinessHoursEnd: proximo.businessHoursEnd,
      calendarDefaultView: proximo.defaultView,
      calendarDefaultReminder: proximo.defaultReminder,
      calendarDefaultAllDayReminder: proximo.defaultAllDayReminder,
    },
    select: CAMPOS_AGENDA,
  });
  log.info("preferencias da agenda atualizadas", { mailboxId });
  return respostaAgenda(salvo);
}

export interface UpdateProfileInput {
  displayName?: string | null;
  recoveryEmail?: string | null;
}

/**
 * Nome de exibicao e e-mail de recuperacao.
 *
 * O e-mail de recuperacao e o unico caminho para o cliente trocar a senha
 * sozinho — sem ele, toda troca vira chamado de suporte.
 */
export async function updateProfile(mailboxId: string, input: UpdateProfileInput) {
  const dados: Record<string, unknown> = {};

  if (input.displayName !== undefined) {
    const nome = input.displayName?.trim() ?? "";
    // CRLF aqui viraria injecao de cabecalho no From: de toda mensagem enviada.
    if (/[\r\n]/.test(nome)) throw new MessageError("Nome de exibicao invalido.", 422);
    if (nome.length > 120) throw new MessageError("Nome de exibicao muito longo.", 422);
    dados.displayName = nome === "" ? null : nome;
  }

  if (input.recoveryEmail !== undefined) {
    const email = input.recoveryEmail?.trim().toLowerCase() ?? "";
    if (email === "") {
      dados.recoveryEmail = null;
    } else {
      if (!isValidAddress(email)) throw new MessageError("E-mail de recuperacao invalido.", 422);
      dados.recoveryEmail = email;
    }
  }

  if (Object.keys(dados).length === 0) throw new MessageError("Nada a atualizar.", 422);

  const salvo = await prisma.mailbox.update({
    where: { id: mailboxId },
    data: dados,
    select: { displayName: true, recoveryEmail: true },
  });

  await prisma.mailEvent.create({
    data: { mailboxId, type: "mailbox.profile_updated", payload: { campos: Object.keys(dados) } },
  });

  return salvo;
}
