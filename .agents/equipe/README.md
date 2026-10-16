# Controle da equipe

Este diretorio e o registro compartilhado de trabalho de `avila-mail-avilaops-com`.

## Rotina

1. Leia o AGENTS.md da raiz, o contexto e o registro de controle.
2. Cadastre as pessoas reais da equipe antes de atribuir tarefas.
3. Registre cada demanda com objetivo, responsavel e criterios de aceite.
4. Atualize o estado ao iniciar, bloquear, enviar para revisao ou concluir.
5. Para concluir, registre a evidencia da verificacao e a revisao pertinente.
6. Registre decisoes e integracoes verificadas; indique ambiente e identidade sem segredos.

## Arquivos

- [Contexto](CONTEXTO.md): fontes de informacao e comandos encontrados no projeto.
- [Registro](controle.json): pessoas, tarefas, decisoes e integracoes.
- [Modelo de demanda](MODELO-DE-DEMANDA.md): contrato de entrega e passagem entre pessoas.

O arquivo inicia vazio porque nao foram informados membros nem demandas concretas.
Esta estrutura coordena pessoas e agentes; nao delega trabalho ou envia mensagens automaticamente.
Versione os registros junto ao projeto. Em conflitos, preserve os IDs e reconcilie as evidencias.

## Atualizar com a ferramenta central

A partir de `D:/Projetos/central-integracoes/desenvolvimento`:

```powershell
python scripts/equipe.py membro avila-mail-avilaops-com --id pessoa --nome 'Nome real' --papel 'Desenvolvimento'
python scripts/equipe.py tarefa avila-mail-avilaops-com --titulo 'Demanda concreta' --responsavel pessoa --aceite 'Resultado verificavel'
python scripts/equipe.py estado avila-mail-avilaops-com --id T-0001 --status em-andamento
python scripts/equipe.py painel
```

Os comandos sao exemplos de uso e nao representam cadastros realizados.
O CLI roda na maquina com o catalogo; os JSONs e instrucoes podem ser usados em outros checkouts.
As alteracoes sao locais ate serem commitadas e compartilhadas pelo fluxo normal do repositorio.
