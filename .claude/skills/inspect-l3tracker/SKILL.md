---
name: inspect-l3tracker
description: "L3 Tracker 웨이퍼 맵 뷰어의 핵심 기능을 체계적으로 점검한다. 색상 매핑, Composite/Measure, LoginId, stats, Label Explorer, MY LOT, 다중선택, 더블클릭 반복 동작, Page Manager, Thumbnail Navigator, Minimap, 다중검색, 권한 관리, 컨텍스트 메뉴 복사/다운로드, 키보드 단축키를 코드 분석과 Playwright UI 테스트로 검증한다. 'L3 점검', '전체 체크', 'UI 테스트', '기능 확인해줘', '버그 있는지 확인' 등의 요청에 반응한다."
context: fork
agent: general-purpose
argument-hint: [점검-범위]
---

# L3 Tracker 전체 점검

점검 범위: `$ARGUMENTS` (비어있으면 전체 점검)

이 스킬은 독립 서브에이전트에서 실행되어 메인 컨텍스트를 오염시키지 않는다.

## 절대규칙: Non-blocking Server Startup

서버 시작 관련 코드를 수정할 때 반드시 준수:
- `lifespan`의 `yield` 전에는 최소한의 필수 초기화만 수행 (labels 로드, 디렉토리 생성)
- 인덱스 로드/빌드, `_build_lookup_indices`, `_save_cache`, `__pycache__` 정리, composite cleanup 등 무거운 작업은 반드시 `asyncio.create_task`로 백그라운드 실행
- CPU/IO 집약적 작업은 반드시 `loop.run_in_executor`로 실행 (이벤트 루프 블로킹 금지)
- 서버는 인덱스 완료 여부와 무관하게 즉시 웹 요청 처리 가능해야 함

## 절대규칙: batch / benchmark_4m 폴더는 더미 파일 — 이미지 로드 금지

- `wm-811k/batch/` 하위의 모든 파일은 **파일 인덱스 성능 테스트용 0바이트 더미 파일**이다.
- `wm-811k/benchmark_4m/` 하위의 모든 파일도 **파일 인덱스/검색 성능 테스트용 0바이트 더미 파일**이다.
- `benchmark_4m`의 기대 구조는 400개 lot 폴더 × 10000개 PNG 이름 빈 파일 = 400만 파일이다.
- 점검 시 batch / benchmark_4m 폴더 파일을 이미지 로드/썸네일 생성/렌더링 대상으로 사용하지 않는다.
- 단, 인덱스 빌드/캐시 로드/검색 성능 점검에서는 `benchmark_4m`를 의도적으로 포함할 수 있다.
- batch / benchmark_4m 경로에서 pyvips/PIL 에러가 발생해도 정상이다 — 버그가 아니므로 수정하지 않는다.

## 점검 체크리스트

### 1. 색상 매핑 일관성

**코드 점검:**
- `api/personal_colors.py` — `BIN_KEYS` 순서 → 팔레트 인덱스 12~23 매핑
- `js/color-editor.js` — `BOTTOM_KEYS` 순서 일치
- `plte_bottom_filter_memory` BOTTOM_MAP 인덱스 일치

**기대 팔레트 인덱스:**
```
0~7  : Grade0~7
8    : background
9    : text
10   : Normal border
11   : Invalid border
12~17: 00P BIN (B285, B286, B287, B288, B290, B291)
18~23: 00C BIN (B300, B385, B386, B388, B389, B390)
31   : invalid fill (white)
```

**UI 점검 (Playwright):**
> **필수**: Playwright 브라우저 실행 시 `browser_resize`로 **width: 1920, height: 1080** 설정하여 전체 화면으로 테스트한다.

1. https://localhost:8443 접속
2. "색상 편집" 버튼 클릭
3. Grade0~7, Normal, Invalid, BIN 색상 표시 확인
4. 색상 변경 → 미리보기 반응 확인
5. 취소 → 원래 색상 복원 확인

### 2. Composite Map

**UI 점검:**
1. Label Explorer에서 이미지 다중 선택
2. "Composite Map" 버튼 클릭
3. 생성 완료 후 색상 편집 → quantile0~100 변경
4. 미리보기 확인, 취소/적용 테스트

