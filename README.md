# avila-mail: servidor de e-mail próprio

Infraestrutura de e-mail da Ávila Ops. Substitui a revenda de Zoho/Titan e o
encaminhamento do Porkbun por caixas reais operadas por nós, vendidas a
**R$ 10/caixa/mês**.

Documento de produto (arquitetura, custos, margem, fases):
[`docs/produtos/MAIL-AVILAOPS.md`](../docs/produtos/MAIL-AVILAOPS.md)

---

## O que já existe

| Componente | Arquivo | Estado |
|---|---|---|
| SMTP de entrada (porta 25) | `src/mta/inbound.ts` | Pronto |
| Verificação SPF/DKIM/DMARC na entrada | `src/mta/authcheck.ts` | Pronto |
| Entrega local, quota, anti-spam, threading | `src/mta/deliver-local.ts` | Pronto |
| Submission autenticada (587/465) | `src/mta/submission.ts` | Pronto |
| Assinatura DKIM por domínio | `src/mta/dkim.ts` | Pronto |
| Fila de saída com relay plugável | `src/mta/queue.ts` | Pronto |
| API de provisionamento | `src/api/index.ts` | Pronto |
| Login do dono da caixa, refresh com rotação, bloqueio de força bruta | `src/services/session.ts` | Pronto |
| API de mensagens: pastas, listagem, busca, leitura, flags, anexos | `src/services/messages.ts` | Pronto |
| Sanitização de HTML das mensagens (anti-XSS) | `src/lib/sanitize.ts` | Pronto |
| Compor, responder com threading, anexar e rascunhar | `src/services/compose.ts` | Pronto |
| E-mail de boas-vindas da caixa nova | `src/services/welcome.ts` | Pronto |
| Cobrança recorrente no cartão (Mercado Pago) | `src/services/billing.ts` | Pronto |
| Interface do webmail (ondas 1–3) | `webmail/` | Pronto |
| Cobrança automática no gateway (Mercado Pago) | `src/services/billing.ts` + webhook | Pronto |
| Bounce (DSN, RFC 3464) ligado à fila | `src/services/bounce.ts` | Pronto |
| Retenção: lixeira 30 dias + faxina diária | `src/mta/maintenance.ts` | Pronto |
| Conferência diária de SPF, DKIM, DMARC e MX de cada domínio, com aviso | `src/services/conferenciaDeDns.ts` | Pronto |
| IMAP (143/993) e POP3 (110/995) | `src/mta/imap.ts` | Pronto |
| Filtros e regras da caixa (mover, marcar, encaminhar cópia) | `src/services/rules.ts` | Pronto |
| Aviso de mensagem nova: contador na aba, balão do sistema e Web Push | `src/services/push.ts` + `webmail/public/sw.js` | Pronto |
| Alertas de segurança da conta (acesso novo, senha, 2FA, chave) e de quota | `src/services/alertas.ts` | Pronto |
| Preferências de aviso: silêncio noturno, só Entrada, desligar | `src/services/settings.ts` | Pronto |
| Aquecimento de IP: rampa diária na saída direta | `src/mta/warmup.ts` | Pronto |
| Aliases (`vendas@` → caixa ou externo) e catch-all pela API | `src/services/provisioning.ts` | Pronto |
| Anti-spam que aprende com os botões "é spam"/"não é spam" | `src/mta/deliver-local.ts` | Pronto |
| Verificação em duas etapas no webmail (TOTP, RFC 6238) | `src/lib/totp.ts` + `src/services/session.ts` | Pronto |
| CardDAV (contatos) e CalDAV (agenda) para celular/desktop | `src/dav/` | Pronto |
| Autoatendimento (domínio, DNS, caixa) | `src/services/publicSignup.ts` + `src/services/signupCheckout.ts` | Pronto |
| Página inicial pública (a porta de quem ainda não é cliente) | `webmail/src/components/PaginaInicial.tsx` | Pronto |

## Login pelo SSO (auth.avilaops.com)

