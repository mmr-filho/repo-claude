#!/bin/sh
# Réplica de leitura por streaming: na primeira subida copia o primário (pg_basebackup -R cria o
# standby.signal) e depois roda como hot standby. Todos os bancos tenant_db_* chegam aqui sozinhos.
set -e
if [ ! -s "$PGDATA/PG_VERSION" ]; then
  until pg_isready -h "$PRIMARY_HOST" -p 5432 -U replicator; do echo "aguardando o primário..."; sleep 2; done
  export PGPASSWORD="${REPLICATION_PASSWORD:-replicator}"
  pg_basebackup -h "$PRIMARY_HOST" -p 5432 -U replicator -D "$PGDATA" -Fp -Xs -P -R
  chmod 0700 "$PGDATA"
fi
exec postgres -c hot_standby=on
