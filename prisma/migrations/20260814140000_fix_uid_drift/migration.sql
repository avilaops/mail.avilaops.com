-- Corrige divergencia entre o banco de producao e o schema.
--
-- O que aconteceu: as colunas de UID do IMAP foram acrescentadas editando o
-- arquivo da migracao inicial, que a producao JA tinha aplicado. O Prisma passa
-- a dizer "up to date" — ele compara nomes de migracao, nao colunas — enquanto
-- o banco fica sem as colunas. Descoberto ao criar a primeira caixa de verdade:
-- `Unknown argument uidValidity`.
--
-- Tudo com IF NOT EXISTS porque instalacao nova ja nasce com essas colunas
-- (vieram no arquivo inicial editado); esta migracao precisa ser inofensiva la
-- e corretiva aqui.
ALTER TABLE "mail_folders" ADD COLUMN IF NOT EXISTS "uid_validity" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "mail_folders" ADD COLUMN IF NOT EXISTS "uid_next" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "mail_messages" ADD COLUMN IF NOT EXISTS "uid" INTEGER NOT NULL DEFAULT 0;

-- UID repetido dentro da pasta faz o cliente exibir a mensagem errada.
CREATE UNIQUE INDEX IF NOT EXISTS "mail_messages_folder_id_uid_key"
  ON "mail_messages"("folder_id", "uid");
