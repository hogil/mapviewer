# FTP 배포 체크리스트 (폐쇄망)

## 📋 전송해야 할 파일 목록

### 1. Python 백엔드 파일
- `api/main.py` ✅ (썸네일 폴더 구조, modified 필드 비교 로직)
- `api/personal_colors.py` ✅ (modified 필드 초기값 설정)

### 2. JavaScript 프론트엔드 파일
- `js/main.js` ✅ (showInitialState, showColorLegends, shortenLabel)
- `js/color-editor.js` ✅ (검색 리스트에 (default) 표시)

### 3. 설정 파일
- `logs/color-legends.json` ✅ **중요!** (modified 필드가 추가된 파일)

### 4. HTML 파일 (필요시)
- `index.html` (변경사항 없으면 생략 가능)

## 🚀 FTP 전송 후 서버 작업 순서

### 1. Python 캐시 삭제
```bash
# Linux/Mac
find . -type d -name "__pycache__" -exec rm -r {} + 2>/dev/null
find . -type f -name "*.pyc" -delete 2>/dev/null

# Windows PowerShell
Get-ChildItem -Path . -Include __pycache__ -Recurse -Directory | Remove-Item -Recurse -Force
Get-ChildItem -Path . -Include *.pyc -Recurse -File | Remove-Item -Force
```

### 2. 파일 권한 확인 (Linux/Mac)
```bash
chmod 644 api/main.py api/personal_colors.py js/main.js js/color-editor.js
chmod 644 logs/color-legends.json
```

### 3. 서버 완전 재시작
```bash
# 1. 기존 프로세스 종료
pkill -f "python.*api.main"  # Linux/Mac
# 또는 taskkill /F /IM python.exe (Windows)

# 2. 재시작
python -m api.main
```

## ✅ 전송 후 확인 사항

### 1. 파일 수정 시간 확인
```bash
# 서버에서 실행
ls -lh api/main.py api/personal_colors.py js/main.js js/color-editor.js logs/color-legends.json
```

### 2. color-legends.json 확인
```bash
# modified 필드가 있는지 확인
grep -c '"modified"' logs/color-legends.json
# 결과: 8개 이상이어야 함 (default 제외한 모든 scheme)
```

### 3. Python 파일 내용 확인
```bash
# main.py에서 modified 필드 비교 로직 확인
grep -A 5 "normalize_color_dict" api/main.py

# personal_colors.py에서 modified 초기값 확인
grep -A 2 "modified.*false" api/personal_colors.py
```

### 4. JavaScript 파일 내용 확인
```bash
# main.js에서 shortenLabel 함수 확인
grep -A 10 "shortenLabel" js/main.js

# color-editor.js에서 (default) 표시 확인
grep -A 3 "(default)" js/color-editor.js
```

## 🔍 문제 해결

### 문제: 초기화면에 상단 color가 없음
- **원인**: `js/main.js`의 `showInitialState()` 함수가 업데이트되지 않음
- **해결**: `js/main.js` 파일 재전송 + 브라우저 캐시 강제 새로고침 (Ctrl+Shift+R)

### 문제: "nor"이 "border"로 나옴
- **원인**: `logs/color-legends.json`의 bottom에 "Border" 키가 있거나, `js/main.js`의 `shortenLabel` 함수가 업데이트되지 않음
- **해결**: 
  1. `logs/color-legends.json`에서 "Border" 키 확인 (있으면 "Normal"로 변경)
  2. `js/main.js` 파일 재전송
  3. 브라우저 캐시 강제 새로고침

### 문제: modified 필드가 작동하지 않음
- **원인**: `api/main.py`의 색상 비교 로직이 업데이트되지 않음
- **해결**: `api/main.py` 파일 재전송 + Python 캐시 삭제 + 서버 재시작

## 📝 FTP 전송 팁

1. **이진 모드로 전송**: 텍스트 파일도 이진 모드로 전송 (줄바꿈 문자 보존)
2. **전송 순서**: 
   - Python 파일 먼저
   - JavaScript 파일
   - color-legends.json 마지막
3. **전송 후 즉시 확인**: 각 파일 전송 후 수정 시간 확인
4. **백업**: 전송 전 기존 파일 백업 권장

