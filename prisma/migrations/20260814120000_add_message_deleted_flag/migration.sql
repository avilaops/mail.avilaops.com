-- Flag \Deleted do IMAP. Apagar no IMAP tem dois tempos: o cliente marca e o
-- EXPUNGE executa. Sem a coluna, a marcacao movia a mensagem na hora e o
-- cliente ficava com a sequencia da sessao desatualizada.
ALTER TABLE "mail_messages" ADD COLUMN "deleted" BOOLEAN NOT NULL DEFAULT false;
