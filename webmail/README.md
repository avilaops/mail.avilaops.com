# Webmail: mail.avilaops.com

Interface do servidor de e-mail próprio. Next.js 16 + React 19 + Tailwind 4,
falando com a API em `127.0.0.1:3040` através de uma camada BFF.

Plano e levantamento: [`docs/produtos/MAIL-WEBMAIL-PLANO.md`](../../docs/produtos/MAIL-WEBMAIL-PLANO.md)

---

## Ondas 1, 2 e 3: prontas

| Recurso | Estado |
|---|---|
| Login | ✅ |
| Três colunas: pastas · lista · leitura | ✅ |
| Leitura em iframe isolado, com selo de remetente verificado | ✅ |
| Bloqueio de rastreador com liberação em um clique | ✅ |
| Busca com pausa de digitação, rolagem paginada | ✅ |
| Marcar lida, marcar tudo lido, spam, apagar | ✅ |
| Medidor de espaço, sair | ✅ |
| Composição com Cc/Cco e "enviar como" | ✅ |
| Resposta com citação e threading | ✅ |
| Anexos com barra de progresso e cancelamento | ✅ |
| Autocompletar destinatário pelo histórico | ✅ |
| Rascunho salvo sozinho a cada 4 s | ✅ |
| Conta: perfil, assinatura, ausência, preferências, aparelhos | ✅ |
| Pastas próprias: criar, renomear, excluir | ✅ |
| Recuperação de senha por e-mail alternativo | ✅ |
| Aviso de mensagem nova em tempo real (SSE) | ✅ |
| Mover mensagem para pasta própria (avulsa e em lote) | ✅ |
| Retomar rascunho no compositor | ✅ |
| Favoritar pela lista e pelo leitor | ✅ |
| Encaminhar e responder a todos | ✅ |
| Seleção múltipla com ações em lote | ✅ |
| Layout responsivo (celular navega em pilha) | ✅ |
| Editor rico: negrito, itálico, link, listas | ✅ |
| Visão de conversa no leitor | ✅ |
| Recorte da lista: todas, não lidas, favoritas | ✅ |
| Atualizar sem recarregar a página | ✅ |
| Esvaziar a lixeira | ✅ |
| Baixar o `.eml` original | ✅ |
| Link clicável em mensagem de texto puro | ✅ |
| Arquivar (pasta de sistema Arquivo) | ✅ |
| Desfazer envio (janela de 15 s) | ✅ |
| Adiar mensagem (pasta Adiadas, volta sozinha) | ✅ |
| Atalhos de teclado com tela de ajuda (`?`) | ✅ |

### Onda 4: o que a API já servia e a tela não usava

Auditoria de 31/08/2026 comparando as rotas do `README.md` da API com o que o
webmail chama. Quatro estavam implementadas, testadas e sem porta na interface:
`unread=true`, `flagged=true`, `POST /me/trash/empty` e `GET /messages/{id}/raw`.
Todas entraram nesta onda.

Em 07/10/2026 a lista ganhou os recortes **Arquivos**, **Imagens** e **PDFs**
(`attachment=any|image|pdf` em `GET /me/messages`), e a busca passou a achar
também pelo nome do anexo.

Em 08/10/2026 o leitor foi arrumado: a barra de ações cabe numa linha (o que se
usa pouco foi para o menu "⋯"), o corpo do e-mail fica num cartão, imagem
bloqueada não deixa mais um retângulo vazio e os três recortes de anexo viraram
o menu **Anexos**. Na mesma leva, "Exibir imagens" passou a funcionar: a CSP da
página barrava toda imagem externa dentro do corpo (ver `src/middleware.ts`).

O padrão vale para a próxima: antes de escrever recurso novo, conferir o que o
servidor já entrega. Recurso pronto sem porta na tela é trabalho já pago que não
rende nada.

### Decisões da composição

- **O compositor é painel ancorado, não modal de tela cheia.** Escrever e-mail
  quase sempre exige consultar outra mensagem no meio; modal que cobre tudo
  obriga a fechar, e perder o texto, para conferir um detalhe.
