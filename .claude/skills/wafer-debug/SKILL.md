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
15. `unknown` 단일 이미지 보기에서 Next/Prev가 가끔 늦게 반응하면 `navigateSingleImageGrid()`의 `_isNavigating` 큐잉, 이전 `loadImage()` callback의 stale state 반영, 그리고 즉시 pyramid prefetch가 서버 작업을 남기는지 확인한다. 최신 Next/Prev 입력은 이전 로드를 abort하고 즉시 `selectedImagePath`/index를 바꿔야 하며, background prefetch는 현재 이미지가 짧게 안정된 뒤 시작해야 한다.

#### Label Explorer / MY LOT 문제
1. `resolveOriginalImagePath`, `resolveLabelExplorerImagePath`, `buildLabelExplorerGridState` 흐름 확인
2. classification / my-lot 경로가 원본 이미지 경로로 정상 역해석되는지 확인
3. 단일 이미지 복귀 시 `_transientGridRestoreState`, `savedViewState`, `gridRestoreImages`가 의도대로 보존되는지 확인
4. `showGrid(..., true, true)` 같은 강제 경로와 LOT Mode 조건이 충돌하지 않는지 확인
5. MY LOT의 보기/Grid 보기/선택 Grid 보기가 기존 폴더 선택 상태를 오염시키지 않는지 확인
6. MY LOT은 영구 보관 폴더이므로 이미지와 positions JSON은 항상 실제 파일로 복사해야 한다. 하드링크로 저장하지 않는다. 첫 MY LOT 그리드가 느릴 때는 원본/복사본 inode 차이로 썸네일 캐시가 미스나는지 확인하고, 실제 이미지 복사는 유지한 채 파생 썸네일 캐시 복제 여부를 확인한다.

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

### Coord range / map selector / grid direct selection 회귀 (2026-08-19)

- Chip/Radius range는 active Shot/Chip coordinate list와 AND 조건이어야 한다. list가 비어 있을 때만 전체 wafer 기준 range로 동작한다. range를 수정할 때 이전 range 결과 `selectedChips`를 base로 쓰면 slider 변경 때 selection이 계속 축소되므로, `matchCoordinateRows()` 같은 non-mutating matcher로 base를 다시 만든 뒤 constraint를 적용한다.
- Coordinate Map selector는 실제 wafer bitmap을 로드하지 않는다. positions/layout만 사용해 Grade0 fill chip, scheme `bottom.Normal` chip boundary, Shot boundary, 선택 highlight를 그리는 structure-only panel이어야 한다. source wafer filename이나 chip별 defect/palette 색은 selector에 표시하지 않는다. Shot boundary는 `Shot 경계` button으로 켜고 끌 수 있어야 한다. 배경 overlay는 투명하고 pointer-events를 막아야 하며 panel만 fixed/draggable로 동작한다.
- Grid context의 direct `Shot 선택`/`Chip 선택`/`Wafer 선택`은 Coord modal과 분리한다. direct 선택은 `_pendingGridRegionComposite`를 만들거나 sourceImages를 바꾸지 않고, 표시가 필요하면 direct 전용 source set으로 thumbnail selection overlay만 그린다. Coord 진입은 grid toolbar `Coord` 버튼으로 유지한다.
- E2E 신호: `coordinate-selection-cells`는 modeless map selector, mode buttons, `showGrid=false`, range base AND와 Clear 복원을 확인한다. `selected-region-composite`는 grid direct Shot 선택이 Coord modal/pending source를 건드리지 않는지 확인한다.

### Chip Label ↔ Wafer 연결/오버레이 회귀 (2026-05-02)

- chip wafer key는 파일명 앞 5개 토큰 `product/bottom/wafer/date/time`이다. 예: `AAU220_00P_13_20260501_010000`. 이 prefix가 같으면 wafer filename에 `96.0_2` 같은 추가 토큰이 있어도 같은 wafer label로 매칭한다.
- chip label에서 원본 wafer/lot 보기는 Label Explorer, chip-label grid context menu, chip-label single image context menu 모두에서 가능해야 한다. 결과는 새 wafer tab으로 열고 lot/wafer 기준으로 dedupe하며, 원본 wafer path만 포함한다.
- chip label → wafer single view는 상단 folder와 좌하단 chip label legend/overlay가 보여야 한다. chip label image single view에서는 folder line/separator를 숨긴다.
- chip label overlay 기본 active label은 `invalid_main` 제외, alpha는 `0.2`, fill은 chip interior만 칠해 chip boundary가 남아야 한다.
- legend 우클릭은 all-off, legend drag는 wafer pan 금지, `scratch` 클릭 후 Shift+`particle_blast` 클릭은 `scratch/bank_boundary/scratch_21deg/particle_blast` range 전체 선택이 정상이다.
- Ctrl-drag는 legend label toggle, Ctrl+Shift-drag는 legend range add와 wafer canvas chip multi-select 모두 동작해야 한다.
- 줌 레벨 전환 색상 문제는 personalized pyramid cache key/rev와 PLTE patch를 먼저 본다. 모든 `SERVER_CONFIG.PYRAMID_LEVELS`에서 개인색 pixel sample이 유지되어야 하며 pyvips/Pillow/speed fallback 모두 palette patch를 유지해야 한다.

### Wafer Map Explorer 스크롤바/폴더 선택 회귀 (2026-05-06)

