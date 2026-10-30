#!/bin/sh
# Gera o .env com senhas aleatórias a partir do .env.example (servidor Linux). Uso: sh gerar-env.sh
set -e
cd "$(dirname "$0")"
if [ -e .env ]; then
  echo 'O .env já existe. Não gere de novo depois que os bancos foram criados: as senhas deixariam de conferir.' >&2
  exit 1
fi
cp .env.example .env
for v in MASTER_DB_PASSWORD POSTGRES_SUPERUSER_PASSWORD APP_DB_PASSWORD ADMIN_DB_PASSWORD BI_DB_PASSWORD REPLICATION_PASSWORD JWT_SECRET PLATFORM_ADMIN_PASSWORD; do
  sed -i "s|^$v=\$|$v=$(openssl rand -hex 24)|" .env
done
sed -i "s|^DATA_KEY=\$|DATA_KEY=$(openssl rand -base64 32)|" .env
chmod 600 .env
echo '.env criado com senhas novas. Guarde uma cópia em local seguro (cofre de senhas).'