- **O anexo sobe antes da mensagem.** Cada arquivo tem seu próprio progresso, dá
  para cancelar um sem perder o texto, e o "enviar" no fim é instantâneo. Usa
  `XMLHttpRequest` porque `fetch` não reporta progresso de upload.
- **A resposta não preenche o assunto.** Quem monta o `Re:` é o servidor, a
  partir da original; preencher aqui geraria `Re: Re:` na ida e volta.
- **Endereço digitado e não confirmado com Enter entra no `blur`.** Sem isso ele
  some ao clicar em "Enviar", e o cliente descobre pelo erro.

### Decisões da conta e do tempo real

- **Cada bloco da tela de conta salva sozinho.** Um "Salvar" único no rodapé
  pareceria mais limpo e faria quem só queria desligar a resposta automática
  rolar a página inteira até achar o botão.
- **Excluir pasta pede confirmação e avisa que as mensagens sobrevivem.** O medo
  de perder correspondência é o que faz o cliente nunca organizar nada.
- **O SSE só injeta mensagem na lista se a Entrada estiver aberta sem busca.**
  Empurrar mensagem nova no meio de um resultado de busca bagunçaria o que o
  cliente estava lendo.
- **`/recuperar` e `/redefinir` são as únicas rotas do proxy sem CSRF.** Não há
  sessão para sequestrar antes do login; o abuso é contido pelo limite de 3
  pedidos por hora no servidor. Login, refresh e logout continuam fora do proxy,
  em `/api/sessao`.

## Rodar

```bash
cp .env.example .env.local     # aponta MAIL_API_URL para a API
npm install
npm run dev                    # http://localhost:3041
```

Para ver com conteúdo de verdade, semeie o banco pelo projeto da API:

```bash
cd ..
MAIL_DATABASE_URL=... npx tsx src/scripts/seed-dev.ts
```

---

## Como a sessão funciona

```
Navegador  ──cookie httpOnly──▶  Next (BFF)  ──Bearer──▶  API do e-mail
```

O token **nunca** chega ao JavaScript da página. Ele entra em cookie `httpOnly`
e é injetado no servidor, em `src/lib/api.ts`.

| Cookie | httpOnly | Escopo | Papel |
|---|---|---|---|
| `avila_mail_at` | sim | `/` | Token de acesso, 15 min |
| `avila_mail_rt` | sim | `/api/sessao` | Refresh, 30 dias, só trafega na rota que o usa |
| `avila_mail_csrf` | **não** | `/` | Metade do duplo envio; a página copia para o header |

Todos com `SameSite=Strict` e `Secure` (desligue com `COOKIE_SECURE=false`
apenas em desenvolvimento sobre HTTP).

### Por que assim

Webmail renderiza HTML de terceiros por definição. Se um vetor de XSS escapar
da sanitização do servidor, token em `localStorage` é lido por `document` e a
conta inteira vai junto. Em cookie `httpOnly`, o script não alcança o valor.

O preço é precisar de proteção CSRF, resolvida com duplo envio: uma página de
outro site consegue fazer o navegador mandar o cookie, mas não consegue **ler**
o valor para montar o header.

---

## Camadas contra XSS

1. **Sanitização no servidor** (`src/lib/sanitize.ts` da API), 23 vetores testados
2. **`<iframe sandbox>` sem `allow-scripts` nem `allow-same-origin`**, origem opaca:
   mesmo que algo executasse lá dentro, não alcançaria o cookie nem o DOM
3. **CSP do documento do iframe**, `default-src 'none'`, sem `script-src`
4. **CSP da página com nonce por requisição** (`src/middleware.ts`)

### A CSP precisa de renderização dinâmica

`/entrar` e `/caixa` exportam `dynamic = "force-dynamic"`. Não é preferência: o
nonce muda a cada resposta, e página pré-renderizada no build tem HTML fixo
não há onde carimbá-lo. Sem isso o navegador bloqueia os scripts do Next, a
página não hidrata e o formulário de login faz submit nativo, sem passar pelo
BFF. **Esse bug passa no `next build` e só aparece abrindo a tela num
navegador.**

---

## Proxy `/api/mail/*`

