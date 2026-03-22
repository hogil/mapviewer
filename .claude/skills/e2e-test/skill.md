---
name: e2e-test
description: "L3 Tracker 전체 기능 E2E 테스트 (Playwright 브라우저 자동화). 37개 Phase로 페이지 로드, 그리드, 검색/필터, 색상, 범례, LOT Mode, Class Manager, Composite, Ref Map, Measure, MY LOT, 단일 이미지 모드, Page Manager, Thumbnail Navigator, Minimap, 다중검색, 권한 관리, 컨텍스트 메뉴 복사/다운로드, 키보드 단축키, 그리드 상태 복구 안정성, 그리드↔단일 이미지 전환 스크롤/로딩 안정성, Measure 다중선택 사이드바이사이드, 성능 벤치마크, 이미지 무결성 검증을 자동 점검한다. '/e2e-test', 'E2E 테스트', '전체 테스트', '기능 테스트 돌려줘' 등의 요청에 반응한다."
context: fork
agent: general-purpose
argument-hint: [Phase 번호 또는 범위]
---

# L3 Tracker E2E 기능 점검

Playwright MCP를 사용하여 L3 Tracker의 모든 주요 기능을 자동으로 테스트합니다.
`browser_evaluate`로 JS를 실행하고, `browser_take_screenshot`으로 시각 확인합니다.

## 사전 조건 (자동 설정)

테스트 실행 전에 아래 단계를 **순서대로** 자동 수행합니다. 이미 준비된 항목은 건너뜁니다.

> **필수**: 브라우저는 **항상 1920×1080 최대화** 상태로 동작해야 한다. 모든 Phase에서 UI 요소가 뷰포트 안에 보여야 한다.
> - MCP 서버 설정(`~/.claude.json`)에 `--viewport-size 1920,1080` 옵션이 반드시 포함되어야 한다.
> - 페이지 접속 직후 `browser_resize(1920, 1080)`도 반드시 실행한다 (이중 보장).
> - 페이지 새로고침이나 네비게이션 후에도 뷰포트 크기를 재확인한다.

### Step 0-1: Playwright MCP 설치 확인 및 브라우저 최대화
1. `browser_navigate` 등 Playwright MCP 도구 호출을 시도하여 연결 확인
2. 실패 시 `npx @playwright/mcp@latest --install` 실행하여 브라우저 설치
3. 재시도하여 MCP 연결 확인 — 실패 시 사용자에게 안내 후 중단
4. **브라우저 창 최대화**: 페이지 접속 직후 `browser_resize`로 **width: 1920, height: 1080** 설정 (전체 화면으로 UI 테스트)
5. **MCP 설정 확인**: `~/.claude.json`의 playwright args에 `--viewport-size 1920,1080`이 포함되어야 한다:
   ```json
   "args": ["...", "@playwright/mcp@latest", "--browser", "chromium", "--viewport-size", "1920,1080"]
   ```

### Step 0-2: 서버 시작 (원샷 스크립트)

**반드시 아래 순서를 정확히 따른다. 서버 접속 확인 전에 테스트를 시작하지 않는다.**

1. **원샷 서버 시작** (프로세스 종료 → 포트 대기 → 시작 → HTTP 200 확인을 한번에):
   ```bash
   bash scripts/start-e2e-server.sh 8443
   ```
   - 출력이 `READY:8443`이면 → `BASE_URL=https://localhost:8443`
   - 출력이 `READY:8444`이면 → 포트 8443이 점유 중이어서 8444로 시작됨
   - 출력이 `FAIL`이면 → 사용자에게 안내 후 중단

2. **브라우저 접속 확인** (`browser_navigate`로 실제 페이지 로드):
   ```
   browser_navigate(BASE_URL)
   browser_resize(1920, 1080)
   ```
   - 타이틀 "Wafer Map Viewer" 확인
   - 폴더 목록 렌더링 확인 (3초 대기)
   - **실패 시**: `bash scripts/start-e2e-server.sh 8444`로 재시도

3. **절대 금지**: 서버 접속 + 페이지 타이틀 확인 없이 테스트 Phase 진입하지 않는다

### Step 0-3: 테스트 데이터 확인
- 테스트 데이터 폴더: `palette_3k` (3000장), `palette_5mb` (대용량), `wafer_folder`, `wafer_edge_ring`
- 서버 접속 후 파일 탐색기에 위 폴더가 표시되는지 확인 (없으면 경고 후 계속 진행)

### 테스트 데이터 제약 사항 (절대 위반 금지)

1. **원본 이미지 파일 절대 수정 금지**: `wm-811k/` 하위의 PNG 파일을 E2E 테스트 중 변경, 삭제, 덮어쓰기하지 않는다.
   이미지 재생성은 `scripts/refresh_failbit_local_maps.py`로만 수행한다.

2. **chip 영역에 원형 마스크 절대 금지**: chip은 positions JSON의 `rect` (직사각형) 그대로 렌더링한다.
   chip과 배경 사이에 동그라미, 원형 클리핑, 마스크 영역을 만들지 않는다.
   chip 테두리는 항상 직사각형 1px(×scale) border이다.

3. **테스트 이미지 규격**:
   - 해상도: 최소 6000×6000 pixels (현재 6912×6912, scale=3)
   - palette_5mb: 파일명대로 5~30MB (PNG padding chunk)
   - Grade: 0~7 각각 chip 전체의 5%+ 점유, 각 chip 내부 pixel의 95%+ 단일 grade
   - BIN: 285~291 + Normal + Invalid 등 다양한 BIN이 이미지마다 존재
   - chip 테두리: BIN에 따른 palette index (Normal=10, Invalid=11, BIN별 12~23)

### Positions 파일 양식 (compact_array 포맷)

positions 파일은 `{POSITIONS_ROOT}/{폴더}/{이미지stem}.json`에 위치한다.
`/api/chip-positions` API가 이 파일을 읽어 브라우저에 전달한다.

```json
{
  "bucket_b_key": "20260122/wafer_palette_5mb_PE_Engineer.gz",
  "root": "LOTBIG05",        // LOT ID
  "step": "S01",
  "wafer": "W06",
  "stime": "20260106_120000", // 검사 시각
  "partid": "WAFER_5MB-0005",
  "tester": "TST-EQ01",
  "device": "AKSEIFKXK-AB3",
  "pgm": "PGM-MAIN",
  "netd": 384,                // Net Die
  "gd": 330,                  // Good Die
  "yield": "85.94",
  "sys": "3.21",
  "tm": "Engineer",           // Test Mode (Normal/Engineer/Test)
  "lt": "PT",                 // Lot Type (EE/PE/PT)
  "coord": {
    "rot_code": 5,
    "x_min_abs": 0, "y_min_abs": 0,
    "x_max_abs": 23, "y_max_abs": 23,
    "tiles_w_rot": 24, "tiles_h_rot": 24,
    "grid_edges": {
      "xs": [0, 96, 192, ...],   // X 그리드 경계 좌표 (pixels)
      "ys": [0, 96, 192, ...]    // Y 그리드 경계 좌표 (pixels)
    },
    "canvas": { "width": 2304, "height": 2304 },
    "scale": { "sx": 1.0, "sy": 1.0 },
    "border": 1, "defect_border": 2,
    "center_rule": { "even_x_zero": "left", "even_y_zero": "down" }
  },
  "ftn_keys": ["2824", "1409", "5506", ...],  // FBT 키 목록 (500개, 상단 1회)
  "qtn_keys": ["5997", "5055", "5566", ...],  // QVL 키 목록 (500개, 상단 1회)
  "chips": [
    {
      "x_abs": 9, "y_abs": 1,      // 절대 좌표
      "x_cal": -2, "y_cal": -11,   // 캘리브레이션 좌표 (중심 기준)
      "b": "9",                     // BIN 값 (문자열)
      "f": ["7402", "1519", ...],   // FBT 값 배열 (ftn_keys 순서 대응, 500개)
      "q": ["9", "24", "25", ...],  // QVL 값 배열 (qtn_keys 순서 대응, 500개)
      "rect": { "x0": 864, "y0": 96, "x1": 960, "y1": 192 }  // 픽셀 바운딩 박스
    },
    ...
  ]
}
```

**핵심 규칙**:
- `chip.f`는 배열(list), `ftn_keys[i]`에 대응하는 값이 `chip.f[i]`
- `chip.q`는 배열(list), `qtn_keys[i]`에 대응하는 값이 `chip.q[i]`
- 값은 모두 문자열 (숫자로 변환 시 `float(raw)` 또는 `Number(raw)`)
- `rect.quad`는 없음 (제거됨)
- `/api/chip-positions` 응답: 기본적으로 칩별 f/q 제거 (경량화), `include_fq=1` 시 포함
- `chip-annotator.js`의 `loadPositions()`에서 `include_fq=1`로 호출 (단일 이미지 뷰)

**데이터 규모 (테스트 환경)**:
| 폴더 | 파일 수 | chips/파일 | ftn_keys | qtn_keys | 파일 크기 |
|------|---------|-----------|----------|----------|----------|
| palette_3k | 3000 | 384 | 500 | 500 | ~1.9MB |
| palette_5mb | 6 | 812 | 500 | 500 | ~4MB |

> **참고**: 이후 모든 Phase에서 `https://localhost/` 대신 `BASE_URL`을 사용합니다.

## 테스트 실행 방법

각 Phase를 순서대로 `browser_evaluate`로 실행합니다.
- 각 단계에서 결과 객체를 반환받아 pass/fail 판정
- 실패 시 스크린샷 촬영 후 원인 분석
- alert/confirm 다이얼로그는 `browser_handle_dialog`로 처리
- Phase 끝마다 정리(cleanup)하여 다음 Phase에 영향 없도록

---

### Phase 1: 페이지 로드 & 기본 UI

**목적**: 앱이 정상 기동되고 핵심 UI 요소가 모두 렌더링되는지 확인

**⛔ 금기사항 (절대 위반 금지)**:
- **FALLBACK_LOGIN_ID 값을 절대 변경하지 마라**: `api/config.py`의 `FALLBACK_LOGIN_ID`는 건드리지 않는다. 이 값은 SAML 미인증 상태에서만 사용하는 내부 식별자다.
- **SAML 인증 완료 후 fallback ID가 로그/stats.json/저장 경로에 나타나면 버그다**:
  - 서버 로그(`access_logger`)에 SAML 인증된 사용자의 요청이 `notsaml`이나 `guest`로 찍히면 안 된다. 반드시 실제 LoginId(`ho.choi` 등)로 표시되어야 한다.
  - `stats.json`의 `users`, `daily_stats.active_users`에 SAML 인증 후 fallback ID가 적재되면 안 된다.
  - `logs/color-legends.json`, `my-lot/`, `composite_map/` 저장 경로에 fallback ID가 나타나면 안 된다.
  - 이 모든 곳에서 SAML 인증 완료 시 실제 LoginId가 사용되어야 한다.
- **SAML 인증 후 LoginId 해석은 서버가 한다**: SAML ACS 성공 시 `SAML_IP_TO_LOGIN[client_ip] = LoginId`로 IP→LoginId 매핑 저장. 이후 같은 IP의 모든 요청에서 `_current_login_id()`가 자동으로 실제 LoginId 반환. 프론트에서 fetch를 래핑하거나 URL에 LoginId를 강제로 붙이는 꼼수를 쓰지 마라.
- **프론트가 LoginId를 명시 전달하는 경우**: `/api/user-prefs?LoginId=`, `_withLogin()` 등 프론트가 명시적으로 LoginId를 보내는 API는 기존 패턴 유지. 서버 `_current_login_id()`가 URL 파라미터를 우선 확인하므로 정상 동작.
- **constructor에서 LoginId가 필요한 API를 호출하지 마라**: `my-lot/groups` 등은 `loadUserInfo()` 완료 후에 호출. constructor 시점에는 `currentUser`가 아직 fallback 값이다.
- **서버 미들웨어에서 `_effective_login_id()` 사용 금지**: `AccessTrackingMiddleware`의 `request.state.session_user`에는 `_current_login_id()`만 사용. `_effective_login_id()`는 fallback을 포함하므로 stats.json 오염 원인.

**변경사항 (2026-03-17)**:
- 필터 버튼 UI: LOT/TEST/STEP 선택 시 `.filter-active` 파란색, 드롭다운에 "N개 선택됨" 배지
- Reset 버튼: `↺` → `Reset` 텍스트, 필터 활성 시 파란색
- 헤더 버튼: "Wafer Map Explorer" / "Label Explorer" 텍스트로 변경
- 텍스트: "색변경"→"색 변경", "권한"→"권한 변경"
- Manual 링크: `http://go/failbitmapmanual/`
- FALLBACK_LOGIN_ID: frontend 'guest'→'notsaml' (backend와 통일)
- SAML /acs: `session_user` 쿠키 설정 추가

**평가 항목**:
1. `BASE_URL` 접속 → HTTP 200, 타이틀 "Wafer Map Viewer"
2. 좌측 파일 탐색기(`#file-tree` 또는 `nav[aria-label]`)에 폴더 목록 렌더링 확인
   - `querySelectorAll('nav li, nav .folder-item')` → length > 0
3. 상단 컨트롤 바 버튼 존재 확인:
   - `#lot-mode-btn` 텍스트 "LOT Mode"
   - `#measure-composite-btn-top` 텍스트 "Composite"
   - `[data-ref-map-btn]` 또는 `#ref-map-btn-top` 텍스트 "Ref Map"
   - `#failbit-btn-top` 텍스트 "Measure"
   - `#my-lot-btn-top` 텍스트 "MY LOT"
4. 우측 Class Manager 패널: "Class Manager" 헤딩, "Wafer"/"Chip" 탭 버튼, Add/Rename/Delete Class 버튼
5. 우측 Label Explorer 패널: "Label Explorer" 헤딩, Add/Delete Label 버튼
6. 콘솔 에러 0개 확인 (favicon 404 제외)

7. **fetch 래핑 LoginId 전달 확인**: SAML 로그인 후 (`viewer.currentUser !== 'guest'`일 때)
   - `browser_evaluate`로 `/api/config` fetch 호출 → Network 탭에서 URL에 `LoginId=` 파라미터 포함 확인
   - `viewer.currentUser`가 설정되어 있으면 모든 `/api/` 요청에 `?LoginId=` 자동 추가됨
   - 서버 로그에서 IP 옆에 LoginId가 "—" 대신 실제 ID로 표시되는지 확인

**pass 기준**: 항목 1~6 모두 true, 콘솔 critical error 0, LoginId 전달 확인

---

### Phase 2: 폴더 & 그리드 + 스크롤 성능

**목적**: 폴더 로드, 그리드 렌더링, 대량 이미지 스크롤 시 썸네일 즉시 로드 확인

**평가 항목**:

#### 2-1. 기본 그리드 로드
1. `v.loadImagesInFolderAndShowGrid('palette_3k')` → `v.currentGridImages.length === 3000`
2. `#image-grid`에 `.grid-thumb-wrap` 요소 존재 (가상 스크롤이므로 전체 3000개는 아닐 수 있음)
3. 첫 번째 이미지의 `<img>` 태그 `complete === true`, `naturalWidth > 0`

#### 2-2. 컬럼 수 변경
1. 컬럼 입력 `#grid-cols-input`에 값 7 입력 → 그리드 레이아웃이 7열로 변경 확인
2. 다시 4로 복원

#### 2-3. 전체선택/해제
1. `#grid-select-all` 클릭 → `v.gridSelectedIdxs.length === 3000`, `v.gridSelectedSet.size === 3000`
2. `#grid-deselect-all` 클릭 → `v.gridSelectedIdxs.length === 0`, `v.gridSelectedSet.size === 0`

#### 2-4. 스크롤 성능 (palette_3k, 3000장)
1. 스크롤 래퍼 찾기: `document.querySelector('.viewer-scroll-wrapper')` 또는 `#image-grid`의 parentElement
2. `wrapper.scrollTop = wrapper.scrollHeight` (맨 아래로 즉시 스크롤)
3. 500ms 대기 후 뷰포트 내 보이는 이미지 확인:
   ```javascript
   const visible = [...document.querySelectorAll('#image-grid img')].filter(img => {
     const r = img.getBoundingClientRect();
     return r.top < window.innerHeight && r.bottom > 0;
   });
   const loaded = visible.filter(i => i.complete && i.naturalWidth > 0);
   ```
4. **pass 기준**: `loaded.length / visible.length >= 0.9` (90% 이상 로드), **100ms 이내 목표**
5. 추가 500ms 대기 후 다시 측정 → 100% 로드 확인
6. 스크롤을 중간 지점 (`scrollHeight / 2`)으로 이동 → 동일 측정 반복

#### 2-5. 스크롤 성능 (palette_5mb, 대용량)
1. `v.loadImagesInFolderAndShowGrid('palette_5mb')` → 폴더 로드 확인
2. 맨 아래 스크롤 → 500ms 후 이미지 로드율 측정
3. 다시 `palette_3k`로 전환 → 캐시 히트로 즉시 로드 확인 (로드율 95%+)

#### 2-6. 여러 폴더 전환
1. `wafer_folder` 로드 → `v.currentGridImages` 내용이 이전 폴더와 다른지 확인
2. `wafer_edge_ring` 로드 → 동일 확인
3. `palette_3k` 로드 → 복귀 확인
4. 각 전환 시 이전 폴더 이미지가 그리드에 남아있지 않은지 확인
   - `#image-grid img[src*="이전폴더명"]` → length === 0

**스크린샷**: 맨 아래 스크롤 후 그리드 상태

#### 2-7. 그리드 정렬 (`sort_test` 폴더, 12장)
파일명 형식: `{root}_{step}_{wafer}_{date}_{time}_{yield}_{sys}.png`
(인덱스: 0=LOT, 1=step, 2=wafer, 3=date, 4=time, 5=yield, 6=sys)

1. `v.loadImagesInFolderAndShowGrid('sort_test')` → 12개 이미지 로드 확인
2. **정렬 드롭다운 존재 확인**: `#grid-sort-select` 요소 존재, 7개 옵션 (파일명, LOT↑↓, Yield↑↓, Sys↑↓)
3. **파일명 정렬** (기본값): 첫 이미지 파일명이 자연 정렬 순서 확인
4. **LOT ↑ (오름차순)**:
   - `#grid-sort-select` 값을 `lot_asc`로 변경 → change 이벤트 발생
   - 첫 번째 이미지: LOTA 포함, 마지막 이미지: LOTD 포함
   - `v.currentGridImages[0]`에 "LOTA" 포함, `v.currentGridImages[11]`에 "LOTD" 포함
5. **LOT ↓ (내림차순)**:
   - `lot_desc` 선택 → 첫 번째: LOTD, 마지막: LOTA
6. **Yield ↑ (오름차순)**:
   - `yield_asc` 선택 → 첫 번째 이미지 파일명에서 인덱스[5] = 최소 Yield (54.2)
   - `v._getFilenameParts(v.currentGridImages[0])[5]` === "54.2"
7. **Yield ↓ (내림차순)**:
   - `yield_desc` 선택 → 첫 번째 = 최대 Yield (99.1)
   - `v._getFilenameParts(v.currentGridImages[0])[5]` === "99.1"
8. **Sys ↑ (오름차순)**:
   - `sys_asc` 선택 → 첫 번째 = 최소 Sys (0.5)
9. **Sys ↓ (내림차순)**:
   - `sys_desc` 선택 → 첫 번째 = 최대 Sys (22.1)
10. **파일명 복원**: `filename` 선택 → 원래 자연 정렬 순서 복원
11. 각 정렬 변경 시 그리드가 즉시 리렌더되고 이미지가 정상 표시되는지 확인

#### 2-8. LOT Mode + 정렬 연동
LOT Mode 활성 상태에서 정렬 변경 시 LOT 그룹핑이 유지되고 그룹 내부 순서만 바뀌는지 확인.

1. `v.loadImagesInFolderAndShowGrid('sort_test')` → LOT Mode ON 확인 (`#lot-mode-btn.active`)
2. LOT 그룹 헤더 존재 확인 (LOTA, LOTB, LOTC, LOTD 그룹)
3. **LOT ↓ (내림차순)**: `lot_desc` 선택
   - LOT 그룹 순서: LOTD → LOTC → LOTB → LOTA (그룹 헤더 순서 확인)
   - 각 그룹 내 이미지도 내림차순
