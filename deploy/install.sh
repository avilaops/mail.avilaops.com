#!/usr/bin/env bash
#
# Instalacao do avila-mail no VPS. Idempotente: pode rodar de novo.
#
#   sudo bash deploy/install.sh
#
# Nao faz nada com DNS nem com certificado — esses passos estao no README,
# porque dependem de acao no painel da Hetzner e do Cloudflare.
#
set -euo pipefail

APP_DIR="/opt/avila-mail"
DATA_DIR="/var/lib/avila-mail"
SERVICE_USER="avilamail"
DB_NAME="avila_mail"
DB_USER="avila_mail"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die() { printf '\n\033[1;31mERRO: %s\033[0m\n' "$1" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Rode como root (sudo)."
command -v node >/dev/null || die "Node.js nao encontrado."
command -v psql >/dev/null || die "psql nao encontrado. O Postgres precisa estar acessivel neste host."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 22 ]] || die "Node 22+ necessario (encontrado $NODE_MAJOR)."

log "Usuario de sistema"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
	useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
	echo "  usuario $SERVICE_USER criado"
else
	echo "  usuario $SERVICE_USER ja existe"
fi

log "Diretorios"
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$DATA_DIR" "$DATA_DIR/blobs"
install -d -o root -g root -m 0755 /var/www/acme/.well-known/acme-challenge
echo "  $DATA_DIR e o webroot do ACME prontos"

log "Banco de dados"
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
	DB_PASS="$(openssl rand -hex 24)"
	sudo -u postgres psql -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS';"
	echo "  role $DB_USER criada"
	echo
	echo "  ---------------------------------------------------------------"
	echo "  Anote a MAIL_DATABASE_URL e coloque no .env.production:"
	echo "  postgresql://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME?schema=public"
	echo "  ---------------------------------------------------------------"
	echo
else
	echo "  role $DB_USER ja existe (senha preservada)"
fi

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1; then
	sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
	echo "  banco $DB_NAME criado"
else
	echo "  banco $DB_NAME ja existe"
fi

log "Arquivo de ambiente"
if [[ ! -f "$APP_DIR/.env.production" ]]; then
	die "Faltou $APP_DIR/.env.production. Copie de .env.example, preencha e rode de novo."
fi
chown root:"$SERVICE_USER" "$APP_DIR/.env.production"
chmod 0640 "$APP_DIR/.env.production"
echo "  permissoes ajustadas (0640 root:$SERVICE_USER)"

for var in MAIL_DATABASE_URL MAIL_DKIM_ENCRYPTION_KEY MAIL_API_TOKEN; do
	grep -qE "^${var}=.+" "$APP_DIR/.env.production" || die "$var vazio em .env.production"
done
echo "  variaveis obrigatorias presentes"

log "Dependencias e build"
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
npx prisma generate
npm install --no-save typescript@^5 @types/node@^24
npx tsc -p tsconfig.json
echo "  build em dist/ concluido"

log "Migracoes"
set -a
# shellcheck disable=SC1091
source "$APP_DIR/.env.production"
set +a
# O Prisma CLI carrega o motor de schema em WebAssembly, e --jitless (que o
# .env.production define para o servico conviver com MemoryDenyWriteExecute)
# desliga o WASM: a migracao morre despejando o bundle inteiro no terminal.
# Sem a flag so aqui, no processo do CLI; o servico continua jitless.
env -u NODE_OPTIONS npx prisma migrate deploy

chown -R "$SERVICE_USER":"$SERVICE_USER" "$APP_DIR/dist" "$APP_DIR/node_modules"

log "Sincronia do certificado (o Caddy renova; o timer copia para o MTA)"
chmod 755 "$APP_DIR/deploy/sincronizar-certificado.sh"
cp "$APP_DIR/deploy/avila-mail-cert-sync.service" "$APP_DIR/deploy/avila-mail-cert-sync.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now avila-mail-cert-sync.timer
bash "$APP_DIR/deploy/sincronizar-certificado.sh" || true

log "Servicos systemd"
install -m 0644 "$APP_DIR/deploy/avila-mail-mta.service" /etc/systemd/system/
install -m 0644 "$APP_DIR/deploy/avila-mail-api.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now avila-mail-api
systemctl enable --now avila-mail-mta

log "Verificacao"
sleep 3
systemctl is-active --quiet avila-mail-api || die "avila-mail-api nao subiu. Veja: journalctl -u avila-mail-api -n 50"
systemctl is-active --quiet avila-mail-mta || die "avila-mail-mta nao subiu. Veja: journalctl -u avila-mail-mta -n 50"

curl -fsS "http://127.0.0.1:${MAIL_API_PORT:-3040}/v1/health" && echo
ss -tlnp | grep -E ':(25|587|465|3040)\s' || true

log "Instalacao concluida"
cat <<'EOS'

Proximos passos (fora deste script, ver README.md):
  1. DNS: A de mail.avilaops.com apontando para o IP do servidor
  2. rDNS do IP para mail.avilaops.com no console da Hetzner
  3. Certificado: certbot certonly --webroot -w /var/www/acme -d mail.avilaops.com
  4. Incluir deploy/Caddyfile.snippet no Caddyfile e recarregar o Caddy
  5. Publicar MX, SPF, DKIM e DMARC de avilaops.com
  6. Apontar EMAIL_PROVIDER_API_URL do portal do cliente para esta API

EOS