**코드 점검:**
- positions 파일 필터링: `[composite-map] positions 필터: N → M개`
- grade_counts NPZ 캐시
- Full vs Subset: `only_low_mask=None`

### 3. LoginId 경로

**코드 점검:**
- `FALLBACK_LOGIN_ID` = env (기본 `"notsaml"`) — `api/config.py` 단일 소스
- `personal_colors.py`: `ANONYMOUS_SCHEME = FALLBACK_LOGIN_ID`
- `composite_map.py` / `my_lot.py`: `ANONYMOUS_LOGIN_ID = FALLBACK_LOGIN_ID`
- JS `main.js`: `FALLBACK_LOGIN_ID = 'guest'`이지만 서버 sentinel(`notsaml`, `guest`)과 함께 동작하는지 확인
- 서버 로그/통계/저장 경로에서 SAML 로그인 사용자가 fallback ID로 기록되지 않는지 확인

### 4. Label Explorer / MY LOT / 특수 그리드

**Playwright:**
1. Label Explorer에서 클래스 폴더 클릭/다중선택/Ctrl+클릭이 모두 정상 작동하는지 확인
2. LOT Mode ON 상태에서 Label Explorer 클래스 그리드가 어떤 경로를 타는지 확인
3. positions 없는 palette 이미지, PNF/비팔레트 이미지가 첫 진입부터 로드되는지 확인
4. 더블클릭으로 단일 이미지 진입 후 다시 그리드 복귀 시 이미지 수, 순서, 스크롤, flat-grid/LOT-grid 상태가 유지되는지 확인
5. MY LOT의 보기/Grid 보기/단일 이미지 진입이 Label Explorer와 충돌하지 않는지 확인

**Cold restart perceived-load guard (2026-06-10):**
- `js/main.js::refreshLabelExplorer()`는 열린 label class 폴더의 `/api/files` 응답을 모두 기다린 뒤 처음 렌더하면 안 된다.
- `/api/classes`가 끝나면 class tree를 즉시 그리고, 아직 늦는 열린 폴더는 `로딩 중...`으로 표시한 뒤 응답 완료 시 파일 목록으로 교체한다.
- 초기 bootstrap에서 `loadServerConfig()`, `loadColorLegends()`, `loadUserInfo()`는 File Explorer 로딩 완료를 기다리지 않는다. top legend/user bar가 `loadDirectoryContents()` cold path에 묶이면 회귀다.
- E2E 신호: `scripts/e2e_chunk1.js` record `7,12,20 Class / MY LOT / stats`가 Playwright route로 primary label class `/api/files`를 지연시키고, 지연 중에도 `#label-explorer-list`에 class name과 `로딩 중...`이 보여야 한다.

### 5. 그리드/단일 이미지 전환

**Playwright:**
1. Label Explorer에서 class 다중선택 → 그리드 모드
2. 그리드에서 이미지 더블클릭 → 단일 이미지 모드
3. 단일 이미지에서 더블클릭 → 그리드 복귀
4. 3~4번 5회 반복 — 버벅임/멈춤/로딩 실패 없는지

### 6. stats.html

**Playwright:**
1. https://localhost:8443/stats.html 접속
2. Chart.js 로딩, /api/stats 응답, 통계 표시 확인

### 7. Measure Overlay / Filter

**확인:**
- Measure overlay 활성 시 gradient 범례 전환
- 범례 클릭으로 percentile 범위별 칩 선택
- BIN chip filter 갯수 표시
- overlay + filter 동시 작동

### 8. Page Manager (멀티탭)

**UI 점검:**
1. 하단 `#page-tab-bar`에 탭 표시 확인
2. `+` 버튼 클릭 → 새 탭 생성
3. 탭 전환 시 뷰어 상태(그리드/단일) 독립 유지
4. 탭 역할 색상: wafer=파란, label=보라, mylot=초록
5. 탭 `x` 닫기 → 인접 탭 활성화
6. PageUp/PageDown → 탭 전환

### 9. Thumbnail Navigator & Minimap

**Thumbnail Navigator:**
1. 단일 이미지 모드 → `#thumbnail-navigator` 자동 표시
2. 썸네일 클릭 → 이미지 전환
3. 드래그 이동 / 리사이즈 핸들 동작
4. 닫기 버튼 → 숨김
5. 3000장 가상 스크롤 성능

