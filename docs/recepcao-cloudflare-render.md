# Recepcao de email na contingencia Render

O SMTP original esta inacessivel. Manter os MX da Cloudflare e entregar as
mensagens nas caixas recuperadas, substituindo o encaminhamento temporario
para Gmail somente depois da validacao.

O Email Worker aceita somente os destinatarios configurados, limita o tamanho
a 25 MiB e grava o MIME original no R2 privado (`incoming/<uuid>.eml`) antes de
confirmar processamento. Metadados preservam o envelope e o primeiro resultado
de autenticacao da Cloudflare. Uma chamada autenticada avisa a API; falhas
mantem o objeto na fila e o cron repete a entrega. Nao enviar nem registrar o
conteudo da mensagem em logs.

A API usa um segredo exclusivo de ingresso e a mesma rotina de entrega do MTA.
Um ID deterministico por objeto impede nova mensagem e nova quota quando
ha repeticao, inclusive concorrente. A API processa MIME, anexos, regras e
autenticacao verificada da Cloudflare; a fila remove o objeto somente depois
de confirmar a gravacao. Mensagens que nao podem ser entregues permanecem
preservadas para tratamento, sem desaparecer silenciosamente.

Validar: persistencia antes da entrega, falha e recuperacao, repeticao,
concorrencia, destinatarios, tamanho, autenticacao e isolamento das caixas.
Testar integracao com caixa sintetica e limpar apenas os dados criados.
Esta mudanca cuida da entrada; transporte de saida e IMAP continuam separados.