Desde 26/08/2026 a porta do webmail e o `auth.avilaops.com`: `/entrar` redireciona
para `auth.avilaops.com/login?app=mail&returnTo=https://mail.avilaops.com/api/sessao/sso`.
Na volta, o webmail repassa o cookie `avila_sso` para `POST /v1/auth/sso` da API,
que verifica o JWT (`SSO_JWT_SECRET`, o mesmo do auth) e emite a sessao normal
da caixa, sem senha.

Quem pode abrir o que: caixa cujo endereco e o e-mail da conta, ou caixa com
`owner_email` igual a ele (`POST /v1/mailboxes` aceita `owner_email`;
`POST /v1/mailboxes/owner` altera). Varias caixas → seletor em `/entrar/caixas`.

`/entrar?local=1` mantem o login com a senha da caixa (IMAP/apps continuam na
senha). Webmail precisa de `SSO_ENABLED=true` (unit do systemd); a API, de
`SSO_JWT_SECRET` no `.env.production`.

Caddy: so `/api/v1/*` vai para a API; o resto de `/api/*` e BFF do webmail.

## Testes

```bash
npm test                  # sobe Postgres em container, migra e roda tudo
npm run test:smoke        # 96 verificações, sem banco e sem rede
npm run test:security     # 46 verificações de injeção, XSS e token
npm run test:integration  # 455 verificações contra Postgres real
```

**Total: 578 verificações.** Os protocolos são conferidos por clientes
independentes: IMAP pelo `imapflow`, CardDAV/CalDAV pelo `tsdav`. A sondagem de segurança cobre 23 vetores de XSS,
injeção de cabeçalho CRLF (assunto e nome de exibição), endereços malformados e
8 formas de falsificar o token de sessão.

O teste de integração cobre o caminho completo: provisionar domínio e caixa,
receber uma mensagem hostil de verdade (com `<script>`, link `javascript:` e
pixel de rastreio), autenticar o dono, ler pela API, e confirmar que uma caixa
não enxerga a correspondência da outra.

---

## Instalação no VPS

```bash
# 1. Enviar o código
#
# O --exclude '.env*' não é opcional: sem ele, qualquer arquivo de ambiente que
# exista aqui na estação sobrescreve o /opt/avila-mail/.env.production do
# servidor. Junto com ele iria embora a MAIL_DKIM_ENCRYPTION_KEY — e as chaves
# DKIM privadas ficam cifradas com ela no banco. Perdê-la significa gerar par
# novo e republicar DNS na conta de cada cliente.
rsync -az --exclude node_modules --exclude dist --exclude '.env*' ./ root@SERVIDOR:/opt/avila-mail/

# 2. Configurar o ambiente
ssh root@SERVIDOR
cp /opt/avila-mail/.env.example /opt/avila-mail/.env.production
openssl rand -hex 32   # → MAIL_DKIM_ENCRYPTION_KEY
openssl rand -hex 32   # → MAIL_API_TOKEN
nano /opt/avila-mail/.env.production

# 3. Instalar (idempotente)
bash /opt/avila-mail/deploy/install.sh
```

O script cria usuário de sistema, banco, diretórios, compila, roda as migrações,
sobe os dois serviços systemd e liga o timer que mantém o certificado em dia.
Ele **não** mexe em DNS.

---

## Passos manuais (fora do script)

### 1. DNS de `avilaops.com` (Cloudflare)

| Tipo | Nome | Valor | Observação |
|---|---|---|---|
| A | `mail` | IP do servidor | **DNS only**, sem proxy do Cloudflare, SMTP não passa por proxy HTTP |
| MX | `@` | `mail.avilaops.com` (prio 10) | Substitui `fwd1/fwd2.porkbun.com` |
| TXT | `@` | `v=spf1 include:_spf.avilaops.com -all` | |
| TXT | `_spf` | `v=spf1 a:mail.avilaops.com ~all` | SPF central, trocar o relay aqui vale para todos os clientes |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:dmarc@avilaops.com` | |
| TXT | `_mta-sts` | `v=STSv1; id=<data>` | **Só quando o MX de avilaops.com vier para cá**, hoje está na Porkbun e a política fica em `mode: none` |
| A | `mta-sts` | IP do servidor | Serve a política MTA-STS |

> Ao trocar o MX do Porkbun para o nosso, o encaminhamento atual para de
> funcionar no mesmo instante. Criar as caixas **antes** de virar o MX.

### 2. rDNS na Hetzner

Console → Servidor → Networking → Reverse DNS → `mail.avilaops.com`.
Sem isso, Gmail e Outlook rejeitam ou marcam como spam.

Já feito para `178.105.82.48` em 14/08/2026. Pela API, para servidor novo:

```bash
curl -X POST "https://api.hetzner.cloud/v1/servers/$ID/actions/change_dns_ptr" \
  -H "Authorization: Bearer $HCLOUD_TOKEN" -H "Content-Type: application/json" \
  -d '{"ip":"'"$IP"'","dns_ptr":"mail.avilaops.com"}'
