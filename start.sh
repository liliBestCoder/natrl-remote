#!/bin/bash
# ============================================================
#  Natrl Remote — 一键启动所有服务
#  Usage: ./start.sh [stop|status|restart]
# ============================================================
set -e

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$PROJECT_DIR/backend"
WAVEFORM_DIR="$PROJECT_DIR/waveform-engine"

# ─── Config ────────────────────────────────────────────────
MYSQL_DATADIR="${MYSQL_DATADIR:-/var/lib/mysql}"
REDIS_PORT=6379
BACKEND_PORT=3001
WAVEFORM_PORT=8001

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
    log "Stopping all services..."
    for pidfile in "$PID_DIR"/*.pid; do
        [ -f "$pidfile" ] || continue
        local name=$(basename "$pidfile" .pid)
        local pid=$(cat "$pidfile")
        if kill -0 "$pid" 2>/dev/null; then
            kill "$pid" 2>/dev/null || true
            log "  Stopped $name (pid $pid)"
        fi
        rm -f "$pidfile"
    done
    # Clean up any leftover processes on our ports
    for port in $BACKEND_PORT $WAVEFORM_PORT; do
        for pid in $(lsof -ti:$port 2>/dev/null); do
            kill "$pid" 2>/dev/null && log "  Killed leftover on port $port (pid $pid)"
        done
    done
    log "All services stopped."
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
    check_proc "mysql"    "$PID_DIR/mysql.pid"
    check_proc "redis"    "$PID_DIR/redis.pid"
    check_proc "waveform" "$PID_DIR/waveform.pid"
    check_proc "backend"  "$PID_DIR/backend.pid"
    echo ""
    echo -e "  ${CYAN}Endpoints:${NC}"
    check_api "backend"  "http://localhost:3001/health"
    check_api "waveform" "http://localhost:8001/health"
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

# ─── Start Waveform Engine ─────────────────────────────────
start_waveform() {
    if curl -s --max-time 2 http://localhost:$WAVEFORM_PORT/health &>/dev/null; then
        info "Waveform engine already running"
        return 0
    fi
    log "Starting Waveform Engine..."
    cd "$WAVEFORM_DIR"
    nohup uvicorn server:app --host 0.0.0.0 --port $WAVEFORM_PORT \
        &>"$LOG_DIR/waveform.log" &
    echo $! > "$PID_DIR/waveform.pid"

    for i in $(seq 1 15); do
        if curl -s http://localhost:$WAVEFORM_PORT/health &>/dev/null; then
            log "  Waveform ready (pid $(cat $PID_DIR/waveform.pid))"
            cd "$PROJECT_DIR"
            return 0
        fi
        sleep 1
    done
    warn "Waveform engine may still be starting (check $LOG_DIR/waveform.log)"
    cd "$PROJECT_DIR"
}

# ─── Start Backend ─────────────────────────────────────────
start_backend() {
    if curl -s --max-time 2 http://localhost:$BACKEND_PORT/health &>/dev/null; then
        info "Backend already running"
        return 0
    fi
    log "Starting Backend..."
    cd "$BACKEND_DIR"
    nohup npx tsx src/server.ts &>"$LOG_DIR/backend.log" &
    echo $! > "$PID_DIR/backend.pid"

    for i in $(seq 1 20); do
        if curl -s http://localhost:$BACKEND_PORT/health &>/dev/null; then
            log "  Backend ready (pid $(cat $PID_DIR/backend.pid))"
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

        # 1. MySQL
        log "─────────── MySQL ───────────"
        start_mysql

        # 2. Init DB (first run)
        init_db

        # 3. Redis
        log "─────────── Redis ───────────"
        start_redis

        # 4. Waveform Engine
        log "──────── Waveform Engine ────────"
        start_waveform

        # 5. Backend
        log "────────── Backend ──────────"
        start_backend

        echo ""
        echo -e "${GREEN}══════════════════════════════════════════${NC}"
        echo -e "${GREEN}  All services started!${NC}"
        echo ""
        echo -e "  Backend:     ${CYAN}http://localhost:3001/health${NC}"
        echo -e "  Waveform:    ${CYAN}http://localhost:8001/health${NC}"
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
