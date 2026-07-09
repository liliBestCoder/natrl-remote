#!/bin/bash
# ============================================================
#  Natrl Remote — 一键启动所有服务
#  Usage: ./start.sh [stop|status|restart]
# ============================================================
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"

# ─── Config ────────────────────────────────────────────────
MYSQL_DATADIR="${MYSQL_DATADIR:-/var/lib/mysql}"
REDIS_PORT=6379
BACKEND_PORT=3000

# Colors
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

log()  { echo -e "${GREEN}[start]${NC} $1"; }
warn() { echo -e "${YELLOW}[warn]${NC}  $1"; }
err()  { echo -e "${RED}[err]${NC}   $1"; }
info() { echo -e "${CYAN}[info]${NC}  $1"; }

# ─── PID / log paths ──────────────────────────────────────
PID_DIR="$PROJECT_DIR/.pids"
LOG_DIR="$PROJECT_DIR/logs"
mkdir -p "$PID_DIR" "$LOG_DIR"

# ─── Stop ──────────────────────────────────────────────────
do_stop() {
    log "Stopping backend..."

    # Kill backend by process name
    for pid in $(pgrep -f "tsx.*server\.ts" 2>/dev/null); do
        kill "$pid" 2>/dev/null && log "  Stopped backend (pid $pid)"
    done

    # Clean up pid file
    rm -f "$PID_DIR/backend.pid"

    # Fallback: kill any leftover on backend port
    for pid in $(lsof -ti:$BACKEND_PORT 2>/dev/null); do
        kill "$pid" 2>/dev/null && log "  Killed leftover on port $BACKEND_PORT (pid $pid)"
    done

    log "Backend stopped. MySQL & Redis left running."
}

# ─── Status ────────────────────────────────────────────────
do_status() {
    echo ""
    echo -e "${CYAN}═══ Natrl Remote Service Status ═══${NC}"
    echo ""
    check_proc() {
        local name=$1 pidfile="$PID_DIR/$name.pid"
        if [ -f "$pidfile" ]; then
            local pid=$(cat "$pidfile")
            if [ "$pid" != "?" ] && kill -0 "$pid" 2>/dev/null; then
                echo -e "  ${GREEN}●${NC} $name (pid $pid)"
            elif [ "$pid" = "?" ]; then
                echo -e "  ${YELLOW}●${NC} $name (running, see endpoint above)"
            else
                echo -e "  ${RED}○${NC} $name (stale pid)"
            fi
        else
            echo -e "  ${YELLOW}−${NC} $name (no pid file, see endpoint above)"
        fi
    }
    check_api() {
        local name=$1 url=$2
        if curl -s --max-time 3 "$url" &>/dev/null; then
            echo -e "  ${GREEN}●${NC} $name — $url"
        else
            echo -e "  ${RED}○${NC} $name — unreachable"
        fi
    }
    echo -e "  ${CYAN}Processes:${NC}"
    check_proc "mysql"         "$PID_DIR/mysql.pid"
    check_proc "redis"         "$PID_DIR/redis.pid"
    check_proc "irext-encode"  "$PID_DIR/irext-encode.pid"
    check_proc "backend"       "$PID_DIR/backend.pid"
    echo ""
    echo -e "  ${CYAN}Endpoints:${NC}"
    check_api "backend"  "http://localhost:3000/health"
    if mysqladmin ping -u root --silent 2>/dev/null; then
        echo -e "  ${GREEN}●${NC} mysql — localhost:3306"
    else
        echo -e "  ${RED}○${NC} mysql — unreachable"
    fi
    if redis-cli -p 6379 ping &>/dev/null; then
        echo -e "  ${GREEN}●${NC} redis — localhost:6379"
    else
        echo -e "  ${RED}○${NC} redis — unreachable"
    fi
    echo ""
}

# ─── Start MySQL ───────────────────────────────────────────
start_mysql() {
    if mysqladmin ping -u root --silent 2>/dev/null; then
        echo "running" > "$PID_DIR/mysql.pid"
        info "MySQL already running"
        return 0
    fi
    log "Starting MySQL..."
    mkdir -p "$MYSQL_DATADIR"
    # Initialize if needed
    if [ ! -d "$MYSQL_DATADIR/mysql" ]; then
        log "  Initializing MySQL data directory..."
        mysqld --user=root --datadir="$MYSQL_DATADIR" --initialize-insecure 2>&1 | tail -1
    fi
    nohup mysqld --user=root --datadir="$MYSQL_DATADIR" \
        --bind-address=127.0.0.1 \
        &>"$LOG_DIR/mysql.log" &
    echo $! > "$PID_DIR/mysql.pid"

    # Wait for MySQL to be ready
    for i in $(seq 1 30); do
        if mysqladmin ping -u root --silent 2>/dev/null; then
            log "  MySQL ready (pid $(cat $PID_DIR/mysql.pid))"
            return 0
        fi
        sleep 1
    done
    err "MySQL failed to start!"
    return 1
}

# ─── Start Redis ───────────────────────────────────────────
start_redis() {
    if redis-cli -p $REDIS_PORT ping &>/dev/null; then
        echo "running" > "$PID_DIR/redis.pid"
        info "Redis already running"
        return 0
    fi
    log "Starting Redis..."
    redis-server --port $REDIS_PORT --daemonize yes --dir "$LOG_DIR" \
        --logfile "$LOG_DIR/redis.log" 2>/dev/null
    sleep 1
    if redis-cli -p $REDIS_PORT ping &>/dev/null; then
        # Find the pid
        local pid=$(redis-cli -p $REDIS_PORT info server 2>/dev/null | grep process_id | cut -d: -f2 | tr -d '\r')
        echo "${pid:-unknown}" > "$PID_DIR/redis.pid"
        log "  Redis ready (pid ${pid:-unknown})"
    else
        err "Redis failed to start!"
        return 1
    fi
}