- 증상: 폴더 선택으로 그리드/단일 이미지를 띄운 상태에서 Explorer 폴더 리스트가 열려 있으면 현재 폴더 대신 파일 리스트 하단 항목이 하이라이트되거나, Explorer 스크롤바를 마우스로 드래그한 뒤 이미지/그리드가 사라졌다.
- 원인: `js/main.js`의 `setupFileExplorerDragSelect()`가 스크롤바 gutter의 `mousedown`을 드래그 선택 시작으로 처리했고, mouseup에서 `selectedFolders`/`selectedImages`를 파일 교차 결과 또는 빈 선택으로 덮어썼다. 또한 `updateWaferMapExplorerHighlight()`가 폴더-origin `gridImage` 단일 보기에서 현재 파일 하이라이트를 적용했다.
- 수정 패턴: Explorer 스크롤바 영역은 드래그 선택 시작 대상에서 제외하고, 폴더 선택에서 진입한 `gridImage` 단일 보기에서는 파일 하이라이트를 지운 뒤 `restoreFolderSelection()`으로 폴더 하이라이트를 유지한다.
- E2E 신호: `scripts/e2e_chunk2.js`의 `22,23,28,29` record는 폴더-origin grid/single 상태에서 Explorer 스크롤바 드래그 후 `selectedFolders`, folder DOM highlight, grid count, single canvas/path가 그대로인지 확인한다.

### Next/Prev 빠른 클릭 반응 지연 (2026-05-11)

- 증상: `unknown` 이미지 단일 보기에서 Next/Prev를 빠르게 누르면 두 번째 이후 클릭이 이전 이미지 로드 완료 뒤에야 반영되는 것처럼 보일 수 있었다.
- 원인: `js/main.js`의 `navigateSingleImageGrid()`가 `_isNavigating` 중 입력을 `_pendingNavDirection`에 큐잉했고, 이전 `loadImage()` callback이 최신 navigation 상태를 덮을 수 있었다. 이미지 로드 직후 pyramid prefetch도 quick navigation 중 서버 작업을 남길 수 있었다.
- 수정 패턴: 최신 Next/Prev 입력은 즉시 이전 image load를 abort하고 index/path를 갱신한다. `.then/.catch`는 `_imageLoadVersion`과 `selectedImagePath`로 stale callback을 무시한다. `prefetchAllPyramidLevels()`는 짧은 디바운스 후 현재 이미지가 유지될 때만 시작한다.
- E2E 신호: `unknown` 재귀 이미지 80장으로 grid single-image와 file single-image 모드에서 연속 Next/Prev를 호출했을 때 모든 클릭이 즉시 다른 path/index로 바뀌고 call time이 50ms 미만이어야 한다.

### MY LOT wafer/LOT paste-save-grid 속도 (2026-05-20)

- 증상: wafer 30개 copied-position check가 2초 이상으로 보이고, MY LOT 저장 후 LOT/wafer 그리드의 첫 visible thumbnail 시간이 느릴 수 있었다.
- 원인: 2초 값은 저장 복사가 아니라 E2E가 full positions JSON을 여러 번 다운로드/파싱한 검증 비용이었다. MY LOT 이미지 복사본은 실제 파일이어야 하므로 원본 inode 기반 썸네일 캐시를 그대로 hit하지 못한다. 첫 LOT grid `ready`가 500ms 이상이면 LOT grid 생성보다 `PageManager.ensurePageForRole()`이 active `blank` 페이지를 `mylot`으로 convert하며 `applyPageState()`를 실행하는지 확인한다.
- 수정 패턴: 이미지와 positions JSON은 항상 실제 복사한다. `/api/chip-positions?count_only=1`은 `netd` fast path와 thread offload로 chip 수만 빠르게 반환한다. MY LOT batch 저장 후에는 원본 썸네일 캐시가 이미 있을 때만 복사본 inode 캐시 키로 파생 썸네일 파일을 복제한다. MY LOT grid open은 `forceNew=true`일 때 blank page convert를 피하고, PageManager create/activate에 `skipPersist`/`skipApply`를 전달하며, 5000장 source grid state는 `savedViewState.images` 한 곳만 저장하도록 compact persist를 사용한다.
- E2E 신호: `scripts/e2e_chunk3.js` record `mylot-wafer30-lot10-perf`가 10 LOT/30 wafer paste, save, copied-position count, LOT/wafer grid ready/visible thumbnail 시간을 측정한다.

### 검색 결과 Ctrl+A / MY LOT 붙여넣기 미리보기 누락 (2026-06-01)

- 증상: 검색창에 입력 후 결과 그리드가 떠도 `Ctrl+A`가 그리드 전체 선택이 아니라 검색창 텍스트 선택으로 남을 수 있었다. Edge에서는 MY LOT 기존 그룹에 붙여넣은 LOT/Wafer가 미리보기 없이 저장되고, 그룹을 삭제 후 재생성하면 정상처럼 보일 수 있었다.
- 원인: 성공한 `performSearch()` 뒤에도 `#file-search` 포커스가 유지되어 그리드 단축키 핸들러가 입력 필드 보호 로직으로 빠졌다. `js/my-lot.js`의 붙여넣기 검색 URL은 `folder` 파라미터를 계속 구성해 stale folder scope가 섞일 여지를 남겼고, MY LOT lazy import도 소스상 명시 버전 태그가 없었다.
- 수정 패턴: 검색 성공 후 결과 그리드를 렌더링하면 `#file-search`를 blur한다. MY LOT의 LOT/Wafer 검색은 UI 검색과 동일하게 전역 검색으로 보내며 `folder`를 아예 생략한다. `main.js::_getMyLotModal()`은 `./my-lot.js?v=${jsVer}`로 import한다.
- E2E 신호: `scripts/e2e_chunk2.js` record `21,24,25,26,27`는 검색 후 `Ctrl+A` 전체 선택을 확인한다. `scripts/e2e_chunk3.js` record `mylot-wafer30-lot10-perf`는 MY LOT paste 검색 URL에 `folder`가 없고 모든 붙여넣기 행의 preview/path가 채워지는지 확인한다.