4. **Yield ↑ (오름차순)**: `yield_asc` 선택
   - LOT 그룹 순서: 오름차순 유지 (LOTA → LOTB → ...)
   - 각 LOT 그룹 내에서 Yield 낮은 순 (그룹 내 첫 이미지의 인덱스[5]이 가장 작은 값)
5. **Sys ↓ (내림차순)**: `sys_desc` 선택
   - LOT 그룹 유지, 그룹 내 Sys 높은 순
6. **파일명 복원**: `filename` 선택 → 그룹 내 자연 정렬 순서 복원
7. LOT Mode OFF → 정렬 상태 유지 확인 (flat 그리드에서도 동일 순서)
8. LOT Mode ON → 다시 그룹핑 + 정렬 유지

**pass 기준**: 7개 정렬 옵션 모두 LOT 그룹핑 유지, 그룹 내 정렬 정확, 모드 전환 시 정렬 유지

---

### Phase 3: 제품 검색 & 필터 (LOT/TEST/STEP)

**목적**: 검색/필터로 이미지 목록을 좁힐 수 있는지, 필터 해제로 복원되는지 확인

**평가 항목**:

#### 3-1. 제품 검색
1. 검색 입력창 `input[placeholder*="제품 검색"]`에 "palette" 입력
2. 파일 탐색기에 "palette" 포함 폴더만 표시되는지 확인
3. 검색어 지우기 → 전체 폴더 복원

#### 3-2. LOT/TEST/STEP 필터 — 전체 동작 라이프사이클

**핵심 원칙**:
- 필터 미선택(초기 상태) → LT/TM 읽기 없음, 모든 파일 그대로 표시
- 필터 선택 시 → 파일명에서 LT/TM 추출 (인덱스 폴더 캐시 활용, 상세: 3-9)
- 필터 변경 시 → API 재호출 없이 DOM show/hide만 (메타는 이미 캐시됨)
- 필터 해제/Reset → 숨겨진 `<li>`만 `display:''` 복원

##### 3-2-1. 필터 미선택 상태 (초기)
1. 제품 폴더 선택 (changeFolder) → `v.filterFileMetadata`는 빈 객체 `{}`
2. 탐색기에 폴더/파일 전체 표시 — positions 파일 읽기 없음
3. 폴더 클릭하여 열기 → 파일 전체 표시, 필터 미적용
4. `v.filterLT === []`, `v.filterTM === []` 확인

##### 3-2-2. 폴더 열어놓은 상태에서 필터 선택
1. 탐색기에서 폴더를 열어놓은 상태 확인 (파일 목록 보임)
2. LOT 버튼 클릭 → 드롭다운 열림
3. LOT > EE 체크 → change 이벤트 발생
4. **첫 필터 적용 시**: `_applyFilterToExplorer()` 호출
   - 파일명에 _LT_TM이 있으면 인덱스 폴더 캐시에서 파싱으로 즉시 추출 (데이터 소스 상세: 3-9)
   - 없으면 `fetchFilterMetadata(path)` API 호출 (positions 폴백, 상세: 3-9)
   - DOM의 `<li>` 요소에 `display:none`/`''` 토글
   - **폴더는 열린 상태 유지 (innerHTML 교체 없음)**
5. 결과: 해당 LOT 파일만 표시, 나머지 숨김

##### 3-2-3. 필터가 적용된 상태에서 추가 필터 변경
1. LOT=EE 상태에서 TEST > ENGINEER 체크
2. **메타가 이미 로드되어 있으므로** API 호출 없음
3. `_applyFilterToExplorer()` → DOM show/hide만 (7ms 이내)
4. 결과: LOT=EE AND TEST=ENGINEER 조건의 파일만 표시
5. LOT=EE 해제 → TEST=ENGINEER만 적용
6. LOT=PT 추가 → LOT=PT AND TEST=ENGINEER 적용

##### 3-2-4. 필터 해제 (개별 체크 해제)
1. TEST > ENGINEER 체크 해제 → `v.filterTM = []`
2. `_applyFilterToExplorer()` → LOT 필터만 적용, TEST 무시
3. LOT도 해제 → 필터 없음 → 모든 `<li>` display:'' → 전체 파일 표시

##### 3-2-5. Reset 버튼
1. Reset 클릭 → `v.filterLT = [], v.filterTM = [], v.filterSTEP = []`
2. 모든 체크박스 해제 (`_restoreMultiSelectUI`)
3. `_applyFilterToExplorer()` → 숨겨진 `<li>`만 display:'' 복원 → 전체 표시
4. 폴더 열림 상태 + 스크롤 위치 유지 (상세 검증: 3-4)

##### 3-2-6. 새 폴더 열 때 필터 자동 적용
1. 필터가 활성인 상태에서 탐색기의 닫힌 폴더를 클릭하여 열기
2. `loadDirectoryContents(path, contentDiv)` 호출
3. 파일 HTML 렌더링 후 즉시 필터 적용 (DOM show/hide)
   - `loadDirectoryContents` 내부에서 `hasFilter` 체크 → `_passesLtTmFilter` + `_passesStepFilter`
4. 결과: 새로 연 폴더에도 현재 필터 조건이 즉시 반영

##### 3-2-7. 필터 버튼 색상 활성화
1. 필터 선택 시 해당 버튼(LOT/TEST/STEP)에 `filter-active` 클래스 추가 → 파란색
2. 필터 해제 시 `filter-active` 클래스 제거 → 원래 색
3. Reset 버튼도 필터 활성 시 파란색, 전부 해제 시 원래 색
4. 드롭다운 패널 상단에 "N개 선택됨" 배지 표시/제거

**검증 단계** (LOT과 TEST 둘 다 해야 함):
1. LOT 단독 (EE → PT → PE → E% 와일드카드) + TEST 단독 (NORMAL → ENGINEER)
2. LOT + TEST 조합 (EE + NORMAL → EE + ENGINEER → PT + NORMAL)
3. 대소문자 무시: 파일명 `_EE_Normal` vs 체크박스 `ENGINEER` (title case ↔ UPPER)
4. 와일드카드: E% → lt가 `E`로 시작하는 파일만 (`startsWith` 매칭)
5. 추가/제거 (LOT=EE 추가 → LOT=EE 제거 → TEST만 남음, 부분 해제 상세: 3-3-1)
6. Reset → 전체 복원
7. 새 폴더 열기 → 필터 자동 적용 확인

#### 3-3-1. 부분 해제 시 나머지 필터 유지 (초기화 금지)
**핵심**: 여러 필터 중 하나를 해제하면 나머지 필터만으로 재필터링해야 한다.
해제된 것만 보고 전체 초기화하면 안 된다.

1. **LOT 와일드카드 부분 해제**:
   - P% + E% 체크 → 전체 표시 (P+E=모두)
   - P% 해제 → **E%만 적용** (전체가 아님!) → `filterLT = ["E%"]`
   - E%만 남은 상태에서 파일 수가 전체보다 적은지 확인
2. **LOT 개별 부분 해제**:
   - EE + PT + ENGINEER 체크
   - PT 해제 → **EE + ENGINEER만** (초기화 아님!) → `filterLT = ["EE"]`
   - EE도 해제 → **ENGINEER만** → `filterLT = [], filterTM = ["ENGINE",...]`
3. **LOT+TEST 교차 해제**:
   - E% + NORMAL 체크
   - E% 해제 → **NORMAL만** → `filterLT = [], filterTM = ["NORMAL","NORM"]`
   - NORMAL 해제 → 전체 (필터 없음)
4. **검증 포인트**: 각 해제 단계에서 `v.filterLT`, `v.filterTM` 배열이 정확한지,
   DOM에 표시되는 파일 수가 남은 조건에 맞는지 확인

#### 3-4. 필터 변경 시 열린 폴더 상태 보존 (DOM show/hide)
필터는 `_applyFilterToExplorer()`로 DOM의 `<li>` 요소를 `display:none`/`''` 토글.
API 재호출이나 innerHTML 교체가 **없어야** 한다 (폴더 닫힘 금지).

1. 폴더 3개 열기: `palette_3k`, `palette_5mb`, `wafer_folder`
   - `details[open] > summary[data-path]` 로 열린 폴더 3개 확인
2. TEST 필터에서 NORMAL 체크 (change 이벤트 발생)
3. 필터 적용 후 확인:
   - `details[open]` 폴더가 필터 전과 동일한 3개인지 확인
   - DOM 파일 수 변화 없음 (숨겨진 것만 다름): `querySelectorAll('a[data-path]').length` 동일
   - 보이는 파일 수만 변경: `filter(a => a.closest('li')?.style.display !== 'none').length` < 전체
4. 필터 해제 후에도 폴더 열림 상태 유지 확인

#### 3-5. 필터 성능 — DOM show/hide 속도 (palette_3k, 3000파일)
메타 로드 후 필터 전환은 API 호출 없이 DOM만 조작하므로 즉시 반영되어야 한다.

1. `palette_3k` 폴더에서 메타 로드 완료 확인 (`Object.keys(v.filterFileMetadata).length === 3000`)
2. LOT=EE 적용:
   ```javascript
   v.filterLT = ['EE'];
   const t0 = performance.now();
   await v._applyFilterToExplorer();
   const elapsed = performance.now() - t0;
   // elapsed < 50ms (API 호출 없음, DOM show/hide만)
   ```
3. LOT=EE + TEST=ENGINEER 적용: `elapsed < 50ms`
4. Reset: `elapsed < 10ms`

#### 3-6. 필터 연속 클릭 취소 (시퀀스 카운터)
빠르게 여러 필터를 연속 클릭하면 이전 요청은 취소되고 마지막만 실행.

1. 필터 3개 연속 빠르게 체크 (await 없이):
   ```javascript
   check(ltPanel, 'EE', true);
   check(ltPanel, 'PT', true);
   check(ltPanel, 'PE', true);
   ```
2. 1초 대기 후 결과가 **마지막 조건(EE|PT|PE)** 기준으로 필터링 확인
3. 중간 상태(EE만, EE|PT만)가 최종 DOM에 남아있지 않은지 확인

#### 3-7. 필터 변경 시 스크롤 위치 보존
1. 탐색기를 중간으로 스크롤 → 앵커 파일/폴더 확인
2. LOT 필터 적용 → 보이는 첫 번째 폴더가 필터 전과 동일 (또는 scrollTop 근사 유지)
3. 필터 해제 → 원래 스크롤 위치로 복원
4. Reset → 동일하게 스크롤 복원

#### 3-8. Ubuntu 호환성 검증
1. `_extract_lt_tm` 함수에서 `os.O_BINARY` 대신 `getattr(os, 'O_BINARY', 0)` 사용 확인
   (코드 확인: `api/main.py`의 `_extract_lt_tm` 내 `os.O_BINARY` 문자열 없음)
2. API 경로 해석: 절대 경로 전달 시 `Path(path).resolve().relative_to(ROOT_DIR)` 사용 확인

#### 3-9. LOT/TEST 필터 데이터 소스 — 인덱스 → 폴더 캐시 → 파일명 추출

**핵심**: LT/TM 값은 **이미지 파일명 자체에 포함**되어 있다.
서버 시작 시 파일 인덱스를 빌드하는데, 이때 **파일명이 인덱스에 들어간다**.
인덱스 빌드 직후 폴더별 캐시(`_FOLDER_FILES_CACHE`)를 자동 생성한다.
폴더 캐시에 이미 파일명이 있으므로 **파일명에서 LT/TM을 바로 추출**할 수 있다.
**positions 파일을 읽을 필요가 없다** — 이것이 핵심 최적화.

**서버 시작 흐름 (1회)**:
```
1. 파일 인덱스 빌드 (100만개 파일명 스캔, 3.8초)
   → 파일명 예: "palette_3k/wafer_0001_EE_Normal.png"
   → 파일명 안에 이미 LT=EE, TM=Normal이 들어있음

2. 인덱스 완료 → 폴더별 캐시 자동 생성 (_FOLDER_FILES_CACHE)
   → { "palette_3k": ["palette_3k/wafer_0001_EE_Normal.png", ...3000개] }
   → 미리 정렬됨, dict[폴더명] O(1) 조회
```

**필터 요청 흐름 (`/api/filter-metadata`)**:
```
1차 (빠른 경로 — 3ms):
  → _FOLDER_FILES_CACHE[폴더명]에서 파일명 목록 가져옴 (O(1))
  → 각 파일명 rsplit("_", 2) → LT/TM 추출
  → positions 파일 접근 없음!
  → _FILTER_META_SERVER_CACHE에 응답 바이트 저장

2차 (폴백 — 파일명에 LT/TM 없는 레거시 데이터):
  → positions 폴더의 JSON 파일들을 ThreadPoolExecutor(64) 병렬 head-read 512B
  → bytes.find로 "lt", "tm" 키 추출
  → ~176ms (서버 캐시 후 ~32ms)
```

**JS 클라이언트 측 (`_passesLtTmFilter`)**:
```
1차: filterFileMetadata[stem] 조회 (서버 API에서 받은 메타)
2차: 없으면 파일명 split('_') → 끝에서 1번째=TM, 2번째=LT 추출
3차: 둘 다 없으면 return true (필터 미적용 통과)
```

**운영 파일명 형식**: `{LOT}_{STEP}_{WAFER}_{stime}_{yield}_{sys}_{LT}_{TM}.png`
예: `ABC123_00P_W01_20260122_022718_87.35_3.21_EE_Normal.png`
→ `rsplit("_", 2)` → `["..._3.21", "EE", "Normal"]` → LT=`EE`, TM=`Normal`

**검증 항목**:
1. 파일명에 _LT_TM 있는 폴더: 필터 첫 적용 **< 50ms** (positions 안 읽음 확인)
2. 파일명에 _LT_TM 없는 폴더: 필터 첫 적용 **< 200ms** (positions 폴백)
3. 같은 폴더 재요청: **< 35ms** (서버 캐시 `_FILTER_META_SERVER_CACHE`)
4. 필터 해제 후 재적용: 필터 미선택과 동일 속도
5. 서버 시작 시 `[INDEX] Folder files cache built: N folders` 로그 확인

#### 3-10. 폴더 선택 + 그리드 성능 — 인덱스 폴더 캐시 활용
`selectAllFolderFiles`도 인덱스 폴더 캐시를 사용한다.
`/api/files/recursive` API가 `_FOLDER_FILES_CACHE[폴더명]`에서 O(1) 조회하므로
os.walk 디스크 순회 없이 즉시 반환.

1. **필터 없이 selectAllFolderFiles + showGrid**: 합계 **< 100ms**
   - selectAllFolderFiles: 인덱스 폴더 캐시 O(1) 조회 (~7ms)
   - showGrid: DOM 렌더링 (~68ms)
2. **필터 있을 때 (파일명 _LT_TM)**:
   - 첫 적용: **< 50ms** (인덱스 캐시에서 파일명 파싱)
   - 변경: **< 20ms** (DOM show/hide)
3. **필터 해제 후**: 필터 없는 속도와 동일 (~44ms)
4. **인덱스 미빌드 시**: os.walk 폴백 (첫 요청 ~384ms)

#### 3-11. 이미지 선택 최대 3000개 제한
1. 10만개 이미지가 있는 폴더 Ctrl+클릭 시
2. `selectAllFolderFiles`에서 3000개 초과 시 잘라냄
3. 토스트 "최대 3000개까지 선택 가능합니다 (N개 중 3000개 선택됨)" 표시
4. 그리드에 3000개만 렌더링 (브라우저 메모리 보호)

#### 3-12. 검색 연산자 동작 검증 (and, or, not, ())

**연산자 규칙**: `and`/`or`/`not`은 **양쪽에 띄어쓰기**가 있어야 연산자로 인식.
`android`의 `and`는 연산자가 아님 (단어 경계 `\b` 체크).

**timestamp 처리**: 연산자가 있으면 파일명에서 `YYYYMMDD_HHMMSS` 자동 제거.
단순 문자열 검색(연산자 없음)은 timestamp 포함 전체 파일명에서 검색.

##### 3-12-1. and 연산자
1. `ABC123 and 03` → 파일명에 "ABC123" 포함 AND "03" 포함 (timestamp 제거됨)
   - timestamp의 "03"에 매칭되지 않음 확인
2. `ABC123 and 00P and 03` → LOT, STEP, WAFER 3개 조건 AND
3. 결과 파일 수가 개별 검색보다 적은지 확인

##### 3-12-2. or 연산자
1. `ABC123 or DEF456` → 둘 중 하나라도 포함된 파일
2. 결과 파일 수가 개별 검색의 합과 같거나 적은지 확인 (중복 제거)

##### 3-12-3. not 연산자
1. `ABC123 not 00C` → "ABC123" 포함하지만 "00C" 없는 파일
2. 결과에 "00C" 포함 파일이 없는지 확인

##### 3-12-4. () 그룹핑
1. `(ABC123 or DEF456) and 03` → (ABC123 또는 DEF456) 이면서 03 포함
2. 괄호 없이 `ABC123 or DEF456 and 03`과 결과가 다른지 확인 (우선순위)

##### 3-12-5. 단순 문자열 검색 (연산자 없음)
1. `ABC123_00P_03` → 전체 파일명에서 부분 일치 (timestamp 포함)
2. `20260122` → 날짜로 검색 가능 (timestamp 제거 안 됨)
3. `022718` → 시간으로 검색 가능

##### 3-12-6. 연산자와 일반 단어 구분
1. `android` → 단순 검색 ("and"가 연산자로 인식되지 않음)
2. `sand` → 단순 검색 ("and"가 연산자로 인식되지 않음)
3. `normal` → 단순 검색 ("or"가 연산자로 인식되지 않음)

#### 3-13. 검색창 화살표 키 커서 이동
1. 검색 입력창에 텍스트 입력
2. 좌/우 화살표 키로 커서 이동 가능 확인
3. 화살표가 그리드 네비게이션 단축키로 가로채이지 않음

#### 3-14. N/n 키 네비게이터 단축키 제거 확인
1. 단일 이미지 모드에서 `n` 또는 `N` 키 입력
2. 네비게이터 토글이 발생하지 않음
3. 키 입력이 무시되거나 다른 동작 없음

#### 3-15. 필터 적용 후 폴더 Ctrl+클릭 → 그리드에 필터 반영
**핵심**: 탐색기에서 필터로 숨겨진 파일은 폴더 Ctrl+클릭 그리드에도 표시되지 않아야 한다.

1. `filter_test` 폴더 열기 (10개 파일: 00P 5개 + 00C 5개)
2. STEP > PLH 체크 → 탐색기에 00P 파일 5개만 보임
3. `filter_test` 폴더 Ctrl+클릭 (폴더 선택 → 그리드 표시)
4. **검증**: `v.currentGridImages`에 00P 파일만 포함 (5개)
5. **검증**: 00C 파일(`LOT001_W01_00C.png` 등)이 그리드에 없음
6. Reset 클릭 → 그리드 10개로 복원

#### 3-16. 그리드 활성 상태에서 필터 변경 → 그리드 동적 갱신
**핵심**: 그리드가 표시된 상태에서 필터를 변경하면 그리드도 즉시 갱신되어야 한다.

1. `filter_test` 폴더를 필터 없이 Ctrl+클릭 → 그리드 10개
2. STEP > PLH 체크 → **그리드가 00P 파일 5개로 줄어듦**
3. STEP > PLC 추가 체크 → **그리드가 10개로 복원**
4. STEP > PLH 해제 → **그리드가 00C 파일 5개만**
5. Reset 클릭 → **그리드가 10개로 복원**
6. 각 단계에서 `v.currentGridImages.length` 검증

#### 3-17. 필터 새로고침 후 유지 (LOT/TEST/STEP 설정 보존)
**핵심**: 필터를 설정하고 페이지를 새로고침하면 필터 값이 그대로 복원되어야 한다.

1. TEST > NORMAL 체크, STEP > PLH 체크
2. `v.filterTM` = `['NORMAL','NORM']`, `v.filterSTEP` = `['PLH']` 확인
3. 페이지 새로고침 (`page.reload`)
4. 5초 대기 후 `v.filterTM`, `v.filterSTEP` 확인 — 설정값 유지
5. NORMAL 체크박스 checked 확인, PLH 체크박스 checked 확인
6. `filter_test` 폴더 열기 → 00P 파일만 표시 (00C 숨김)
7. 폴더 Ctrl+클릭 → 그리드에 00P 파일만 표시