**Minimap:**
1. `#minimap-container` 자동 표시
2. `#minimap-viewport` 줌 레벨에 비례 크기 변화
3. Minimap 클릭 → 메인 뷰 팬 이동
4. 뷰포트 드래그 → 실시간 팬

### 10. 다중검색 & 권한 관리

**다중검색:**
1. "다중검색" 버튼 → `#multi-search-modal` 열기
2. LOT ID 줄바꿈 입력 → 적용 → 해당 LOT만 그리드 표시
3. 빈 입력 시 에러 표시

**권한 관리:**
1. "권한 변경" 버튼 → `#permission-editor-modal` 열기
2. 역할 필터(ALL/POWER/ADMIN/SUPER) 전환
3. 사용자 검색 → 결과 드롭다운
4. 등록 테이블 행 추가/역할 설정

### 11. 컨텍스트 메뉴 복사/다운로드

**확인:**
1. 그리드 이미지 우클릭 → 메뉴 8개 항목 전체 표시
2. "LOT 리스트 복사" → 클립보드에 `LOT\tWafer` 형식
3. "wafer 정보 복사" → 탭 구분 테이블 형식
4. "이미지 복사 (Legend 포함)" → merge+legend 캔버스 → 클립보드
5. "선택 파일 다운로드" → 배치 다운로드 시작

### 12. 키보드 단축키 & 드래그 선택

## 점검 순서 권장

1. 코드에서 상태 플래그/경로/캐시 규칙을 먼저 읽어 현재 요구사항을 확인한다.
2. Playwright로 재현 가능한 최소 시나리오를 만든다.
3. 증상이 Label Explorer, MY LOT, Measure, Composite, 단일 이미지, 탭 상태 중 어디에서 시작되는지 분리한다.
4. 수정이 필요한 경우 관련 파일만 좁혀서 변경하고, 재현 시나리오와 인접 시나리오를 다시 확인한다.

**그리드:**
- `Ctrl+A` → 전체 선택, `Escape` → 전체 해제
- 드래그 → `#grid-drag-select` 러버밴드 선택

**단일 이미지:**
- `←/→` → 이전/다음 이미지, `Escape` → 그리드 복귀
- 칩: Ctrl+클릭(추가), Shift+클릭(범위), Alt+드래그(lasso)

**검색창 독립:**
- 포커스 중 `←/→` → 커서 이동 (그리드 네비 X)
- 포커스 중 `Ctrl+A` → 텍스트 전체 선택 (그리드 선택 X)

## 결과 보고 형식

```markdown
## L3 Tracker 점검 결과 — YYYY-MM-DD

### ✅ 정상
- [항목]

### ⚠️ 주의
- [항목] (이유)

### ❌ 이상
- [항목] (상세)

### 수정 필요 사항
- 파일:라인 — 내용
```

### 2026-10-24 PostgreSQL colour and upload verification regressions
- Colour mutation routes in api/full_app.py must run synchronous legend load/save through asyncio.to_thread so DB waits do not block other requests. scripts/check_audit_api.py checks event-loop progress during delayed DB loads for all three routes.
- scripts/manage_db.py::verify must load each distinct namespace once, rather than once per source row. scripts/check_postgres_storage.py checks namespace query counts and preservation of newer DB values.
- The extracted colour legend route test supplies its package context and isolated file-mode database stub; it must not import the server or depend on local DB configuration.

### 2026-10-24 Start-script DB configuration
- DB settings belong to start.ps1 (Windows) and start.sh (Linux); api/database.py must not load .env files. The standalone upload_json_to_db.py reads literal DB assignments from the matching start script without executing it. Upload wrappers run that Python file.
- Start scripts only configure and launch the app; do not add migration/action dispatch. Verify python upload_json_to_db.py (Windows) and python3 upload_json_to_db.py (Linux), including nonzero failure propagation. Importing must not launch the app or clean caches.

### Cross-feature interaction coverage (2026-10-24)
- A full inspection includes Class Manager and Label Explorer CRUD, then live multi-tab interaction rather than testing each module in isolation.
- e2e_chunk3.js record tab-state-preserve-10-tabs repeats real tab/thumbnail/viewer clicks across wafer, label, composite, measure and MY LOT five times each; compare image order, selection state and highlight, explorer scope, overlay, scroll, loaded thumbnails and rendered pixels. Browser errors and HTTP5xx fail the interaction.
- e2e_extended_linked.js adds search/sort/LOT, class rename/collision, label membership, MY LOT groups, colour cancel, navigator/minimap, multi-search, scratch-tab lifecycle and actual DOM-cache eviction after opening more live tabs than the cache limit. Run via extended-linked or the complete extended lane only with explicit E2E consent.

