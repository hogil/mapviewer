# L3 Tracker – Wafer Map Viewer & Analyzer

<div align="center">
  <img src="https://img.shields.io/badge/version-2.0.0-blue.svg" />
  <img src="https://img.shields.io/badge/python-3.8%2B-green.svg" />
  <img src="https://img.shields.io/badge/javascript-ES6%2B-yellow.svg" />
  <img src="https://img.shields.io/badge/license-MIT-purple.svg" />
</div>

## Overview

L3 Tracker는 대규모 반도체 웨이퍼 이미지를 실시간으로 탐색·분석할 수 있도록 설계된 웹 애플리케이션입니다. 수천만 픽셀의 웨이퍼를 자동으로 피라미드화하여 빠르게 조회하고, GPU 가속 렌더러와 AI 분류 모델을 동시에 활용할 수 있습니다.

### 주요 특징

- **PNG level-3 + cubic 리샘플 피라미드** – pyvips 기반, 품질과 속도를 모두 확보
- **썸네일/프리패치 파이프라인** – 서버·클라이언트 동시 병렬 처리, 환경변수로 튜닝 가능
- **폴더 범위 제한 검색** – 정렬 인덱스와 비동기 스캔으로 현재 선택 폴더만 즉시 검색
- **AI 자동 분류(옵션)** – ResNet50 기반 웨이퍼 패턴 분류 (정확도 95% 이상)
- **풍부한 캐시 계층** – 썸네일/피라미드/인덱스 캐시를 통한 재 방문 속도 향상

## Project Structure

```
├─ api/                   # FastAPI backend
│  ├─ main.py             # 라우팅, 검색, 피라미드, 구성 로직
│  ├─ config.py           # 모든 환경변수 → 앱 설정
│  └─ thumbnail_service.py
├─ js/                    # 프론트엔드 ES6 코드
│  ├─ main.js             # UI & 데이터 흐름 (WaferMapViewer)
│  ├─ labels.js           # 라벨 관리 (LabelManager)
│  └─ semiconductor-renderer.js  # GPU 렌더러
├─ index.html             # SPA 진입점
├─ start.ps1              # Windows 11 개발 환경 스타터
├─ start.sh               # Ubuntu 24 운영 환경 스타터
├─ scripts/               # 벤치마크 및 유틸리티 스크립트
├─ docs/archive/          # 성능 분석 및 벤치마크 결과 아카이브
├─ ARCHITECTURE.md        # 시스템 구성 설명
├─ ENVIRONMENT_SETUP.md   # 환경 변수 설정 가이드
├─ CLAUDE.md              # Claude Code 작업 가이드
├─ CHANGELOG.md           # 버전별 변경 사항
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
   git clone https://github.com/yourusername/l3tracker.git
   cd l3tracker
   ```
2. Python 의존성 설치
   ```bash
   pip install -r requirements.txt
   ```
3. (선택) 추가 도구 설치  
   GPU 또는 AI 기능을 사용할 경우 `ENVIRONMENT_SETUP.md` 참고
4. 개발 환경 실행
   ```powershell
   ./start.ps1
   ```
5. 운영 환경 실행
   ```bash
   ./start.sh
   ```
6. 브라우저에서 접속  
   기본 주소는 `http://localhost:8080`

## Documentation

- **시스템 구성**: `ARCHITECTURE.md` - API와 썸네일/피라미드 처리 흐름
- **환경 설정**: `ENVIRONMENT_SETUP.md` - 환경 변수 및 성능 튜닝 가이드
- **개발 가이드**: `CLAUDE.md` - Claude Code 작업 시 참고 문서
- **성능 분석**: `docs/archive/` - 벤치마크 결과 및 최적화 히스토리

## History

- 모든 변경 사항은 [CHANGELOG.md](CHANGELOG.md) 참조
- 최근 핵심 업데이트
  - 검색 인덱스 정렬 및 비동기 병렬화 → 현재 폴더만 빠르게 검색
  - 썸네일/피라미드 PNG level-3 + cubic 리샘플 통일
  - Windows/Ubuntu 각각에 맞춘 스타트 스크립트와 환경변수 노출

## API Snapshot

| Method | Path              | 설명                    |
|--------|-------------------|-------------------------|
| GET    | `/api/files`      | 현재 폴더 목록          |
| GET    | `/api/image`      | 원본/피라미드 이미지    |
| GET    | `/api/thumbnail`  | 썸네일 생성/제공        |
| POST   | `/api/thumbnail/preload` | 썸네일 배치 프리패치 |
| GET    | `/api/config`     | 프론트 설정 정보        |
| GET    | `/api/search`     | 현재 폴더 범위 검색     |
| POST   | `/api/classify`   | AI 분류 (옵션)          |

## Contributing

1. Fork the project  
2. Feature 브랜치 생성 `git checkout -b feat/my-feature`
3. 변경 사항 커밋 `git commit -m 'feat: add my feature'`
4. 원격 브랜치 푸시 `git push origin feat/my-feature`  
5. Pull Request 생성

## License

MIT License – 자세한 내용은 [LICENSE](LICENSE) 참고

## Support

- 프로젝트 문의: support@l3tracker.com
- 버그/기능 제안: GitHub Issues 활용