**pass 기준**: 필터 시 파일만 숨김(폴더 유지, DOM 교체 없음), 대소문자 무시 매칭,
열린 폴더 보존, 해제 시 전체 복원, DOM show/hide 50ms 이내, 연속 클릭 마지막만 실행,
스크롤 보존, Ubuntu 호환, 파일명 _LT_TM 추출 50ms 이내, 폴더선택+그리드 100ms 이내,
선택 3000개 제한, 검색 연산자(and/or/not/()) 정상 동작, 연산자 시 timestamp 제거 + 단순검색 시 timestamp 포함,
단어 경계 구분(android≠and), 검색창 화살표 커서, N키 단축키 없음,
**필터→그리드 반영**, **그리드 중 필터 변경 동적 갱신**, **새로고침 후 필터 유지**

---

### Phase 4: 색상 편집

**목적**: 색상 편집 모달이 정상 열리고 탭 전환이 되는지 확인

**평가 항목**:
1. 색상 편집 버튼 클릭 → `#color-editor-modal` 열림 (`aria-hidden !== 'true'` 또는 `display !== 'none'`)
2. Fail 탭 클릭 → Grade/BIN 색상 테이블 표시 (G0~G7 + Normal, Invalid, B285, ...)
3. Composite 탭 클릭 → Composite gradient 색상 테이블 표시 (quantile0~100)
4. Measure 탭 클릭 → Measure gradient 색상 테이블 표시 (quantile0~100)
5. 닫기 버튼 (`#color-editor-close-btn`) 클릭 → 모달 닫힘
6. 모달이 닫힌 후 그리드가 정상 표시되는지 확인

**pass 기준**: 모달 open/close, 3개 탭(Fail/Composite/Measure) 전환 모두 성공

---

### Phase 5: 상단 컬러 범례 (Grade/BIN/Gradient)

**목적**: 범례 클릭으로 칩 필터가 정상 적용/해제되고, Measure heatmap 적용 시 Gradient 범례로 전환되는지 확인

**평가 항목**:

#### 5-1. Grade 범례 (Top Legend) — **pixel 필터**
1. 그리드 모드에서 상단 범례 영역에 G0~G7 항목 존재 확인
   - `document.querySelectorAll('.top-legend-item, [data-grade]')` → length >= 8
2. G0 클릭 → **pixel 필터 적용**: 해당 palette index(0)를 가진 pixel만 남기고, 나머지 Grade pixel은 Grade0 색상으로 변경하여 표시
   - 서버 API `/api/image` 또는 `/api/thumbnail`에 `grade_filter` 파라미터 전달
   - 스크린샷으로 시각 확인 (선택 Grade만 원래 색, 나머지는 G0 색)
3. G0 다시 클릭 → 필터 해제, 원래 이미지로 복원
4. G1 + G3 연속 클릭 → 두 Grade 동시 pixel 필터 확인 (G1+G3만 원래 색)

#### 5-2. BIN 범례 (Bottom Legend)
1. 하단 범례에 nor, inv, 285, 286, ... ETC 항목 존재 확인
2. "285" 클릭 → BIN 285 칩만 하이라이트/필터
3. Border 버튼 클릭 → 칩 테두리 on/off 토글 (이미지 rerender 확인)
4. 다시 "285" 클릭 → 필터 해제

#### 5-3. Gradient 범례 (Measure heatmap + BIN/FBT/QVL Composite Map)
Composite에서 Failbit이 아닌 모든 항목(BIN/FBT/QVL)은 gradient 범례를 사용합니다.
1. **Measure heatmap**: Measure 패널에서 FBT2342 클릭 → heatmap 적용 (원본 이미지를 `/api/measure-thumb` 이미지로 교체)
2. 상단 범례가 G0~G7에서 percentile 범례 (0~10%, 10~20%, ..., 90~100%)로 변경 확인
   - 범례 텍스트에 "%" 포함 여부로 판별
3. Gradient 범례의 90~100% 클릭 → 해당 범위 칩만 표시, 나머지 흰색
4. 클릭 해제 → 전체 오버레이 복원
5. Measure 초기화 버튼 클릭 → Grade 범례로 복원 확인 (G0~G7 다시 표시)
6. **BIN Composite Map**: Composite에서 BIN285 생성 후 결과 이미지 → gradient 범례 확인
7. **Failbit Composite Map**: Composite에서 Failbit 생성 → Grade 범례 유지 확인
   - Failbit 결과에서 여러 Grade 선택 시 **Subset Grade Composite Map** 생성 가능 확인

#### 5-4. 단일 이미지 모드에서 범례 — 퍼센트/숫자 검증
1. 이미지 더블클릭 → 단일 모드 진입
2. **Grade 범례 퍼센트/칩수 확인** (`#color-legend-top`):
   - G0~G7 각 항목의 `.legend-color-bar` 내부 텍스트에 `%` 와 `(` 포함 확인
   - 예: "25.3%(12.5K)", "8.1%(404)" 형태
   - 모든 Grade 퍼센트 합이 약 100% (±2%) 확인:
     ```javascript
     const items = document.querySelectorAll('#color-legend-top .legend-color-bar span');
     const pcts = [...items].map(s => parseFloat(s.textContent));
     const sum = pcts.reduce((a,b) => a+b, 0);
     // sum should be ~100 (±2)
     ```
   - 각 퍼센트가 0 이상, 숫자가 유효한 값인지 확인
3. **BIN 범례 퍼센트/칩수 확인** (`#color-legend-bottom`):
   - Normal, Invalid, 285~390, ETC 각 항목의 `.legend-color-bar` 내부 텍스트에 `%` 와 `(` 포함 확인
   - 예: "15.2%(12)", "42.0%(56)" 형태
   - 칩수가 0 이상의 정수인지 확인
   - BIN 전체 칩수 합이 NET 값(정보패널)과 일치하는지 확인
4. **Grade 범례 클릭 기능** (pixel 필터):
   - G3 클릭 → `v.selectedGrades.has(3) === true`, canvas rerender 확인
   - 스크린샷으로 G3만 원래 색, 나머지 G0 색 확인
   - G3 다시 클릭 → 필터 해제, `v.selectedGrades.size === 0`
   - Ctrl+클릭으로 G1+G5 동시 선택 → `v.selectedGrades.size === 2`
   - 우클릭 → 전체 해제 (`v.selectedGrades.size === 0`)
5. **BIN 범례 클릭 기능** (칩 필터):
   - "285" 클릭 → `v.selectedBottoms.has('285') === true`, 해당 BIN 칩만 하이라이트
   - 스크린샷 확인
   - "285" 다시 클릭 → 필터 해제
   - Ctrl+클릭으로 "Normal"+"285" 동시 선택 → `v.selectedBottoms.size === 2`
   - 우클릭 → 전체 해제
6. **Border 버튼**: 클릭 → 칩 테두리 on/off, canvas rerender 확인
7. Back → 그리드 복귀 시 범례 상태 유지 확인

#### 5-5. Measure heatmap 단일 모드 — Gradient 범례 퍼센트/칩수 및 클릭
1. 그리드 모드로 복귀 → Measure 패널에서 FBT2342 클릭 → heatmap 적용
2. 이미지 더블클릭 → 단일 모드 진입
3. **Gradient 범례 퍼센트/칩수 확인** (`#color-legend-top`):
   - 10개 항목 (`0~10%`, `10~20%`, ..., `90~100%`) 존재 확인
   - 각 항목의 `.legend-color-bar` 내부 텍스트에 `%` 와 `(` 포함 확인
   - 예: "18.5%(245)", "5.2%(12)" 형태
   - 모든 범위 퍼센트 합이 약 100% (±2%) 확인
4. **Gradient 범례 클릭 기능** (칩 필터):
   - `90~100%` 클릭 → `v.selectedGradientRanges.has(9) === true`
   - 해당 범위 칩만 표시, 나머지 흰색 처리 확인 (스크린샷)
   - 다시 클릭 → 해제, `v.selectedGradientRanges.size === 0`
   - Ctrl+클릭으로 `0~10%` + `90~100%` 동시 선택 → `v.selectedGradientRanges.size === 2`
   - 우클릭 → 전체 해제
5. **BIN 범례**: Gradient 모드에서도 하단 BIN 범례는 유지, 퍼센트/칩수 표시 확인
6. Measure 초기화 → Grade 범례 복원, 퍼센트/칩수 다시 표시 확인
7. Back → 그리드 복귀

**스크린샷**: Grade 필터 적용, Gradient 범례 칩수 표시, Gradient 클릭 필터 적용

---

### Phase 6: LOT Mode

**목적**: LOT별 그룹화 표시 on/off 전환

**평가 항목**:
1. `#lot-mode-btn` 클릭 전 `classList.contains('active')` 확인 (기본값 true)
2. 클릭 → `active` 해제, 그리드가 LOT 헤더 없이 flat 표시
3. 다시 클릭 → `active` 복원, LOT 헤더(`▸ wafer`, LOT 구분선) 표시
4. LOT 헤더의 이미지 개수 배지 표시 확인

#### 6-2. LOT/TEST/STEP 필터 → 그리드/LOT 모달 연동
1. LOT 필터 패널에서 "EE" 체크 → `v.filterLT = ["EE"]`
2. 폴더 선택 → 그리드에 "EE" 파일만 표시 확인 (파일명에 EE 포함)
3. LOT 모달 열기 → LOT 목록에서 EE가 아닌 LOT의 이미지 수가 감소하거나 숨겨짐 확인
4. 그리드 이미지 더블클릭 → 단일 모드 → Navigator 이미지 리스트에 EE 파일만 포함 확인
5. 필터 해제 → 그리드/모달/Navigator 원래 수 복원 확인

#### 6-3. `loadImagesInFolderAndShowGrid` 필터 적용
1. `v.filterLT = ["PT"]` 설정
2. `v.loadImagesInFolderAndShowGrid('palette_3k')` 호출
3. `v.currentGridImages`에 PT 파일만 포함 확인
4. 전체 3000개보다 적은 수 확인
5. 필터 해제 후 재호출 → 3000개 전체 로드 확인

**pass 기준**: 토글 2회 성공, 그리드 레이아웃 변경 확인, 필터→그리드/모달/Navigator 연동

---

### Phase 7: Class Manager & Label Explorer

**목적**: 클래스 CRUD + 라벨 할당/삭제 + Label Explorer 탐색이 모두 동작하는지 확인

**평가 항목**:

#### 7-1. 클래스 단건 추가
1. 입력 필드 `input[placeholder*="클래스명"]`에 "e2e_class_a" 입력
2. "Add Class" 버튼 클릭
3. Fail List에 "e2e_class_a" 버튼 생성 확인
4. API 응답 status 200 확인

#### 7-2. 클래스 다중 추가 (쉼표 구분)
1. 입력 필드에 "e2e_class_b, e2e_class_c, e2e_class_d" 입력 (쉼표 구분)
2. "Add Class" 버튼 클릭
3. Fail List에 "e2e_class_b", "e2e_class_c", "e2e_class_d" 3개 버튼 모두 생성 확인
4. 총 4개 e2e 클래스 존재 확인 (a, b, c, d)

#### 7-3. Class 버튼 클릭으로 라벨 즉시 추가
1. 원본 폴더(palette_3k)로 이동 → 이미지 5개 Ctrl+클릭 선택
2. Fail List에서 "e2e_class_a" 버튼 직접 클릭
3. alert "5 images successfully!" 확인 → `browser_handle_dialog(accept: true)`
4. Label Explorer에서 "e2e_class_a" 아래 5개 이미지 확인

#### 7-4. Add Label 버튼으로 라벨 추가
1. 이미지 3개 추가 선택
2. Fail List에서 "e2e_class_b" 클릭 (선택 상태 표시)
3. "Add Label" 버튼 클릭 → alert 확인 → accept
4. Label Explorer에서 "e2e_class_b" 아래 3개 이미지 확인

#### 7-5. Label Explorer 확인
1. Label Explorer에서 "e2e_class_a" 클릭 → 그리드에 5개 이미지만 표시
2. "e2e_class_b" 클릭 → 그리드에 3개 이미지 표시
3. 스크린샷 촬영

#### 7-6. 단일 모드 전환
1. 이미지 더블클릭 → 단일 모드 진입 (`v.gridMode === false`)
2. ESC 또는 Back → 그리드 복귀 (`v.gridMode === true`)

#### 7-7. 다중 클래스 선택 후 삭제
1. Fail List에서 "e2e_class_c" Ctrl+클릭 → "e2e_class_d" Ctrl+클릭 (다중 선택)
2. "Delete Class" 버튼 클릭 → confirm 다이얼로그 accept
3. Fail List에 "e2e_class_c", "e2e_class_d" 없음 확인
4. "e2e_class_a", "e2e_class_b"는 여전히 존재 확인

#### 7-8. 정리 (남은 클래스 삭제)
1. "e2e_class_a" 클릭 → "e2e_class_b" Ctrl+클릭 (다중 선택)
2. "Delete Class" 클릭 → confirm accept
3. Fail List에 e2e_ 접두사 클래스 모두 없음 확인
4. Label Explorer에서도 모두 제거 확인

**pass 기준**: 단건/다중 추가 → 버튼 클릭 라벨 → Add Label 라벨 → 탐색 → 단일뷰 → 다중 삭제 전체 성공

---

### Phase 8: Composite (구 M.Comp)

**목적**: Composite 드롭다운에서 다중 선택 후 Failbit/BIN/FBT/QVL 맵 생성 및 결과 확인

**평가 항목**:

#### 8-1. 드롭다운 열기
1. 이미지 20개 선택 (`toggleGridImageSelect` × 20)
2. `#measure-composite-btn-top` 클릭 → `#mc-panel` display !== 'none'

#### 8-2. 드롭다운 항목 검증
1. `.mc-list` 텍스트 내용 확인:
   - "MAP" 섹션 헤더 → "Failbit" 항목
   - "BIN" 섹션 헤더 → "NORMAL", "INVALID", "ETC" (상단), "BIN285"~"BIN390" (숫자 오름차순)
   - "FBT" 섹션 헤더 → "FBT2342", "FBT2456", ... (대문자)
   - "QVL" 섹션 헤더 → "QVL5501", "QVL5502" (대문자)
2. 검색 입력에 "285" 입력 → BIN285만 보이는지 확인
3. 검색 초기화

#### 8-3. 생성 테스트 (Failbit + BIN + FBT + QVL)
1. Failbit + BIN285 + FBT2342 + QVL5501 체크 → 생성 버튼 텍스트 "생성 (4)"
2. 생성 클릭 → status polling (1초 간격, 최대 15초) → completed 확인
   - 속도 측정: 생성 시작 ~ completed 도달 시간 기록
3. 결과 그리드 확인:
   - "Grade" 섹션: Grade_0 ~ Grade_7 이미지 (8개)
   - "square" 섹션: square_average, square_weighted_average (2개)
   - "BIN" 섹션: BIN_285_count 이미지
   - "FBT" 섹션: FBT_2342 이미지
   - "QVL" 섹션: QVL_5501 이미지

#### 8-4. Failbit 결과 그리드 — 범례 확인
Failbit 결과 그리드에는 Grade_0~Grade_7 (8개) + square_average, square_weighted_average (2개)가 있다.
1. **그리드 범례 확인**: 결과 그리드 상태에서 상단 범례 확인
   - Gradient 범례 (0~10% ~ 90~100%) 10개 항목이 표시되는지 확인
     - `_ratioGradientCache` 존재 + `compositeSession.measureMode === true` 조건
   - 하단에 BIN 범례도 표시 확인
2. **Average 이미지 더블클릭 → Gradient 범례**:
   - `square_average` 또는 `square_weighted_average` 이미지 더블클릭 → 단일 뷰 진입
   - `#color-legend-top`에 **Gradient 범례** (0~10% ~ 90~100%) 표시 확인
   - 각 항목에 퍼센트와 칩수 표시: `%` 와 `(` 포함 텍스트
   - 모든 범위 퍼센트 합이 약 100% (±2%) 확인
   - Gradient 항목 클릭 → 해당 범위 칩만 표시, 나머지 흰색 (스크린샷)
   - 다시 클릭 → 해제
   - Back → 결과 그리드 복귀
3. **Grade 이미지 더블클릭 → Grade 범례**:
   - Grade_3 이미지 더블클릭 → 단일 뷰 진입
   - `#color-legend-top`에 Grade 범례 (G0~G7) 표시 확인
   - 각 항목에 퍼센트와 칩수 표시 확인
   - Grade 항목 클릭 → pixel 필터 적용 (canvas rerender), 스크린샷 확인
   - 다시 클릭 → 필터 해제
   - Back → 결과 그리드 복귀

#### 8-5. Subset Grade Map 생성 및 검증
Failbit 결과 그리드에서 여러 Grade를 선택하여 Subset Composite Map을 생성한다.
1. **Grade 이미지 선택**: 결과 그리드에서 Grade_3, Grade_5 이미지를 Ctrl+클릭으로 선택
   - `v.gridSelectedIdxs` 에 2개 이상 포함 확인
2. **Subset 생성**: Grade 범례에서 Grade 선택 또는 컨텍스트 메뉴를 통해 Subset 생성 트리거
   - `POST /api/composite-subset` 호출 확인 (콘솔/네트워크)
   - payload: `{ output_dir, selected_grades: [3, 5], lot_mode }`
3. **결과 확인**: 그리드에 Subset 이미지 추가 표시
   - `square_average_35.png`, `square_weighted_average_35.png` 2개 이미지 생성
   - 기존 Grade/average 이미지는 유지
   - 스크린샷으로 Subset 이미지가 그리드에 추가된 것 확인
4. **Subset 단일 뷰**: Subset 이미지 (`square_average_35`) 더블클릭
   - Gradient 범례 표시 확인 (0~10% ~ 90~100%)
   - 퍼센트와 칩수 표시 확인
   - Full Composite average와 색상 범위가 다를 수 있음 (독립적 min/max 스케일링 — 정상)
   - Gradient 항목 클릭 → 필터 동작 확인
   - Back → 결과 그리드 복귀

#### 8-6. BIN/FBT/QVL Composite 결과 — Gradient 범례 공통 검증
BIN, FBT, QVL Composite는 모두 Gradient 범례를 사용한다. 각 유형별로 동일한 검증을 수행한다.

**8-3 생성을 확장하여 Failbit + BIN285 + FBT2342 + QVL5501 총 4개를 체크 후 생성한다.**
(생성 버튼 텍스트 "생성 (4)", 생성 후 결과 그리드에 각 유형 이미지 모두 표시 확인)

각 유형별 Gradient 범례 검증 (BIN285 → FBT2342 → QVL5501 순서):

##### 그리드 모드 Gradient 범례
1. 결과 그리드 상태에서 상단 범례에 Gradient (0~10% ~ 90~100%) 표시 확인
2. 각 항목에 퍼센트와 칩수 텍스트 존재 확인 (`%` 와 `(` 포함)
3. Gradient 항목 클릭 → `v.selectedGradientRanges` 업데이트 확인
4. Ctrl+클릭으로 다중 범위 선택 (예: 0~10% + 90~100%) → `v.selectedGradientRanges.size === 2`
5. 우클릭 → 전체 해제 (`v.selectedGradientRanges.size === 0`)

##### 단일 뷰 Gradient 범례 (유형별 반복)
각 유형(BIN285, FBT2342, QVL5501)의 결과 이미지를 더블클릭하여 단일 뷰에서 확인:
1. 더블클릭 → 단일 뷰 진입
2. `#color-legend-top`에 **Gradient 범례** (0~10% ~ 90~100%) 10개 항목 표시 확인
3. 각 항목에 퍼센트와 칩수 표시: `%` 와 `(` 포함 텍스트
4. 모든 범위 퍼센트 합이 약 100% (±2%) 확인
5. **단일 선택**: 90~100% 클릭 → `v.selectedGradientRanges.has(9) === true`
   - 해당 범위 칩만 표시, 나머지 흰색 처리 (스크린샷)
6. **해제**: 다시 클릭 → `v.selectedGradientRanges.size === 0`, 전체 복원
7. **다중 선택**: Ctrl+클릭으로 0~10% + 50~60% + 90~100% 선택
   - `v.selectedGradientRanges.size === 3`
   - 선택된 3개 범위 칩만 표시, 나머지 흰색
8. **전체 해제**: 우클릭 → `v.selectedGradientRanges.size === 0`
9. `#color-legend-bottom`에 BIN 범례도 표시, 퍼센트/칩수 확인
10. Back → 결과 그리드 복귀

