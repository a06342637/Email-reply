#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT_DIR"
if [[ ! -f .env ]]; then
  echo "找不到 .env，请先安装系统。"
  exit 1
fi
if [[ ! -d .git ]]; then
  echo "在线或脚本升级需要完整的 Git 仓库。"
  exit 1
fi

OFFICIAL_REPOSITORY="https://github.com/a06342637/Email-reply"
normalize_repository_url() {
  local value=${1,,}
  value=${value%/}
  value=${value%.git}
  value=${value%/}
  if [[ "$value" == git@github.com:* ]]; then
    value="https://github.com/${value#*:}"
  fi
  printf '%s' "$value"
}

ORIGIN_URL=$(git remote get-url origin 2>/dev/null || true)
if [[ $(normalize_repository_url "$ORIGIN_URL") != $(normalize_repository_url "$OFFICIAL_REPOSITORY") ]]; then
  echo "Git origin 不是允许的官方仓库，已拒绝升级：${ORIGIN_URL:-未配置}"
  exit 1
fi
CURRENT_BRANCH=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)
if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "升级只能在 main 主分支执行；当前状态：${CURRENT_BRANCH:-detached HEAD}"
  exit 1
fi
if [[ -n $(git status --porcelain --untracked-files=all) ]]; then
  echo "项目目录存在未提交改动。为防止覆盖文件，升级已停止。"
  exit 1
fi

