# Contrato de sessão entre Mail e Auth

## Portas e validação

O Mail conserva o protocolo existente: cookie HttpOnly `avila_sso`, HS256,
emissor `auth.avilaops.com`, identidade `sub`, e-mail e datas `iat`/`exp`.
Tokens OIDC de outra finalidade não são aceitos como esse cookie.

O Auth é a fonte da política de acesso e segundo fator. O servidor Mail consulta
`/login?app=mail&returnTo=<callback do Mail>` com o cookie e sem seguir redirects.
Somente o retorno exato ao callback significa autorização. Um redirect para
`/api/auth/mfa/elevar` exige confirmar o fator no Auth; uma tela de login sem
retorno não concede acesso. O Mail não interpreta HTML nem replica regras de
papéis ou exigência de MFA.

Essa é a mesma porta usada pelo navegador no contrato existente. `/api/session`
isoladamente não basta: sua resposta atual informa permissão, mas não a exigência
de segundo fator. Uma indisponibilidade do emissor responde 503 e não consome o
refresh Mail. A consulta tem limite de três segundos e ocorre ao entrar e renovar.

## Prazos e identidade

- Login com senha da caixa: prazo absoluto `MAIL_REFRESH_TOKEN_DAYS`, 30 dias por
  padrão, e acesso curto `MAIL_ACCESS_TOKEN_MINUTES`, 15 minutos por padrão.
- SSO: o prazo é o menor entre esse limite Mail e o `exp` emitido pelo Auth.
  O Auth atual emite oito horas. O Mail não transforma esse prazo em 30 dias nem
  o prolonga por atividade.
- A sessão armazena origem, `sub`, e-mail e emissão do Auth. O cookie necessário
  à revalidação fica cifrado no banco, nunca no JavaScript da página.
- Mudança de dono da caixa impede o acesso e a renovação do dono SSO anterior.
- Login local e sessões de outra identidade não são revogados por logout SSO
  dirigido a um `sub` diferente.

## Aviso de saída

O endpoint público do receptor é
`POST https://mail.avilaops.com/api/sessao/sso/revogar`.
Aceita `application/x-www-form-urlencoded` com `logout_token`, como o Auth envia.
O BFF limita o corpo e encaminha a prova à API interna.

O receptor confere RS256, `kid` das chaves públicas de `/oauth/jwks`, emissor
`https://auth.avilaops.com`, audience, `typ=logout+jwt`, validade curta, `jti`,
`sub` e o evento `http://schemas.openid.net/event/backchannel-logout`.
Sem assinatura confiável, nada é revogado. Repetições são idempotentes.

O corte por identidade persiste no PostgreSQL e nunca retrocede. Login e refresh
usam o mesmo lock do corte; um aviso concorrente não permite reabrir com o JWT
anterior. Uma nova sessão emitida pelo Auth depois do corte é aceita.

O transmissor SSF também pode entregar `application/secevent+jwt` em
`POST https://mail.avilaops.com/api/sessao/sso/sinais`. O Mail aceita os eventos
que o Auth atual publica: sessão revogada, credencial alterada e conta desativada,
além da verificação do canal. Esses eventos identificam o usuário por e-mail e
mantêm um corte separado, aplicado somente às sessões SSO. A assinatura tem o
mesmo emissor/audience, mas `typ=secevent+jwt` e sem `exp`, como o transmissor emite.

Para receber esses sinais, o administrador precisa cadastrar no Auth um canal
SSF com os tipos correspondentes e o endereço acima. O Auth exige uma integração
autorizada a SSF e autorização de uma pessoa da equipe com `ssf.manage`/`ssf.read`.
O Mail não cria essa autorização nem esse canal silenciosamente.

Depois de um aviso recebido, novas chamadas autenticadas são recusadas e streams
SSE já abertos revalidam a sessão a cada consulta (o intervalo padrão é oito
segundos). Os cortes persistentes também impedem reentrada com o cookie anterior.

O emissor usa precisão de segundos. Se a nova prova e a alteração de MFA caem
no mesmo segundo, o Mail mantém o corte inclusivo e pede reautenticação, pois
não consegue distinguir com segurança uma prova anterior de uma posterior.
A tela de recuperação só encerra o login único após clique explícito. O Auth
faz o POST de logout e retorna ao Mail. A espera atual de 1,1 segundo evita
repetição imediata, mas **não comprova ordenação**: o emissor pode assinar o aviso
em uma tarefa posterior à resposta. A correção completa depende da
[proposta de ajuste do emissor](contrato-auth-mail-ordenacao.md), ainda pendente
de autorização de escopo. O módulo Auth não está concluído nem liberado para produção.

## Configuração e publicação

Configuração da API Mail:

- `SSO_JWT_SECRET`: segredo já compartilhado com o emissor. Não imprimir valores.
- `MAIL_AUTH_URL`: base para consultar o gate e as chaves públicas; padrão
  `https://auth.avilaops.com`.
- `WEBMAIL_URL`: URL pública do Mail, igual à usada pelo BFF; padrão
  `https://mail.avilaops.com`.
- `MAIL_SSO_LOGOUT_AUDIENCE`: ID da integração que o Auth usa ao assinar o aviso;
  padrão `mail`. Conferir o ID efetivo; não confundir ID da integração e do app.

O administrador deve registrar o endereço de saída acima na integração do Auth.
A assinatura RS256 do emissor precisa estar habilitada e suas chaves públicas
acessíveis à API Mail. Este trabalho implementa e testa o receptor; não altera
o cadastro do Auth nem comprova que esse cadastro existe em produção.

O emissor atual trata a entrega do aviso como melhor esforço. A aplicação após
recebimento é verificável; entrega efetiva precisa ser conferida no procedimento
operacional. Sem entrega, o prazo `exp` do Auth continua sendo o limite absoluto.

## Migração de sessões existentes

O servidor antigo não distinguia login local e SSO. A migração
`20261028070000_sso_contract` marca sessões existentes como `legacy`; elas exigem
uma reautenticação única. É impossível atribuir com segurança um `sub` a essas
sessões por adivinhação. Logins novos registram a origem e mantêm os prazos acima.

A migração de `Path` do cookie continua funcionando para sessões com origem
conhecida. Ela não dispensa a reautenticação de sessões anteriores ao novo contrato.
Preparar e aplicar a migração no procedimento operacional aprovado, sem executar
builds ou testes nos servidores de produção.

## Verificação

O GitHub CI cobre autorização e MFA no callback direto, prazo do emissor,
indisponibilidade recuperável, vínculo e troca de dono, múltiplas caixas,
assinatura/audience, repetição e corte monotônico, concorrência e isolamento
entre identidades e sessões locais. O cadastro e a entrega reais em produção
continuam dependendo da publicação e verificação operacional autorizadas.
