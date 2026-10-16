# Modelo de demanda

Use este roteiro para cadastrar uma tarefa real no registro de controle.

- Objetivo e problema observado.
- Escopo e arquivos/modulos afetados.
- Responsavel e revisor quando aplicavel.
- Prioridade: baixa, normal, alta ou urgente.
- Criterios de aceite verificaveis.
- Dependencias, impedimentos e proxima acao.
- Evidencias: teste, diff, commit, PR ou verificacao funcional.
- Ambiente comprovado: local, homologacao ou producao.

Estados: `a-fazer`, `em-andamento`, `em-revisao`, `bloqueada`, `concluida`.
Uma tarefa bloqueada exige motivo. Conclusao exige evidencia e criterios de aceite atendidos.
Para alteracoes de codigo, registre a revisao pertinente. Publicacao exige evidencia propria.
Nao use o arquivo para segredos, dados pessoais de clientes ou transcricoes privadas.
