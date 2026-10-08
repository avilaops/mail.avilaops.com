-- Cidade/pais do IP da sessao, para a tela de aparelhos conectados responder
-- "esse acesso sou eu?" sem obrigar ninguem a decorar o proprio IP.
ALTER TABLE "mail_sessions" ADD COLUMN "location" VARCHAR(120);
