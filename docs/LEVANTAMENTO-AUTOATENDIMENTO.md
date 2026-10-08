# Autoatendimento do Avila Mail: o que falta

Levantamento de 31/08/2026. Pergunta que originou: *"o mail.avilaops.com já está
self-service?"* A resposta curta é **não**, e este documento diz por quê, o que
já existe pronto, o que falta construir e o que só o Nicolas pode decidir.

## 1. Onde estamos hoje

Quem quer comprar e-mail hoje abre `mail.avilaops.com/criar-conta` e encontra uma
página que **explica o produto e manda para o WhatsApp**. Não há cadastro.

Isso é melhor do que era: até 31/08/2026 a mesma tela tinha um formulário que
repassava o pedido para `cliente.avilaops.com/api/register/request`. Esse host
foi apagado do servidor em 24/08 e nem resolve mais, então por uma semana quem
tentou comprar recebeu *"Cadastro indisponível no momento. Tente novamente em
instantes"*. Formulário quebrado é pior que formulário nenhum: promete e falha,
e ainda diz que a culpa é temporária.

A caixa nasce, hoje, pela ficha do cliente no `app.avilaops.com`, que dispara os
workflows `Ávila OS — *` no n8n. Funciona, mas **exige o Nicolas**.

## 2. O que já está pronto e é reaproveitável

Esta é a parte boa: a máquina existe quase inteira. O que falta é a porta.

| Peça | Onde | Estado |
|---|---|---|
| Criar domínio | `POST /v1/domains` | pronto |
| Guia de DNS (MX, SPF, DKIM, DMARC) | `dnsGuide()` em `provisioning.ts` | pronto, já devolve os 4 registros com explicação |
| **Verificar o DNS do domínio** | `POST /v1/domains/{d}/verify` | pronto: confere MX, SPF, DKIM e DMARC e **ativa o domínio sozinho** |
| Criar caixa | `POST /v1/mailboxes` | pronto, com senha e troca no primeiro acesso |
| DKIM por domínio | chave gerada na criação | pronto |
| Assinatura no Mercado Pago | `POST /v1/billing/accounts` + `initPoint` | pronto |
| Webhook de pagamento | `POST /v1/webhooks/mercadopago` | pronto, com HMAC conferido — testado em 31/08 |
| Suspender por inadimplência / reativar | `billing.ts` | pronto |
| Área do cliente | `app.avilaops.com/portal` | pronta, já mostra assinatura e faturas |
| Login do cliente | `app.avilaops.com/login` | pronto |

Em 31/08/2026 os quatro domínios de cliente passaram na verificação completa
(`mx:ok spf:ok dkim:ok dmarc:ok`), o que prova que o caminho automático funciona
de ponta a ponta.

## 3. O que falta

### 3.1 A tela de cadastro (não existe)

Mora no **`app.avilaops.com`**, não no webmail: o webmail é para quem já tem
caixa. O `cliente.avilaops.com` não volta.

O fluxo mínimo:

1. pessoa informa domínio e e-mail de contato;
2. tela mostra os 4 registros de DNS para copiar (a API já os gera);
3. botão "já configurei" chama a verificação;
4. verificado → checkout;
5. pago → provisiona domínio e primeira caixa.

### 3.2 Prova de posse do domínio (não existe como rota pública)

Sem isso, qualquer um cria caixa em domínio alheio.

O `verify` atual já é uma prova forte — só quem controla o DNS consegue apontar
o MX para nós. Mas hoje ele exige **token de administrador**. Falta uma versão
pública, e ela precisa de:

- limite de tentativas por IP e por domínio;
- recusa de domínio que já existe na base, com mensagem que não revele se ele é
  de outro cliente (senão vira sonda para descobrir quem é cliente);
- expiração do pedido não concluído.

### 3.3 Cobrar antes de provisionar

Hoje a ordem é criar e depois cobrar. No autoatendimento tem que ser o inverso,
senão qualquer um cria caixa de graça. O webhook já sabe receber a confirmação;
falta amarrar "assinatura autorizada" → "provisiona".

### 3.4 Limite de abuso

Caixa de e-mail é alvo clássico de quem quer enviar spam. Antes de abrir ao
público é preciso, no mínimo: teto de caixas por cadastro novo, cota de envio
reduzida nos primeiros dias, e bloqueio de domínio recém-registrado.

## 4. O ponto onde o autoatendimento costuma morrer

**O cliente não sabe mexer no DNS.** É aí que o funil trava, não no pagamento.

Duas saídas, e elas não se excluem:

- **Caminho fácil:** mover a zona para a nossa Cloudflare, que é o padrão da
  casa e já é o que fazemos à mão. Aí a configuração é nossa e o cliente não
  toca em DNS.
- **Caminho manual:** mostrar os 4 registros e verificar. Serve para quem tem
  agência ou TI própria.

