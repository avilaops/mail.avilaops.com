ALTER TABLE "mail_mailbox_settings"
  ADD COLUMN "calendar_timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN "calendar_week_start" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "calendar_business_hours_start" TEXT NOT NULL DEFAULT '09:00',
  ADD COLUMN "calendar_business_hours_end" TEXT NOT NULL DEFAULT '18:00',
  ADD COLUMN "calendar_default_view" TEXT NOT NULL DEFAULT 'week',
  ADD COLUMN "calendar_default_reminder" INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN "calendar_default_all_day_reminder" INTEGER NOT NULL DEFAULT 1440;

ALTER TABLE "mail_mailbox_settings"
  ADD CONSTRAINT "mail_mailbox_settings_calendar_week_start_check" CHECK ("calendar_week_start" IN (0, 1)),
  ADD CONSTRAINT "mail_mailbox_settings_calendar_default_view_check" CHECK ("calendar_default_view" IN ('day', 'week', 'month', 'list')),
  ADD CONSTRAINT "mail_mailbox_settings_calendar_reminder_check" CHECK ("calendar_default_reminder" BETWEEN 0 AND 525600),
  ADD CONSTRAINT "mail_mailbox_settings_calendar_all_day_reminder_check" CHECK ("calendar_default_all_day_reminder" BETWEEN 0 AND 525600);
