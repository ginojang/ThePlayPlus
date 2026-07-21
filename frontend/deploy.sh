#!/usr/bin/env bash
# ThePlayPlus 프런트엔드 배포 스크립트
# 로컬에서 빌드한 dist/ 를 EC2(EldaFront)의 nginx 웹루트로 rsync 한다.
#
# 사용법:
#   npm run build && bash ./deploy.sh      # 또는  npm run deploy
#
# 전제:
#   - ~/.ssh/config 에 Host EldaFront 정의되어 있어야 함
#   - 서버에 /var/www/theplayplus/ 가 ec2-user 소유로 존재해야 함
set -euo pipefail

SSH_HOST="${SSH_HOST:-EldaFront}"
REMOTE_DIR="${REMOTE_DIR:-/var/www/theplayplus/}"
LOCAL_DIR="dist/"

if [ ! -d "$LOCAL_DIR" ]; then
  echo "❌ $LOCAL_DIR 가 없습니다. 먼저 'npm run build' 를 실행하세요." >&2
  exit 1
fi

echo "▶ 배포: $LOCAL_DIR  ->  $SSH_HOST:$REMOTE_DIR"

# --delete: 서버의 옛 파일 제거해서 dist 와 정확히 일치시킴 (Vite 해시 파일 누적 방지)
rsync -avz --delete \
  -e "ssh -o ConnectTimeout=10" \
  "$LOCAL_DIR" "$SSH_HOST:$REMOTE_DIR"

echo "✅ 배포 완료 → https://elda-ai.org/theplayplus/"
