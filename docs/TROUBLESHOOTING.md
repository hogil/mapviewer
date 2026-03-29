# Troubleshooting Guide

L3 Tracker 문제 진단 및 해결 가이드입니다.

## 증상별 진단표

| 증상 | 카테고리 | 핵심 파일 |
|------|---------|----------|
| 이미지 안 나옴, 깨짐, 흰 화면 | 렌더링 | `js/semiconductor-renderer.js`, `api/main.py` |
| 색 안 맞음, 팔레트 문제 | 색상 | `api/personal_colors.py`, `js/color-editor.js`, `logs/color-legends.json` |
| BIN/Grade overlay 안 보임 | 오버레이 | `js/main.js`, `js/chip-annotator.js` |
| 필터 안 먹힘, 범례 클릭 무반응 | 필터 | `js/main.js`, `js/color-editor.js` |
| Composite 생성 실패, 색상 이상 | Composite | `api/composite_map.py`, `api/composite_colors.py` |
| 그리드/단일 전환 오류 | 그리드 | `js/grid.js`, `js/main.js` |
| 줌 깨짐, 레벨 전환 문제 | Pyramid | `js/semiconductor-renderer.js` |

## 서버 시작 문제

### 포트 충돌
```bash
# Windows
netstat -an | findstr :8443
# Ubuntu
netstat -tulpn | grep :8443
```

### SSL 인증서
- `cert/fullchain.pem`, `cert/server.key` 존재 확인
- 만료일: `openssl x509 -enddate -noout -in cert/fullchain.pem`

### Python 의존성
- Python 3.8+ 필요
- `pip install -r requirements.txt`

## 렌더링 문제

1. 브라우저 콘솔 에러 확인
2. `/api/image?path=...` 직접 호출로 API 응답 확인
3. Pyramid 레벨: `PYRAMID_LEVELS` 설정 확인 (`/api/config`에서 내려옴)
4. `semiconductor-renderer.js`의 `loadImage()` → `drawFrame()` 흐름 추적

## 색상 문제

1. `logs/color-legends.json` → 현재 저장된 색상 확인
2. 팔레트 인덱스 검증:
   - `0~7`: Grade0~7
   - `8`: background, `9`: text
   - `10`: Normal, `11`: Invalid
   - `12~17`: 00P BIN (B285~B291)
   - `18~23`: 00C BIN (B300~B390)
3. `personal_colors.py`의 `BIN_KEYS` 순서 vs `color-editor.js`의 `BOTTOM_KEYS` 순서 비교
4. loginId별 색상 분리: `_current_login_id()` 경로 추적

## 오버레이 문제

1. `positions.json` 파일 존재 확인 → `/api/chip-positions?path=...` 응답 확인
2. `chip-annotator.js` 초기화 에러 확인
3. BIN/Grade overlay 텍스트: chip 좌표가 post-transform인지 확인

## 필터 문제

1. `plte_bottom_filter_memory` BOTTOM_MAP 인덱스 일치 확인
2. Grade filter vs BIN filter 상호 배타 로직
3. overlay + filter 동시 작동 로직
4. 범례 클릭 → 칩 선택/해제 이벤트 흐름

## Composite Map 문제

1. positions 파일 필터링 로그: `[composite-map] positions 필터: N → M개`
2. `grade_counts` NPZ 캐시 존재 확인
3. square weighting: `grade^2` 계산 로직
4. Full vs Subset: `only_low_mask=None` 전달 필수
5. 11-point gradient 설정: `api/composite_colors.py`

## 그리드 문제

1. `gridMode` 상태 플래그 확인
2. grid ↔ single 전환: `savedViewState` 보존 여부
3. `labelSelection.selectedClasses` 클리어 타이밍
4. DOM class: `grid-mode` ↔ `single-image-mode`

## Pyramid 문제

1. 줌 레벨 → pyramid level 매핑 (`PYRAMID_ZOOM_THRESHOLDS`)
2. `requestIdleCallback` 비동기 생성 vs 즉시 생성 경로
3. ImageBitmap 업그레이드 상태
4. 메모리: canvas 해제 타이밍

## 배포 전 점검 체크리스트

### 코드 점검
- [ ] `console.log` / `print` / `debugger` 제거
- [ ] 민감 정보 커밋 여부 (`password`, `secret`, `api_key`, `token`)
- [ ] `cert/` — placeholder만 커밋 (실제 인증서 금지)
- [ ] SAML: `saml/settings.json`은 샘플 → 프로덕션은 Ubuntu 별도 설정
- [ ] 이미지 품질 Q=100 유지 확인

### 프로덕션 환경변수

| 변수 | 권장값 | 이유 |
|------|--------|------|
| `UVICORN_WORKERS` | 1 | 중복 인덱싱 방지 |
| `IO_THREADS` | 128 | 고부하 서버 |
| `THUMBNAIL_SEM` | 256 | 32코어 서버 |
| `VIPS_CONCURRENCY` | 1 | 스레드 충돌 방지 |
| `VIPS_DISC_THRESHOLD` | 10000m | 대용량 RAM |
| `VIPS_MAX_CACHE` | 10000 | 고성능 |
| `VIPS_MAX_CACHE_MEM` | 20000m | 대용량 RAM |
| `DIRLIST_CACHE_SIZE` | 8192 | 프로덕션 |
| `THUMB_STAT_CACHE_CAPACITY` | 32768 | 프로덕션 |
| `PYTHONUNBUFFERED` | 1 | 실시간 로그 |
| `MALLOC_ARENA_MAX` | 4 | 메모리 단편화 방지 |

### SSL/HTTPS
- [ ] `SSL_CERTFILE` 경로 확인
- [ ] `SSL_KEYFILE` 경로 확인
- [ ] 인증서 만료일 확인

### SAML (Ubuntu에서만)
- [ ] OneLogin 설정 프로덕션 환경 일치
- [ ] ACS URL이 실제 도메인/포트와 일치
- [ ] Windows에서 SAML 테스트하지 말 것
