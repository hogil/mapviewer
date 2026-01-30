# L3 Tracker – Wafer Map Viewer & Analyzer

<div align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-blue.svg" />
  <img src="https://img.shields.io/badge/python-3.8%2B-green.svg" />
  <img src="https://img.shields.io/badge/javascript-ES6%2B-yellow.svg" />
  <img src="https://img.shields.io/badge/backend-FastAPI-green.svg" />
</div>

## Overview

L3 Tracker(=Wafer Map Viewer)는 대규모 반도체 웨이퍼 맵 이미지를 **초고속으로 탐색(줌/팬)** 하고,
**개인색(palette) / Composite / 클립보드 복사 / Chip 오버레이/라벨링** 같은 업무 기능을 빠르게 제공하는 웹 애플리케이션입니다.

### 주요 특징

- **Pyramid(level) 기반 렌더링**: `/api/image?path=...&level=...` 로 필요한 해상도만 전송/캐시
- **썸네일/프리패치 파이프라인**: 서버·클라이언트 동시 병렬 처리, 환경변수로 튜닝 가능
- **개인색(팔레트) 적용**: PNG 팔레트(PLTE)만 패치하여 빠르게 색상 변경
- **Composite Map**: 다수 맵을 집계/합성해 히트맵 생성
- **Chip 오버레이/선택/라벨링**: overlay canvas 기반으로 빠른 UI 피드백

---

## 왜 이렇게 빠른가 (핵심 설계)

### 1) 서버: 피라미드(해상도 레벨) + 디스크 캐시 + 백그라운드 생성

- 단일 뷰는 원본 전체를 매번 내려받지 않고, **피라미드 레벨**을 요청합니다.
- 생성된 피라미드는 디스크에 캐시되고, 응답은 `Cache-Control: immutable` + `ETag` 로 브라우저 캐시가 강하게 동작합니다.
- 첫 요청 레벨만 즉시 생성하고, 나머지 레벨은 `asyncio` 로 백그라운드에서 미리 생성합니다.

관련 코드: `api/main.py` (`GET /api/image`)

### 2) 썸네일: pyvips(스트리밍) + (옵션) TurboJPEG + 동시성 제어

- `pyvips`의 `access="sequential"` 로 스트리밍 I/O를 활용합니다.
- JPEG 인코딩은 (옵션) TurboJPEG를 사용해 CPU 시간을 줄입니다.
- 서버는 `THUMBNAIL_SEM` 세마포어로 동시 생성을 제한해 과부하를 방지합니다.

관련 코드: `api/thumbnail_service.py`, `api/cache_manager.py`

### 3) 개인색/필터: “재렌더링”이 아니라 “PLTE만 패치”

- 팔레트(P) PNG는 **픽셀(IDAT) 재압축 없이** PLTE 청크만 수정하면 색을 바꿀 수 있습니다.
- 이 방식은 CPU/지연을 크게 줄이고, 사용자별 scheme 캐시도 충돌 없이 관리합니다.

관련 코드: `api/personal_colors.py`, `api/main.py`

### 4) 클라이언트: Vanilla JS + Canvas/WebGL2 + 프레임 친화 스케줄링

- ES6 모듈 기반 Vanilla JS로 동작해 런타임 오버헤드가 적습니다.
- 렌더는 Canvas 2D/WebGL2로 수행하며, 작업은 `rAF`/`requestIdleCallback` 기반 큐로 분산해 프레임 드랍을 최소화합니다.

관련 코드: `js/semiconductor-renderer.js`, `js/render-optimizer.js`, `js/main.js`

---

## 편의 기능 구현 포인트

- **개인색(Color Scheme)**: `logs/color-legends.json` 저장 → 서버가 PLTE만 패치해 즉시 반영 (`api/personal_colors.py`, `js/color-editor.js`)
- **Composite Map / Subset**: numpy/numba(+옵션 Cython) 집계 + 병렬 워커 (`api/composite_map.py`)
- **컨텍스트 메뉴 복사/합성**: 보이는 영역만 합성해서 Clipboard API로 복사 (`js/context-menu.js`)
- **Chip 오버레이/선택**: overlay canvas 기반 렌더 (`js/chip-annotator.js`)
- **라벨/분류**: 가능한 경우 하드링크로 I/O 최소화 (`api/main.py` `/api/classify*`)

