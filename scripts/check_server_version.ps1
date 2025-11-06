# 서버 버전 확인 스크립트 (PowerShell)

Write-Host "🔍 서버 코드 버전 확인" -ForegroundColor Cyan
Write-Host "======================" -ForegroundColor Cyan
Write-Host ""

# 1. Git 최신 커밋 확인
Write-Host "📋 최신 Git 커밋:" -ForegroundColor Yellow
git log -1 --oneline --no-decorate
Write-Host ""

# 2. 변경된 파일 확인
Write-Host "📝 변경된 파일:" -ForegroundColor Yellow
git status --short
Write-Host ""

# 3. Python 캐시 확인
Write-Host "🐍 Python 캐시 파일 (최대 10개):" -ForegroundColor Yellow
Get-ChildItem -Path . -Include __pycache__,*.pyc -Recurse -ErrorAction SilentlyContinue | Select-Object -First 10 FullName
Write-Host ""

# 4. 주요 파일의 수정 시간 확인
Write-Host "📅 주요 파일 수정 시간:" -ForegroundColor Yellow
$files = @("api/main.py", "api/personal_colors.py", "js/main.js", "js/color-editor.js")
foreach ($file in $files) {
    if (Test-Path $file) {
        $info = Get-Item $file
        Write-Host "$($info.LastWriteTime) - $file"
    }
}
Write-Host ""

# 5. color-legends.json 확인
Write-Host "🎨 color-legends.json 수정 시간:" -ForegroundColor Yellow
$legendsPath = "logs/color-legends.json"
if (Test-Path $legendsPath) {
    $info = Get-Item $legendsPath
    Write-Host "$($info.LastWriteTime) - $legendsPath"
    Write-Host ""
    Write-Host "modified 필드 확인:"
    $content = Get-Content $legendsPath -Raw
    $count = ([regex]::Matches($content, '"modified"')).Count
    if ($count -gt 0) {
        Write-Host "✅ modified 필드 $count 개 발견" -ForegroundColor Green
    } else {
        Write-Host "❌ modified 필드 없음" -ForegroundColor Red
    }
} else {
    Write-Host "❌ logs/color-legends.json 파일 없음" -ForegroundColor Red
}
Write-Host ""

# 6. 실행 중인 프로세스 확인
Write-Host "🔄 실행 중인 Python 프로세스:" -ForegroundColor Yellow
$processes = Get-Process | Where-Object { $_.ProcessName -like "*python*" -and $_.CommandLine -like "*api.main*" } -ErrorAction SilentlyContinue
if ($processes) {
    $processes | ForEach-Object { Write-Host "PID: $($_.Id) - $($_.ProcessName)" }
} else {
    Write-Host "프로세스 없음 (또는 권한 부족)"
}
Write-Host ""

Write-Host "✅ 확인 완료" -ForegroundColor Green
Write-Host ""
Write-Host "다음 단계:" -ForegroundColor Cyan
Write-Host "1. 최신 코드가 맞는지 확인"
Write-Host "2. Python 캐시 삭제"
Write-Host "3. 서버 완전 재시작"

