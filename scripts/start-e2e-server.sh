#!/bin/bash
# E2E 테스트용 서버 시작 스크립트
# 사용법: bash scripts/start-e2e-server.sh [PORT]
# 결과: 서버가 준비되면 "READY:{PORT}" 출력, 실패 시 "FAIL" 출력

PORT=${1:-8443}
MAX_WAIT=20

# 1. 기존 Python 프로세스 전체 종료
taskkill //F //IM python.exe 2>/dev/null
sleep 3

# 2. 포트 해제 대기
for i in 1 2 3 4 5; do
  if ! netstat -an | grep ":${PORT} " | grep -q LISTEN; then
    break
  fi
  sleep 2
done

# 3. 아직 점유 중이면 다음 포트
if netstat -an | grep ":${PORT} " | grep -q LISTEN; then
  PORT=$((PORT + 1))
fi

# 4. 서버 시작 (백그라운드)
cd "$(dirname "$0")/.." || exit 1
HTTPS_PORT=$PORT python -m api.main &>/dev/null &

# 5. LISTENING 확인 (최대 MAX_WAIT초)
for i in $(seq 1 $MAX_WAIT); do
  sleep 1
  if netstat -an | grep ":${PORT} " | grep -q LISTEN; then
    # 6. 실제 HTTP 응답 확인
    if curl -sk -o /dev/null -w "%{http_code}" "https://localhost:${PORT}/" 2>/dev/null | grep -q "200"; then
      echo "READY:${PORT}"
      exit 0
    fi
  fi
done

echo "FAIL"
exit 1