**스크린샷**: Failbit 그리드 Gradient 범례, Average 단일 뷰, Grade 단일 뷰, Subset 결과, BIN/FBT/QVL 각 단일 뷰 Gradient 범례 + 클릭 필터

**pass 기준**: 그리드 Gradient 범례 표시, Average/Grade 단일 뷰 범례 분리, Subset 생성→검증, BIN/FBT/QVL 모두 Gradient 범례 + 퍼센트/칩수 + 단일/다중 선택/해제 필터 정상

---

### Phase 9: Context Menu Composite

**목적**: 우클릭 컨텍스트 메뉴의 Composite 서브메뉴가 안정적으로 동작하는지 확인

**평가 항목**:

#### 9-1. 컨텍스트 메뉴 열기
1. 원본 폴더 복귀, 이미지 5개 선택
2. `.grid-thumb-wrap` 우클릭 (`contextmenu` 이벤트) → `#grid-context-menu` display === 'block'
3. "Composite 만들기" 항목 존재 확인

#### 9-2. 서브메뉴 열기
1. `#context-mc-create` mouseenter → `#context-mc-submenu` display !== 'none'
2. 서브메뉴 항목: Failbit, NORMAL, INVALID, ETC, BIN285, ..., FBT2342, ..., QVL5501, ...
3. `.mc-generate-btn` 1개만 존재 확인

#### 9-3. 클릭 안정성
1. Failbit 항목 클릭 → `v._mcCheckedItems.length === 1`
2. 클릭 후 컨텍스트 메뉴 여전히 열림 (`display === 'block'`) — stopPropagation 확인
3. 서브메뉴도 여전히 열림 확인

#### 9-4. mouseleave 안정성
1. `#context-mc-submenu` mouseleave 이벤트 발생
2. 500ms 대기 → 서브메뉴 여전히 열림 확인 (mouseleave로 닫히지 않음)

#### 9-5. 재호버 체크 상태 유지
1. `#context-mc-create` mouseenter 다시 발생
2. 이전 체크(Failbit)가 유지되는지 확인 (`_mcBuilt` 플래그로 재빌드 방지)
3. BIN285 추가 체크 → `v._mcCheckedItems.length === 2`
4. 생성 버튼 텍스트 "생성 (2)"

#### 9-6. 메뉴 닫기
1. 메뉴 바깥 영역 클릭 → `hideContextMenu()` 호출
2. 컨텍스트 메뉴 + 서브메뉴 모두 `display === 'none'`
3. `_mcBuilt === false` (리셋됨)

#### 9-7. 서브메뉴 뷰포트 하단 넘침 방지
1. 화면 하단 근처(clientY > viewportHeight - 100)에서 우클릭 → 컨텍스트 메뉴 열기
2. `#context-mc-create` hover → 서브메뉴 열기
3. 서브메뉴 `getBoundingClientRect().bottom <= window.innerHeight` 확인 (뷰포트 안에 수렴)
4. 서브메뉴가 `position:fixed`이고 `bottom` 스타일이 설정되어 있는지 확인

#### 9-8. Composite Map 저장 경로 (LoginId 기반)
1. `/api/config` 응답에서 FALLBACK_LOGIN_ID 확인 (기본값 "guest")
2. Composite Map 생성 API 호출 시 응답의 `output_dir`에 LoginId 포함 확인
3. `composite_map/{LoginId}/current/` 구조인지 확인 (timestamp 폴더 아님)
4. 재생성 시 이전 결과가 삭제되고 새 결과로 교체되는지 확인

#### 9-9. Measure Composite 누적 방지
1. Measure Composite 생성 후 `output_dir` 경로 확인
2. 동일 사용자로 재생성 시 이전 `*_measure/` 폴더가 삭제되는지 확인
3. `current/` 디렉토리는 삭제되지 않는지 확인

**pass 기준**: 9-1 ~ 9-9 전체 pass

---

### Phase 10: Ref Map

**목적**: Reference Map 등록/표시/크기조절/삭제 전체 플로우

**평가 항목**:
1. `v.setRefMap(v.currentGridImages[0])` → 등록 성공 (콘솔 "[RefMap] 등록:" 로그)
2. `#ref-map-btn-top` 클릭 → `#ref-map-window` classList.contains('is-open')
3. z-index 확인: `getComputedStyle(window).zIndex` === "26000" (LOT 모달 25000보다 위)
4. 이미지 표시: `#ref-map-image` src !== "" && display !== 'none'
5. 이미지가 창에 맞게 축소: `max-width: 100%; max-height: 100%; object-fit: contain` CSS 확인
6. `#ref-map-clear-btn` 클릭 → Ref Map 삭제, 이미지 src 초기화
7. `#ref-map-close-btn` 클릭 → 창 닫힘

**pass 기준**: 등록→열기→z-index→이미지표시→삭제→닫기 전체 성공

---

### Phase 11: Measure heatmap

**목적**: Measure 패널에서 FBT/QVL/BIN heatmap 적용/해제

> **핵심 구현**: `/api/measure-thumb`는 원본 이미지를 로드하지 않고, positions JSON의 chip rect + 측정값만으로 gradient heatmap 이미지를 새로 생성한다. 원본 위에 덧그리는 overlay가 아닌, **독립적인 이미지 교체** 방식이다. 그리드/네비게이터에서는 썸네일 URL 자체가 `/api/measure-thumb`로 교체되고, 단일 이미지 모드에서는 chipAnnotator가 칩 rect에 gradient 색상을 직접 렌더링한다.

**positions 파일 compact_array 포맷 (2026-03-17 적용)**:
- `/api/chip-positions` 응답: 칩별 f/q 값 제거, `ftn_keys`/`qtn_keys`를 상단에 제공
- JS: `data.ftn_keys`/`data.qtn_keys`로 키 목록 추출 (chip.f 순회 제거)
- 서버: positions 파일의 f/q가 dict든 list든 양쪽 모두 지원
- `rect.quad` 필드 응답에서 제거

**테스트 데이터 기준**:
- palette_3k: ftn_keys 500개, qtn_keys 500개, chips 384개/파일, 3000파일
- palette_5mb: ftn_keys 500개, qtn_keys 500개, chips 812개/파일, 6파일
- ftn_keys 예시: `["2824","1409","5506","5012","4657","3286",...]` (500개)
- qtn_keys 예시: `["5445","5180","5751","5534","5988",...]` (500개)
- f 값 범위: 25~9976 (정수 문자열), q 값 범위: 0~100

**평가 항목**:

#### 11-0. `/api/chip-positions` 응답 구조 검증
1. `fetch('/api/chip-positions?path=palette_3k/wafer_p3k_0001_EE_Engineer.png')` 호출
2. 응답에 `ftn_keys` 배열 존재, **길이 500** 확인
3. 응답에 `qtn_keys` 배열 존재, **길이 500** 확인
4. `ftn_keys` 첫 번째 키가 문자열인지 확인 (예: `"2824"`)
5. 칩 객체에 `f`, `q` 키 **없음** 확인 (`chips[0].f === undefined`)
6. 칩 객체에 `rect.quad` **없음** 확인
7. 칩 객체에 `b`, `g`, `rect.x0/y0/x1/y1`, `x_abs`, `y_abs`, `x_cal`, `y_cal` 존재 확인
8. chips 배열 길이 **384** 확인
9. 응답 크기 측정 (경량화 전 ~2MB → 경량화 후 수십KB 기대)

#### 11-1. Measure 패널 열기 & FBT/QVL/BIN 키 표시
1. palette_3k 그리드 로드 (`loadImagesInFolderAndShowGrid`) → 전체선택
2. `#failbit-btn-top` 클릭 → `#failbit-panel-top` display !== 'none'
3. 패널에 **"FBT" 섹션 헤더** 존재, FBT 항목 **500개** 표시 (ftn_keys 기반)
4. 패널에 **"QVL" 섹션 헤더** 존재, QVL 항목 **500개** 표시 (qtn_keys 기반)
5. **"BIN" 섹션** 존재 확인
6. FBT 항목 중 `FBT2824` (첫 번째 ftn_key) 표시 확인
7. QVL 항목 중 `QVL5445` (첫 번째 qtn_key) 표시 확인

#### 11-2. FBT Measure heatmap 적용 & 시각 검증
1. FBT 항목 아무거나 클릭 (예: FBT2824 또는 목록 첫 번째) → 그리드 썸네일이 `/api/measure-thumb` heatmap으로 교체
2. `viewer.overlayMode` === `"f"` 확인
3. 이미지 src에 `measure_overlay=f:2824` 또는 `field=f` 파라미터 포함 확인
4. **Gradient 범례** 전환 확인: Grade(G0~G7) → Gradient(파란→초록→빨강)
5. Gradient bar 내 **퍼센트 구간 텍스트** 존재 확인 ("0~10%", "10~20%", ..., "90~100%" 등)
6. Gradient bar 내 **칩 수 텍스트** 존재 확인 (각 구간별 칩 개수)
7. 그리드 썸네일 이미지가 원본과 다르게 gradient 색상으로 렌더링 확인 (스크린샷)
8. 그리드 이미지 더블클릭 → 단일 이미지 뷰 진입
9. 단일 뷰에서 measure heatmap 렌더링 확인 (칩별 색상 gradient)
10. 단일 뷰에서도 Gradient 범례 + 퍼센트/칩수 표시 확인
11. 뒤로가기 → 그리드 복귀

#### 11-3. QVL Measure heatmap 적용 & 시각 검증
1. 초기화 버튼 클릭 → heatmap 해제
2. QVL 항목 아무거나 클릭 (예: QVL5445 또는 QVL5180)
3. `viewer.overlayMode` === `"q"` 확인
4. 이미지 src에 `measure_overlay=q:5445` 파라미터 포함 확인
5. Gradient 범례 + 퍼센트/칩수 텍스트 확인 (11-2와 동일 검증)
6. 단일 이미지 더블클릭 → measure heatmap 확인 → 뒤로가기

#### 11-4. BIN Overlay 적용 & 시각 검증
1. 초기화 → BIN 항목 중 하나 (285 등) 클릭
2. `viewer.overlayMode` === `"bin"` 확인
3. 이미지 src에 `bin_overlay=1` 파라미터 포함 확인
4. 범례가 BIN 모드로 표시 확인 (Grade + BIN 항목)

#### 11-5. 초기화 & 복원
1. 초기화 버튼 클릭 → `viewer.overlayMode` === `null` 또는 `undefined`
2. Grade 범례(G0~G7)로 복원 확인
3. 그리드 이미지 src에 `measure_overlay`/`bin_overlay` 파라미터 **없음** 확인
4. Gradient 범례 DOM 요소 숨겨짐 또는 제거 확인
5. `#failbit-btn-top` 다시 클릭 → 패널 닫힘

#### 11-6. Measure Composite 생성 (서버 compact_array f/q 처리 검증)
서버가 compact_array 포맷(f가 list, ftn_keys로 인덱스 매핑)의 positions 파일을 읽어 Measure Composite 이미지를 정상 생성하는지 검증.

1. palette_3k 그리드 → 이미지 10개 이상 선택
2. Composite 버튼(`#measure-composite-btn-top`) 클릭 → MC 패널 열기
3. MC 패널에서 FBT 항목(아무거나) + QVL 항목(아무거나) + BIN285 체크
4. "생성" 버튼 클릭 → 생성 시작
5. 상태 폴링으로 완료 대기 (최대 60초)
6. 결과 확인: composite 그리드에 이미지 표시
   - Grade 이미지 8개 (Grade_0 ~ Grade_7)
   - Square 이미지 2개 (square_average, square_weighted_average)
   - FBT_XXXX 이미지 1개 (선택한 FBT 키)
   - QVL_XXXX 이미지 1개 (선택한 QVL 키)
   - BIN_285_count 이미지 1개
7. FBT Composite 결과 이미지 더블클릭 → 단일 뷰 진입
8. **Gradient 범례** 표시 확인 (Measure Composite 결과는 gradient)
9. Gradient bar 내 **퍼센트/칩수 텍스트** 확인
10. 뒤로가기 → BIN Composite 결과 이미지 더블클릭
11. **Gradient 범례** 표시 확인 (BIN count도 gradient)
12. 뒤로가기 → QVL Composite 결과 이미지 더블클릭
13. **Gradient 범례** 표시 확인

#### 11-7. palette_5mb 대용량 positions 처리 검증
1. palette_5mb 그리드 로드 → `/api/chip-positions` 호출
2. 응답에 `ftn_keys` 500개, `qtn_keys` 500개, chips **812개** 확인
3. Measure 패널에서 FBT/QVL 키 목록 정상 표시 확인
4. FBT heatmap 적용 → gradient 범례 표시 확인

#### 11-8. Measure 키 인덱스 방지 & 그리드→단일 전환 시 오버레이 보존
compact_array 포맷에서 FBT/QVL 키가 배열 인덱스(0,1,2...)로 표시되지 않고 실제 키 이름으로 표시되는지, 그리드→단일 전환 시 measure 오버레이가 유지되는지 검증.

1. palette_3k 그리드 로드 → 전체선택
2. Measure 패널 열기 (`#failbit-btn-top` 클릭)
3. **인덱스 방지 검증**: FBT 항목 텍스트에 `FBT0`, `FBT1`, `FBT2` 등 순차 인덱스가 **없는지** 확인
   - `browser_evaluate`로 `.failbit-item` 텍스트 목록 수집
   - `FBT0` 텍스트가 포함된 항목이 0개인지 확인 (인덱스가 아닌 실제 키: `FBT2824` 등)
4. FBT 항목 중 하나 클릭 (예: 첫 번째 FBT 항목) → 그리드 썸네일이 measure-thumb heatmap으로 교체
5. `viewer.overlayMode === 'f'` 확인
6. `viewer._ratioActiveItemKey`가 숫자 문자열이 아닌 실제 키 값인지 확인 (예: `"2824"`, NOT `"0"`)
7. 그리드 이미지 더블클릭 → 단일 이미지 뷰 진입
8. **오버레이 보존 확인**: `viewer.overlayMode === 'f'` 확인
9. **키 보존 확인**: `viewer._ratioActiveItemKey`가 동일한 값 유지 확인
10. 단일 이미지 뷰에서 Measure 패널 열기 (`#failbit-btn-filename` 클릭)
11. **단일 뷰 인덱스 방지**: FBT 항목 텍스트에 `FBT0`, `FBT1` 등 순차 인덱스 **없음** 확인
12. 선택된 FBT 항목에 `active` 클래스 존재 확인
13. `browser_take_screenshot` → 단일 뷰에서 measure heatmap 렌더링 확인
14. 뒤로가기(ESC) → 그리드 복귀
15. 그리드에서도 `viewer.overlayMode === 'f'` 유지 확인

#### 11-9. 단일 이미지 compact_array 텍스트 & 그리드 Measure 항목 전환 & 범례 칩 수
compact_array 포맷에서 단일 이미지 모드 칩 내 수치 텍스트 정상 표시, 그리드에서 FBT 항목 변경 시 맵 갱신, 그리드 gradient 범례 퍼센트/칩수 표시 검증.

1. palette_3k 단일 이미지 로드 (wafer_p3k_0001_EE_Engineer.png)
2. Measure 패널에서 FBT2824 클릭 → 오버레이 적용
3. **단일 이미지 칩 텍스트 확인**: `chipAnnotator.ratioOverlayColors.size > 0` (칩 색상 계산됨)
4. **칩 텍스트 값 검증**: `browser_evaluate`로 chipAnnotator 렌더 시 compact_array 인덱스 접근 확인
   - `chipAnnotator.overlayItemKey`가 `"2824"`
   - `chipAnnotator.positionsData.ftn_keys` 배열에 `"2824"` 포함
   - `chipAnnotator.chips[0].f`가 Array (compact_array 포맷)
5. **Gradient 범례 칩 수 확인** (단일 모드): `.legend-item[data-section="gradient"]` 내부에 퍼센트 텍스트 존재 (예: `10.2%(39)`)
6. `browser_take_screenshot` → 단일 이미지에 칩 내 K/M 축약 숫자 텍스트 표시 확인
7. 그리드 모드 진입 (`showGrid` 또는 전체선택)
8. 그리드 gradient 범례 확인: `.legend-item-grid[data-section="gradient"]` 내부에 퍼센트/칩수 텍스트 존재
9. **FBT 항목 전환 테스트**: Measure 패널에서 FBT5506 클릭 → 그리드 썸네일 갱신
10. `viewer._ratioActiveItemKey === "5506"` 확인
11. 그리드 이미지 src에 `measure_overlay=f%3A5506` 포함 확인
12. `browser_take_screenshot` → 이전 FBT2824와 다른 gradient 패턴 확인
13. 그리드 이미지 더블클릭 → 단일 이미지 뷰 진입
14. **전환 후 칩 텍스트 확인**: `chipAnnotator.overlayItemKey === "5506"` 확인
15. `chipAnnotator.ratioOverlayColors.size > 0` 확인 (칩 색상 재계산됨)
16. `browser_take_screenshot` → 단일 뷰에서 FBT5506 heatmap + 칩 텍스트 표시 확인
17. 뒤로가기(ESC) → 그리드 복귀 → `viewer._ratioActiveItemKey === "5506"` 유지 확인

#### 11-10. Measure heatmap 그리드/네비게이터 픽셀 정합성 검증
그리드 및 네비게이터 썸네일에 서버사이드 `/api/measure-thumb` heatmap이 정확히 적용되는지 픽셀 수준으로 검증.
단일 이미지(클라이언트 사이드 chipAnnotator 렌더링)와 그리드/네비게이터(서버사이드 이미지 생성)가 동일한 gradient/ftn_key/scheme을 사용하는지 확인.

1. palette_5mb 단일 이미지 로드 (wafer_palette_5mb_PE_Engineer.png)
2. Measure 패널에서 FBT2824 클릭 → 클라이언트 사이드 chipAnnotator heatmap 적용
3. `browser_evaluate`로 gradient 캐시 확인: `viewer._ratioGradientCache` 11개 색상 존재
4. Navigator 썸네일 URL에 `measure_overlay=f%3A2824` 포함 확인
5. Navigator 첫 번째 썸네일 이미지를 canvas에 그려 픽셀 샘플링 (칩 영역 + 배경)
6. 칩 영역 픽셀이 원본 Grade 색상과 **다름** 확인 (heatmap gradient 색상)
7. 그리드 모드 진입 (`loadImagesInFolderAndShowGrid('palette_5mb')`)
8. Measure 패널에서 FBT2824 클릭 → 서버사이드 `/api/measure-thumb` heatmap 적용
9. 그리드 첫 번째 이미지 URL에 `measure_overlay=f%3A2824` 포함 확인
10. 그리드 첫 번째 이미지를 canvas에 그려 칩 영역 픽셀 샘플링
11. 칩 영역 픽셀이 원본 Grade 색상과 **다름** 확인
12. **썸네일 포맷 검증**: `curl -sI` 또는 `fetch` HEAD로 Content-Type 확인
    - `THUMBNAIL_FORMAT=PNG` → `image/png`
    - `THUMBNAIL_FORMAT=WEBP` → `image/webp`
    (PNG 데이터가 `.webp` 파일에 저장되는 포맷 불일치가 없어야 함)
13. `browser_take_screenshot` → 그리드 measure heatmap 시각 확인

#### 11-11. /api/measure-thumb 경량 heatmap 속도 및 정합성 검증
그리드 Measure overlay가 `/api/measure-thumb` (positions-only, 이미지 로드 없음)를 사용하는지,
속도가 기존 `/api/thumbnail` overlay 대비 빠른지 검증.

1. palette_5mb 그리드 로드 → FBT2824 선택
2. 그리드 첫 번째 이미지 `img.src` 또는 `img.dataset.src`에 `/api/measure-thumb` 포함 확인
   (NOT `/api/thumbnail?...measure_overlay=`)
3. URL에 `field=f`, `key=2824`, `scheme={LoginId}` 파라미터 존재 확인
4. 서버 응답 Content-Type: `image/webp` 확인
5. 응답 크기 **< 15KB** 확인 (기존 thumbnail overlay ~40KB 대비 경량)
6. `performance.now()` 기준 FBT 선택→visible 이미지 로드 완료: **< 500ms** (6장 기준)
7. 초기화 → 그리드 이미지 src가 `/api/thumbnail` (기존 방식)으로 복귀 확인
8. palette_3k 3000장 로드 → FBT2824 선택
9. visible 16장 로드 완료: **< 200ms** (positions 캐시 히트)
10. 스크롤 → 새 이미지 lazy load 시에도 `/api/measure-thumb` 사용 확인
11. Measure 선택 상태에서 폴더 전환 (palette_3k → palette_5mb)
12. 전환 후 그리드 이미지에 measure heatmap 적용 확인 (overlayMode 유지)
13. `browser_take_screenshot` → 그리드 heatmap 시각 확인

