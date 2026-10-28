# Mail: sessões e notificações

**Objetivo:** concluir os seis módulos da auditoria de 28/10/2026 (AVL-361 a AVL-366).

**Execução:** neste checkout de desenvolvimento, com testes e builds exclusivamente no GitHub CI. Preservar alterações existentes. PR em rascunho enquanto a validação estiver incompleta; não promover merge/deploy sem autorização operacional.

**Arquitetura:** manter BFF Next e API Node/Prisma. Refresh HttpOnly disponível às páginas e ao BFF; rotação transacional com sucessor cifrado reapresentável durante uma janela curta de concorrência. TTL absoluto herdado da sessão inicial, contexto preservado e falhas transitórias sem logout. Demais módulos mantêm os serviços existentes e o isolamento de caixa.

**Especificação:** [auditoria no Linear](https://linear.app/avilaops/document/auditoria-mail-persistencia-contrato-auth-e-notificacoes-28102026-1bdaaf0508ae).

## Módulos e evidências

- [ ] AVL-361 — cookies, navegação e recuperação. Testar navegador real em CI: acesso vencido com refresh válido, JSON, download e SSE; 502 preserva sessão. Arquivos: `webmail/src/lib/sessao.ts`, `api.ts`, proxy `/api/mail`, workflow e `webmail/tests/sessao.mjs`.
- [ ] AVL-362 — rotação atômica e contexto. Testar PostgreSQL real: chamadas concorrentes retornam a mesma sucessora, replay tardio revoga, logout antigo não ressuscita sucessora, TTL não desliza, primeiro acesso/IP/UA preservados. Arquivos: `src/services/session.ts`, schema/migration e `src/scripts/integration.ts`.
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
