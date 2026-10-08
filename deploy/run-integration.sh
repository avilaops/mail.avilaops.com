#!/usr/bin/env bash
#
# Roda o teste de integracao contra um PostgreSQL descartavel em container.
#
#   bash deploy/run-integration.sh
#
# Nao encosta em nenhum banco existente: sobe container proprio na porta 55432,
# aplica as migracoes do zero e derruba tudo no final, inclusive se falhar.
#
set -euo pipefail

CONTAINER="avila-mail-test"
PORTA="55432"
export MAIL_DATABASE_URL="postgresql://teste:teste@127.0.0.1:${PORTA}/avila_mail_test?schema=public"

cleanup() {
	docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

cleanup

echo "==> Subindo PostgreSQL descartavel na porta ${PORTA}"
docker run -d --name "$CONTAINER" \
	-e POSTGRES_PASSWORD=teste \
	-e POSTGRES_USER=teste \
	-e POSTGRES_DB=avila_mail_test \
	-p "${PORTA}:5432" \
	postgres:16-alpine >/dev/null

for _ in $(seq 1 30); do
	docker exec "$CONTAINER" pg_isready -U teste >/dev/null 2>&1 && break
	sleep 1
done

echo "==> Aplicando migracoes"
npx prisma migrate deploy

echo "==> Teste de unidade (sem banco)"
npx tsx src/scripts/smoke.ts

echo "==> Sondagem de seguranca (injecao, XSS, token)"
npx tsx src/scripts/security-probe.ts

# O teste de migracao usa o nosso proprio IMAP como "provedor antigo", e o
# cliente IMAP recusa certificado desconhecido — como deve ser. Por isso o
# certificado nasce AQUI, antes do Node subir: NODE_EXTRA_CA_CERTS so e lido na
# partida do processo, entao gerar la dentro seria tarde demais.
CERT=$(node deploy/gerar-cert-teste.cjs)
export MAIL_TESTE_CERT="$(echo "$CERT" | sed -n 1p)"
export MAIL_TESTE_KEY="$(echo "$CERT" | sed -n 2p)"
export NODE_EXTRA_CA_CERTS="$MAIL_TESTE_CERT"

echo "==> Teste de integracao (com banco)"
npx tsx src/scripts/integration.ts