**pass 기준**:
- 11-0: API 응답에서 ftn_keys 500개, qtn_keys 500개, 칩에 f/q/quad 없음
- 11-1: Measure 패널에 FBT 500개, QVL 500개, BIN 표시
- 11-2: FBT heatmap → gradient 범례 + 퍼센트/칩수 텍스트 + 단일뷰 heatmap
- 11-3: QVL heatmap → 동일 검증
- 11-4: BIN heatmap → BIN 범례
- 11-5: 초기화 → Grade 범례 복원, measure-thumb URL 제거
- 11-6: Measure Composite 생성 → FBT/QVL/BIN 결과 이미지 + gradient 범례 + 텍스트
- 11-7: palette_5mb 대용량 정상 처리
- 11-8: FBT/QVL 키 인덱스 미표시 + 그리드→단일 전환 시 measure heatmap 보존
- 11-9: compact_array 칩 텍스트 정상 표시 + FBT 항목 전환 시 그리드 갱신 + 범례 칩 수
- 11-10: 그리드/네비게이터 썸네일에 measure heatmap 픽셀 적용 확인 + 포맷 일관성
- 11-11: /api/measure-thumb 사용 확인 + 응답 < 15KB + visible 로드 < 500ms + 폴더 전환 유지

---

### Phase 12: MY LOT

**목적**: MY LOT 모달에서 그룹 CRUD + 이미지 추가/삭제

**평가 항목**:

#### 12-1. 모달 열기 & 모드 확인
1. `#my-lot-btn-top` 클릭 → MY LOT 모달 display !== 'none'
2. **LOT 모드** / **Wafer 모드** 탭 전환 확인
   - LOT 모드: 선택 이미지들의 LOT ID 리스트 → 중복제거 → 다중검색으로 해당 LOT의 모든 이미지 저장
   - Wafer 모드: 선택한 이미지만 바로 저장

#### 12-2. LOT 모드 테스트
1. 이미지 10개 선택 → LOT 모드에서 그룹 추가 ("e2e_test_group")
2. 추가 시 선택 이미지의 LOT ID 추출 → 중복제거 → 해당 LOT의 전체 이미지 자동 포함 확인
3. 그룹 내 이미지 수가 선택 수(10)보다 많거나 같은지 확인 (같은 LOT의 다른 wafer 포함)

#### 12-3. Wafer 모드 테스트
1. Wafer 모드 전환
2. 이미지 5개 선택 → 그룹에 추가
3. 그룹 내 이미지 수가 정확히 5개인지 확인 (선택한 것만)

#### 12-4. Manual 입력 — LOT 모드 (Noise + 대량 + 디스크 검증)

1. LOT ID 직접 입력 (noise 포함): `wafer.J1`, `wafer.2`, `wafer.abc`, `wafer` 등
2. **파싱 검증**: dot 이후 제거, 탭/공백 뒤 무시 → 모두 LOT=`wafer`로 중복제거
3. 저장 → entries.json 디스크 확인: `lot` 값 정확, `path` 존재
4. Grid 보기 → 해당 LOT의 전체 이미지 표시
5. **대량 테스트**: 100개 noise 입력 → 중복제거 후 1행 → 저장 → Grid 보기 3000개

```javascript
// Noise 패턴 (공백/탭 뒤는 LOT 모드에서 무시)
const lines = ['wafer.J1', 'wafer.2', 'wafer\textra', 'wafer.abc junk', 'wafer'];
// 모두 lot='wafer'로 중복제거 → 1행
```

#### 12-5. Manual 입력 — Wafer 모드 (Noise 입력 + 토큰 필터 + Grid 보기)

**목적**: Wafer 모드에서 noise 포함 입력 → dot 제거 파싱 → 토큰 정확매칭 → 현재 폴더 우선 검색 → 저장 → Grid 보기까지 전체 흐름 검증

1. `palette_3k` 그리드 로드 상태에서 MY LOT → Wafer 탭 → 새 그룹 생성
2. 다음 형식으로 `handleManualPaste` 호출 (noise 포함):
   ```
   wafer.J3 0001
   wafer.J2 0005
   wafer 0010
   wafer.abc 0050
   wafer 0100
   ```
3. **파싱 검증**: `manualRows` 확인
   - 모든 행의 `lot` === `'wafer'` (`.J3`, `.J2`, `.abc` 제거됨)
   - `wafer` 값 === `'0001'`, `'0005'`, `'0010'`, `'0050'`, `'0100'`
   - **pass 기준**: dot 이후 noise가 모두 제거되고 LOT/Wafer가 정확히 분리됨

4. **검색 결과 검증**: 각 행의 `searchResults.length > 0`
   - preview 파일명이 `wafer_p3k_XXXX` 패턴 (현재 폴더 `palette_3k`에서 검색됨)
   - **pass 기준**: 5개 행 모두 paths > 0, preview에 `p3k` 포함

5. **저장** (`#my-lot-manual-submit` 클릭) → 성공 메시지 확인
6. **전체 선택** (`#my-lot-select-all` 클릭) → 3개 이상 항목 선택됨
7. **선택 Grid 보기** (`#my-lot-grid-view` 클릭):
   - 그리드에 **입력한 wafer 이미지만** 표시 (LOT 전체 아님)
   - `v.currentGridImages.length` === 입력한 행 수 (5개)
   - 각 이미지 파일명에 `0001`, `0005`, `0010`, `0050`, `0100` 포함
   - **pass 기준**: gridImages === 5, LOT 전체(3000장)가 아닌 해당 wafer만

8. **대량 테스트 (100개)**: 다양한 noise 패턴 100행 입력 (dot+숫자, dot+영문, tab 구분 혼합)
   - lotOk === 100 (모두 `wafer`로 noise 제거)
   - waferOk === 100 (4자리 숫자 정확)
   - pathOk === 100 (검색 매칭)
   - 저장 후 entries.json 디스크 확인: 100개 전부 lot/wafer/path 존재
   - Grid 보기: `v.currentGridImages.length === 100`
   - **API 응답 검증**: `GET /api/my-lot?mode=wafer` → entries의 `wafer` 필드가 entries.json 원본값 (파일명 재파싱 아님)

9. **테스트 그룹 삭제**: `DELETE /api/my-lot/group` → 200

#### 12-5-noise. Noise 패턴 상세 (LOT/Wafer 공통)

입력 파싱 규칙: `line.split(/\t|\s+/)` → 첫 토큰의 `.` 이후 제거 → LOT, 두번째 토큰의 `.` 이후 제거 → Wafer

| 입력 | LOT | Wafer | 비고 |
|------|-----|-------|------|
| `ABC123.1 03` | ABC123 | 03 | dot+숫자 제거 |
| `ABC123.J1 03` | ABC123 | 03 | dot+영숫자 제거 |
| `ABC123.abc 03` | ABC123 | 03 | dot+영문 제거 |
| `ABC123.12.3 04` | ABC123 | 04 | 다중 dot 제거 |
| `ABC123 03` | ABC123 | 03 | 정상 (noise 없음) |
| `LOT001.2\t05` | LOT001 | 05 | tab 구분 |
| `LOT002.X 06` | LOT002 | 06 | dot+영문 |
| `wafer.J3` | wafer | (없음) | LOT 모드용 |

```javascript
// 파싱 테스트 코드
const modal = v.myLotModal;
modal.handleManualPaste('wafer.J3 0001\nwafer.J2 0005\nwafer 0010', true);
// 5초 대기 후
modal.manualRows.forEach(r => {
    assert(r.lot === 'wafer');           // noise 제거
    assert(r.searchResults.length > 0);  // 검색 매칭
    assert(r.path?.includes('p3k'));     // 현재 폴더 결과
});
// 저장 → 전체선택 → Grid 보기
document.getElementById('my-lot-manual-submit').click();
// 3초 대기 후
document.getElementById('my-lot-select-all').click();
document.getElementById('my-lot-grid-view').click();
// 5초 대기 후
assert(v.currentGridImages.length === 3);  // 입력한 wafer만
```

#### 12-5-api. API limit 및 전체 검색 검증
`searchImagesByLotsBatch`에서 서버 limit 초과 시 검색 실패하므로 아래를 반드시 확인:

1. **서버 API limit**: `/api/search` 의 `limit` 파라미터 상한이 200000 이상
2. **전체 검색 fallback**: `currentGridImages`가 비어있어도 `folder=''` 전체 검색에서 limit 충분히 큰 값으로 호출 → 결과 포함
3. **Wafer 필터링**: 전체 검색 결과에서 wafer 토큰 정확 매칭 (`tokens.some(t => t === waferFilter)`)
4. **저장 확인**: `entries.json`이 디스크에 생성됨 (LOT, Wafer, Path 모두 기록)
5. **Grid 보기**: 저장된 이미지 20/20 정상 로드, broken=0, 512×512

#### 12-6. 이미지/그룹 삭제
1. 그룹 내 이미지 삭제 버튼 → 개별 이미지 제거 확인
2. 그룹 삭제 → 목록에서 제거 확인

#### 12-7. 모달 닫기
1. 닫기 버튼 또는 `#my-lot-btn-top` 다시 클릭 → 모달 닫힘

**pass 기준**: LOT/Wafer 모드 전환, 그룹 CRUD, Wafer Manual 입력(noise 제거 + 토큰 정확매칭 + 현재 폴더 우선 검색 + Grid 보기에서 해당 wafer만 표시), 이미지/그룹 삭제

---

### Phase 13: 단일 이미지 모드 — 기본

**목적**: 더블클릭 진입, 화살표 탐색, 줌, 복귀가 안정적으로 동작하는지

**평가 항목**:
1. 그리드 이미지 더블클릭 (`dblclick` 이벤트) → `v.gridMode === false`
2. 타이틀 바에 파일명 표시 확인
3. 좌측 Navigator에 썸네일 목록 표시 확인
4. 좌 화살표 클릭 → 이전 이미지로 전환 (파일명 변경 확인)
5. 우 화살표 클릭 → 다음 이미지로 전환
6. 줌 버튼 테스트:
   - "50%" 클릭 → `v.renderer.transform.scale` ≈ 0.5 (±0.1)
   - "100%" 클릭 → scale ≈ 1.0
   - "200%" 클릭 → scale ≈ 2.0
   - "300%" 클릭 → scale ≈ 3.0
7. "-" / "+" 줌 버튼 → scale 증감 확인
8. "Reset" 버튼 → fit-to-container 크기로 복원
9. Back/ESC → `v.gridMode === true`, 그리드 복귀
10. 스크롤 위치 복원 확인 (이전 스크롤 위치와 ±50px 이내)

**pass 기준**: 진입→탐색→줌→복귀 전체 성공

---

### Phase 14: 단일 이미지 모드 — 피라미드 렌더링

**목적**: 줌 레벨에 따라 올바른 피라미드 레벨이 선택되고, 픽셀이 선명하게 렌더링되는지

**평가 항목**:
1. 단일 모드 진입 → 콘솔 `[INIT] Lv0.5` 로그 확인 (기본 fit 줌)
2. `v.renderer` 객체에서 현재 피라미드 정보 확인:
   ```javascript
   const r = v.renderer;
   r.pyramidLevels  // 사용 가능한 레벨 목록
   r.currentLevel   // 현재 사용 중인 레벨
   ```
3. 줌 50% 설정 → 피라미드 Lv0.5 사용 확인 (zoom < 75%)
4. 줌 100% 설정 → 피라미드 Lv1.0 사용 확인 (zoom >= 75%)
   - 콘솔 `[PREFETCH]` 로그에서 원본 다운로드 확인
5. 줌 200% 설정 → Lv1.0 유지, 캔버스 `imageSmoothingEnabled === false` 확인
   ```javascript
   const ctx = document.querySelector('canvas')?.getContext('2d');
   ctx.imageSmoothingEnabled === false  // 픽셀 선명
   ```
6. 줌 300% 설정 → 개별 픽셀이 선명한 사각형으로 보이는지 스크린샷 확인
7. 각 줌 전환 시:
   - 빈 화면 (검정/흰색) 없이 이미지가 즉시 표시
   - canvas width/height > 0
   - 렌더링 지연 200ms 이내

**pass 기준**: 줌별 올바른 레벨 선택, imageSmoothingEnabled=false, 빈 화면 없음

---

### Phase 15: 단일 이미지 모드 — 웨이퍼/칩 정보 패널

**목적**: 좌하단 정보 패널에 웨이퍼 메타데이터와 칩 좌표가 정확히 표시되는지

**평가 항목**:

#### 15-1. 웨이퍼 정보 테이블
1. 좌하단 정보 영역 (`#wafer-info-table` 또는 `.wafer-info`) 존재 확인
2. 다음 필드가 모두 표시되는지 확인:
   - **Device**: 제품명 (예: "FAILBIT-DEMO-PLTE")
   - **PartID**: 파트 ID (예: "WAFER_P3K-0001-PLTE")
   - **PGM**: 프로그램명
   - **TEST**: 테스트명 (예: "Engineer")
   - **LOT**: LOT명 (예: "EE")
   - **NET**: 순 칩 수 (예: 404)
   - **GOOD**: 양품 수 (예: 385)
   - **YIELD**: 수율 (예: 95.3)
   - **SYS**: 시스템 수율 (예: 23.4)
3. 칩 미선택 상태에서:
   - **BIN**: "-"
   - **Chip(Abs)**: "-"
   - **Chip(Rel)**: "-"

#### 15-2. 칩 클릭 시 정보 업데이트
1. 캔버스에서 칩 영역 클릭 (chipAnnotator를 통해)
2. 클릭 후 정보 패널 업데이트 확인:
   - **BIN**: 실제 BIN 값 (예: "285", "Normal" 등)
   - **Chip(Abs)**: `x_abs, y_abs` 좌표 (예: "12, 8")
   - **Chip(Rel)**: `x, y` 상대 좌표 (예: "3, 2")
3. 값이 "-"가 아닌 실제 숫자/문자열인지 확인

#### 15-3. CHIP LABELS 섹션
1. 정보 패널 하단에 "CHIP LABELS" 헤딩 존재 확인
2. 라벨 없는 칩 선택 시: "No chip labels" 텍스트 표시
3. (Phase 18에서 라벨 추가 후 재확인)

**pass 기준**: 웨이퍼 필드 9개 표시, 칩 클릭 시 BIN/좌표 업데이트, CHIP LABELS 섹션 존재

---

### Phase 16: 단일 이미지 모드 — 칩 선택 & 좌표

**목적**: 칩 클릭/다중선택/해제 시 하이라이트와 좌표 표시가 정확한지

**평가 항목**:
1. 칩 영역 클릭 → 칩 선택 하이라이트 (테두리 또는 색상 변경) 확인
   - `v.chipAnnotator.selectedChips` 또는 유사 프로퍼티 length > 0
2. 선택된 칩의 좌표가 정보 패널에 표시:
   - Chip(Abs) 행에 `"x_abs, y_abs"` 형태의 실제 숫자 값
   - Chip(Rel) 행에 `"x, y"` 형태의 실제 숫자 값
3. Ctrl+클릭으로 추가 칩 선택 → 다중 선택 확인
   - 선택 칩 수 2개 이상
4. 빈 영역 클릭 → 선택 해제
   - 정보 패널 BIN, Chip(Abs), Chip(Rel) 모두 "-"로 리셋
   - 하이라이트 제거

**pass 기준**: 단일선택→좌표표시→다중선택→해제→초기화

---

### Phase 17: 단일 이미지 모드 — 우클릭 컨텍스트 메뉴

**목적**: 단일 이미지 모드에서 칩/빈영역 우클릭 시 적절한 컨텍스트 메뉴 표시

**평가 항목**:
1. 칩 위에서 `contextmenu` 이벤트 → 컨텍스트 메뉴 열림
2. 메뉴 항목 확인:
   - 칩 라벨 관련 항목 존재 (Add Chip Label, Remove Chip Label 등)
   - 기타 항목 (이미지 정보, 좌표 복사 등)
3. 메뉴 항목 클릭 → 해당 기능 동작 (라벨 추가 등)
4. 빈 영역 클릭 또는 ESC → 메뉴 닫힘

**pass 기준**: 메뉴 열림, 항목 존재, 닫힘

---

### Phase 18: 단일 이미지 모드 — Chip Labels 추가/확인

**목적**: Chip 모드에서 칩 라벨 CRUD가 동작하고 정보 패널에 반영되는지

**평가 항목**:

#### 18-1. Chip 모드 전환
1. Class Manager에서 "Chip" 탭 클릭 → `button[pressed]` 상태 변경
2. Chip 모드 활성 확인

#### 18-2. 칩 라벨용 클래스 추가
1. 입력 필드에 "e2e_chip_test" 입력 → "Add Class" 클릭
2. Fail List에 "e2e_chip_test" 표시 확인

#### 18-3. 칩 라벨 추가
1. 칩 선택 (클릭)
2. Fail List에서 "e2e_chip_test" 클릭 (선택)
3. "Add Label" 클릭 → 성공 확인
4. 정보 패널 CHIP LABELS 섹션에 "e2e_chip_test" 표시 확인
5. "No chip labels" 텍스트 사라짐 확인

#### 18-4. 칩 라벨 삭제
1. 해당 칩 선택 상태에서 "Delete Label" 클릭 → 라벨 제거
2. CHIP LABELS 섹션이 "No chip labels"로 복원 확인

#### 18-5. 정리
1. "Wafer" 탭으로 복귀
2. 입력 필드에 "e2e_chip_test" → "Delete Class" → confirm accept
3. 클래스 삭제 확인

**pass 기준**: Chip 모드→클래스 추가→칩 라벨 추가→표시 확인→삭제→정리

---

### Phase 19: 이미지 미선택 상태 보호

**목적**: 이미지를 선택하지 않은 상태에서 Composite 기능 접근 시 적절한 안내 표시

**평가 항목**:
1. 그리드 복귀, 전체해제 → `v.gridSelectedIdxs.length === 0`
2. `#measure-composite-btn-top` 클릭 → 토스트 "이미지를 먼저 선택하세요." 표시
   - `#mc-panel` display === 'none' (드롭다운 안 열림)
3. 우클릭 → 컨텍스트 메뉴 열기 → "Composite 만들기" 호버
4. 서브메뉴 내용에 "이미지를 선택하세요" 텍스트 표시 확인

**pass 기준**: 토스트 표시, 드롭다운 미열림, 서브메뉴 안내 메시지

---

### Phase 20: 접속 통계 대시보드 (stats.html)

**목적**: 접속 통계 페이지가 정상 로드되고, 데이터 표시/차트/내보내기가 모두 동작하는지 확인

**평가 항목**:

#### 20-1. 페이지 로드 & API 응답
1. `BASE_URL/stats` 접속 → 타이틀 "웨이퍼맵 뷰어 접속 분석" 확인
2. Stats API 엔드포인트 호출 확인 (browser_evaluate로 fetch):
   - `GET /api/stats/daily` → 200 응답, `total_users` 필드 존재 (숫자 >= 0)
   - `GET /api/stats/trend?days=14` → 200 응답, 객체 키가 날짜 형식 (YYYY-MM-DD)
   - `GET /api/stats/monthly?months=6` → 200 응답, 객체 키가 월 형식 (YYYY-MM)
   - `GET /api/stats/users` → 200 응답, `total_users` 필드 + `users` 배열
   - `GET /api/stats/recent-users` → 200 응답, `recent_users` 배열
   - `GET /api/stats/department` → 200 응답, `departments` 객체

#### 20-2. 대시보드 UI 요소
1. **오늘 요약 카드** 4개 표시:
   - 전체 사용자 수 (숫자 표시, >= 0)
   - 오늘 활성 사용자 (숫자 표시)
   - 신규 사용자 (숫자 표시)
   - 오늘 요청 수 (숫자 표시)
2. **사용자 목록 테이블**: 행이 1개 이상 존재, 컬럼 (사용자 ID, 이름, 부서, 직급, 요청수, 최근 접속)
3. **최근 사용자 테이블**: 행 존재 확인
4. **부서 분석 테이블**: 행 존재 확인