### 단일보기 패널 소실 / Border 두께 / partial Shot 빈 슬롯 (2026-08-08)

- 증상: Grade, Chip/Border, 좌하단 상태, 미니맵 위 더블클릭이나 확대·pan 중 빠른 클릭 뒤 단일보기 패널이 함께 사라졌다. Border를 켜면 색만 바뀌지 않고 선이 굵어졌고, partial Shot 선택은 빈 canonical 슬롯까지 채웠다.
- 원인: `viewerContainer`의 `dblclick`이 패널 자식 이벤트까지 받아 `gridImage` 종료를 실행했다. Border는 서버 PLTE 치환 뒤 client overlay에서 최대 3px 선을 추가했다. Shot의 기존 Chip이 전부 선택된 경우 canonical boundary 전체를 채우는 shortcut이 있었다.
- 수정 패턴: 네 고정 패널 내부 더블클릭을 navigation 전에 차단한다. Border는 PNG PLTE 인덱스 10을 11~23에 복사하는 서버 경로만 사용하고 client geometry를 만들지 않는다. Shot 외곽선은 canonical 크기를 유지하되 선택 채움은 실제 선택 Chip rect만 순회한다.
- E2E 신호: `layout-chip-coordinates`가 네 패널 더블클릭과 확대·pan 6회 후 visibility/path/mode를 확인하고, Chip 1개 partial Shot의 빈 슬롯 픽셀이 변하지 않는지 검사한다. `systematic-measure-single-lot-wafer`는 Border 전후 IDAT와 overlay hash 동일, PLTE 11~23만 Normal 색으로 바뀌는지 검사한다.

### Grid Coord Shot Composite / Measure median (2026-08-18)

- 증상: grid에서 wafer 여러 장을 선택하고 Coord로 Shot을 고른 뒤 Composite를 만들 때 단일 대표 wafer만 source로 쓰이거나, gridImage 로드 후처리의 늦은 selection sync가 coordinate list를 비우면 사용자가 고른 wafer/Shot selection이 사라진 것처럼 보인다. `med` aggregation은 failbit palette/class가 아니라 FBT/QVL measure 값에서만 의미가 있다.
- 수정 패턴: grid bottom legend의 `Coord`, `Shot`, `Border` 버튼은 같이 보여야 한다. grid `Coord`는 선택 wafer 목록을 `_pendingGridRegionComposite.sourceImages`로 보존한 뒤 대표 wafer를 `gridImage`로 열고 기존 coordinate modal을 사용한다. coordinate modal에 입력 state가 있으면 chip selection 자동 sync가 그 입력을 덮지 않는다. selected Shot/Chip Composite는 pending source를 `image_paths`로 보내고 completion 후 cleanup한다. M.Comp `MED`는 FBT/QVL 요청에만 `aggregation=median`을 보낸다.
- E2E 신호: `selected-region-composite`는 grid controls visible, 선택 wafer 2개 payload, pending cleanup, median data-only 결과를 확인한다. `8,9,10,11`은 M.Comp submenu의 `SUM|MED` toggle을 확인한다.

### Shot Position picker chip-only selection (2026-08-18)

- 증상: coordinate modal의 Shot Position cell 하나를 눌렀는데 해당 position chip만 남지 않고 Shot 전체가 선택된 것처럼 보인다.
- 원인 후보: `js/main.js::_applyCoordinateSelectionShotPickerSelection()`이 `chip-annotator.js::setShotChipSelections()`를 호출하면 `selectionMode='shot'`로 강제되어 렌더/데이터 경로가 Shot 단위로 확장된다.
- 수정 패턴: Shot Position picker는 클릭된 position 번호를 직접 chip index로 변환하고 `selectionMode='chip'`으로 저장한다. Shot X/Y row나 기존 Shot selection이 있으면 그 scope 안에서만 같은 position을 선택하고, scope가 없으면 wafer 전체의 같은 position을 선택한다.
- E2E 신호: `coordinate-selection-cells`는 scope 없음 position 0 선택과 Shot 두 개 scope 내 position 1개 선택을 모두 확인해야 한다. `scripts/e2e_shot_100_products_guard.js`는 100개 synthetic product에서 같은 Shot Position 계약을 반복 확인해야 한다.

### Grid Shot thumbnail overlay separation (2026-08-18)

- 증상: grid mode의 `Shot` 버튼을 눌렀을 때 썸네일 위 Shot 경계만 보여야 하는데, 선택 wafer를 열거나 Coord/Shot Composite selection 흐름처럼 동작한다. single image에서는 정상인 edge partial Shot 크기가 grid thumbnail에서만 작게 보일 수 있다.
- 원인 후보: `#grid-shot-boundary-btn`가 `openGridCoordinateSelection()`을 호출하면 grid thumbnail overlay와 coordinate modal 진입이 섞인다. 한 row/column Shot 구조에서는 기준 Shot만으로 screen transform을 추론해 회전/전치 방향이 틀릴 수 있다. grid thumbnail data가 edge partial Shot을 실제 chip rect min/max로만 만들고, canonical full Shot shape/cell size를 복원하지 않을 수 있다.
- 수정 패턴: grid Shot은 `gridShotBoundaryVisible`과 `.grid-shot-boundary-overlay` canvas만 토글한다. `gridSelectedIdxs`, selected wafer paths, `viewMode`, `selectedImagePath`, coordinate modal display, chip selection은 그대로 둔다. 기준 Shot에 한 축 벡터가 없으면 전체 chip entries로 `ChipAnnotator` screen transform을 보강한다. edge partial Shot은 layout `FULL` Shot에서 canonical cols/rows와 slot origin을 잡고, thumbnail positions rect cell size로 full Shot 크기 boundary를 그린다.
- E2E 신호: `selected-region-composite`는 grid Shot 클릭 전후 선택/grid/modal 상태 불변과 실제 overlay canvas nontransparent pixel을 확인한다. 같은 record는 partial edge Shot group이 `canonicalBoundary=true`이고 width/height가 canonical width/height와 같은지 확인한다. `scripts/e2e_shot_100_products_guard.js`는 `1×2`, `2×1`을 포함한 100개 synthetic product의 shape/rotation/chip-count coverage를 확인한다.

