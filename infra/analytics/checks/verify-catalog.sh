#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../../.."

HIVE_METASTORE_DB_PASSWORD="$(openssl rand -hex 24)"
SUPERSET_SECRET_KEY="$(openssl rand -hex 32)"
export HIVE_METASTORE_DB_PASSWORD SUPERSET_SECRET_KEY
project="mdh-catalog-$(openssl rand -hex 6)"
compose=(docker compose --project-name "$project" --env-file .env.example -f docker-compose.analytics.yml --profile jobs)
query="SELECT marker FROM default.catalog_probe"

cleanup() {

	local status=$?
	if (( status != 0 )); then
		"${compose[@]}" ps --all || true
		"${compose[@]}" logs --tail 40 --no-color 2>&1 \
			| sed -e "s/$HIVE_METASTORE_DB_PASSWORD/[redacted]/g" -e "s/$SUPERSET_SECRET_KEY/[redacted]/g" >&2 || true
	fi
	"${compose[@]}" down --volumes --rmi local || status=1
	exit "$status"

}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
printf 'Compose project: %s\n' "$project"

"${compose[@]}" config --quiet
"${compose[@]}" build spark-thrift spark-job hive-metastore superset
"${compose[@]}" up --wait --wait-timeout 300 spark-thrift airflow superset
"${compose[@]}" run --rm --no-deps \
	--volume "$PWD/infra/analytics/checks/write-catalog-probe.py:/opt/analytics/write-catalog-probe.py:ro" \
	spark-job /opt/analytics/write-catalog-probe.py
"${compose[@]}" exec -T spark-thrift sh -ec 'ls /warehouse/catalog_probe/*.parquet >/dev/null'

result=$("${compose[@]}" exec -T --env JAVA_TOOL_OPTIONS=-Duser.home=/tmp spark-thrift /opt/spark/bin/beeline \
	-u jdbc:hive2://spark-thrift:10000/default -n spark \
	--silent=true --showHeader=false --outputformat=tsv2 -f /dev/stdin <<< "$query;" | sed '/^[[:space:]]*$/d')
if [[ "$result" != "42" ]]; then
	printf 'Expected Beeline to return 42, got %s\n' "$result" >&2
	exit 1
fi
printf 'Beeline returned %s\n' "$result"

"${compose[@]}" exec -T superset python - <<'PY'
from sqlalchemy import text
from superset.app import create_app
from superset.extensions import db

with create_app().app_context():
	from superset.models.core import Database

	database = db.session.query(Database).filter_by(database_name="Spark SQL").one()
	with database.get_sqla_engine() as engine, engine.connect() as connection:
		result = connection.execute(text("SELECT marker FROM default.catalog_probe")).scalar_one()

if result != 42:
	raise SystemExit(f"Expected Superset to return 42, got {result}")
print(f"Superset returned {result} through PyHive")
PY