```

### 3. Certificado TLS

**Automático, não faça nada.** Quem emite e renova é o Caddy (ACME, ~30 dias
antes de vencer), porque ele já responde por `https://mail.avilaops.com`. Como o
Caddy guarda o material em `/var/lib/caddy` com `600 caddy:caddy` - que o usuário
do MTA não lê, o `avila-mail-cert-sync.timer` (diário, instalado pelo
`install.sh`) copia para `/etc/avila-mail/tls` só quando muda, com escrita
atômica e a chave em `640 root:avilamail`.

O MTA relê o certificado sozinho: o `SNICallback` confere o mtime a cada
handshake e reconstrói o contexto quando o arquivo troca (`src/mta/tls.ts`).
Renovação entra em vigor na conexão seguinte, **sem restart e sem derrubar
quem está conectado**.

```bash
# conferir quando vence e forçar uma sincronia
bash /opt/avila-mail/deploy/sincronizar-certificado.sh
systemctl list-timers avila-mail-cert-sync.timer
```

O script avisa no journal se o certificado do próprio Caddy estiver a menos de
15 dias do vencimento, sinal de que a renovação automática falhou e alguém
precisa olhar.


### 4. Caddy

Incluir `deploy/Caddyfile.snippet` no Caddyfile principal e `caddy reload`.

### 5. Ligar o portal

O `cliente.avila.inc` já fala este contrato em `src/lib/emailProvider.ts`
basta tirá-lo do modo mock por variável de ambiente, sem alterar código:

```bash
EMAIL_PROVIDER_API_URL="https://mail.avilaops.com/api/v1"
EMAIL_PROVIDER_API_TOKEN="<mesmo valor de MAIL_API_TOKEN>"
```

---

## Contrato da API

Autenticação: `Authorization: Bearer <MAIL_API_TOKEN>`.

| Método | Rota | Uso |
|---|---|---|
| GET | `/v1/health` | Liveness (única rota sem token) |
| POST | `/v1/domains` | Provisiona domínio e gera par DKIM |
| GET | `/v1/domains/{dominio}/dns` | Registros a publicar + última verificação |
| POST | `/v1/domains/{dominio}/verify` | Confere DNS e ativa o domínio |
| GET | `/v1/domains/{dominio}/mailboxes` | Lista caixas com uso e status |
| POST | `/v1/mailboxes` | Cria caixa (`notify_to` avisa o contato do cliente) |
| POST | `/v1/mailboxes/suspend` | Suspende acesso (continua recebendo) |
| POST | `/v1/mailboxes/reactivate` | Reativa |
| POST | `/v1/mailboxes/password` | Troca senha |
| POST | `/v1/mailboxes/quota` | Ajusta quota |
| POST | `/v1/mailboxes/delete` | Remove caixa e mensagens |
| GET | `/v1/domains/{dominio}/aliases` | Lista os aliases do domínio |
| POST | `/v1/aliases` | Cria ou atualiza alias (`vendas@` → caixa nossa ou endereço externo) |
| POST | `/v1/aliases/delete` | Remove alias |
| POST | `/v1/domains/{dominio}/catch-all` | Define a caixa pega-tudo do domínio (`username: null` desliga) |
| GET | `/v1/billing/mailboxes` | Base de faturamento (R$ 10 × caixas) |
| POST | `/v1/billing/accounts` | Cria a conta de cobrança do cliente |
| POST | `/v1/billing/accounts/{ref}/subscribe` | Gera o link do cartão (Mercado Pago) |
| POST | `/v1/billing/accounts/{ref}/sync` | Recalcula o valor pelo nº de caixas |
| POST | `/v1/billing/accounts/{ref}/cancel` | Cancela a assinatura |
| GET | `/v1/billing/accounts/{ref}` | Situação e últimas cobranças |
| GET | `/v1/billing/overview` | Painel: contas, caixas e MRR |
| POST | `/v1/public/signup/dns` | **Público**: `{domain}` → os 4 registros de DNS que o domínio precisa |
| POST | `/v1/public/signup/verify` | **Público**: `{domain}` → `{pronto, checks, faltando}` |
| POST | `/v1/webhooks/mercadopago` | Notificações do MP (valida `x-signature`) |
| GET | `/v1/ops/status` | Fila, domínios pendentes, quota, para o n8n |
| GET | `/v1/ops/domains-pending` | Domínios aguardando propagação de DNS |