### Grid Coord all-loaded source and coordinate-list sync (2026-08-18)

- 증상: grid에서 wafer를 선택하지 않고 `Coord`를 누르면 로드된 전체 wafer에 적용되어야 하는데 선택 필요/대표 wafer처럼 동작하거나, 좌표 모달을 열기 위해 grid가 단일보기로 바뀐다. Shot X/Y와 Chip X/Y 입력 리스트가 서로 따라 갱신되지 않을 수도 있다. Coord 선택 chip/shot이 grid thumbnail에는 보이지 않거나, thumbnail double-click이 기존 grid wafer 선택을 바꿀 수도 있다. grid Coord로 Shot을 선택한 뒤 우클릭 메뉴에 선택 Shot Composite Map 항목이 없을 수 있다. Grid Shot Composite는 일반 Shot Composite와 Shot-local Square Weighted Avg가 별도 항목이어야 한다. 선택 wafer를 우클릭하면 grid selection이 풀리거나, grid Shot overlay가 스크롤 왕복 때 다시 로드될 수 있다.
- 원인 후보: `openGridCoordinateSelection()`이 selected paths만 source로 삼고 no-selection fallback을 막거나, 좌표 준비를 `enterGridImageViewMode()`에 의존한다. coordinate live apply가 입력 중 sync를 완전히 막아 active list는 보존되지만 반대 list도 비어 있다. grid thumbnail에는 `chipAnnotator.selectedChips`를 source wafer별 canvas overlay로 다시 그리는 경로가 없을 수 있다. double-click 전 첫 plain click이 `gridSelectedIdxs`/`savedViewState`를 먼저 바꿀 수 있다. grid `showContextMenu()`가 selected wafer scope, 전체/선택 Shot group, 전체/선택 Chip group, Shot-local weighted-only 플래그를 분리하지 않을 수 있다. grid 우클릭이 pending plain-click을 무조건 취소하거나 DOM 순번으로 selected class를 다시 계산할 수 있고, Coord modal 후 남은 drag state가 오른쪽 `mouseup`을 selection 완료로 처리할 수 있다. Shot overlay renderer가 offscreen canvas를 제거해 스크롤 왕복 때 다시 만들 수 있다.
- 수정 패턴: grid `Coord`는 선택이 있으면 선택 wafer만, 없으면 `currentGridImages` 전체를 pending source로 저장한다. grid 화면에서는 단일보기로 전환하지 말고, 대표 wafer의 positions/layout만 읽어서 coordinate modal을 grid 위에 띄운다. `gridMode`, `viewMode`, grid DOM, grid 선택 wafer, `selectedImagePath`는 유지한다. 좌표 모달에 Shot Composite 전용 버튼은 두지 않는다. live apply 후 active list를 제외한 Shot/Chip/Shot Position list를 selected chips에서 다시 채운다. Shot X/Y와 Chip X/Y `Map` 버튼은 각각 Shot/Chip selection mode로 전환하고 map 선택 결과를 해당 좌표 리스트에 반영한다. grid thumbnail overlay는 pending source path와 selected chip absolute coord가 모두 맞는 visible thumbnail에만 그리고, wafer 선택 border와 분리한다. Grid Composite의 wafer scope는 grid 선택 wafer만이다. 우클릭한 wafer가 미선택이면 기존처럼 그 wafer 1개를 선택하고, 선택된 wafer 우클릭은 selected indices/paths/wrap border를 그대로 유지한다. selected class 갱신은 `.grid-thumb-wrap[data-index]` 기준으로 한다. 오른쪽 `mouseup`은 남은 drag state 정리만 하고 selection을 바꾸지 않는다. Shot/Chip scope는 선택이 있으면 선택 Shot/Chip만, 없으면 전체 Shot/Chip이다. grid 우클릭 메뉴는 Coord 선행 없이 `Shot 선택`, 일반 Shot Composite, Shot-local Square Weighted Avg, Chip Composite를 분리한다. Shot-local Square Weighted Avg는 `/api/composite-map`에 `shot_local_square_weighted=true`를 보내고 backend는 `shot_local_square_weighted_average.png` 한 장만 저장한다. double-click은 pending plain click을 취소하고 이미 적용된 첫 click snapshot을 저장 상태 생성 전에 복원한다. Grid Shot overlay는 버튼이 켜진 동안 offscreen canvas를 지우지 말고 같은 path/size canvas를 재사용하며, 버튼 OFF에서만 제거한다.
- E2E 신호: `selected-region-composite`는 no-selection Coord source count가 current grid count와 같고 `gridMode=true`, `viewMode=null`, grid wrapper visible, single-view buttons absent, modal visible인지 확인한다. 같은 record는 Coord를 누르기 전에도 grid 우클릭 메뉴에 `Shot 선택`이 보이고, 클릭 시 grid 화면 유지 상태에서 Coord 모달과 Shot overlay가 열리는지 확인한다. wafer 2개 선택 후 Coord/Shot quick-pick에서도 grid와 선택 wafer 2개가 유지되고 selected Shot group이 잡히며 `.grid-coordinate-selection-overlay`에 selected chip count와 nontransparent pixel이 생기는지 확인한다. 같은 record는 Coord 후 stale left drag state에서 오른쪽 `mouseup`이 와도 selected indices/paths/wraps가 유지되는지 확인한다. 같은 record는 grid 우클릭 메뉴의 `Shot Composite`, `Shot Composite W to W`, `Chip Composite`가 보이고, 일반 Shot은 `shotLocalSquareWeighted=false`, special은 `shotLocalSquareWeighted=true`로 Shot group/slot/source wafer를 `handleCompositeCreate()`에 넘기는지 확인하며 우클릭 전후 selected indices/paths/wraps가 같은지 본다. 같은 record는 Grid Shot overlay가 스크롤 왕복 뒤에도 canvas marker를 유지하고 같은 path boundary data를 다시 조회하지 않는지 확인한다. 같은 record는 thumbnail double-click 진입/복귀 뒤에도 selected indices/paths와 saved selection이 double-click 전과 같은지 확인한다. `coordinate-selection-cells`는 Shot/Chip Map 버튼의 selection mode 전환과 좌표 리스트 sync, Shot X/Y 입력 후 Chip/Position, Chip X/Y 입력 후 Shot/Position 리스트가 갱신되는지 확인한다.

