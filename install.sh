#!/usr/bin/env bash
set -Eeuo pipefail

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "请使用 root 运行：sudo ./install.sh"
  exit 1
fi

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT_DIR"
if [[ ! -f VERSION ]]; then
  echo "缺少 VERSION 文件"
  exit 1
fi
APP_VERSION=$(tr -d '[:space:]' < VERSION)
if [[ ! "$APP_VERSION" =~ ^[0-9]+\.[0-9]+$ ]]; then
  echo "VERSION 文件格式无效"
  exit 1
fi

if [[ -f .env ]]; then
  echo "检测到现有 .env。为避免覆盖数据库密码和实例主密钥，安装程序已停止。"
  echo "如需升级请运行 sudo ./update.sh；如需全新重装请先备份并移走现有实例。"
  exit 1
fi

# 非交互安装：显式设置 NON_INTERACTIVE=1，或标准输入不是终端时自动启用。
# 非交互模式下未提供的配置一律使用默认值，管理员用户名和密码随机生成。
if [[ -z "${NON_INTERACTIVE:-}" ]]; then
  if [[ -t 0 ]]; then NON_INTERACTIVE=0; else NON_INTERACTIVE=1; fi
fi
if [[ ! "$NON_INTERACTIVE" =~ ^[01]$ ]]; then
  echo "NON_INTERACTIVE 只能是 0 或 1"
  exit 1
fi

PROJECT_NAME=$(awk 'NR<=20 && /^name:[[:space:]]/ {
  sub(/^name:[[:space:]]*/, "")
  sub(/[[:space:]]*$/, "")
  print
  exit
}' compose.yml)
if [[ -z "$PROJECT_NAME" ]]; then
  echo "无法从 compose.yml 解析 Compose 项目名"
  exit 1
fi

# 安装未走完时回滚本次创建的资源，避免残留 .env 让重试被开头的检查直接拒绝。
INSTALL_COMPLETE=0
ENV_CREATED=0
rollback() {
  (( INSTALL_COMPLETE )) && return 0
  (( ENV_CREATED )) || return 0
  echo ""
  echo "安装未完成，正在回滚本次创建的资源..."
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  local leftover
  leftover=$(docker volume ls --quiet --filter "name=^${PROJECT_NAME}_" 2>/dev/null || true)
  if [[ -n "$leftover" ]]; then
    printf '%s\n' "$leftover" | xargs -r docker volume rm -f >/dev/null 2>&1 || true
  fi
  rm -f -- "$ROOT_DIR/.env"
  echo "已删除 .env 和本次新建的数据卷，修复问题后可重新运行 sudo ./install.sh。"
}
trap rollback EXIT

random_urlsafe() { openssl rand -hex "$1"; }
random_base64() { openssl rand -base64 "$1" | tr -d '\n'; }

prompt_value() {
  # prompt_value <变量名> <提示语> <默认值>
  local name=$1 prompt=$2 fallback=${3:-} answer=""
  if [[ -n "${!name:-}" ]]; then return 0; fi
  if (( NON_INTERACTIVE )); then
    printf -v "$name" '%s' "$fallback"
    return 0
  fi
  read -r -p "$prompt" answer || answer=""
  printf -v "$name" '%s' "${answer:-$fallback}"
}

prompt_secret() {
  # prompt_secret <变量名> <提示语>
  local name=$1 prompt=$2 answer=""
  if [[ -n "${!name:-}" ]]; then return 0; fi
  if (( NON_INTERACTIVE )); then
    printf -v "$name" '%s' ""
    return 0
  fi
  read -r -s -p "$prompt" answer || answer=""
  echo ""
  printf -v "$name" '%s' "$answer"
}

port_in_use() {
  local port=$1
  if command -v ss >/dev/null 2>&1; then
    [[ -n $(ss -Hltn "sport = :$port" 2>/dev/null) ]] && return 0
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$" && return 0
  fi
  return 1
}