set_env_value() {
  local key=$1
  local value=$2
  local temporary
  temporary=$(mktemp "${ROOT_DIR}/.env.update.XXXXXX")
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    index($0, key "=") == 1 { print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' .env > "$temporary"
  chmod 0600 "$temporary"
  mv -f -- "$temporary" .env
}

if ! grep -q '^PROJECT_DIR=' .env || [[ -z $(sed -n 's/^PROJECT_DIR=//p' .env | tail -n1) ]]; then
  set_env_value PROJECT_DIR "$ROOT_DIR"
fi
CURRENT_UPDATER_TOKEN=$(sed -n 's/^UPDATER_TOKEN=//p' .env | tail -n1)
if ! grep -q '^UPDATER_TOKEN=' .env || (( ${#CURRENT_UPDATER_TOKEN} < 32 )); then
  set_env_value UPDATER_TOKEN "$(openssl rand -hex 32)"
fi

OLD_APP_VERSION=$(sed -n 's/^APP_VERSION=//p' .env | tail -n1)
OLD_APP_VERSION=${OLD_APP_VERSION:-0.01}
OLD_COMMIT=$(git rev-parse HEAD)
OLD_ENV=$(mktemp "${ROOT_DIR}/.env.rollback.XXXXXX")
cp -- .env "$OLD_ENV"
chmod 0600 "$OLD_ENV"
cleanup() { rm -f -- "$OLD_ENV"; }
trap cleanup EXIT

echo "正在检查官方正式版本标签..."
git fetch --force --prune --prune-tags --tags origin \
  "+refs/heads/main:refs/remotes/origin/main"
LATEST_TAG=$(git tag --list 'v[0-9]*.[0-9]*' --sort=-version:refname | head -n1)
if [[ -z "$LATEST_TAG" ]]; then
  echo "没有找到正式版本标签。"
  exit 1
fi
TARGET_COMMIT=$(git rev-list -n1 "$LATEST_TAG")
git merge-base --is-ancestor "$TARGET_COMMIT" origin/main || {
  echo "最新版本标签不在 main 主分支，已拒绝升级。"
  exit 1
}
NEW_APP_VERSION=$(git show "$TARGET_COMMIT:VERSION" | tr -d '[:space:]')
if [[ ! "$NEW_APP_VERSION" =~ ^[0-9]+\.[0-9]+$ || "v$NEW_APP_VERSION" != "$LATEST_TAG" ]]; then
  echo "版本标签与 VERSION 文件不一致。"
  exit 1
fi
if [[ "$NEW_APP_VERSION" == "$OLD_APP_VERSION" ]]; then
  echo "当前已经是最新版本 v$OLD_APP_VERSION。"
  exit 0
fi
if [[ $(printf '%s\n%s\n' "$OLD_APP_VERSION" "$NEW_APP_VERSION" | sort -V | tail -n1) != "$NEW_APP_VERSION" ]]; then
  echo "拒绝从 v$OLD_APP_VERSION 降级到 v$NEW_APP_VERSION。"
  exit 1
fi

# 非交互升级：通过 BACKUP_PASSPHRASE 环境变量提供口令，跳过两次输入确认。
if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  if (( ${#BACKUP_PASSPHRASE} < 12 )); then
    echo "备份口令至少 12 位"
    exit 1
  fi
else
  if [[ ! -t 0 ]]; then
    echo "标准输入不是终端，无法读取备份口令。"
    echo "非交互升级请通过 BACKUP_PASSPHRASE 环境变量提供至少 12 位口令。"
    exit 1
  fi
  read -r -s -p "升级前加密备份口令（至少 12 位）: " BACKUP_PASSPHRASE
  echo
  if (( ${#BACKUP_PASSPHRASE} < 12 )); then
    echo "备份口令至少 12 位"
    exit 1
  fi
  read -r -s -p "再次输入备份口令: " BACKUP_CONFIRM
  echo
  [[ "$BACKUP_PASSPHRASE" == "$BACKUP_CONFIRM" ]] || {
    echo "两次口令不一致"
    exit 1
  }
fi

mkdir -p backups
chmod 0700 backups
BACKUP_FILE="backups/pre-update-$(date +%Y%m%d-%H%M%S).mpbak"
if ! printf '%s\n' "$BACKUP_PASSPHRASE" | docker compose exec -T app autoreply backup export > "$BACKUP_FILE"; then
  rm -f -- "$BACKUP_FILE"
  echo "升级前备份生成失败"
  exit 1
fi
chmod 0600 "$BACKUP_FILE"
if [[ ! -s "$BACKUP_FILE" ]]; then
  rm -f -- "$BACKUP_FILE"
  echo "升级前备份为空"
  exit 1
fi
unset BACKUP_PASSPHRASE BACKUP_CONFIRM
echo "升级前加密备份已生成：$BACKUP_FILE"

APP_CONTAINER=$(docker compose ps -q app || true)
WORKER_CONTAINER=$(docker compose ps -q worker || true)
UPDATER_CONTAINER=$(docker compose ps -q updater || true)
OLD_IMAGE=$([[ -n "$APP_CONTAINER" ]] && docker inspect "$APP_CONTAINER" --format '{{.Image}}' 2>/dev/null || true)
OLD_WORKER_IMAGE=$([[ -n "$WORKER_CONTAINER" ]] && docker inspect "$WORKER_CONTAINER" --format '{{.Image}}' 2>/dev/null || true)
OLD_UPDATER_IMAGE=$([[ -n "$UPDATER_CONTAINER" ]] && docker inspect "$UPDATER_CONTAINER" --format '{{.Image}}' 2>/dev/null || true)
if [[ -z "$OLD_IMAGE" || "$OLD_IMAGE" != "$OLD_WORKER_IMAGE" ]]; then
  echo "app 与 worker 当前镜像状态异常，已停止升级。"
  exit 1
fi
ROLLBACK_STAMP=$(date +%Y%m%d-%H%M%S)
OLD_TAG="microsoft-mail-autoreply:rollback-$ROLLBACK_STAMP"
OLD_UPDATER_TAG="microsoft-mail-autoreply-updater:rollback-$ROLLBACK_STAMP"
docker tag "$OLD_IMAGE" "$OLD_TAG"
[[ -n "$OLD_UPDATER_IMAGE" ]] && docker tag "$OLD_UPDATER_IMAGE" "$OLD_UPDATER_TAG"

UPDATE_OK=true
SERVICES_TOUCHED=false
if ! git merge --ff-only "$TARGET_COMMIT"; then
  echo "无法快进到正式版本 $LATEST_TAG。"
  UPDATE_OK=false
fi
if [[ "$UPDATE_OK" == true ]]; then
  set_env_value APP_VERSION "$NEW_APP_VERSION"
fi
if [[ "$UPDATE_OK" == true ]] && ! docker compose build app worker migrate updater; then
  echo "构建新镜像失败。"
  UPDATE_OK=false
fi
if [[ "$UPDATE_OK" == true ]]; then
  SERVICES_TOUCHED=true
  if ! docker compose stop app worker; then
    echo "停止旧版本服务失败。"
    UPDATE_OK=false
  fi
fi
if [[ "$UPDATE_OK" == true ]] && ! docker compose run --rm migrate; then
  echo "数据库迁移失败。"
  UPDATE_OK=false
fi
if [[ "$UPDATE_OK" == true ]] && ! docker compose up -d --no-build --no-deps --force-recreate app worker updater; then
  echo "启动新版本失败。"
  UPDATE_OK=false
fi

HOST_PORT_VALUE=$(sed -n 's/^HOST_PORT=//p' .env | tail -n1)
HOST_PORT_VALUE=${HOST_PORT_VALUE:-8080}
if [[ "$UPDATE_OK" == true ]]; then
  HEALTHY=false
  for _ in $(seq 1 90); do
    UPDATER_CONTAINER=$(docker compose ps -q updater || true)
    UPDATER_HEALTH=$([[ -n "$UPDATER_CONTAINER" ]] && docker inspect "$UPDATER_CONTAINER" --format '{{.State.Health.Status}}' 2>/dev/null || true)
    if curl -fsS "http://127.0.0.1:$HOST_PORT_VALUE/health/ready" >/dev/null 2>&1 && [[ "$UPDATER_HEALTH" == healthy ]]; then
      HEALTHY=true
      break
    fi
    sleep 3
  done
  [[ "$HEALTHY" == true ]] || UPDATE_OK=false
fi

if [[ "$UPDATE_OK" != true ]]; then
  echo "升级失败，正在恢复升级前版本..."
  git reset --hard "$OLD_COMMIT" || true
  cp -- "$OLD_ENV" .env
  chmod 0600 .env
  if [[ "$SERVICES_TOUCHED" == true ]]; then
    AUTOREPLY_IMAGE="$OLD_TAG" \
      docker compose up -d --no-build --no-deps --force-recreate app worker || true
    if [[ -n "$OLD_UPDATER_IMAGE" ]]; then
      AUTOREPLY_UPDATER_IMAGE="$OLD_UPDATER_TAG" \
        docker compose up -d --no-build --no-deps --force-recreate updater || true
    fi
  fi
  echo "应用、Worker、升级器和项目代码已尝试恢复到升级前版本。"
  echo "如果新迁移与旧版本不兼容，请使用升级前备份恢复：$BACKUP_FILE"
  exit 1
fi

echo "升级完成：v$OLD_APP_VERSION → v$NEW_APP_VERSION"
echo "升级前备份：$BACKUP_FILE"
echo "上一版本镜像：$OLD_TAG"