### Shot Position Shot Composite / grid Coord restore (2026-08-19)

- 증상: grid Coord에서 Shot Position 3개만 선택하고 `Shot Composite`를 실행하면 선택하지 않은 position까지 payload/result에 섞일 수 있다. Composite 탭으로 이동했다가 wafer 탭으로 돌아오면 coord 선택 chip과 thumbnail overlay가 사라질 수 있다.
- 원인: Shot Position 선택은 `selectionMode='chip'`인데 Shot Composite context는 `getSelectedShotGroupSelections()`가 비면 전체 Shot group으로 fallback했다. grid page state는 single-image chip selection만 저장하고 grid Coord selected coords, targetPath, pending source wafer를 저장하지 않았다. backend selected-shot canvas는 비선택 slot을 background index 8로 두어 사용자 배경색처럼 보일 수 있었고, numba 없는 sum-map fallback은 invalid mask를 다시 빼지 않을 수 있었다.
- 수정 패턴: requested Shot Composite는 `selectionMode='chip'`이어도 selected chip을 실제 Shot group별로 묶어 `selected_shot_groups`를 만든다. Shot Position 선택이면 각 group에는 선택 slot chip만 들어가야 한다. selected Shot canonical canvas의 기본 index는 전용 흰색 index 23이고, 선택 placement rect만 grade 0 chip 내부로 마킹한다. grade accumulation과 result positions는 선택 chip만 사용한다. grid page state에는 selected coords, targetPath, pending source wafer를 저장하고 wafer 복귀 시 positions/layout 준비 후 chip selection과 grid coord overlay를 복원한다.
- E2E 신호: `selected-region-composite`는 Shot Position `0,1,2` 선택 후 grid `Shot Composite` payload가 unique slot 3개, group당 최대 3 chip, source wafer 2개만 갖는지 확인한다. 같은 record는 Composite 전 page state를 저장한 뒤 selection/pending/overlay를 지우고 복원했을 때 grid mode, selected chip count/positions/source wafer/grid selection/coord overlay가 유지되는지 확인한다.

### Selected quantile mask / Grid Coord blank-click / W-to-W output (2026-08-19)

- 증상: selected Chip/Shot square/weighted map에서 선택하지 않은 canonical slot의 0값이 quantile 색상 범위에 섞이거나, 값 범위가 한 점일 때 끝색만 보일 수 있다. Grid Coord 선택 후 빈 grid 공간 click 또는 composite 탭 왕복 뒤 Coord modal reopen에서 selected chip/overlay가 사라질 수 있다. Grid `Shot Composite W to W`는 선택 wafer별 결과 대신 한 장짜리 `shot_local_square_weighted_average.png`로 보일 수 있다.
- 원인: selected geometry에서도 `base_indices == 0` 전체를 계산 denominator/cache/subset/recolor mask로 사용했다. grid 빈공간 click은 `clearGridSelection()`으로 전체 grid/chip state를 지웠고, `_prepareGridCoordinateSelectionTarget()`은 modal 준비 때 selection을 무조건 clear했다. W-to-W 저장 경로는 모든 source wafer를 한 번에 누적해 고정 파일명 한 장으로 저장했다.
- 수정 패턴: selected geometry는 `grade_counts.sum(axis=0) > 0` 기반 selected-value mask를 quantile/stat/cache/subset/recolor에 저장하고 재사용한다. `value_min == value_max`는 gradient 시작색으로 렌더한다. grid blank click은 coord selection이 있으면 wafer selection mark만 지우고 selected chips/pending source/thumbnail overlay는 유지한다. Coord modal reopen은 같은 targetPath selection을 positions/layout 재준비 후 재적용한다. W-to-W는 source wafer마다 shot-local weighted map을 만들고 output filename은 source basename을 유지한다.
- E2E 신호: `selected-region-composite`는 Grid Coord 후 빈공간 click과 Coord modal reopen에서도 selected chip count/pending source/overlay가 유지되는지 확인한다. 같은 record는 3개 wafer W-to-W API 결과가 `sum_maps.length == 3`, `heatmaps.length == 0`, 원본 basename filename, `composite_sample_count == wafer_count * selected_shot_count`인지 확인한다.

### Selected Shot empty slot quantile clamp / no-wafer Composite alert (2026-08-19)

