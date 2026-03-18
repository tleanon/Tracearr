#!/bin/bash
# Wrapper script for starting Tracearr after dependencies are ready
# Used by supervisord to ensure PostgreSQL and Redis are available

set -e

# Supervised mode ALWAYS uses internal database/redis
# If you need an external database, use the regular tracearr image instead
INTERNAL_DB="postgresql://tracearr:tracearr@127.0.0.1:5432/tracearr"
INTERNAL_REDIS="redis://127.0.0.1:6379"

# Warn if user tried to set external DATABASE_URL (they should use regular image)
if [ -n "$DATABASE_URL" ] && [ "$DATABASE_URL" != "$INTERNAL_DB" ]; then
    echo "[Tracearr] WARNING: Custom DATABASE_URL detected in supervised mode"
    echo "[Tracearr] The supervised image includes its own PostgreSQL - external databases are not supported"
    echo "[Tracearr] If you need an external database, please use the regular 'tracearr:latest' image instead"
    echo "[Tracearr] Your DATABASE_URL will be ignored. Using internal database."
fi

export DATABASE_URL="$INTERNAL_DB"
export REDIS_URL="$INTERNAL_REDIS"

MAX_RETRIES=30
RETRY_INTERVAL=2

# Wait for PostgreSQL
echo "[Tracearr] Waiting for PostgreSQL..."
for i in $(seq 1 $MAX_RETRIES); do
    if pg_isready -h 127.0.0.1 -p 5432 -U tracearr -q; then
        echo "[Tracearr] PostgreSQL is ready"
        break
    fi
    if [ $i -eq $MAX_RETRIES ]; then
        echo "[Tracearr] ERROR: PostgreSQL failed to become ready after $((MAX_RETRIES * RETRY_INTERVAL)) seconds"
        exit 1
    fi
    sleep $RETRY_INTERVAL
done

# Wait for Redis
echo "[Tracearr] Waiting for Redis..."
for i in $(seq 1 $MAX_RETRIES); do
    if redis-cli -h 127.0.0.1 ping 2>/dev/null | grep -q PONG; then
        echo "[Tracearr] Redis is ready"
        break
    fi
    if [ $i -eq $MAX_RETRIES ]; then
        echo "[Tracearr] ERROR: Redis failed to become ready after $((MAX_RETRIES * RETRY_INTERVAL)) seconds"
        exit 1
    fi
    sleep $RETRY_INTERVAL
done

echo "[Tracearr] Starting application..."
exec node /app/apps/server/dist/index.js