install_docker() {
  . /etc/os-release
  if [[ ${ID:-} != debian || ! ${VERSION_ID:-} =~ ^(12|13)$ ]]; then
    echo "自动安装仅支持 Debian 12/13。请先手工安装 Docker Engine 与 Compose Plugin。"
    exit 1
  fi
  apt-get update
  apt-get install -y ca-certificates curl jq openssl
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    systemctl enable --now docker
    return
  fi
  apt-get install -y gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

install_docker

# 全新安装会生成新的 PostgreSQL 密码，无法匹配残留卷里已初始化的数据目录，
# 与其让 app 在启动后反复认证失败，不如在这里明确停止。
LEFTOVER_VOLUMES=$(docker volume ls --quiet --filter "name=^${PROJECT_NAME}_" 2>/dev/null || true)
if [[ -n "$LEFTOVER_VOLUMES" ]]; then
  echo "检测到上一次安装残留的数据卷："
  printf '%s\n' "$LEFTOVER_VOLUMES" | sed 's/^/  - /'
  echo ""
  echo "全新安装会重新生成数据库密码，无法读取这些卷中已初始化的数据，安装已停止。"
  echo "确认其中的数据不再需要后，执行下面的命令清理再重试："
  LEFTOVER_LIST=$(printf '%s ' $LEFTOVER_VOLUMES)
  echo "  docker volume rm ${LEFTOVER_LIST% }"
  exit 1
fi

echo ""
echo "MailPilot Microsoft 与 Gmail 邮箱自动回复系统安装"
echo "-----------------------------------------"
if (( NON_INTERACTIVE )); then
  echo "非交互模式：未提供的配置使用默认值，管理员凭据随机生成。"
fi
prompt_value PUBLIC_URL "后台 HTTPS 公开地址（可留空，留空时按访问域名自动识别）: " ""
if [[ -n "$PUBLIC_URL" && ! "$PUBLIC_URL" =~ ^https://[^/@?#[:space:]]+/?$ ]]; then
  echo "公开地址必须是纯 HTTPS 域名（可含端口），不能包含路径、查询参数或账号信息"
  exit 1
fi
prompt_value HOST_PORT "本机监听端口 [8080]: " "8080"
HOST_PORT=${HOST_PORT:-8080}
if ! [[ "$HOST_PORT" =~ ^[0-9]+$ ]] || (( HOST_PORT < 1 || HOST_PORT > 65535 )); then echo "端口无效"; exit 1; fi
if port_in_use "$HOST_PORT"; then
  echo "本机监听端口 $HOST_PORT 已被占用，请先释放该端口或改用其他端口后重试。"
  exit 1
fi

prompt_value ADMIN_USERNAME "管理员用户名（直接回车随机生成）: " ""
RANDOM_USERNAME=false
if [[ -z "$ADMIN_USERNAME" ]]; then ADMIN_USERNAME="admin_$(random_urlsafe 6)"; RANDOM_USERNAME=true; fi
if [[ ! "$ADMIN_USERNAME" =~ ^[A-Za-z0-9._-]{1,128}$ ]]; then
  echo "管理员用户名仅允许字母、数字、点、下划线和短横线，长度 1-128 位"
  exit 1
fi

prompt_secret ADMIN_PASSWORD "管理员密码（直接回车随机生成；手工输入至少 12 位）: "
RANDOM_PASSWORD=false
if [[ -z "$ADMIN_PASSWORD" ]]; then
  ADMIN_PASSWORD=$(random_urlsafe 16)
  RANDOM_PASSWORD=true
elif (( ${#ADMIN_PASSWORD} < 12 )); then echo "密码至少 12 位"; exit 1; fi

POSTGRES_PASSWORD=$(random_urlsafe 24)
INSTANCE_KEY=$(random_base64 32)
SESSION_SECRET=$(random_urlsafe 32)
UPDATER_TOKEN=$(random_urlsafe 32)

umask 077
ENV_CREATED=1
cat > .env <<EOF
NODE_ENV=production
APP_VERSION=$APP_VERSION
APP_HOST=0.0.0.0
APP_PORT=3000
HOST_BIND=0.0.0.0
HOST_PORT=$HOST_PORT
PUBLIC_URL=$PUBLIC_URL
DATABASE_URL=postgresql://autoreply:$POSTGRES_PASSWORD@postgres:5432/autoreply?schema=public
POSTGRES_DB=autoreply
POSTGRES_USER=autoreply
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
REDIS_URL=redis://redis:6379
INSTANCE_KEY=$INSTANCE_KEY
SESSION_SECRET=$SESSION_SECRET
TRUST_PROXY=0
TZ=Asia/Shanghai
LOG_LEVEL=info
BOOTSTRAP_FILE=/bootstrap/admin.json
WORKER_ID=worker-1
PROJECT_DIR=$ROOT_DIR
UPDATER_TOKEN=$UPDATER_TOKEN
EOF

COMPOSE_PROJECT_NAME=$(docker compose config --format json | jq -r '.name')
if [[ -z "$COMPOSE_PROJECT_NAME" || "$COMPOSE_PROJECT_NAME" == null ]]; then
  echo "无法读取 Compose 项目名"
  exit 1
fi
PROJECT_NAME=$COMPOSE_PROJECT_NAME
BOOTSTRAP_VOLUME="${PROJECT_NAME}_bootstrap_data"
docker volume create "$BOOTSTRAP_VOLUME" >/dev/null
BOOTSTRAP_MOUNT=$(docker volume inspect "$BOOTSTRAP_VOLUME" --format '{{ .Mountpoint }}')
install -d -o 10001 -g 10001 -m 0700 "$BOOTSTRAP_MOUNT"
jq -n --arg u "$ADMIN_USERNAME" --arg p "$ADMIN_PASSWORD" --argjson ru "$RANDOM_USERNAME" --argjson rp "$RANDOM_PASSWORD" '{username:$u,password:$p,randomUsername:$ru,randomPassword:$rp}' > "$BOOTSTRAP_MOUNT/admin.json"
chmod 0600 "$BOOTSTRAP_MOUNT/admin.json"
chown 10001:10001 "$BOOTSTRAP_MOUNT/admin.json"

docker compose build
docker compose up -d

echo "等待应用和 Worker 健康检查..."
for _ in $(seq 1 90); do
  UPDATER_CONTAINER=$(docker compose ps -q updater || true)
  UPDATER_HEALTH=$([[ -n "$UPDATER_CONTAINER" ]] && docker inspect "$UPDATER_CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || true)
  if curl -fsS "http://127.0.0.1:$HOST_PORT/health/ready" >/dev/null 2>&1 && [[ "$UPDATER_HEALTH" == healthy ]]; then break; fi
  sleep 2
done
UPDATER_CONTAINER=$(docker compose ps -q updater || true)
UPDATER_HEALTH=$([[ -n "$UPDATER_CONTAINER" ]] && docker inspect "$UPDATER_CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || true)
if ! curl -fsS "http://127.0.0.1:$HOST_PORT/health/ready" >/dev/null 2>&1 || [[ "$UPDATER_HEALTH" != healthy ]]; then
  echo "应用或在线升级器未能在预期时间内启动，以下是容器状态和最近日志："
  echo "----- docker compose ps -a -----"
  docker compose ps -a || true
  echo "----- docker compose logs --tail=60 -----"
  docker compose logs --no-color --tail=60 app worker updater migrate || true
  exit 1
fi

INSTALL_COMPLETE=1

echo ""
SERVER_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
echo "安装完成："
if [[ -n "$SERVER_IP" ]]; then
  echo "IP 访问：http://$SERVER_IP:$HOST_PORT"
else
  echo "IP 访问：http://服务器IP:$HOST_PORT"
fi
echo "本机健康检查：http://127.0.0.1:$HOST_PORT/health/ready"
[[ -n "$PUBLIC_URL" ]] && echo "公开地址：$PUBLIC_URL"
echo "提示：IP 直连使用明文 HTTP；Microsoft/Google OAuth 需要通过 HTTPS 域名打开后台，"
echo "     公开地址会按访问域名自动识别，不需要写进配置文件。"
if [[ "$RANDOM_USERNAME" == true || "$RANDOM_PASSWORD" == true ]]; then
  echo ""
  echo "随机管理员凭据（也会在 app 首次日志中仅显示一次）："
  [[ "$RANDOM_USERNAME" == true ]] && echo "用户名: $ADMIN_USERNAME"
  [[ "$RANDOM_PASSWORD" == true ]] && echo "临时密码: $ADMIN_PASSWORD"
  echo "首次登录必须修改随机密码。"
else
  echo "管理员用户名: $ADMIN_USERNAME"
  echo "手工输入的密码未写入 Docker 日志。"
fi
echo "Nginx 示例：$ROOT_DIR/nginx/autoreply.conf.example"
