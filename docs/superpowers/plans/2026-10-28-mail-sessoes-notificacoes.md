# Mail: sessões e notificações

**Objetivo:** concluir os seis módulos da auditoria de 28/10/2026 (AVL-361 a AVL-366).

**Execução:** neste checkout de desenvolvimento, com testes e builds exclusivamente no GitHub CI. Preservar alterações existentes. PR em rascunho enquanto a validação estiver incompleta; não promover merge/deploy sem autorização operacional.

**Arquitetura:** manter BFF Next e API Node/Prisma. Refresh HttpOnly disponível às páginas e ao BFF; rotação transacional com sucessor cifrado reapresentável durante uma janela curta de concorrência. TTL absoluto herdado da sessão inicial, contexto preservado e falhas transitórias sem logout. Demais módulos mantêm os serviços existentes e o isolamento de caixa.

**Especificação:** [auditoria no Linear](https://linear.app/avilaops/document/auditoria-mail-persistencia-contrato-auth-e-notificacoes-28102026-1bdaaf0508ae).

## Módulos e evidências

- [x] AVL-361 — cookies, navegação e recuperação. Testar navegador real em CI: acesso vencido com refresh válido, JSON, download e SSE; 502 preserva sessão. Arquivos: `webmail/src/lib/sessao.ts`, `api.ts`, proxy `/api/mail`, workflow e `webmail/tests/sessao.mjs`.
- [x] AVL-362 — rotação atômica e contexto. Testar PostgreSQL real: chamadas concorrentes retornam a mesma sucessora, replay tardio revoga, logout antigo não ressuscita sucessora, TTL não desliza, primeiro acesso/IP/UA preservados. Arquivos: `src/services/session.ts`, schema/migration e `src/scripts/integration.ts`.
- [ ] AVL-363 — contrato com Auth. Implementar vínculo de identidade, validação de política/MFA e revogação verificável com o contrato suportado pelo emissor. Não alterar o Auth ou ERP. Testar callback direto, conta revogada e logout global; documentar requisitos operacionais externos sem fingir que estão configurados.
- [ ] AVL-364 — preferências e ciclo do push. Unificar política e desligamento por aparelho/conta, incluindo logout; cobrir silêncio, alertas de segurança e falha parcial.
- [ ] AVL-365 — ativação e destino. Cruzar permissão, inscrição local, vínculo remoto e disponibilidade; teste de entrega; consumir deep link de mensagem e mantê-lo no login.
- [ ] AVL-366 — SSE. Cursor composto, recuperação de lacunas, resumo completo, indicação de desconexão e deduplicação entre canais/abas; testes de lote, empates e revogação.

## Critérios transversais

- HttpOnly/Secure/CSRF e isolamento entre caixas continuam obrigatórios.
- Nunca imprimir cookies, tokens ou credenciais em logs de teste.
- Falhas de rede não se tornam 401; revogação continua definitiva.
- Compatibilidade com cookies antigos exige migração explícita de Path.
- Evidência RED/GREEN e suíte completa vem de Actions, sem executar aplicação localmente.
- Revisão independente do diff antes de declarar cada entrega concluída.

## Registro de execução

- 28/10/2026: branch `codex/mail-sessoes-notificacoes` criada a partir de `163fb906`; exclusão preexistente de `CLAUDE.md` preservada e fora dos commits.
- Decisão: janela de concorrência de 10 segundos apenas para sessão comprovadamente rotacionada; sessão revogada por logout nunca é renovável. A sessão sucessora herda a expiração absoluta original.
- AVL-361/362 implementados e em revisão no PR #12. RED original: Actions 40642302631; RED da revisão: 40642995280. GREEN completo: Actions 40644670238, SHA 56f7730906f541177503148ffd1f099cebc4893d (PostgreSQL, Chromium/HTTPS/CSP, lint, tipagem e imagens). Sem merge/deploy.
- Revisão independente: corrigidos ancestral reapresentado após logout global e migração em aba já aberta, com testes RED/GREEN. O teste do cliente real também cobre mutação repetida uma vez com CSRF preservado e o ciclo do primeiro acesso.
- Próximo: AVL-363. O Auth atual oferece authorization code + PKCE, refresh e logout assinado RS256. `/api/session?app=mail` informa `permitido`, mas não informa exigência atual de MFA; usar somente esse endpoint não resolve o contrato. O cadastro OIDC do emissor exige cliente e segredo no painel. Não presumir credenciais/configuração de produção nem alterar o Auth.
- AVL-363 implementou vínculo, gate real de política/MFA, prazo limitado ao emissor, backchannel/SSF e reautenticação de sessões legadas. Permanece incompleto: o Auth captura o corte na assinatura assíncrona, podendo revogar uma sessão posterior. Proposta concreta em `docs/contrato-auth-mail-ordenacao.md`; ampliação ao Auth aguarda resposta do usuário. Nenhum arquivo do emissor foi alterado.
- AVL-364/365: autorização por família, filtros de entrega, estados verdadeiros de inscrição, chave VAPID e destino de mensagem implementados. RED: 40654022842/40654227556 (ciclo/preferências) e 40655413700 (deep link). Revisões corrigiram filtro aplicado à consulta errada e chave VAPID antiga ainda exibida como ativa.
- VAPID operacional verificada somente por leitura: pares válidos, iguais entre processos API/MTA, contato igual; nenhuma chave impressa ou alterada. Registro detalhado em `docs/contrato-notificacoes-mail.md`.
- AVL-366: substituí cursor por Date por caixa/seq atribuída no commit da entrega. `receivedAt` vem do header remoto e não ordena chegada nem commits. DTO compartilhado, retomada, reconciliação e deduplicação no worker implementados; RED 40656746688 confirmou DTO/cursor ausentes.
- Actions 40658609350 (cff12e9) passou verify e session-browser, incluindo PostgreSQL, lote com empates e queda, prazo SSE com consulta pendente, worker/IndexedDB e abas concorrentes. Imagens pendentes na última consulta; ainda sem merge/deploy.
- Reaberto AVL-364 para cobrir falha de logout remoto: BFF apagava cookies e cliente continuava mesmo quando a revogação falhava. RED 40659079888 (c51b8c9) confirmou 200 indevido no lugar de 503. BFF e cliente agora exigem sucesso da revogação; o botão exibe falha e permite repetir. GREEN do HEAD final pendente.