### 2026-10-24 Measure single-view return state leaking between tabs
- Root cause: js/main.js::enterSingleImageMode stored multi-Measure return items in _singleImageMeasureRestoreItems, but captureActivePageState/applyPageState did not preserve or clear that field per tab. Leaving a Measure detail and later returning from a wafer detail could apply stale Measure items, replacing a 5000-image grid with a 1000-entry duplicated Measure grid.
- Fix: serialize/restore the pending Measure return items with each page state, and clear them before opening a new single image. Keep the existing empty-selection double-click auto-highlight behavior.
- Guard: extended-cross-role reuses chunk3 ten-tab fixtures and performs 25 real cross-role double-click/tab roundtrips with exact image order/count, selection/highlight, scroll, visible-image and pixel assertions. It is a separate lane so the unchanged per-chunk timeout is retained. Browser E2E requires explicit consent.

### 2026-10-24 Class selection lost after grid detail roundtrip
- Root cause: js/main.js::loadImage cleared labelSelection.selectedClasses for grid-derived single images as well as direct Explorer image selection. Re-entering a Label grid after cross-tab detail viewing lost its selected class.
- Fix: keep class selection when singleImageFromGrid is true; retain the existing clear for direct Explorer image selection. The extended-cross-role lane compares selected classes as well as grid selection through repeated actual double-click/tab interactions.

### 2026-10-24 Modified selection overwritten by a stale double-click snapshot
- Root cause: toggleGridImageSelect retained the earlier plain-click snapshot after Ctrl/Shift selection. A double-click on that earlier image within 900ms could restore stale indices, dropping the new multi-selection.
- Fix: invalidate the plain-click snapshot when Ctrl/Shift modifies selection, and restore it only while the clicked image is still the sole selection. This also protects Ctrl+A from the same stale snapshot. Keep uninterrupted plain-click/double-click restoration behavior.
- Guards: check-audit-frontend.mjs exercises original methods for Ctrl, Shift, Ctrl+A and the normal double-click case. extended-linked navigator/zoom/minimap returns to the original grid and strictly compares selection and highlight without timing/selection-order workarounds.

### 2026-10-24 Colour cancellation racing with background pyramid generation
- Root cause: colour preview/cancel invalidated a user cache tree while _generate_pyramid_pipeline wrote a temporary JPEG inside it. Retry recovered the UI, but the server logged an encoder ENOENT error. File stat/read could also race deletion.
- Fix: full_app.py::_thumbnail_cache_guard permits concurrent generation/read per cache owner and excludes invalidation until active users finish. Reentrant reads and distinct-owner parallelism are preserved. Pipeline uses the existing per-output-path lock; API cache waits run off the event loop. Pyramid responses snapshot stat+bytes under the same ownership guard. Use lexical absolute cache keys so Windows path resolution does not open files during replacement.
- Guards: check_pyramid_regressions.py blocks a real native JPEG encoder while queueing deletion, tests same-owner/different-owner concurrency and reentrant reads, then verifies deletion and regeneration. check_thumbnail_publication.py checks reader/deletion ordering and encoder-failure release. extended-linked colour cancellation plus server-log-guards must pass together; keep original failure artifacts.

### 2026-10-24 Delayed LOT scroll restoration touching another tab
- Root cause: flat showGrid scroll callbacks had no render/page guard; showGridByLot callbacks checked a render generation but not page ownership. Switching to a cached tab did not necessarily start a new render generation, so a previous tab could move the new tab from scroll0 to62.
- Fix: guard both flat and LOT callbacks by render generation and originating page ID. Release the old restoration flag when its page has changed, without moving or refreshing the new page. Preserve strict pixel scroll assertions and existing global grid-column preferences.
- Guards: check-audit-frontend.mjs executes both original flat/LOT callbacks against another active page and a newer render (failed62!=0 before the fix). extended-linked close/recreate keeps strict scroll comparison and adds real cache eviction with more tabs than the DOM cache limit.