- 증상: Shot Position 3개만 선택한 selected Shot Composite에서 비선택 빈 slot이 quantile 0처럼 보이고, 선택된 position들이 모두 끝색처럼 보일 수 있다. wafer 선택 없이 top `Composite`를 눌러도 alert 창이 아니라 toast/기존 이미지 선택 문구만 보일 수 있다.
- 원인: selected Shot canvas가 전체 canonical 영역을 grade 0으로 초기화했고, sum-map 최초 생성/recolor/subset/shot-local WTW가 selected 결과에서도 value range를 `0..max`로 clamp했다. top Composite no-selection은 `_toggleMcPanel()` toast 경로였다.
- 수정 패턴: `_build_selected_shot_geometry()`는 base를 selected Shot 전용 흰색 index 23으로 시작하고 selected placement rect만 0으로 마킹한다. selected Chip/Shot Composite는 `quantile_clamp_min_to_zero=false`를 response/NPZ에 저장하고, `_save_sum_map_variants()`, `recolor_saved_sum_maps()`, `create_subset_map()`, `_render_shot_local_square_weighted_entry()` 모두 selected mask의 실제 finite min/max를 사용한다. 일반 wafer Composite는 기존 `0..max`를 유지한다. selected Shot output에는 `selected_shot_display.json`을 저장하고 `/api/image`와 thumbnail PLTE 패치 뒤에도 empty slot index 23을 흰색으로 되돌린다. no-wafer Composite는 `wafer를 선택하세요.` alert를 띄운다.
- 주의: `api/composite_map.py` 계산 결과가 맞아도 `api/full_app.py` status response allow-list가 `quantile_clamp_min_to_zero`를 빠뜨리면 E2E에서는 selected quantile 계약이 깨진 것으로 보인다. selected response metadata를 추가할 때 allow-list를 같이 확인한다.
- E2E 신호: `8,9,10,11`은 no-wafer top Composite alert와 `#mc-panel` 미표시를 확인한다. `selected-region-composite`는 selected result의 `quantile_clamp_min_to_zero === false`와 partial Shot 빈 slot 중심 pixel이 palette index 23 흰색과 일치하고 선택 slot들이 선택된 값끼리 여러 quantile 색으로 분포하는지 확인한다.

### Coordinate Map structure-only selector / range rail guard (2026-08-19)

- 증상: Shot X/Y `Map` 또는 Chip X/Y `Map`이 선택용 구조 모달이어야 하는데 특정 wafer bitmap을 로드하고 크게 표시할 수 있었다. plain click으로 Shot/Chip 선택이 되지 않거나, Chip/Radius 범위 min/max가 독립 rail처럼 보여 좌우 값이 뒤집히기 쉬웠다.
- 원인: coordinate map selector가 `/api/image` bitmap을 로드해 그렸고, plain click 선택 경로 없이 `ChipAnnotator`의 일반 클릭 해제 동작에 의존했다. 범위 UI는 axis마다 min/max range를 나란히 만들고 crossing 값을 같은 값으로만 보정했다.
- 수정 패턴: map selector는 positions/layout만 읽고 chip 구조와 Shot boundary만 canvas에 그린다. Shot Map plain click은 Shot 단위 replace, Chip Map plain click은 Chip 단위 replace로 처리하고 blank click은 selection을 지우지 않는다. Chip/Radius 범위 UI는 axis마다 하나의 dual-handle rail을 사용하고, UI state 및 `chip-annotator.js` range 계산 모두 min/max를 작은 값/큰 값으로 정렬한다.
- E2E 신호: `coordinate-selection-cells`는 map modal에 `coordinateMapSelection.image`가 없고 plain click만으로 Shot/Chip list가 동기화되는지 확인한다. 같은 record는 axis마다 `.coordinate-select-range-slider` 하나와 value group 하나가 있고, reversed min/max 입력 후에도 `min <= max`, 소수점 2자리, Chip/Radius AND 선택이 유지되는지 확인한다.

### Coordinate Map Shot render / scheme color guard (2026-08-19)

- 증상: Shot X/Y `Map`에서 chip을 눌러도 Shot 선택이 화면에 안 된 것처럼 보이고, map selector 색/선택 효과/Shot boundary가 현재 scheme와 다르게 보일 수 있다. Chip boundary도 selector에서 과하게 진하게 보일 수 있고, Chip X/Y heading의 `Map`/`Clear` button이 서로 떨어질 수 있다.
- 원인: map selector viewer가 `gridMode=true`면 `chip-annotator.js`의 Shot boundary/hover/selected Shot renderer가 early return한다. selector annotator가 main `chipAnnotator` 색을 복사하거나 hard-coded 색을 쓰면 구조-only map이 scheme 3색 계약에서 벗어난다. `.coordinate-select-list-heading`이 title, `Map`, `Clear` 3개 flex item에 `space-between`을 쓰면 버튼 간격이 벌어진다.
- 수정 패턴: selector는 구조-only를 유지하되 viewer `gridMode=false`여야 한다. Selector canvas visible color는 active scheme의 background, `top.Grade0`, `bottom.Normal` 3개만 사용한다. `js/main.js::_syncCoordinateMapSelectionSchemeColors()`로 selector annotator의 grid/hover/selected/preview/Shot boundary 색을 모두 `bottom.Normal`으로 맞추고 main annotator 색을 복사하지 않는다. Chip fill은 source wafer의 chip별 palette/defect 색을 쓰지 않고 active color legend scheme의 Grade0 색 하나로 통일한다. status는 source filename 없이 `구조 · N Shot / M Chip`만 표시한다. `Shot 경계` button은 `annotator.shotBoundaryVisible`을 토글하고 overlay를 즉시 다시 그려야 한다. Coordinate list heading은 title에 `margin-right:auto`를 두어 `Map`/`Clear`를 붙여 둔다.
- E2E 신호: `coordinate-selection-cells`는 map selector open 상태에서 `coordinateMapSelectionViewer.gridMode === false`, selector overlay colors가 모두 scheme `bottom.Normal`, chip boundary color가 scheme `bottom.Normal`, status filename 미표시, sampled chip fill color 1개, `Shot 경계` toggle 전후 overlay alpha 변화, Shot Map plain click 후 selected Shot group/overlay alpha pixel 존재, Chip X/Y `Map`/`Clear` gap `<= 8px`를 확인한다.

