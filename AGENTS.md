# Instruções para o Claude neste repositório

Servidor de e-mail próprio da Ávila Ops: MTA, API e webmail. Não é revenda —
o SMTP, o IMAP, o POP3 e a entrega são nossos.

## Fluxo Git — obrigatório

Regra do Nicolas de 05/10/2026, que vale acima do fluxo antigo de branch e PR:
**toda alteração é commitada e enviada para a `main` na mesma tarefa.**

1. `git pull --rebase origin main`;
2. implementar e rodar os testes (ver **Como validar**);
3. `git commit` e `git push origin main`;
4. se o GitHub recusar o push direto, abrir o PR e mesclar em seguida, sem
   deixar aberto.

Nunca `push --force` na `main` e nunca commitar segredo.

A `main` é implantada em produção a cada push. Depois de mesclar, acompanhe o
run de deploy até o fim: mesclar e não conferir o deploy é deixar o trabalho
pela metade.

## Como validar

O CI roda `npm ci`, `npx prisma generate` e `npm test`. Rode o mesmo antes de
abrir PR.

```bash
npm run typecheck          # tsc --noEmit
npm test                   # sobe PostgreSQL descartável e roda tudo
```

`npm test` chama `deploy/run-integration.sh`, que precisa de Docker. Sem Docker,
dá para subir um PostgreSQL local e rodar as três suítes na mão:

```bash
export MAIL_DATABASE_URL="postgresql://…/avila_mail_test?schema=public"
npx prisma migrate deploy
npx tsx src/scripts/smoke.ts          # unidade, sem banco e sem rede
npx tsx src/scripts/security-probe.ts # injeção, XSS, token
npx tsx src/scripts/integration.ts    # precisa do banco
```

Não existe framework de teste: as suítes são scripts com um `check(rótulo,
condição)`. Teste novo entra como seção numerada no script que couber —
`smoke.ts` para regra pura, `integration.ts` para o que toca o banco.

### Webmail

`webmail/` é um projeto Next.js separado, com `package-lock.json` próprio (npm,
não pnpm — o `pnpm-workspace.yaml` da raiz não o inclui).

```bash
cd webmail && npm ci && npm run typecheck && npm run build
```

`npm run lint` está quebrado: o pacote não tem `eslint.config.js`. É anterior a
qualquer trabalho recente e o CI não o executa.

**Mudança de interface se confere no navegador.** Build e typecheck passam com a
tela quebrada — já aconteceu duas vezes aqui, as duas por CSP. Suba
`npx next start` e abra com o Chromium de `/opt/pw-browsers/chromium`, olhando:
erro no console, estouro horizontal (`scrollWidth - clientWidth`) e os dois
temas.

## Armadilhas conhecidas

- **CSP com nonce por requisição** (`webmail/src/middleware.ts`). Toda página é
  `force-dynamic` por causa disso: página pré-renderizada tem HTML fixo e não há
  onde carimbar o nonce. `<script>` escrito à mão precisa de `nonce={nonce}`
  explícito — o Next só carimba os que ele mesmo injeta.
- **`--color-fundo-suave` e `--color-superficie` têm o mesmo valor no tema
  escuro** (`#161a20`). Elemento com um por fundo e outro por cima some à noite.
  Para marcador de conteúdo use `--color-borda` ou `--color-texto-fraco`.
- **O webmail inteiro é `noindex`**, de propósito. A exceção é `/`, a porta da
  rua.
- **`verifyDomainDns` grava o status do domínio.** Chamá-la num domínio
  `disabled` o traz de volta para `pending_dns` sozinho.

## Convenções

- Tudo em português: código, comentários, commits e PR.
- Commit explica **por que**, com a consequência concreta do bug — não só o que
  mudou. Veja o histórico.
- Não afirme na interface o que o serviço não faz. A tabela do README é a fonte
  do que existe; se ela estiver desatualizada, atualize junto.
- Nada de fonte do Google, script de CDN ou pixel de rastreio no webmail: a CSP
  é `default-src 'self'` e não há motivo para abrir exceção.

<!-- avilaops:contexto:inicio (versão 2026-10-03; gerado a partir de avilaops/contexto, não editar aqui) -->
## Contexto Ávila Ops (vale para todos os projetos)

Este repositório pertence à Ávila Ops Tecnologia, que ajuda pequenas empresas a construir presença digital, organizar a operação e crescer. As contas `avilaops` e `avilainc` no GitHub são a mesma empresa. Nicolas Avila (Nicolas sem acento) é o fundador e quem decide.

### Como trabalhar

- Comunicar em português natural, com resposta direta e evidência. Sem tom de coach, promessa vaga ou jargão comercial. O idioma da interface e do conteúdo acompanha o site, não a conversa.
- Identificar o projeto, o domínio, o repositório e o ambiente antes de alterar qualquer coisa. Não presumir que todos os projetos usam o mesmo deploy.
- Ter iniciativa dentro do pedido e levar a tarefa até um resultado verificado. Plano, código, publicação e funcionamento comprovado são coisas diferentes: não declarar sucesso só porque um build terminou ou um workflow foi ativado.
- Proteger dados, acessos e a separação entre clientes. Nunca gravar segredo em arquivo versionado, issue, PR ou memória.
- Não iniciar comunicação externa nem ação irreversível sem autorização do Nicolas.
- Preservar trabalho em andamento de outra pessoa ou de outro agente. Trabalho não commitado vai para uma branch `resgate/*`.

### Decisões vigentes

- Pagamentos: Mercado Pago no Brasil e PayPal para clientes de fora. Não usar Stripe nem Éfi, mesmo que material antigo diga o contrário.
- Automações em n8n, infraestrutura em Cloudflare e canais em Twilio, preservando integrações existentes.
- Ofertas com três planos: entrada limitada, intermediário como escolha principal e premium como referência. Consultar preços vigentes antes de publicar.
- Build de aplicação roda no GitHub Actions, não no servidor de produção.
- Versão antiga de código fica no GitHub. Não criar `.tgz`, `.tar`, `*-before-*` nem pastas `rollback/`, `releases/` ou `backups/` com código no servidor; voltar versão é republicar o commit. Antes de mexer em dado, fazer dump do banco.

### Sessões na nuvem

- Uma sessão de nuvem não tem acesso à máquina do Nicolas, aos servidores nem à memória compartilhada. Não presumir o estado de produção: buscar evidência ou dizer que não foi verificado.
- Decisão durável tomada na sessão deve ficar registrada na descrição do PR e, quando for do projeto, neste arquivo, fora deste bloco.
- A memória compartilhada completa e as regras corporativas ficam no repositório privado `avilaops/contexto`.
<!-- avilaops:contexto:fim -->
