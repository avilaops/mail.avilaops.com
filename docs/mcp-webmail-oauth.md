# MCP do Webmail

O Mail expõe um servidor MCP via `https://mail.avilaops.com/mcp`.

## Autenticação

O endpoint aceita somente access tokens OAuth 2.0 emitidos por:

```text
https://auth.avilaops.com
```

O recurso protegido publica:

```text
https://mail.avilaops.com/.well-known/oauth-protected-resource
```

O cliente OAuth precisa ser cadastrado no painel do Auth como integração OIDC do aplicativo `mail`, com:

- redirect URI exato fornecido pelo cliente MCP;
- `https://mail.avilaops.com/mcp` como recurso protegido;
- PKCE com `S256` quando o cliente suportar;
- escopos `openid profile email`, além de `offline_access` se o cliente precisar renovar a sessão.

O `client_secret` fica somente no cliente OAuth e no Auth. Não deve ser colocado no repositório, no Caddyfile ou no serviço Mail.

O Mail consulta `/oauth/userinfo` para validar o access token e só permite a operação quando o claim `apps` contém `mail`. A caixa é resolvida pelo endereço da conta autenticada. Se houver mais de uma caixa, cada chamada deve informar `address`.

## Protocolo

O endpoint usa JSON-RPC 2.0 sobre `POST /mcp` e implementa:

- `initialize`;
- `notifications/initialized`;
- `tools/list`;
- `tools/call`.

As ferramentas incluem:

- pastas, listagem, busca, leitura e anexos;
- flags, movimentação, exclusão e lixeira;
- criação, renomeação e exclusão de pastas;
- envio e rascunhos, com `idempotencyKey` obrigatório no envio;
- contatos e endereços autorizados para envio;
- agendas, eventos, recorrência e respostas a convites.

Todas as operações recebem o `mailboxId` somente do servidor. IDs de mensagens, anexos, pastas, agendas e eventos são sempre filtrados pela caixa autenticada.

## Publicação

O Caddy deve encaminhar estes caminhos para `127.0.0.1:3042`:

```text
/.well-known/oauth-protected-resource
/mcp
```

Depois do deploy, validar sem enviar mensagem:

```bash
curl -i https://mail.avilaops.com/.well-known/oauth-protected-resource
curl -i -X POST https://mail.avilaops.com/mcp \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'
```

O segundo comando deve responder `401` porque não há Bearer OAuth. A validação autenticada deve usar `tools/list` e uma ferramenta de leitura. A validação de `send_message` exige autorização operacional separada e não deve usar destinatário real durante smoke test.