### Selection visible yield-only guard (2026-08-20, updated 2026-08-31)

- 증상: 단일보기 selection list와 grid 선택 패널에 `G/B`, source, Shot/Position breakdown, min~max range를 같이 표시하면 패널 높이가 커지고 사용자가 원하는 전체 선택 Yld만 빠르게 보기 어렵다. 단일보기 Selection 리스트 안에 Yld 행을 넣으면 좌표 목록이 밀리고 패널이 커진다.
- 수정 패턴: 단일보기 visible summary는 Selection 리스트 내부가 아니라 Device 정보 박스 위의 작은 검정/흰글씨 `#selection-yield-panel`에 전체 선택 집합의 `Yld NNN.N%` 한 줄만 표시한다. Selection 리스트에는 좌표 항목만 둔다. grid 우측하단 선택 패널은 filename yield 평균을 `Yld NNN.N%` 한 줄로 표시하고, grid 좌표/direct 선택 thumbnail에는 좌상단 작은 검정/흰글씨 배지를 쓴다. 상세 Good/Bad/group yield는 TSV/clipboard 같은 데이터 경로에만 유지한다.
- E2E 신호: `selected-region-export`는 `#selection-yield-panel`이 소수 1자리 Yld, 검정 배경, 흰 글씨로 보이고 `.selected-chips-yield-summary`/`.selected-chips-yield-breakdown`이 Selection 리스트에 없는지 확인한다. `grid-context-actions`는 `#selected-grid-yield-summary`가 `~` range 없이 소수 1자리 Yld만 표시하는지 확인한다.

### Grid context direct selection / Composite menu guard (2026-08-19)

- 증상: grid 우클릭 메뉴가 `Coord 선택`과 `선택`을 top-level에 따로 보여 길어지거나, direct `Shot 선택`/`Chip 선택`/`Wafer 선택`을 top-level에 따로 보여줄 수 있다. `Shot Composite`/`Shot Composite W to W`/`Chip Composite`가 Coord 또는 positions 준비 상태에 따라 사라질 수 있다. Direct Shot/Chip 선택이 Shot boundary toggle처럼 동작하거나, 선택 뒤 grid wafer border/source, hover 좌표 tooltip, thumbnail 노란 선택 표시가 단일보기 선택처럼 따라오지 않을 수 있다. Shot boundary 기본선이 grid/single에서 너무 진하고 dash가 굵게 보일 수 있다.
- 원인: Coord와 direct 선택 항목을 개별 context item으로 만들고, direct mode가 `toggleGridShotBoundaryOverlay(true)`를 호출하면 선택 모드와 boundary 표시 모드가 섞인다. direct mode/click 경로가 `gridDirectSelectionSourceSet`만 갱신해 `gridSelectedIdxs`를 보장하지 않으면 wafer selection과 region source가 갈라진다. Direct hover/click이 다른 wafer positions/layout을 준비할 때 선택 좌표를 보존하지 않거나, Ctrl-click 새 wafer에서 `gridDirectSelectionSourceSet`을 단일 source로 덮어쓰면 기존 Shot/Chip 선택이 사라진다. Composite item visibility를 즉시 selected-region context 성공 여부에 묶으면 positions 미준비 상태에서 메뉴가 숨겨진다.
- 수정 패턴: top-level은 `Wafer/Shot/Chip 선택 ▸` 하나이며 Composite 항목들 아래에 둔다. submenu 안에는 `Wafer 선택`/`Shot 선택`/`Chip 선택` 순서로 두고 기본 `Wafer 선택`과 현재 direct Shot/Chip mode를 checked 표시한다. Coord 진입은 grid toolbar `Coord` 버튼으로 한다. Wafer selection이 grid 기본 source이고 Coord는 이를 따른다. Direct Shot/Chip은 Coord와 Shot boundary 버튼을 무시하고 클릭한 wafer 내부에서 선택하며, 클릭한 wafer를 grid selected scope에 넣는다. Ctrl을 누른 채 다른 wafer의 Shot/Chip을 클릭하면 기존 wafer의 선택 key set은 그대로 두고 새 wafer에는 그 wafer에서 클릭한 Shot/Chip key set을 별도로 저장한다. Hover 좌표 tooltip과 thumbnail overlay는 main annotator `hoverColor`/`selectedColor`를 쓰되, thumbnail overlay는 source별 저장 key만 칠해야 하며 다른 wafer로 동기화되면 안 된다. Shot boundary 기본선은 `rgba(170, 120, 210, 0.45)`와 `[1,3]` dash를 쓴다. Grid source가 있으면 세 Composite 항목은 항상 보이고 순서는 `Ref Map 등록`, `Shot Composite`, `Shot Composite W to W`, `Chip Composite`, `Wafer/Shot/Chip 선택 ▸`여야 한다.
- E2E 신호: `selected-region-composite`는 Coord 전 context menu에서 `Wafer/Shot/Chip 선택 ▸` submenu 구조와 Composite 아래 위치, Coord item 없음, direct item이 submenu에만 존재, 기본 `✓ Wafer 선택`, Shot 전환 후 `✓ Shot 선택`, 세 Composite item visible/order, direct Shot hover tooltip/overlay, direct Shot 후 `gridShotBoundaryVisible=false`, Ctrl+다른 wafer의 다른 Shot 클릭 후 `gridDirectSelectionBySource`가 source 2개와 서로 다른 key set을 유지하는지, direct Chip 후 Ctrl+다른 wafer의 다른 Chip 클릭에서도 source 2개와 서로 다른 key set을 유지하는지, target wafer selected wrap/source와 coordinate overlay selected chip count를 확인한다.