### Área administrativa (webmail `/admin`)

Caixas listadas em `MAIL_ADMIN_ADDRESSES` (endereço ou dono no SSO) veem o link
**Administração** e fazem pela tela tudo que a API de provisionamento faz: provisionar
domínio e copiar/verificar os registros DNS, criar caixa (senha gerada, exibida uma vez),
redefinir senha, quota, suspender/reativar/excluir, aliases e catch-all, com um resumo de
fila, aquecimento e cobrança no topo. Na seção de DNS, o painel
consulta os servidores de nome do domínio e mostra um botão que abre o DNS dele no
provedor (Cloudflare, Registro.br, GoDaddy, Hostinger, Namecheap e Porkbun,
`src/lib/provedorDns.ts`); provedor fora da lista aparece só com os servidores de nome.
Quando a zona está na conta da Cloudflare da Avila Ops (a mesma credencial que publica o
DKIM na nossa zona), aparece **Publicar na Cloudflare**: grava os registros e verifica em
seguida (`src/services/publicacaoDns.ts`). O que já existe na zona é respeitado: MX que
aponta para outro provedor só é trocado depois de confirmação na tela, SPF existente
ganha o nosso `include` sem perder o resto, DMARC já publicado fica como está. As rotas `/v1/admin/*` autenticam pela **sessão**;
chave de API não entra (administrar é ação de gente logada, com 2FA se tiver).

| Método | Rota | Uso |
|---|---|---|
| GET | `/v1/admin/resumo` | Domínios, caixas ativas, fila, aquecimento, cobrança |
| GET | `/v1/admin/domains` | Lista com status, checagem de DNS e contagens |
| POST | `/v1/admin/domains` | Provisiona domínio (gera DKIM) |
| GET | `/v1/admin/domains/{d}` | Registros DNS, caixas, aliases e catch-all |
| POST | `/v1/admin/domains/{d}/verify` | Confere MX/SPF/DKIM/DMARC e ativa |
| POST | `/v1/admin/domains/{d}/publish-dns` | Publica os registros na Cloudflare quando a zona está na conta da casa; `{substituirMx: true}` troca um MX que aponta para outro lugar |
| POST | `/v1/admin/domains/{d}/catch-all` | `{username}` ou `{username: null}` |
| POST | `/v1/admin/mailboxes` | Cria caixa; sem `password` gera e devolve uma vez |
| POST | `/v1/admin/mailboxes/{suspend,reactivate,delete,password,quota,owner}` | Ações da caixa |
| POST | `/v1/admin/aliases`, `/v1/admin/aliases/delete` | Aliases |

### Chaves de API (área de desenvolvedor)

O dono da caixa cria, copia e revoga chaves na tela **Conta → Desenvolvedor** do
webmail, ninguém precisa entrar no servidor. O token aparece uma única vez; o banco
guarda só o hash (`mail_api_keys`). Dois escopos, dois prefixos:

| Prefixo | Escopo | Onde vale | Quem cria |
|---|---|---|---|
| `amk_m_…` | Caixa | `/v1/me/*` (age como o dono) | qualquer dono |
| `amk_p_…` | Provisionamento | `/v1/domains`, `/v1/mailboxes`, `/v1/aliases`, `/v1/billing`, `/v1/ops` | caixa em `MAIL_ADMIN_ADDRESSES` |

