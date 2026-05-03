# L3 Tracker – Wafer Map Viewer & Analyzer

## Overview

L3 Tracker는 대규모 반도체 웨이퍼 맵 이미지를 초고속으로 탐색(줌/팬)하고,
개인색(palette) / Composite / 클립보드 복사 / Chip 오버레이/라벨링 기능을 제공하는 웹 애플리케이션입니다.

### 주요 특징

- **Pyramid 기반 렌더링**: `/api/image?path=...&level=...`로 필요한 해상도만 전송/캐시
- **썸네일/프리패치 파이프라인**: 서버/클라이언트 동시 병렬 처리, 환경변수로 튜닝
- **개인색(팔레트) 적용**: PNG 팔레트(PLTE)만 패치하여 빠르게 색상 변경
- **Composite Map**: 다수 맵을 집계/합성해 히트맵 생성
- **Chip 오버레이/선택/라벨링**: overlay canvas 기반 UI

---

## 핵심 설계

### 1) 서버: 피라미드(해상도 레벨) + 디스크 캐시 + 백그라운드 생성

- 단일 뷰는 원본 전체를 내려받지 않고 **피라미드 레벨**을 요청
- 생성된 피라미드는 디스크에 캐시, 피라미드 응답은 `Cache-Control: immutable` + `ETag`
- 첫 요청 레벨만 즉시 생성, 나머지 레벨은 백그라운드에서 미리 생성

### 2) 썸네일: pyvips(스트리밍) + TurboJPEG(옵션) + 동시성 제어

- `pyvips`의 `access="sequential"`로 스트리밍 I/O 활용
- `THUMBNAIL_SEM` 세마포어로 동시 생성 제한

### 3) 개인색/필터: PLTE만 패치

- 팔레트(P) PNG는 IDAT 재압축 없이 PLTE 청크만 수정하여 색 변경
- 사용자별 scheme 캐시도 충돌 없이 관리

### 4) 클라이언트: Vanilla JS + Canvas/WebGL2

- ES6 모듈 기반 Vanilla JS, 런타임 오버헤드 최소
- Canvas 2D/WebGL2 렌더링, `rAF`/`requestIdleCallback` 기반 스케줄링

---

## Project Structure

```
├─ api/                   # FastAPI backend
├─ js/                    # 프론트엔드 ES6 모듈
├─ css/                   # 스타일시트
├─ docs/                  # 기능/운영 문서
├─ cert/                  # SSL 인증서 (placeholder)
├─ logs/                  # 런타임 로그/설정
├─ index.html             # SPA 진입점
├─ stats.html             # 통계 페이지
├─ start.ps1              # Windows 실행 스크립트
├─ start.sh               # Ubuntu 실행 스크립트
└─ README.md
```

## 설치 및 실행

```bash
git clone https://github.com/hogil/mapviewer.git
cd mapviewer
pip install -r requirements.txt
python -m api.main                # HTTPS 서버 (기본 포트 8443)
```

브라우저: `https://localhost:8443`

환경변수 튜닝이 필요하면:
- Windows: `./start.ps1`
- Ubuntu: `./start.sh`

## Environment

| 구분 | CPU/RAM | 실행 스크립트 | 주요 환경 변수 |
|------|---------|---------------|---------------|
| **개발 (Windows)** | 8C / 64 GB | `./start.ps1` | `VIPS_CONCURRENCY=4` |
| **운영 (Ubuntu)** | 32C / 192 GB | `./start.sh` | `VIPS_CONCURRENCY=24`, `IO_THREADS=128` |

## API Snapshot

| Method | Path | 설명 |
|--------|------|------|
| GET | `/api/files` | 현재 폴더 목록 |
| GET | `/api/image` | 원본/피라미드 이미지 |
| GET | `/api/thumbnail` | 썸네일 생성/제공 |
| POST | `/api/thumbnail/preload` | 썸네일 배치 프리패치 |
| GET | `/api/config` | 프론트 설정 정보 |
| GET | `/api/search` | 파일명 검색 |
| POST | `/api/classify` | 라벨/분류 |
| POST | `/api/composite-map` | Composite map 생성 (비동기) |
| GET | `/api/composite-map/status/{task_id}` | Composite 진행상태 |

전체 API 목록: [docs/API_REFERENCE.md](docs/API_REFERENCE.md)

## Documentation

| 문서 | 설명 |
|------|------|
| [docs/README.md](docs/README.md) | 문서 인덱스 |
| [docs/TECHNICAL_OVERVIEW.md](docs/TECHNICAL_OVERVIEW.md) | Frontend/Backend/Search 전체 기술 구성 요약 |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | 개발 가이드, 프로젝트 구조, 코드 스타일 |
| [docs/API_REFERENCE.md](docs/API_REFERENCE.md) | 전체 API 엔드포인트 목록 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 문제 진단 및 배포 점검 |
| [docs/IMAGE_PIPELINE.md](docs/IMAGE_PIPELINE.md) | 이미지/팔레트/positions 계약 |
| [docs/COMPOSITE_MAP.md](docs/COMPOSITE_MAP.md) | Composite map 기능 |