Único caminho da página até a API. Concentra três defesas:

- **CSRF** verificado em todo método que altera estado
- **Lista de rotas permitidas**: só `me/*` e `auth/*`. Provisionamento e
  faturamento respondem 404 aqui, mesmo que a API os exponha
- **Download passa cru**: anexo e `.eml` mantêm `Content-Disposition: attachment`
  e `nosniff`. Reserializar como JSON corromperia o arquivo e derrubaria
  justamente os cabeçalhos que impedem um anexo HTML de executar na nossa origem

---

## Verificado

```
next build .............. 5 rotas
tsc --noEmit ............ exit 0
CSP com nonce ........... script-src 'self' 'nonce-…' 'strict-dynamic'
CSRF sem token .......... 403 em POST, PATCH e DELETE
Proxy allowlist ......... 404 em domains, mailboxes, billing, ops
Sem sessão .............. 401
Cookies ................. httpOnly + SameSite=Strict nos dois tokens
Erros de console ........ nenhum
```

Fluxo completo no navegador (Playwright contra o servidor real):

```text
login → lista → leitura → rastreador bloqueado
escrever → autocompletar do histórico → anexar → enviar
cópia em Enviados com o anexo · anexo pendente consumido · rascunho descartado
responder → destinatário preenchido → original citado
criar pasta própria → aparece na barra lateral → mover mensagem → ela está lá
conta → perfil salvo · assinatura sanitizada · ausência ligada · aparelho listado
recuperar senha → destino mascarado (do**@empresa.com.br) → token gerado
mensagem entregue por fora → aviso em tempo real → entra na lista sem recarregar
favoritar pela lista · encaminhar com cabeçalho · responder a todos sem se incluir
selecionar 2 → ação em lote · rascunho reabre no compositor com o texto salvo
```

Acabamento:

```text
atalhos j / ? / r funcionam · digitar no editor não dispara atalho
negrito e link aplicados · Ctrl+Enter envia
MIME enviado: multipart/alternative com text/plain E text/html, assinado
conversa agrupa resposta e original (1 thread, 2 mensagens)
```

Sem estouro horizontal em seis larguras, a menor é o caso difícil:

```text
iPhone SE           375px   lista:ok  leitura:ok  composição:ok
iPhone 17 (aprox.)  402px   lista:ok  leitura:ok  composição:ok
tablet retrato      768px   lista:ok  leitura:ok  composição:ok
tablet paisagem    1024px   lista:ok  leitura:ok  composição:ok
notebook           1280px   lista:ok  leitura:ok  composição:ok
monitor            1920px   lista:ok  leitura:ok  composição:ok
```

No celular: lista some durante a leitura, botão voltar, menu de pastas por cima,
compositor em tela cheia.

Conferido no banco: mensagem na fila com o envelope certo,
`mail_pending_attachments` zerado, nenhum rascunho órfão, `<script>` removido da
assinatura, pasta criada com `kind='custom'` e o e-mail de redefinição
enfileirado para o endereço de recuperação.

Capturas em `artifacts/`.

## Publicar no servidor

Não há script: o build é local (o VPS não tem RAM para compilar) e vai por
`tar` sobre SSH. O serviço é `avila-webmail.service`, em `/opt/avila-webmail`,
rodando `node server.js` na porta 3041 como `avilamail`.

```bash
npm run build                                   # gera .next/standalone
S="ssh -i ~/.ssh/hetzner_avilaops root@178.105.82.48"
tar -C .next/standalone --exclude=node_modules -cf - . | $S 'tar -C /opt/avila-webmail -xf -'
tar -C .next -cf - static                          | $S 'tar -C /opt/avila-webmail/.next -xf -'
tar -cf - public                                   | $S 'tar -C /opt/avila-webmail -xf -'
$S 'chown -R avilamail:avilamail /opt/avila-webmail && systemctl restart avila-webmail'
```

`node_modules` só precisa subir quando a versão do Next muda: o standalone
carrega uma cópia enxuta, e reenviar a cada deploy custa minutos por nada.
Confira com `cat /opt/avila-webmail/.next/BUILD_ID` que bate com o local.