#### 20-3. 차트 렌더링
1. **일별 접속 트렌드 차트**: `<canvas>` 요소 존재, Chart.js로 렌더링됨
   - `Chart.getChart(canvas)` 또는 canvas 크기 > 0 확인
2. **월별 접속 트렌드 차트**: 동일하게 canvas 렌더링 확인
3. **부서별 Top10 차트**: canvas 렌더링 확인

#### 20-4. 새로고침 버튼
1. "새로고침" 버튼 클릭 → 데이터가 다시 로드됨
2. 로드 후 카드 숫자가 여전히 유효한 값 (NaN 아님)

#### 20-5. CSV 내보내기
1. "통계 내보내기" 버튼 존재 확인
2. `GET /api/stats/export-csv` 호출 → 200 응답 확인
   - Content-Type에 `csv` 또는 `text` 포함
   - 응답 본문 첫 줄에 CSV 헤더 포함 ("접속일시" 또는 "Username" 등)

#### 20-6. 로그 파일 생성 확인
1. 서버에 몇 개 요청 발생 후 (이미 Phase 1~19에서 충분히 발생)
2. `logs/stats.json` 파일 존재 확인 (서버 파일시스템):
   ```javascript
   const res = await fetch('/api/stats/users');
   const data = await res.json();
   data.total_users >= 1  // 최소 1명 (테스트 접속자)
   ```
3. `logs/access.log` 생성 확인 (Phase 1~19 요청 로그)

**스크린샷**: 대시보드 전체 화면, 차트 영역

**pass 기준**: 페이지 로드, 6개 API 정상 응답, 4개 카드 숫자 표시, 3개 차트 렌더링, 새로고침 동작, CSV 내보내기 200 응답, 로그 데이터 존재

---

### Phase 21: Page Manager (멀티탭)

**목적**: 페이지 탭 생성/전환/닫기/역할 변경이 정상 동작하는지 확인

**평가 항목**:

#### 21-1. 탭 생성
1. 하단 탭 바에 기본 탭 1개 존재 확인 (`#page-tab-bar .page-tab` length === 1)
2. `+` 버튼(`#page-add-btn`) 클릭 → 새 탭 생성, 탭 수 2개로 증가
3. 새 탭이 `active` 상태인지 확인 (`.page-tab.active`)
4. 새 탭 이름이 자동 생성 (예: "page1")

#### 21-2. 탭 전환
1. 첫 번째 탭 클릭 → `active` 클래스가 첫 번째 탭으로 이동
2. 두 번째 탭 클릭 → `active` 클래스가 두 번째 탭으로 이동
3. 전환 시 뷰어 상태(그리드/단일/폴더 경로)가 독립적으로 유지되는지 확인
   - 탭1에서 palette_3k 그리드 → 탭2로 전환 → 빈 화면(또는 별도 상태)
   - 탭1로 복귀 → palette_3k 그리드 복원

#### 21-3. 탭 역할 색상
1. 단일 이미지 진입 시 탭에 `data-role="wafer"` 설정, 파란색 하단 보더
2. Label Explorer 그리드 시 `data-role="label"`, 보라색 보더
3. MY LOT 그리드 시 `data-role="mylot"`, 초록색 보더

#### 21-4. 탭 닫기
1. 탭의 `x` 버튼 클릭 → 해당 탭 제거
2. 마지막 탭은 닫을 수 없음 (최소 1개 유지)
3. 활성 탭 닫으면 인접 탭이 자동 활성화

#### 21-5. 키보드 단축키
1. `PageDown` → 다음 탭으로 전환
2. `PageUp` → 이전 탭으로 전환
3. 입력 필드 포커스 중에는 단축키 비활성 (shouldSkipShortcut)

**pass 기준**: 생성→전환(상태 독립)→역할 색상→닫기→키보드 전체 성공

---

### Phase 22: Thumbnail Navigator

**목적**: 단일 이미지 모드에서 Thumbnail Navigator 창의 표시/상호작용/리사이즈 확인

**평가 항목**:

#### 22-1. 자동 표시
1. 단일 이미지 모드 진입 → `#thumbnail-navigator` display !== 'none'
2. Navigator 헤더에 "Navigator" 텍스트 표시
3. 썸네일 목록에 이미지 아이템 존재 (`#thumbnail-navigator-list` 자식 > 0)
4. 현재 이미지가 하이라이트 표시 (active/selected 스타일)

#### 22-2. 클릭 네비게이션
1. Navigator 내 다른 이미지 썸네일 클릭 → 해당 이미지로 전환
2. 전환 후 `#file-name-text` 변경 확인
3. Navigator에서 새 이미지가 하이라이트로 변경

#### 22-3. 스크롤
1. Navigator 목록에서 마우스 휠 → 목록 스크롤
2. 현재 이미지가 뷰포트 밖이면 자동 스크롤로 보이게

#### 22-4. 드래그 이동
1. Navigator 헤더 영역 mousedown → 드래그 → 창 위치 이동
2. 이동 후 위치 유지 확인

#### 22-5. 리사이즈
1. 하단 리사이즈 핸들(`#thumbnail-navigator-resize-handle`) 드래그 → 높이 변경
2. 좌측 핸들(`#thumbnail-navigator-resize-handle-left`) 드래그 → 너비 변경
3. 리사이즈 후 썸네일 목록 레이아웃 적응

#### 22-6. 닫기 & 재표시
1. 닫기 버튼(`#thumbnail-navigator-close`) 클릭 → Navigator 숨김
2. 다른 이미지 진입 시 Navigator 다시 표시

#### 22-7. 가상 스크롤 (300+ 이미지)
1. palette_3k(3000장) 단일 모드 진입
2. Navigator에 모든 3000개를 DOM에 넣지 않고 가상 스크롤 적용 확인
3. 빠른 스크롤 시 끊김 없이 렌더링

#### 22-8. Measure heatmap 반영
1. palette_3k 그리드 → 전체선택 → Measure FBT 항목 클릭 → heatmap 적용
2. 그리드 이미지 더블클릭 → 단일 모드 진입
3. Navigator 썸네일 URL에 `measure_overlay=f:` 파라미터 포함 확인
4. 다른 FBT 항목으로 전환 → Navigator 썸네일 URL이 새 키로 갱신 확인
5. 초기화 → Navigator 썸네일 URL에서 `measure_overlay` 파라미터 제거 확인

#### 22-9. LOT/TEST/STEP 필터 반영
1. LOT 필터에서 "EE" 선택 (filterLT = ["EE"])
2. 단일 이미지 모드 진입 → Navigator 이미지 목록이 EE 파일만 포함 확인
3. Navigator 이미지 수 < 전체 이미지 수 확인
4. 필터 해제 → Navigator 이미지 수 = 전체 이미지 수 복원 확인

**pass 기준**: 자동 표시→클릭 네비→드래그→리사이즈→닫기→가상 스크롤→measure 반영→필터 반영

---

### Phase 23: Minimap

**목적**: 단일 이미지 모드에서 Minimap 표시, 뷰포트 인디케이터, 클릭/드래그 네비게이션

**평가 항목**:

#### 23-1. Minimap 표시
1. 단일 이미지 모드 진입 → `#minimap-container` display !== 'none'
2. `#minimap-canvas` 크기 > 0 (width, height)
3. Minimap에 현재 이미지의 축소 버전 렌더링

#### 23-2. 뷰포트 인디케이터
1. `#minimap-viewport` 요소 존재, 위치/크기가 현재 줌에 비례
2. 줌 50% → 뷰포트가 minimap의 큰 영역 차지
3. 줌 300% → 뷰포트가 작은 영역 차지
4. 팬 이동 → 뷰포트 위치가 실시간 이동

#### 23-3. Minimap 클릭 네비게이션
1. Minimap 영역 클릭 → 메인 뷰가 해당 위치로 팬 이동
2. 클릭 후 `v.renderer.transform.tx/ty` 값 변경 확인

#### 23-4. Minimap 뷰포트 드래그
1. `#minimap-viewport` mousedown → 드래그 → 메인 뷰 실시간 팬 이동
2. 드래그 중 부드러운 이동 (끊김 없음)

**pass 기준**: 표시→뷰포트 크기 변화→클릭 네비→드래그 네비

---

### Phase 24: 다중검색 (Multi-Search) 모달

**목적**: LOT 다중검색 모달의 입력/검증/적용/결과 확인. dot(.) 접미사 제거, LOT+WAFER 쌍 매칭, 이미지 무결성까지 검증.

**평가 항목**:

#### 24-1. 모달 열기
1. `#multi-search-btn` ("다중검색") 클릭 → `#multi-search-modal` display !== 'none'
2. 모달 제목 "LOT 다중 검색" 표시
3. textarea(`#multi-search-input`)가 비어있는지 확인
4. 적용/취소 버튼 존재
5. **모달 열면 일반 검색창(`#file-search`) 텍스트 초기화 확인**

#### 24-2. LOT ID 입력 & 적용
1. textarea에 여러 LOT ID 입력 (줄바꿈 구분):
   ```
   LOTA
   LOTB
   ```
2. "적용" 버튼(`#multi-search-apply`) 클릭
3. 그리드에 해당 LOT의 이미지만 표시 확인
4. LOT ID가 없는 이미지는 필터링 확인

#### 24-3. 검증 에러
1. 빈 입력 상태에서 적용 → 에러 메시지(`#multi-search-error`) "LOT ID를 한 개 이상 입력하세요." 표시
2. Escape 키로 모달 닫기 확인

#### 24-4. 취소
1. 취소 버튼(`#multi-search-cancel`) 클릭 → 모달 닫힘
2. 그리드 상태 변경 없음

#### 24-5. dot(.) 접미사 제거
입력에 `.숫자` 또는 `.문자`가 포함되면 dot 이후를 제거하고 검색한다.
**stripDotSuffix 규칙**: 각 공백 구분 토큰에서 첫 번째 `.` 이후 제거 (`.`으로 시작하면 유지).

1. **일반 검색**: `wafer_palette_5mb.3` 입력 → `wafer_palette_5mb`로 검색 → 결과 있음
2. **일반 검색 복합**: `wafer.1 palette.2` 입력 → `wafer palette`로 검색 → 결과 있음
3. **다중검색**: `ABC123.1\nDEF456.2\nGHI789` → LOT 파싱: `[ABC123, DEF456, GHI789]`
4. **다중검색 중복 제거**: `ABC123.1\nABC123.2` → 둘 다 `ABC123` → 중복 제거 → 1개 LOT
5. **AND/OR/NOT + dot**: `palette.1 and 5mb.2` → `palette and 5mb` → 결과 있음
6. **dot 시작 유지**: `.hidden` → `.hidden` (변환 안 함)
7. 다양한 케이스 검증:
   ```
   ABC123.1 → ABC123
   ABC123.1 09 → ABC123 09
   LOT001.2 LOT002.3 → LOT001 LOT002
   A.1 B.2 C → A B C
   .hidden → .hidden (유지)
   ```

#### 24-6. 대량 noise 입력 LOT 추출 (100개 초과)
다중검색에 100줄 이상 다양한 noise 입력 시 LOT만 정확히 추출되어 빠르게 검색되는지 확인.
**파싱 규칙**: `_ split → 맨앞`, `공백/탭 split → 맨앞`, `dot 제거`, `중복제거`.

1. **110줄 noise 입력** (아래 패턴 혼합):
   ```
   wafer                           → wafer
   wafer_map_07_00001              → wafer (_ split)
   wafer.J3                        → wafer (dot 제거)
   wafer 07                        → wafer (공백 split)
   wafer.J3_00P_04_timestamp       → wafer (dot+_ 혼합)
   wafer\t99\textra                → wafer (탭 split)
   WAFER.X1 99                     → WAFER (대소문자, 중복)
   NONEXIST1.J3 04                 → NONEXIST1 (존재하지 않는 LOT)
   ```
2. **중복 제거**: 110줄 → 6개 유니크 LOT (wafer + 존재하지 않는 5개)
3. **100개 초과 에러 없음**: 중복 제거 후 6개이므로 MAX 100 제한에 걸리지 않음
4. **검색 속도**: LOT-only 빠른 경로 사용 (기존과 동일 성능)
5. **그리드 결과**: 3000건, 이미지 60/60 정상 로드, broken=0

#### 24-7. 검색 결과 이미지 무결성
1. 검색 후 그리드 첫 36개 이미지 `naturalWidth > 0 && complete === true` 확인
2. X표시, 깨진 이미지, 이상한 맵 없어야 함
3. 썸네일 크기 512×512 확인
4. 서버 API 이미지 다운로드 vs 디스크 원본 MD5 해시 비교 → 100% 일치

#### 24-8. Shift+Enter 줄바꿈
1. textarea에서 Shift+Enter → 줄바꿈 삽입 (검색 실행 아님)
2. Enter만 누르면 → 검색 실행

**pass 기준**: 모달 열기→LOT 입력→적용(필터링)→에러 처리→취소→dot 접미사 제거→LOT+WAFER 쌍 매칭→이미지 무결성→Shift+Enter 줄바꿈

**참고**: E2E 테스트 스크립트 `scripts/test_search_e2e.py` (22개 테스트)

---

### Phase 25: 권한 관리 (Permission Editor)

**목적**: 권한 편집 모달의 사용자 목록/역할 변경/저장 기능 확인

**평가 항목**:

#### 25-1. 모달 열기
1. "권한 변경" 버튼(`#permission-editor-button`) 클릭 → `#permission-editor-modal` 표시
2. 좌측 패널: 사용자 목록(`#permission-user-list`) 로드
3. 역할 필터 버튼 존재: ALL, ROLE_POWER, ROLE_ADMIN, ROLE_SUPER

#### 25-2. 역할 필터링
1. ALL 버튼 `.active` 확인 (기본값)
2. ROLE_ADMIN 클릭 → 해당 역할 사용자만 목록에 표시
3. ALL 다시 클릭 → 전체 목록 복원

#### 25-3. 사용자 검색
1. 검색 입력(`#permission-search-input`)에 텍스트 입력
2. `#permission-search-results` 드롭다운에 매칭 사용자 표시
3. 검색 결과 클릭 → 등록 테이블에 행 추가

#### 25-4. 등록 테이블
1. `#permission-registration-table`에 행 존재 확인
2. 행 추가 버튼(`#permission-add-row-btn`) 클릭 → 빈 행 추가
3. 역할 드롭다운에서 역할 선택 가능

#### 25-5. 모달 닫기
1. 취소 버튼(`#permission-cancel-btn`) 클릭 → 모달 닫힘

**pass 기준**: 모달 열기→필터→검색→테이블 조작→닫기

---

### Phase 26: 컨텍스트 메뉴 복사/다운로드 기능

**목적**: 우클릭 메뉴의 복사/다운로드 항목이 정상 동작하는지 확인

**평가 항목**:

#### 26-1. 그리드 컨텍스트 메뉴 항목 확인
1. 이미지 5개 선택 → `.grid-thumb-wrap` 우클릭
2. `#grid-context-menu` display === 'block'
3. 표시 항목 확인:
   - "📊 Composite 만들기 ▸"
   - "📌 Ref Map 등록"
   - "📥 선택 파일 다운로드"
   - "🖼️ 선택한 이미지 복사 (Legend 포함)"
   - "📋 선택 LOT 리스트 복사(YMS 방식)"
   - "📊 선택 wafer 정보 복사(테이블)"
   - "📝 MY LOT에 추가"
   - "❌ 취소"

#### 26-2. LOT 리스트 복사 (YMS 방식)
1. "📋 선택 LOT 리스트 복사" 클릭
2. 클립보드에 `LOT\tWafer` 형식 텍스트 복사 확인
3. alert 또는 토스트로 복사 성공 안내

#### 26-3. Wafer 정보 복사 (테이블)
1. "📊 선택 wafer 정보 복사" 클릭
2. 클립보드에 탭 구분 테이블 형식 복사 확인
3. 컬럼: Device, PartID, LOT, Wafer, Yield, Sys 등

#### 26-4. 이미지 복사 (Legend 포함)
1. "🖼️ 선택한 이미지 복사" 클릭
2. 선택된 이미지들을 Legend와 함께 merge한 캔버스 생성
3. 클립보드에 이미지 blob 복사 확인

#### 26-5. 다운로드
1. "📥 선택 파일 다운로드" 클릭
2. 선택된 이미지 파일 다운로드 시작 (배치 100ms 간격)

#### 26-6. 취소
1. "❌ 취소" 클릭 → 메뉴 닫힘
2. 메뉴 바깥 클릭 → 메뉴 닫힘

**pass 기준**: 메뉴 항목 전체 표시, 복사 3종(LOT/wafer info/이미지), 다운로드, 닫기

---

### Phase 27: 키보드 단축키 & 드래그 선택

**목적**: 그리드/단일 이미지 모드의 키보드 단축키와 드래그 선택이 정상 동작

**평가 항목**:

#### 27-1. 그리드 모드 키보드 단축키
1. `Ctrl+A` → 전체 선택 (`v.gridSelectedIdxs.length === v.currentGridImages.length`)
2. `Escape` → 전체 해제 (`v.gridSelectedIdxs.length === 0`)
3. `Enter` → 선택 이미지가 1개면 단일 모드 진입

#### 27-2. 그리드 드래그 선택 (러버밴드)
1. 그리드 빈 영역에서 mousedown → 드래그 → `#grid-drag-select` 사각형 표시
2. 드래그 영역 안에 들어온 이미지 자동 선택
3. mouseup → 사각형 사라지고 선택 확정
4. Shift+드래그 → 기존 선택에 추가

#### 27-3. 단일 이미지 모드 키보드
1. `←` / `→` 화살표 → 이전/다음 이미지 네비게이션
2. `Escape` → 그리드 복귀
3. `Ctrl+C` → 현재 이미지 클립보드 복사

#### 27-4. 칩 다중선택 방식
1. 칩 클릭 → 단일 선택
2. `Ctrl+클릭` → 추가 선택 (토글)
3. `Shift+클릭` → 범위 선택 (처음~끝 사이 칩 모두)
4. `Alt+드래그` → 자유형(lasso) 영역 선택
5. 빈 영역 클릭 → 전체 해제
6. 선택된 칩 수가 정보 패널에 반영

#### 27-5. 검색창 키보드 독립성
1. 검색 입력창에 포커스 → 좌/우 화살표로 커서 이동 (Phase 3-13 참조)
2. 검색 입력 중 `Ctrl+A` → 텍스트 전체 선택 (그리드 전체선택 아님)
3. 검색 입력 중 `Escape` → 포커스 해제

**pass 기준**: Ctrl+A/Escape/Enter, 드래그 선택, 화살표 네비, 칩 다중선택 4종, 검색창 독립

---

### Phase 28: 그리드 상태 복구 안정성 (반복 선택/해제/더블클릭)

**목적**: 이미지 선택/해제, 더블클릭 단일 모드 진입·복귀, 우클릭 초기화를 반복해도 폴더 Ctrl+클릭으로 그리드가 정상 표시되는지 검증

**배경**: `handleFileRightClick()`, `exitSingleImageViewMode()`, `hideGrid()` 간 상태 플래그(`_gridVisuallyHidden`, `viewMode`, `selectedImages`) 불일치로 반복 조작 후 그리드가 나타나지 않는 버그 수정 검증

**평가 항목**:

#### 28-1. 우클릭 초기화 후 폴더 재선택 (기본)
1. Ctrl+클릭으로 폴더 선택 → 그리드 표시 (`v.gridMode === true`, `grid.children.length > 0`)
2. Wafer Map Explorer 영역에서 우클릭 → `v.handleFileRightClick()` → 모든 상태 초기화
3. 초기화 후 상태 확인: `v.selectedImages.length === 0`, `v._gridVisuallyHidden === false`, `v.viewMode === null`, `v.singleImageFromGrid === false`
4. 같은 폴더 Ctrl+클릭 → 그리드 다시 표시 확인 (`v.gridMode === true`, `grid.children.length > 0`)

#### 28-2. 더블클릭 단일 모드 → 더블클릭 복귀 → 우클릭 초기화 → 재선택 (3회 반복)
1. Ctrl+클릭 폴더 → 그리드 로드
2. 그리드 이미지 더블클릭 → 단일 이미지 모드 (`v.viewMode === 'gridImage'`)
3. 뷰어 영역 더블클릭 → 그리드 복귀 (`v.gridMode === true`)
4. 복귀 후 `v.selectedImages.length` > 0 확인 (전체 그리드 이미지 수와 동일해야 함)
5. Wafer Map Explorer 우클릭 → 초기화
6. 같은 폴더 Ctrl+클릭 → 그리드 재표시 확인
7. 위 1~6을 3회 반복 — 매 반복마다 `grid.children.length > 0` 확인

