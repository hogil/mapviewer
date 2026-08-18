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

- 증상: grid mode의 `Shot` 버튼을 눌렀을 때 썸네일 위 Shot 경계만 보여야 하는데, 선택 wafer를 열거나 Coord/Shot Composite selection 흐름처럼 동작한다.
- 원인 후보: `#grid-shot-boundary-btn`가 `openGridCoordinateSelection()`을 호출하면 grid thumbnail overlay와 coordinate modal 진입이 섞인다. 한 row/column Shot 구조에서는 기준 Shot만으로 screen transform을 추론해 회전/전치 방향이 틀릴 수 있다.
- 수정 패턴: grid Shot은 `gridShotBoundaryVisible`과 `.grid-shot-boundary-overlay` canvas만 토글한다. `gridSelectedIdxs`, selected wafer paths, `viewMode`, `selectedImagePath`, coordinate modal display, chip selection은 그대로 둔다. Coord 버튼만 coordinate modal/representative wafer 진입을 담당한다. 기준 Shot에 한 축 벡터가 없으면 전체 chip entries로 `ChipAnnotator` screen transform을 보강한다.
- E2E 신호: `selected-region-composite`는 grid Shot 클릭 전후 선택/grid/modal 상태 불변과 실제 overlay canvas nontransparent pixel을 확인한다. `scripts/e2e_shot_100_products_guard.js`는 `1×2`, `2×1`을 포함한 100개 synthetic product의 shape/rotation/chip-count coverage를 확인한다.

### Grid Coord all-loaded source and coordinate-list sync (2026-08-18)

- 증상: grid에서 wafer를 선택하지 않고 `Coord`를 누르면 로드된 전체 wafer에 적용되어야 하는데 선택 필요/대표 wafer처럼 동작한다. grid Shot/Border 상태가 grid-origin single-view 버튼과 이어지지 않고, Shot X/Y와 Chip X/Y 입력 리스트가 서로 따라 갱신되지 않는다.
- 원인 후보: `openGridCoordinateSelection()`이 selected paths만 source로 삼고 no-selection fallback을 막는다. single-view `Coord` 버튼은 grid-origin source 범위를 만들지 않는다. thumbnail Shot overlay canvas가 DPR 배율로 커진다. coordinate live apply가 입력 중 sync를 완전히 막아 active list는 보존되지만 반대 list도 비어 있다.
- 수정 패턴: grid `Coord`는 선택이 있으면 선택 wafer만, 없으면 `currentGridImages` 전체를 pending source로 저장한다. grid-origin single `Coord`도 동일 source를 보장한다. single Shot/Border 버튼은 grid state와 같이 갱신한다. thumbnail overlay backing pixel은 CSS 크기와 같게 둔다. live apply 후 active list를 제외한 Shot/Chip/Shot Position list를 selected chips에서 다시 채운다.
- E2E 신호: `selected-region-composite`는 no-selection Coord source count가 current grid count와 같은지, single Shot/Coord/Border가 grid state와 이어지는지, overlay canvas pixel size가 CSS size와 같은지 확인한다. `coordinate-selection-cells`는 Shot X/Y 입력 후 Chip/Position, Chip X/Y 입력 후 Shot/Position 리스트가 갱신되는지 확인한다.