Chave de caixa **não** troca senha, 2FA, sessões, migração, perfil nem outras chaves (403).
O `MAIL_API_TOKEN` do `.env.production` continua valendo como bootstrap/contingência;
o n8n e os scripts devem usar uma chave `amk_p_` criada pela tela, para poder ser
revogada sem redeploy.

| Método | Rota | Uso |
|---|---|---|
| GET | `/v1/me/api-keys` | Lista (prefixo, escopo, último uso) + `canProvision` |
| POST | `/v1/me/api-keys` | Cria `{name, scope}` → devolve `token` (uma vez) |
| DELETE | `/v1/me/api-keys/{id}` | Revoga |

### Rotas do dono da caixa

Autenticação por JWT de sessão (`POST /v1/auth/login`), **não** pelo token de
provisionamento. Um token nunca serve para o outro: o de provisionamento cria e
apaga caixa de qualquer cliente; o de sessão só enxerga a própria caixa.

| Método | Rota | Uso |
|---|---|---|
| POST | `/v1/auth/login` | Login com endereço + senha (com 2FA ativa, devolve `requiresTotp` + `totpToken`) |
| POST | `/v1/auth/totp` | Segunda etapa: código do autenticador ou de recuperação |
| POST | `/v1/me/totp/setup` · `enable` · `disable` | Ativa/desativa a verificação em duas etapas |
| POST | `/v1/auth/refresh` | Renova a sessão (rotaciona o refresh) |
| POST | `/v1/auth/logout` | Encerra a sessão atual |
| GET | `/v1/me` | Dados da caixa, quota e uso |
| POST | `/v1/me/password` | Troca de senha pelo próprio dono |
| GET | `/v1/me/sessions` | Dispositivos conectados |
| POST | `/v1/me/sessions/revoke-all` | Sair de todos os dispositivos |
| GET | `/v1/me/folders` | Pastas com total e não lidas |
| GET | `/v1/me/messages` | Listagem paginada por cursor (`folder`, `q`, `unread`, `flagged`, `attachment=any|image|pdf`) |
| GET | `/v1/me/messages/{id}` | Mensagem completa, HTML sanitizado (`?images=true` libera imagem remota) |
| GET | `/v1/me/messages/{id}/raw` | Baixa o `.eml` original |
| GET | `/v1/me/messages/{id}/attachments/{anexoId}` | Baixa anexo |
| PATCH | `/v1/me/messages` | Marca lida/favorita, move de pasta (até 200 por vez) |
| POST | `/v1/me/messages/delete` | Lixeira; se já na lixeira, apaga e devolve quota |
| POST | `/v1/me/trash/empty` | Esvazia a lixeira |
| POST | `/v1/me/messages/send` | Envia (anexos em base64 ou por `attachmentIds`); segura 15 s na fila e devolve `desfazerAteMs` |
| POST | `/v1/me/messages/undo-send` | Cancela o envio dentro da janela; devolve `{cancelado}` (falso se o worker já pegou) |
| POST | `/v1/me/messages/snooze` | Adia mensagens até `until` (ISO); voltam à Entrada pelo varredor do MTA |
| POST | `/v1/me/drafts` | Salva rascunho; com `draftId` substitui o anterior |
| GET | `/v1/me/send-quota` | Quanto resta da cota de envio nesta hora |
| GET | `/v1/me/threads/{threadKey}` | Conversa inteira |
| POST | `/v1/me/messages/mark-all-read` | Marca a pasta inteira como lida |
| GET | `/v1/me/unread-count` | Contador por pasta, sem baixar a lista |
| DELETE | `/v1/me/sessions/{id}` | Desconecta **um** dispositivo |
| GET/PUT | `/v1/me/settings` | Assinatura, resposta automática, imagens remotas |
| PATCH | `/v1/me/profile` | Nome de exibição e e-mail de recuperação |
| GET | `/v1/me/contacts?q=` | Autocompletar destinatário (do histórico) |
| GET | `/v1/me/send-as` | Endereços que a caixa pode usar como remetente |
| POST/GET | `/v1/me/attachments` | Anexo enviado antes, com progresso |
| DELETE | `/v1/me/attachments/{id}` | Descarta anexo pendente |
| POST | `/v1/me/messages/report-spam` · `not-spam` | Move e registra para treino |
| POST | `/v1/me/folders` | Cria pasta própria |
| PATCH/DELETE | `/v1/me/folders/{id}` | Renomeia / exclui (mensagens voltam à Entrada) |
| GET | `/v1/me/events` | SSE: aviso de mensagem nova |
| POST | `/v1/auth/forgot-password` · `reset-password` | Recuperação por e-mail alternativo |

