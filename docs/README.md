# Docs Guide

`docs/`의 문서는 현재 코드 기준 동작을 설명합니다. 구현 정본은 항상 코드이며, 문서는 코드에서 바로 유도되는 운영 규칙과 API 사용법만 남깁니다.

## 문서 맵

| 문서 | 현재 역할 |
|------|-----------|
| `docs/IMAGE_PIPELINE.md` | 이미지 응답, 팔레트 인덱스, `positions.json`, 개인색/필터 적용의 공통 계약 |
| `docs/LOCAL_FAILBIT_DATASET_SPEC.md` | 로컬 `palette_5mb` / `palette_3k` 재생성 절차, 파일 인벤토리, deterministic seed 규칙 |
| `docs/FAILBIT_DUAL_PIPELINE.md` | fail-bit 파일명 필터 규칙과 외부 파이프라인 계약 메모 |
| `docs/CHIP_ANNOTATION.md` | chip overlay, annotation 저장 구조, 관련 API |
| `docs/COMPOSITE_MAP.md` | composite 생성, recolor, subset, positions 복사 규칙 |
| `docs/PERSONALIZED_COLORS.md` | 개인색 스킴 저장소와 서버 적용 방식 |
| `docs/PYRAMID_THUMBNAIL.md` | 피라미드 레벨, 캐시 경로, 서버/클라이언트 피라미드 동작 |
| `docs/INDEX_SEARCH.md` | 파일 인덱싱, 검색, 다중 LOT 검색 |
| `docs/ROLE_ACCESS.md` | 현재 RBAC 구현 상태와 두 권한 체계의 차이 |
| `docs/performance-optimization.md` | 현재 런타임 기준 성능/캐시/워커/압축 동작 |

## MCP (Cursor / IDE)

저장소 루트의 `mcp.json.example`을 `.mcp.json`으로 복사한 뒤, `PROJECT_ROOT`와 `USER_HOME`을 각자 환경에 맞는 절대 경로로 바꾸면 Cursor 등에서 MCP 서버(filesystem, git)를 사용할 수 있습니다. `.mcp.json`은 로컬 전용이므로 `.gitignore`에 두고 커밋하지 않습니다.

## 정리 원칙

- 팔레트 인덱스와 `positions.json` 공통 규격은 `docs/IMAGE_PIPELINE.md`를 기준으로 봅니다.
- 로컬 fail-bit 샘플 데이터 생성 절차는 `docs/LOCAL_FAILBIT_DATASET_SPEC.md`를 기준으로 봅니다.
- composite, chip annotation, personalized colors 문서는 공통 규격을 다시 복사하지 않고 필요한 차이만 적습니다.
- 저장소에 없는 스크립트나 미구현 API는 사용법 문서에서 제거하거나 "외부 파이프라인"으로 명시합니다.
- 예전 fallback 문자열, 과거 실험 수치, 희망 설계보다 현재 코드 경로와 실제 엔드포인트를 우선합니다.
