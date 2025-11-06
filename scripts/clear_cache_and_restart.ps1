# 서버 캐시 정리 및 재시작 스크립트 (PowerShell)

Write-Host "🧹 Python 캐시 정리 중..." -ForegroundColor Yellow

# __pycache__ 디렉토리 삭제
Get-ChildItem -Path . -Include __pycache__ -Recurse -Directory | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

# .pyc 파일 삭제
Get-ChildItem -Path . -Include *.pyc -Recurse -File | Remove-Item -Force -ErrorAction SilentlyContinue

Write-Host "✅ 캐시 정리 완료" -ForegroundColor Green
Write-Host ""
Write-Host "다음 단계:" -ForegroundColor Cyan
Write-Host "1. 서버를 완전히 종료하세요"
Write-Host "2. 서버를 다시 시작하세요"
Write-Host "3. 브라우저에서 Ctrl+Shift+R (또는 Ctrl+F5)로 강제 새로고침하세요"

