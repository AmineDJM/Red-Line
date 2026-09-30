#!/usr/bin/env bash
# PostgreSQL 16 local et jetable pour le développement et les tests du serveur Red Line.
#
#   apps/server/scripts/dev-db.sh start    # initialise si besoin, démarre, crée redline et redline_test
#   apps/server/scripts/dev-db.sh stop
#   apps/server/scripts/dev-db.sh status
#   apps/server/scripts/dev-db.sh reset    # arrête et efface toutes les données
#   apps/server/scripts/dev-db.sh url      # affiche les URL de connexion
#
# Variables : REDLINE_PGDATA (défaut <racine>/.pgdata, ignoré par git), REDLINE_PGPORT (défaut 54329),
#             PG_BIN (défaut /usr/lib/postgresql/16/bin).
# Base de dev  : postgres://postgres@127.0.0.1:54329/redline
# Base de test : postgres://postgres@127.0.0.1:54329/redline_test (TEST_DATABASE_URL)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${REDLINE_PGDATA:-$REPO_ROOT/.pgdata}"
PORT="${REDLINE_PGPORT:-54329}"

# postgres refuse de tourner en root : on délègue à l'utilisateur système « postgres ».
as_pg() {
  if [ "$(id -u)" = "0" ]; then
    runuser -u postgres -- "$@"
  else
    "$@"
  fi
}

ensure_dir() {
  mkdir -p "$PGDATA"
  if [ "$(id -u)" = "0" ]; then
    chown postgres:postgres "$PGDATA"
    chmod 700 "$PGDATA"
    # L'utilisateur postgres doit pouvoir traverser les dossiers parents.
    local d
    d="$(dirname "$PGDATA")"
    while [ "$d" != "/" ]; do
      if ! runuser -u postgres -- test -x "$d"; then chmod o+x "$d"; fi
      d="$(dirname "$d")"
    done
  fi
}

is_running() {
  as_pg "$PG_BIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1
}

psql_cmd() {
  as_pg "$PG_BIN/psql" -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -qAt "$@"
}

create_db() {
  local name="$1"
  if [ "$(psql_cmd -d postgres -c "SELECT 1 FROM pg_database WHERE datname='$name'")" != "1" ]; then
    psql_cmd -d postgres -c "CREATE DATABASE $name"
    echo "Base $name créée."
  fi
}

print_urls() {
  echo "DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/redline"
  echo "TEST_DATABASE_URL=postgres://postgres@127.0.0.1:$PORT/redline_test"
}

cmd="${1:-start}"
case "$cmd" in
  start)
    ensure_dir
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      as_pg "$PG_BIN/initdb" -D "$PGDATA" -U postgres -A trust -E UTF8 --no-sync >/dev/null
      echo "Cluster initialisé dans $PGDATA."
    fi
    if ! is_running; then
      as_pg "$PG_BIN/pg_ctl" -D "$PGDATA" -l "$PGDATA/server.log" -w \
        -o "-p $PORT -c unix_socket_directories='' -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off" \
        start >/dev/null
      echo "PostgreSQL démarré sur 127.0.0.1:$PORT."
    else
      echo "PostgreSQL tourne déjà."
    fi
    create_db redline
    create_db redline_test
    print_urls
    ;;
  stop)
    if is_running; then as_pg "$PG_BIN/pg_ctl" -D "$PGDATA" -m fast -w stop >/dev/null; fi
    echo "PostgreSQL arrêté."
    ;;
  status)
    if is_running; then echo "en marche ($PGDATA, port $PORT)"; else echo "arrêté"; exit 1; fi
    ;;
  reset)
    if [ -d "$PGDATA" ] && is_running; then as_pg "$PG_BIN/pg_ctl" -D "$PGDATA" -m immediate -w stop >/dev/null; fi
    rm -rf "$PGDATA"
    echo "Données effacées ($PGDATA)."
    ;;
  url)
    print_urls
    ;;
  *)
    echo "usage : $0 {start|stop|status|reset|url}" >&2
    exit 2
    ;;
esac
