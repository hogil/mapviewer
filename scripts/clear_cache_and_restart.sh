#!/bin/bash
# 서버 캐시 정리 및 재시작 스크립트

echo "🧹 Python 캐시 정리 중..."
find . -type d -name "__pycache__" -exec rm -r {} + 2>/dev/null
find . -type f -name "*.pyc" -delete 2>/dev/null

echo "✅ 캐시 정리 완료"
echo ""
echo "다음 단계:"
echo "1. 서버를 완전히 종료하세요"
echo "2. 서버를 다시 시작하세요"
echo "3. 브라우저에서 Ctrl+Shift+R (또는 Ctrl+F5)로 강제 새로고침하세요"

