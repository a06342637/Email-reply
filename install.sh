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

random_urlsafe() { openssl rand -hex "$1"; }
random_base64() { openssl rand -base64 "$1" | tr -d '\n'; }

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

echo ""
echo "MailPilot Microsoft 邮箱自动回复系统安装"
echo "-----------------------------------------"
read -r -p "后台 HTTPS 公开地址（可留空，留空时暂不能连接 Microsoft）: " PUBLIC_URL
if [[ -n "$PUBLIC_URL" && ! "$PUBLIC_URL" =~ ^https://[^/@?#[:space:]]+/?$ ]]; then
  echo "公开地址必须是纯 HTTPS 域名（可含端口），不能包含路径、查询参数或账号信息"
  exit 1
fi
read -r -p "本机监听端口 [8080]: " HOST_PORT
HOST_PORT=${HOST_PORT:-8080}
if ! [[ "$HOST_PORT" =~ ^[0-9]+$ ]] || (( HOST_PORT < 1 || HOST_PORT > 65535 )); then echo "端口无效"; exit 1; fi

read -r -p "管理员用户名（直接回车随机生成）: " ADMIN_USERNAME
RANDOM_USERNAME=false
if [[ -z "$ADMIN_USERNAME" ]]; then ADMIN_USERNAME="admin_$(random_urlsafe 6)"; RANDOM_USERNAME=true; fi
if [[ ! "$ADMIN_USERNAME" =~ ^[A-Za-z0-9._-]{1,128}$ ]]; then
  echo "管理员用户名仅允许字母、数字、点、下划线和短横线，长度 1-128 位"
  exit 1
fi

read -r -s -p "管理员密码（直接回车随机生成；手工输入至少 12 位）: " ADMIN_PASSWORD
echo ""
RANDOM_PASSWORD=false
if [[ -z "$ADMIN_PASSWORD" ]]; then
  ADMIN_PASSWORD=$(random_urlsafe 16)
  RANDOM_PASSWORD=true
elif (( ${#ADMIN_PASSWORD} < 12 )); then echo "密码至少 12 位"; exit 1; fi

POSTGRES_PASSWORD=$(random_urlsafe 24)
INSTANCE_KEY=$(random_base64 32)
SESSION_SECRET=$(random_urlsafe 32)

umask 077
cat > .env <<EOF
NODE_ENV=production
APP_VERSION=$APP_VERSION
APP_HOST=0.0.0.0
APP_PORT=3000
HOST_BIND=127.0.0.1
HOST_PORT=$HOST_PORT
PUBLIC_URL=$PUBLIC_URL
DATABASE_URL=postgresql://autoreply:$POSTGRES_PASSWORD@postgres:5432/autoreply?schema=public
POSTGRES_DB=autoreply
POSTGRES_USER=autoreply
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
REDIS_URL=redis://redis:6379
INSTANCE_KEY=$INSTANCE_KEY
SESSION_SECRET=$SESSION_SECRET
TRUST_PROXY=1
TZ=Asia/Shanghai
LOG_LEVEL=info
BOOTSTRAP_FILE=/bootstrap/admin.json
WORKER_ID=worker-1
EOF

PROJECT_NAME=$(docker compose config --format json | jq -r '.name')
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
  if curl -fsS "http://127.0.0.1:$HOST_PORT/health/ready" >/dev/null 2>&1; then break; fi
  sleep 2
done
if ! curl -fsS "http://127.0.0.1:$HOST_PORT/health/ready" >/dev/null 2>&1; then
  echo "应用未能在预期时间内启动，请运行 docker compose logs app worker migrate 查看原因。"
  exit 1
fi

echo ""
echo "安装完成：http://127.0.0.1:$HOST_PORT"
[[ -n "$PUBLIC_URL" ]] && echo "公开地址：$PUBLIC_URL"
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
