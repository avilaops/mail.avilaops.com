# Configurar a agenda no celular

Use o endereço completo da caixa e a mesma senha do e-mail. O servidor é `https://mail.avilaops.com/dav/`.

## iPhone e iPad

1. Abra Ajustes → Apps → Calendário → Contas.
2. Toque em Adicionar Conta → Outra → Adicionar Conta CalDAV.
3. Informe o servidor, o e-mail completo e a senha.
4. Salve e habilite Calendários.

## Android

1. Instale o DAVx⁵.
2. Escolha login com URL e usuário.
3. Informe o servidor, o e-mail completo e a senha.
4. Selecione as agendas que deseja sincronizar.

## Thunderbird

Crie um calendário “Na rede”, escolha CalDAV e informe `https://mail.avilaops.com/dav/calendars/SEU_EMAIL/agenda/`.

Cada agenda criada no webmail aparece como uma coleção separada. Alterações feitas no celular usam ETag e sincronização incremental para evitar sobrescrever edições concorrentes.
