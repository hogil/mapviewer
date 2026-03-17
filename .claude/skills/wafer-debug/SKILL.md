---
name: wafer-debug
description: "L3 Tracker 웨이퍼 맵 렌더링/색상/오버레이/필터 이슈를 디버깅한다. 다음 상황에서 트리거: 웨이퍼 이미지가 안 보일 때, 색상이 이상할 때, 오버레이/BIN/Grade 필터가 동작하지 않을 때, composite map 생성 실패, 그리드/단일 이미지 전환 오류, pyramid 렌더링 문제. '렌더링 이상', '색이 안 맞아', '오버레이 안 돼', '필터 안 먹어', '이미지 안 나와' 등의 표현에도 반응한다."
argument-hint: [증상-설명]
---

# Wafer Debug - L3 Tracker 디버깅 가이드

증상: `$ARGUMENTS`

## 진단 절차

### Step 1: 증상 분류

사용자의 설명을 다음 카테고리로 분류한다:

| 카테고리 | 키워드 | 핵심 파일 |
|---------|--------|----------|
| 렌더링 | 이미지 안 나옴, 깨짐, 흰 화면 | `js/semiconductor-renderer.js`, `api/main.py` |
| 색상 | 색 안 맞음, 팔레트, Grade/BIN 색상 | `api/personal_colors.py`, `js/color-editor.js`, `logs/color-legends.json` |
| 오버레이 | BIN/Grade overlay, 텍스트 안 보임 | `js/main.js` (overlay 관련), `js/color-editor.js` |
| 필터 | 필터 안 먹힘, 칩 선택, 범례 클릭 | `js/main.js` (filter 관련), `js/color-editor.js` |
| Composite | 합성맵 생성 실패, 색상 이상 | `api/composite_map.py`, `api/composite_colors.py` |
| 그리드 | 그리드/단일 전환, 스크롤, 로딩 | `js/grid.js`, `js/main.js` |
| Pyramid | 줌 깨짐, 레벨 전환, 메모리 | `js/semiconductor-renderer.js` |

### Step 2: 카테고리별 진단

#### 렌더링 문제
1. **브라우저 최대화**: Playwright 실행 시 `browser_resize`로 **width: 1920, height: 1080** 설정
2. 브라우저 콘솔 에러 확인 (Playwright snapshot)
2. `/api/image?path=...` 직접 호출로 API 응답 확인
3. `semiconductor-renderer.js`의 `loadImage()` → `drawFrame()` 흐름 추적
4. Pyramid 레벨 확인: `PYRAMID_LEVELS = [0.25, 0.5, 0.75, 1.0]`

#### 색상 문제
1. `logs/color-legends.json` 읽기 → 현재 저장된 색상 확인
2. 팔레트 인덱스 검증:
   - 0~7: Grade0~7
   - 8: background, 9: text, 10: Normal, 11: Invalid
   - 12~17: 00P BIN (B285~B291)
   - 18~23: 00C BIN (B300~B390)
   - 31: invalid fill (white)
3. `personal_colors.py`의 `BIN_KEYS` 순서 vs `color-editor.js`의 `BOTTOM_KEYS` 순서 비교
4. loginId별 색상 분리 확인: `_current_login_id()` 경로 추적

#### 오버레이 문제
1. position JSON 파일 존재 여부: `{image}.json` 같은 위치
2. `main.js`에서 overlay 활성화 로직 확인
3. BIN/Grade overlay 텍스트: 칩 위치 좌표가 post-transform인지 확인
4. measure overlay: K/M 축약 표시 로직

#### 필터 문제
1. `plte_bottom_filter_memory` BOTTOM_MAP 인덱스 일치 확인
2. Grade filter vs BIN filter 상호 배타 로직
3. overlay + filter 동시 작동 로직
4. 범례 클릭 → 칩 선택/해제 이벤트 흐름

#### Composite Map 문제
1. positions 파일 필터링 로그 확인: `[composite-map] positions 필터: N → M개`
2. grade_counts NPZ 캐시 확인
3. square weighting: `grade^2` 계산 로직
4. Full vs Subset: only_low_mask=None 전달 확인
5. `composite_colors.py`: 11-point gradient 설정

#### 그리드 문제
1. `gridMode` 상태 플래그 확인
2. grid ↔ single 전환: `savedViewState` 보존
3. `labelSelection.selectedClasses` 클리어 타이밍
4. DOM class 전환: `grid-mode` ↔ `single-image-mode`

#### Pyramid 문제
1. 현재 줌 레벨 → 선택된 pyramid level 매핑 확인
2. `requestIdleCallback` 비동기 생성 vs 즉시 생성 경로
3. ImageBitmap 업그레이드 상태
4. 메모리: canvas 해제 타이밍

### Step 3: 수정 적용

수정 전 반드시:
- 이미지 품질: Q=100, Lanczos3 알고리즘 유지
- SAML: Windows에서 테스트하지 않음
- 기존 로깅 패턴 유지 (ANSI color pretty-table)

수정 후:
- 관련 테스트 수행 (Playwright 또는 수동)
- `git diff`로 변경 범위 확인
- 사이드 이펙트 없는지 연관 기능 체크

### Step 4: 결과 보고

```
## 디버그 결과

### 원인
- [근본 원인 설명]

### 수정 내용
- 파일:라인 — [변경 내용]

### 확인 방법
- [재현/검증 단계]
```