Vale medir quantos desistem nessa etapa antes de investir em polimento.

## 5. Decisões que dependem do Nicolas

1. **Preço no autoatendimento.** Hoje a API assume R$ 10 por caixa/mês. Continua?
2. **Teste grátis?** Se sim, quantos dias e com qual limite de envio — período
   grátis sem limite é convite para spammer.
3. **Quem pode se cadastrar sozinho?** Qualquer um, ou só domínio que já é
   cliente da casa em outro serviço?
4. **Move a zona ou ensina o DNS?** Ver seção 4.
5. **Migração de e-mails antigos** entra no autoatendimento ou continua manual?
   Hoje é o argumento de venda mais forte da página, e é trabalho humano.

## 6. Ordem sugerida

Cada etapa entrega valor sozinha, e nenhuma depende da seguinte para servir.

1. **Cadastro com verificação de domínio** — a peça difícil já existe; é
   embrulhar `verify` numa rota pública com limite e numa tela.
2. **Checkout antes do provisionamento** — amarra o webhook, que já funciona.
3. **Provisionamento automático** — domínio, DKIM e primeira caixa.
4. **Migração assistida** — o que hoje é conversa de dez minutos.

## 7. O que este levantamento também revelou

Coisas encontradas ao conferir o terreno, já corrigidas em 31/08/2026:

- **Três domínios de cliente enviavam sem DKIM** (`cifrainssdeobras.com.br`,
  `comandeiro.com.br`, `saudepet.app.br`), dois deles com DMARC `p=reject` — ou
  seja, entrega recusada, não só spam. A chave existia no servidor desde a
  criação do domínio e nunca tinha ido para o DNS. Publicadas.
- **O `MP_BACK_URL`** devolvia quem acabou de pagar para o `cliente.avilaops.com`
  morto. Apontado para `app.avilaops.com/portal`.
- **O README dizia que o autoatendimento estava "Pronto"**, apontando para o
  mesmo host morto. Corrigido.

O padrão dos três é o mesmo: **coisa configurada pela metade que ninguém tinha
como perceber**. Vale um fluxo semanal no n8n conferindo SPF, DKIM e DMARC de
todos os domínios — o buraco do DKIM existia desde a criação e só apareceu
porque um e-mail caiu no spam e o Nicolas viu.

### Feito em 17/09/2026: a conferência agora roda sozinha

`src/services/conferenciaDeDns.ts`, pendurado na faxina diária
(`src/mta/maintenance.ts`).

Ficou **no mail e diário**, não semanal no n8n. Três razões:

- a faxina já é a única rotina da casa que roda todo dia sem depender de cron,
  então não entrou peça nova para manter nem mais um lugar onde a variável de
  ambiente pode faltar;
- a conferência de verdade (`verifyDomainDns`) mora aqui, com a chave privada
  para comparar contra o que está publicado. Do n8n dava para ver o CNAME, não
  para saber se ele aponta para a chave certa — que é exatamente o erro que
  passou batido;
- uma semana de entrega recusada é um cliente perdido, não um incidente.

O que ele faz, por domínio `active` ou `pending_dns`:

1. confere MX, SPF, DKIM e DMARC, e **lê o `p=` do DMARC** — porque DKIM
   quebrado com `p=none` é risco de spam e com `p=reject` é entrega recusada, e
   os dois não podem chegar com a mesma cara;
2. compara com a conferência anterior e registra na trilha do domínio o que
   quebrou (`dns.regrediu`) ou voltou (`dns.recuperado`);
3. avisa `MAIL_ADMIN_ADDRESSES` **quando algo muda**, e repete a cada 7 dias
   enquanto o problema continuar. Aviso diário sobre o mesmo domínio quebrado
   vira ruído, e ruído diário é ignorado — que é como o buraco do DKIM
   sobreviveu meses.

O aviso diz a consequência antes do registro: "NÃO está recebendo e-mail", não
"mx: false".

Duas exclusões, ambas contra alarme falso:

- **Domínio `disabled` não é varrido.** `verifyDomainDns` grava o status, e
  varrer um desativado o traria de volta para `pending_dns` sozinho — uma
  rotina de fundo desfazendo, de madrugada, uma decisão da operação.
- **Domínio `pending_dns` é conferido, mas não vira aviso.** É cliente no meio
  do cadastro, que ainda não publicou o DNS: está corretamente incompleto.
  Continua sendo conferido porque é assim que ele é ativado sozinho quando o
  DNS chega. Se contasse como problema, cada cadastro em andamento viraria
  alarme diário — e alarme falso todo dia é como um aviso de verdade passa
  despercebido, que é exatamente o que este arquivo existe para impedir.

O `npm run dkim:auditar` continua existindo para olhar de perto na hora.
