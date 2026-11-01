# Ajuste necessário no emissor para ordenar revogações

## Problema verificado

O Auth grava `iat` em segundos. No cadastro do MFA, registra `mfa_ativado` e
imediatamente emite outra sessão. Evento e nova sessão podem ter o mesmo segundo.
O Mail não consegue distinguir com segurança uma prova anterior de uma posterior.

O logout também agenda `avisarLogout` com `after`. Esse serviço consulta o banco
e a chave antes de assinar o JWT. Seu `iat` representa o instante da assinatura,
que pode ser posterior à resposta do logout e até ao próximo login do usuário.
Uma espera fixa desde a resposta não garante ordenação.

## Proposta limitada ao contrato Auth–Mail

1. Em `src/lib/sessao.ts`, emitir uma claim adicional `auth_time_ms`, capturada
   ao criar a sessão. Manter `iat`, `exp`, issuer, algoritmo e TTL existentes.
   Construir o payload com os campos de identidade aceitos, sem reaproveitar
   `iat`/`exp` de um token verificado ao reemitir a sessão.
2. Em `src/app/api/auth/logout/route.ts`, capturar o instante lógico do logout
   antes de responder e passá-lo a `avisarLogout`.
3. Em `src/lib/avisoDeLogout.ts`, acrescentar `revoked_before_ms` ao logout token
   com o instante capturado. Conservar `iat`/`exp` do envelope para validade do
   aviso. Preparação ou entrega atrasada não muda o corte lógico.
4. Em `src/lib/ssf.ts`, acrescentar `event_timestamp_ms` ao conteúdo do evento,
   capturado junto a `event_timestamp`. Manter os campos atuais para consumidores
   existentes.
5. No Mail, usar os campos de precisão maior quando presentes e persistir o corte
   sem truncamento. Provas sem esses campos continuam sob corte conservador.
   Uma igualdade residual exige reautenticação explícita; a recuperação só passa
   a ter ordenação demonstrável porque o corte do logout foi capturado antes
   da resposta, sem depender do `iat` assinado em uma tarefa posterior.

## Verificação exigida no CI

- Sessão anterior, evento e sessão posterior dentro do mesmo segundo.
- Preparação do backchannel atrasada após a resposta do logout; a nova sessão
  permanece válida porque o corte lógico não avança com a assinatura.
- Prova anterior no mesmo milissegundo não é liberada por trocar `<=` por `<`.
- Reemissão após MFA não inclui `exp` antigo junto de `expiresIn`.
- Consumidores e tokens existentes conservam seus campos e validade.

## Limite de escopo

Este arquivo é uma proposta revisável. Nenhum arquivo do Auth foi alterado.
O pedido original restringiu o projeto ao Mail. A alteração do emissor requer
autorização de escopo; merge e publicação continuam separados da implementação.
