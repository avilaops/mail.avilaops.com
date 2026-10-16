# Contexto verificavel

- Identificador: `avila-mail-avilaops-com`.
- Origem: raiz deste checkout; nao depende de um caminho absoluto.
- Fontes encontradas: `README.md`, `package.json`, `AGENTS.md`.
- Gerenciador declarado: nao declarado no package.json; conferir lockfile e regras locais.

## Estrutura observada

- `app/`
- `deploy/`
- `docs/`
- `prisma/`
- `src/`
- `webmail/`

## Scripts de verificacao declarados

- `typecheck`: `tsc -p tsconfig.json --noEmit`
- `test:smoke`: `tsx src/scripts/smoke.ts`
- `test:security`: `tsx src/scripts/security-probe.ts`
- `test:integration`: `tsx src/scripts/integration.ts`
- `test`: `bash deploy/run-integration.sh`

Esta lista e um retrato de 15/10/2026, nao uma prova de que os comandos passaram.
Confirme os comandos e seus efeitos antes de executa-los. Alguns testes dependem de servicos externos.
Nao execute deploy, migracao ou envio como parte de uma consulta de status.
