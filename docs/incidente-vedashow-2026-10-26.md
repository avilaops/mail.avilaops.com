# Envios da VedaShow em 26/10/2026

## Evidencias

Consulta ao banco do Avila Mail, desde 00h de Brasilia: 29 registros de saida,
sendo 28 da Luana e 1 do Jose Luis. No levantamento inicial, 21 estavam como
sent, 7 failed e 1 deferred. sent registra aceitacao pelo transporte, nao leitura.
Os dois Gmail conectados nao representam as caixas corporativas.

Foram examinadas 783 linhas do journal de API, MTA e webmail daquele dia.
As 145 recusas de autenticacao observadas nao envolviam usuarios da VedaShow.
Falhas transitorias de Ribpav e Industria Soberano foram recuperadas pela fila.
Os sete registros failed possuem bouncedAt preenchido: houve aviso de nao entrega.

## Causas

- Quatro destinatarios recusados com usuario inexistente (550 5.1.1).
- Netsite recusou o destinatario com 550 5.1.1.
- Dois destinatarios Microsoft recusados com 550 5.4.1; nao comprova bloqueio do IP.
- thermovel.com.br retornou ENOTFOUND para MX em 1.1.1.1 e 8.8.8.8.
- Submission SMTP enfileirava sem preencher subject.
- SMTP salvava copia em Enviados; Outlook fazia outro APPEND, com Message-ID e
  conteudo diferentes. Havia uma unica saida por envio, apesar de duas copias.

## Correcao

- Assunto passa a ser extraido do MIME antes do enfileiramento.
- MAIL_SMTP_CLIENT_SAVES_SENT permite delegar a copia ao cliente por caixa.
  O padrao continua salvando no servidor. Webmail nao usa essa configuracao.
- Configuracao operacional destinada a luana@vedashow.com.br e
  joseluis@vedashow.com.br: seus 29 envios tiveram copia do cliente confirmada.
  Ao mudar o cliente, rever essa configuracao.
- Recuperados os assuntos dos 29 registros de saida do dia, diretamente do MIME.
- As 29 copias automaticas identificadas pelo Message-ID da saida foram movidas
  para a pasta customizada Copias SMTP - auditoria 26-10-2026, conservando em
  Enviados a copia do cliente. Nenhum blob ou mensagem foi apagado.
- Manifestos de reversao das duas manutencoes em /var/backups/avila-mail/.

## Validacao e limites

Regressao por SMTP TLS em loopback e PostgreSQL descartavel confere assunto
Unicode e a gravacao de Enviados para caixa configurada e caixa padrao.
A suite existente confere APPEND com cliente independente.

Nao se reenviam recusas definitivas sem corrigir o destinatario. A fila mantem
retentativas limitadas para a falha DNS e emite aviso de atraso/nao entrega.
Enderecos alternativos exigem confirmacao do contato; nao foram inventados.

Publicacao e saude em producao devem ser registradas separadamente dos testes.