# ─── Start irext-encode ────────────────────────────────────
start_irext_encode() {
    local irext_pid=$(lsof -ti:8002 2>/dev/null)
    if [ -n "$irext_pid" ]; then
        kill "$irext_pid" 2>/dev/null
        log "  Killed old irext-encode (pid $irext_pid)"
        sleep 1
    fi
    log "Starting irext-encode..."
    cd "$PROJECT_DIR/backend/irext_encode"
    nohup uvicorn server:app --host 0.0.0.0 --port 8002 &>"$LOG_DIR/irext-encode.log" &
    echo $! > "$PID_DIR/irext-encode.pid"

    for i in $(seq 1 15); do
        if curl -s --max-time 2 http://localhost:8002/health &>/dev/null; then
            log "  irext-encode ready (pid $(cat $PID_DIR/irext-encode.pid))"
            cd "$PROJECT_DIR"
            return 0
        fi
        sleep 1
    done
    warn "irext-encode may still be starting (check $LOG_DIR/irext-encode.log)"
    cd "$PROJECT_DIR"
}

# ─── Start Backend ─────────────────────────────────────────
start_backend() {
    # Kill any running backend by process name (tsx running server.ts)
    local old_pids=$(pgrep -f "tsx.*server\.ts" 2>/dev/null)
    if [ -n "$old_pids" ]; then
        for pid in $old_pids; do
            kill "$pid" 2>/dev/null && log "  Killed old backend (pid $pid)"
        done
        sleep 1
    fi

    log "Starting Backend..."
    cd "$BACKEND_DIR"
    nohup npx tsx src/server.ts &>"$LOG_DIR/backend.log" &
    local new_pid=$!
    echo "$new_pid" > "$PID_DIR/backend.pid"

    for i in $(seq 1 20); do
        if curl -s --max-time 2 http://localhost:$BACKEND_PORT/health &>/dev/null; then
            log "  Backend ready (pid $new_pid)"
            cd "$PROJECT_DIR"
            return 0
        fi
        sleep 1
    done
    warn "Backend may still be starting (check $LOG_DIR/backend.log)"
    cd "$PROJECT_DIR"
}

# ─── Init DB (first run only) ──────────────────────────────
init_db() {
    if mysql -u root natrl -e "SELECT COUNT(*) FROM ir_protocols" &>/dev/null; then
        local count=$(mysql -u root natrl -N -e "SELECT COUNT(*) FROM ir_protocols")
        info "Database already initialized ($count protocols)"
        return 0
    fi

    log "Initializing database..."
    # Create DB & user
    mysql -u root <<SQL 2>/dev/null
CREATE DATABASE IF NOT EXISTS natrl CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'natrl'@'localhost' IDENTIFIED BY 'natrl_dev';
CREATE USER IF NOT EXISTS 'natrl'@'%' IDENTIFIED BY 'natrl_dev';
GRANT ALL PRIVILEGES ON natrl.* TO 'natrl'@'localhost';
GRANT ALL PRIVILEGES ON natrl.* TO 'natrl'@'%';
FLUSH PRIVILEGES;
SQL

    # Run init SQL
    mysql -u root natrl < "$BACKEND_DIR/db/init.sql" 2>/dev/null && \
        log "  init.sql OK"

    # Import IR codes
    if [ -f "$BACKEND_DIR/db/02_ir_codes_data.sql" ]; then
        mysql -u root natrl < "$BACKEND_DIR/db/02_ir_codes_data.sql" 2>/dev/null && \
            log "  ir_codes data imported ($(mysql -u root natrl -N -e 'SELECT COUNT(*) FROM ir_codes') rows)"
    fi
}

# ─── Main ──────────────────────────────────────────────────
CMD="${1:-start}"

case "$CMD" in
    stop)
        do_stop
        ;;
    status)
        do_status
        ;;
    restart)
        do_stop
        sleep 2
        ;&
    start)
        echo ""
        echo -e "${CYAN}╔══════════════════════════════════════╗${NC}"
        echo -e "${CYAN}║     Natrl Remote — Starting Up       ║${NC}"
        echo -e "${CYAN}╚══════════════════════════════════════╝${NC}"
        echo ""

        # 1. MySQL — keep alive if running
        log "─────────── MySQL ───────────"
        start_mysql

        # 2. Init DB (first run only)
        init_db

        # 3. Redis — keep alive if running
        log "─────────── Redis ───────────"
        start_redis

        # 4. irext-encode — always kill old and restart
        log "───────── irext-encode ────────"
        start_irext_encode

        # 5. Backend — always kill old and restart
        log "────────── Backend ──────────"
        start_backend

        echo ""
        echo -e "${GREEN}══════════════════════════════════════════${NC}"
        echo -e "${GREEN}  All services started!${NC}"
        echo ""
        echo -e "  Backend:     ${CYAN}http://localhost:3000/health${NC}"
        echo -e "  irext-encode:${CYAN}http://localhost:8002/health${NC}"
        echo -e "  MySQL:       ${CYAN}localhost:3306 (natrl/natrl_dev)${NC}"
        echo -e "  Redis:       ${CYAN}localhost:6379${NC}"
        echo ""
        echo -e "  Logs:        ${CYAN}$LOG_DIR${NC}"
        echo -e "  Stop:        ${CYAN}./start.sh stop${NC}"
        echo -e "  Status:      ${CYAN}./start.sh status${NC}"
        echo -e "${GREEN}══════════════════════════════════════════${NC}"
        echo ""
        ;;
    *)
        echo "Usage: $0 [start|stop|status|restart]"
        exit 1
        ;;
esac
