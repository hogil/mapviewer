---
name: wafer-debug
description: "L3 Tracker 웨이퍼 맵 렌더링/색상/오버레이/필터 이슈를 디버깅한다. 다음 상황에서 트리거: 웨이퍼 이미지가 안 보일 때, 색상이 이상할 때, 오버레이/BIN/Grade 필터가 동작하지 않을 때, Label Explorer/MY LOT 그리드가 비거나 늦게 뜰 때, composite map 생성 실패, 그리드/단일 이미지 전환 오류, pyramid 렌더링 문제. '렌더링 이상', '색이 안 맞아', '오버레이 안 돼', '필터 안 먹어', '이미지 안 나와' 등의 표현에도 반응한다."
argument-hint: [증상-설명]
---

# Wafer Debug - L3 Tracker 디버깅 가이드

증상: `$ARGUMENTS`

## 절대규칙: batch / benchmark_4m 폴더는 더미 파일 — 이미지 로드 금지

- `wm-811k/batch/` 하위의 모든 파일은 **파일 인덱스 성능 테스트용 0바이트 더미 파일**이다.
- `wm-811k/benchmark_4m/` 하위의 모든 파일도 **파일 인덱스/검색 성능 테스트용 0바이트 더미 파일**이다.
- `benchmark_4m`의 기대 구조는 400개 lot 폴더 × 10000개 PNG 이름 빈 파일 = 400만 파일이다.
- batch / benchmark_4m 경로에서 "not a known file format" / "cannot identify image file" 에러가 나오면 **정상 동작**이다.
- 이 에러를 버그로 간주하여 수정하려 하지 않는다. 디버깅 대상에서 batch / benchmark_4m 폴더를 제외한다.

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
| Label Explorer / MY LOT | 클래스/그룹 그리드 비표시, 복귀 후만 보임, 경로 꼬임 | `js/main.js`, `js/my-lot.js`, `api/my_lot.py` |
| LoginId / Cache | 개인색/저장 경로/캐시 무효화 이상 | `api/config.py`, `api/main.py`, `api/personal_colors.py`, `js/main.js` |
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
5. LOT Mode와 Label Explorer가 함께 켜졌을 때 `showGridByLot()` / flat-grid 중 어떤 경로를 타는지 확인
6. positions 없는 palette/PNF 이미지가 초기 로드에서 빠지는지, 단일 이미지 복귀 후에만 채워지는지 확인
7. Reset 이후에도 일부 이미지만 남으면 기본 필터값과 `_unfilteredGridImages` 오염을 먼저 본다
8. `filterSTEP` 기본값은 비어 있어야 한다. Reset은 LT/TM/STEP만 비우는 것이 아니라 원본 그리드 목록도 다시 잡아야 한다
9. LOT Mode에서 2~3번째 뷰포트 썸네일이 비면 필터만 보지 말고 lazy load 취소/timeout 경로를 같이 본다
10. 스크롤 중 in-flight 썸네일 취소, 15초 timeout 강제 에러, measure-thumb 무재시도는 특정 이미지군에서 미표시를 만든다
11. 실패한 썸네일을 `gridLoaded=true`로 확정하면 뷰포트 재진입 시 재요청이 막힌다. 실패 상태는 retry 가능하게 유지해야 한다
12. 폴더 우클릭 선택 해제는 현재 필터로 보이는 이미지 subset이 아니라 폴더의 전체 이미지 집합에 대해 적용되어야 한다
13. Reset 후 이미지가 "튀어나오면" reset 자체보다 `deselectFolderFiles()`가 필터된 subset만 지우고 남은 선택이 residual 상태로 남는지 먼저 확인한다
14. Wafer Map Explorer 스크롤바 드래그 후 그리드/단일 이미지가 사라지거나 폴더 선택이 파일 하이라이트로 바뀌면 `setupFileExplorerDragSelect()`가 스크롤바 `mousedown`을 rectangle selection으로 처리했는지 먼저 확인한다. 폴더-origin `gridImage` 단일 보기에서는 `updateWaferMapExplorerHighlight()`가 현재 파일을 하이라이트하지 않고 폴더 선택을 유지해야 한다.

#### Label Explorer / MY LOT 문제
1. `resolveOriginalImagePath`, `resolveLabelExplorerImagePath`, `buildLabelExplorerGridState` 흐름 확인
2. classification / my-lot 경로가 원본 이미지 경로로 정상 역해석되는지 확인
3. 단일 이미지 복귀 시 `_transientGridRestoreState`, `savedViewState`, `gridRestoreImages`가 의도대로 보존되는지 확인
4. `showGrid(..., true, true)` 같은 강제 경로와 LOT Mode 조건이 충돌하지 않는지 확인
5. MY LOT의 보기/Grid 보기/선택 Grid 보기가 기존 폴더 선택 상태를 오염시키지 않는지 확인

