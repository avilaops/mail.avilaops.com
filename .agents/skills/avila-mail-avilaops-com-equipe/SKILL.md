---
name: avila-mail-avilaops-com-equipe
description: Coordene a equipe desta aplicacao quando o usuario pedir distribuicao de tarefas, acompanhamento, impedimentos, revisao ou passagem de trabalho.
---

# Coordenar a equipe da aplicacao

1. Confirme que a raiz do checkout corresponde a `avila-mail-avilaops-com`; leia AGENTS.md e `.agents/equipe/README.md`.
2. Leia `.agents/equipe/CONTEXTO.md` e `.agents/equipe/controle.json`. Consulte o codigo e os manifestos quando o pedido depender de fatos tecnicos.
3. Use apenas membros cadastrados. Se faltar a identidade de quem deve receber uma demanda, mantenha-a sem atribuicao no relato e solicite o dado antes de cadastrar a tarefa.
4. Registre tarefas reais com objetivo, responsavel, prioridade e criterios de aceite. Preserve IDs, historico e alteracoes de outros colaboradores.
5. Ao atualizar status, registre motivo de bloqueio ou evidencia de conclusao. Uma implementacao local nao comprova publicacao em producao.
6. Registre decisoes com justificativa e evidencia. Integrações precisam de ambiente, identidade nao secreta e verificacao real de acesso.
7. Apresente tarefas por estado, responsaveis, bloqueios e proxima acao. Diga quando o registro esta vazio ou desatualizado.

Use o CLI `scripts/equipe.py` da central quando estiver acessivel; em outro host, atualize o mesmo JSON preservando seu formato.
Nao inicie outros agentes nem envie mensagens em nome da equipe sem autorizacao do usuario.
Este workflow organiza registros; nao instala conectores, nao concede acesso e nao comprova conclusao por conta propria.
