ALTER TABLE "mail_migrations"
  ADD COLUMN "source_calendar_url" TEXT,
  ADD COLUMN "source_calendar_user" TEXT,
  ADD COLUMN "source_calendar_secret" TEXT,
  ADD COLUMN "copied_events" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "skipped_events" INTEGER NOT NULL DEFAULT 0;
