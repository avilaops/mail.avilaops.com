-- Preferencias de aviso de mensagem nova. Padrao: ligado, sem silencio
-- noturno e so para a Entrada — o comportamento que ja valia antes destas
-- colunas existirem, para ninguem acordar amanha com o aviso diferente.
ALTER TABLE "mail_mailbox_settings" ADD COLUMN "notify_enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "mail_mailbox_settings" ADD COLUMN "notify_quiet_start" INTEGER;
ALTER TABLE "mail_mailbox_settings" ADD COLUMN "notify_quiet_end" INTEGER;
ALTER TABLE "mail_mailbox_settings" ADD COLUMN "notify_only_inbox" BOOLEAN NOT NULL DEFAULT true;
