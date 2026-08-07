# Docs Guide

`docs/` 문서는 현재 코드 기준 동작을 설명합니다. 구현 정본은 항상 코드이며, 문서는 코드에서 바로 유도되는 운영 규칙과 API 사용법만 남깁니다.

## 문서 맵

### 핵심 계약

| 문서 | 설명 |
|------|------|
| [IMAGE_PIPELINE.md](IMAGE_PIPELINE.md) | 이미지 응답, 팔레트 인덱스, positions.json, 개인색/필터 적용의 공통 계약 |
| [LAYOUT_FEATURE.md](LAYOUT_FEATURE.md) | [NEW] Layout CSV 데이터 경로와 더미 데이터 계약 |
| [PERSONALIZED_COLORS.md](PERSONALIZED_COLORS.md) | 개인색 스킴 저장소와 PLTE 패치 방식 |
| [COMPOSITE_MAP.md](COMPOSITE_MAP.md) | Composite 생성, recolor, subset, positions 복사 규칙 |

### 기능 문서

| 문서 | 설명 |
|------|------|
| [CHIP_ANNOTATION.md](CHIP_ANNOTATION.md) | Chip overlay, annotation 저장 구조, 관련 API |
| [PYRAMID_THUMBNAIL.md](PYRAMID_THUMBNAIL.md) | 피라미드 레벨, 캐시 경로, 서버/클라이언트 피라미드 동작 |
| [INDEX_SEARCH.md](INDEX_SEARCH.md) | 파일 인덱싱, 검색, 다중 LOT 검색 |
| [ROLE_ACCESS.md](ROLE_ACCESS.md) | 현재 RBAC 구현 상태와 두 권한 체계의 차이 |

### 참조

| 문서 | 설명 |
|------|------|
| [TECHNICAL_OVERVIEW.md](TECHNICAL_OVERVIEW.md) | Frontend/Backend/Search 전체 기술 구성 요약 |
| [API_REFERENCE.md](API_REFERENCE.md) | 전체 API 엔드포인트 목록 (100+) |
| [DEVELOPMENT.md](DEVELOPMENT.md) | 개발 가이드, 프로젝트 구조, 코드 스타일, 엔드포인트 추가 방법 |
| [PERFORMANCE.md](PERFORMANCE.md) | 런타임 기준 성능/캐시/워커/압축 동작 |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | 문제 진단, 카테고리별 디버깅, 배포 전 점검 |
| [FAILBIT_DUAL_PIPELINE.md](FAILBIT_DUAL_PIPELINE.md) | Fail-bit 외부 파이프라인 계약, BIN 코드 세트 |

## 정리 원칙

- 팔레트 인덱스와 positions.json 공통 규격은 `IMAGE_PIPELINE.md` 기준
- Composite, chip annotation, personalized colors 문서는 공통 규격을 다시 복사하지 않고 필요한 차이만 기술
- 저장소에 없는 스크립트나 미구현 API는 문서에서 제거
- 문서와 코드가 어긋나면 코드가 우선
