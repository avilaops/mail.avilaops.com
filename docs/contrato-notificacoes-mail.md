# Contrato de notificações do Mail

## Autorização e preferências

A permissão do navegador permite ao site mostrar avisos. A autorização deste
login fica na raiz da família de `MailSession`, inicialmente desligada.
Rotacionar o refresh conserva essa raiz. Encerrar a família remove sua inscrição
push e desliga ambos os canais; encerrar todos remove as inscrições da caixa.
Backchannel e SSF aplicam o mesmo corte às famílias SSO correspondentes.

Uma inscrição antiga sem família não comprova autorização. A migração remove
essas inscrições e suas chaves; o usuário precisa autorizar o aparelho novamente.
Nova sessão também exige autorização explícita. A presença de uma inscrição
local órfã não significa que ela esteja ligada para a conta atual.

Antes de entregar, o servidor filtra famílias ativas, prazo, estado da caixa e
propriedade SSO. Avisos comuns respeitam `notifyEnabled`, `notifyOnlyInbox` e
silêncio no fuso `MAIL_TIMEZONE`. Avisos internos de segurança ignoram essas
preferências da caixa, mas precisam de aparelho autorizado. A origem de segurança
é atribuída pelo serviço interno; headers recebidos não podem obtê-la.

## Estado e teste do aparelho

O estado de segundo plano cruza permissão, suporte, disponibilidade VAPID,
inscrição local, chave pública correspondente e vínculo remoto com a família
atual. Alterar VAPID exige reativação. Sem PushManager, o aparelho ainda pode
usar avisos com a aba aberta se houver Notification e service worker.

`POST /v1/me/push/test` envia somente às inscrições da família autenticada.
`enviados` significa aceite do serviço do navegador, não comprovação de exibição.
O usuário precisa conferir o aviso no aparelho. Desligar retira primeiro a
autorização remota; falha posterior do navegador é exibida sem manter o servidor
autorizado. Falha remota preserva o estado e permite tentar novamente.
O logout segue a mesma regra: só apaga os cookies e segue ao encerramento global
depois que a API confirma a revogação da família. Falha remota mantém a sessão
para repetir o pedido e aparece no botão Sair.

## Continuidade e dados

`Message.arrivalSeq` é atribuído junto do incremento de
`Mailbox.messageEventSeq`, sob o lock da caixa na transação da entrega. Isso
ordena commits e independe do header Date, de timestamps iguais e de gravações
de blobs com durações diferentes. Registros anteriores à migração ficam em zero;
a lista inicial os mostra, sem gerar avisos históricos.

O cursor é composto por caixa e sequência. `id` dos eventos SSE permite
`Last-Event-ID`; a URL também aceita `cursor` quando a interface recria o canal.
O BFF repassa o header. Um cursor inválido, de outra caixa ou futuro inicia a
reconciliação no estado atual. Lotes de vinte avançam até seu último item;
checkpoints atravessam sequências cujas mensagens já foram removidas.

O cursor só avança junto da escrita efetiva do evento. O limite de cinco minutos
não pode publicar cursor de lote ainda esperando preferências ou contagens.
Polls não se sobrepõem. Cada poll, por padrão a cada oito segundos, revalida a
sessão e encerra o canal revogado. Esse é o prazo nominal de propagação, sujeito
à latência das consultas; não há promessa de oito segundos em indisponibilidade.

Listagem e eventos usam o mesmo seletor e mapeador de resumo. A interface
reconcilia lista e contagens após conexão, retomada, eventos e retorno à aba;
não injeta DTO parcial na lista. O canal permanece aberto ao trocar pasta ou
filtro e mostra estado de desconexão com ação de reconectar.

## Deduplicação e clique

Push e avisos da aba passam pelo mesmo service worker. Uma transação IndexedDB
reserva a chave caixa/evento antes da exibição, serializando abas concorrentes
e o push. O registro é conservado por sete dias, com limpeza incremental.
Avisos de mensagem compartilham a mesma tag por caixa. A presença de uma caixa
visível é consultada nas abas antes de mostrar o aviso do sistema.

Se a exibição falhar, a reserva é liberada para outra tentativa. A notificação
do sistema é best effort: não há fila de reenvio automático após recusa do
navegador. Lista, contador e mensagem continuam disponíveis. Limpar os dados do
site também apaga o histórico de deduplicação.

O clique só navega para destinos internos permitidos. Mensagens usam
`/caixa?mensagem=ID`; o destino atravessa renovação, login local, SSO, MFA,
seletor e primeira senha. A API continua exigindo pertencimento à caixa;
mensagem removida ou alheia produz o mesmo erro seguro. Lembretes conservam
data e identificador da ocorrência.

## Verificação operacional de 28/10/2026

Consulta somente de leitura pelo alias SSH configurado `applications`, no mesmo
IP resolvido pelo DNS de `mail.avilaops.com`: `avila-mail-api.service` e
`avila-mail-mta.service` ativos. Os ambientes iniciais dos processos possuem
ambas as chaves VAPID. OpenSSL derivou a pública a partir da privada em memória
e confirmou pares válidos. As duas chaves e o contato coincidem entre API/MTA.
O relatório expôs somente booleanos, sem chaves ou fingerprints.

Não houve envio real de push, mudança de configuração, inscrição ou preferência
de produção. Testes e builds da implementação rodam exclusivamente no GitHub CI.
