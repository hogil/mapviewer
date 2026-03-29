# Development Guide

L3 Tracker 개발 가이드입니다.

## 기술 스택

| 구분 | 기술 |
|------|------|
| Backend | FastAPI + Uvicorn (HTTPS) |
| Image Processing | pyvips (썸네일/피라미드), PIL (팔레트 패치) |
| Frontend | Vanilla JavaScript ES6+ (빌드 스텝 없음) |
| Rendering | Canvas 2D + WebGL2 |
| Auth | OneLogin python3-saml (SAML SP) |
| Storage | 파일 시스템 (JSON/PNG) |

## 프로젝트 구조

```
├─ api/                   # FastAPI 백엔드
│  ├─ main.py             # 엔트리포인트 + 전체 엔드포인트
│  ├─ config.py           # 환경변수/설정
│  ├─ thumbnail_service.py # pyvips 썸네일 생성
│  ├─ personal_colors.py  # PLTE 패치 (개인색)
│  ├─ composite_map.py    # Composite map 생성
│  ├─ composite_colors.py # Composite gradient
│  ├─ index_service.py    # 파일 인덱싱
│  ├─ search_service.py   # 검색
│  ├─ user_manager.py     # 사용자 관리
│  └─ cache_manager.py    # 캐시 관리
├─ js/                    # 프론트엔드 ES6 모듈
│  ├─ main.js             # WaferMapViewer 메인 컨트롤러
│  ├─ semiconductor-renderer.js # 이미지 피라미드 렌더러
│  ├─ grid.js             # 그리드 뷰
│  ├─ labels.js           # LabelManager (분류)
│  ├─ search.js           # 검색 UI
│  ├─ context-menu.js     # 컨텍스트 메뉴
│  ├─ chip-annotator.js   # Chip overlay/annotation
│  ├─ color-editor.js     # 색상 편집기
│  └─ utils.js            # 유틸리티
├─ css/style.css          # 스타일시트
├─ index.html             # SPA 진입점
├─ stats.html             # 통계 페이지
├─ start.ps1              # Windows 실행 (환경변수 포함)
├─ start.sh               # Ubuntu 실행 (환경변수 포함)
├─ cert/                  # SSL 인증서 (placeholder)
├─ logs/                  # 런타임 로그/설정
│  ├─ color-legends.json  # 개인색/composite 색상 저장
│  ├─ permissions.json    # 권한 (체계 1)
│  └─ users.json          # 사용자 (체계 2)
└─ docs/                  # 문서
```

## 설치 및 실행

```bash
pip install -r requirements.txt
python -m api.main               # HTTPS 서버 시작 (기본 포트 8443)
```

브라우저: `https://localhost:8443`

환경변수 튜닝이 필요하면 `start.ps1` (Windows) 또는 `start.sh` (Ubuntu)를 사용합니다.

## 엔드포인트 추가

기존 패턴을 따릅니다:

```python
@app.get("/api/your-endpoint")
async def your_endpoint(request: Request, param: str = Query(...)):
    login_id = _current_login_id(request)
    # 로직
    return JSONResponse({"status": "ok", "data": result})
```

필수 확인:
- **인증**: `_current_login_id(request)` 사용
- **비동기**: I/O 작업은 `await` / `run_in_executor`
- **에러 처리**: `JSONResponse` + 적절한 status_code
- **로깅**: 기존 pretty-table 로거 패턴 유지

## 이미지 처리 규칙

- 품질: Q=100 (변경 금지)
- 썸네일: `ThumbnailService` 사용 (pyvips)
- Pyramid: `PYRAMID_LEVELS` / `PYRAMID_KERNEL` 설정 기준
- `VIPS_CONCURRENCY=1` (웹서버에서 필수)

## 캐싱 패턴

```python
# ETag + Cache-Control (기존 /api/image 참고)
etag = f'"{file_hash}"'
if request.headers.get("if-none-match") == etag:
    return Response(status_code=304)
return Response(content=data, headers={
    "ETag": etag,
    "Cache-Control": "public, max-age=86400"
})
```

현재 캐시 정책:
- `/api/image`, `/api/thumbnail`: `no-store`
- 피라미드 이미지: `max-age=31536000, immutable`
- 개인색/필터: 캐시 경로 자체를 분리 (scheme + lastModified + filter token)

## 코드 스타일

| 언어 | 규칙 |
|------|------|
| Python | PEP 8, 4-space indent, `snake_case` 함수, `CamelCase` 클래스 |
| JavaScript | ES6+, `camelCase` API, hyphenated 파일명 |

## 커밋 컨벤션

```
feat: 새로운 기능
fix: 버그 수정
refactor: 리팩토링
perf: 성능 개선
docs: 문서
test: 테스트
chore: 빌드/도구
```

## Worker 제약

- `UVICORN_WORKERS=1` (중복 인덱싱 방지, 필수)
- 동시성은 `IO_THREADS`, `THUMBNAIL_SEM`으로 조절
- `RELOAD=1`로 개발 시 자동 리로드

## 서버 시작 규칙 (Non-blocking)

- `lifespan`의 `yield` 전에는 최소한의 필수 초기화만 수행
- 인덱스 캐시 로드, 빌드, cleanup 등 무거운 작업은 `asyncio.create_task`로 백그라운드 실행
- CPU/IO 집약적 작업은 `loop.run_in_executor` 사용
- 서버는 인덱스 빌드 완료와 무관하게 즉시 요청 처리 가능해야 함