### Shot Composite W to W result grid double-click guard (2026-08-19)

- 증상: `Shot Composite W to W` 완료 후 결과 grid에는 원본 basename별 wafer 결과가 보이지만, 이전 direct `Shot 선택`/`Chip 선택` 상태가 남아 있으면 thumbnail double-click이 단일보기 진입으로 이어지지 않을 수 있다.
- 원인: grid thumbnail capture interceptor가 `dblclick`까지 선택 이벤트로 막고, `switchToCompositeGrid()`가 composite 결과 grid 진입 전에 direct selection mode/source/hover/overlay를 비우지 않았다.
- 수정 패턴: `switchToCompositeGrid()`는 direct selection state와 thumbnail coordinate overlay를 초기화한다. `_shouldInterceptGridShotBoundaryThumbEvent()`는 `event.type === 'dblclick'`이면 false를 반환해 `enterGridImageViewMode()` 경로를 보장한다.
- E2E 신호: `selected-region-composite`는 W-to-W 결과를 `switchToCompositeGrid()`로 띄운 뒤 stale direct Shot state를 둔 상태에서도 첫 썸네일 더블클릭이 `viewMode='gridImage'`, `isCompositeMode=true`, `compositeSession.shotLocalSquareWeighted=true`로 진입하는지 확인한다.

### Coord range OR set guard (2026-08-20)

- 증상: Chip X/Y와 Radius range가 단일 AND 필터만 제공하면 떨어진 여러 chip 영역을 한 번에 고르기 어렵고, Chip 범위와 Radius 범위가 별도 group으로 보이면 같은 조건 set인지 혼동된다. 여러 set tab을 field 영역에 넣으면 panel에 불필요한 세로 줄이 생긴다.
- 수정 패턴: Coord range UI는 기본 `Set 1` tab/page를 항상 가진다. `Set 1`, `Set 2` tab은 field 영역이 아니라 `Add` 바로 옆 액션 줄에 둔다. `Add`는 새 tab/page를 만들고 활성 tab을 이동하되, 새 full-range set을 즉시 OR 적용해 선택을 바꾸지 않는다. 한 page 안에는 `Chip X(mm)`, `Chip Y(mm)`, `Radius(mm)` 3축을 세로 한 열로 두고 AND로 평가한다. 여러 set은 OR로 합친다. 기존 Shot/Chip/Shot Position list가 있으면 list match를 base로 두고 `(base) AND (set1 OR set2 ...)`로 계산한다. 마지막 set은 삭제하지 않는다.
- E2E 신호: `coordinate-selection-cells`는 기본 Set 1 tab/page, tab container가 `Add` 바로 뒤에 있고 field 영역에 tab이 없는지, 마지막 delete disabled, Add 후 tab 2개/visible page 1개, 2개 set OR로 서로 다른 chip 2개 선택, Shot list base와 range set AND, set Clear 후 base selection 복원을 확인한다.

### Coord Map full-range no-op / grid source restore (2026-08-23)

- 증상: Shot X/Y `Map` 클릭 뒤 list와 selected chip 수는 맞지만 main `chipAnnotator.selectionMode`가 `chip`으로 남아 Shot 선택 표시/동작이 깨질 수 있다. Grid Coord/Shot Composite page restore 뒤 selected chip과 pending overlay는 남아도 grid wafer selection source가 target 1개로 줄거나 현재 grid order에 맞지 않는 index로 보일 수 있다.
- 원인: Coord modal 기본 Range `Set 1` 전체 범위도 constraint로 처리되어 `selectByCoordinateConstraints()`가 항상 `selectionMode='chip'`을 덮었다. Grid Coord restore는 pending `sourceImages`를 저장해도 chip coords/pending만 복원하고 grid selected wafer set은 sourceImages 기준으로 재매핑하지 않았다.
- 수정 패턴: full extent Chip/Radius range는 selection 계산에서 no-op으로 보고, 실제로 좁혀진 range가 있을 때만 constraint 경로를 탄다. full-range 상태의 Shot Map/list 선택은 `selectByCoordinateRows('shot-grid', ...)`를 유지해야 한다. `pendingGridRegionComposite.selectedOnly=true` 복원 시 sourceImages를 current grid image list에 매핑해 `gridSelectedIdxs/gridSelectedSet`을 즉시/rAF/short timeout으로 재적용한다. No-selection all-loaded Coord는 grid wafer selection을 강제로 만들지 않는다.
- E2E 신호: `coordinate-selection-cells`는 Shot Map plain click 뒤 Shot rows, map/main selected count, main `selectionMode='shot'`을 같이 확인하고 full-range `Clear` 후 Shot base가 48 chip/2 Shot으로 복원되는지 본다. `selected-region-composite`는 Coord가 Shot boundary OFF 상태를 자동 ON 하지 않는지, context-menu Composite payload를 async handler 호출까지 기다리는지, source wafer paths와 coord overlay가 page-state restore 및 thumbnail double-click 전후 유지되는지 확인한다.

### Coord selected yield summary height guard (2026-08-20)

- 증상: Coord panel 상단 summary에 `Yld`, `Shot Yld`, `Shot Pos Yld`를 표시하면 modal 높이가 늘어나 닫기/완료 버튼이 화면 아래로 밀릴 수 있다.
- 수정 패턴: Coord panel selection summary는 `Chip N · Shot M`처럼 선택 개수만 표시한다. 수율과 Shot별/Position별 breakdown은 Coord modal에 렌더하지 않는다.
- E2E 신호: `coordinate-selection-cells`는 Shot 2개 선택 후 summary가 `Chip 48 · Shot 2`이고 `Yld`, `Shot Yld`, `Shot Pos Yld` 텍스트와 `.coordinate-select-summary-group` row가 없는지 확인한다.