### Contatos e agenda no celular (CardDAV/CalDAV)

Cada caixa tem uma coleção de contatos (`Contatos`) e uma agenda (`Agenda`,
só VEVENT), servidas em `https://mail.avilaops.com/dav/` com o endereço e a
senha da caixa (Basic sobre TLS, mesmas travas de força bruta dos outros
protocolos). iOS/macOS descobrem sozinhos pelos well-known
(`/.well-known/carddav` e `/.well-known/caldav`); DAVx⁵ e Thunderbird aceitam
a URL direta. Sincronização incremental por `sync-collection` (RFC 6578) com
lápides, exclusão feita num aparelho some do outro, e ETag em todo item, com
`If-Match`/`If-None-Match` segurando edição concorrente. O vCard/iCalendar do
cliente é guardado byte a byte; o servidor só indexa UID, nome e a janela do
evento para o filtro `time-range`.

Envio e resposta:

```bash
curl -X POST https://mail.avilaops.com/api/v1/me/messages/send \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
        "to": ["cliente@exemplo.com"],
        "subject": "Proposta",
        "html": "<p>Segue em anexo.</p>",
        "inReplyToMessageId": "cm...",
        "attachments": [{"filename":"proposta.pdf","contentBase64":"..."}]
      }'
```

Ao passar `inReplyToMessageId`, o servidor preenche `In-Reply-To` e `References`,
prefixa `Re:` no assunto, marca a original como respondida e mantém a resposta
na mesma conversa. `bcc` entra só no envelope, nunca nos headers.

Decisões de segurança que valem registro:

- **Todo acesso a mensagem filtra por `mailboxId` da sessão.** Nunca por id
  isolado, o teste de integração tem um caso dedicado a isso (IDOR).
- **O HTML é sanitizado na leitura, não na gravação.** O `.eml` original fica
  intacto; quando a lista de permissão mudar, a correção vale retroativamente.
- **Imagem remota vem bloqueada por padrão**, é o rastreador de leitura mais
  comum que existe. O cliente libera com um clique.
- **Refresh token rotaciona**, e reuso de um token já gasto derruba todas as
  sessões da caixa (sinal de roubo de token).
- **Bloqueio de força bruta em camadas**: par endereço+IP (8 tentativas), IP
  (24) e endereço (40). O limite alto por endereço é proposital, se fosse 8,
  qualquer um trancaria a caixa de um cliente errando a senha de propósito.
- **A senha nunca vai por e-mail.** O e-mail de boas-vindas leva o endereço e o
  guia de configuração; a senha volta uma única vez na resposta de
  `POST /v1/mailboxes`, para o painel mostrar a quem está provisionando.
- **A cota de envio é uma só** para o SMTP e para o webmail. Dois contadores
  separados seriam duas metades de uma trava, e o atacante usaria a mais folgada.

Exemplo:

```bash
curl -X POST https://mail.avilaops.com/api/v1/domains \
  -H "Authorization: Bearer $MAIL_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"domain":"clientex.com.br","clientRef":"ckx123"}'
```

---

## Cobrança recorrente

Uma assinatura por **cliente**, com valor igual a R$ 10 × número de caixas. Uma
assinatura por caixa encheria a fatura do cartão de linhas de R$ 10 e
multiplicaria a taxa fixa do gateway em cada uma.

```bash
# 1. cria a conta de cobrança
curl -X POST .../v1/billing/accounts -d '{"client_ref":"cli_x","payer_email":"financeiro@cliente.com.br"}'

# 2. gera o link do cartão e manda o cliente para lá
curl -X POST .../v1/billing/accounts/cli_x/subscribe
# → { "initPoint": "https://www.mercadopago.com.br/subscriptions/checkout?..." }
```

