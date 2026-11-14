# Armazenamento R2 em contingencia

Defina `MAIL_STORAGE_DRIVER=r2`, `MAIL_R2_ENDPOINT` (HTTPS), `MAIL_R2_BUCKET`,
`MAIL_R2_ACCESS_KEY_ID` e `MAIL_R2_SECRET_ACCESS_KEY` na API e no MTA que usarem
esse armazenamento. O padrao continua sendo o diretorio local existente.
Use credenciais de leitura/escrita restritas ao bucket de operacao; nao forneca
credenciais de escrita no bucket de backups para a aplicacao.

O layout no bucket e `AAAA/MM/id.eml.gz`, com o mesmo gzip usado no disco.
O armazenamento remoto guarda os novos arquivos e atende leitura e exclusao;
nenhum blob depende do disco efemero do container. O banco continua PostgreSQL.

Para recuperar `blobs/` do backup em um bucket separado, use credenciais privadas
com leitura na origem e escrita no destino:

```text
node deploy/copy-r2-backup.mjs <credenciais-privadas.json> <bucket-novo> <relatorio.json>
```

O JSON privado deve conter `endpoint`, `accessKeyId` e `secretAccessKey`.
O script valida as chaves, verifica o tamanho da primeira copia e copia os
objetos no servidor sem escrever na origem. O relatorio contem apenas contagens
e nomes de buckets. Complete e verifique a copia antes de liberar as caixas.

Essa configuracao recupera os arquivos para a API. Ela nao fornece transporte
SMTP/IMAP nem entrega de novas mensagens. Preserve o encaminhamento emergencial
ate o transporte ser recuperado e validado separadamente.

Validacao local: `npm run test:storage`, `npm run typecheck`, `npm run build`.
