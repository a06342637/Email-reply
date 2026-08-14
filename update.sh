#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT_DIR"
if [[ ! -f .env ]]; then echo "找不到 .env，请先安装系统。"; exit 1; fi
OLD_APP_VERSION=$(sed -n 's/^APP_VERSION=//p' .env | tail -n1)
OLD_APP_VERSION=${OLD_APP_VERSION:-0.01}

read -r -s -p "升级前加密备份口令（至少 12 位）: " BACKUP_PASSPHRASE; echo
if (( ${#BACKUP_PASSPHRASE} < 12 )); then echo "备份口令至少 12 位"; exit 1; fi
read -r -s -p "再次输入备份口令: " BACKUP_CONFIRM; echo
[[ "$BACKUP_PASSPHRASE" == "$BACKUP_CONFIRM" ]] || { echo "两次口令不一致"; exit 1; }

mkdir -p backups
chmod 0700 backups
BACKUP_FILE="backups/pre-update-$(date +%Y%m%d-%H%M%S).mpbak"
if ! printf '%s\n' "$BACKUP_PASSPHRASE" | docker compose exec -T app autoreply backup export > "$BACKUP_FILE"; then
  rm -f -- "$BACKUP_FILE"
  echo "升级前备份生成失败"
  exit 1
fi
chmod 0600 "$BACKUP_FILE"
if [[ ! -s "$BACKUP_FILE" ]]; then echo "升级前备份生成失败"; exit 1; fi
echo "升级前加密备份已生成：$BACKUP_FILE"

APP_CONTAINER=$(docker compose ps -q app || true)
WORKER_CONTAINER=$(docker compose ps -q worker || true)
OLD_IMAGE=$([[ -n "$APP_CONTAINER" ]] && docker inspect "$APP_CONTAINER" --format '{{.Image}}' 2>/dev/null || true)
OLD_WORKER_IMAGE=$([[ -n "$WORKER_CONTAINER" ]] && docker inspect "$WORKER_CONTAINER" --format '{{.Image}}' 2>/dev/null || true)
OLD_TAG="microsoft-mail-autoreply:rollback-$(date +%Y%m%d-%H%M%S)"
OLD_WORKER_TAG="microsoft-mail-autoreply:rollback-worker-$(date +%Y%m%d-%H%M%S)"
[[ -n "$OLD_IMAGE" ]] && docker tag "$OLD_IMAGE" "$OLD_TAG"
[[ -n "$OLD_WORKER_IMAGE" ]] && docker tag "$OLD_WORKER_IMAGE" "$OLD_WORKER_TAG"

UPDATE_OK=true
if [[ -d .git ]] && ! git pull --ff-only; then
  echo "拉取新版本失败。"
  UPDATE_OK=false
fi
if [[ "$UPDATE_OK" == true ]]; then
  NEW_APP_VERSION=""
  if [[ ! -f VERSION ]]; then
    echo "新版本缺少 VERSION 文件。"
    UPDATE_OK=false
  else
    NEW_APP_VERSION=$(tr -d '[:space:]' < VERSION)
  fi
  if [[ "$UPDATE_OK" == true && ! "$NEW_APP_VERSION" =~ ^[0-9]+\.[0-9]+$ ]]; then
    echo "新版本的 VERSION 文件格式无效。"
    UPDATE_OK=false
  elif [[ "$UPDATE_OK" == true ]] && grep -q '^APP_VERSION=' .env; then
    sed -i "s/^APP_VERSION=.*/APP_VERSION=$NEW_APP_VERSION/" .env
  elif [[ "$UPDATE_OK" == true ]]; then
    printf 'APP_VERSION=%s\n' "$NEW_APP_VERSION" >> .env
  fi
fi
if [[ "$UPDATE_OK" == true ]] && ! docker compose build; then
  echo "构建新镜像失败。"
  UPDATE_OK=false
fi
if [[ "$UPDATE_OK" == true ]] && ! docker compose run --rm migrate; then
  echo "数据库迁移失败。"
  UPDATE_OK=false
fi
if [[ "$UPDATE_OK" == true ]] && ! docker compose up -d; then
  echo "启动新版本失败。"
  UPDATE_OK=false
fi
HOST_PORT_VALUE=$(sed -n 's/^HOST_PORT=//p' .env | tail -n1)
HOST_PORT_VALUE=${HOST_PORT_VALUE:-8080}
if [[ "$UPDATE_OK" == true ]]; then
  HEALTHY=false
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$HOST_PORT_VALUE/health/ready" >/dev/null 2>&1; then
      HEALTHY=true
      break
    fi
    sleep 3
  done
  [[ "$HEALTHY" == true ]] || UPDATE_OK=false
fi
if [[ "$UPDATE_OK" != true ]]; then
  if grep -q '^APP_VERSION=' .env; then
    sed -i "s/^APP_VERSION=.*/APP_VERSION=$OLD_APP_VERSION/" .env
  fi
  if [[ -n "$OLD_IMAGE" ]]; then AUTOREPLY_IMAGE="$OLD_TAG" docker compose up -d --no-build --no-deps app; fi
  if [[ -n "$OLD_WORKER_IMAGE" ]]; then AUTOREPLY_IMAGE="$OLD_WORKER_TAG" docker compose up -d --no-build --no-deps worker; fi
  echo "升级健康检查失败，应用与 Worker 已恢复上一版本镜像。"
  echo "若数据库迁移不兼容，请使用升级前备份恢复：$BACKUP_FILE"
  exit 1
fi
echo "升级完成。上一版本镜像：$OLD_TAG"