#### 28-3. 단일 모드에서 직접 우클릭 초기화 (더블클릭 복귀 없이)
1. Ctrl+클릭 폴더 → 그리드 로드
2. 그리드 이미지 더블클릭 → 단일 이미지 모드 (`v._gridVisuallyHidden === true`)
3. **그리드 복귀 없이** Wafer Map Explorer 우클릭 → `handleFileRightClick()` 호출
4. 초기화 후 `v._gridVisuallyHidden === false` 확인 (핵심 검증 포인트)
5. 같은 폴더 Ctrl+클릭 → 그리드 정상 표시 확인

#### 28-4. clearGridSelection 후 폴더 재선택
1. Ctrl+클릭 폴더 → 그리드 로드
2. `v.clearGridSelection()` 호출
3. `v._gridVisuallyHidden === false` 확인
4. Wafer Map Explorer 우클릭 → 초기화
5. 같은 폴더 Ctrl+클릭 → 그리드 재표시 확인

#### 28-5. selectedImages 복원 검증 (exitSingleImageViewMode)
1. Ctrl+클릭 폴더 → 그리드 로드, `selectedImages.length` 기록 (`N`이라 하자)
2. 그리드 이미지 더블클릭 → 단일 이미지 모드 진입
3. `exitSingleImageViewMode()` 호출하여 그리드 복귀
4. `v.selectedImages.length === N` 확인 (비어 있으면 안 됨)
5. `v.currentGridImages.length === N` 확인

#### 28-6. 3000개 폴더 반복 선택/해제/더블클릭 안정성 (5회)
대량 이미지(3000장) 폴더에서 반복 조작 후에도 그리드가 정상 표시되는지 검증.

1. `v.loadImagesInFolderAndShowGrid('palette_3k')` → 3000개 로드 확인
2. 전체선택 (`v.selectAllGridImages()`) → `v.gridSelectedIdxs.length === 3000`
3. 더블클릭 단일 모드 (`v.enterGridImageViewMode(0, v.currentGridImages)`) → `v.viewMode === 'gridImage'`
4. 그리드 복귀 (`v.exitSingleImageViewMode()`) → `v.gridMode === true`, grid visible
5. 전체해제 (`v.clearGridSelection()`) → `v.gridSelectedIdxs.length === 0`
6. 상태 확인: `v._gridVisuallyHidden === false`, `v.viewMode === null`
7. 1~6을 **5회 반복** — 매 라운드 모든 조건 통과
8. 최종: `v.loadImagesInFolderAndShowGrid('palette_3k')` → 그리드 정상 표시 확인

**pass 기준**: 28-1~28-6 모든 항목에서 폴더 클릭 후 `grid.children.length > 0`이고 `v.gridMode === true`, `v.selectedImages.length > 0`

---

### Phase 29: 그리드↔단일 이미지 전환 시 스크롤/로딩 안정성

**목적**: 그리드→단일 이미지→그리드 복귀, 우클릭 해제→새 폴더 선택 시 스크롤 위치와 썸네일 로딩이 정상 동작하는지 검증

**배경**:
- `_showGridVisual()`에서 `single-image-mode` CSS 클래스 미제거로 `display: none !important` 유지되어 그리드 스크롤 복원 실패
- `grid.style.display = ''`가 CSS 기본값으로 fallback되어 grid 레이아웃 미적용
- 우클릭 해제 후 스크롤 wrapper scrollTop 미초기화로 새 폴더 선택 시 이전 스크롤 유지
- fast path 복귀 시 `loadVisibleGridThumbnails()` 미호출로 보이는 영역 썸네일 로드 지연

**평가 항목**:

#### 29-1. 그리드 복귀 시 스크롤 위치 복원
1. Ctrl+클릭 폴더(wafer_edge_ring) → 그리드 로드 (3000개)
2. 그리드 스크롤을 8000px로 설정, 1초 대기
3. `v.enterSingleImageMode(80)` → 단일 이미지 모드 진입
4. 상태 확인: `v._gridVisuallyHidden === true`, `v.gridViewSaveState.scrollTop === 8000`
5. `v.exitSingleImageViewMode()` → 그리드 복귀, 500ms 대기
6. **핵심 검증**: `document.querySelector('.grid-scroll-wrapper').scrollTop` ≈ 8000 (±200)
7. **핵심 검증**: `document.querySelector('.grid-scroll-wrapper').scrollHeight` > 0 (grid DOM 정상 표시)
8. **핵심 검증**: `document.querySelector('.viewer-container').classList.contains('single-image-mode') === false`

#### 29-2. 그리드 복귀 시 파일 탐색기 스크롤 및 폴더 선택 복원
1. Ctrl+클릭 폴더 → 그리드 로드
2. 파일 탐색기 스크롤 위치 기록 (`explorer.scrollTop`)
3. `v.enterSingleImageMode(0)` → 단일 이미지 모드
4. `v.exitSingleImageViewMode()` → 그리드 복귀, 300ms 대기
5. **핵심 검증**: `explorer.querySelector('summary.folder.selected')` 존재 (폴더 선택 시각적 복원)
6. **핵심 검증**: `v.selectedFolders.size > 0` (상태 복원)
7. **핵심 검증**: `explorer.scrollTop` === 저장된 값 (파일 탐색기 스크롤 복원)

#### 29-3. 우클릭 해제 후 새 폴더 선택 시 그리드 스크롤 맨 위
1. Ctrl+클릭 폴더 → 그리드 로드 → 스크롤 8000px
2. `v.enterSingleImageMode(80)` → 단일 이미지 모드
3. `v.exitSingleImageViewMode()` → 그리드 복귀 (스크롤 8000px)
4. `v.handleFileRightClick({preventDefault:()=>{}, stopPropagation:()=>{}})` → 전체 해제
5. **핵심 검증**: `document.querySelector('.grid-scroll-wrapper').scrollTop === 0` (스크롤 초기화)
6. 다른 폴더(wafer_folder) Ctrl+클릭 → 그리드 로드
7. **핵심 검증**: `document.querySelector('.grid-scroll-wrapper').scrollTop === 0` (새 폴더 맨 위)
8. **핵심 검증**: `v.currentGridImages.length > 0` (그리드 정상 표시)

#### 29-4. 그리드 복귀 시 보이는 영역 썸네일 즉시 로드
1. Ctrl+클릭 폴더(wafer_edge_ring) → 그리드 로드 (3000개)
2. 그리드 스크롤을 5000px로 설정, 2초 대기 (스크롤 영역 썸네일 로드)
3. `v.enterSingleImageMode(50)` → 단일 이미지 모드
4. `v.exitSingleImageViewMode()` → 그리드 복귀, 1초 대기
5. 현재 뷰포트 내 `.grid-thumb-img` 요소 중 `img.complete && img.naturalWidth > 1` 비율 계산
6. **핵심 검증**: 뷰포트 내 로드된 비율 > 50% (즉시 로드 시작됨)

**pass 기준**: 29-1~29-4 모든 핵심 검증 통과

---

### Phase 30: Measure 맵 전환 시 회색 배경 방지

**목적**: Measure heatmap이 이미 적용된 상태에서 다른 measure key를 클릭할 때 이미지 배경이 회색으로 변하지 않는지 검증

**배경**:
- `refreshGridThumbnailsWithCurrentParams()`에서 이미 로드된 이미지의 `opacity`를 0.5로 설정 + `img.src`가 placeholder로 리셋되면 배경색(`#1c1c1c`)이 보여 회색으로 나타남
- 수정: 이미 로드된 이미지(`img.src`가 `data:`로 시작하지 않는 경우)는 opacity를 유지

**평가 항목**:
1. palette_3k 폴더 로드 → Measure 버튼 클릭 → MC 패널 열기
2. FBT 키 하나 클릭 → Measure heatmap 적용 (이미지에 gradient 표시)
3. 5초 대기 (이미지 로드 완료)
4. 다른 FBT 키 클릭 → Measure 맵 전환
5. **핵심 검증**: 뷰포트 내 `.grid-thumb-img` 중 `opacity < 1`인 이미지 비율 < 20%
6. **핵심 검증**: 뷰포트 내 이미지의 `img.src`가 `data:` (placeholder)인 비율 < 10%
7. 3초 대기 후 모든 뷰포트 이미지의 `opacity === '1'` 확인

**pass 기준**: 전환 중 회색 배경 없이 이전 이미지가 유지되고, 새 이미지 로드 후 정상 교체

---

### Phase 31: palette_3k grade 다양성 검증

**목적**: palette_3k 이미지들의 grade가 0~7로 다양하게 분포되어 있는지 검증

**배경**:
- positions JSON에 `g` 필드가 없어서 모든 chip이 grade 0으로 렌더링됨
- 수정: `_assign_grade()` 함수로 chip 좌표 기반 해시 → grade 0~7 균등 분배

**평가 항목**:
1. palette_3k 폴더의 첫 이미지를 단일 이미지 모드로 열기
2. `chipAnnotator.chips`에서 각 chip의 BIN 값 분포 확인 (다양한 BIN 존재)
3. `/api/image?path=palette_3k/wafer_p3k_0001_...` 원본 이미지 요청
4. **핵심 검증**: 이미지 pixel에서 grade 0~7 각각의 pixel 수가 전체의 5% 이상 (8 grade 모두 존재)
5. 또는 browser_evaluate로 canvas에 이미지를 그려 pixel color 분석
6. 대안: 그리드 스크린샷에서 이미지들이 시각적으로 다양한 색상을 가지는지 확인

**pass 기준**: grade 0~7이 모두 이미지에 존재하고, 단일 grade만 있지 않음

---

### Phase 32: 폴더 전환 시 스크롤 맨 위 강제

**목적**: 폴더를 전환할 때 그리드 스크롤이 항상 맨 위(0)로 리셋되는지 검증

**배경**:
- `updateFileExplorerSelection()` → `showGrid()` 경로에서 `_lastGridScrollTop`과 `savedViewState.scrollTop` 미리셋
- `showGridByLot()`의 이전 `setTimeout(doRestore)` 타이머가 새 호출을 덮어씀
- 수정: 스크롤 상태 리셋 + `_scrollRestoreId` 카운터로 이전 타이머 무효화

**평가 항목**:

#### 32-1. loadImagesInFolderAndShowGrid 경로
1. `v.loadImagesInFolderAndShowGrid('palette_3k')` → 4초 대기
2. 스크롤을 8000px로 설정
3. `v.loadImagesInFolderAndShowGrid('sort_test')` → 3초 대기
4. **핵심 검증**: `scrollWrapper.scrollTop === 0`

#### 32-2. updateFileExplorerSelection 경로 (Ctrl+클릭 시뮬레이션)
1. `v.loadImagesInFolderAndShowGrid('palette_3k')` → 4초 대기
2. 스크롤을 8000px로 설정
3. `fetch('/api/files?path=sort_test')` → `v.selectedImages = files` → `v.updateFileExplorerSelection()`
4. 700ms 대기
5. **핵심 검증**: `scrollWrapper.scrollTop === 0`

#### 32-3. 연속 폴더 전환
1. palette_3k 로드 → 스크롤 5000px → sort_test 로드 → 스크롤 확인
2. sort_test 로드 → 스크롤 3000px → palette_3k 로드 → 스크롤 확인
3. **핵심 검증**: 모든 전환에서 `scrollTop === 0`

**pass 기준**: 32-1~32-3 모든 핵심 검증 통과 (새 폴더 진입 시 항상 scrollTop === 0)

---

### Phase 33: Measure 다중 선택 — 전체 기능 검증

**목적**: Measure 드롭다운 다중선택 UI, 그리드 확장, 라벨 포맷, Navigator 갱신, 단일↔그리드 전환, 선택 이미지 필터, 404 placeholder를 종합 검증

**배경**:
- Measure 드롭다운: 체크박스 다중선택 (MAP: Failbit, BIN, FBT 섹션, QVL 섹션)
- FBT/QVL 키: 4자리 제로패딩 (69 → `FBT0069`)
- 다중 선택 시 `images × measureItems`로 그리드 리스트 확장
- 라벨 포맷: Failbit(원본)=접두사 없음, FBT/QVL=`F0069_filename` (대문자), BIN=`BIN_filename`
- 단일 이미지 파일명: `F0069_filename` (대문자 + 4자리 패딩)
- measure-thumb 404: 빈 회색 placeholder 이미지 반환 (깨진 아이콘 방지)

**사전 준비** (모든 하위 테스트 공통):
```javascript
v.lotMode = false;
v.loadImagesInFolderAndShowGrid('palette_3k');
// 6초 대기 후 v.currentGridImages.length > 0 확인
```

**평가 항목**:

#### 33-1. 드롭다운 UI 확인
1. Measure 버튼 (`#failbit-btn-top`) 클릭 → 패널 표시 확인
2. **핵심 검증**: 패널에 체크박스 아이템 존재 (`.failbit-item input[type="checkbox"]`)
3. **핵심 검증**: MAP 섹션에 `Failbit` 항목 존재
4. **핵심 검증**: BIN 섹션에 `BIN` 항목 존재
5. **핵심 검증**: FBT 항목이 4자리 패딩 (`FBT0069` 형태)
6. **핵심 검증**: 적용 버튼 (`.measure-apply-btn`) 존재
7. **핵심 검증**: 초기화 항목 존재 (클릭 시 전체 체크 해제)

#### 33-2. 그리드 다중 선택 (Failbit + BIN + FBT)
1. `v._measureCheckedItems = [{type:'failbit',key:null,label:'Failbit'},{type:'bin',key:null,label:'BIN'},{type:'f',key:'85',label:'FBT0085'}]`
2. `v._applyMeasureSelection()` → 6초 대기
3. **핵심 검증**: `v.overlayMode === 'multi'`
4. **핵심 검증**: `v._gridMeasureMap`이 배열 (null 아님)
5. **핵심 검증**: `v.currentGridImages.length === v._measureBaseImages.length × 3`
6. **핵심 검증**: Measure 버튼 텍스트에 `Measure (3)` 포함
7. **핵심 검증**: 모든 이미지 정상 로드 (깨진 아이콘 없음) — measure-thumb 404도 회색 placeholder로 표시

#### 33-3. 라벨 포맷 검증
1. 33-2 상태에서 `.grid-thumb-label` 텍스트 확인
2. **핵심 검증**: Failbit 라벨 = 파일명만 (접두사 없음, 예: `wafer_p3k_0001_EE_Engineer`)
3. **핵심 검증**: BIN 라벨 = `BIN_` 접두사 (예: `BIN_wafer_p3k_0001_EE_Engineer`)
4. **핵심 검증**: FBT 라벨 = 대문자 + 4자리 패딩 (예: `F0085_wafer_p3k_0001_EE_Engineer`)
5. **핵심 검증**: 같은 이미지의 3개 라벨에서 파일명 부분 동일

#### 33-4. 선택 이미지만 measure 적용
1. 33-2 초기화 후 일반 그리드로 복원
2. `v.gridSelectedIdxs = [0,1,2]`, `v.gridSelectedSet = new Set([0,1,2])`
3. Failbit + BIN 2개 적용 → `v._applyMeasureSelection()` → 5초 대기
4. **핵심 검증**: `v.currentGridImages.length === 6` (선택 3개 × 2 measure)
5. **핵심 검증**: `v._measureBaseImages.length === 3`

#### 33-5. 1개 이미지 선택 + 1개 measure → 단일 이미지 전환
1. 일반 그리드 상태에서 `v.gridSelectedIdxs = [0]`, `v.gridSelectedSet = new Set([0])`
2. FBT0069 1개만 적용: `v._measureCheckedItems = [{type:'f',key:'69',label:'FBT0069'}]`
3. `v._applyMeasureSelection()` → 4초 대기
4. **핵심 검증**: `v.gridMode === false` (단일 이미지 모드 전환)
5. **핵심 검증**: `v.overlayMode === 'f'`
6. **핵심 검증**: 상단 파일명에 `F0069_` 접두사 포함 (대문자 + 4자리 패딩)
7. **핵심 검증**: measure heatmap 이미지 정상 로드 (chip 값 표시)

#### 33-6. 단일 이미지 모드 Navigator 갱신
1. 33-5 상태에서 Navigator 썸네일 확인
2. **핵심 검증**: Navigator 썸네일 URL에 `/api/measure-thumb` 포함
3. **핵심 검증**: Navigator 썸네일이 measure heatmap으로 표시 (원본 아님)

#### 33-7. 단일 이미지 모드에서 다중 선택 → 그리드 전환
1. 33-5 상태(단일 이미지)에서 Failbit + BIN + FBT0069 3개 적용
2. `v._applyMeasureSelection()` → 5초 대기
3. **핵심 검증**: `v.gridMode === true` (그리드 모드 전환)
4. **핵심 검증**: `v.overlayMode === 'multi'`
5. **핵심 검증**: 그리드 이미지 정상 로드

#### 33-8. 초기화 복원
1. `v._measureCheckedItems = []` → `v._applyMeasureSelection()` → 4초 대기
2. **핵심 검증**: `v.overlayMode === null`
3. **핵심 검증**: `v._gridMeasureMap === null`
4. **핵심 검증**: 라벨에 접두사 없음 (원래 파일명만)
5. **핵심 검증**: Measure 버튼 텍스트가 `Measure` (숫자 없음)
6. **핵심 검증**: `v.currentGridImages.length === v._measureBaseImages.length` (확장 해제)

#### 33-9. measure-thumb 404 placeholder 확인
1. 존재하지 않는 키로 API 직접 호출: `curl /api/measure-thumb?path=...&field=f&key=99999&size=256`
2. **핵심 검증**: HTTP 200 반환 (404 아님)
3. **핵심 검증**: 응답 크기 > 0 (빈 회색 placeholder 이미지)

**pass 기준**: 33-1~33-9 모든 핵심 검증 통과

---

### Phase 34: Measure 탭 분리 + 폴더 전환 Measure 유지

**목적**: 이미지 선택 후 Measure 키 클릭 시 새 "mea" 탭 생성, 미선택 시 현재 탭 바꿔치기, 폴더 전환 시 Measure 유지 검증

**배경**:
- 이미지 선택 + Measure 키 → 새 "mea" 탭, 선택 이미지만 measure-thumb
- 미선택 + Measure 키 → 현재 탭에서 바꿔치기
- mea 탭에서 다른 키 → 같은 탭에서 교체 (탭 추가 없음)
- 원래 탭 → 일반 썸네일 유지
- Measure 활성 상태에서 폴더 전환 → measure-thumb 유지

**평가 항목**:

#### 34-1. 선택 + Measure → 새 mea 탭
1. palette_3k 로드 → 5개 이미지 Ctrl+클릭 선택
2. Measure 드롭다운에서 FBT 키 클릭
3. **핵심 검증**: 새 탭 생성, `title === 'mea0'`, `role === 'measure'`
4. **핵심 검증**: 그리드에 5개 이미지만 표시, 모두 measure-thumb URL
5. **핵심 검증**: gradient 범례 (0~10% ~ 90~100%) 표시

#### 34-2. mea 탭에서 키 교체
1. 다른 FBT 키 클릭
2. **핵심 검증**: 탭 수 변화 없음 (새 탭 추가 안 됨)
3. **핵심 검증**: 같은 mea0 탭에서 이미지 갱신

#### 34-3. 원래 탭 복귀
1. page0 탭 클릭
2. **핵심 검증**: 일반 썸네일로 3000개 표시 (measure 아님)

#### 34-4. 미선택 + Measure → 현재 탭 바꿔치기
1. 선택 해제 상태에서 FBT 키 클릭
2. **핵심 검증**: 탭 수 변화 없음
3. **핵심 검증**: 현재 탭(page0)에서 measure-thumb으로 바꿔치기

#### 34-5. Measure 활성 상태 폴더 전환
1. Measure가 활성인 상태에서 `loadImagesInFolderAndShowGrid('palette_3k')` 재호출
2. **핵심 검증**: `overlayMode === 'f'` 유지
3. **핵심 검증**: 뷰포트 이미지가 measure-thumb URL