## Project Structure

```
├─ api/                   # FastAPI backend (image/pyramid/thumbnail/search/composite)
├─ js/                    # 프론트엔드 ES6 모듈 (번들러 없이 index.html에서 로드)
├─ index.html             # SPA 진입점
├─ start.ps1              # Windows 개발 환경 스타터
├─ start.sh               # Ubuntu/Linux 실행 스크립트
├─ scripts/               # 벤치마크 및 유틸리티 스크립트
├─ docs/                  # 설계/성능 문서
├─ docs/archive/          # 벤치마크 결과 및 최적화 히스토리
├─ ARCHITECTURE.md        # 시스템 구성 설명
├─ CHIP_ANNOTATION.md     # Chip 주석/좌표 설명
└─ README.md
```

## Environment & Deployment

| 구분               | CPU/RAM        | 실행 스크립트 | 주요 환경 변수                                       |
|-------------------|---------------|---------------|------------------------------------------------------|
| **개발 (Windows)**| 8C / 64 GB     | `./start.ps1` | `THUMB_PREFETCH_BATCH=24`, `THUMB_CLIENT_MAX_CONCURRENCY=8`, `VIPS_CONCURRENCY=4` |
| **운영 (Ubuntu)** | 32C / 192 GB   | `./start.sh`  | `THUMB_PREFETCH_BATCH=64`, `THUMB_CLIENT_MAX_CONCURRENCY=12`, `VIPS_CONCURRENCY=24` |
| **클라이언트**    | 6C / 32 GB     | 웹 브라우저   | `/api/config` 로 전달된 값 적용 (기본 24/12)         |

> 운영 서버의 코어·RAM이 더 높다면 `start.sh` 상단의 주석에 따라 `IO_THREADS`, `THUMBNAIL_SEM`, `VIPS_CONCURRENCY` 등을 확장한 뒤 `/api/config` 응답을 확인하세요.

### 설치 및 실행

1. 저장소 클론
   ```bash
   git clone https://github.com/hogil/mapviewer.git
   cd mapviewer
   ```
2. Python 의존성 설치
   ```bash
   pip install -r requirements.txt
   ```
3. 개발 환경 실행
   ```powershell
   ./start.ps1
   ```
4. 운영 환경 실행
   ```bash
   ./start.sh
   ```
5. 브라우저에서 접속  
   기본 주소는 `http://localhost:8080`

## Documentation

- **시스템 구성**: `ARCHITECTURE.md`
- **칩 주석/좌표**: `CHIP_ANNOTATION.md`
- **성능 분석/벤치마크**: `docs/`, `docs/archive/`

## API Snapshot

| Method | Path              | 설명                    |
|--------|-------------------|-------------------------|
| GET    | `/api/files`      | 현재 폴더 목록          |
| GET    | `/api/image`      | 원본/피라미드 이미지    |
| GET    | `/api/thumbnail`  | 썸네일 생성/제공        |
| POST   | `/api/thumbnail/preload` | 썸네일 배치 프리패치 |
| GET    | `/api/config`     | 프론트 설정 정보        |
| GET    | `/api/search`     | 현재 폴더 범위 검색     |
| POST   | `/api/classify`   | 라벨/분류               |
| POST   | `/api/composite-map` | Composite map 생성(비동기) |
| GET    | `/api/composite-map/status/{task_id}` | Composite 진행상태 |

## Note

- 예전 README에 있던 `ENVIRONMENT_SETUP.md`, `CHANGELOG.md`, `LICENSE` 는 현재 레포에 없어서 링크가 깨질 수 있습니다. 최신 튜닝/히스토리는 `docs/`, `docs/archive/` 를 기준으로 보시면 됩니다.
