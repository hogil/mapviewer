#!/bin/bash
# 서버 버전 확인 스크립트

echo "🔍 서버 코드 버전 확인"
echo "======================"
echo ""

# 1. Git 최신 커밋 확인
echo "📋 최신 Git 커밋:"
git log -1 --oneline --no-decorate
echo ""

# 2. 변경된 파일 확인
echo "📝 변경된 파일:"
git status --short
echo ""

# 3. Python 캐시 확인
echo "🐍 Python 캐시 파일:"
find . -name "*.pyc" -o -name "__pycache__" | head -10
echo ""

# 4. 주요 파일의 수정 시간 확인
echo "📅 주요 파일 수정 시간:"
ls -lh api/main.py api/personal_colors.py js/main.js js/color-editor.js 2>/dev/null | awk '{print $6, $7, $8, $9}'
echo ""

# 5. color-legends.json 확인
echo "🎨 color-legends.json 수정 시간:"
if [ -f "logs/color-legends.json" ]; then
    ls -lh logs/color-legends.json | awk '{print $6, $7, $8, $9}'
    echo ""
    echo "modified 필드 확인:"
    grep -c '"modified"' logs/color-legends.json || echo "modified 필드 없음"
else
    echo "❌ logs/color-legends.json 파일 없음"
fi
echo ""

# 6. 실행 중인 프로세스 확인
echo "🔄 실행 중인 Python 프로세스:"
ps aux | grep -E "python.*api.main|uvicorn" | grep -v grep || echo "프로세스 없음"
echo ""

echo "✅ 확인 완료"
echo ""
echo "다음 단계:"
echo "1. 최신 코드가 맞는지 확인"
echo "2. Python 캐시 삭제: find . -type d -name '__pycache__' -exec rm -r {} +"
echo "3. 서버 완전 재시작"