### Nenhum dado de cartão passa por aqui

A assinatura é criada **sem `card_token_id`**. O Mercado Pago devolve um
`init_point` e o cliente cadastra o cartão na página dele. Some o escopo de PCI
do nosso lado, e o webmail não precisa afrouxar a CSP para carregar o SDK de
tokenização.

### O que o webhook decide

| Evento | Efeito |
|---|---|
| Assinatura autorizada | Caixas ativas |
| Cobrança aprovada | Registra pagamento, zera falhas, reativa se estava suspensa |
| Cobrança recusada, dentro da tolerância | Só conta a tentativa, cartão vencido costuma ser trocado no mesmo dia |
| Cobrança recusada, após `MAIL_DIAS_TOLERANCIA` | Suspende o **acesso**; o recebimento continua |
| Assinatura cancelada ou pausada | Suspende o acesso |

Três decisões que sustentam isso:

- **A notificação é gravada antes de ser processada**, com chave única
  `topico:id`. O MP reenvia por dias qualquer notificação que não receba 200
  rápido, sem isso, o mesmo pagamento entraria duas vezes.
- **A assinatura HMAC é obrigatória.** O endpoint é público (o MP não carrega
  nosso token). Sem validar, qualquer um posta "pagamento aprovado" para
  reativar uma caixa suspensa, ou "assinatura cancelada" para derrubar a caixa
  de um cliente em dia. Notificação com mais de 10 minutos é recusada, para
  fechar replay.
- **Reativar só devolve o que nós suspendemos.** Caixa `disabled` foi desativada
  de propósito e não volta porque uma fatura foi paga.

O número de caixas é sempre lido do banco na hora. Criar ou remover caixa
reajusta a assinatura sozinho; se o Mercado Pago estiver fora do ar, o
provisionamento **não falha**, a rota `/sync` recalcula depois.

## Operação

```bash
systemctl status avila-mail-mta avila-mail-api
journalctl -u avila-mail-mta -f          # log estruturado em JSON
curl -s localhost:3040/v1/health

# fila travada?
curl -s -H "Authorization: Bearer $TOKEN" localhost:3040/v1/ops/status | jq
```

**Caminho de saída atual: `direct`**, entrega MX-a-MX pelo IP do servidor. A
Hetzner liberou a porta 25 de saída em 14/08/2026.

### Aquecimento de IP

O IP nunca enviou correspondência: volume súbito de IP desconhecido é a
assinatura clássica de spammer para Gmail e Outlook. Definir
`MAIL_WARMUP_INICIO` (YYYY-MM-DD, o dia 1) no `.env.production` liga uma rampa
com teto **diário** de mensagens externas, padrão `30,60,120,250,500,1000`,
um valor por semana (`MAIL_WARMUP_CAPS`); terminada a lista, o teto some.

Três decisões que valem registro:

- **Nada é recusado nem vira bounce.** O excedente fica na fila com hora
  marcada na virada do dia UTC, sem consumir tentativa, não houve falha,
  fomos nós que seguramos.
- **Só destinatário de fora conta.** Mensagem entre caixas nossas não gasta
  reputação do IP; ela nunca espera.
- **O consumo é lido do banco a cada ciclo**, não de um contador em memória
  um restart do MTA não zera (nem infla) o orçamento do dia.

`GET /v1/ops/status` devolve `warmup: { dia, cap, enviadosHoje, restante }`
enquanto a rampa está ativa (null quando desligada ou concluída), e cada ciclo
que segura mensagens grava um evento `outbound.warmup_deferred`.

Se o IP entrar em bloqueio de reputação, a volta para uma ponte é trocar
`MAIL_RELAY_DRIVER` no `.env.production` (`smtp` ou `n8n`) e reiniciar o MTA.
Nada mais muda, a fila é a mesma.

---

## Limites conhecidos

- **IP sem histórico de envio.** A rampa de aquecimento cuida disso sozinha
  basta definir `MAIL_WARMUP_INICIO` no dia em que a venda começar.
- **Teto de ~30 caixas** no host compartilhado atual. Gatilhos de migração estão
  no documento de produto.