#### 34-6. measure-thumb 배경 개인색
1. `/api/measure-thumb?path=...&scheme=notsaml` 호출
2. 응답 이미지를 canvas에 그려 좌상단 (0,0) 픽셀 색상 확인
3. **핵심 검증**: 배경색이 `color-legends.json`의 해당 사용자 `background` 색상과 일치 (WEBP 압축 오차 ±5 허용)
4. **핵심 검증**: 하드코딩 #CCCCCC가 아님

#### 34-7. 컨텍스트 메뉴 Measure 만들기 드롭다운
1. 이미지 선택 → 우클릭 → "📏 Measure 만들기 ▸" 항목 존재 확인
2. hover → 서브메뉴 열림
3. **핵심 검증**: FBT 항목 **10개** 이하 (헤더에 "500개 중 10개" 표시)
4. **핵심 검증**: QVL 항목 **10개** 이하
5. **핵심 검증**: 각 항목에 **체크박스** 존재
6. **핵심 검증**: 하단에 **"적용 (N)"** 버튼 존재
7. 검색창에 "009" 입력 → 필터링 동작 확인

#### 34-8. 컨텍스트 메뉴 Composite 만들기 드롭다운 제한
1. "📊 Composite 만들기 ▸" hover → 서브메뉴
2. **핵심 검증**: FBT 항목 **10개** 이하, QVL 항목 **10개** 이하

**pass 기준**: 34-1~34-8 모든 핵심 검증 통과

---

## 결과 보고

각 Phase별로 pass/fail 요약표를 작성하세요:

| Phase | 항목 | 결과 | 비고 |
|-------|------|------|------|
| 1 | 페이지 로드 & 기본 UI | pass/fail | |
| 2 | 폴더 & 그리드 + 스크롤 성능 + 정렬 | pass/fail | 로드 시간, 로드율, 7개 정렬 검증 |
| 3 | 제품 검색 & 필터 + 대소문자/폴더보존 | pass/fail | 대소문자 무시, 폴더 상태 보존 |
| 4 | 색상 편집 | pass/fail | |
| 5 | 상단 컬러 범례 (Grade/BIN/Gradient) — 퍼센트/칩수/클릭 | pass/fail | 스크린샷 첨부 |
| 6 | LOT Mode | pass/fail | |
| 7 | Class Manager & Label Explorer | pass/fail | CRUD 전체 |
| 8 | Composite + 결과 범례/Subset 검증 | pass/fail | Gradient 범례, Subset 생성, 칩수 검증 |
| 9 | Context Menu Composite | pass/fail | 안정성 6개 항목 |
| 10 | Ref Map | pass/fail | z-index, resize |
| 11 | Measure heatmap | pass/fail | |
| 12 | MY LOT | pass/fail | CRUD 전체 |
| 13 | 단일 이미지 — 기본 | pass/fail | 줌/탐색/복귀 |
| 14 | 단일 이미지 — 피라미드 렌더링 | pass/fail | 줌별 레벨, 선명도 |
| 15 | 단일 이미지 — 웨이퍼/칩 정보 | pass/fail | 필드 9개+좌표 |
| 16 | 단일 이미지 — 칩 선택 좌표 | pass/fail | Abs/Rel 좌표 |
| 17 | 단일 이미지 — 컨텍스트 메뉴 | pass/fail | |
| 18 | 단일 이미지 — Chip Labels | pass/fail | CRUD |
| 19 | 미선택 보호 | pass/fail | 토스트/안내 |
| 20 | 접속 통계 (stats.html) | pass/fail | API 6개, 카드 4개, 차트 3개, CSV 내보내기 |
| 21 | Page Manager (멀티탭) | pass/fail | 생성/전환/역할색상/닫기/키보드 |
| 22 | Thumbnail Navigator | pass/fail | 표시/클릭/드래그/리사이즈/가상스크롤 |
| 23 | Minimap | pass/fail | 표시/뷰포트/클릭/드래그 네비 |
| 24 | 다중검색 모달 | pass/fail | LOT 입력/적용/에러/취소/dot제거/대량noise LOT추출/이미지무결성 |
| 25 | 권한 관리 | pass/fail | 목록/필터/검색/테이블 |
| 26 | 컨텍스트 메뉴 복사/다운로드 | pass/fail | 복사 3종, 다운로드, 닫기 |
| 27 | 키보드 단축키 & 드래그 선택 | pass/fail | Ctrl+A, 드래그선택, 칩 다중선택 4종 |
| 28 | 그리드 상태 복구 안정성 | pass/fail | 반복 선택/해제/더블클릭 후 그리드 재표시 |
| 29 | 그리드↔단일 이미지 스크롤/로딩 | pass/fail | 스크롤 복원, 폴더선택 복원, 썸네일 즉시 로드 |
| 30 | Measure 맵 전환 회색 배경 | pass/fail | 이전 이미지 유지, 회색 미발생 |
| 31 | palette_3k grade 다양성 | pass/fail | grade 0~7 균등, 다양한 색상 |
| 32 | 폴더 전환 스크롤 리셋 | pass/fail | 모든 경로에서 scrollTop===0 |
| 33 | Measure 다중선택 전체 | pass/fail | UI/라벨/선택필터/단일전환/Navigator/404placeholder |
| 34 | Measure 탭 분리 + 폴더 전환 유지 | pass/fail | mea 탭 생성/키 교체/원탭 복귀/미선택 바꿔치기/폴더 전환 유지 |

핵심 단계마다 스크린샷을 촬영하여 첨부하세요.

## 속도 측정 (Performance Report)

**모든 맵 로드와 생성 속도를 측정하여 결과에 포함합니다.**

### 필수 측정 항목

| 항목 | 측정 방법 | 기준 |
|------|----------|------|
| 페이지 초기 로드 | `navigate` ~ 폴더 목록 렌더링 완료 | < 5초 |
| palette_3k (3000장) 그리드 로드 | `loadImagesInFolderAndShowGrid` ~ grid children 생성 | < 3초 |
| 뷰포트 썸네일 로드 (첫 화면) | grid 로드 ~ 뷰포트 내 `img.complete` > 80% | < 5초 |
| 단일 이미지 로드 + 피라미드 | 더블클릭 ~ `[PREFETCH] 모든 레벨 다운로드 완료` | < 3초 |
| Composite Map 생성 (5장) | POST ~ status=completed | < 5초 |
| Composite Map 생성 (50장) | POST ~ status=completed | < 10초 |
| Measure heatmap 적용 | FBT 클릭 ~ 뷰포트 이미지 갱신 완료 | < 5초 |
| Measure 맵 전환 | 다른 FBT 클릭 ~ 뷰포트 이미지 갱신 완료 | < 5초 |
| 폴더 전환 | 새 폴더 로드 ~ grid children 생성 | < 3초 |

### 결과 테이블 양식

```
| 항목 | 소요 시간 | 판정 |
|------|----------|------|
| 페이지 초기 로드 | 2.1초 | FAST |
| palette_3k 그리드 로드 | 1.5초 | FAST |
| ... | ... | ... |
```

판정 기준: 기준의 50% 이하 = FAST, 기준 이내 = OK, 기준 초과 = SLOW

## 자동 수정 (Auto-Fix)

**실패 Phase가 발견되면 자동으로 코드를 수정합니다.**

### 수정 프로세스

1. **원인 분석**: 실패 Phase의 스크린샷, 콘솔 에러, DOM 상태를 종합하여 근본 원인 파악
2. **관련 코드 탐색**: 원인과 관련된 소스 파일을 Read/Grep으로 찾아 읽기
3. **코드 수정**: Edit 도구로 해당 파일을 직접 수정
4. **재검증**: 수정 후 해당 Phase를 다시 실행하여 pass 확인
5. **반복**: 재검증에서도 실패하면 원인 재분석 → 수정 → 재검증 (최대 3회 반복)

### 수정 원칙

- **최소 변경**: 실패 원인을 해결하는 데 필요한 최소한의 코드만 수정
- **기존 패턴 유지**: 프로젝트의 기존 코딩 스타일과 패턴을 따름
- **부작용 방지**: 다른 Phase에 영향을 줄 수 있는 변경은 사용자 확인 후 진행
- **수정 불가 판단**: 3회 반복 후에도 실패하거나, 구조적 변경이 필요한 경우 사용자에게 상황 보고 후 판단 요청

### 결과 보고

수정이 발생한 경우 요약표에 수정 내역을 추가합니다:

| Phase | 항목 | 결과 | 수정 | 비고 |
|-------|------|------|------|------|
| N | ... | fix → pass | `파일명:라인` 수정 내용 요약 | |

---

## Phase 35: 성능 벤치마크

서버 재시작 직후(cold) 상태에서 핵심 기능의 응답 시간을 측정합니다.

### 측정 항목 및 기준값 (Cold = 서버 재시작 직후)

**Failbit Composite (이미지 로드 필수)**

| 항목 | API | Cold 기준 (20매) | 비고 |
|------|-----|-----------------|------|
| Failbit Composite | POST /api/composite-map → 폴링 | < 10초 | Grade 8장 + Sum 2장, PIL 이미지 로드 |

**Measure Composite (이미지 로드 없음, positions만)**

| 항목 | API | Cold 기준 (20매) | 비고 |
|------|-----|-----------------|------|
| FBT 데이터 | POST /api/measure-composite-data | < 2초 (cold) | ProcessPool 첫 디스패치 포함 |
| BIN 데이터 | POST /api/measure-composite-data | < 300ms | positions 캐시 히트 |
| QVL 데이터 | POST /api/measure-composite-data | < 300ms | positions 캐시 히트 |
| FBT 이미지 | POST /api/measure-composite → 폴링 | < 1초 | PIL ImageDraw + JPEG 저장 |
| 멀티 3키 | measure-composite-data × 3 병렬 | < 500ms | positions 캐시 |
| 단일 Canvas | _applyRatioOverlayClient | < 1초 | 브라우저 Canvas 직접 렌더링 |
| Measure-thumb | GET /api/measure-thumb | < 20ms/장 | positions-only WEBP |

**공통**

| 항목 | API | Cold 기준 | 비고 |
|------|-----|----------|------|
| 피라미드 전 레벨 | loadImage + prefetchAllPyramidLevels | < 2초 | 0.2+0.5+0.7 병렬 |
| 그리드 measure 전환 | FBT 적용 후 뷰포트 썸네일 | < 3초 | measure-thumb 캐시 미스 |

### 측정 방법

```javascript
// 1. 폴더 로드 + 20장 선택
await v.loadImagesInFolderAndShowGrid('palette_3k');
const paths = v.currentGridImages.slice(0, 20);
v.selectedImages = paths;

// 2. Measure 데이터 API (Cold)
const t0 = performance.now();
const resp = await fetch('/api/measure-composite-data', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ image_paths: paths, mode: 'f', item_key: fbtKey, aggregation: 'average' })
});
const data = await resp.json();
const elapsed = Math.round(performance.now() - t0);
// 기준: processing_time < 0.3s
```

### 성능 최적화 이력

**Composite Map (11.5s → 7.3s)**
- numba JIT: grade_counts(8x), mask+transform(6x), render(50x)
- turbojpeg 병렬 Grade 히트맵 저장
- numpy 직접 저장 (PIL 변환 제거)
- positions 복사 비동기화

**Measure (6s → 112ms data / 556ms Canvas)**
- /api/measure-composite-data: 이미지 렌더링 없이 좌표+값+색상 JSON 반환
- 단일 이미지 모드: overlay 제거 → Canvas 직접 렌더링 (_renderMeasureOnCanvas)
- ProcessPool 병렬 JSON 파싱 (모든 워커 서버 시작 시 워밍업)
- PIL ImageDraw 렌더링 (numpy 143MB 배열 제거, 6x 빠름)
- 원본 이미지 로드 제거 (positions 좌표만으로 캔버스, 배경=개인색)
- positions JSON 메모리 캐시 (256 entries) + orjson
- 1개 이미지: 순차 (ProcessPool 스폰 회피), 다수: ProcessPool 병렬

**Pyramid (3.9s → 0.5s)**
- 프리페치 순차→병렬 (Promise.allSettled)
- Level 1.0 body stream 버그 수정 (arrayBuffer 선읽기)

**품질 보장**
- pyvips palette PNG 깨짐 발견 → PIL 유지 (palette 인덱스 보존)
- JPEG Q=95, TJSAMP_444 동일 (1월 커밋 대비 검증)
- 단일 이미지 Measure: Canvas에서 개인색 배경 + gradient 칩 + bold 숫자 텍스트

---

## Phase 36: 이미지 무결성 검증 (깨짐/X표시/이상 맵 확인)

모든 이미지 경로에서 깨진 이미지, X표시, 잘못된 맵이 없는지 전방위 확인합니다.

### 36-1. 그리드 썸네일 무결성

1. `palette_3k` 로드 → 뷰포트 내 이미지 30개 대기 (최대 20초)
2. 첫 30개 `img.complete && img.naturalWidth > 10 && !img.src.startsWith('data:')` 확인
3. **pass 기준**: broken === 0

```javascript
const wraps = document.querySelectorAll('.grid-thumb-wrap');
let ok = 0, broken = 0;
for (let i = 0; i < Math.min(30, wraps.length); i++) {
    const img = wraps[i].querySelector('img');
    if (img && img.complete && img.naturalWidth > 10 && !img.src.startsWith('data:')) ok++;
    else broken++;
}
// broken === 0
```

### 36-2. 그리드 끝 영역 썸네일

1. 마지막 30개 (2971~3000번) 이미지도 동일 확인
2. `wraps[i].querySelector('img')` 로드 후 `naturalWidth > 10`
3. **pass 기준**: broken === 0

### 36-3. 썸네일 API 샘플링 (10개)

1. 인덱스 [0, 50, 200, 500, 999, 1500, 2000, 2500, 2800, 2999]의 이미지 경로로 직접 `new Image()` 로드
2. URL: `/api/thumbnail?path=${encodeURIComponent(path)}&size=512`
3. `img.onload` → `naturalWidth === 512 && naturalHeight === 512`
4. **pass 기준**: 10개 전부 ok

```javascript
const indices = [0, 50, 200, 500, 999, 1500, 2000, 2500, 2800, 2999];
const promises = indices.map(i => {
    const path = v.currentGridImages[i];
    const url = '/api/thumbnail?path=' + encodeURIComponent(path) + '&size=512';
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => resolve({ ok: img.naturalWidth === 512 });
        img.onerror = () => resolve({ ok: false });
        img.src = url;
    });
});
const results = await Promise.all(promises);
// results.every(r => r.ok)
```

### 36-4. 원본 이미지 API HEAD 확인 (5개)

1. 인덱스 [0, 500, 1500, 2500, 2999]의 원본 이미지 HEAD 요청
2. `fetch('/api/image?path=...', { method: 'HEAD' })` → status 200, content-type image/png
3. **pass 기준**: 5개 전부 200 + image/png

### 36-5. 단일 이미지 순회 (5개)

1. 인덱스 [0, 99, 499, 1499, 2999]의 이미지를 `v.loadImage()` 순차 로드
2. 각 로드 후 `v.currentImage != null`, `canvas.width > 100 && canvas.height > 100`
3. **pass 기준**: 5개 전부 ok

### 36-6. 피라미드 레벨별 HEAD 확인

1. 첫 번째 이미지의 0.2 / 0.5 / 0.7 / 1.0 레벨 HEAD 요청
2. `/api/image?path=...&pyramid_level=${level}` → status 200
3. **pass 기준**: 4 레벨 전부 200

### 36-7. Measure 데이터 무결성

1. 20개 이미지로 `/api/measure-composite-data` 호출 (mode='f', item_key 첫 번째 ftn_key)
2. `data.chips` 배열의 모든 칩: `color.length === 3`, 각 값 0~255, `val != null`
3. `data.canvas.width > 0 && data.canvas.height > 0`
4. `data.chip_rects.length === data.chip_count`
5. **pass 기준**: colorBad === 0, valNull === 0, canvas 유효

```javascript
const { chips, chip_rects, canvas } = data;
let colorOk = 0, colorBad = 0, valOk = 0, valNull = 0;
for (const c of chips) {
    if (c.color?.length === 3 && c.color.every(v => v >= 0 && v <= 255)) colorOk++;
    else colorBad++;
    if (c.val != null && !isNaN(c.val)) valOk++;
    else valNull++;
}
// colorBad === 0 && valNull === 0 && canvas.width > 0
```

### 결과 요약표

| 항목 | 샘플 수 | pass 기준 |
|------|---------|----------|
| 그리드 첫 30개 | 30 | broken === 0 |
| 그리드 끝 30개 | 30 | broken === 0 |
| 썸네일 API | 10 | 전부 512x512 |
| 원본 API HEAD | 5 | 전부 200 + image/png |
| 단일 이미지 순회 | 5 | 전부 canvas 정상 |
| 피라미드 4레벨 | 4 | 전부 200 |
| Measure 칩 색상/값 | 384 | colorBad=0, valNull=0 |

---

## Phase 37: 인덱스 빌드 + 검색 벤치마크 (대용량)

`benchmark_4m` 폴더(400만 더미 파일)를 포함한 대용량 환경에서 인덱스 빌드, 캐시 로드, 검색 성능을 측정합니다.

> **전제**: `D:/project/data/wm-811k/benchmark_4m/` 에 400폴더 × 10000파일 = 400만 더미 파일이 존재해야 합니다.
> 파일명 패턴: `lot_XXXX_step_YYYYY_WZZ_EE_Engineer.png`

### 37-1. 더미 파일 존재 확인

1. `benchmark_4m` 폴더 400개 확인
2. 각 폴더 10000개 파일 확인 (샘플 3개 폴더)
3. **pass 기준**: 400폴더, 각 10000파일

### 37-2. 인덱스 빌드 (cold)

1. 캐시 파일 삭제 (`.file_index_cache.txt`)
2. 서버 시작 → 인덱스 빌드 완료 대기
3. **측정**: 빌드 시간, 총 파일 수
4. **pass 기준**: 빌드 < 10초 (로컬 SSD 기준), 파일 수 > 400만

### 37-3. 빌드 중 서비스 유지 검증

1. 서버 시작 직후 (인덱스 빌드 중) `palette_3k` 그리드 로드
2. **pass 기준**: `v.currentGridImages.length === 3000`, 썸네일 30개 즉시 로드
3. 빌드 중에도 `/api/files`, `/api/thumbnail` 정상 응답

### 37-4. 캐시 로드 벤치마크

1. 인덱스 빌드 완료 후 캐시 파일 크기 확인
2. 캐시 로드 시간 측정
3. **pass 기준**: 캐시 로드 < 5초

### 37-5. 검색 벤치마크

서버 재시작 + 인덱스 빌드 완료 후 실행:

| 검색 모드 | 쿼리 | pass 기준 |
|----------|------|----------|
| 폴더 한정 | `q=ABC123&folder=palette_3k` | < 500ms, 결과 > 0 |
| 전체 단순 | `q=lot_0001&folder=` | < 1초, 결과 > 0 |
| LOT multi | `lot_multi=ABC123,DEF456&folder=palette_3k` | < 500ms |
| AND 검색 | `q=lot_0050 and Engineer&folder=` | < 3초 |

### 37-6. 다중검색 Noise 파싱 + 결과 검증

1. 다중검색 모달에서 noise 포함 6개 LOT 입력:
   ```
   ABC123.J1 04
   DEF456.2\t08
   FEX482.abc W03
   GHJ789 extra_junk
   KHN931.X2\tW05.1
   TMW067.99 0010
   ```
2. **파싱 검증**: 콘솔에서 `LOT 목록 전달: 6개 - abc123,def456,fex482,ghj789,khn931,tmw067` 확인
3. **결과 검증**: `v.currentGridImages.length === 3000`, 6개 LOT 각 500개씩
4. **pass 기준**: noise 전부 제거, 6 LOT 정확 추출, 이미지 정상 표시

### 37-7. 텍스트 검색 UI

1. 검색창에 `ABC123` 입력 → 검색 버튼 클릭
2. **pass 기준**: 그리드에 500개 이미지 표시, 모두 ABC123 LOT

### 결과 요약표

| 항목 | 기준값 |
|------|-------|
| 인덱스 빌드 (500만+ 파일) | < 10초 |
| 캐시 로드 | < 5초 |
| 빌드 중 그리드 로드 | 즉시 (블로킹 없음) |
| 폴더 한정 검색 | < 500ms |
| 전체 검색 | < 1초 |
| 다중검색 noise 파싱 | 6 LOT 정확 추출 |
| 텍스트 검색 | 결과 정확 |
