ALTER TABLE "mail_messages" ADD COLUMN "trashed_at" TIMESTAMP(3);

-- Sem historico da exclusao, conceder 30 dias completos aos itens existentes.
UPDATE "mail_messages" AS m SET "trashed_at" = CURRENT_TIMESTAMP
FROM "mail_folders" AS f WHERE m."folder_id" = f."id" AND f."kind" = 'trash';

CREATE INDEX "mail_messages_mailbox_id_folder_id_trashed_at_idx"
ON "mail_messages"("mailbox_id", "folder_id", "trashed_at");

-- Aplicar o mesmo prazo para webmail, IMAP, importacao e regras de entrega.
CREATE FUNCTION registrar_entrada_lixeira() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM mail_folders WHERE id = NEW.folder_id AND kind = 'trash') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.trashed_at := CURRENT_TIMESTAMP;
    ELSIF NEW.folder_id IS DISTINCT FROM OLD.folder_id THEN
      NEW.trashed_at := CURRENT_TIMESTAMP;
    END IF;
  ELSE
    NEW.trashed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mail_messages_prazo_lixeira
BEFORE INSERT OR UPDATE OF folder_id ON mail_messages
FOR EACH ROW EXECUTE FUNCTION registrar_entrada_lixeira();