#### LoginId / Cache 문제
1. `FALLBACK_LOGIN_ID` 실제 값(`notsaml`)과 프론트 sentinel(`guest`)이 서버 쪽 sentinel 처리와 함께 일관되게 동작하는지 확인
2. `Cache-Control`, `ETag`, `_t=` cache buster, personalized scheme 파라미터가 stale 캐시를 막는지 확인
3. 색상 변경 후 그리드/단일 이미지/Measure/Composite가 각각 어떤 캐시를 지우는지 추적

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
- 재현 시나리오, 실제 원인, 수정 후 검증 시나리오를 반드시 분리해서 기록

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

## 최근 수정 메모 (2026-04-11)

### palette_3k Cold Start가 늦을 때

- 원인 후보를 폴더 스캔 하나로 단정하지 말고, 서버 재기동 직후 startup warm / index build / 첫 HTTPS hit 경합을 먼저 본다.
- 실제 수정은 전체 디스크 워밍 제거, `palette_3k` targeted warm, internal self-warm, user-idle 이후 heavy build 시작으로 해결했다.
- 이 증상은 `api/main.py`의 startup 흐름 문제일 가능성이 높다. `js/main.js`만 보지 말고 서버 warm 경로를 같이 확인한다.

### "배포했는데 예전 JS가 나온다" 증상

- top-level `main.js`만 새 URL이어도 충분하지 않다. 하위 ES module import, dynamic import, worker URL까지 같은 버전 문자열이 전파돼야 한다.
- 현재 기준 정상 상태:
  - `index.html`의 JS/CSS URL에 `?v=...`
  - `/js/main.js` 본문의 상대 import / dynamic import에 `?v=...`
  - `fetch-optimizer.js`의 `cache-worker.js`, `bitmap-loader.js`의 `bitmap-worker.js`에도 `?v=...`
  - JS/CSS 응답은 `no-cache + ETag`
- 신규 기능이 특정 사용자에게만 안 보이면 먼저 네트워크 탭에서 모듈 그래프 전체의 버전 문자열과 `304` 재검증을 확인한다.

### Chip Label ↔ Wafer 연결/오버레이 회귀 (2026-05-02)

- chip wafer key는 파일명 앞 5개 토큰 `product/bottom/wafer/date/time`이다. 예: `AAU220_00P_13_20260501_010000`. 이 prefix가 같으면 wafer filename에 `96.0_2` 같은 추가 토큰이 있어도 같은 wafer label로 매칭한다.
- chip label에서 원본 wafer/lot 보기는 Label Explorer, chip-label grid context menu, chip-label single image context menu 모두에서 가능해야 한다. 결과는 새 wafer tab으로 열고 lot/wafer 기준으로 dedupe하며, 원본 wafer path만 포함한다.
- chip label → wafer single view는 상단 folder와 좌하단 chip label legend/overlay가 보여야 한다. chip label image single view에서는 folder line/separator를 숨긴다.
- chip label overlay 기본 active label은 `invalid_main` 제외, alpha는 `0.15`, fill은 chip interior만 칠해 chip boundary가 남아야 한다.
- legend 우클릭은 all-off, legend drag는 wafer pan 금지, `scratch` 클릭 후 Shift+`particle_blast` 클릭은 `scratch/bank_boundary/scratch_21deg/particle_blast` range 전체 선택이 정상이다.
- Ctrl-drag는 legend label toggle, Ctrl+Shift-drag는 legend range add와 wafer canvas chip multi-select 모두 동작해야 한다.
- 줌 레벨 전환 색상 문제는 personalized pyramid cache key/rev와 PLTE patch를 먼저 본다. 모든 `SERVER_CONFIG.PYRAMID_LEVELS`에서 개인색 pixel sample이 유지되어야 하며 pyvips/Pillow/speed fallback 모두 palette patch를 유지해야 한다.

### Wafer Map Explorer 스크롤바/폴더 선택 회귀 (2026-05-06)

- 증상: 폴더 선택으로 그리드/단일 이미지를 띄운 상태에서 Explorer 폴더 리스트가 열려 있으면 현재 폴더 대신 파일 리스트 하단 항목이 하이라이트되거나, Explorer 스크롤바를 마우스로 드래그한 뒤 이미지/그리드가 사라졌다.
- 원인: `js/main.js`의 `setupFileExplorerDragSelect()`가 스크롤바 gutter의 `mousedown`을 드래그 선택 시작으로 처리했고, mouseup에서 `selectedFolders`/`selectedImages`를 파일 교차 결과 또는 빈 선택으로 덮어썼다. 또한 `updateWaferMapExplorerHighlight()`가 폴더-origin `gridImage` 단일 보기에서 현재 파일 하이라이트를 적용했다.
- 수정 패턴: Explorer 스크롤바 영역은 드래그 선택 시작 대상에서 제외하고, 폴더 선택에서 진입한 `gridImage` 단일 보기에서는 파일 하이라이트를 지운 뒤 `restoreFolderSelection()`으로 폴더 하이라이트를 유지한다.
- E2E 신호: `scripts/e2e_chunk2.js`의 `22,23,28,29` record는 폴더-origin grid/single 상태에서 Explorer 스크롤바 드래그 후 `selectedFolders`, folder DOM highlight, grid count, single canvas/path가 그대로인지 확인한다.
