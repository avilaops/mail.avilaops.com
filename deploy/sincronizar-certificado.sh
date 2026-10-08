#!/usr/bin/env bash
#
# Copia o certificado que o Caddy renova para onde o MTA le.
#
# O Caddy ja cuida da emissao e da renovacao (ACME, ~30 dias antes de vencer),
# mas guarda tudo em /var/lib/caddy com permissao 600 caddy:caddy — o usuario
# do MTA nao le. Sem esta ponte, a copia em /etc/avila-mail/tls congela no dia
# em que foi feita a mao e vence em producao.
#
# Roda pelo timer avila-mail-cert-sync.timer (diario). So mexe nos arquivos
# quando o conteudo muda; o MTA percebe a troca sozinho, pelo mtime, sem
# reiniciar (ver src/mta/tls.ts).
#
#   bash /opt/avila-mail/deploy/sincronizar-certificado.sh
set -euo pipefail

DESTINO_DIR="/etc/avila-mail/tls"
CADDY_DIR="/var/lib/caddy/.local/share/caddy/certificates"
HOSTNAME_MAIL="$(grep -E '^MAIL_HOSTNAME=' /opt/avila-mail/.env.production | cut -d= -f2- | tr -d '"'"'"'\r' || true)"
HOSTNAME_MAIL="${HOSTNAME_MAIL:-mail.avilaops.com}"

origem_cert="$(find "$CADDY_DIR" -type f -name "${HOSTNAME_MAIL}.crt" 2>/dev/null | head -1 || true)"
origem_key="$(find "$CADDY_DIR" -type f -name "${HOSTNAME_MAIL}.key" 2>/dev/null | head -1 || true)"

if [[ -z "$origem_cert" || -z "$origem_key" ]]; then
	echo "certificado de ${HOSTNAME_MAIL} nao encontrado no Caddy; nada a fazer"
	exit 0
fi

# Certificado vencido ou prestes a vencer no proprio Caddy e problema DELE:
# avisar aqui evita que a sincronia mascare uma renovacao que nao aconteceu.
fim="$(openssl x509 -in "$origem_cert" -noout -enddate | cut -d= -f2)"
if ! openssl x509 -in "$origem_cert" -noout -checkend $((15 * 86400)) >/dev/null; then
	echo "ATENCAO: o certificado do Caddy vence em menos de 15 dias ($fim) — a renovacao automatica pode estar falhando" >&2
fi

mkdir -p "$DESTINO_DIR"

mudou=0
for par in "cert:$origem_cert:fullchain.pem" "key:$origem_key:privkey.pem"; do
	IFS=: read -r rotulo origem destino <<<"$par"
	alvo="$DESTINO_DIR/$destino"

	if [[ -f "$alvo" ]] && cmp -s "$origem" "$alvo"; then
		continue
	fi

	# Escreve em arquivo temporario e move: o MTA nunca ve meio certificado.
	temporario="$(mktemp "$alvo.XXXXXX")"
	cat "$origem" >"$temporario"
	chown root:avilamail "$temporario"
	chmod "$([[ "$rotulo" == "key" ]] && echo 640 || echo 644)" "$temporario"
	mv -f "$temporario" "$alvo"
	mudou=1
	echo "atualizado: $alvo"
done

if [[ "$mudou" -eq 0 ]]; then
	echo "certificado ja estava em dia (vence em $fim)"
else
	echo "certificado sincronizado (vence em $fim); o MTA recarrega sozinho na proxima conexao"
fi
