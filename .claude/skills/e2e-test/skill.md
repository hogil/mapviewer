---
name: e2e-test
description: "L3 Tracker 전체 기능 E2E 테스트 (Playwright 브라우저 자동화). 63개 Phase로 페이지 로드, 그리드, 검색/필터, 색상, 범례, LOT Mode, Class Manager, Composite, Ref Map, Measure, MY LOT, 단일 이미지 모드, Page Manager, Thumbnail Navigator, Minimap, 다중검색, 권한 관리, 컨텍스트 메뉴 복사/다운로드, 키보드 단축키, 그리드 상태 복구 안정성, 그리드↔단일 이미지 전환 스크롤/로딩 안정성, Measure 다중선택 사이드바이사이드, 성능 벤치마크, 이미지 무결성 검증, Measure Map Navigator 전환, Subset Composite Map 검증, Measure 드롭다운 통합+이미지 중복 방지, 다중 Measure 더블클릭 Navigator overlay 타입 보존, Chip Label Explorer CRUD+캐시+속도 검증, Measure 색상 미리보기/적용 회귀, HTTP 캐시 무효화 검증, Composite 색상 매핑/배경 행 제거 검증, Measure 첫 진입 지연/폴더 stale state 회귀, Label Explorer flat-grid 강제 및 positions 없는 unknown/PNF 이미지 즉시 로드 회귀, 검색 첫 실행/다중검색/이벤트루프 블로킹 회귀, 서버 Cold Start 즉시 로딩 속도, 탭 다중 전환 이미지 보존, f/q missing 이미지 그리드 로드 검증, classification 인덱스 즉시 일관성 검증, 썸네일 캐시 삭제 후 첫 unknown 그리드 즉시 로딩 검증, [CRITICAL] Cold Start 3단계 분절 성능 측정(페이지 로드→폴더 확장→그리드 viewport), JS 모듈 그래프/worker 캐시 무효화 검증을 자동 점검한다. '/e2e-test', 'E2E 테스트', '전체 테스트', '기능 테스트 돌려줘' 등의 요청에 반응한다."
argument-hint: [Phase 번호 또는 범위]
---

# L3 Tracker E2E 기능 점검

## 실행 승인 규칙

- 현재 사용자 요청에 E2E 실행 지시가 명시된 경우에만 이 runner와 agent cycle을 실행한다.
- 이전 대화의 E2E 요청은 이후 코드 변경에 대한 지속 승인이 아니다.
- E2E guard를 추가하거나 수정하는 작업과 실제 E2E 실행은 별개다. 실행 요청이 없으면 테스트 파일만 변경하고 미실행으로 보고한다.

## 기능 우선순위와 반복 실행 순서

이번 회귀군은 테스트 수보다 사용자 장애 영향으로 우선순위를 고정한다. P0가 실패하면 P1/P2 결과와 무관하게 원인 분석 후 해당 P0를 다시 통과시킨다.

| 우선순위 | 기능 | 필수 브라우저 증명 |
|---|---|---|
| P0 | 단일 이미지 Measure 단일선택, F/Q stale 응답 차단, 캔버스/네비게이터 동기화 | `scripts/e2e_chunk2.js` `measure-single-consistency` |
| P0 | AAI633/08 SYSTEMATIC 단일보기 raw-map 제거, 본 이미지/오버레이/네비게이터 필터 정합성 | `scripts/e2e_chunk2.js` `systematic-measure-single-lot-wafer` |
| P1 | 시간 정렬, `H%(PA,TD)` root LOT wildcard, 그리드/단일 네비게이션 순서 | `scripts/e2e_chunk1.js` `sort-lot-filter` |
| P1 | Composite/Measure fixed 12-BIN SYSTEMATIC grouping and filtered render | `scripts/e2e_chunk1.js` `systematic-bin-group` |
| P1 | Layout `layout.txt` chip 매칭, Chip Coord/Radious/Shot 순서, Shot 토글/선택 및 shot_id 경계 표시 | `scripts/e2e_chunk2.js` `layout-chip-coordinates` |
| P1 | 선택 Chip/Shot 영역 Composite Map 및 결과 positions 정합성, Shot chip 수/선택영역 crop, 선택 Good/Bad/Yield summary/export, 선택 crop MY LOT/Label 연결 메뉴 | `scripts/e2e_chunk2.js` `selected-region-composite`, `selected-region-export` |
| P1 | 기존 Measure 다중선택/탭 복귀/썸네일 무결성 | `30,33,34,35,39`, `41,42,45,47,48,56` |
| P2 | 전체 63개 Phase와 성능/프로세스 정리 | `run-e2e-playwright.ps1 -Chunk all` |

각 P0/P1 수정 사이클은 코드 정적 검사 → 새 Playwright 세션의 해당 chunk → 실패 로그 원인 수정 → 같은 chunk 재실행 순서로 반복한다. 상태 플래그만 확인하지 말고 실제 bitmap/canvas, visible thumbnail, navigator index를 함께 확인한다.

기본은 로컬 Playwright runner(`scripts/run-e2e-playwright.ps1`)로 L3 Tracker의 모든 주요 기능을 자동 테스트합니다. MCP 브라우저는 최종 E2E 증명 경로가 아니며, 사용자가 명시적으로 MCP를 요구한 경우의 보조 디버깅에만 사용합니다.

## E2E 역할 구성과 실행 게이트

- **결정론적 browser lane**: `scripts/run-e2e-playwright.ps1 -Chunk all -Headless`가 실제 Playwright UI, bitmap, request body, 다운로드, 성능, 프로세스 정리를 수행한다. LLM이 브라우저를 임의로 클릭해 PASS를 만드는 구조가 아니다.
- **Scout**: 저비용 read-only agent 1개가 evidence/log/diff를 읽고 사실, 첫 실패, 누락 검증을 추출한다.
- **Planner**: 상위 모델 3개가 독립적으로 P0/P1 재현·수정 계획을 작성한다.
- **Reviewer/Judge**: 상위 모델 3개가 실제 E2E 결과, output image dimensions, positions, export TSV, UI request body를 각각 점수화하고 토론용 근거를 남긴다.
- **Master**: 상위 모델 3개 슬롯 중 한 모델을 cycle마다 순환 사용해 최종 PASS/FAIL을 판정한다. `E2E exit=0`과 master PASS가 모두 충족되면 hourly cycle을 즉시 중지한다.
- 실행기는 `scripts/e2e-agent-cycle.ps1`, 역할/모델 설정은 `scripts/e2e-agent-config.json`, 결과는 `D:\project\mapviewer\.codex-tmp\e2e-agent-cycles\`에 저장한다. 기본 모델 alias는 scout=`sonnet`, 상위 슬롯=`opus`이며 `E2E_*_MODELS` 환경변수로 교체할 수 있다.
- 순서는 `static -> P0/P1 targeted chunk -> failure triage -> same chunk rerun -> Chunk all -> scout -> planner 3개 -> reviewer 3개 -> rotating master`이다. targeted guard가 실패한 상태로 전체 E2E를 PASS 처리하지 않는다.
- `-Mode hourly-until-clean`은 실패/미판정일 때만 60분 후 새 세션을 시작하고, 이상이 없으면 반복하지 않는다. `-PlanOnly`는 agent 호출과 browser 실행 없이 구성을 검증한다.
- `systematic-bin-group`는 Composite와 Measure 각각에 `285,286,287,288,290,291,300,385,386,388,389,390`만 들어가는지, SYSTEMATIC이 NORMAL/INVALID보다 먼저 표시되는지, 단일/그리드 filtered render URL, 실제 `mode=systematic` API 응답과 matched chip 수를 함께 확인한다. `BIN336` 같은 비계약 숫자는 SYSTEMATIC에 포함되면 안 된다.

## 절대규칙 #-5: 장시간 E2E는 중간 보고 필수

전체 E2E처럼 오래 도는 작업은 실행 중에도 사용자에게 중간 보고를 남긴다. runner 출력만 보고 끝까지 침묵하지 않는다.

중간 보고 기준:
- 시작 직후: 실행 명령, `Chunk`, `Headless` 여부, 새 서버 `BASE_URL`, session/output 경로가 확인되면 보고한다.
- 각 chunk 시작 시: 어떤 chunk/script를 돌리는지와 해당 chunk가 주로 검증하는 기능 범위를 짧게 말한다.
- 각 chunk 종료 시: `CHUNK_SUMMARY` 또는 progress log를 기준으로 pass/fail 개수, 실패 여부, 주요 phase 이름, 핵심 성능 숫자(`loadMs`, `fqLoadMs`, 검색 평균, composite 시간, annotation 평균 등)를 보고한다.
- 성능 지표가 나오면 그 지표가 무엇을 의미하는지 한 줄로 같이 적는다. 특히 `loadMs`와 `total_files`는 작업 시간과 상태값을 분리해서 설명한다.
- 실패/timeout/warning이 나오면 즉시 보고하고, 전체 PASS 여부와 별개로 원인 분석 대상으로 분리한다.
- 최소 30~60초마다 현재 어디까지 진행됐는지, 마지막으로 통과한 phase 또는 대기 중인 작업이 무엇인지 업데이트한다.

## 절대규칙 #-4: E2E 종료 후 최종 보고 생략 금지

E2E 실행이 끝나면 최종 답변에 반드시 "무엇을 어떻게 실행했고, 결과가 무엇이며, 성능은 어땠는지"를 남긴다. 단순히 "통과했습니다" 또는 "끝났습니다"로 끝내면 안 된다.

최소 보고 항목:
- **수행 항목**: 이번 요청에서 실제로 한 일과 검증한 기능을 먼저 적는다. 예: "검색 query 다양화", "100개 LOT/WF 다중검색", "인덱스 재생성/캐시 로드", "chip label overlay", "전체 E2E 재실행", "Git push"처럼 사용자가 어떤 작업이 처리됐는지 바로 알 수 있어야 한다.
- **변경 파일/범위**: 코드나 테스트를 수정했다면 파일명과 변경 목적을 적는다. 수정이 없고 검증만 했다면 "코드 변경 없음, 검증만 수행"이라고 적는다.
- **실행 범위/명령**: `-Chunk all` 또는 특정 chunk/phase, `-Headless` 여부, 사용한 runner 명령.
- **세션 정보**: `SESSION`, `BASE_URL`, `SUMMARY`, `OUTPUT_DIR`, `COLD_START_SUMMARY`가 있으면 경로까지.
- **최종 판정**: `RESULT_SUMMARY status=... pass=... fail=...`, runner exit code, 실패 phase 목록. 실패가 있으면 첫 실패 원인과 다음 조치까지 적는다.
- **프로세스 정리**: `PROCESS_CLEANUP status=PASS/FAIL`, 남은 E2E 서버/브라우저/Node/Python 프로세스 확인 결과.
- **핵심 기능 결과**: 이번 요청과 관련된 주요 phase 이름, 검증한 기능, 결과 개수/이미지 수/그리드 wraps/인덱스 파일 수 등 사용자가 판단할 수 있는 숫자.
- **Phase별 수행/통과 근거**: `e2e-summary.json`의 `records`를 순서대로 읽고 모든 `phase`/`name`/`status`를 빠짐없이 적는다. 각 항목에는 "무엇을 검증했는지"와 통과 근거 수치(count, wraps, broken, timing, 선택 개수, annotation 수 등)를 붙인다. 여러 Phase가 하나의 record로 묶여 있어도 생략하지 않는다.
- **성능 요약**: `COMPOSITE_NUMBA_WARM`, `PERF_SUMMARY`, cold start, `fqLoadMs`, 폴더 loadMs, 검색 평균/표준편차/spread, chip label annotation 평균, composite/measure 생성 시간 등 summary/detail에 있는 실측치를 우선 보고한다.
- **성능 지표 의미 설명**: `fqLoadMs`, `loadMs`, `lookupMs`처럼 이름만으로 오해되는 지표는 무엇을 잰 시간인지, 무엇이 아닌지, PASS 기준과 현재 값을 같이 설명한다. 예: `fqLoadMs`는 Phase `46,52,53,54,55,58,59,61,62,63`에서 unknown 5000장 그리드/FQ-missing/cache/placeholder/asset version 검증을 위해 폴더를 로드한 wall time이지 단일 F/Q 이미지 생성 시간이 아니다. `index loadMs`는 Phase `36,37,38,40`에서 unknown 5000장 그리드 로드와 이미지 무결성/인덱스 ready 확인에 걸린 wall time이지 인덱스 build 시간이 아니다.
- **오해 방지 문장 분리**: `loadMs`와 `total_files`를 한 문장에 붙여 "402만 파일을 1.8초에 스캔"처럼 읽히게 쓰지 않는다. 반드시 아래처럼 분리해서 적는다. "`loadMs=1799ms`: unknown 5000장 그리드를 화면 상태와 DOM까지 로드한 시간. `total_files=4,022,499`: 이미 준비된 인덱스의 전체 파일 수 상태값. 둘은 같은 phase에서 기록됐지만 같은 작업 시간이 아니다."
- **로그 위치**: stdout/stderr 로그, `e2e-summary.json`, `cold-start-summary.json` 위치.
- **미실행/부분 실행 고지**: 전체가 아니라 일부만 돌렸거나, 성능 항목이 없거나, 테스트를 못 돌린 경우 그 사실을 명확히 적는다.

보고는 짧아도 되지만 숫자는 빼지 않는다. Phase가 많으면 전체 Phase 체크리스트를 먼저 적고, 각 Phase의 핵심 숫자를 붙인 뒤 상세 로그 경로를 덧붙인다. 특히 사용자가 검색/인덱스/성능/오버레이를 물은 직후라면 해당 phase detail에서 count, timing 평균, 표준편차, spread를 뽑아 함께 적는다. 성능 경고가 있으면 PASS와 별도로 경고 원인을 분석 대상으로 분리해서 보고한다.

## 절대규칙 #-3: 성능 경고는 원인 분석 대상 — timeout 완화로 덮지 않는다

- Composite Numba warmup, cold start, 검색, 썸네일 생성, 그리드 로딩, Measure/Composite 생성 등에서 느림 또는 timeout warning이 나오면 **timeout을 늘리거나 경고를 무시하는 방식으로 해결했다고 말하지 않는다.**
- E2E 전체가 PASS여도 성능 warning은 별도 분석 대상이다. PASS 요약과 성능 warning 원인 분석을 분리해서 보고한다.
- 먼저 확인할 것: runner 호출 지점, 서버 access/app 로그, endpoint별 elapsed time, 이벤트루프 블로킹 여부, background task 상태, 인덱스/캐시 준비 상태, 첫 요청 lazy import/compile 여부, CPU/IO 포화 여부.
- Composite Numba warmup warning이 나오면 `/api/internal/composite-numba-warmup` 구현, `scripts/run-e2e-playwright.ps1`의 warmup 호출, 서버 시작 직후 background 작업 경합, 실제 Composite E2E의 `detail.compositePerf.numba` 값을 함께 확인한다.
- 원인이 확인되기 전에는 "정책상 경고라 문제 없음", "timeout을 늘리면 됨", "실제 테스트는 PASS라 괜찮음"처럼 결론내리지 않는다.
- timeout 변경은 마지막 수단이다. 변경하려면 먼저 병목 근거와 개선안을 제시하고, 사용자가 명시적으로 동의한 경우에만 한다.

## 절대규칙 #-2: E2E 브라우저는 로컬 Playwright runner 우선 — MCP 브라우저로 최종 증명 금지

- **기본 실행은 반드시 로컬 Playwright runner**(`powershell -ExecutionPolicy Bypass -File scripts/run-e2e-playwright.ps1`)로 한다.
- 사용자가 "내가 보게", "브라우저 띄워서"라고 하면 같은 runner를 **`-Headless` 없이** 실행한다. MCP 브라우저 도구로 대체하지 않는다.
- 사용자가 "서버부터 키고 브라우저 띄워라", "창부터 보이게 해라", "브라우저가 안 뜬다"라고 하면 테스트 분석 전에 반드시 `powershell -ExecutionPolicy Bypass -File scripts/open-e2e-browser.ps1`를 먼저 실행한다. 이 스크립트는 서버를 먼저 시작한 뒤 `npx playwright open --browser=chromium --ignore-https-errors --viewport-size=1920,1080`로 새 로컬 Chromium 창을 열고 최대화한다.
- 사용자가 "브라우저가 안 뜬다"고 하면 `-Headless` 실행은 금지한다. headful runner로 다시 시작하고, 한 Playwright session에 매달리지 말고 새 browser process/context로 재시도한다.
- MCP 브라우저는 모델/도구가 직접 제어하는 원격 브라우저 세션이다. 최종 PASS 증명, 성능 측정, 프로세스 정리 검증에는 사용하지 않는다.
- 로컬 runner는 repo 스크립트가 서버/Python/Node/Chromium 수명주기를 추적하므로, E2E 후 프로세스 정리 검증이 가능하다.
- 이미 열려있는 사용자 브라우저 창을 navigate로 덮어쓰는 행위는 절대 금지한다.
- 테스트 완료 후 runner가 만든 임시 브라우저/서버는 정리되어야 한다. 사용자가 `-KeepServer`를 명시한 경우만 예외다.

## 절대규칙 #-1: E2E 서버는 항상 새 빈 포트로 시작 — 기존 서버 절대 종료 금지, 자기 서버는 정리

- **`start-e2e-server.ps1`는 기존 서버(8443 등)를 절대 종료하지 않는다.**
- 항상 `Get-FreePort`로 사용 중이지 않은 포트를 찾아 새 서버를 그 포트에서 시작한다.
- 스크립트 출력 `READY:<port>`에서 실제 포트 번호를 읽어 `BASE_URL=https://localhost:<port>`로 설정한다.
- `READY:<port>` 직후에는 5초 이하의 짧은 health check(`/api/config`)로 서버가 실제 응답하는지 확인한다.
- READY 직후 서버가 죽었으면 해당 E2E PID/잔여 pid 파일을 정리한 뒤 다음 fresh port에서 새 서버를 시작한다.
- Composite Numba warmup은 `COMPOSITE_USE_NUMBA=1` 서버에서 짧게 시도하되, 빨리 끝나지 않으면 경고를 남기고 브라우저 테스트를 즉시 진행한다. 단, 이 경고를 정상으로 덮지 말고 별도 성능 병목으로 분석한다. warmup 때문에 브라우저 표시를 막지 않는다.
- `run-e2e-playwright.ps1`는 자신이 시작한 E2E 서버 PID를 추적하고, 테스트 종료 후 반드시 종료한다. 사용자가 `-KeepServer`를 명시한 경우만 예외다.
- 기존 사용자 서버를 Kill하여 연결이 끊기는 사고는 절대 금지한다.
- 이 규칙을 위반하여 `Stop-ApiMainProcesses` 또는 기존 서버 종료를 추가하는 행위는 절대 금지한다.

## 절대규칙 #0: 반드시 Playwright 브라우저로 전체 UI 검증 — 예외 없음

- **모든 Phase는 반드시 Playwright 기반 브라우저 자동화로만 검증한다.** 기본 허용 경로는 `scripts/run-e2e-playwright.ps1`이다.
- **사용자가 "브라우저가 안 뜬다" 또는 "먼저 창부터 띄워라"라고 하면, 분석 전에 반드시 `powershell -ExecutionPolicy Bypass -File scripts/open-e2e-browser.ps1`를 먼저 실행해 서버가 켜진 뒤 `npx playwright open`으로 실제 브라우저 창이 열린 것을 확인한다.** 이 경우 MCP 브라우저만으로 시작하는 것은 금지한다.
- API 레벨(curl, urllib, fetch 등)만으로 테스트를 대체하는 것은 절대 금지한다.
- "API로 검증 가능", "브라우저 없이도 확인 가능" 등의 이유로 Playwright를 생략하는 것은 허용하지 않는다.
- 한 개 Phase라도 Playwright 없이 API만으로 처리하면 전체 테스트를 FAIL로 간주한다.
- **기본 실행 경로는 `powershell -ExecutionPolicy Bypass -File scripts/run-e2e-playwright.ps1` 이다.**
- 이 runner는 **질문/실행 1회당 새 Playwright 세션(`E2E_SESSION_ID`)**을 만들고, chunk마다 브라우저를 하나씩 띄워 이전 질문의 쿠키/캐시/창 상태를 재사용하지 않는다.
- headful 실행에서 브라우저 창 검증이 실패하면 `E2E_BROWSER_SESSION_ATTEMPTS=3` 기준으로 새 Playwright browser process/context를 다시 띄운다. progress log의 `[BROWSER] launch attempt=` 기록으로 확인한다.

## 절대규칙 #0-1: 상태 플래그만으로 PASS 판정 금지 — 실제 화면 + visible 그리드로 검증

- `gridMode === true`, `viewMode === null`, `selectedImages.length > 0` 같은 **상태값만으로 PASS 판정하는 행위는 절대 금지**한다.
- 특히 그리드/단일 이미지 전환, ESC 복귀, Ctrl 다중선택, LOT Mode, Label Explorer, Composite/Measure 복귀 검증에서는 **실제 화면이 비어 있지 않은지**를 반드시 본다.
- 아래 조건을 만족해야만 "그리드 정상 표시"로 판정한다.
  - `.grid-scroll-wrapper`가 `display:none`이 아님
  - `#image-grid .grid-thumb-wrap` 중 **실제로 보이는 항목 수**가 1개 이상
  - 첫 번째 visible `.grid-thumb-wrap`의 `getBoundingClientRect().width > 0` 그리고 `height > 0`
  - 썸네일 `img.complete && img.naturalWidth > 0` 또는 동일 수준의 실제 렌더 확인
  - 최종적으로 **스크린샷에서 검은 화면이 아니라 썸네일/그리드 셀이 보임**
- `LOT Mode`에서는 특히 `#image-grid`만 보이고 `.grid-scroll-wrapper`가 숨겨진 상태를 버그로 본다. 이 경우 `gridMode=true`라도 FAIL이다.
- 단일 이미지에서 그리드 복귀 검증 시에는 다음을 최소 시나리오로 포함한다.
  - 이미지 1개 클릭 → 단일 보기 스크린샷
  - `Escape` 또는 실제 복귀 동작 → 1장 그리드 스크린샷
  - 같은 상태에서 `Ctrl+클릭`으로 2번째 이미지 추가 → 2장 그리드 스크린샷
- 결과 보고에는 가능하면 상태값뿐 아니라 아래와 같은 실측값을 같이 남긴다.
  - `visibleWraps`
  - 첫 visible wrap의 `width`, `height`
  - `.grid-scroll-wrapper`의 `display`, `width`, `height`
  - 캡처 파일 경로

### Fresh Boot 정식 E2E 회귀 기록

- `scripts/e2e_chunk1.js` phase `0`은 첫 페이지 접속 직후 `window.viewer`와 `window.__l3FullViewerReady`만 보지 않는다. `boot-explorer.js`의 lazy `main.js` import 상태(`window.__l3MainImportState`, `window.__l3MainImportError`)와 `window.__l3FullViewerError`를 결과 detail에 남겨야 한다. 이 검증은 `-WithSmoke` 없이 실행되는 정식 전체 E2E 경로에 포함되어야 한다.
- `unknown` 폴더 검증은 `loadImagesInFolderAndShowGrid('unknown')` 단독 호출로 하면 안 된다. `unknown`의 실제 이미지는 recursive subfolder에 있으므로 chunk boot와 같이 `selectAllFolderFiles('unknown')` 후 `showGrid(selectedImages)`를 사용하고, `gridCount=5000`, `.grid-thumb-wrap=5000`, visible loaded thumbnail `>0`을 확인한다.
- `js/main.js`의 readiness contract는 `new WaferMapViewer()` 성공 후에만 `window.__l3FullViewerReady=true`다. ready flag를 먼저 올려 constructor/import 실패를 숨기면 정식 fresh boot E2E가 잘못된 신호를 본다.
- 2026-06-08 formal E2E baseline은 `docs/PERFORMANCE.md`에 기록된 session `20260608-075006-6b0cd897` 값이다. Fresh boot 성능을 비교할 때는 `domLoadedMs`, `viewerReadyMs`, `explorerReadyMs`, `viewerReadyMs - domLoadedMs`, 그리고 `gridCount/wraps/loadedVisible`을 같이 본다.

## 절대규칙 #0-2: 탭 상태 보존 회귀 테스트는 grid/detail을 모두 만든 뒤 왕복 검증

- wafer, measure, composite, label, mylot 각각에서 **grid 탭과 detail/single 탭을 모두 만든다**.
- 최소 10개 탭 시나리오를 유지한다: `wafer0`, `wafer1`, `mea0`, `mea1`, `com0`, `com1`, `label0`, `label1`, `mylot0`, `mylot1`.
- 각 grid 탭은 다음을 캡처하고, 다른 role 탭과 single 탭을 왕복한 뒤 같은 값인지 확인한다.
  - `currentGridImages.length`, `selectedImages.length`
  - `gridSelectedIdxs`
  - `.grid-scroll-wrapper.scrollTop`
  - Wafer Map Explorer의 `selectedFolders` / 선택 폴더 하이라이트
  - Label Explorer의 `selectedClasses`
  - Measure의 `overlayMode`, `_measureCheckedItems`, `_gridMeasureMap`
- 각 detail/single 탭은 `viewMode === 'gridImage'` 또는 `viewMode === 'single'`, canvas 표시, `selectedImagePath`가 보존되는지 확인한다.
- **파일 탐색기 직접 이미지 클릭 회귀**를 반드시 포함한다: `unknown` 5000장 그리드에서 Wafer Map Explorer 파일 1개 클릭 → single 보기 → ESC/복귀 후 `currentGridImages.length === 5000`, `.grid-thumb-wrap === 5000`이어야 한다. `5000 -> 1`이면 FAIL.
- 단일 label detail만 따로 건드리는 방식으로 PASS 처리하지 않는다. label은 label grid/detail 보존 검증에 포함하되, wafer/composite/measure/mylot과 같은 cross-role 왕복 안에서 같이 검증한다.

## 절대규칙 #0-3: E2E 프로세스 정리 검증

- 전체 실행은 서버 1개를 시작하고 chunk를 순서대로 실행한다. 각 chunk는 Node 1개와 Chromium 1개를 사용한다.
- E2E runner는 `COMPOSITE_USE_NUMBA=1` 상태의 서버를 시작하고, 실제 서버 프로세스 안에서 Composite Numba warmup을 수행한다.
- 서버가 READY 후 죽었으면 즉시 실패 서버를 버리고 다음 fresh port로 재시도한다.
- Composite Numba warmup이 짧은 timeout 안에 응답하지 않아도 서버가 살아 있으면 테스트를 계속한다. 단, timeout 완화로 해결하지 말고 원인 분석을 남긴다. Numba 사용 여부와 실제 성능은 Composite E2E 결과에서 검증한다.
- 테스트 종료 후 `api.main`/uvicorn Python, Playwright Chromium, E2E Node, E2E PID 파일이 남지 않아야 한다.
- 실패 로그가 `[FAIL]` 또는 `"status": "FAIL"`을 포함하면 runner exit code는 반드시 non-zero여야 한다.
- 테스트 결과 보고 전 아래를 확인한다.
  - E2E 서버 포트 listener 없음
  - `.codex-tmp/e2e-server-*.pid` 없음
  - repo 경로를 command line에 포함한 E2E Python/Node/Chromium 프로세스 없음

## 절대규칙: 기본 전체 실행

- **인자 없이 `/e2e-test` 실행 시 Phase 1~63 전체를 실행한다.**
- 특정 Phase만 실행하려면 `/e2e-test 3,9,12` 또는 `/e2e-test 33-50`처럼 명시적으로 지정해야 한다.
- "전체 테스트", "E2E 테스트" 등 범위 미지정 요청은 전체 실행으로 간주한다.
- Phase를 건너뛰거나 일부만 실행하는 것은 사용자가 명시적으로 요청한 경우에만 허용된다.
- 별도 지령이 없으면 단 한 개 Phase도 skip하지 않고 전부 실행한다.
로컬 Playwright `page.evaluate`와 screenshot으로 실제 UI를 확인한다.

## 절대규칙: Non-blocking Server Startup

서버 시작 관련 코드를 수정할 때 반드시 준수:
- `lifespan`의 `yield` 전에는 최소한의 필수 초기화만 수행 (labels 로드, 디렉토리 생성)
- 인덱스 로드/빌드, `_build_lookup_indices`, `_save_cache`, `__pycache__` 정리, composite cleanup 등 무거운 작업은 반드시 `asyncio.create_task`로 백그라운드 실행
- CPU/IO 집약적 작업은 반드시 `loop.run_in_executor`로 실행 (이벤트 루프 블로킹 금지)
- 서버는 인덱스 완료 여부와 무관하게 즉시 웹 요청 처리 가능해야 함

## 절대규칙: Composite/Measure 웨이퍼 원형 금지

- **chip과 배경(background) 사이에 색을 삽입하여 웨이퍼 원형을 만드는 행위는 절대 금지한다.**
- chip 바깥 영역은 반드시 배경색(index 8)으로만 채운다.
- Composite Map, Measure Map, BIN Map 등 모든 맵 생성/렌더링 시 이 규칙을 준수한다.
- chip 테두리(Normal border, index 10)는 chip 내부 경계이므로 이 규칙과 무관하다.
- E2E 테스트에서 Composite/Measure 맵 생성 후 chip 외곽에 비배경색이 있으면 FAIL로 판정한다.

## 절대규칙: Composite context submenu orphan panel 금지

- Composite 생성 직후 `검색...` / `이미지를 선택하세요`가 들어 있는 작은 context chooser panel이 보이면 FAIL이다. 잠깐 보였다 사라지는 것도 정상 처리하지 않는다.
- 이 현상은 예외 처리나 timeout으로 덮지 않는다. 먼저 `#grid-context-menu`, `#context-mc-submenu`, `#context-mea-submenu`의 lifecycle과 `_resetContextCompositeChecks()`, `_openMcContextSubmenu()`, `_openMeaContextSubmenu()`, `_closeCompositeMeasureFloatingPanels()`를 확인한다.
- 정상 구현은 context submenu를 `#grid-context-menu`가 보이는 동안에만 열고, 닫을 때는 `_hideGridContextSubmenuPanel()`로 원래 부모/위치/동적 버튼/빌드 플래그를 정리한다.
- Composite 생성 시작 시 닫힌 `#context-mc-submenu`에 `_resetContextSubmenuPanel(..., '이미지를 선택하세요')`를 호출하면 안 된다. 선택 상태만 clear하고 hidden submenu 내용을 다시 렌더하지 않는다.
- E2E는 app 예외처리가 아니라 회귀 검출로 `MutationObserver`를 사용할 수 있다. `scripts/e2e_chunk1.js`의 context-menu 버튼 경로는 `orphanContextChooserEvents.length === 0`, `scripts/e2e_chunk3.js`의 직접 10장 composite 경로는 `directCompositeOrphanContextChooserEvents.length === 0`이어야 한다.

## 절대규칙: Context menu copy/download/MY LOT 실동작 검증

- Grid context menu의 복사/다운로드/MY LOT 항목은 라벨이나 상태 플래그만 보지 말고 실제 우클릭 메뉴 클릭으로 검증한다.
- `ContextMenuManager`와 `MyLotModal`은 lazy 초기화될 수 있으므로, 앱 코드는 context handler 안에서 `_getContextMenuManager()` / `_getMyLotModal()`을 호출해 첫 사용도 동작해야 한다.
- Wafer 정보 TSV 복사는 `bucket` 계열 header가 없어야 하며, `wafer` 값은 `W` prefix 없이 복사되어야 한다.
- E2E guard는 `scripts/e2e_chunk1.js` record `grid-context-actions`다. 최소 검증: `선택 wafer 리스트 복사(YMS 방식)` 라벨, YMS text clipboard rows, wafer info table without bucket columns, `선택 파일 다운로드`, `선택한 이미지 복사 (Legend 포함)`, `MY LOT에 추가`.
- Single image context menu는 실제 보이는 `#single-context-menu` 또는 chip 우클릭에서 생성되는 `#chip-context-menu`를 대상으로 검증한다. Record `13-19`는 `파일명복사 (YMS)`, `이미지 복사`, `캔버스 전체 복사`, `원본 다운로드`, `MY LOT 추가`를 모두 실제 메뉴 클릭으로 검증해야 한다.

## 절대규칙: Multi LOT 검색 입력 정규화

- LOT multi-search는 파일 경로, 파일명, 일반 LOT 목록을 붙여 넣어도 `/api/search`의 `lot_multi`에는 filename basename의 `_` index 0 LOT 토큰만 전달해야 한다.
- `/` 또는 `\`는 경로 구분자로 보존한 뒤 basename 추출에만 사용한다. 공백/탭은 한 줄/청크 안의 컬럼 구분으로만 보고 index 0만 LOT 후보로 사용한다. `ABC123 05`에서 `05`나 ignored column이 `lot_multi`로 들어가면 FAIL이다.
- UI 검색은 폴더 선택 그리드 상태여도 `folder` 파라미터를 보내면 안 된다.
- 검색 0건일 때 기존 그리드를 그대로 두면 이전 폴더 이미지가 검색 결과처럼 보이므로 FAIL이다. `currentGridImages.length === 0`, visible `.grid-thumb-wrap === 0`, 빈 결과 메시지가 보여야 한다.
- E2E guard는 `scripts/e2e_chunk2.js` record `21,24,25,26,27`이다. 실제 `fetch('/api/search?...')` URL을 캡처해 mixed path/filename/LOT 입력의 `lot_multi` 값이 기대 LOT 배열과 정확히 일치하고, UI 검색 URL에 `folder`가 없으며, 일반/다중/WF no-result가 빈 그리드로 표시되는지 확인해야 한다. 서버 직접 호출도 `lot_multi=LOT1 LOT2`에서 두 번째 whitespace 토큰을 무시하는지 확인해야 한다.

## 절대규칙: 검색 결과 그리드 키보드 선택 회귀 금지

- 검색 텍스트창(`#file-search`)에 입력하고 검색 버튼/Enter로 결과 그리드가 뜨면, 키보드 포커스는 그리드 단축키가 동작 가능한 상태로 넘어가야 한다.
- 검색 성공 직후 `Ctrl+A`는 검색창 텍스트 선택이 아니라 현재 결과 그리드의 모든 이미지 선택이어야 한다. `gridSelectedIdxs.length`, visible `.grid-thumb-wrap.selected` 수, `currentGridImages.length`가 모두 일치해야 한다.
- 검색 결과 그리드에서 `Ctrl+클릭`은 선택 토글/추가, `Shift+클릭`은 anchor부터 범위 선택을 실제 DOM selected class와 상태 배열 양쪽으로 검증한다.
- E2E guard는 `scripts/e2e_chunk2.js` record `21,24,25,26,27`이다. 단순 상태값만 보지 말고 실제 `page.keyboard.press('Control+A')`, `Ctrl+click`, `Shift+click`을 수행한 뒤 화면 selection class와 상태 배열을 같이 비교한다.

## 절대규칙: MY LOT 그룹/붙여넣기/미리보기/그리드/파일 복사 전수 검증

- MY LOT은 LOT 모드와 Wafer 모드를 모두 검증한다. 새 그룹 생성, 기존 그룹 선택, 붙여넣기 행 생성, 검색 결과 수, preview path, 저장 후 `/api/my-lot/entries`, 실제 `my-lot/<LoginId>/<mode>/<group>/...` 파일 존재, positions 복사까지 확인한다.
- 붙여넣기 검색은 UI 검색과 동일하게 전역 검색이어야 하며 `/api/search` URL에 `folder` 파라미터가 있으면 FAIL이다. 기존 폴더 선택/검색 상태가 MY LOT paste lookup에 섞이면 안 된다.
- 저장 후 `보기`/`선택 Grid 보기`는 상태 플래그만 보지 말고 실제 그리드 wraps, visible thumbnail load, LOT header 수, `currentGridImages`의 `my-lot/...` prefix를 확인한다.
- 그룹 삭제 후 다시 하면 정상처럼 보이는 증상은 기존 그룹 상태를 지우는 workaround로 처리하지 않는다. 같은 그룹에 붙여넣고 저장해도 preview와 실제 이미지 복사가 정상이어야 한다.
- E2E guard는 `scripts/e2e_chunk3.js` record `mylot-wafer30-lot10-perf`다. LOT 10개/wafer 30개 paste-save-grid와 copied positions count, paste search URL의 `folder === null`, entries의 image path/file count를 모두 요구한다.

## 절대규칙: Global logical search는 basic-index 상태에서도 파일명 필드를 찾아야 함

- Cold/basic cache load 직후에는 full token index가 아직 비어 있고 token0/token2 index만 있을 수 있다. 이 상태에서도 UI 전역 검색은 `folder` 파라미터 없이 `unknown` 실제 파일명 기반 논리 검색을 통과해야 한다.
- `bintype AND _wafer_`, status/prefix OR, prefix NOT LOT 같은 Phase `3v` 시나리오는 API `folder=unknown` 경로와 UI global 경로가 모두 non-empty `unknown/` 결과를 내야 한다.
- 회귀가 나면 timeout 완화가 아니라 `api/index_service.py::_evaluate_logical_query()`의 token0/token2 fast path와 full filename fallback, `js/main.js::getSearchFolderParam()`의 stale folder scope 노출 여부를 먼저 확인한다.

## 절대규칙: Wafer Map Explorer 스크롤바/폴더 선택 회귀 금지

- 폴더 선택으로 만든 grid 또는 gridImage single 상태에서 Wafer Map Explorer의 스크롤바를 드래그해도 Explorer rectangle selection이 시작되면 안 된다.
- 스크롤바 드래그 뒤 `selectedFolders`, folder DOM highlight, `currentGridImages.length`, visible grid/canvas, `selectedImagePath`가 바뀌면 FAIL이다.
- 폴더-origin `gridImage` single view에서는 현재 파일 링크 하이라이트가 폴더 선택을 대체하면 안 된다. 파일 하이라이트가 생기거나 폴더 하이라이트가 사라지면 FAIL이다.
- E2E guard는 `scripts/e2e_chunk2.js`의 `22,23,28,29` record에 포함한다.

## 절대규칙: Label Explorer CRUD와 열린 폴더 리스트 보존

- wafer와 chip 모두 Class Manager의 class add, multi-add, delete, multi-select delete를 실제 UI 버튼과 `/api/classes` 최신 목록으로 검증한다.
- Class Manager rename은 prompt 확인 뒤 새로고침 없이 Class Manager와 Label Explorer 모두에서 old class가 사라지고 new class가 즉시 보여야 한다.
- Chip/Wafer class 목록과 Label Explorer는 mode별 캐시를 섞으면 안 된다. Chip class 추가 직후 새로고침이나 wafer/chip 탭 재선택 없이 `classMode === 'chip'`, Class Manager, Label Explorer가 모두 chip class 목록을 보여야 한다.
- Label Explorer는 label add, label 단일 delete, label 다중선택 delete, class folder 선택 delete, folder 다중선택 image grid, 여러 folder image grid, grid에서 1개 detail view까지 포함한다.
- 특정 class folder 파일 리스트가 열린 상태에서 label add/delete를 하면 폴더는 계속 열려 있어야 하며 `button.label-img-name` sample 행만 증가/감소해야 한다. 상태 플래그만 보지 말고 실제 DOM count와 API file count를 같이 확인한다.
- Chip label 저장 직후에는 Chip Labels 체크박스나 class pill을 다시 토글하지 않아도 새 class pill이 active이고 overlay canvas 내부 alpha가 즉시 표시되어야 한다.
- Chip을 추가로 선택하거나 선택 해제해도 사용자가 켜둔 Chip Labels active class set을 자동으로 좁히거나 초기화하면 안 된다.
- Wafer label 등록 파일은 corresponding positions.json을 classification copy 경로에도 가져야 한다. Label Explorer에서 해당 wafer label copy를 열면 chip positions가 로드되고, 그 chip들을 선택해 chip label로 저장할 수 있어야 한다.
- E2E guard는 chip은 `scripts/e2e_chunk1.js`의 `chip-label-crud-ui`, wafer는 `scripts/e2e_chunk3.js`의 `label-wafer-crud` record다. 열린 폴더 add는 `2 -> 4`, 단일/다중/folder delete는 `1/2 -> 0`과 `open === true`를 요구한다.

## 절대규칙: Positions 파일 전체 스캔 금지

- **POSITIONS_ROOT에서 `rglob`, `iterdir`, `os.walk` 등으로 전체 디렉토리를 재귀/순회 검색하는 행위는 절대 금지한다.**
- positions 파일은 이미지 경로와 동일한 상대 경로(`POSITIONS_ROOT/제품폴더/stem.json`)에서만 조회한다.
- 해당 경로에 없으면 추가 검색 없이 즉시 404를 반환한다 — 다른 폴더를 뒤지지 않는다.
- classification, my-lot 등 어떤 경로든 동일하게 적용: 직접 경로에 없으면 없는 것이다.
- `_candidate_positions_paths()`는 trimmed 경로 + 레거시 경로 + classification 복사 경로 최대 3개만 `exists()` 체크한다.
- `get_chip_positions()`에서 classification 분기를 만들어 별도 스캔하는 것도 금지 — `_resolve_positions_path()` 한 줄로 통일한다.
- 이 규칙 위반 시 async 이벤트 루프를 블로킹하여 모든 HTTP 요청이 수 초간 pending되는 심각한 성능 문제를 유발한다.

## 절대규칙: 하드링크(os.link) 절대 금지 — 반드시 파일 복사

- 프로젝트 전체에서 `os.link()`, `os.symlink()` 사용은 절대 금지한다.
- classification, my-lot, 썸네일 등 모든 파일 배치는 `shutil.copy2()`로 실제 복사한다.
- E2E 테스트에서 classification 폴더의 파일이 원본과 독립적인 복사본인지 검증한다.
- 코드에 `os.link`를 도입하는 변경은 절대 금지한다.

## 절대규칙: batch / benchmark_4m 폴더는 더미 파일 — 이미지 로드 금지

- `wm-811k/batch/` 하위의 모든 파일은 **파일 인덱스 성능 테스트용 0바이트 더미 파일**이다.
- `wm-811k/benchmark_4m/` 하위의 모든 파일도 **파일 인덱스/검색 성능 테스트용 0바이트 더미 파일**이다.
- `benchmark_4m`의 기대 구조는 400개 lot 폴더 × 10000개 PNG 이름 빈 파일 = 400만 파일이다.
- 실제 서버의 수백만 개 파일 수를 재현하기 위한 것이므로, 유효한 이미지 데이터가 아니다.
- E2E 테스트에서 batch / benchmark_4m 폴더 파일을 이미지 로드/썸네일 생성/렌더링 대상으로 사용하지 않는다.
- 단, 인덱스 빌드/캐시 로드/검색 성능 E2E에서는 `benchmark_4m`를 의도적으로 포함해 대용량 환경을 재현할 수 있다.
- batch / benchmark_4m 경로에서 pyvips/PIL 에러가 발생해도 정상이다 — 버그가 아니므로 수정하지 않는다.

## 절대규칙: Playwright 브라우저 실행 방식

- 기본은 repo의 로컬 Playwright 스크립트가 Chromium을 직접 띄우는 방식이다.
- 사용자가 브라우저 창부터 보기를 요구하면 기본 수동 가시화 경로는 `powershell -ExecutionPolicy Bypass -File scripts/open-e2e-browser.ps1`이다. 이 스크립트는 `start-e2e-server.ps1`로 서버를 먼저 띄우고, 그 다음 `npx playwright open`으로 새 브라우저를 열며, 창을 1920×1080 기준으로 최대화한다.
- headless 전체 검증: `powershell -ExecutionPolicy Bypass -File scripts/run-e2e-playwright.ps1 -Chunk all -Headless`
- 사용자가 보는 검증: `powershell -ExecutionPolicy Bypass -File scripts/run-e2e-playwright.ps1 -Chunk 3`처럼 `-Headless` 없이 실행한다.
- 사용자가 브라우저가 보이지 않는다고 말한 직후의 재검증은 반드시 `-Headless` 없이 실행한다. runner가 headful 창을 `normal -> maximized`로 올리고, 실패 시 새 Playwright session으로 최대 3회 재시도한다.
- MCP 브라우저는 모델에게 제공되는 별도 원격 제어 브라우저 도구다. 사용자에게 "내 로컬에서 보이는 E2E"를 증명할 때는 MCP가 아니라 로컬 Playwright runner를 사용한다.
- 로컬 runner가 직접 만든 임시 브라우저/탭만 정리할 수 있다. 사용자 브라우저나 별도 작업 창은 건드리지 않는다.

## 사전 조건 (자동 설정)

테스트 실행 전에 아래 단계를 **순서대로** 자동 수행합니다. 이미 준비된 항목은 건너뜁니다.

> **대전제: 썸네일 캐시 삭제 후 서버 시작**
> 이미지 로드 시간 측정의 정확성을 위해 **서버 시작 전 썸네일 캐시 폴더를 삭제**한다.
> ```bash
> rm -rf "${PROJECT_ROOT}/thumbnails"
> ```
> - `PROJECT_ROOT`는 `IMAGES_ROOT` 또는 `/appdata/appuser/images` (환경에 따라 다름)
> - Windows 개발: `rm -rf D:/project/data/wm-811k/thumbnails`
> - 이 규칙을 위반하면 캐시 히트로 인해 로드 시간이 비정상적으로 빠르게 측정됨
> - 서버 시작 후 첫 요청에서 썸네일이 새로 생성되므로 cold start 성능을 정확히 측정 가능

> **필수**: 브라우저는 **항상 1920×1080 최대화** 상태로 동작해야 한다. 모든 Phase에서 UI 요소가 뷰포트 안에 보여야 한다.
> - 로컬 Playwright runner는 컨텍스트/viewport를 1920×1080 기준으로 생성해야 한다.
> - 수동 MCP 디버깅을 명시적으로 하는 경우에만 페이지 접속 직후 `browser_resize(1920, 1080)`도 실행한다.
> - 페이지 새로고침이나 네비게이션 후에도 뷰포트 크기를 재확인한다.

### Step 0-1: 로컬 Playwright runner 확인
1. `node --check scripts/e2e_chunk*.js`로 테스트 스크립트 문법을 먼저 확인한다.
2. 로컬 Playwright 브라우저 설치가 없으면 `npx playwright install chromium`을 실행한다.
3. 브라우저가 보여야 하는 요청이면 `-Headless`를 빼고 runner를 실행한다.
4. headful인데 창이 안 뜨면 같은 세션을 기다리지 말고 새 Playwright browser process/context로 재시도한다. runner의 기본 headful 재시도 횟수는 3회다.
5. MCP 브라우저는 이 단계에서 사용하지 않는다. MCP는 사용자가 명시적으로 "MCP로 봐라"라고 한 경우의 보조 디버깅만 허용한다.

### Step 0-2: 서버 시작 (원샷 스크립트)

**반드시 아래 순서를 정확히 따른다. 서버 접속 확인 전에 테스트를 시작하지 않는다.**

1. **원샷 서버 시작** (프로세스 종료 → free port 확보 → 시작 → TCP listen 확인):
   - **Windows 로컬**
     ```powershell
     powershell -ExecutionPolicy Bypass -File scripts/start-e2e-server.ps1 8443
     ```
   - **bash 스크립트가 실제로 존재하는 Unix/Linux 환경에서만**
     ```bash
     bash scripts/start-e2e-server.sh 8443
     ```
   - 출력이 `READY:<port>`이면 → `BASE_URL=https://localhost:<port>`
   - 출력이 `FAIL`이면 → 사용자에게 안내 후 중단

2. **브라우저 접속 확인** (로컬 Playwright page로 실제 페이지 로드):
   - 타이틀 "Wafer Map Viewer" 확인
   - 폴더 목록 렌더링 확인 (3초 대기)
   - **실패 시**: 새 free port로 원샷 서버 시작을 한 번만 재시도

3. **절대 금지**: 서버 접속 + 페이지 타이틀 확인 없이 테스트 Phase 진입하지 않는다

### Step 0-2a: 사용자가 창을 먼저 보겠다고 한 경우

아래 한 줄을 먼저 실행한다. 이 방식이 기본 수동 가시화 경로이며 MCP 브라우저를 사용하지 않는다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/open-e2e-browser.ps1
```

- 내부 순서: `start-e2e-server.ps1` → `/api/config` 짧은 확인 → `npx playwright open --browser=chromium --ignore-https-errors --viewport-size=1920,1080 <BASE_URL>` → Windows 창 최대화.
- 출력의 `BASE_URL`, `SERVER_PID`, `PLAYWRIGHT_OPEN_PID`, `WINDOW_MAXIMIZED`를 확인한다.
- 이 단계는 사용자에게 실제 창을 즉시 보여주는 용도다. 자동 PASS/FAIL 판정은 이후 `run-e2e-playwright.ps1` headful/headless 실행 결과로 한다.

### Step 0-3: 테스트 데이터 확인
- 테스트 데이터 폴더: `unknown` (실제 failbit map 기준 폴더)
- 전체 E2E runner의 폴더 기반 UI 검증은 예외 없이 `unknown` 폴더를 사용한다. `unknown` 외 레거시/합성 폴더는 사용자가 명시적으로 해당 폴더 검증을 요청한 경우에만 별도 테스트로 사용한다.
- **`unknown` 폴더는 failbit/bin/measure/composite 시각 검증의 기본 기준이다.** `unknown` 루트는 하위 패턴 폴더를 포함하므로 E2E에서는 일반 `/api/files` 단일 depth가 아니라 실제 UI의 Ctrl+폴더 선택 경로처럼 재귀 스캔(`/api/files/recursive`)으로 이미지를 로드해야 한다.
- 그리드 선택 → 단일 이미지 보기, reference map, label modal, composite, measure, MyLot, 성능/캐시 검증은 기본적으로 `unknown` 폴더 이미지를 사용한다.
- 전역 검색 검증은 `folder=`를 명시해 ROOT 전체 검색으로 실행하고, `unknown` LOT 검색 결과가 `unknown/...` 이미지로 반환되는지 확인한다. 이 검증은 `folder=unknown` 같은 폴더 범위 제한 검색으로 대체하지 않는다.
- 서버 접속 후 파일 탐색기에 위 폴더가 표시되는지 확인 (없으면 경고 후 계속 진행)

### 테스트 데이터 제약 사항 (절대 위반 금지)

1. **원본 이미지 파일 절대 수정 금지**: `wm-811k/` 하위의 PNG 파일을 E2E 테스트 중 변경, 삭제, 덮어쓰기하지 않는다.
   이미지 재생성은 `scripts/refresh_failbit_local_maps.py`로만 수행한다.

2. **chip 영역에 원형 마스크 절대 금지**: chip은 positions JSON의 `rect` (직사각형) 그대로 렌더링한다.
   chip과 배경 사이에 동그라미, 원형 클리핑, 마스크 영역을 만들지 않는다.
   chip 테두리는 항상 직사각형 1px(×scale) border이다.

3. **테스트 이미지 규격**:
   - 해상도: 최소 6000×6000 pixels (현재 6912×6912, scale=3)
   - unknown: 파일명대로 5~30MB (PNG padding chunk)
   - Grade: 0~7 각각 chip 전체의 5%+ 점유, 각 chip 내부 pixel의 95%+ 단일 grade
   - BIN: 285~291 + Normal + Invalid 등 다양한 BIN이 이미지마다 존재
   - chip 테두리: BIN에 따른 indexed-color index (Normal=10, Invalid=11, BIN별 12~23)

### Positions 파일 양식 (compact_array 포맷)

positions 파일은 `{POSITIONS_ROOT}/{폴더}/{이미지stem}.json`에 위치한다.
`/api/chip-positions` API가 이 파일을 읽어 브라우저에 전달한다.

```json
{
  "bucket_b_key": "20260122/wafer_unknown_PE_Engineer.gz",
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
| unknown | 3000 | 384 | 500 | 500 | ~1.9MB |
| unknown | 6 | 812 | 500 | 500 | ~4MB |

> **참고**: 이후 모든 Phase에서 `https://localhost/` 대신 `BASE_URL`을 사용합니다.

## 테스트 실행 방법

각 Phase를 로컬 Playwright runner에서 순서대로 실행합니다.
- 각 단계에서 결과 객체를 반환받아 pass/fail 판정
- 실패 시 스크린샷 촬영 후 원인 분석
- alert/confirm 다이얼로그는 Playwright dialog handler로 처리
- Phase 끝마다 정리(cleanup)하여 다음 Phase에 영향 없도록

## 중복 정리 및 권위 기준

같은 주제를 여러 Phase가 다루더라도 역할이 다르다. 아래 기준으로 읽고 실행한다.

| 주제 | 권위 기준 Phase | 보조/레거시 Phase | 정리 원칙 |
|------|-----------------|-------------------|-----------|
| Reset / 선택 해제 / 복귀 안정성 | 상단 `Reset / 선택 해제 평가 방법`, Phase 28, Phase 29 | Phase 3 일부 필터 시나리오 | 선택/해제는 "현재 보이는 subset"이 아니라 원본 폴더 집합 기준으로 평가한다 |
| HTTP 캐시 / 정적 자산 재검증 | Phase 58, Phase 63 | Phase 46 | Phase 46은 API/thumbnail/image 계열 broad header 확인, Phase 58은 JS/CSS ETag, Phase 63은 모듈 그래프/worker 버전 전파 전담 |
| Cold Start / 첫 로드 성능 | Phase 61, Phase 62 | Phase 52, Phase 36 일부 cold 항목 | Phase 52는 빠른 smoke check, 서버/브라우저 캐시 완전 초기화 후 권위 벤치는 반드시 Phase 61·62를 사용 |
| 검색 기능 / 성능 | Phase 50, Phase 57, Phase 59 | Phase 38, Phase 51 | 검색 정확도는 Phase 50·51, WF UI 흐름은 Phase 57, latency 회귀는 Phase 59로 분리해 읽는다 |
| classification / Explorer 상태 일관성 | Phase 21, Phase 55, Phase 60 | Phase 43, Phase 44 | 탭 상태, Explorer 하이라이트, 인덱스 rename/delete 반영은 서로 다른 회귀군으로 구분한다 |

## 공통 캐시 검증 규칙

- 캐시 관련 Phase를 실행할 때는 **새 브라우저 컨텍스트**를 기본으로 사용한다.
- 정적 자산 회귀는 `HTML URL`만 보면 안 된다. `main.js` 본문, dynamic import, worker URL까지 같이 확인해야 한다.
- `Cache-Control: no-cache`만으로 PASS 처리하지 않는다. 반드시 `ETag` 존재와 `If-None-Match -> 304`를 같이 본다.
- 서버 재기동 후 stale JS 회귀를 볼 때는 브라우저 메모리 캐시와 디스크 캐시를 둘 다 비우고 시작한다.

## 공통 Cold Start 측정 규칙

- 권위 기준은 **strict cold** 이다. 항상 `기존 api.main 서버 종료 -> thumbnails 삭제 -> .file_index_cache.txt / .file_index_cache_*.lock 삭제 -> RELOAD=0으로 새 서버 기동 -> 새 브라우저 세션` 순서를 따른다.
- **random free port**를 매 run마다 새로 잡는다. 같은 포트를 고정 재사용하면 FAIL이다.
- 서버 readiness 확인은 **TCP listen 확인만 허용**한다. `/`, `/api/index-status`, `/api/config` 같은 HTTP readiness 요청을 브라우저 접속 전에 보내면 FAIL이다.
- 첫 HTTP 요청은 반드시 Playwright 브라우저의 첫 `GET /` 이어야 한다. 이 규칙이 깨지면 strict cold 결과로 인정하지 않는다.
- 브라우저 쪽은 **새 컨텍스트 + HTTP cache / cookie clear**를 사용한다.
- `page load`, `folder list`, `unknown list`, `files/recursive`, `first viewport thumb`, `browser total`, `server start -> folder list`, `server start -> grid`를 분리해서 기록한다. 하나의 합산값만 남기면 병목 위치를 놓친다.
- 폴더 목록이 보이자마자 `unknown`를 클릭하고, 파일 리스트가 보이자마자 지연 없이 `Ctrl+click`으로 그리드 진입한다. 중간 `sleep`/`waitForTimeout`으로 시간을 소비하면 FAIL이다.
- 최소 3회 반복하고 median을 권위 기록으로 남긴다. 단, 단 1회라도 fail threshold를 넘기면 전체 Phase는 FAIL이다.

## Reset / 선택 해제 평가 방법

- 폴더 1개를 선택해 grid를 연다
- LT/TM/STEP 또는 범례 필터를 일부 적용해 현재 보이는 이미지 수를 의도적으로 줄인다
- 선택된 폴더에서 우클릭 선택 해제를 수행한다
- PASS 기준:
  - 선택 해제 후 `selectedImages`에는 해당 폴더 이미지가 1장도 남아 있지 않아야 한다
  - 선택 해제는 "현재 보이는 subset"이 아니라 폴더 전체 이미지 집합 기준으로 동작해야 한다
  - 이어서 `Reset`을 눌렀을 때 residual selection 때문에 숨겨져 있던 이미지가 갑자기 튀어나오면 FAIL이다
  - `Reset`은 단지 필터를 초기화하고 현재 폴더 원본 이미지 목록을 다시 보여줄 뿐, 이전 선택 찌꺼기를 복구하면 안 된다

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
- 필터 버튼 UI: LOT/TEST/STEP 선택 시 `.filter-active` 파란색, 드롭다운에는 처음 열기 전부터 "0개 선택중" 배지를 렌더링하고 선택 후 "N개 선택중"으로 갱신한다.
- Reset 버튼: `↺` → `Reset` 텍스트, 필터 활성 시 파란색
- 헤더 버튼: "Wafer Map Explorer" / "Label Explorer" 텍스트로 변경
- 텍스트: "색변경"→"색 변경", "권한"→"권한 변경"
- Manual 링크: `http://go/failbitmapmanual/`
- FALLBACK_LOGIN_ID / sentinel 정합성: backend 기본값은 `notsaml`, frontend sentinel은 `guest`이지만 서버가 둘 다 invalid/fallback으로 처리
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

7. **fetch 래핑 LoginId 전달 확인**: SAML 로그인 후 (`viewer.getCurrentLoginId?.()`가 `guest`/`notsaml`이 아닌 실제 사용자일 때)
   - 로컬 Playwright `page.evaluate`로 `/api/config` fetch 호출 → Network 탭에서 URL에 `LoginId=` 파라미터 포함 확인
   - `viewer.currentUser`가 설정되어 있으면 모든 `/api/` 요청에 `?LoginId=` 자동 추가됨
   - 서버 로그에서 IP 옆에 LoginId가 "—" 대신 실제 ID로 표시되는지 확인

**pass 기준**: 항목 1~6 모두 true, 콘솔 critical error 0, LoginId 전달 확인

---

### Phase 2: 폴더 & 그리드 + 스크롤 성능

**목적**: 폴더 로드, 그리드 렌더링, 대량 이미지 스크롤 시 썸네일 즉시 로드 확인

**평가 항목**:

#### 2-1. 기본 그리드 로드
1. `v.loadImagesInFolderAndShowGrid('unknown')` → `v.currentGridImages.length === 3000`
2. `#image-grid`에 `.grid-thumb-wrap` 요소 존재 (가상 스크롤이므로 전체 3000개는 아닐 수 있음)
3. 첫 번째 이미지의 `<img>` 태그 `complete === true`, `naturalWidth > 0`

#### 2-2. 컬럼 수 변경
1. 컬럼 입력 `#grid-cols-input`에 값 7 입력 → 그리드 레이아웃이 7열로 변경 확인
2. 다시 4로 복원

#### 2-3. 전체선택/해제
1. `#grid-select-all` 클릭 → `v.gridSelectedIdxs.length === 3000`, `v.gridSelectedSet.size === 3000`
2. `#grid-deselect-all` 클릭 → `v.gridSelectedIdxs.length === 0`, `v.gridSelectedSet.size === 0`

#### 2-4. 스크롤 성능 (unknown, 3000장)
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

#### 2-5. 스크롤 성능 (unknown, 대용량)
1. `v.loadImagesInFolderAndShowGrid('unknown')` → 폴더 로드 확인
2. 맨 아래 스크롤 → 500ms 후 이미지 로드율 측정
3. 다시 `unknown`로 전환 → 캐시 히트로 즉시 로드 확인 (로드율 95%+)

#### 2-6. 여러 폴더 전환
1. `unknown` 로드 → `v.currentGridImages` 내용이 이전 폴더와 다른지 확인
2. `unknown` 로드 → 동일 확인
3. `unknown` 로드 → 복귀 확인
4. 각 전환 시 이전 폴더 이미지가 그리드에 남아있지 않은지 확인
   - `#image-grid img[src*="이전폴더명"]` → length === 0

**스크린샷**: 맨 아래 스크롤 후 그리드 상태

#### 2-7. 그리드 정렬 (`unknown` 폴더, 12장)
파일명 형식: `{root}_{step}_{wafer}_{date}_{time}_{yield}_{sys}.png`
(인덱스: 0=LOT, 1=step, 2=wafer, 3=date, 4=time, 5=yield, 6=sys)

1. `v.loadImagesInFolderAndShowGrid('unknown')` → 12개 이미지 로드 확인
2. **정렬 드롭다운 존재 확인**: `#grid-sort-select` 요소 존재, 9개 옵션 (파일명, LOT↑↓, 시간↑↓, Yield↑↓, Sys↑↓)
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
8. **time ↑ (오름차순)**:
   - `time_asc` 선택 → `_` index 3+4 (`YYYYMMDD_HHMMSS`)가 가장 이른 항목부터 표시
9. **time ↓ (내림차순)**:
   - `time_desc` 선택 → `_` index 3+4가 가장 늦은 항목부터 표시
10. **Sys ↑ (오름차순)**:
   - `sys_asc` 선택 → 첫 번째 = 최소 Sys (0.5)
11. **Sys ↓ (내림차순)**:
   - `sys_desc` 선택 → 첫 번째 = 최대 Sys (22.1)
12. **파일명 복원**: `filename` 선택 → 원래 자연 정렬 순서 복원
13. 각 정렬 변경 시 그리드가 즉시 리렌더되고 이미지가 정상 표시되는지 확인

#### 2-8. LOT Mode + 정렬 연동
LOT Mode 활성 상태에서 정렬 변경 시 LOT 그룹핑이 유지되고 그룹 내부 순서만 바뀌는지 확인.

1. `v.loadImagesInFolderAndShowGrid('unknown')` → LOT Mode ON 확인 (`#lot-mode-btn.active`)
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

**pass 기준**: 9개 정렬 옵션 모두 LOT 그룹핑 유지, 그룹 내 정렬 정확, 모드 전환 시 정렬 유지

---

### Phase 3: 제품 검색 & 필터 (LOT/TEST/STEP)

**목적**: 검색/필터로 이미지 목록을 좁힐 수 있는지, 필터 해제로 복원되는지 확인

**평가 항목**:

#### 3-1. 제품 검색
1. 검색 입력창 `input[placeholder*="제품 검색"]`에 "unknown" 입력
2. 파일 탐색기에 "unknown" 포함 폴더만 표시되는지 확인
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
4. 드롭다운 패널 상단에 항상 "0개 선택중" 배지를 먼저 렌더링하고 선택 시 "N개 선택중"으로 갱신

##### 3-2-8. `H%(PA,TD)` root LOT wildcard
1. LOT 드롭다운 Wildcard에 `H%(PA,TD)` 항목이 존재하는지 확인
2. `v.filterLT = ['H%(PA,TD)']`로 설정하고 `_passesLtTmFilter()`를 실제 파일명 형식으로 호출
3. root LOT 길이 8, index 6이 `H`, index 7이 숫자인 파일만 통과해야 한다.
4. 길이 7/9, index 6이 H가 아님, index 7이 숫자가 아님인 파일은 숨겨져야 한다.
5. 현재 규칙에서는 괄호의 `PA,TD`는 표시명이며 LT 메타데이터 AND 조건으로 사용하지 않는다. 조건이 바뀌면 이 E2E와 필터 판정을 함께 수정한다.

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

1. 폴더 3개 열기: `unknown`, `unknown`, `unknown`
   - `details[open] > summary[data-path]` 로 열린 폴더 3개 확인
2. TEST 필터에서 NORMAL 체크 (change 이벤트 발생)
3. 필터 적용 후 확인:
   - `details[open]` 폴더가 필터 전과 동일한 3개인지 확인
   - DOM 파일 수 변화 없음 (숨겨진 것만 다름): `querySelectorAll('a[data-path]').length` 동일
   - 보이는 파일 수만 변경: `filter(a => a.closest('li')?.style.display !== 'none').length` < 전체
4. 필터 해제 후에도 폴더 열림 상태 유지 확인

#### 3-5. 필터 성능 — DOM show/hide 속도 (unknown, 3000파일)
메타 로드 후 필터 전환은 API 호출 없이 DOM만 조작하므로 즉시 반영되어야 한다.

1. `unknown` 폴더에서 메타 로드 완료 확인 (`Object.keys(v.filterFileMetadata).length === 3000`)
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
   → 파일명 예: "unknown/wafer_0001_EE_Normal.png"
   → 파일명 안에 이미 LT=EE, TM=Normal이 들어있음

2. 인덱스 완료 → 폴더별 캐시 자동 생성 (_FOLDER_FILES_CACHE)
   → { "unknown": ["unknown/wafer_0001_EE_Normal.png", ...3000개] }
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
예: `AAU220_00P_W01_20260122_022718_87.35_3.21_EE_Normal.png`
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
1. `AAU220 and 13` → 파일명에 "AAU220" 포함 AND "13" 포함 (timestamp 제거됨)
   - timestamp에 매칭되지 않고 실제 wafer 토큰에 매칭되는지 확인
2. `AAU220 and 00P and 13` → LOT, STEP, WAFER 3개 조건 AND
3. 결과 파일 수가 개별 검색보다 적은지 확인

##### 3-12-2. or 연산자
1. `AAU220 or ABM792` → 둘 중 하나라도 포함된 파일
2. 결과 파일 수가 개별 검색의 합과 같거나 적은지 확인 (중복 제거)

##### 3-12-3. not 연산자
1. `AAU220 not 00C` → "AAU220" 포함하지만 "00C" 없는 파일
2. 결과에 "00C" 포함 파일이 없는지 확인

##### 3-12-4. () 그룹핑
1. `(AAU220 or ABM792) and 13` → (AAU220 또는 ABM792) 이면서 13 포함
2. 괄호 없이 `AAU220 or ABM792 and 13`과 결과가 다른지 확인 (우선순위)

##### 3-12-5. 단순 문자열 검색 (연산자 없음)
1. `AAU220_00P_13` → 전체 파일명에서 부분 일치 (timestamp 포함)
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

1. `unknown` 폴더 열기 (10개 파일: 00P 5개 + 00C 5개)
2. STEP > PLH 체크 → 탐색기에 00P 파일 5개만 보임
3. `unknown` 폴더 Ctrl+클릭 (폴더 선택 → 그리드 표시)
4. **검증**: `v.currentGridImages`에 00P 파일만 포함 (5개)
5. **검증**: 00C 파일(`LOT001_W01_00C.png` 등)이 그리드에 없음
6. Reset 클릭 → 그리드 10개로 복원

#### 3-16. 그리드 활성 상태에서 필터 변경 → 그리드 동적 갱신
**핵심**: 그리드가 표시된 상태에서 필터를 변경하면 그리드도 즉시 갱신되어야 한다.

1. `unknown` 폴더를 필터 없이 Ctrl+클릭 → 그리드 10개
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
6. `unknown` 폴더 열기 → 00P 파일만 표시 (00C 숨김)
7. 폴더 Ctrl+클릭 → 그리드에 00P 파일만 표시

#### 3-18. 필터 0건 시 상단 패널 유지 + 안내 메시지
**핵심**: 폴더를 Ctrl+클릭했는데 필터로 이미지가 0건이면, 상단 패널(grid-controls)은 유지하고 안내 메시지를 표시해야 한다. `hideGrid()`가 호출되면 FAIL.

1. `unknown` 폴더 Ctrl+클릭 → 3000개 그리드 표시 확인
2. 존재하지 않는 LOT 필터 적용 (`v.filterLT = ['NONEXISTENT']`)
3. `await v._applyFilterToGrid()`
4. **검증**: `v.gridMode === true` (그리드 모드 유지)
5. **검증**: `grid-controls`의 `offsetHeight > 0` (상단 패널 보임)
6. **검증**: 그리드 영역에 "이미지가 없습니다" 메시지 포함
7. 필터 해제 (`v.filterLT = []`) → `await v._applyFilterToGrid()`
8. **검증**: `v.selectedImages.length === 3000` (원래 이미지 복원)
9. 필터 설정된 상태에서 **새 폴더 Ctrl+클릭** (초기 선택 시에도 동일 동작)
10. **검증**: `v.gridMode === true`, `grid-controls` visible, 안내 메시지 표시

```javascript
// 필터 0건 → 상단 패널 유지
const v = window.viewer;
v.filterLT = ['NONEXISTENT'];
await v._applyFilterToGrid();
const gc = document.getElementById('grid-controls');
console.assert(v.gridMode === true, 'gridMode should stay true');
console.assert(gc.offsetHeight > 0, 'grid-controls should be visible');
const grid = document.getElementById('image-grid');
console.assert(grid.textContent.includes('이미지가 없습니다'), 'empty message should show');

// 필터 해제 → 복원
v.filterLT = [];
await v._applyFilterToGrid();
console.assert(v.selectedImages.length === 3000, 'images should restore');
```

**pass 기준**: 필터 시 파일만 숨김(폴더 유지, DOM 교체 없음), 대소문자 무시 매칭,
열린 폴더 보존, 해제 시 전체 복원, DOM show/hide 50ms 이내, 연속 클릭 마지막만 실행,
스크롤 보존, Ubuntu 호환, 파일명 _LT_TM 추출 50ms 이내, 폴더선택+그리드 100ms 이내,
선택 3000개 제한, 검색 연산자(and/or/not/()) 정상 동작, 연산자 시 timestamp 제거 + 단순검색 시 timestamp 포함,
단어 경계 구분(android≠and), 검색창 화살표 커서, N키 단축키 없음,
**필터→그리드 반영**, **그리드 중 필터 변경 동적 갱신**, **새로고침 후 필터 유지**, **필터 0건 시 상단 패널 유지+안내 메시지**

---

### Phase 4: 색상 편집 + 개인색 적용 종합 검증

**목적**: 색상 편집 모달 동작, 개인색이 그리드/단일이미지/Measure/Navigator/미니맵에 올바르게 적용되는지 종합 검증

**배경 (개인색 아키텍처)**:
- `personalizedColorEnabled = true` (항상 활성화, 체크박스 UI 숨김)
- 프론트: `getPersonalizedParams()` → `&personalized=true&scheme=LoginId&_t=timestamp` URL 파라미터 추가
- 서버: `/api/thumbnail`에서 `personalized=true&scheme=LoginId` 수신 → indexed-color PNG의 PLTE 청크를 개인색으로 패치
- 캐시: 서버 디스크 캐시 `thumbnails/{scheme}/` 하위, 프론트 `thumbnailManager.cache` Map
- 색상 변경 시: 서버 `_invalidate_scheme_thumbnail_caches()` 디스크 삭제 + 프론트 `_personalizedColorCacheBuster` + `thumbnailManager.cache.clear()`

**발견 및 수정한 버그 (2026-03-28)**:

| # | 버그 | 수정 |
|---|------|------|
| 1 | Measure 배경색이 항상 #CCCCCC — 개인색 무시 | `_resolve_scheme_background_rgb`에서 measure 섹션 bg=#CCCCCC이면 개인색 fallback |
| 2 | 색상 저장 후 그리드 미갱신 (selectedImages 비어있을 때) | `color-editor.js`에서 `currentGridImages` 우선 사용 + fallback `refreshGridThumbnailsWithCurrentParams()` |
| 3 | 그리드 미선택+Measure → 단일 이미지 전환 | `getSelectedImagesForModal()`에서 gridMode일 때 빈 배열 반환 |

**평가 항목**:

#### 4-1. 모달 열기/닫기/탭 전환
1. 색상 편집 버튼 클릭 → 색상 편집 모달 열림
2. Fail 탭 → Grade/BIN 색상 테이블 (G0~G7 + Normal, Invalid, B285, ...)
3. Composite 탭 → gradient 색상 테이블 (quantile0~100)
4. Measure 탭 → gradient 색상 테이블 (quantile0~100)
5. 닫기 → 모달 닫힘, 그리드 정상 표시

#### 4-2. 개인색 시스템 상태 검증
1. `v.personalizedColorEnabled === true`
2. `v.getPersonalizedParams()`에 `personalized=true` 포함
3. `v.getPersonalizedParams()`에 `scheme=` 포함
4. `v.getActivePersonalizedScheme()`이 유효한 스킴명 반환 (예: `notsaml`)
5. `v.colorLegends[scheme]`에 `background`, `top`, `bottom` 키 존재

#### 4-3. 그리드 썸네일에 개인색 적용 확인
1. unknown 그리드 로드
2. 첫 번째 `<img>` src에 `personalized=true&scheme=` 포함 확인
3. **pixel 검증**: 첫 번째 썸네일의 배경 픽셀(5,5)이 `colorLegends[scheme].background` RGB와 ±10 이내 일치
4. **핵심**: 배경색이 default `#CCCCCC` `rgb(204,204,204)`가 아닌 개인 배경색

#### 4-4. 개인색 변경 → 그리드 즉시 반영
1. `/api/color-scheme` POST로 배경색을 테스트 색상 (예: `#FF00FF`)으로 변경
2. 프론트 상태 갱신: `colorLegends[scheme].background`, `_personalizedColorCacheBuster`, `thumbnailManager.cache.clear()`
3. `showGrid(currentGridImages)` 호출 → 8초 대기
4. **pixel 검증**: 새 배경색이 반영됨 (±10 허용)
5. 원래 색상으로 복원

#### 4-5. 단일 이미지에 개인색 적용
1. 이미지 더블클릭 → 단일 이미지 모드
2. 이미지 로드 후 배경 픽셀이 개인 배경색과 일치 확인
3. Grade 범례(G0~G7) 색상이 `colorLegends[scheme].top` 값과 일치 확인

#### 4-6. Measure heatmap 배경 개인색
1. Measure 패널에서 FBT 항목 적용
2. **API 검증**: `/api/measure-composite-data` 응답의 `background`가 `[204,204,204]`가 아닌 개인 배경색 RGB
3. **Canvas 검증**: measure heatmap 렌더링 후 배경 영역이 개인 배경색
4. **미니맵 검증**: 미니맵에도 동일한 배경색 표시

#### 4-7. Navigator 썸네일 개인색
1. Navigator 패널의 썸네일 배경이 개인 배경색
2. Measure 모드에서 Navigator 썸네일 URL에 `scheme=` 포함

#### 4-8. Composite/Measure 탭 gradient 저장
1. Composite 탭에서 gradient 색상 변경 → 적용
2. API POST 성공 확인
3. 그리드 썸네일 갱신 확인 (Measure 모드일 때)

#### 4-9. 색상 편집기 에러 없음 확인
1. Fail 탭 → Composite 탭 → Measure 탭 전환 시 콘솔 에러 없음
2. "Failed to fetch" 에러 없음
3. 적용/초기화/복원/닫기 모든 버튼 정상 동작

**pass 기준**: 4-1~4-9 모든 핵심 검증 통과

---

### Phase 5: 상단 컬러 범례 (Grade/BIN/Gradient)

**목적**: 범례 클릭으로 칩 필터가 정상 적용/해제되고, Measure heatmap 적용 시 Gradient 범례로 전환되는지 확인

**평가 항목**:

#### 5-1. Grade 범례 (Top Legend) — **pixel 필터**
1. 그리드 모드에서 상단 범례 영역에 G0~G7 항목 존재 확인
   - `document.querySelectorAll('.top-legend-item, [data-grade]')` → length >= 8
2. G0 클릭 → **pixel 필터 적용**: 해당 indexed-color index(0)를 가진 pixel만 남기고, 나머지 Grade pixel은 Grade0 색상으로 변경하여 표시
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
2. `v.loadImagesInFolderAndShowGrid('unknown')` 호출
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
1. 원본 폴더(unknown)로 이동 → 이미지 5개 Ctrl+클릭 선택
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

#### 7-9. 기존 라벨 클래스 로드 (non-indexed-color 이미지 폴백)
기존에 라벨링된 클래스의 이미지가 RGBA/RGB 등 non-indexed-color 포맷이어도 에러 없이 표시되는지 확인.
1. Label Explorer에서 기존 클래스 폴더 클릭 (예: `afwefaw`) → 폴더 열림 확인
2. 이미지 목록 표시 확인 (Center.png, Donut.png 등)
3. **서버 생존 확인**: 폴더 열기 후 `/api/classes` 응답 200 확인
4. 이미지 썸네일 아이콘 표시 확인 (에러 이미지가 아닌 실제 이미지)
5. Label Explorer에서 이미지 클릭 → 그리드에 해당 클래스 이미지만 표시
6. **서버 생존 재확인**: 그리드 로드 후 `/api/classes` 응답 200 확인
7. 이미지 더블클릭 → 단일 뷰 진입 (RGBA/RGB 이미지도 정상 렌더링)
8. **범례**: non-indexed-color 이미지는 Grade 범례가 비어있거나 기본값 표시 (에러 아님)
9. ESC → 그리드 복귀
- **핵심**: non-indexed-color(RGBA/RGB) 이미지에 `personalized=true` 요청 시 서버가 죽지 않고 원본 이미지로 폴백
- **핵심**: positions JSON이 없는 이미지에서 chip annotator 에러가 발생하지 않음

**pass 기준**: 단건/다중 추가 → 버튼 클릭 라벨 → Add Label 라벨 → 탐색 → 단일뷰 → 다중 삭제 → 기존 라벨 non-indexed-color 로드 전체 성공

#### 7-10. Label Explorer 단일/다중 선택 전환
Label Explorer에서 이미지 클릭으로 단일 뷰/다중 그리드 전환이 정상 동작하는지 확인.
1. 이미지 1개 클릭 → `gridMode=false`, `viewMode='single'`, canvas `display:block`
2. Ctrl+클릭으로 2번째 이미지 추가 → `gridMode=true`, `selected.length=2`, `currentGridImages.length=2`
3. Ctrl+클릭으로 3번째 추가 → `selected.length=3`, `currentGridImages.length=3`
4. 다른 이미지 단일 클릭 → `gridMode=false`, `viewMode='single'`, canvas `display:block`
5. 같은 이미지 다시 클릭(해제) → `gridMode=true`, `selected.length=0` (이전 그리드 복귀)
6. **서버 생존 확인**: `/api/classes` 응답 200

#### 7-11. Label Explorer UI 안정성 — 상단 밀림 방지
Label Explorer 클래스 폴더 열기/닫기 시 위쪽 UI(Class Manager, Fail List)가 움직이지 않는지 확인.
1. 클래스 폴더 열기 전 `.classification-frame` offsetTop 기록
2. 클래스 폴더 열기 후 `.classification-frame` offsetTop 비교 → 동일해야 함
3. 이미지 클릭(단일 뷰) 후 `.classification-frame` offsetTop 비교 → 동일해야 함
4. `.label-explorer-frame`에 `overflow-y: auto` 확인 (독립 스크롤)
- **핵심**: `.wrapper-right`가 `overflow: hidden`, `.classification-frame`이 `flex-shrink: 0`

#### 7-12. classification 이미지 경로 폴백 (Ubuntu 호환)
`get_image`/`get_thumbnail` API가 classification 경로를 찾을 때 다중 폴백을 시도하는지 확인.
1. `/api/image?path=classification/afwefaw/Center.png` → 200 (ROOT_DIR 또는 current_folder 기준)
2. `/api/thumbnail?path=classification/afwefaw/Center.png&size=512` → 200
3. 404 발생 시 서버 로그에 `❌ [get_image] 404: path=..., ROOT_DIR=..., current_folder=...` 진단 로그 출력
- **핵심**: `ROOT_DIR/path` 실패 → `current_folder/path` → `current_folder/classification/tail` 순서로 폴백

#### 7-13. Label Explorer 클래스 선택 hover 시 하이라이트 유지
Ctrl+클릭으로 클래스 폴더를 선택한 뒤, 이미지 버튼 위에 마우스를 올렸다 빼도 하이라이트(`#09f`)가 유지되는지 확인.
1. Label Explorer에서 이미지가 있는 클래스 폴더 클릭 → 폴더 열림
2. 폴더 헤더를 Ctrl+클릭 → `selectedClasses`에 해당 클래스 포함 확인
3. 이미지 버튼 `style.background`가 `rgb(0, 153, 255)` (`#09f`) 확인
4. 이미지 버튼에 `mouseover` 이벤트 발생 → `style.background`가 `#09f` 유지 확인 (hover 시 색상 변경 없음)
5. 이미지 버튼에 `mouseout` 이벤트 발생 → `style.background`가 `#09f` 유지 확인 (`#222`로 리셋되지 않음)
6. 다른 이미지 버튼에도 동일 테스트 반복 → 모두 `#09f` 유지
- **핵심**: `onmouseover`/`onmouseout`에서 `labelSelection.selectedClasses.includes(cls)` 체크로 클래스 선택 상태의 하이라이트 보호
- **회귀 방지**: 수정 전에는 `labelSelection.selected`만 체크하여 클래스 폴더 선택 시 mouseout에서 `#222`로 리셋되던 버그

**pass 기준**: 단건/다중 추가 → 버튼 클릭 라벨 → Add Label 라벨 → 탐색 → 단일뷰 → 다중 삭제 → 기존 라벨 non-indexed-color 로드 → 단일/다중 전환 → UI 안정성 → 경로 폴백 → hover 하이라이트 유지 전체 성공

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

#### 8-7. Composite Map 배경색 개인색 검증
Composite 생성 결과의 모든 이미지(Grade 0~7, square_average, square_weighted_average) 배경이 개인색으로 적용되는지 확인.
1. Composite 결과 그리드에서 이미지 더블클릭 → 단일 뷰 진입
2. **Grade 이미지 배경색 확인**: chip 바깥 영역이 개인색 background (index 8) — 흰색이 아님
3. **Average 이미지 배경색 확인**: chip 바깥 영역이 개인색 background
4. Grade와 Average 모두 동일한 배경색 사용 확인
5. 배경색이 `color-legends.json`의 해당 사용자 background 색상과 일치
- **핵심**: composite_map.py `base_indices` 배경 = index 8 (개인색), index 31 = invalid fill (흰색 고정)
- **핵심**: `personal PLTE 적용 경로`에서 index 8은 개인색, index 31은 항상 (255,255,255)

#### 8-8. Invalid Fill 흰색 고정 검증
투명 영역/잘못된 데이터가 있는 이미지에서 invalid 영역이 항상 흰색(index 31)으로 표시되는지 확인.
1. unknown 이미지에서 투명 픽셀이 있으면 index 31 → 흰색 (255,255,255)
2. 개인색 배경을 변경해도 invalid 영역은 흰색 유지
3. `personal_colors.py`에서 index 31 = 흰색 고정 확인
- **핵심**: index 8 (배경) vs index 31 (invalid) 역할 분리

#### 8-9. Gradient Stats 성능 검증
Composite average map 단일 뷰에서 gradient 범례 픽셀 분포 계산이 빠르게 완료되는지 확인.
1. `/api/gradient-stats?path=...square_average...` API 호출 → 200 응답
2. 응답 시간 < 500ms (np.histogram 직접 사용, float64 정규화 제거)
3. 응답에 `stats` 객체 포함 (10개 구간별 카운트)

#### 8-10. Composite 생성 시 이벤트 루프 블로킹 방지 검증
`composite-cleanup` 엔드포인트의 `from .composite_map import ...`가 async handler에서 동기 실행되면 이벤트 루프를 블로킹한다.
import와 shutil.rmtree가 반드시 `run_in_executor` 안에서 실행되어야 한다.
1. `POST /api/composite-cleanup` 요청과 `GET /api/files?path=.` 요청을 **동시에** 전송
2. `files` 응답이 **5초 이내**에 200으로 반환되는지 확인 (블로킹 없음)
3. `composite-cleanup` 응답도 200으로 반환되는지 확인
4. **코드 검증**: `api/main.py`의 `composite_cleanup_endpoint`에서 `from .composite_map import ...`가 `_cleanup_sync()` 함수 내부에 있고, `run_in_executor`로 실행되는지 확인
- **핵심**: import가 async handler 본문에서 직접 실행되면 첫 요청 시 numba/numpy/pyvips 로드로 2분+ 이벤트 루프 블로킹 → 모든 HTTP 요청 pending

#### 8-11. Composite Gradient 색상 — 개인색 Composite 탭 색 사용 검증
Grade 맵을 제외한 모든 Composite 결과(square_average, square_weighted_average, BIN/FBT/QVL Composite)의 gradient 색상이 개인색 편집기의 **Composite 탭** 색을 사용하는지 확인한다.
1. `/api/composite-colors?LoginId={loginId}` 응답에서 gradient 색상 배열 획득 (`colors`)
2. `/api/measure-colors?LoginId={loginId}` 응답에서 gradient 색상 배열 획득 (`colors`)
3. Composite 결과에서 **square_average** 더블클릭 → 단일 뷰 진입
4. `v._ratioGradientCache`가 **composite-colors**의 색상 배열과 일치하는지 확인
5. `v._ratioGradientCacheKey === 'composite'` 확인
6. Back → 그리드 복귀 → 원본 폴더로 이동 → Measure overlay 진입
7. `v._ratioGradientCacheKey === 'measure'` 확인 (모드 전환 시 캐시 무효화)
- **핵심**: `_ensureRatioGradientCache()`가 `isCompositeMode`이면 `/api/composite-colors`, 아니면 `/api/measure-colors` 사용. 모드 전환 시 캐시키 변경으로 자동 무효화.

**pass 기준**: 그리드 Gradient 범례 표시, Average/Grade 단일 뷰 범례 분리, Subset 생성→검증, BIN/FBT/QVL 모두 Gradient 범례 + 퍼센트/칩수 + 단일/다중 선택/해제 필터 정상, 배경색 개인색 적용, invalid 흰색 고정, gradient stats < 500ms, composite-cleanup 블로킹 없음, gradient 색상 Composite 탭 색 사용

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

#### 9-7a. Composite 생성 직후 orphan chooser 금지
1. `#context-mc-submenu .mc-generate-btn` 클릭 직전 orphan chooser monitor 시작
2. 버튼 클릭 후 Composite 탭 전환과 결과 그리드 렌더링 대기
3. `#grid-context-menu`가 닫힌 상태에서 `#context-mc-submenu` 또는 `#context-mea-submenu`가 보이면 FAIL
4. 특히 `input[placeholder="검색..."]`와 `이미지를 선택하세요`가 함께 보인 event가 없어야 함
5. PASS 기준: `orphanContextChooserEvents.length === 0`, `visibleFloatingPanelsAfterComposite.length === 0`, `selectedPanelAfterComposite.display === 'none'`

#### 9-8. Composite Map 저장 경로 (LoginId 기반)
1. `/api/config` 응답에서 FALLBACK_LOGIN_ID 확인 (기본값 `"notsaml"`)
2. Composite Map 생성 API 호출 시 응답의 `output_dir`에 LoginId 포함 확인
3. `composite_map/{LoginId}/current/` 구조인지 확인 (timestamp 폴더 아님)
4. 재생성 시 이전 결과가 삭제되고 새 결과로 교체되는지 확인

#### 9-9. Measure Composite 누적 방지
1. Measure Composite 생성 후 `output_dir` 경로 확인
2. 동일 사용자로 재생성 시 이전 `*_measure/` 폴더가 삭제되는지 확인
3. `current/` 디렉토리는 삭제되지 않는지 확인

**pass 기준**: 9-1 ~ 9-9 전체 pass, Composite 생성 직후 orphan chooser event 0

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
- unknown: 실제 failbit map 기준 폴더. 하위 패턴 폴더까지 재귀 선택하여 검증한다. failbit/bin/measure/composite/reference/label/MyLot/단일 이미지 보기와 전역 LOT 검색의 화면 정확성은 `unknown`을 기준으로 삼는다.
- unknown: ftn_keys 500개, qtn_keys 500개, chips 384개/파일, 3000파일
- unknown: ftn_keys 500개, qtn_keys 500개, chips 812개/파일, 6파일
- ftn_keys 예시: `["2824","1409","5506","5012","4657","3286",...]` (500개)
- qtn_keys 예시: `["5445","5180","5751","5534","5988",...]` (500개)
- f 값 범위: 25~9976 (정수 문자열), q 값 범위: 0~100

**평가 항목**:

#### 11-0. `/api/chip-positions` 응답 구조 검증
1. `fetch('/api/chip-positions?path=unknown/unknown_wafer_0001_EE_Engineer.png')` 호출
2. 응답에 `ftn_keys` 배열 존재, **길이 500** 확인
3. 응답에 `qtn_keys` 배열 존재, **길이 500** 확인
4. `ftn_keys` 첫 번째 키가 문자열인지 확인 (예: `"2824"`)
5. 칩 객체에 `f`, `q` 키 **없음** 확인 (`chips[0].f === undefined`)
6. 칩 객체에 `rect.quad` **없음** 확인
7. 칩 객체에 `b`, `g`, `rect.x0/y0/x1/y1`, `x_abs`, `y_abs`, `x_cal`, `y_cal` 존재 확인
8. chips 배열 길이 **384** 확인
9. 응답 크기 측정 (경량화 전 ~2MB → 경량화 후 수십KB 기대)

#### 11-1. Measure 패널 열기 & FBT/QVL/BIN 키 표시
1. unknown 그리드 로드 (`loadImagesInFolderAndShowGrid`) → 전체선택
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

1. unknown 그리드 → 이미지 10개 이상 선택
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

#### 11-7. unknown 대용량 positions 처리 검증
1. unknown 그리드 로드 → `/api/chip-positions` 호출
2. 응답에 `ftn_keys` 500개, `qtn_keys` 500개, chips **812개** 확인
3. Measure 패널에서 FBT/QVL 키 목록 정상 표시 확인
4. FBT heatmap 적용 → gradient 범례 표시 확인

#### 11-8. Measure 키 인덱스 방지 & 그리드→단일 전환 시 오버레이 보존
compact_array 포맷에서 FBT/QVL 키가 배열 인덱스(0,1,2...)로 표시되지 않고 실제 키 이름으로 표시되는지, 그리드→단일 전환 시 measure 오버레이가 유지되는지 검증.

1. unknown 그리드 로드 → 전체선택
2. Measure 패널 열기 (`#failbit-btn-top` 클릭)
3. **인덱스 방지 검증**: FBT 항목 텍스트에 `FBT0`, `FBT1`, `FBT2` 등 순차 인덱스가 **없는지** 확인
   - 로컬 Playwright `page.evaluate`로 `.failbit-item` 텍스트 목록 수집
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

1. unknown 단일 이미지 로드 (unknown_wafer_0001_EE_Engineer.png)
2. Measure 패널에서 FBT2824 클릭 → 오버레이 적용
3. **단일 이미지 칩 텍스트 확인**: `chipAnnotator.ratioOverlayColors.size > 0` (칩 색상 계산됨)
4. **칩 텍스트 값 검증**: 로컬 Playwright `page.evaluate`로 chipAnnotator 렌더 시 compact_array 인덱스 접근 확인
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

1. unknown 단일 이미지 로드 (wafer_unknown_PE_Engineer.png)
2. Measure 패널에서 FBT2824 클릭 → 클라이언트 사이드 chipAnnotator heatmap 적용
3. 로컬 Playwright `page.evaluate`로 gradient 캐시 확인: `viewer._ratioGradientCache` 11개 색상 존재
4. Navigator 썸네일 URL에 `measure_overlay=f%3A2824` 포함 확인
5. Navigator 첫 번째 썸네일 이미지를 canvas에 그려 픽셀 샘플링 (칩 영역 + 배경)
6. 칩 영역 픽셀이 원본 Grade 색상과 **다름** 확인 (heatmap gradient 색상)
7. 그리드 모드 진입 (`loadImagesInFolderAndShowGrid('unknown')`)
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

1. unknown 그리드 로드 → FBT2824 선택
2. 그리드 첫 번째 이미지 `img.src` 또는 `img.dataset.src`에 `/api/measure-thumb` 포함 확인
   (NOT `/api/thumbnail?...measure_overlay=`)
3. URL에 `field=f`, `key=2824`, `scheme={LoginId}` 파라미터 존재 확인
4. 서버 응답 Content-Type: `image/webp` 확인
5. 응답 크기 **< 15KB** 확인 (기존 thumbnail overlay ~40KB 대비 경량)
6. `performance.now()` 기준 FBT 선택→visible 이미지 로드 완료: **< 500ms** (6장 기준)
7. 초기화 → 그리드 이미지 src가 `/api/thumbnail` (기존 방식)으로 복귀 확인
8. unknown 3000장 로드 → FBT2824 선택
9. visible 16장 로드 완료: **< 200ms** (positions 캐시 히트)
10. 스크롤 → 새 이미지 lazy load 시에도 `/api/measure-thumb` 사용 확인
11. Measure 선택 상태에서 폴더 전환 (unknown → unknown)
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
- 11-7: unknown 대용량 정상 처리
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

1. `unknown` 그리드 로드 상태에서 MY LOT → Wafer 탭 → 새 그룹 생성
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
   - preview 파일명이 `unknown_wafer_XXXX` 패턴 (현재 폴더 `unknown`에서 검색됨)
   - **pass 기준**: 5개 행 모두 paths > 0, preview에 `unknown` 포함

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
| `AAU220.1 13` | AAU220 | 13 | dot+숫자 제거 |
| `AAU220.J1 13` | AAU220 | 13 | dot+영숫자 제거 |
| `AAU220.abc 13` | AAU220 | 13 | dot+영문 제거 |
| `ABM792.12.3 05` | ABM792 | 05 | 다중 dot 제거 |
| `AAU220 13` | AAU220 | 13 | 정상 (noise 없음) |
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
    assert(r.path?.includes('unknown'));     // 현재 폴더 결과
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

#### 12-6. 디스크 파일 복사 검증 (이미지 + positions)

**목적**: batch/manual 저장 시 이미지 파일과 positions JSON이 실제로 디스크에 복사되는지 검증

1. **LOT 모드 batch 저장 후 디스크 확인**:
   - `my-lot/{loginId}/lot/{group}/{LOT}/` 하위에 `.png` 파일 존재
   - `positions/my-lot/{loginId}/lot/{group}/{LOT}/` 하위에 `.json` 파일 존재
   - 이미지 수 === positions 수 (1:1 매칭)
   - **pass 기준**: 이미지 파일 + positions 파일 모두 존재, 개수 일치

2. **Wafer 모드 batch 저장 후 디스크 확인**:
   - `my-lot/{loginId}/wafer/{group}/` 하위에 `.png` 파일 존재
   - `positions/my-lot/{loginId}/wafer/{group}/` 하위에 `.json` 파일 존재
   - **pass 기준**: 동일

3. **Manual 저장 시 `_manual.json` 생성 확인**:
   - `my-lot/{loginId}/{mode}/{group}/_manual.json` 파일 존재
   - JSON 배열 형태, 각 항목에 `lot`, `wafer`, `added_at` 필드
   - 이미지 없는 수동 항목만 포함 (batch로 복사된 항목은 미포함)
   - **pass 기준**: `_manual.json` 존재 + 수동 항목 수 일치

#### 12-7. 수동 항목 영구 보존 (새로고침 후 유지)

**목적**: `my-lot/manual` API로 생성된 이미지 없는 항목이 새로고침 후에도 사라지지 않는지 검증
(이전 버그: wafer 모드에서 빈 폴더만 생성 → `_load_group_entries_legacy`가 이미지 파일만 스캔 → 수동 항목 소실)

1. **LOT 모드 수동 항목 새로고침 검증**:
   - `POST /api/my-lot/manual` → LOT 항목 3개 생성 (이미지 없음)
   - 페이지 새로고침 → MY LOT 열기 → 해당 그룹 선택
   - entries 테이블에 3개 항목 모두 표시됨
   - **pass 기준**: 수동 항목 `file_count: 0`으로 표시, 사라지지 않음

2. **Wafer 모드 수동 항목 새로고침 검증**:
   - `POST /api/my-lot/manual` → Wafer 항목 3개 생성 (lot:wafer 쌍)
   - 페이지 새로고침 → Wafer 탭 → 해당 그룹 선택
   - entries 테이블에 3개 항목 모두 표시됨
   - **pass 기준**: 수동 항목이 wafer 모드에서도 유지됨

3. **삭제 시 `_manual.json` 정리 검증**:
   - 수동 항목 1개 삭제 → `_manual.json`에서 해당 항목 제거됨
   - `GET /api/my-lot/entries` → 삭제된 항목 미포함
   - **pass 기준**: `_manual.json`과 API 응답 모두에서 제거

#### 12-8. Grid 보기 + Chip 정보 로드

**목적**: MY LOT에서 "보기" 또는 "선택 Grid 보기" 후 그리드 로드 + 단일 이미지 진입 시 chip positions 정상 로드 확인

1. **"보기" 버튼 테스트** (이미지 있는 항목):
   - 이미지 있는 LOT 항목의 "보기" 클릭 → 그리드에 해당 LOT 이미지 표시
   - 이미지 수 === 해당 LOT의 `file_count`
   - **pass 기준**: 그리드 아이템 수 일치

2. **"선택 Grid 보기" 테스트**:
   - 항목 선택 → "선택 Grid 보기" 클릭 → 그리드에 선택 항목의 이미지 표시
   - **pass 기준**: 그리드 아이템 수 === 선택 항목의 총 `file_count`

3. **Chip positions 로드 테스트**:
   - 그리드에서 이미지 더블클릭 → 단일 이미지 모드 진입
   - 콘솔에 `✅ Loaded N chip positions` 출력
   - chip_count > 0 (positions JSON이 MY LOT 경로에 복사되어 있으므로)
   - **pass 기준**: chip positions 정상 로드, N > 0

4. **새로고침 후 Grid 보기 재검증**:
   - 페이지 새로고침 → MY LOT → 그룹 선택 → "보기" 클릭
   - 이전과 동일한 이미지 수 표시
   - **pass 기준**: 새로고침 후에도 동일 결과

#### 12-9. 이미지/그룹 삭제
1. 그룹 내 이미지 삭제 버튼 → 개별 이미지 제거 확인
2. 수동 항목 삭제 → `_manual.json`에서도 제거 확인
3. 그룹 삭제 → 목록에서 제거 + 디스크 폴더 삭제 확인

#### 12-10. 모달 닫기
1. 닫기 버튼 또는 `#my-lot-btn-top` 다시 클릭 → 모달 닫힘

**pass 기준**: LOT/Wafer 모드 전환, 그룹 CRUD, Manual 입력(noise 제거 + 토큰 정확매칭 + 현재 폴더 우선 검색 + Grid 보기에서 해당 wafer만 표시), 디스크 파일 복사(이미지+positions), 수동 항목 영구 보존(`_manual.json`), Grid 보기+Chip 로드, 이미지/그룹 삭제

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
   - **Chip(Coord)**: "-"
   - **Chip(Rel)**: "-"
   - **Radious**: "-"
   - **Shot**: "-"

#### 15-2. 칩 클릭 시 정보 업데이트
1. 캔버스에서 칩 영역 클릭 (chipAnnotator를 통해)
2. 클릭 후 정보 패널 업데이트 확인:
   - **BIN**: 실제 BIN 값 (예: "285", "Normal" 등)
   - **Chip(Rel)**: positions `x_cal, y_cal` 칩 격자 상대좌표
   - **Chip(Coord)**: layout `chip_center_x_pos, chip_center_y_pos` 웨이퍼 연속좌표
   - EDS `x_abs, y_abs`는 layout 매칭 키로만 사용하고 화면에는 직접 표시하지 않음
   - **Radious**: `sqrt(chip_center_x_pos² + chip_center_y_pos²)` 거리값
   - **Shot**: `shot_x_pos, shot_y_pos` signed shot order, 단위 없음
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
1. 칩 영역 hover → Chip 모드에서는 해당 칩만 은백색 하이라이트되는지 확인
2. 칩 우클릭 메뉴에서 `Shot 선택` 클릭 → `selectionMode === 'shot'` 확인
   - hover 시 개별 칩이 아니라 같은 `layout.txt shot_id`의 실제 전체 범위가 표시
   - Shot 내부 원본 맵은 그대로 보이고 경계만 표시
   - 선택 전 일반 클릭은 선택하지 않음
   - Ctrl-click으로 같은 `shot_id`의 칩만 전체 선택
   - 선택 결과가 edge partial shot의 실제 칩 수와 일치
   - Shot 선택 후 개별 Chip 경계는 숨기거나 약하게 보이고, Shot 외곽선이 주로 보임
   - 선택 후 일반 왼쪽 클릭으로 전체 선택 해제
3. hover와 선택 하이라이트가 같은 밝은 은백색이고 노란색이 아닌지 확인
4. 우클릭 메뉴에서 `Chip 선택` 클릭 → 기본 선택 모드로 복귀하고 선택 상태 초기화
5. 선택 상태에서 컨텍스트 메뉴의 `선택 Chip Composite Map 만들기`를 실행하고 `/api/composite-map` payload에 선택 좌표 1개가 포함되는지 확인
   - 완료 결과의 `selection_mode === "chip"`, `selected_chip_count === 1` 확인
   - 결과 positions의 chip 수가 1인지 확인
   - 결과 이미지가 원본 6400×6400 전체 wafer가 아니라 선택 chip 주변으로 crop되고, 배경 픽셀 비율이 25% 미만인지 확인
6. 같은 P001 fixture의 한 Shot 좌표 전체를 직접 API 요청하고 완료 결과 positions의 chip 수가 해당 Shot의 실제 chip 수와 같은지 확인
   - edge partial Shot도 layout이 정의한 실제 chip 수만 포함하고, 결과 crop/positions canvas 원점이 일치하는지 확인
7. 선택된 칩의 좌표가 정보 패널에 표시:
   - Chip(Coord) 행에 `"x_abs, y_abs"` 형태의 실제 숫자 값
   - Chip(Rel) 행에 실제 칩 격자 인덱스, Radious 행에 소수점 2자리 거리값, Shot 행에 signed order pair
8. Ctrl+클릭으로 추가 칩 선택 → 다중 선택 확인
   - 선택 칩 수 2개 이상
9. Shift+드래그와 Alt+드래그도 modifier가 눌린 경우에만 선택 범위를 변경하는지 확인

**pass 기준**: hover 범위→일반 클릭 무변경→modifier 선택→좌표표시→모드 복귀→초기화

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
2. Stats API 엔드포인트 호출 확인 (로컬 Playwright `page.evaluate`로 fetch):
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
   - 탭1에서 unknown 그리드 → 탭2로 전환 → 빈 화면(또는 별도 상태)
   - 탭1로 복귀 → unknown 그리드 복원

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

#### 21-6. 새 페이지 추가 시 Label Explorer 초기화
1. 새 페이지 추가 시 Label Explorer 하이라이트/펼침 상태 초기화 확인
2. `labelSelection.selectedClasses` 빈 배열, `openFolders` 전체 false
3. `imgItems` 개수 0개 (이전 페이지 데이터 잔류 없음)

**pass 기준**: 생성→전환(상태 독립)→역할 색상→닫기→키보드→Label Explorer 초기화 전체 성공

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
1. unknown(3000장) 단일 모드 진입
2. Navigator에 모든 3000개를 DOM에 넣지 않고 가상 스크롤 적용 확인
3. 빠른 스크롤 시 끊김 없이 렌더링

#### 22-8. Measure heatmap 반영
1. unknown 그리드 → 전체선택 → Measure FBT 항목 클릭 → heatmap 적용
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

1. **일반 검색**: `wafer_unknown.3` 입력 → `wafer_unknown`로 검색 → 결과 있음
2. **일반 검색 복합**: `wafer.1 AAU220.2` 입력 → `unknown AAU220`로 검색 → 결과 있음
3. **다중검색**: `AAU220.1\nABM792.2\nAAV489` → LOT 파싱: `[AAU220, ABM792, AAV489]`
4. **다중검색 중복 제거**: `AAU220.1\nAAU220.2` → 둘 다 `AAU220` → 중복 제거 → 1개 LOT
5. **AND/OR/NOT + dot**: `AAU220.1 and EE.7` → `AAU220 and EE` → 결과 있음
6. **dot 시작 유지**: `.hidden` → `.hidden` (변환 안 함)
7. 다양한 케이스 검증:
   ```
   AAU220.1 → AAU220
   AAU220.1 09 → AAU220 09
   LOT001.2 LOT002.3 → LOT001
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

#### 25-6. loginId=all 사용자 표시
1. loginId="all" 와일드카드 사용자가 "모든 사용자 · ROLE_ADMIN"으로 표시되는지 확인 (not "(이름없음) (all)")

**pass 기준**: 모달 열기→필터→검색→테이블 조작→닫기→all 사용자 표시

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

1. `v.loadImagesInFolderAndShowGrid('unknown')` → 3000개 로드 확인
2. 전체선택 (`v.selectAllGridImages()`) → `v.gridSelectedIdxs.length === 3000`
3. 더블클릭 단일 모드 (`v.enterGridImageViewMode(0, v.currentGridImages)`) → `v.viewMode === 'gridImage'`
4. 그리드 복귀 (`v.exitSingleImageViewMode()`) → `v.gridMode === true`, grid visible
5. 전체해제 (`v.clearGridSelection()`) → `v.gridSelectedIdxs.length === 0`
6. 상태 확인: `v._gridVisuallyHidden === false`, `v.viewMode === null`
7. 1~6을 **5회 반복** — 매 라운드 모든 조건 통과
8. 최종: `v.loadImagesInFolderAndShowGrid('unknown')` → 그리드 정상 표시 확인

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
1. Ctrl+클릭 폴더(unknown) → 그리드 로드 (3000개)
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
6. 다른 폴더(unknown) Ctrl+클릭 → 그리드 로드
7. **핵심 검증**: `document.querySelector('.grid-scroll-wrapper').scrollTop === 0` (새 폴더 맨 위)
8. **핵심 검증**: `v.currentGridImages.length > 0` (그리드 정상 표시)

#### 29-4. 그리드 복귀 시 보이는 영역 썸네일 즉시 로드
1. Ctrl+클릭 폴더(unknown) → 그리드 로드 (3000개)
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
1. unknown 폴더 로드 → Measure 버튼 클릭 → MC 패널 열기
2. FBT 키 하나 클릭 → Measure heatmap 적용 (이미지에 gradient 표시)
3. 5초 대기 (이미지 로드 완료)
4. 다른 FBT 키 클릭 → Measure 맵 전환
5. **핵심 검증**: 뷰포트 내 `.grid-thumb-img` 중 `opacity < 1`인 이미지 비율 < 20%
6. **핵심 검증**: 뷰포트 내 이미지의 `img.src`가 `data:` (placeholder)인 비율 < 10%
7. 3초 대기 후 모든 뷰포트 이미지의 `opacity === '1'` 확인

**pass 기준**: 전환 중 회색 배경 없이 이전 이미지가 유지되고, 새 이미지 로드 후 정상 교체

---

### Phase 31: unknown grade 다양성 검증

**목적**: unknown 이미지들의 grade가 0~7로 다양하게 분포되어 있는지 검증

**배경**:
- positions JSON에 `g` 필드가 없어서 모든 chip이 grade 0으로 렌더링됨
- 수정: `_assign_grade()` 함수로 chip 좌표 기반 해시 → grade 0~7 균등 분배

**평가 항목**:
1. unknown 폴더의 첫 이미지를 단일 이미지 모드로 열기
2. `chipAnnotator.chips`에서 각 chip의 BIN 값 분포 확인 (다양한 BIN 존재)
3. `/api/image?path=unknown/unknown_wafer_0001_...` 원본 이미지 요청
4. **핵심 검증**: 이미지 pixel에서 grade 0~7 각각의 pixel 수가 전체의 5% 이상 (8 grade 모두 존재)
5. 또는 로컬 Playwright `page.evaluate`로 canvas에 이미지를 그려 pixel color 분석
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
1. `v.loadImagesInFolderAndShowGrid('unknown')` → 4초 대기
2. 스크롤을 8000px로 설정
3. `v.loadImagesInFolderAndShowGrid('unknown')` → 3초 대기
4. **핵심 검증**: `scrollWrapper.scrollTop === 0`

#### 32-2. updateFileExplorerSelection 경로 (Ctrl+클릭 시뮬레이션)
1. `v.loadImagesInFolderAndShowGrid('unknown')` → 4초 대기
2. 스크롤을 8000px로 설정
3. `fetch('/api/files?path=unknown')` → `v.selectedImages = files` → `v.updateFileExplorerSelection()`
4. 700ms 대기
5. **핵심 검증**: `scrollWrapper.scrollTop === 0`

#### 32-3. 연속 폴더 전환
1. unknown 로드 → 스크롤 5000px → unknown 로드 → 스크롤 확인
2. unknown 로드 → 스크롤 3000px → unknown 로드 → 스크롤 확인
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
v.loadImagesInFolderAndShowGrid('unknown');
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
2. **핵심 검증**: Failbit 라벨 = 파일명만 (접두사 없음, 예: `unknown_wafer_0001_EE_Engineer`)
3. **핵심 검증**: BIN 라벨 = `BIN_` 접두사 (예: `BIN_unknown_wafer_0001_EE_Engineer`)
4. **핵심 검증**: FBT 라벨 = 대문자 + 4자리 패딩 (예: `F0085_unknown_wafer_0001_EE_Engineer`)
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

#### 33-7. 단일 이미지 모드의 다중 상태 차단
1. 33-5 상태(단일 이미지)에서 레거시처럼 `v._measureCheckedItems`에 2개 이상을 주입
2. `v._applyMeasureSelection()` 실행
3. **핵심 검증**: `v.gridMode === false` (단일 이미지를 그리드로 강제 전환하지 않음)
4. **핵심 검증**: `v._measureCheckedItems.length === 1`
5. Measure 패널을 다시 열어 체크된 Measure가 1개이고 다른 항목 선택 시 기존 항목이 해제되는지 확인

#### 33-7a. 단일 이미지 Measure stale 응답/bitmap/navigator
1. 실제 unknown 이미지 1장을 단일 보기로 진입하고 FBT 또는 QVL을 적용
2. `v._measureOverlayRendered === true`, `currentImageBitmap`의 크기와 pixel sample을 확인
3. 서로 다른 두 Measure 요청을 빠르게 발생시켜 늦은 첫 응답이 현재 bitmap을 덮어쓰지 않는지 확인
4. Navigator의 `currentImageIndex`가 `selectedImagePath`의 정규화된 목록 인덱스와 일치하는지 확인
5. 첫 Measure → 다른 Measure → 원본/초기화 순서에서 흰 화면, 배경만 보이는 화면, 늦은 minimap 갱신이 없는지 확인

#### 33-7b. SYSTEMATIC 단일 이미지 raw-map/네비게이터 정합성
1. `unknown/CenterDonut/AAI633_00P_08_20260501_010000_99.6_0_PE_PWQ.png`를 단일보기로 연다.
2. SYSTEMATIC을 적용하고 `285,286,287,288,290,291,300,385,386,388,389,390`만 필터되는지 확인한다.
3. **핵심 검증**: 본 이미지 `/api/image` 요청과 pyramid cache key에 `bin_overlay=1` 및 동일한 `bottom_filter`가 포함되고, raw-map 요청으로 덮어써지지 않는다.
4. **핵심 검증**: SYSTEMATIC을 ETC/검정 단일색으로 강제하지 않고 오버레이에 실제 BIN별 색상이 표시된다.
5. **핵심 검증**: Navigator URL은 `/api/thumbnail`의 동일한 `bin_overlay=1&bottom_filter=...` 표현이며 `/api/bin-map-thumb`가 아니고, 선택 인덱스/색상 픽셀이 본 이미지와 일치한다.

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

#### 33-10. 컨텍스트 메뉴 Measure 전수 표시 (CTX_MAX 제거 회귀 검증)
1. 그리드 이미지 선택 → 우클릭 → "Measure 만들기" 호버
2. **핵심 검증**: 서브메뉴에 FBT 전체 수량 표시 (이전 CTX_MAX=10 제한 없음)
3. **핵심 검증**: MAP, BIN, FBT 섹션 + 적용 버튼 표시
4. `_renderMcList({mode:'measure'})` 통합 렌더링 확인

#### 33-11. 다중 Measure N배 증식 방지 회귀 검증
1. 다중 measure 3개 적용 → `_measureBaseImages=null` 후 `showGrid(10개, true)` 호출
2. **핵심 검증**: `_measureBaseImages.length === 10`, `currentGridImages.length === 30` (10×3)
3. **핵심 검증**: 재호출 `showGrid(currentGridImages, true)` → base=10 유지, grid=30 유지 (30→90 증식 없음)
4. 초기화 후: `currentGridImages.length === 10`, `_gridMeasureMap === null`

#### 33-12. 탭 전환 시 measure stale 데이터 초기화
1. measure 활성 상태 설정 후, `overlayMode=null`, `_measureCheckedItems=[]` 복원 시뮬레이션
2. **핵심 검증**: `_gridMeasureMap === null`, `_measureBaseImages === null` (stale 데이터 제거)

#### 33-13. Measure/Composite 생성 시 LOT Mode 유지
1. LOT Mode ON → 다중 Measure → `showGrid()` 호출
2. **핵심 검증**: `viewer.lotMode === true` 유지 (해제되지 않음)
3. Composite 생성 후 원래 탭 전환 → `lotMode === true` 확인

**pass 기준**: 33-1~33-13 모든 핵심 검증 통과

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
1. unknown 로드 → 5개 이미지 Ctrl+클릭 선택
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
1. Measure가 활성인 상태에서 `loadImagesInFolderAndShowGrid('unknown')` 재호출
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

#### 34-9. mea 탭에서 Measure 패널 열기 → 체크 상태 복원 (구 Phase 41-4)
1. mea0 탭에서 Measure 버튼 클릭 → 패널 열림
2. **핵심 검증**: 해당 FBT 항목의 체크박스가 **체크된 상태**
3. **핵심 검증**: 다른 항목들은 미체크

**pass 기준**: 34-1~34-9 모든 핵심 검증 통과

---

### Phase 35: Measure Map 항목 순차 전환 + 미니맵/범례/필터 종합 검증

**목적**: Measure 패널에서 Failbit → BIN → FBT → QVL 순으로 항목을 전환하며 그리드 썸네일 URL, Navigator 썸네일, Gradient 범례(비율/갯수/필터), 단일 이미지 렌더링을 종합 검증. 3회 반복으로 상태 누적 버그를 탐지.

**배경**:
- `_selectFailbitItem()` 호출 시 `overlayMode`, `_gridMeasureMap`, `_ratioGradientCache` 상태 전환
- `_ratioGradientCache`가 hex 문자열 또는 RGB 배열일 수 있음 — `renderGridColorLegend`의 `hexToRgb`가 양쪽 모두 처리해야 함
- BIN 모드에서 `getPersonalizedParams()`와 `_buildMeasureThumbUrl` 모두 `bin_overlay=1`을 추가하면 중복 발생
- 단일 이미지에서 `_renderMeasureOnCanvas` 완료 후 `renderColorLegends()` 미호출 시 gradient count가 0으로 표시

**발견 및 수정한 버그 (2026-03-23)**:

| # | 버그 | 커밋 | 수정 내용 |
|---|------|------|---------|
| 1 | BIN `bin_overlay=1` URL 중복 | 52a34ac | `_buildMeasureThumbUrl`에서 `getPersonalizedParams`에 이미 포함된 경우 추가 안 함 |
| 2 | FBT/QVL 단일 이미지 gradient 범례 count가 모두 0 | 52a34ac | `_renderMeasureOnCanvas` 완료 후 `renderColorLegends()` 호출 추가 |
| 3 | `_ratioGradientCache` RGB 배열 시 `hexToRgb` 크래시 | 52a34ac | grid/single 모드 모두 배열+문자열 양쪽 처리 |
| 4 | gradient 칩 내부 글자 크기 작음/넘침 | 52a34ac | 개별 칩 크기 기반 폰트 + `measureText` 자동 축소 |
| 5 | Composite 단일 이미지에서 더블클릭 시 검은 화면 | e66b41d | `exitSingleImageViewMode`에서 Composite 상태 정상 복원 |
| 6 | mea 탭 생성 후 원래 탭에 measure 상태 잔류 | e66b41d | `_openMeasureTab`에서 persist 전에 overlay/measure 상태 해제 |
| 7 | 다중 Measure 초기화 시 확장된 이미지 갯수 유지 | e66b41d | `_measureBaseImages`로 복원 후 null 리셋 + `renderColorLegends()` |
| 8 | Measure Composite LoginId 폴더 분리 (`ho.choi` vs `ho_choi`) | da05881 | `measure_composite.py`에서 `_sanitize_login_id()` 적용 |
| 9 | Composite 생성 시 원래 그리드 탭 소멸 → LOT Mode 깨짐 | 31abed3 | `ensurePageForRole` → `createPage`로 변경, 원래 탭 보존 |
| 10 | Composite 단일→더블클릭 복귀 시 3000개 원본 표시 (10개여야 함) | 31abed3 | `savedViewState.images`를 항상 현재 그리드로 갱신 |
| 11 | MC 드롭다운 FBT/QVL 라벨 `FBT9105 Count` → `FBT9105` | e537f7c | 드롭다운은 원래 라벨, 결과 파일명만 `_sum` |
| 12 | Composite 결과 파일명 `FBT_9105_average` → `FBT_9105_sum` | e537f7c | aggregation `average` → `sum`, modeLabel도 `_sum` |
| 13 | Composite 생성 시 LOT 모달이 Composite 탭에 잔류 | cc5fe31 | `hideLotListModal()` 호출 추가 |
| 14 | Composite 결과가 LOT Mode 무시하고 flat 그리드 표시 | 598026f | `showGrid`에서 `!isCompositeMode` 조건 제거 |
| 15 | 다중 Composite 경로에서 FBT/QVL aggregation이 `average`로 전송 | e767169 | `_startMultipleMeasureComposites`에서도 `sum`으로 통일 |
| 16 | Measure Composite 재생성 시 이전 파일 미삭제 | e767169 | 같은 prefix(FBT/QVL/BIN)의 이전 .png/.jpg/.webp/.npz 자동 삭제 |
| 17 | Wafer Map Explorer 파일 직접 클릭 후 single 복귀 시 3000장 그리드가 1장으로 축소 | 2026-05-01 | 파일 클릭 전 이전 grid return state 저장, single exit에서 더 큰 saved grid list 우선, fast restore에서 `currentGridImages/selectedImages` 재주입 |

**정상 확인된 기능 (수정 후 검증 완료)**:

| 기능 | 검증 내용 | 상태 |
|------|---------|------|
| Failbit 원본 이미지 표시 | 그리드 `/api/thumbnail` URL, Grade 범례 비율/갯수 | ✅ |
| BIN 오버레이 | 그리드 `bin_overlay=1` 1회만, 단일 이미지 BIN 번호 + 색상 | ✅ |
| FBT/QVL measure-thumb | 그리드 `/api/measure-thumb` URL, gradient 범례 10개 | ✅ |
| 단일 이미지 Measure heatmap 렌더링 | Canvas gradient 색상 + 값 텍스트, 칩 크기 적응형 폰트 | ✅ |
| Gradient 범례 비율/갯수 | 단일 이미지에서 `10.2%(39)` 등 non-zero count 표시 | ✅ |
| Gradient 범례 필터 클릭/해제 | 클릭→`selectedGradientRanges.size=1`, 해제→`size=0` | ✅ |
| Navigator 표시 및 이미지 전환 | 단일 이미지에서 Navigator visible, 클릭으로 다른 이미지 전환 | ✅ |
| Navigator measure-thumb 반영 | Navigator 썸네일 URL에 `/api/measure-thumb` 포함 | ✅ |
| Bottom legend (BIN) 비율/갯수 | Normal 92.2%(354) 등 정상 표시 | ✅ |
| Composite Map 생성 및 그리드 | 10개 결과 이미지 (square avg, Grade 0~7), gradient 범례 | ✅ |
| Composite 단일→더블클릭 복귀 | com 탭으로 정상 복귀, 검은 화면 없음 | ✅ |
| Composite gradient 범례 count | Grade 이미지에서 `99.2%(1.8K)` 등 표시 | ✅ |
| 4개 항목 × 3회 반복 안정성 | 12/12 PASS, JS 에러 0건, 상태 누적 버그 없음 | ✅ |
| mea 탭 원래 탭 상태 분리 | 원래 탭 `overlayMode=null`, measure 해제 | ✅ |
| 다중 Measure 초기화 이미지 복원 | 15개(확장) → 5개(원본) 정상 복원 | ✅ |
| Composite 생성 후 원래 탭 보존 | page0(그리드) + com0(composite) 2탭 유지 | ✅ |
| Composite 후 LOT Mode 정상 동작 | 원래 탭 복귀 시 lotHeaders=6, 토글 OFF→0/ON→6 | ✅ |
| Composite 결과 LOT Mode 그룹핑 | Grade(8) + square(2) LOT 헤더 표시 | ✅ |
| Composite 탭에서 LOT 모달 숨김 | Composite 진입 시 lotModalVisible=false | ✅ |
| Composite 결과 파일명 sum | `FBT_9105_sum.png`, aggregation=sum | ✅ |
| MC 드롭다운 라벨 | `FBT9105` (Count 없이 원래 형태) | ✅ |
| 다중 Composite 동시 생성 | Grade+FBT+BIN 3개 동시 → 12개 이미지 (10+1+1) | ✅ |
| Measure Composite 파일 자동 교체 | FBT_1000_sum → FBT_1100_sum (이전 삭제 + 새로 생성) | ✅ |
| 서버 파일 확인 | `composite_map/notsaml/` 내 .jpg + .npz 정상 | ✅ |

**평가 항목**:

#### 35-1. 그리드 모드 4개 항목 순차 전환 (3회 반복)
1. unknown 폴더 로드 → 3000개 이미지 확인
2. 아래 순서를 **3회 반복** (Round 1~3):
   - `v._selectFailbitItem('failbit')` → 2초 대기
     - **검증**: `overlayMode === null`, 썸네일 URL에 `/api/thumbnail` 포함
   - `v._selectFailbitItem('reset')` → `v._selectFailbitItem('bin')` → 2초 대기
     - **검증**: `overlayMode === 'bin'`, 썸네일 URL에 `bin_overlay=1` 포함
     - **핵심 검증**: `bin_overlay`가 URL에 **1회만** 존재 (중복 없음)
   - `v._selectFailbitItem('reset')` → `v._selectFailbitItem('f', '1000')` → 2초 대기
     - **검증**: `overlayMode === 'f'`, 썸네일 URL에 `/api/measure-thumb` 포함
     - **검증**: grid-color-legend-bottom에 `data-section="gradient"` 항목 10개 존재
     - **핵심 검증**: JS 에러 없음 (`hexToRgb` 크래시 방지)
   - `v._selectFailbitItem('reset')` → `v._selectFailbitItem('q', '5000')` → 2초 대기
     - **검증**: `overlayMode === 'q'`, 썸네일 URL에 `/api/measure-thumb` 포함
     - **검증**: gradient 범례 10개 존재
   - `v._selectFailbitItem('reset')` → 0.5초 대기

#### 35-2. 단일 이미지 모드 Measure 렌더링 + Navigator + 범례
1. FBT1000 선택 → 그리드 첫 이미지 더블클릭 → 단일 이미지 진입
2. 8초 대기 (measure-composite-data API 응답 + canvas 렌더링)
3. **핵심 검증**: `gridMode === false`, `overlayMode === 'f'`
4. **핵심 검증**: Navigator visible, `imageList.length > 0`
5. **핵심 검증**: Navigator 썸네일 URL에 `/api/measure-thumb` 또는 `/api/thumbnail` 포함
6. **핵심 검증**: 상단 범례(`color-legend-top`)에 `data-section="gradient"` 항목 10개
7. **핵심 검증**: gradient 범례 bar에 비율/갯수 텍스트가 **"0"이 아닌** 값 1개 이상 존재
   (예: `10.2%(39)`, `11.7%(45)` 등)
8. 하단 범례(`color-legend-bottom`)에 BIN 항목 존재 확인

#### 35-3. Gradient 범례 필터 클릭 테스트
1. 35-2 상태에서 gradient 범례 첫 번째 항목 (0~10%) 클릭
2. **핵심 검증**: `v.selectedGradientRanges.size === 1`
3. 우클릭으로 필터 해제 (`clearGradientFilter`)
4. **핵심 검증**: `v.selectedGradientRanges.size === 0`

#### 35-4. 그리드 복귀 후 BIN URL 중복 방지
1. 단일 이미지에서 그리드 복귀
2. `v._selectFailbitItem('bin')` → 2초 대기
3. 첫 번째 이미지 URL에서 `bin_overlay` 문자열 출현 횟수 확인
4. **핵심 검증**: `bin_overlay` **1회만** 출현

#### 35-5. Navigator 클릭으로 Measure 이미지 전환
1. FBT1000 선택 → 그리드 첫 이미지 더블클릭 → 단일 이미지 진입
2. 4초 대기 (Measure canvas 렌더링 완료)
3. Navigator 두 번째 썸네일 클릭
4. 4초 대기 (새 이미지 Measure 렌더링)
5. **핵심 검증**: `selectedImagePath`가 이전과 다름 (이미지 전환됨)
6. **핵심 검증**: Measure canvas 렌더링 완료 (`[MEASURE] Canvas 렌더링 완료` 로그 확인)
7. **핵심 검증**: gradient 범례 count가 "0"이 아닌 값 포함 (새 이미지에서도 갱신됨)

#### 35-6. Composite Map 생성 + LOT Mode + 탭 보존 + 파일명 검증
1. unknown 전체 선택, **LOT Mode ON** 상태에서 Composite Map 생성 (20개 이미지)
2. 12초 대기 (서버 생성 완료)
3. **핵심 검증**: `isCompositeMode === true`, 그리드에 결과 이미지 10개 표시
4. **핵심 검증**: gradient 범례 10개 존재 (grid-color-legend-bottom)
5. **핵심 검증**: 원래 그리드 탭(page0) + Composite 탭(com0) **2개 탭 존재** (원래 탭 소멸 방지)
6. **핵심 검증**: Composite 탭에서 **LOT Mode 그룹핑 적용** — `lotHeaders >= 2` (Grade, square 등)
7. **핵심 검증**: Composite 탭에서 **LOT 모달 숨김** — `lot-list-modal.style.display === 'none'`
8. **핵심 검증**: FBT/QVL Measure Composite 결과 파일명이 `_sum` 포함 (예: `FBT_9105_sum.png`)
9. 더블클릭 → 단일 Composite 이미지 진입
10. **핵심 검증**: Navigator visible, 이미지 목록 > 0
11. **핵심 검증**: gradient 범례 필터 클릭 → `selectedGradientRanges.size === 1`
12. 필터 해제 → `selectedGradientRanges.size === 0`
13. 그리드 복귀 → 다른 이미지(Grade) 더블클릭 → 정상 전환 확인
14. 원래 그리드 탭으로 전환 → **핵심 검증**: `lotMode === true`, `lotHeaders === 6`, `isCompositeMode === false`
15. LOT Mode 토글 OFF→ON → **핵심 검증**: OFF 시 `lotHeaders === 0`, ON 시 `lotHeaders === 6`

#### 35-7. Composite 단일 이미지 더블클릭 → 그리드 복귀 (이미지 사라짐 방지)
1. Composite 그리드 표시 상태에서 첫 번째 이미지 더블클릭 → 단일 이미지 진입
2. 단일 이미지에서 다시 더블클릭
3. **핵심 검증**: Composite 그리드(com 탭)로 정상 복귀, 검은 화면 없음
4. **핵심 검증**: `isCompositeMode === true`, **결과 이미지 10개 표시** (3000개 원본이 아닌)
5. **핵심 검증**: 새 com 탭이 추가 생성되지 않음 (detail page 삭제 후 origin 복귀)
6. **핵심 검증**: `savedViewState.images`가 현재 Composite 그리드(10개)로 갱신됨

#### 35-8. Measure 탭 생성 후 원래 탭 상태 해제
1. unknown 그리드에서 이미지 5개 선택
2. FBT1000 measure 클릭 → mea0 탭 생성
3. 원래 그리드 탭으로 전환
4. **핵심 검증**: 원래 탭에서 `overlayMode === null`, `_measureCheckedItems.length === 0`
5. **핵심 검증**: 원래 탭의 썸네일이 일반 `/api/thumbnail` URL (measure-thumb 아님)

#### 35-9. 다중 Measure 초기화 시 이미지 갯수 복원
1. unknown 그리드에서 Failbit + BIN + FBT1000 3개 체크
2. `_applyMeasureSelection()` → 이미지 갯수 = baseImages × 3 확인
3. 초기화 (`_measureCheckedItems = []` + `_measureBaseImages` 복원)
4. **핵심 검증**: 이미지 갯수 = 원본 baseImages 갯수 (확장 해제)
5. **핵심 검증**: `overlayMode === null`, `_gridMeasureMap === null`
6. **핵심 검증**: gradient 범례 → Grade 범례로 복원

#### 35-10. Measure Composite 서버 파일 생성/삭제/교체 검증
1. unknown 20개 선택 → Grade Composite + FBT1000 + BIN285 동시 생성
2. 15초 대기 (서버 생성 완료)
3. **핵심 검증**: `composite_map/{LoginId}/` 디렉터리에 파일 존재 확인
   - `Grade_0.jpg` ~ `Grade_7.jpg` (8개)
   - `square_average.jpg`, `square_weighted_average.jpg` (2개)
   - `FBT_1000_sum.jpg` (파일명에 `_sum` 포함)
   - `BIN_285_count.jpg` (파일명에 `_count` 포함)
   - `measure_composite_data.npz` (캐시)
   - `square_maps_data.npz` (Grade 캐시)
4. **이전 파일 교체 테스트**: FBT1100 + QVL5000 생성
5. **핵심 검증**: `FBT_1000_sum.jpg` **삭제됨**, `FBT_1100_sum.jpg` **새로 생성**
6. **핵심 검증**: `QVL_5000_sum.jpg` **새로 생성**
7. **핵심 검증**: `BIN_285_count.jpg`는 **그대로 유지** (다른 prefix)
8. **"No chip values found" 에러**: `item_key`가 positions 파일의 `ftn_keys`에 없으면 발생
   - 테스트 데이터(unknown)의 ftn_keys 범위: `1000~1499` (500개)
   - 존재하지 않는 key (예: `9001`) 요청 시 서버 에러 정상 반환 확인
   - 프론트엔드에서 `alert('Measure Composite 생성에 실패했습니다: ...')` 표시 확인

#### 35-11. Composite MC 드롭다운 UI 검증
1. MC 패널 열기 → Composite 드롭다운 표시
2. **핵심 검증**: 드롭다운 패널 `max-height: min(520px, 60vh)` — 뷰포트 비례
3. **핵심 검증**: 생성 버튼(`.mc-generate-wrap`)이 항상 보임 (`flex-shrink: 0`)
4. **핵심 검증**: FBT 항목 라벨이 `FBT9105` 형태 (Count 없음)
5. **핵심 검증**: QVL 항목 라벨이 `QVL5000` 형태 (Count 없음)

#### 35-12. 더블클릭 반복 그리드↔단일 전환 안정성 (3회 이상)
1. unknown 폴더 로드 → 3000개 이미지 확인
2. **3회 반복**: 더블클릭 → 단일 이미지 진입 → 더블클릭 → 그리드 복귀
3. **핵심 검증**: 매 복귀 시 `currentGridImages.length === 3000` (이미지 사라지지 않음)
4. **핵심 검증**: 매 복귀 시 `gridMode === true`, 그리드 DOM children > 0
5. **핵심 검증**: 검은 화면 없음 (뷰포트 내 로드된 이미지 비율 > 50%)
6. **핵심 검증**: `gridViewImageList.length > 0` (다음 진입을 위한 상태 보존)
7. Composite 탭에서도 동일 테스트: com0 그리드 → 더블클릭 → com1 단일 → 더블클릭 → com0 복귀 × 3회

**발견 버그 (2026-03-25)**: `exitSingleImageViewMode`에서 `gridViewImageList = []`로 초기화 후
미복원 — 2번째 더블클릭 복귀 시 `imagesToShow`가 빈 배열 → 검은 화면.
수정: 복귀 후 `gridViewImageList = [...imagesToShow]`로 재설정.

#### 35-13. Composite 비동기 생성 + 탭 전환 안정성
1. unknown 전체 선택 → Grade + FBT1000 Composite 생성 시작
2. **즉시** page0 탭으로 전환 (생성 완료 전)
3. 15초 대기 (서버 비동기 생성 완료)
4. **핵심 검증**: JS 에러 없음 (alert 미발생)
5. com0 탭으로 전환 → `isCompositeMode === true`, `images > 0`
6. **핵심 검증**: 결과 이미지 정상 표시 (검은 화면 없음)

#### 35-14. 단일 Measure 선택 시 LOT Mode 유지
1. unknown LOT Mode ON → FBT1000 단일 선택
2. **핵심 검증**: `lotMode === true`, LOT 헤더 존재
3. **핵심 검증**: LOT 그룹 레이아웃 깨지지 않음 (lot-header + lot-spacer)
4. Measure 초기화 → LOT Mode 유지, Grade 범례 복원

**발견 버그**: 단일 Measure 선택 시 `refreshGridThumbnailsWithCurrentParams()`가 LOT 그룹 레이아웃 무시
수정: LOT Mode에서는 `showGridByLot(currentGridImages)` 호출

#### 35-15. 더블클릭 반복 5회 + Navigator/Minimap 안정성
1. unknown 그리드 → **5회 반복**: 더블클릭 단일 → 더블클릭 그리드 복귀
2. **핵심 검증**: 매 단일 진입 시 Navigator visible, imageList.length > 0
3. **핵심 검증**: 매 단일 진입 시 Minimap canvas visible
4. **핵심 검증**: 매 복귀 시 currentGridImages.length === 3000, gridViewImageList.length > 0
5. **핵심 검증**: 5회 모두 검은 화면 없음

**pass 기준**: 35-1~35-15 모든 핵심 검증 통과, 더블클릭 반복 5회 안정, LOT Mode 유지, 서버 파일 정상

---

## 결과 보고

각 Phase별로 pass/fail 요약표를 작성하세요:

| Phase | 항목 | 결과 | 비고 |
|-------|------|------|------|
| 1 | 페이지 로드 & 기본 UI | pass/fail | |
| 2 | 폴더 & 그리드 + 스크롤 성능 + 정렬 | pass/fail | 로드 시간, 로드율, 9개 정렬 검증 |
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
| 12-6 | MY LOT 디스크 파일 복사 | pass/fail | 이미지+positions 파일 복사 확인 |
| 12-7 | MY LOT 수동 항목 영구 보존 | pass/fail | _manual.json + 새로고침 후 유지 |
| 12-8 | MY LOT Grid 보기 + Chip 로드 | pass/fail | 보기/Grid 보기 + 더블클릭 chip positions |
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
| 31 | unknown grade 다양성 | pass/fail | grade 0~7 균등, 다양한 색상 |
| 32 | 폴더 전환 스크롤 리셋 | pass/fail | 모든 경로에서 scrollTop===0 |
| 33 | Measure 다중선택 전체 | pass/fail | UI/라벨/선택필터/단일전환/Navigator/404placeholder |
| 34 | Measure 탭 분리 + 폴더 전환 유지 | pass/fail | mea 탭 생성/키 교체/원탭 복귀/미선택 바꿔치기/폴더 전환 유지 |
| 35 | Measure Map + Composite 종합 검증 | pass/fail | 35-1~35-10: 4항목×3회, gradient, Navigator, LOT Mode, 탭 보존, 더블클릭 복귀, MC UI |
| 36 | 성능 벤치마크 | pass/fail | 페이지/그리드/단일/Composite/Measure 속도 |
| 37 | 이미지 무결성 검증 | pass/fail | 깨짐/X표시/이상 맵 샘플링 |
| 38 | 인덱스 빌드 + 검색 벤치마크 | pass/fail | 500만+ 파일 검색/로드 성능 |
| 39 | Measure Map 다중 생성 + Navigator 전환 | pass/fail | F/B/Q/범례/필터/탭 복원 |
| 40 | Subset Composite Map | pass/fail | 선택 Grade → Sum Map |
| 41 | Composite 탭 전환 안정성 | pass/fail | 더블클릭→ESC→탭전환 |
| 42 | 다중 Measure 더블클릭 overlay 타입 보존 | pass/fail | Navigator/그리드 타입 유지 |
| 43 | Label Explorer 네비게이션 및 그리드↔단일 전환 | pass/fail | savedViewState/경계 이동/복귀 |
| 44 | Chip Label Explorer CRUD + 캐시 + 속도 | pass/fail | chip 모드 전용 Label Explorer |
| 45 | Measure 색상 변경 미리보기/적용 | pass/fail | 실시간 반영/즉시 닫힘/복원 |
| 46 | HTTP 캐시 무효화 | pass/fail | no-cache/ETag/stale cache 방지 |
| 47 | Composite 색상 매핑 + 배경 행 제거 | pass/fail | BIN/F/Q/square는 Composite 색만 추종 |
| 48 | Measure 첫 진입 즉시 로드 + 폴더 stale state | pass/fail | 첫 적용 지연/폴더 클릭 오염 방지 |
| 49 | Label Explorer 그리드 로드 실패 + chip-positions 404 | pass/fail | flat-grid/positions 없는 unknown/PNF/복귀 안정성 |
| 50 | 검색 첫 실행 + 다중검색 + 이벤트루프 블로킹 | pass/fail | 첫 검색/모달/noise LOT/비동기 검색 |

핵심 단계마다 스크린샷을 촬영하여 첨부하세요.

## 속도 측정 (Performance Report)

**모든 맵 로드와 생성 속도를 측정하여 결과에 포함합니다.**

### 필수 측정 항목

| 항목 | 측정 방법 | 기준 |
|------|----------|------|
| 페이지 초기 로드 | `navigate` ~ `.folder-item` DOM attached | < 500ms |
| unknown (3000장) 그리드 로드 | `loadImagesInFolderAndShowGrid` ~ grid children 생성 | < 300ms |
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
| 페이지 초기 로드 | 458ms | FAST |
| unknown 그리드 로드 | 205ms | FAST |
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

## Phase 36: 성능 벤치마크

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
await v.loadImagesInFolderAndShowGrid('unknown');
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
- pyvips indexed-color PNG 깨짐 발견 → PIL 유지 (indexed-color index 보존)
- JPEG Q=95, TJSAMP_444 동일 (1월 커밋 대비 검증)
- 단일 이미지 Measure: Canvas에서 개인색 배경 + gradient 칩 + bold 숫자 텍스트

**페이지 콜드스타트 (2,883ms → 458ms, ▼84%) — 2026-03-28 업데이트**

측정 조건:
- **페이지 초기 로드**: 서버를 새로 시작한 직후 새 브라우저 창으로 UI에 접속하여 측정
- **3000개 그리드 로드**: 썸네일 캐시 삭제 후 서버를 새로 시작한 직후 새 브라우저 창으로 UI에 접속하여 측정
- 측정 방식: `goto(domcontentloaded)` + `waitForSelector('.folder-item', { state: 'attached', timeout: 600 })`
- limit: 페이지 로드 < 500ms, 그리드 로드 < 300ms

Cold-start 10회 결과 (2026-03-28):
```
Page load:  avg 458ms  min 433ms  max 487ms  (limit 500ms, ALL PASS)
Grid load:  avg 205ms  min 190ms  max 232ms  (limit 300ms, ALL PASS)
```

이전 기록:

병목 원인 5가지와 수정 내용:

| # | 병목 원인 | 영향 | 수정 | 효과 |
|---|----------|------|------|------|
| 1 | `_cleanup_pycache()` 매 시작 실행 — `os.walk` 전체 트리 순회 + `shutil.rmtree` | DEFAULT executor 300~500ms 점유, GIL 경합으로 모든 요청 지연 | 시작 시 제거 (배포 시점에만 수행) | executor 해방 |
| 2 | `run_in_executor(None, ...)` — DEFAULT executor 사용 | 인덱스 로드/빌드가 DEFAULT executor를 점유, 요청 핸들러도 같은 executor 경합 | `IO_POOL`/`DIRLIST_EXECUTOR` 전용 executor로 분리 | GIL 경합 감소 |
| 3 | `logs/color-legends.json` StaticFiles 서빙 — 112MB access.log 옆 FS 캐시미스 | 첫 요청 시 OS가 112MB 파일 메타데이터를 캐시하느라 1.5초 지연 | 메모리 캐시 + ETag 304 (서버 시작 시 `read_bytes()` → 메모리) | 1,589ms → 2ms |
| 4 | `browse-folders` 중첩 ThreadPoolExecutor — DIRLIST_EXECUTOR 내에서 새 ThreadPool 생성 | GIL 경합 + 스레드 스폰 오버헤드, 콜드스타트 시 207ms | 중첩 제거 → `DIRLIST_EXECUTOR` 직접 사용 + 결과 메모리 캐시(60초 TTL) + 시작 시 프리로드 | 207ms → 31ms |
| 5 | HTML/JS/CSS 무압축 전송 — 696KB (HTML 64 + JS 531 + CSS 101) | 네트워크 전송 + 브라우저 파싱 시간 증가 | pre-gzip: 서버 시작 시 `gzip.compress()` → `Content-Encoding: gzip` 직접 서빙 (GZipMiddleware Python 3.13 버그 우회) | 696KB → 147KB (▼79%) |
| 6 | 백그라운드 init GIL 경합 — 인덱스 빌드가 서버 시작 직후 실행 | 단일 워커에서 인덱스 빌드(CPU/IO 집약)가 이벤트 루프를 굶김, 모든 API 4~6초 지연 | 백그라운드 init 10초 지연 시작 + 단계 사이 `asyncio.sleep(0)` yield | 첫 페이지 로드 시 경합 제거 |
| 7 | `list_dir_fast` 중첩 ThreadPoolExecutor — 100개+ 파일 시 새 ThreadPool 생성 | 인덱스 빌드 중 GIL 경합으로 api/files 10.9초 지연 | 중첩 제거 → 순차 처리 (이미 DIRLIST_EXECUTOR에서 실행) | 10,965ms → 48ms |
| 8 | `_walk_and_collect` GIL 독점 — os.walk 전체 순회 중 GIL 미해제 | 인덱스 빌드 중 모든 API 응답 3~11초 지연 | `time.sleep(0.01)` 매 10 디렉토리 + `_build_lookup_indices` 매 5000건 yield | 인덱스 빌드 중에도 API 48ms 응답 |
| 9 | IndexService `run_in_executor(None)` — DEFAULT executor 사용 | 인덱스 빌드가 DEFAULT executor 점유 | IO_POOL 전용 executor 주입 (`index_service._io_pool = IO_POOL`) | executor 분리 |

콜드스타트 측정 결과 (2026-03-27 19:26, 서버 준비 직후 17ms 만에 측정):

```
서버 시작    19:26:00.467
서버 준비    19:26:02.624  (부팅 2.2초)
측정 시작    19:26:02.643  (준비 후 19ms)

리소스          응답시간   전송크기   순수API(TLS제외)
─────────────────────────────────────────────────
HTML(gzip)      214ms     11KB      ~4ms
main.js(gzip)   220ms     122KB     ~10ms
style.css(gzip) 209ms     14KB      ~0ms
config          220ms     -         ~10ms
color-legends   223ms     13KB      ~13ms
browse-folders  242ms     78KB      ~32ms
files(3000개)   282ms     575KB     ~72ms
image(5MB)      298ms     5MB       ~88ms
thumbnail       356ms     19KB      ~146ms(생성)
```

> 각 curl은 개별 TLS 핸드셰이크(~210ms) 포함. 브라우저는 HTTP/2로 TLS 1회.
> 브라우저 실제 체감: TLS 210ms + API 병렬 ~100ms + JS 파싱 ~200ms ≈ **~500ms**

BEFORE vs AFTER 비교:

| 항목 | BEFORE | AFTER | 개선 |
|------|--------|-------|------|
| DOMContentLoaded | 2,883ms | 422ms | ▼85% |
| browse-folders API | 1,589ms | 32ms | ▼98% |
| color-legends API | 1,589ms | 2ms | ▼99% |
| HTML 전송 | 64KB | 11KB | ▼83% |
| JS 전송 | 531KB | 122KB | ▼77% |
| CSS 전송 | 101KB | 14KB | ▼86% |
| 총 전송량 | 696KB | 147KB | ▼79% |

콜드스타트 전체 플로우 측정 (2026-03-27 19:33, 서버→페이지→폴더→그리드):

```
19:33:43.332  서버 시작
19:33:45.463  서버 준비              +2.1s
19:33:45.478  측정 시작              +15ms (준비 직후)
19:33:46.233  페이지 리소스 완료     +755ms (HTML 11KB + JS 122KB + CSS 14KB, 모두 gzip)
19:33:46.995  초기 API 완료          +762ms (config + color-legends + browse-folders)
19:33:47.305  unknown 파일목록    +310ms (3000개, 575KB)
19:33:51.774  그리드 썸네일 16장     +4,469ms (순차 curl, 각각 TLS 210ms 포함)
```

> 브라우저 실제 체감 (HTTP/2 병렬): TLS 1회(210ms) + 리소스 병렬(~100ms) + API(~30ms) + 파일목록(~70ms) + 썸네일 병렬(~350ms) ≈ **~760ms**
> curl 순차 측정은 각 요청마다 TLS 핸드셰이크(~210ms)를 포함하므로 실제보다 느리게 보임

기술 세부:
- pre-gzip: Python 내장 `gzip` 모듈, 추가 패키지 불필요, Python 3.8+ 모든 버전 호환
- `save_color_legends()` 호출 시 자동 캐시 갱신 (래퍼 함수)
- browse-folders 캐시: 60초 TTL, 시작 시 프리로드
- 백그라운드 init 10초 지연: 첫 페이지 로드 윈도우 확보, 이후 인덱스 빌드 정상 진행

---

### 버그 수정 이력

> **⚠️ 중요: 속도 측정 필수**
> 모든 UI 동작은 실행 시간을 `performance.now()` 로 측정하고 기록해야 한다.
> 특히 아래 항목은 **회귀 감지를 위해 매 E2E 실행마다 반드시 측정**한다:
>
> | 항목 | 기준 | 측정 방법 |
> |------|------|-----------|
> | 페이지 로드 (cold) | < 500ms | `.folder-item` DOM attached 시점 |
> | 그리드 로드 (cold, 3000장) | < 300ms | 첫 30개 썸네일 visible 시점 |
> | 색 변경 모달 닫힘 (취소) | < 50ms | `performance.now()` cancel click → `is-open` 제거 |
> | 색 변경 모달 닫힘 (적용) | < 100ms | `performance.now()` apply click → `is-open` 제거 |
> | 색 미리보기 반영 | < 2000ms | gradient 변경 → 그리드 이미지 src 갱신 완료 |
> | 새로고침 후 색 일관성 | 100% | 새로고침 전후 `cacheBuster === lastModified` |
> | Composite 생성 (14장) | < 10s | API 응답 완료 |
>
> 속도가 기준을 초과하면 **WARN**으로 기록하고 원인을 코드에서 추적한다.

#### BUG-1: 페이지 초기 로드 — init() 2단계 순차 실행 (2026-03-28)
**증상**: 페이지 로드 시 API 호출이 2단계로 순차 실행되어 불필요한 대기
**수정**: `index.html` prefetch + `init()` 6개 API 병합 `Promise.all` + `hardResetUiCaches`/`change-folder` fire-and-forget
**결과**: Cold-start avg 458ms (limit 500ms) → PASS
**파일**: `index.html`, `js/main.js`

#### BUG-2: Composite 그리드에 비이미지 파일 노출 (2026-03-28)
**증상**: Composite 생성 후 `.npz`, `.json` 캐시 파일이 그리드에 표시
**수정**: `/api/files` 이미지 확장자 화이트리스트 + `loadImagesInFolderAndShowGrid()` `isImageFile()` 체크
**파일**: `api/main.py`, `js/main.js`

#### BUG-3+6: 색 변경 시 Composite 그리드 미반영 — 적용 흐름 (2026-03-28)
**증상**: 색상 편집기에서 Grade/Gradient 색 변경 후 적용 → 단일 이미지만 반영, 그리드는 이전 색상 유지
**원인**: (BUG-3) recolor API 미호출 + (BUG-6) `refreshCompositeGridImages(sumMaps)` sum maps만 갱신, Grade 미갱신
**수정**: `handleApply()` + `_handleApplyGradient()` — composite 폴더 전체 재로드 (`refreshGridThumbnailsWithCurrentParams`)
**파일**: `js/color-editor.js`

#### BUG-4: Composite 히트맵 저장 속도 병목 (2026-03-28)
**증상**: `save_heatmaps+sum_maps` 6초 소요
**수정**: PIL PNG 무압축 → TurboJPEG Q95. 결과: 6.07s → 1.75s (▼71%)
**파일**: `api/composite_map.py`

#### BUG-5+7: Label Explorer 캐시 무효화 실패 (2026-03-28)
**증상**: (BUG-5) Chip label 등록 후 Ctrl+클릭 시 그리드 미표시 + (BUG-7) Fail List 클릭 후 Label Explorer 미갱신
**원인**: `classToImgListCache` 무효화 없음 + 폴더 닫힘 시 `refreshLabelExplorer` 미호출
**수정**: 항상 `refreshLabelExplorer([cls])` + 캐시 무효화 + dirty class 전달
**파일**: `js/main.js`

#### BUG-8: Label Explorer Measure 그리드 더블클릭 시 raw map 표시 (2026-03-28)
**증상**: Measure 적용 후 더블클릭 → raw map 표시 (measure map 아님)
**원인**: `_gridMeasureMap`이 null일 때 fallback 없음
**수정**: `enterSingleImageMode()` + `enterGridImageViewMode()` — `_measureCheckedItems[0]` fallback
**파일**: `js/main.js`

#### BUG-9: Composite/Measure 생성 시 개인색 미적용 (2026-03-28)
**증상**: Composite 생성 후 default 흑백 gradient 표시, 개인색 미적용
**원인**: 개인색으로 직접 생성 → NPZ에 bake-in → recolor 불가 + NPZ 비동기 저장 → recolor 시 FileNotFoundError
**수정 (아키텍처 변경)**:
```
생성: default color → NPZ(default) + 이미지(default)
  ↓ 즉시 recolor: NPZ에서 개인색 적용 → 이미지 교체
  ↓ 색 변경 시: recolor API → NPZ에서 새 색상 → 이미지 교체
```
- composite/measure 생성 `scheme="default"` → 생성 후 자동 recolor
- NPZ 저장 daemon thread → 동기 (recolor가 즉시 참조)
- NPZ 파일명 `measure_cache_{mode}_{key}.npz`로 분리 (충돌 방지)
**파일**: `api/main.py`, `api/composite_map.py`, `api/measure_composite.py`

#### BUG-10: Composite/Measure 색 변경 **미리보기** 시 서버 캐시 미무효화 (2026-03-29)
**증상**: 색상 편집기에서 gradient 색 변경 시 미리보기(실시간)가 그리드에 반영 안 됨. 적용은 OK
**원인**: `save_composite_color_settings()`에서 `save_color_legends(legends)` 호출 시 `updated_scheme_name` 미전달 → `lastModified` 미갱신 → 썸네일 캐시 경로(`thumbnails/{scheme}/{lastModified}/`) 불변 → 기존 파일 반환
**수정**: `save_color_legends(legends, updated_scheme_name=scheme_key)` — composite + measure 2곳
**테스트**: Composite 그리드 → 전체 stop #00FF00 → square 초록 즉시 반영 확인
**파일**: `api/composite_colors.py`

#### BUG-11: 색 변경 모달 취소/적용 시 수초 지연 (2026-03-29)
**증상**: 취소/적용 클릭 시 모달이 수초간 안 닫힘
**원인**: `close()`에서 `await fetch()` × 3 + `await showGrid()` 전부 완료 후 DOM 숨김
**수정**: 모달 DOM 숨기기 최상단 배치 → 서버 복원/그리드 리로드는 fire-and-forget 백그라운드
**결과**: 취소 4ms, 적용 52ms
**파일**: `js/color-editor.js`

#### BUG-12+13: 색 변경 후 새로고침 시 구버전 썸네일 표시 — 브라우저 캐시 + cacheBuster 고정 (2026-03-29)
**증상**: 개인색 변경 → 적용 → 즉시 반영 → 새로고침 → 구버전 색상 또는 이전/현재 혼합 표시. Edge 정상, Chrome만 발생. 썸네일 폴더에는 정상 생성됨
**원인 2가지**:
1. **(BUG-12) 서버 HTTP 캐시**: `Cache-Control: max-age=86400~31536000` → Chrome 디스크 캐시가 서버에 안 물어보고 구버전 반환
2. **(BUG-13) cacheBuster 고정**: `_personalizedColorCacheBuster`가 `if (!val)` 조건으로 한 번만 설정 → 구버전 `lastModified`로 고정 → URL `_t=` 불일치 → 혼합 캐시
**수정**:
- **서버**: 모든 이미지/썸네일/JS/CSS 응답 `Cache-Control: no-cache` (약 20곳). `no-cache` = 매번 ETag 확인, 변경 없으면 304 (빠름)
- **프론트엔드 fetch**: `cache: 'no-cache'`, `Cache-Control: 'no-cache'` 항상 적용 (조건부 제거)
- **cacheBuster**: `if (!val)` 조건 제거 → 항상 `lastModified`에서 최신값 갱신 (`getPersonalizedParams`, `loadColorLegends` 2곳)
**테스트**:
1. thumbnails 삭제 → 서버 재시작 → unknown 로드 → `cacheBuster === lastModified` 일치 확인
2. background #FF0000 적용 → 모든 이미지 빨간 배경
3. 페이지 새로고침 → unknown 재로드 → **빨간 배경 100% 유지** (혼합 없음)
**결과**: cacheBuster=260329130912 = lastModified → PASS
**파일**: `api/main.py` (약 20곳), `js/main.js` + `js/main.min.js` (`getPersonalizedParams`, `loadColorLegends`, `fetchOptions`)

### 통합 검증 결과 (2026-03-28~29, Playwright UI 직접 확인)

```
=== 2026-03-28 ===
✓ Page load (cold):               454ms (limit 500ms)
✓ Grid load (cold, no thumbs):    264ms (limit 300ms)
✓ Personal color grid:            scheme=notsaml, personalized=true
✓ Composite create (14 imgs):     outputDir=composite_map/notsaml
✓ Non-image filter:               10 files, 0 nonImage
✓ Composite default→recolor:      "default → notsaml recolor 완료: 2개"
✓ Composite grid 개인색:           Grade=개인색, Square=개인 gradient
✓ Composite 색 변경 적용:          gradient → recolor 2개 → 그리드 즉시 반영
✓ Measure composite (BIN/FBT/QVL): 3개 전부 default→recolor 완료
✓ Measure 더블클릭 overlay:        overlayMode='f', measure_overlay URL 포함

=== 2026-03-29 (BUG-10~13 수정 후 클린 테스트) ===
✓ Composite 미리보기:              11개 stop #00FFFF → square 시안색 즉시 반영
✓ 취소 모달 속도:                  4ms (이전: 수초)
✓ 취소 후 원복:                    원래 gradient 복원
✓ 적용 모달 속도:                  52ms
✓ 적용 후 반영:                    square 빨간색 즉시 반영
✓ cacheBuster=lastModified:        260329130912 일치
✓ 새로고침 후 색 유지:             빨간 배경 100% 유지 (혼합 없음)
Result: 17/17 PASS
```

### 미완료 검증 항목

1. ~~색 변경 모달 Composite 탭 미리보기+적용+취소~~ → **검증 완료 (2026-03-29)**
2. **Measure 색 변경 모달**: measure 탭 gradient 변경 → 이미지 즉시 반영 (개발 환경 position 데이터 없어 미검증)
3. **Gradient/Grade/BIN 범례 필터**: 범례 바 클릭 → 필터 동작
4. **composite_map 폴더 파일 검증**: default NPZ + 개인색 recolor 이미지 공존

테스트 방법:
```
서버 kill → rm -rf composite_map thumbnails → 서버 시작 → 새 Playwright 접속
→ unknown 그리드 → 14개 선택 → Composite 생성
→ composite 그리드 → 색 변경 모달 → gradient/background 변경 → 미리보기 → 적용 → 반영 확인
→ 새로고침 → 변경색 유지 확인
→ 취소 → 원복 확인
```

### E2E 벤치마크 변경 사항 (2026-03-28)

| 항목 | 이전 | 변경 | 비고 |
|------|------|------|------|
| 페이지 로드 limit | 5000ms | **500ms** | cold-start avg 458ms |
| 그리드 로드 limit | 3000ms | **300ms** | cold avg 205ms |
| 측정 방식 | `waitForTimeout(2000)` | `waitForSelector('.folder-item', state: 'attached', timeout: 600)` | 실제 interactive 시점 측정 |
| 측정 조건 | 미명시 | 서버 재시작 + 새 브라우저 + 썸네일 삭제(그리드) | cold-start 기준 |

---

## Phase 37: 이미지 무결성 검증 (깨짐/X표시/이상 맵 확인)

모든 이미지 경로에서 깨진 이미지, X표시, 잘못된 맵이 없는지 전방위 확인합니다.

### 36-1. 그리드 썸네일 무결성

1. `unknown` 로드 → 뷰포트 내 이미지 30개 대기 (최대 20초)
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

## Phase 38: 인덱스 빌드 + 검색 벤치마크 (대용량)

`benchmark_4m` 폴더(400만 더미 파일)를 포함한 대용량 환경에서 인덱스 빌드, 캐시 로드, 검색 성능을 측정합니다.

> **전제**: `D:/project/data/wm-811k/benchmark_4m/` 에 400폴더 × 10000파일 = 400만 더미 파일이 존재해야 합니다.
> 파일명 패턴: `lot_XXXX_step_YYYYY_WZZ_EE_Engineer.png`

### 37-1. 더미 파일 존재 확인

1. `benchmark_4m` 폴더 400개 확인
2. 각 폴더 10000개 파일 확인 (샘플 3개 폴더)
3. **pass 기준**: 400폴더, 각 10000파일

### 37-2. 인덱스 빌드 (cold) + 토큰 역인덱스

1. 캐시 파일 삭제 (`.file_index_cache.txt`)
2. 서버 시작 → 인덱스 빌드 완료 대기
3. **측정 항목 3개**:
   - **파일 스캔 + 캐시 저장**: `os.walk`로 전체 파일 수집 + `.file_index_cache.txt` 저장
   - **토큰 역인덱스 빌드**: 파일명 `_` split → LOT/폴더/토큰 dict 생성
   - **총 빌드 시간**: 스캔 + 캐시 + 토큰 인덱스 합산
4. 서버 로그에서 확인:
   ```
   [INDEX] Build complete: 5010725 files (4.13s)
   [INDEX] Lookup indices built: 1031 LOTs, 16 folders, 14328 tokens (1.70s)
   ```
5. **pass 기준**:
   - 파일 스캔 + 캐시 저장: < 6초
   - 토큰 역인덱스: < 3초
   - 총 빌드: < 10초
   - 파일 수 > 400만

### 37-3. 빌드 중 서비스 유지 검증

1. 서버 시작 직후 (인덱스 빌드 중) `unknown` 그리드 로드
2. **pass 기준**: `v.currentGridImages.length === 3000`, 썸네일 30개 즉시 로드
3. 빌드 중에도 `/api/files`, `/api/thumbnail` 정상 응답
4. 이전 캐시가 있으면 `ready=true` 유지 (빌드 중에도 검색 가능)

### 37-4. 캐시 로드 + 역인덱스 재생성 벤치마크

서버 재시작 시 캐시가 있으면 스캔 없이 캐시 로드 + 토큰 역인덱스만 재생성:

1. 캐시 파일 존재 확인 (`.file_index_cache.txt`, ~285MB)
2. **측정 항목 2개**:
   - **캐시 로드**: 텍스트 파일 읽기 + keys/names 리스트 생성
   - **역인덱스 재생성**: LOT/폴더/토큰 dict 재빌드
3. 서버 로그에서 확인:
   ```
   [INDEX] Cache load complete: 5010725 files (1.51s)
   [INDEX] Lookup indices built: 1031 LOTs, 16 folders, 14328 tokens (1.70s)
   ```
4. **pass 기준**:
   - 캐시 로드: < 3초
   - 역인덱스 재생성: < 3초
   - 총 시간(로드+역인덱스): < 6초

### 37-5. 검색 벤치마크 (토큰 역인덱스 기반)

**검색 API**: `GET /api/search?q={검색어}&limit=5000&folder={폴더}&lot_multi={LOT목록}`

**데이터**: unknown (LOT 6개 × 500개 = 3000개) + benchmark_4m (400만 더미) = 501만 파일

**검색 방식 — 위치별 토큰 역인덱스 (token[0] / token[2])**:
빌드 시 파일명을 `_` split하여 **위치별** 인덱스를 생성 (대소문자 무시):
- `token0_index`: token[0] (LOT) 위치별 인덱스 → **모든 검색의 기본**
- `token2_index`: token[2] (WAFER) 위치별 인덱스 → **AND 오른쪽 전용**
- `token_index`: 전체 위치 인덱스 (fallback)

**핵심 규칙**:
1. 모든 검색어는 **token[0]에 포함(contains)**되는 파일만 검색 (대소문자 무시)
2. `A and B`: token[0] contains A → 그 결과에서 token[2] contains B
3. `A or B`: (token[0] contains A) ∪ (token[0] contains B)
4. 결과 패턴: 단일 `A` → `*A*_*_*_*`, AND `A and B` → `*A*_*_*B*_*`

```python
# 빌드 시 (서버 시작 1회):
# AAU220_00P_13_20260501_010000_96.0_2_EE_PWQ.png → parts: [aau220, 00p, 13, 20260501, 010000, 96.0, 2, ee, pwq]
token0_index = {
    'aau220': [...],            # token[0]=aau220인 unknown 파일
    'aai216': [...],            # token[0]=aai216인 unknown 파일
    'lot':    [...],            # benchmark_4m 파일들
}
token2_index = {
    '13':     [x,y,z,...],      # token[2]=13인 unknown 파일
    'step':   [...],            # benchmark_4m 파일들
}

# 검색 시:
# 단순 "aai216" → token0_index에서 'aai216' 포함 키 찾기 → 즉시 반환 (2.4ms)
# AND "aau220 and 13" → token0에서 aau220, token2에서 13 → 교차
# LOT multi → lot_index dict에서 O(1) 룩업 (8ms)
```

**7가지 검색 방식 + 입력 예시 + 결과 + 속도**:

| # | 방식 | 검색창 입력 / API 쿼리 | 결과 | 최적화 전 | 최적화 후 | 개선 |
|---|------|----------------------|------|----------|----------|------|
| 1 | 단순 검색 (token[0]) | `AAV489` → `q=AAV489&folder=` | >0개 | 233ms | **2.4ms** | 97x |
| 2 | 부분매칭 (token[0]) | `AU22` → `q=au22&folder=` | >0개 (AAU220 LOT) | 233ms | **2.5ms** | 93x |
| 3 | AND (token[0]+[2]) | `AAU220 and 13` → `q=AAU220+and+13` | >0개 | 994ms | **1.0ms** | 994x |
| 4 | AND/OR | `(AAU220 and 13) or (ABM792 and 05)` | >0개 | 994ms | **75ms** | 13x |
| 5 | 부분 AND | `au22 and 07` → `q=au22+and+07` | >0개 | 210ms | **35ms** | 6x |
| 6 | 폴더 한정 | `aau220` (unknown 선택 상태) | >0개 | 3ms | **2.1ms** | — |
| 7 | LOT multi | 다중검색 모달 noise 6줄 입력 | >0개 | 739ms | **8ms** | 92x |

> **주의**: 단순/부분매칭은 token[0] 전용, AND 왼쪽은 token[0], AND 오른쪽은 token[2]. 대소문자 무시. Phase 51 참조.

**pass 기준**:

| 검색 모드 | 기준 |
|----------|------|
| 단순/부분매칭 | < 10ms |
| AND | < 10ms |
| AND/OR | < 200ms |
| 부분 AND | < 100ms |
| 폴더 한정 | < 10ms |
| LOT multi | < 20ms |

**평가 방법**:
```javascript
// API 직접 호출로 서버 응답 시간 측정
const t0 = performance.now();
const resp = await fetch('/api/search?q=aai216&limit=3000&folder=');
const data = await resp.json();
const ms = Math.round(performance.now() - t0);
// data.total > 0, data.timings.total_ms < 기준값
```

### 37-6. 다중검색 Noise 파싱 + 결과 검증

1. 다중검색 모달에서 noise 포함 6개 LOT 입력:
   ```
   AAU220.J1 13
   ABM792.2\t05
   AAI216.abc 13
   AAV489 11
   AAU220.X2\t13.1
   ABM792.99 05
   ```
2. **파싱 검증**: 콘솔에서 `LOT 목록 전달: 6개 - aau220,abm792,aav489,aai216,aad534,aai158` 확인
3. **결과 검증**: 현재 `unknown`에 존재하는 LOT 결과만 표시
4. **pass 기준**: noise 전부 제거, 6 LOT 정확 추출, 이미지 정상 표시

### 37-7. 텍스트 검색 UI (스크린샷 검증)

1. 검색창에 `(AAU220 and 13) or (ABM792 and 05)` 입력 → 검색 버튼 클릭
2. **결과 검증**: 그리드에 이미지 표시, LOT 패널에 AAU220 + ABM792
3. 스크롤하여 AAU220 영역과 ABM792 영역 각각 스크린샷
4. AAU220 파일명에 `_13_` 포함, ABM792 파일명에 `_05_` 포함 확인
5. **pass 기준**: 결과 > 0, 두 LOT 모두 표시, 이미지 정상

### 37-8. 텍스트 단순 검색 UI

1. 검색창에 LOT ID 입력 (예: `ABM792`) → 검색 버튼 클릭
2. **pass 기준**: 해당 LOT 이미지만 표시, 개수 > 0

### 결과 요약표

| 항목 | 기준값 | 실측 |
|------|-------|------|
| 인덱스 빌드 (500만+ 파일) | < 10초 | 4.13초 |
| 토큰 역인덱스 빌드 | < 10초 | ~6초 (빌드 포함) |
| 캐시 로드 | < 5초 | 1.51초 |
| 빌드 중 그리드 로드 | 즉시 | 3000장 + 30썸네일 즉시 |
| 단순 전체 검색 (토큰) | < 10ms | 2.4ms |
| 부분매칭 검색 | < 10ms | 2.5ms |
| AND/OR 검색 | < 200ms | 75ms |
| LOT multi (6개) | < 20ms | 8ms |
| 폴더 한정 검색 | < 10ms | 2ms |
| 다중검색 noise 파싱 | 6 LOT 정확 추출 | ✅ |
| AND/OR UI 스크린샷 | 두 LOT 모두 표시 | ✅ |

---

## Phase 39: Measure Map 다중 생성 + Navigator 전환 + 범례/필터 검증

**목적**: Measure Map(Failbit/BIN/FBT/QVL) 다중 생성 후, 각 결과 이미지를 Navigator/Prev/Next/더블클릭으로 전환하며 gradient 범례·필터·텍스트·미니맵이 정상 동작하는지 3라운드 반복 검증

**배경**:
- Measure Map은 overlay가 아닌, chip별 item value로 gradient를 계산하여 독립 이미지를 생성
- Navigator 클릭 시 `loadImage(path, false)` 호출에서 composite mode가 해제되던 버그 수정됨 (viewMode === 'gridImage' 조건 추가)
- 서버사이드 텍스트 font_size가 24px 상한으로 대형 캔버스에서 읽을 수 없던 버그 수정됨 (칩 크기 비례 0.35 적용)

**평가 항목**:

### 38-1. Measure Map 다중 생성 (Failbit + BIN + FBT + QVL)

1. unknown 폴더 24개 이미지 그리드 로드 → 전체선택
2. Measure 패널 열기 → 패널 구조 확인:
   - MAP 섹션: Failbit (1개)
   - BIN 섹션: NORMAL, BIN285~BIN390 (11+개)
   - FBT 섹션: FBT1000~FBT1499 (500개)
   - QVL 섹션: QVL5000~QVL5499 (500개)
3. Failbit + BIN285 + FBT1000 + QVL5000 체크 → "생성 (4)" 버튼 활성
4. 생성 클릭 → 완료 대기 (최대 30초)
5. 결과 그리드 확인:
   - square_average, square_weighted_average (2개)
   - Grade_0 ~ Grade_7 (8개)
   - BIN_285_count (1개)
   - FBT_1000_average (1개)
   - QVL_5000_average (1개)
   총 13개 이미지

### 38-2. 그리드 Gradient 범례 검증

1. 결과 그리드 상단 범례에 Gradient (0~10% ~ 90~100%) 10개 항목 표시
2. 각 항목에 퍼센트와 칩수 텍스트 존재 (예: "39.8%(459)")
3. 하단 BIN 범례도 표시 (nor, inv, 285~390, ETC)

### 38-3. 단일 뷰 진입 + 범례 + 미니맵 검증 (FBT)

1. FBT_1000_average 더블클릭 → 단일 뷰 진입
2. `v.isCompositeMode === true` 확인
3. Gradient 범례 (0~10% ~ 90~100%) + 퍼센트/칩수 텍스트 확인
4. BIN 범례 (Normal, BIN types) + 퍼센트/칩수 텍스트 확인
5. 미니맵 표시 확인
6. Navigator에 13개 썸네일 표시 확인
7. 50% 줌 → 칩 내 텍스트 (K/M 축약 숫자) 가독성 확인

### 38-4. Navigator 전환 시 Composite Mode 유지 (BIN → QVL)

1. Navigator에서 BIN_285_count 클릭
2. `v.isCompositeMode === true` 유지 확인
3. **핵심 검증**: 상단 범례가 Grade(G0~G7)가 아닌 Gradient(0~10%~90~100%) 표시
4. Navigator에서 QVL_5000_average 클릭
5. `v.isCompositeMode === true` 유지 확인
6. Gradient 범례 + 퍼센트/칩수 확인

### 38-5. Prev/Next 버튼 전환 시 Composite Mode 유지

1. FBT_1000_average 단일 뷰에서 ◀ (Previous) 클릭 → BIN_285_count로 이동
2. `v.isCompositeMode === true` 유지 확인
3. Gradient 범례 표시 확인
4. ▶ (Next) 클릭 → FBT_1000_average 복귀
5. ▶ 다시 → QVL_5000_average로 이동
6. Gradient 범례 유지 확인

### 38-6. Gradient 필터 클릭 동작 검증

1. 단일 뷰에서 Gradient 범례 "90~100%" 클릭
2. `v.selectedGradientRanges.has(9) === true`
3. 범례 갱신: 90~100% = "100.0%(N)", 나머지 = "0.0%(0)"
4. 비선택 범위 칩이 흰색/투명 처리 (스크린샷)
5. 다시 클릭 → 해제, 전체 복원
6. Ctrl+클릭으로 0~10% + 90~100% 다중 선택 → `v.selectedGradientRanges.size === 2`
7. 우클릭 → 전체 해제

### 38-7. ESC → 그리드 복귀 → 다시 더블클릭 (3라운드 반복)

각 라운드에서 다른 이미지 타입 진입:
- 라운드 1: BIN_285_count → 범례 확인 → ESC → 그리드 복귀
- 라운드 2: QVL_5000_average → 범례 확인 → ESC → 그리드 복귀
- 라운드 3: FBT_1000_average → Prev → BIN → 범례 확인 → ESC → 그리드 복귀

각 라운드 검증:
1. 더블클릭 후 `v.isCompositeMode === true`
2. Gradient 범례 표시 (Grade 범례가 아님)
3. ESC 후 그리드 모드 복귀 + `v.isCompositeMode === true` 유지
4. 그리드 Gradient 범례 유지

### 38-8. 칩 텍스트 가독성 검증 (서버사이드 렌더링)

1. Measure Composite 결과 이미지(FBT_1000_average)를 50% 줌으로 표시
2. 칩 내부에 K/M 축약 값 텍스트가 보이는지 스크린샷 확인
3. 텍스트가 칩 영역을 넘지 않는지 확인 (overflow 방지)
4. 대비 색상: 밝은 배경 → 검정 텍스트, 어두운 배경 → 흰색 텍스트

**pass 기준**:
- 38-1: 4개 항목 생성 → 13개 결과 이미지
- 38-2: 그리드 Gradient 범례 10개 + 칩수
- 38-3: FBT 단일 뷰 Gradient 범례 + 미니맵 + Navigator
- 38-4: Navigator 전환 시 isCompositeMode 유지 + Gradient 범례 (NOT Grade)
- 38-5: Prev/Next 전환 시 Composite Mode 유지
- 38-6: Gradient 필터 단일/다중 선택/해제 정상
- 38-7: 3라운드 ESC→그리드→더블클릭 모두 Composite Mode + Gradient 범례 유지
- 38-8: 50% 줌에서 칩 텍스트 가독성 확인

---

## Phase 40: Subset Composite Map (선택 Grade → Sum Map) 검증

**목적**: Failbit Composite 생성 후 특정 Grade만 선택하여 Subset Sum Map을 생성하는 기능이 정상 동작하는지 검증

**배경**:
- Subset Map은 Full Composite(Grade 0~7 전체) 결과에서 사용자가 원하는 Grade만 골라 해당 Grade들로만 재계산한 sum map
- `updateContextMenuState()`에서 `context-composite-create` 요소가 없을 때 early return하여 subset 메뉴가 표시되지 않던 버그 수정됨
- 트리거 경로: 그리드 우클릭 → `🎯 선택 Grade Composite Map` / 단일 이미지 우클릭 → `#single-composite-subset`
- API: `POST /api/composite-subset` (output_dir, selected_grades, lot_mode)

**평가 항목**:

### 39-1. Failbit Composite 생성 + Grade 선택

1. unknown 24개 이미지 → 전체선택 → Measure 패널에서 Failbit만 체크 → 생성
2. 결과 그리드: square_average, square_weighted_average, Grade_0~7 (10개)
3. `v.isCompositeMode === true` 확인
4. 전체선택 (`v.selectAllGridImages()`) → `gridSelectedIdxs.length === 10`
5. `v.getSelectedGradesFromGrid()` → Set(0,1,2,3,4,5,6,7)

### 39-2. 컨텍스트 메뉴 Subset 항목 표시

1. Composite 결과 그리드에서 우클릭 → `showContextMenu()` 호출
2. `context-subset-map-create` 요소: `display === 'block'` (NOT 'none')
3. 텍스트: `🎯 선택 Grade Composite Map`
4. **핵심 검증**: `updateContextMenuState()`에서 `context-composite-create` 없어도 subset 처리까지 도달

### 39-3. 특정 Grade 선택 후 Subset Map 생성

1. Grade_2, Grade_5만 선택 (나머지 해제)
2. `v.getSelectedGradesFromGrid()` → Set(2, 5)
3. `v.createSubsetMap()` 호출
4. API 호출 확인: `POST /api/composite-subset` body에 `selected_grades: [2, 5]`
5. 결과: `square_average_25.jpg`, `square_weighted_average_25.jpg` (subset sum maps) 생성
6. 결과 그리드에 subset 이미지 추가됨

### 39-4. 단일 이미지 모드에서 Subset 메뉴

1. Composite 결과 이미지(Grade_2) 더블클릭 → 단일 뷰 진입
2. 우클릭 → `#single-composite-subset` 표시 (`isCompositeContext === true`)
3. 클릭 → `createSubsetMap()` 호출 가능

### 39-5. Subset 결과 이미지 검증

1. Subset sum map 이미지가 그리드에 표시됨
2. 이미지가 정상 로드됨 (broken image 없음)
3. Full Composite sum map과 다른 색상 분포 (subset은 특정 Grade만 포함하므로 값이 다름)

**pass 기준**:
- 39-1: Failbit Composite 10개 결과 + Grade 8개 인식
- 39-2: 우클릭 메뉴에 Subset 항목 표시 (display: block)
- 39-3: Grade 2,5 선택 → Subset API 호출 → subset sum map 생성
- 39-4: 단일 이미지 모드에서도 Subset 메뉴 표시
- 39-5: Subset 결과 이미지 정상 렌더링

---

## Phase 41: Composite 탭 전환 안정성 (더블클릭→ESC→탭전환)

**목적**: Composite 결과 그리드에서 더블클릭→단일뷰→ESC→원래 탭 복귀, 수동 탭 전환 시 검은화면 방지

**배경**:
- `/api/files` 응답의 `item.path`가 절대경로(`D:/project/data/...`)로 반환되어 `/api/image`, `/api/thumbnail` 호출 시 404 발생
- `exitSingleImageViewMode`에서 `saveState` 변수를 선언 전에 참조 (TDZ ReferenceError)
- detail 탭(com1)에서 ESC 시 origin 탭(com0)으로 자동 복귀하지 않음

**평가 항목**:

### 40-1. Composite 결과 이미지 경로 상대경로 확인

1. Measure Composite 생성 (FBT1000 등)
2. 결과 그리드의 이미지 경로 확인: `v.selectedImages[0]`
3. **핵심 검증**: 경로가 `composite_map/notsaml/...` 형태 (절대경로 `D:/...` 아님)
4. 썸네일 URL: `/api/thumbnail?path=composite_map%2F...` (정상 로드)

### 40-2. 더블클릭→단일뷰→이미지 로드 성공

1. Composite 결과 이미지 더블클릭 → 단일 뷰 진입
2. 이미지 정상 로드 (404 에러 없음)
3. `v.selectedImagePath`가 상대경로

### 40-3. ESC → 원래 탭(com0) 복귀

1. 단일 뷰에서 ESC 키
2. **핵심 검증**: `v.pageManager.activePageId`가 origin 탭(com0)으로 복귀
3. `v.gridMode === true`
4. 그리드 이미지 정상 표시 (검은화면 아님)
5. `v.isCompositeMode === true` 유지
6. 콘솔에 `detail 탭 → origin 탭으로 복귀` 로그

### 40-4. 수동 탭 전환 시 이미지 표시

1. 더블클릭→단일뷰→ESC→com0 복귀 후
2. page0 탭 클릭 → 정상 전환
3. com0 탭 다시 클릭 → 그리드 이미지 정상 표시 (검은화면 아님)

### 40-5. 반복 더블클릭/ESC 사이클

1. com0에서 더블클릭 → ESC → com0 복귀 (3회 반복)
2. 매 사이클: gridMode=true, 이미지 표시, isComposite=true

**pass 기준**:
- 40-1: 상대경로 확인 (D:/ 미포함)
- 40-2: 단일 뷰 이미지 로드 성공 (404 없음)
- 40-3: ESC 시 origin 탭 복귀 + 그리드 표시
- 40-4: 수동 탭 전환 시 검은화면 없음
- 40-5: 3회 반복 안정성

**발견된 버그 및 수정 이력 (Phase 40)**:
1. **절대경로 버그**: `/api/files` 응답의 `item.path`가 `D:/project/data/...` 절대경로 → `loadImagesInFolderAndShowGrid`에서 상대경로 변환 추가
2. **TDZ ReferenceError**: `exitSingleImageViewMode`에서 `saveState` 변수를 선언 전 참조 → 선언 위치 이동
3. **ESC 복귀 미동작**: detail 탭(com1)에서 ESC 시 origin 탭(com0)으로 자동 복귀 안 됨 → `gridDetailOriginMap`으로 origin 탭 전환 + `skipApply` 옵션 추가
4. **탭 전환 시 상태 오염**: Composite 완료 시 `switchToPage`가 현재 탭 상태를 오염 → `persistActivePageState()` 후 `activatePage(skipPersist: true)` 사용
5. **수동 탭 전환 검은화면**: 위 절대경로 + 상태 오염 버그의 합산 결과 → 1~4 수정으로 해결

**검증 시나리오 (3가지 복귀 방법 모두 검증)**:
- **ESC 키**: com0 더블클릭 → com1 단일뷰 → ESC → com0 그리드 복원 (이미지 전체 표시)
- **캔버스 더블클릭**: com0 더블클릭 → com1 단일뷰 → 캔버스 영역 더블클릭 → com0 그리드 복원
- **수동 탭 클릭**: com0 더블클릭 → com1 단일뷰 → com0 탭 직접 클릭 → com0 그리드 복원 (검은화면 없음)
- **반복 안정성**: 위 3가지를 섞어 3회 반복 → 매 라운드 이미지 수 동일, isComposite 유지

---

## Phase 42: 다중 Measure 더블클릭 Navigator/그리드 overlay 타입 보존

**목적**: 다중 Measure(Failbit+BIN+FBT+QVL) 그리드에서 각 타입 이미지를 더블클릭하여 단일 이미지 모드 진입 시 Navigator 썸네일이 올바른 overlay 타입을 유지하고, 그리드 복귀 시 이미지 수와 타입 분포가 변하지 않는지 검증

**배경**:
- 다중 Measure 확장 시 동일 이미지가 4가지 타입(failbit/bin/f/q)으로 반복됨
- `_gridMeasureMap`이 각 그리드 인덱스의 measure 타입을 추적
- 더블클릭 시 `createPage→applyPageState`가 `_gridMeasureMap`을 초기화하는 버그 존재했음
- `groupImagesByLot`의 `pathToItem` Map이 동일 경로 중복으로 마지막 타입만 유지하는 버그
- `_buildMeasureThumbUrl`에서 `getPersonalizedParams()`가 전역 `overlayMode`에 의존하여 failbit에 bin_overlay 적용하는 버그

**사전 조건**: Phase 33 완료 (Measure 드롭다운 기본 동작)

**테스트 절차**:

#### 42-1. 다중 Measure 그리드 설정
1. `unknown` 폴더 로드, 3개 이미지 선택
2. `_measureCheckedItems = [failbit, bin, f(FBT1001), q(QVL5000)]` 설정
3. `_applyMeasureSelection()` 호출
4. **핵심 검증**: `currentGridImages.length === 12`, `_gridMeasureMap.length === 12`
5. **핵심 검증**: `_gridMeasureMap` 타입 분포 = `{failbit:3, bin:3, f:3, q:3}`
6. **핵심 검증**: `overlayMode === 'multi'`

#### 42-2. BIN 더블클릭 → Navigator 타입 분포 확인
1. BIN 인덱스(`_gridMeasureMap`에서 type==='bin'인 첫 번째) 더블클릭
2. 6초 대기 (이미지 로드 + positions 로드 + Navigator 렌더)
3. **핵심 검증**: Navigator 썸네일 URL 분포: `bin_overlay=1` 3개, `/api/thumbnail`(raw) 3개, `measure-thumb` 6개
4. **핵심 검증**: `_gridMeasureMap.length === 12`, `_measureCheckedItems.length === 4`
5. 스크린샷으로 캔버스(BIN overlay), Navigator(4타입 구분) 시각 확인

#### 42-3. 그리드 복귀 → 타입 보존 확인
1. `exitSingleImageViewMode()` 호출, 4초 대기
2. **핵심 검증**: `currentGridImages.length === 12` (증식 없음)
3. **핵심 검증**: `overlayMode === 'multi'`
4. **핵심 검증**: `_gridMeasureMap` 타입 분포 유지 = `{failbit:3, bin:3, f:3, q:3}`
5. 스크린샷으로 4열 그리드 시각 확인

#### 42-4. QVL 더블클릭 → Navigator 확인 → 복귀
1. QVL 인덱스 더블클릭, 6초 대기
2. **핵심 검증**: Navigator URL 분포 동일 (3 raw + 3 bin + 6 measure)
3. 복귀 후 `currentGridImages.length === 12`, `overlayMode === 'multi'`

#### 42-5. Failbit 더블클릭 → Navigator 확인 → 복귀
1. Failbit 인덱스 더블클릭, 6초 대기
2. **핵심 검증**: Navigator URL 분포 동일 (3 raw + 3 bin + 6 measure)
3. 복귀 후 `currentGridImages.length === 12`, `overlayMode === 'multi'`

#### 42-6. FBT 더블클릭 → Navigator 확인 → 복귀
1. FBT 인덱스 더블클릭, 6초 대기
2. **핵심 검증**: Navigator URL 분포 동일
3. 복귀 후 `currentGridImages.length === 12`, `overlayMode === 'multi'`

**pass 기준**: 42-1~42-6 모든 핵심 검증 통과, 4가지 타입 모두 더블클릭→복귀 후 이미지 수/타입 변동 없음

**pass 조건 요약**:
- 42-1: 그리드 12개, map 12개, 타입 분포 정확
- 42-2: Navigator 3+3+6 분포, map/mc 보존
- 42-3: 복귀 후 12개, overlay=multi, 타입 분포 유지
- 42-4: QVL 동일 검증
- 42-5: Failbit 동일 검증
- 42-6: FBT 동일 검증

---

## Phase 43: Label Explorer 네비게이션 및 그리드↔단일 전환 안정성

**목적**: Label Explorer에서 Wafer Map Explorer와 동일한 그리드/단일이미지 동작이 정상 작동하는지 검증

**사전 조건**: `unknown` 원본 이미지로 생성한 `e2e_unknown_label` 클래스가 존재

**평가 항목**:

#### 43-1. Label Explorer 단일 이미지 모드 진입
1. Label Explorer에서 클래스 폴더 열기 (예: `e2e_unknown_label`)
2. 이미지 1개 클릭 → `viewMode='single'`, 캔버스 표시
3. Navigator에 클래스 내 전체 이미지 리스트 표시 확인
4. ◀ ▶ 화살표 버튼 표시 확인
5. `_labelExplorerSingleMode === true` 확인

#### 43-2. 방향키 네비게이션 (← →)
1. → 키 → 다음 이미지로 이동, `singleViewImageIndex` 증가
2. ← 키 → 이전 이미지로 이동, `singleViewImageIndex` 감소
3. 마지막 이미지에서 → 키 → 폴더 이동 없이 멈춤 (로그: `Label Explorer 경계 — 마지막 이미지`)
4. 첫 이미지에서 ← 키 → 멈춤 (로그: `Label Explorer 경계 — 첫 번째 이미지`)

#### 43-3. 화살표 버튼 UI (◀ ▶) 클릭
1. ▶ 클릭 → 다음 이미지로 이동 확인
2. ◀ 클릭 → 이전 이미지로 이동 확인
3. 이미지 이름이 정상 변경되는지 확인 (헤더 바)

#### 43-4. Navigator 클릭 이동
1. Navigator에서 다른 이미지 클릭 → 해당 이미지 로드
2. `singleViewImageIndex` 변경 확인

#### 43-5. ESC로 단일 이미지 종료 → 초기 상태 복귀
1. ESC 키 → `viewMode=null`, 단일 이미지 숨김
2. Label Explorer 선택 해제 (`labelSelection.selected.length === 0`)
3. 초기 상태 메시지("파일을 선택하거나...") 표시 또는 이전 상태 복원

#### 43-6. 다중 선택 → 그리드 모드
1. 이미지 1개 클릭 → 단일 이미지 모드
2. Ctrl+Click 두 번째 이미지 → 그리드 모드 전환 (`gridMode=true`)
3. 그리드에 2개 이미지 표시 확인
4. `data-label-explorer-grid` attribute 존재 확인

#### 43-7. 그리드 더블클릭 → 단일 → ESC → 그리드 복귀 사이클
1. Ctrl+Click 클래스명 → 그리드 (3개 이미지)
2. 그리드 더블클릭 → 단일 이미지 진입 (`viewMode='gridImage'`)
3. `savedViewState`에 classification 이미지 없음 확인 (오염 방지)
4. ESC → 그리드 복귀 (`gridMode=true`, `data-label-explorer-grid=true`)
5. 단일 이미지 클릭 → `viewMode='single'`, 그리드 사라짐 (`gridVisible=false`)
6. ESC → 초기 상태 복귀 (`placeholder=true`, `savedViewState=null`)

#### 43-8. 그리드 컨텍스트 메뉴
1. 그리드 아이템 우클릭 → 컨텍스트 메뉴 표시 확인
2. 메뉴에 Composite, Measure 등 옵션 존재 확인

#### 43-9. Composite/Measure 버튼 동작 (Label Explorer 그리드)
1. Ctrl+Click 클래스 → 그리드 표시
2. Composite 버튼 클릭 → Composite 생성 모달/패널 표시
3. Measure 버튼 클릭 → Measure 패널 표시
4. `getSelectedImagesForModal()` 반환값에 원본 경로 포함 확인

#### 43-10. Label Explorer 라벨 추가 + Position 파일 복사
1. unknown 등 position JSON이 있는 폴더에서 이미지 5개 선택
2. Fail List 클래스 버튼 클릭 → 라벨 추가
3. `/api/files?path=classification/{class}` 확인: PNG 5개 + JSON(position) 5개 존재
4. Label Explorer에서 해당 클래스 열기 → **모든 파일 표시** (PNG + JSON 포함)
5. 단일 이미지 클릭 → chip positions는 `POSITIONS_ROOT`에서 로드 (classification 내 JSON 아님)

#### 43-11. 모든 파일 타입 표시 (필터 없음)
1. classification 폴더에 PNG + JSON + TXT 혼재된 클래스 열기
2. Label Explorer 리스트에 **모든 파일** 표시 확인 (isImageFile 필터 제거됨)
3. Ctrl+Click → 그리드에도 **모든 파일** 표시 확인 (썸네일 실패는 정상)

#### 43-12. 빈 폴더 Ctrl+Click — UI 보호
1. 빈 클래스 폴더 Ctrl+Click
2. 상단 그리드 컨트롤(컬럼 수, 전체선택 등) `display` 변경 없음 확인
3. 뷰어 영역이 빈 검은 화면으로 바뀌지 않음 확인

#### 43-13. 라벨 삭제
1. 🗑️ 버튼 클릭 → 이미지 삭제 확인
2. Delete Label 버튼으로 다중 삭제 확인
3. Delete Class로 테스트 클래스 정리

#### 43-14. 혼합 이미지 유형 클래스 (no-indexed-color/indexed-color/position)
**사전 준비**: `e2e_mixed_test` 클래스에 3가지 유형 이미지 배치:
- `rgba_no_pos_*.png`: RGBA non-indexed-color, position 없음
- `unknown_no_pos_*.png`: indexed-color PNG, position 없음
- `AAD534_00C_*.png`: indexed-color PNG, position은 `POSITIONS_ROOT/e2e_mixed_test/` 에 JSON 배치

1. Label Explorer에서 `e2e_mixed_test` 폴더 열기 → 모든 파일 표시 (필터 없음)
2. Ctrl+Click → 폴더 자동 열림 + 파일 버튼 하이라이트 + 그리드 아이템 표시
3. 이미지 썸네일 정상 로딩 (비이미지 파일은 썸네일 실패 정상)
4. indexed-color+pos 이미지 더블클릭 → 단일 뷰 정상, `POSITIONS_ROOT`에서 384 chips 로드 확인
5. RGBA 이미지 더블클릭 → 단일 뷰 정상, `currentImageBitmap` 존재
6. → 키로 6개 전체 순회: unknown_no_pos → unknown_pos → rgba_no_pos 순서로 정상 전환
7. 서버 생존 확인

#### 43-15. 프리페치 + dirty 캐시 무효화 속도
1. `refreshLabelExplorer()` 후 백그라운드 프리페치 완료 확인 (`classToImgListCache` 채워짐)
2. 폴더 열기 캐시 히트 → **200ms 이하**
3. 라벨 추가 API 후 `refreshLabelExplorer(['className'])` dirty 호출 → **50ms 이하**
4. dirty 호출 시 다른 클래스 캐시 유지 확인
5. Ctrl+Click 그리드 표시 시 캐시 히트 → 즉시 그리드 (fetch 없이)

**pass 기준**: 43-1~43-15 모든 항목 성공, 서버 생존 확인 (`/api/classes` 200)

---

## Phase 44: Chip Label Explorer — CRUD + 캐시 + 폴더 클릭 + 속도 검증

**목적**: Chip 모드 Label Explorer의 전체 기능이 Wafer 모드와 동일하게 동작하는지, 50ms 이내 UI 반응을 검증

**관련 버그 수정 이력** (2026-03-27):
1. **chip_annotations JSON dead code 제거** (`api/main.py` -158줄): `_upsert_chip_annotations`, `_remove_chip_annotations` 등 15개 미사용 함수, `POST /api/chip-annotations` no-op endpoint 제거. chip label은 `classification_chips/` 파일시스템에서만 파생.
2. **🗑️ 삭제 후 캐시 불일치** (`js/main.js`): 🗑️ 삭제 시 `classToImgListCache[cls]` 미갱신 → 전체 새로고침 시 삭제 이미지 재출현. 수정: re-fetch 결과로 캐시 즉시 동기화.
3. **폴더 클릭 동작 분리** (`js/main.js`): 일반 클릭=폴더 토글, Ctrl/Shift 클릭=폴더 상태 유지+하이라이트+그리드+LOT 패널. (Wafer/Chip 공통)

**Phase 43과의 차이**: 43은 Wafer 모드 (네비게이션 ←→◀▶, savedViewState 오염 방지). 44는 Chip 모드 전용 (모드 전환, `_x{n}_y{m}.png` 패턴, 캐시 일관성, JSON 미사용). 폴더 클릭 동작은 양 모드 공통이므로 44-2~44-3에서 chip 기준 검증.

**사전 조건**: `classification_chips/` 하위에 최소 1개 클래스 + 1개 chip 이미지 존재

**평가 항목**:

#### 44-1. Chip 모드 전환 + Label Explorer 갱신
1. Chip 버튼 클릭 → `classMode === 'chip'` 확인
2. Fail List에 chip 클래스만 표시 확인 (wafer 클래스 없음)
3. Label Explorer에 chip 클래스 폴더 표시 확인
4. 전환 속도 측정: `performance.now()` 기준 UI 업데이트 **50ms 이내**

#### 44-2. 폴더 일반 클릭 = 열기/닫기 토글 (그리드 전환 없음)
1. 클래스 폴더 **일반 클릭** → ▸ → ▾ 전환 + 이미지 리스트 표시
2. 이미지 파일명 형식: `{wafer}_x{n}_y{m}.png` 패턴 확인
3. 다시 **일반 클릭** → ▾ → ▸ 닫힘
4. **그리드 전환 없음** 확인 (`gridMode`, `selectedClasses` 변경 없음)
5. 토글 반응: DOM 변경 **50ms 이내** (캐시 히트 시)

#### 44-3. 폴더 Ctrl+클릭 = 선택 + 폴더 상태 유지 + 그리드 + LOT
1. 클래스 폴더 **Ctrl+클릭** → `selectedClasses`에 해당 클래스 추가
2. **폴더 열림/닫힘 상태 변경 없음** (접혀있으면 접힌 채 하이라이트, 펼쳐져있으면 펼쳐진 채)
3. 그리드에 클래스 이미지 표시 (`.grid-thumb-wrap` 개수 > 0)
4. LOT 패널에 LOT 리스트 표시 확인
5. Shift+클릭 범위 선택: 여러 클래스 한번에 선택 + 그리드 합산
6. Ctrl+클릭 토글: 이미 선택된 클래스 다시 Ctrl+클릭 → 선택 해제

#### 44-4. Chip 이미지 단일 뷰
1. chip 이미지 클릭 → 단일 이미지 모드 진입 (`gridMode === false`)
2. 이미지 렌더링 확인 (`currentImageBitmap` 존재, overlay canvas > 0)
3. Navigator에 같은 클래스 내 chip 이미지 리스트 표시
4. ◀ ▶ 버튼 표시
5. Grade 범례 표시 (indexed-color PNG인 경우)
6. ESC → 초기 화면 복귀

#### 44-5. Chip 클래스 생성 + 폴더 상태 보존
1. 새 클래스명 입력 → Add Class 클릭
2. Fail List + Label Explorer에 즉시 추가 확인
3. **기존 열린 폴더의 열림 상태(▾) 유지 확인** (핵심!)
4. API 확인: `GET /api/classes?mode=chip` → 새 클래스 포함

#### 44-6. Chip 클래스 삭제 + 폴더 상태 보존
1. 테스트 클래스 Ctrl+클릭 선택 (Fail List에서)
2. Delete Class → confirm → 삭제
3. Fail List + Label Explorer에서 제거 확인
4. **다른 클래스의 열림 상태 유지 확인** (핵심!)

#### 44-7. Chip 라벨 삭제 (🗑️) + 캐시 일관성
1. 폴더 열기 → 이미지 목록 + `classToImgListCache[cls].length` 확인
2. 🗑️ 클릭 → 이미지 제거 (DOM에서 즉시 사라짐)
3. **3중 일관성**: `classToImgListCache[cls].length` === DOM 개수 === API `/api/classes/{cls}/images?mode=chip` 결과 개수
4. **재현 검증**: 클래스 생성 → 전체 새로고침 → 삭제된 이미지 미표시 확인

#### 44-8. Wafer ↔ Chip 모드 전환 왕복
1. Chip → Wafer 전환: wafer 클래스 표시 확인
2. Wafer → Chip 전환: chip 클래스 표시 확인
3. 각 전환 시 `labelSelection` 초기화 확인
4. 3회 왕복 → 마지막 모드의 데이터 정확성 확인

#### 44-9. 속도 벤치마크 (50ms 기준)
각 항목의 UI 반응 시간을 `performance.now()` 로 측정:
1. 폴더 토글 일반 클릭 (캐시 히트): **< 50ms**
2. 이미지 클릭 → DOM selected 스타일 변경: **< 50ms**
3. Ctrl+Click 폴더 → 그리드 표시 시작: **< 50ms** (API fetch 제외, DOM 반응만)
4. 🗑️ 삭제 → DOM 업데이트 (API 제외, DOM만): **< 50ms**
5. 모드 전환 버튼 → `classMode` 변경: **< 50ms**

**pass 기준**: 44-1~44-9 전 항목 성공, 모든 UI 반응 50ms 이내, 서버 생존 (`/api/classes?mode=chip` 200)

---

## 버그 수정 이력 (2026-03-27)

### Label Explorer Ctrl+Click 그리드 미표시
- **버그**: Ctrl+Click 클래스 선택 시 하이라이트만 되고 그리드에 이미지 안 나옴
- **원인**: `updateLabelExplorerSelection()`만 호출, `showGridFromLabelExplorer()` 미호출
- **수정**: `selectedClasses`의 이미지를 `classToImgListCache`에서 수집 → `showGridFromLabelExplorer()` 호출
- **커밋**: `010f57a`

### 폴더 열기 느림 (매번 fetch)
- **버그**: Label Explorer 폴더 클릭 시 매번 `/api/files` fetch → 2초+ 지연
- **원인**: `classToImgListCache` 프리페치 없음, 매 클릭마다 API 호출
- **수정**: `refreshLabelExplorer()` 완료 후 모든 클래스 이미지 목록 백그라운드 프리페치
- **결과**: 폴더 열기 108ms (캐시 히트)
- **커밋**: `010f57a`

### 라벨 추가 후 전체 캐시 삭제 → 느림
- **버그**: 라벨 1개 추가 시 `classToImgListCache = {}` 전체 초기화 → 모든 열린 폴더 re-fetch
- **원인**: `labels.js:852`, `main.js:16050` 두 곳에서 전체 캐시 삭제
- **수정**: `refreshLabelExplorer(dirtyClasses)` 파라미터 추가, 변경된 클래스만 `delete cache[cls]`
- **결과**: UI 갱신 2ms (이전 수백ms)
- **커밋**: `de39b94`

### Ctrl+Click 선택 시 폴더 헤더 크기 변경
- **버그**: 클래스 선택 시 padding `2px 0` → `4px 8px` 변경으로 폴더 헤더 크기 커짐
- **수정**: padding을 `2px 0`으로 고정, 배경색+borderRadius만 변경
- **커밋**: `9471023`

### isImageFile 필터로 그리드 파일 누락
- **버그**: Label Explorer에서 JSON/TXT 등 비이미지 파일이 그리드에 안 나옴
- **원인**: `.filter(item => item.type === 'file' && this.isImageFile(item.name))` 10곳에서 필터링
- **수정**: `isImageFile` 필터 전체 제거, `item.type === 'file'`만 유지
- **커밋**: `7cd89be`

### resolveOriginalImagePath 이중 호출
- **버그**: `showGridFromLabelExplorer`에서 `resolveOriginalImagePath(resolveLabelExplorerImagePath(key))` 이중 변환
- **원인**: `resolveLabelExplorerImagePath` 내부에서 이미 `resolveOriginalImagePath` 호출하는데 외부에서 또 감쌈
- **수정**: 외부 `resolveOriginalImagePath` 제거, `resolveLabelExplorerImagePath`만 호출
- **커밋**: `d0a7449`

### Ubuntu 그리드 미표시 (미해결)
- **증상**: Ubuntu 24에서 Label Explorer 이미지 다중선택/폴더 선택 시 그리드 미표시
- **서버 로그**: 추가 API 호출 없음, 최근 추가한 라벨만 그리드에 나옴
- **디버그 로그 추가**: `showGridFromLabelExplorer` 진입/경로해석/showGrid 호출 로그
- **커밋**: `d0a7449`
- **상태**: Ubuntu F12 콘솔 로그 확인 대기

## 버그 수정 이력 (2026-03-27, Composite/Measure 점검)

### NPZ 임시파일(_tmp.npz) 잔류
- **버그**: Composite 생성/Recolor 후 `square_maps_data_tmp.npz`가 삭제되지 않고 남음 (1.3GB/건)
- **원인**: `_save_npz()` daemon thread에서 `tmp.replace(cache_path)` Windows 파일 잠금으로 실패 → `except: pass`가 에러 무시, tmp 미삭제
- **수정**: `api/composite_map.py` `_save_npz()` finally 블록에서 항상 tmp 삭제 + 실패 로깅. `api/main.py` cleanup에서 `*_tmp.npz` / `*.npz.tmp.npz` 자동 정리
- **테스트**: Composite 생성 → `find composite_map -name "*_tmp.npz"` 결과 없어야 PASS

### Label Explorer 프리페치 JSON 파일 415 에러
- **버그**: classification 폴더의 `.json` 파일에 대해 `/api/thumbnail` 요청 → 415 대량 발생
- **원인**: 프리페치(line 16607)에서 `isImageFile` 필터 누락 (커밋 `7cd89be`에서 전체 제거 시 같이 빠짐)
- **수정**: `js/main.js` 프리페치에만 `&& this.isImageFile(item.name)` 재추가 (그리드 렌더링은 그대로)
- **테스트**: Label Explorer 열기 → 콘솔에서 `.json` 썸네일 415 에러 없어야 PASS

### Measure Composite COMPOSITE_EXECUTOR 미사용
- **버그**: Grade Composite는 `COMPOSITE_EXECUTOR(max_workers=4)` 사용, Measure Composite는 raw `threading.Thread` 사용
- **수정**: `api/main.py`에서 `threading.Thread` → `COMPOSITE_EXECUTOR.submit()` 교체
- **테스트**: 동시 Measure Composite 요청 시 max_workers=4 병렬 제한 적용 확인

### chip-positions classification 경로 → 원본 역추적 버그
- **버그**: classification 경로의 chip-positions 요청 시 `ROOT_DIR`에서 JSON 검색 → 원본 경로(`positions/AB/A1AB/`)로 잘못 역추적
- **수정**: `get_chip_positions`에서 `POSITIONS_ROOT.rglob(stem.json)` 우선 검색. `_candidate_positions_paths` 우선순위 3도 `ROOT_DIR` → `POSITIONS_ROOT`로 변경
- **테스트**: classification 이미지의 chip-positions 요청 → 서버 로그에서 `POSITIONS_ROOT/classification/class/` 경로 확인
- **커밋**: `d043581`

### Label Explorer 그리드 LOT/TEST/STEP 필터에 의한 전체 제거
- **버그**: 제품 폴더에서 LOT 필터 적용 후 Label Explorer 폴더 선택 시 `showGridByLot` 내 필터가 classification 이미지를 전부 걸러냄 → `wrapCount: 0`
- **원인**: `showGrid(images, skipSaveState=true)` → `showGridByLot(images)` 호출 시 `skipFilter` 미전달
- **수정**: `showGrid` → `showGridByLot(images, skipFilter)` 전달. Label Explorer 호출 시 필터 우회
- **테스트**: LOT 필터 활성 상태에서 Label Explorer 클래스 선택 → `wrapCount > 0` + 이미지 정상 표시
- **커밋**: `b95feef`

### positions JSON이 이미지 폴더에 생성됨
- **버그**: 라벨 추가(classify) 시 positions.json이 `ROOT_DIR/classification/class/`(이미지 폴더)에 복사됨
- **수정**: 복사 대상을 `POSITIONS_ROOT/classification/class_name/`으로 변경 (classify + batch 2곳)
- **테스트**: 라벨 추가 후 `ROOT_DIR/classification/class/` 에 `.json` 없고, `POSITIONS_ROOT/classification/class/`에 있어야 PASS
- **커밋**: `e7a09d1`

### classification 썸네일 경로 해석 실패 + 에러 시 그리드 셀 투명
- **버그**: (1) `_try_resolve`에서 `LABELS_DIR` 직접 검색 누락 → 404 (2) `img.onerror`에서 `opacity: 0.5` → 실패 셀이 거의 안 보임
- **수정**: (1) `LABELS_DIR`/`CHIP_LABELS_DIR` 직접 검색 추가 + 미발견 디버그 로그 (2) `opacity: 1` + `gridLoaded='error'`로 변경
- **테스트**: 손상 이미지도 그리드에 회색 셀로 보여야 PASS
- **커밋**: `a05470c`

### Label Explorer 그리드 썸네일 로드 느림 (캐시 미스)
- **버그**: classification 하드링크 이미지의 썸네일 hash가 원본과 다르게 생성 → 캐시 미스 → 매번 재생성
- **원인**: `get_thumbnail_path`에서 `image_path.resolve()` 경로 기반 hash 사용 → 하드링크도 별도 hash
- **수정**: hash를 `dev:ino`(inode) 기반으로 변경 → 하드링크는 동일 inode → 원본 썸네일 캐시 즉시 재사용
- **테스트**: Label Explorer 클래스 폴더 선택 → 이미지 로드 속도가 WME 그리드와 동등해야 PASS
- **커밋**: `ca72dd6`

### Label Explorer 그리드에서 LOT Mode 미적용
- **버그**: LOT Mode 활성 상태에서 Label Explorer 클래스 폴더 선택 → 그리드가 LOT 그룹 없이 flat 표시
- **원인**: `showGridFromLabelExplorer()`가 `showGrid(actualPaths, true, true)` 호출 — 3번째 인자 `forceFlatGrid=true`가 `showGrid()` 내부의 `if (this.lotMode && !forceFlatGrid)` 조건을 강제 우회
- **수정**: `showGrid(actualPaths, true)` — `forceFlatGrid` 인자 제거하여 LOT Mode 활성 시 `showGridByLot()` 정상 호출
- **파일**: `js/main.js` 줄 23459 (수정 전 23471)
- **테스트**: LOT Mode ON → Label Explorer 클래스 폴더 선택 → 그리드가 LOT 그룹별로 정리되어야 PASS
- **커밋**: `31b6f89`
- **후속 정리 (2026-03-31)**: positions 없는 unknown/PNF 혼합 클래스는 Phase 49 기준으로 flat-grid 강제가 최신 요구사항이다. 따라서 "일반 Label Explorer LOT 그룹 검증"과 "예외 혼합 클래스 flat-grid 검증"을 분리해서 본다.

### 그리드 썸네일 5-10초 멈춤 후 일괄 로드 (배치 블로킹 + 서버 POST 블로킹)
- **버그**: 그리드에서 썸네일이 개별 표시되지 않고 5-10초 멈춘 후 24개가 한번에 표시
- **원인 1 (클라이언트)**: `preloadBatch()` (줄 325)에서 `Promise.allSettled(promises)` — 배치 내 24개 전부 완료 대기
- **원인 2 (서버)**: `preloadBatch()`가 POST `/api/thumbnail/preload` → 서버 `asyncio.gather()`로 전체 배치 생성 완료까지 HTTP 응답 블로킹 (api/main.py 줄 7471)
- **수정**: (1) `/api/thumbnail/preload` POST 호출 완전 제거 (2) 개별 `loadThumbnail()` fire-and-forget (3) `loadCurrentFolderThumbnails` 비동기 대기 제거
- **파일**: `js/main.js` 줄 268-280 (preloadBatch 재작성), 줄 19428 (loadCurrentFolderThumbnails)
- **측정 결과** (Playwright 실측, 썸네일 삭제 + 서버 재시작 + 새 브라우저):
  - 서버 썸네일 생성 속도: WME/Label 경로 무관 ~630ms/개 (cold 순차), ~325ms/개 (cached)
  - 24개 병렬 cold: 1,773ms 전체 (73ms/개 effective)
  - 변경 전: 클릭 → **5-10초 무응답** → 24개 동시 표시
  - 변경 후: 클릭 → **54ms에 첫 썸네일** → **324ms에 14개 로드** (40개 그리드, LOT 그룹별)
- **테스트**: 썸네일 삭제 + 서버 재시작 + 새 브라우저 → Label Explorer 클래스 선택 → 첫 썸네일 100ms 이내 + 500ms 이내 뷰포트 채워짐이면 PASS
- **커밋**: `31b6f89` → `2eb9fc2`

### 그리드 뷰포트 외 3000개 전체 로드 (백그라운드 프리로드 무제한)
- **버그**: unknown 등 3000개 이미지 폴더에서 그리드 표시 시 뷰포트에 보이는 ~50개뿐 아니라 전체 3000개를 순차 로드
- **원인**: `_feedBackgroundGridBatch()`가 `grid.querySelectorAll('.grid-thumb-img:not([data-grid-loaded])')` — **전체 DOM 3000개**에서 미로드 이미지 선택 → 24개씩 계속 큐잉 → drainQueue → 다시 feed → 무한 반복으로 3000개 전부 로드
- **수정**: `_feedBackgroundGridBatch()`에서 `scrollParent.scrollTop ± vpH*0.5` 범위 내 이미지만 큐잉. `wrap.offsetTop` 기반 범위 체크, 범위 밖이면 skip/break
- **파일**: `js/main.js` 줄 19080-19110 (_feedBackgroundGridBatch)
- **테스트**: 3000개 이미지 폴더 선택 → 15초 대기 → 썸네일 요청 수 < 100이면 PASS (뷰포트+버퍼만). 3000개 전부 요청 시 FAIL
- **커밋**: `2eb9fc2`

### lifespan browse_folders() 프리로드가 서버 시작 블로킹
- **버그**: `_lifespan_background_init()`에서 `await browse_folders()` 호출 → lifespan yield 전 블로킹 → 서버 포트 열리지 않음
- **원인**: `await browse_folders()`가 동기적으로 완료 대기 — CLAUDE.md 규칙 "yield 전 무거운 작업 금지" 위반
- **수정**: `asyncio.ensure_future(_preload_browse())` — 백그라운드 비동기 실행으로 변경
- **파일**: `api/main.py` 줄 1721-1729
- **테스트**: 서버 시작 후 15초 이내 `curl https://localhost/api/config` 응답이면 PASS
- **커밋**: `2eb9fc2` (amend)

### Navigator 썸네일 preload가 메인 이미지 블로킹
- **버그**: Label Explorer에서 이미지 클릭 시 Navigator가 ±30개(최대 61개) 썸네일을 즉시 `img.src` 설정 → 브라우저 HTTP 연결 6개를 썸네일이 점유 → 메인 이미지가 대기열 뒤로 밀림
- **원인**: `thumbnail-navigator.js` `createThumbnailItem()`에서 `priorityRange = 30` → 61개 동시 `img.src` 할당
- **수정**: (1) `priorityRange = 5`로 축소 (±5 = 11개만 즉시) (2) `loadRemainingThumbnails()` 메서드 추가 — 메인 이미지 로드 완료 후 8개/프레임씩 점진 로드 (3) Label Explorer `loadImage().then()` 내에서 `requestAnimationFrame(() => this.thumbnailNavigator.loadRemainingThumbnails())` 호출
- **파일**: `js/thumbnail-navigator.js` 줄 1490 (priorityRange), 줄 1093 (loadRemainingThumbnails), `js/main.js` 줄 17257
- **테스트**: Label Explorer 이미지 클릭 → 메인 이미지가 Navigator 썸네일보다 먼저 표시되어야 PASS
- **커밋**: `c6b2c1c`

### Label Explorer 이미지 경로가 classification 심링크 경로 사용
- **버그**: Label Explorer에서 이미지/썸네일 요청 시 `classification/e2e_unknown_label/file.png` 경로 사용 → 서버에서 심링크 해석에 stat 5+회 필요
- **원인**: (1) `singleViewImageList`가 `item.root_relative` (classification 경로)만 사용 (2) `/api/files` 응답에 `original_relative` 필드 없음 (3) `resolveOriginalImagePath`/`resolveLabelExplorerImagePath`에서 `original_relative` 미참조
- **수정**: (1) 백엔드 `/api/files`에서 classification 디렉토리 파일에 `original_relative` 추가 (IndexService O(1) 조회) (2) 프론트 `singleViewImageList` 구성 시 `item.original_relative || item.root_relative` 우선 (3) `resolveOriginalImagePath`/`resolveLabelExplorerImagePath`에서 `original_relative` 우선 반환 (4) 백엔드 `_resolve_and_generate`에서 stat 결과 캐싱 + `get_thumbnail_path`에 `cached_stat` 전달
- **파일**: `api/main.py` (stat 캐싱, original_relative), `js/main.js` 줄 17188, 22864-22867, 22917-22919
- **테스트**: Label Explorer 이미지 클릭 → `viewer.currentImagePath`가 `unknown/...` 형태 (classification 아님)이면 PASS
- **커밋**: `c6b2c1c`

### JS/CSS/HTML pre-gzip 서빙 (성능 개선)
- **개선**: JS/CSS/HTML을 서버 시작 시 gzip 압축하여 메모리 캐시 → 요청마다 실시간 압축 대신 즉시 전송
- **수정**: `_preload_minified_js()`, `_preload_css()`, `_build_index_cache()`에서 `gzip.compress(raw, compresslevel=6)` 추가. `serve_js`, `serve_css`, `read_root`에서 `Accept-Encoding: gzip` 헤더 확인 후 압축본 전송
- **파일**: `api/main.py` (JS/CSS/HTML 서빙 엔드포인트)
- **테스트**: `curl -H "Accept-Encoding: gzip" -ks -o /dev/null -w "%{size_download}" https://localhost/js/main.js` — 압축본 크기가 원본보다 작으면 PASS
- **커밋**: `c6b2c1c`

### browse-folders 60초 TTL 캐시
- **개선**: `/api/browse-folders` 응답을 60초 메모리 캐시 → 콜드스타트 시 207ms → 0ms
- **수정**: `_BROWSE_FOLDERS_CACHE` 글로벌 변수 + `time.time()` TTL 체크
- **파일**: `api/main.py` (`browse_folders` 엔드포인트)
- **테스트**: 동일 요청 2회 → 2회째 응답 시간 < 5ms이면 PASS
- **커밋**: `c6b2c1c`

### openCompositeColorModal async 누락
- **버그**: `openCompositeColorModal()`이 `async` 없이 내부에서 `await` 사용 → minify 시 빌드 에러
- **수정**: `openCompositeColorModal(skipModeCheck = false)` → `async openCompositeColorModal(skipModeCheck = false)`
- **파일**: `js/main.js` 줄 8213
- **테스트**: `node scripts/minify.js` 에러 없이 성공하면 PASS
- **커밋**: `c6b2c1c`

### 첫 로드 시 개인색 미적용 (cacheBuster 미설정)
- **버그**: 페이지 첫 로드 → 그리드 썸네일이 기본색(#CCCCCC 배경)으로 표시. 색상 편집에서 "적용" 한 번 눌러야 개인색 활성화
- **원인**: `_personalizedColorCacheBuster`가 색상 편집 후에만 설정됨. 초기 로드 시 undefined → URL에 `_t=` 미포함 → 서버가 이전 캐시(기본색) 반환
- **수정**: `getPersonalizedParams()`에서 `_personalizedColorCacheBuster` 없으면 `colorLegends[scheme].lastModified`에서 자동 생성. 그래도 없으면 `'1'` 기본값 설정
- **파일**: `js/main.js` (`getPersonalizedParams` 함수, `loadColorLegends` 함수)
- **테스트**:
  ```javascript
  // 서버 재시작 + 썸네일 캐시 삭제 후 첫 로드
  v.loadImagesInFolderAndShowGrid('unknown'); // 8초 대기
  const params = v.getPersonalizedParams();
  // PASS: params.includes('_t=') === true
  // PASS: v._personalizedColorCacheBuster !== undefined
  // PASS: 첫 번째 썸네일 배경 픽셀 != rgb(204,204,204)
  ```
- **E2E Phase**: Phase 4-3 (그리드 썸네일 개인색 적용) 검증

### 색상 저장 후 그리드 미갱신 (selectedImages 비어있을 때)
- **버그**: 색상 편집기에서 "적용" 후 그리드가 새 색상으로 갱신되지 않음 (폴더 클릭으로 진입한 경우)
- **원인**: `color-editor.js`에서 `this.viewer.selectedImages || []` 사용 — 폴더 클릭 진입 시 `selectedImages`가 비어있어 `showGrid()` 미호출
- **수정**: `currentGridImages` 우선 사용 + fallback으로 `refreshGridThumbnailsWithCurrentParams()` 호출
- **파일**: `js/color-editor.js` (Fail 탭 저장 후 그리드 리로드 로직)
- **테스트**:
  ```javascript
  // unknown 폴더 클릭 → 그리드 표시
  // 색상 편집 → 배경 #FF00FF → 적용
  // PASS: 그리드 썸네일 배경이 마젠타로 변경
  // FAIL: 이전 색상 유지 (그리드 미갱신)
  ```

### Composite gradient filter 클릭 시 이미지 미갱신
- **버그**: Composite 모드에서 gradient 범례 클릭 → `_recolorMeasureComposite()` 호출 → 서버에서 이미지 재생성하지만 UI 미반영
- **원인**: `refreshGridThumbnailsWithCurrentParams()` 호출 → URL 변경 없이 같은 경로 요청 → 브라우저 캐시가 old 이미지 반환
- **수정**: recolor 완료 후 그리드 이미지의 `_t=timestamp`를 직접 갱신하여 브라우저 캐시 우회
- **파일**: `js/main.js` (`_recolorMeasureComposite` 함수)
- **테스트**: Composite 그리드에서 gradient 90~100% 클릭 → 이미지가 필터링된 버전으로 교체되면 PASS

### Measure 배경색 개인색 미적용
- **버그**: Measure heatmap 배경이 항상 #CCCCCC (회색) — 개인색 배경 무시
- **원인**: `_resolve_scheme_background_rgb()`에서 measure 섹션의 `background=#CCCCCC` (기본값)를 "명시적 설정"으로 취급하여 개인색 fallback 안 됨
- **수정**: measure/composite 섹션 background가 기본값 `#CCCCCC`이면 개인색으로 fallback
- **파일**: `api/composite_map.py` (`_resolve_scheme_background_rgb` 함수)
- **테스트**:
  ```bash
  curl -sk -X POST https://localhost/api/measure-composite-data \
    -H "Content-Type: application/json" \
    -d '{"image_paths":["unknown/AAU220_00P_13_20260501_010000_96.0_2_EE_PWQ.png"],"mode":"f","item_key":"1000","aggregation":"average"}'
  # PASS: background != [204,204,204] && background == 개인색 RGB
  ```
- **E2E Phase**: Phase 34-6 (measure-thumb 배경 개인색) 검증

### 그리드 미선택 + Measure → 단일 이미지 전환 버그
- **버그**: 그리드에서 이미지 선택 없이 Measure 적용 시 단일 이미지 모드로 전환됨
- **원인**: `getSelectedImagesForModal()`이 gridMode일 때도 gridSelectedIdxs가 비면 이전 `selectedImagePath`를 반환
- **수정**: `getSelectedImagesForModal()`에서 `gridMode === true`이면 gridSelectedIdxs 비었을 때 빈 배열 `[]` 반환
- **파일**: `js/main.js` (`getSelectedImagesForModal` 함수)
- **테스트**:
  ```javascript
  v.loadImagesInFolderAndShowGrid('unknown'); // 6초 대기
  v._measureCheckedItems = [{type:'f', key:'1000', label:'FBT1000'}];
  v._applyMeasureSelection(); // 5초 대기
  // PASS: v.gridMode === true && v.overlayMode === 'f'
  ```
- **E2E Phase**: Phase 34-4 (미선택 + Measure → 현재 탭 바꿔치기) 검증

### Chip Annotator Y_OFFSET 정렬 오류 + minified JS 버그
- **버그**: chip overlay가 이미지와 ~55px 어긋남 + chip-annotator.min.js에서 operator precedence 버그
- **원인**: (1) Y_OFFSET=-55 하드코딩 (positions와 이미지가 동일 좌표계이므로 0이어야 함) (2) minified JS에서 `(a - b) * c`가 우선순위 오류로 잘못 계산됨
- **수정**: (1) Y_OFFSET=0, pointer-events='auto' (2) chip-annotator.min.js 삭제 → 원본 JS 사용
- **파일**: `js/chip-annotator.js`, `js/chip-annotator.min.js` (삭제), `index.html`
- **테스트**: chip overlay 클릭 → chip 선택 가능 + overlay 위치가 이미지와 정렬되면 PASS

### Label 삭제 후 Chip Annotation 캔버스 잔상
- **버그**: label 삭제 후 chip overlay에 삭제된 라벨 잔상 남음
- **원인**: 삭제 후 `chipAnnotator.loadAnnotations()` 미호출 → markedChips와 렌더 캐시 미갱신
- **수정**: 삭제 후 positions 캐시 클리어 + chipAnnotator annotation 재로드 + render()
- **파일**: `js/main.js` (label 삭제 핸들러)
- **테스트**: label 삭제 → chip overlay에서 해당 라벨 즉시 사라지면 PASS

### 폴더 전환 시 Measure 상태 고착
- **버그**: Measure 활성 상태에서 폴더 전환 → 이전 measure 그리드 잔존
- **원인**: `changeFolder()`에서 `_measureBaseImages`, `_gridMeasureMap`, `overlayMode` 등 measure 상태 초기화 누락
- **수정**: `changeFolder()`에서 measure/overlay 상태 전부 null 초기화
- **파일**: `js/main.js` (`changeFolder`, `selectAllFolderFiles`)
- **테스트**: Measure 활성 → 다른 폴더 클릭 → measure 상태 해제되면 PASS

### F/Q Lazy Loading (성능 개선)
- **개선**: chip-positions API 기본응답에서 f/q 데이터 제거, `include_fq=1`일 때만 포함
- **파일**: `js/chip-annotator.js` (`loadPositions`, `ensureFqData`)
- **테스트**: chip-positions 응답 크기 < 100KB

### Positions 파일 이미지 분석 기반 재생성 (테스트 데이터)
- **작업**: unknown 빈 파일 2개 + 누락 10개 → 이미지 indexed-color index 분석 기반 재생성
- **방법**: reference positions 구조 + `determine_bin()` 이미지 칩 영역 분석으로 BIN 결정, F/Q는 파일명+좌표 해시 기반 결정적 생성
- **검증**: `3000 이미지 = 3000 positions, 전부 ftn_keys 500개 + qtn_keys 500개 + chips 384개 + coord + rect`
- **참고**: `D:/project/fail-map/positions_module.py` (`save_positions_json`)

### 종합 검증 결과 (2026-03-28, cold start, port 8444, 썸네일 삭제 후)
```
17/17 ALL PASS
 1. personalizedColorEnabled     ✅
 2. params personalized          ✅
 3. params scheme                ✅
 4. params _t= (cacheBuster)     ✅
 5. cacheBuster set              ✅
 6. gridMode                     ✅
 7. gridImages 3000              ✅
 8. thumb URL personalized       ✅
 9. thumb URL _t=                ✅
10. bg pixel != #CCC             ✅ rgb(142,255,205)
11. grid no-select=[]            ✅
12. measure stays grid           ✅
13. overlayMode=f                ✅
14. measure bg!=CCC              ✅ [144,254,203]
15. measure cleared              ✅
16. positions 384 chips          ✅
17. ftn_keys 500                 ✅
```

### Composite 이미지 default 색상 생성 → display 개인색 적용 (해결)
- **버그**: Composite Grade/BIN/FBT/square 맵이 생성 시점 개인색으로 baking → 색상 변경 시 재생성 필요, 즉시 반영 불가
- **원인**: `create_full_composite_maps()`에서 개인색 적용 후 RGB/JPEG 저장 → PLTE 패치 불가
- **수정**:
  1. Grade 맵: indexed-color PNG(mode=P)로 default PLTE 저장 → `/api/thumbnail`에서 개인색 PLTE 패치
  2. Square 맵: `_save_sum_map_variants(scheme=ANONYMOUS_LOGIN_ID)` default gradient 사용
  3. BIN/FBT 맵: `_render(scheme=ANONYMOUS_LOGIN_ID)` default gradient 사용
  4. 개인색은 display 시점에 `/api/thumbnail?personalized=true&scheme=<user>` 파라미터로 적용
- **파일**:
  - `api/composite_map.py`: `_save_heatmap_task` (indexed-color PNG), `_save_sum_map_variants` 호출 (scheme=default), `personal PLTE 적용 경로` 제거
  - `api/measure_composite.py`: `create_measure_composite` (default gradient)
- **테스트**:
  ```python
  # 1. Grade 맵이 indexed-color PNG(mode=P)로 저장되는지
  from PIL import Image
  img = Image.open('composite_map/notsaml/Grade_6.png')
  assert img.mode == 'P'  # indexed-color
  colors = img.getcolors(maxcolors=256)
  assert colors

  # 2. 썸네일 API에서 개인색 적용
  # GET /api/thumbnail?path=composite_map/notsaml/Grade_6.png&personalized=true&scheme=notsaml
  # → 배경 픽셀 == 개인 배경색 (not #CCCCCC)
  ```
- **검증 결과** (2026-03-28, cold start, port 8445, playwright2):
  - Grade_6.png mode=P ✅
  - 썸네일 배경 rgb(184,255,224) ≈ 개인색 #B8FFDE ✅
  - 그리드 Grade 0~7 전부 개인 배경색 표시 ✅

### Composite batch 최적화 + numpy 벡터화
- **개선**: composite 배치 크기 증가 (`effective_batch = max_workers*4`) + grade 카운팅 numpy 벡터화
- **파일**: `api/composite_map.py`
- **테스트**: composite 생성 시간 측정 (14개 이미지 < 5초)

### Positions 파일 생성 (테스트 데이터)
- **작업**: unknown에서 빈 파일 2개 + 누락 10개 → 이미지 분석 기반 재생성 (12개 총)
- **방법**: reference positions 구조 + 실제 이미지 indexed-color index 분석으로 BIN 결정, F/Q는 파일명+좌표 해시 기반 결정적 생성
- **검증**: 3000 이미지 = 3000 positions, 전부 `ftn_keys` 500개 + `qtn_keys` 500개 + `chips` 384개 + `coord` + `rect`
- **참고**: `D:/project/fail-map/positions_module.py`의 `save_positions_json()` 로직 참조

## 미해결 이슈 (다음 세션)

### Composite 속도 최적화
- **현상**: 14개 이미지 composite 3.7초 (save_heatmaps 2.0초 병목)

### 개인색 편집 "Failed to fetch" 간헐 발생
- **원인**: 미확인 (서버 과부하/타임아웃 추정)

## 병합 이력

아래 Phase들은 중복/겹침으로 인해 다른 Phase에 병합됨:
- **구 Phase 41** (Measure 탭 분리 + 탭 전환 상태 복원) → Phase 34에 34-9로 병합 (패널 체크 상태 복원)
- **구 Phase 42** (Measure/Composite 전체 흐름 안정성) → Phase 35 + Phase 40에 흡수 (검은화면 5중 방어, 시나리오 2종)
- **구 Phase 43** (Measure 드롭다운 통합 + 이미지 중복 방지) → Phase 33에 33-10~33-13으로 병합
- **구 Phase 44** (Measure/Composite LOT Mode 유지) → Phase 33-13으로 병합

## Phase 45: Measure 색상 변경 미리보기/적용 + 모달 즉시 닫기 검증

**목적**: Measure(FBT/QVL) 그리드 모드에서 색상 변경 시 미리보기가 실시간 반영되고, 적용 시 서버에 영구 저장되며, 취소 시 원래 색으로 복원되는지 검증. 모달 닫기 지연 없이 즉시 동작하는지 확인.

**배경 — 수정한 버그 3+1건 (2026-03-29)**:

| # | 버그 | 원인 | 수정 |
|---|------|------|------|
| 1 | Measure 색상 변경 미리보기/적용 시 그리드 이미지 안 바뀜 | `refreshGridThumbnailsWithCurrentParams()`에서 measure-thumb URL에 `_t=` 캐시 버스터 누락. `getPersonalizedParams()`가 이미 `_t=` 포함 → `cacheSuffix=''` → measure-thumb URL 동일 → 이미지 재로드 스킵 | `js/main.js` line 25328: measure-thumb URL에 `measureCacheSuffix = '&_t=${cacheBuster}'` 직접 추가 |
| 2 | `/api/measure-colors` POST 후 서버 인메모리 캐시 미삭제 | `_measure_thumb_cache` dict가 scheme 이름 기반 → 색 바뀌어도 같은 키 → 이전 색상 캐시 반환 | `api/main.py`: POST 핸들러에서 `_measure_thumb_cache`의 해당 scheme 엔트리 삭제 |
| 3 | measure-thumb 배경색이 Fail 탭 데이터에서 로딩 | `legends.get(scheme)` = Fail 탭 데이터, Measure 배경은 `legends["measure"][scheme]` | `api/main.py`: `legends.get("measure", {}).get(scheme)` 경로로 수정 |
| 4 | 색상 편집기 취소/적용 시 모달 닫기 지연 | `close()`에서 서버 POST + 이미지 리로드를 `await` → 수초 블로킹 | `js/color-editor.js`: 모달 DOM 숨기기를 맨 먼저 실행, 복원 로직은 fire-and-forget 비동기 |

**테스트 절차**:

1. unknown 폴더 이미지 로드 → `showGrid(images.slice(0,30))`
2. FBT1001 선택 → `_applyMeasureSelection()` → gradient heatmap 그리드 확인
3. FBT1005로 전환 → 이미지 패턴 변경 확인
4. QVL5000으로 전환 → 이미지 패턴 변경 확인
5. 색 변경 → Measure 탭 → 0% HEX를 다른 색으로 변경
6. `_previewGradientRealtime()` → **그리드 이미지가 새 색상으로 변경되는지** 확인
7. 적용 버튼 → 모달 **즉시 닫히는지** + 색상 유지 확인
8. 색 변경 → Measure 탭 → 다시 다른 색으로 변경 → 미리보기 확인
9. 취소 버튼 → 모달 **즉시 닫히는지** + **원래 색으로 복원**되는지 확인

**검증 포인트**:
- [ ] FBT/QVL 전환 시 이미지가 다른 heatmap 패턴으로 변경됨
- [ ] 색 변경 미리보기 시 그리드 이미지가 실시간 반영됨 (이전: 안 바뀜)
- [ ] 적용 시 모달이 즉시 닫힘 (이전: 수초 지연)
- [ ] 적용 후 그리드 이미지가 변경된 색상 유지
- [ ] 취소 시 모달이 즉시 닫힘 (이전: 수초 지연)
- [ ] 취소 후 그리드 이미지가 원래 색상으로 복원됨

**핵심 파일**:
- `js/main.js`: `refreshGridThumbnailsWithCurrentParams()` — measure-thumb URL cacheBuster 수정
- `js/color-editor.js`: `close()` — 모달 즉시 닫기 + 백그라운드 복원, `_handleApplyGradient()` — 적용 후 복원 방지
- `api/main.py`: `/api/measure-colors` POST — `_measure_thumb_cache` 클리어, `_generate_measure_thumb` — 배경색 로딩 경로 수정

## Phase 46: HTTP 캐시 무효화 검증 (Cache-Control: no-cache 전수 적용 확인)

**목적**: 모든 이미지/썸네일/JS/CSS 응답에 `Cache-Control: no-cache`가 적용되어, 브라우저가 매번 서버에 ETag 검증을 수행하고 stale 캐시를 사용하지 않는지 확인한다.

> 역할 분리: 이 Phase는 **API/thumbnail/image 계열의 broad no-cache 적용 여부**를 본다. 정적 자산의 `ETag/304`는 Phase 58, 모듈 그래프/worker 버전 전파는 Phase 63이 권위 기준이다.

**배경 — BUG-12 (2026-03-29)**:
Chrome이 `max-age=86400~31536000` 응답을 디스크 캐시에 저장 → 개인색 변경/서버 재시작 후에도 구버전 이미지 표시.
서버 + 프론트엔드 양쪽 모두 `Cache-Control: no-cache`로 변경 (약 20곳).

**테스트 절차**:

1. **서버 응답 헤더 검증** — 로컬 Playwright `page.evaluate`로 API 호출 후 헤더 확인:
```javascript
// 썸네일 응답 헤더 확인
const thumbRes = await fetch('/api/thumbnail?path=unknown/' + firstImage + '&size=256');
const thumbCC = thumbRes.headers.get('Cache-Control');
// PASS: thumbCC === 'no-cache'
// FAIL: thumbCC에 'max-age' 포함 (max-age=0 제외)

// 이미지 응답 헤더 확인
const imgRes = await fetch('/api/image?path=unknown/' + firstImage);
const imgCC = imgRes.headers.get('Cache-Control');
// PASS: imgCC가 'no-cache' 또는 'no-store' 포함
// FAIL: imgCC에 'max-age' > 0 포함

// measure-thumb 응답 헤더 확인
const mRes = await fetch('/api/measure-thumb?path=unknown/' + firstImage + '&size=256&field=f&key=1001');
const mCC = mRes.headers.get('Cache-Control');
// PASS: mCC === 'no-cache'

// JS 파일 응답 헤더 확인
const jsRes = await fetch('/js/main.js');
const jsCC = jsRes.headers.get('Cache-Control');
// PASS: jsCC === 'no-cache'
// FAIL: jsCC에 'max-age=31536000' 포함
```

2. **ETag 304 동작 검증** — 같은 리소스를 두 번 요청 시 304 반환:
```javascript
const res1 = await fetch('/api/thumbnail?path=unknown/' + firstImage + '&size=256');
const etag = res1.headers.get('ETag');
const res2 = await fetch('/api/thumbnail?path=unknown/' + firstImage + '&size=256', {
    headers: { 'If-None-Match': etag }
});
// PASS: res2.status === 304
// FAIL: res2.status === 200 (ETag 미작동)
```

3. **색 변경 후 새로고침 반영 검증** (핵심 시나리오):
   - 그리드 로드 → 첫 번째 이미지의 특정 픽셀 색상 캡처
   - 색상 편집기 열기 → Grade 0 색상을 다른 색으로 변경 → 적용
   - `location.reload()` 실행
   - 같은 이미지의 같은 픽셀 색상 재캡처
   - **PASS**: 새로고침 후에도 변경된 색상 유지
   - **FAIL**: 새로고침 후 구버전 색상으로 돌아감 (Chrome 캐시 문제 재발)

4. **Performance API로 캐시 사용 여부 확인**:
```javascript
const entries = performance.getEntriesByType('resource')
    .filter(e => e.name.includes('/api/thumbnail') || e.name.includes('/api/image'));
const diskCacheHits = entries.filter(e => e.transferSize === 0 && e.decodedBodySize > 0);
// PASS: diskCacheHits.length === 0 (모든 요청이 서버 응답)
// WARN: diskCacheHits.length > 0 (일부 요청이 디스크 캐시 히트 — Cache-Control 미적용 가능성)
```

**검증 포인트**:
- [ ] `/api/thumbnail` 응답 헤더에 `Cache-Control: no-cache` 포함
- [ ] `/api/image` 응답 헤더에 `Cache-Control: no-cache` 포함
- [ ] `/api/measure-thumb` 응답 헤더에 `Cache-Control: no-cache` 포함
- [ ] `/api/bin-map-thumb` 응답 헤더에 `Cache-Control: no-cache` 포함
- [ ] `/js/main.js` 응답 헤더에 `Cache-Control: no-cache` 포함
- [ ] `/css/style.css` 응답 헤더에 `Cache-Control: no-cache` 포함
- [ ] ETag 304 정상 동작 (같은 리소스 재요청 시 304)
- [ ] 색 변경 → 새로고침 → 새 색상 유지 (stale 캐시 미사용)
- [ ] Performance API: 이미지 요청에 disk cache hit 없음

**핵심 파일**:
- `api/main.py`: 모든 이미지/정적 파일 응답의 `Cache-Control` 헤더 (약 20곳)
- `js/main.js`: `fetchOptions` — `cache: 'no-cache'`, `Cache-Control: 'no-cache'`

## 버그 수정 이력 (2026-03-30, Composite color editor mapping)

### Composite Map non-grade PNG가 Measure 탭 색을 잘못 참조
- **버그**: `composite_map` 결과에서 `BIN_*`, `F_*`, `Q_*`, `square_*`가 `Composite` 탭이 아니라 `Measure` 탭 gradient에 반응함
- **정상 요구사항**: `Grade_*`만 예외로 두고, 그 외 `composite_map` PNG는 전부 `Composite` 탭 색을 따라야 함
- **원인**: `_resolve_composite_map_gradient_mode()`가 `BIN_/F_/Q_`를 `"measure"`로 분기하여 PLTE gradient patch 시 `measure` 색상 소스를 읽음
- **수정**: `composite_map` 아래의 non-`Grade_` PNG는 전부 `"composite"`로 통일. 결과적으로 `BIN/F/Q/square`가 모두 `Composite` 탭 gradient를 사용
- **파일**: `api/main.py` (`_resolve_composite_map_gradient_mode`)
- **검증 포인트**:
  - `Measure` 탭 0% 색을 바꿔도 `BIN/F/Q/square` 픽셀이 바뀌지 않아야 함
  - `Composite` 탭 0% 색을 바꾸면 `BIN/F/Q/square`가 함께 바뀌어야 함
  - `Grade_*`는 이 검증 대상에서 제외되며 기존 Grade 색 체계를 유지해야 함

### Composite/Measure 탭의 배경 행이 요구사항과 다르게 노출됨
- **버그**: 색상 편집기 `Composite`/`Measure` 탭에 배경(background) 행이 보여 사용자 요구사항과 충돌함
- **원인**: gradient row 빌드 시 quantile 11개 뒤에 배경 row를 별도로 생성하고, 변경 감지/저장/복원 payload에도 포함함
- **수정**: `Composite`/`Measure` 탭에서 배경 row를 제거. gradient 변경 감지와 저장/복원은 quantile 11개만 기준으로 동작. background는 row가 존재할 때만 payload에 포함되도록 방어
- **파일**: `js/color-editor.js`
- **검증 포인트**:
  - `Composite` 탭과 `Measure` 탭 모두 `0%~100%` 11개 row만 보여야 함
  - `배경` row가 보이면 FAIL
  - gradient 변경만으로 `적용` 버튼 활성화/비활성화가 정상 동작해야 함

## Phase 47: Composite 탭 색상 매핑 + 배경 행 제거 검증

**목적**: `unknown` 기준 실제 composite 생성 결과에서 `BIN/F/Q/square`가 오직 `Composite` 탭 색상만 따르는지, `Measure` 탭 변경에는 영향받지 않는지, 그리고 `Composite`/`Measure` 탭에서 배경 row가 제거되었는지 검증한다.

**배경 — 수정한 버그 2건 (2026-03-30)**:

| # | 버그 | 원인 | 수정 |
|---|------|------|------|
| 1 | `BIN/F/Q/square`가 `Measure` 탭 색으로 바뀜 | `composite_map` non-`Grade_` PNG 중 `BIN_/F_/Q_`가 `"measure"` gradient로 분기됨 | `api/main.py`에서 non-`Grade_` PNG를 모두 `"composite"`로 처리 |
| 2 | `Composite`/`Measure` 탭에 배경 row 노출 | gradient row 빌드 시 background row를 항상 생성하고 payload에도 포함 | `js/color-editor.js`에서 background row 제거, quantile 11개만 저장/복원 |

**테스트 절차**:

1. 새 서버 포트로 앱 접속 후 `unknown` 폴더를 로드한다.
2. 그리드에서 처음 10개 이미지를 선택한다.
3. Composite 생성 항목으로 `Failbit + BIN389 + FBT1000 + QVL5000`를 동시에 생성한다.
4. 결과 그리드에 아래 파일이 보여야 한다.
   - `BIN_389_count.png`
   - `F_1000_sum.png`
   - `Q_5000_sum.png`
   - `square_average.png`
   - `Grade_0.png` ~ `Grade_7.png`
5. 색상 편집기를 열고 `Measure` 탭으로 이동한다.
6. `Measure` 탭의 `0%` 색을 뚜렷한 다른 색으로 변경하고 실시간 미리보기를 기다린다.
7. `BIN_389_count`, `F_1000_sum`, `Q_5000_sum`, `square_average`의 픽셀/색상이 **그대로인지** 확인한다.
8. 색상 편집기에서 `Composite` 탭으로 이동한다.
9. `Composite` 탭의 `0%` 색을 다른 색으로 변경하고 실시간 미리보기를 기다린다.
10. `BIN_389_count`, `F_1000_sum`, `Q_5000_sum`, `square_average`의 픽셀/색상이 **함께 바뀌는지** 확인한다.
11. `적용` 버튼을 눌러 모달이 즉시 닫히는지 확인하고, 닫힌 뒤에도 위 4개 이미지 색상이 유지되는지 확인한다.
12. `Composite`/`Measure` 탭 모두에서 row 목록에 `배경` 행이 없는지 확인한다.

**검증 포인트**:
- [ ] `Measure` 탭 색 변경 시 `BIN/F/Q/square`가 바뀌지 않음
- [ ] `Composite` 탭 색 변경 시 `BIN/F/Q/square`가 함께 바뀜
- [ ] `Grade_*`는 본 검증에서 제외되며 `Composite` 0% 변경만으로 같이 움직이면 FAIL
- [ ] `Composite` 탭에 `배경` row가 없음
- [ ] `Measure` 탭에 `배경` row가 없음
- [ ] `적용` 후 모달이 즉시 닫힘
- [ ] `적용` 후 `BIN/F/Q/square`의 변경 색상이 유지됨

**권장 확인 코드**:
```javascript
const pick = ['BIN_389_count', 'F_1000_sum', 'Q_5000_sum', 'square_average'];
const rows = [...document.querySelectorAll('#image-grid .grid-thumb-wrap')];
const readCenterPixel = (img) => {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const x = Math.floor(img.naturalWidth * 0.5);
  const y = Math.floor(img.naturalHeight * 0.5);
  return Array.from(ctx.getImageData(x, y, 1, 1).data);
};
const result = {};
for (const name of pick) {
  const wrap = rows.find(w => w.textContent.includes(name));
  const img = wrap?.querySelector('img');
  result[name] = img ? {
    src: img.currentSrc || img.src,
    pixel: readCenterPixel(img),
  } : null;
}
return result;
```

**핵심 파일**:
- `api/main.py`: `_resolve_composite_map_gradient_mode`
- `js/color-editor.js`: gradient row 구성, 저장/복원 payload, 변경 감지 로직

## 버그 수정 이력 (2026-03-31, Measure map 첫 진입 지연 + 폴더 선택 stale state)

### 새로고침 직후 첫 Measure 적용만 `F/Q`가 늦게 뜨고, 그리드 비운 뒤 반복하면 빨라짐
- **버그**: 앱 새로고침 직후 `Measure -> Failbit + BIN + F + Q -> 적용` 시 첫 진입에서 `F/Q` 썸네일이 한 박자 늦게 붙음. 같은 세션에서 그리드를 비우고 다시 반복하면 즉시 뜸
- **원인 1**: `measure` 그리드가 이미 최초 렌더부터 `measure-thumb` URL을 쓰고 있는데도, 뒤에서 `refreshGridThumbnailsWithCurrentParams()`를 다시 호출해 첫 요청을 갈아엎는 2-pass 경로가 남아 있었음
- **원인 2**: `measure` 그리드에서도 일반 폴더 썸네일 prefetch(`loadCurrentFolderThumbnails`)를 같이 돌려 네트워크/디코드 경합이 발생했음
- **원인 3**: `measure-colors`와 병합 key 목록을 먼저 기다린 뒤에만 legend/list가 갱신되어, 첫 진입 체감이 더 느려졌음
- **수정**:
  - `measure` 그리드는 최초 렌더 결과를 유지하고 delayed refresh를 제거
  - `measure` 그리드에서는 일반 폴더 썸네일 prefetch를 건너뜀
  - 선택된 `F/Q` 항목에 대해 `_prefetchCheckedMeasureThumbs()`로 batch prefetch 추가
  - `measure-colors`는 `_ensureRatioGradientCache()`로 비동기 예열하고, 리스트는 기존 `_cachedMeasureKeys`가 있으면 먼저 즉시 렌더
- **파일**: `js/main.js`

### 그리드 초기화 후 폴더를 클릭하면 폴더가 아니라 마지막 파일이 다시 선택됨
- **버그**: `Composite`/`Measure` 생성 후 오른쪽 클릭으로 그리드를 초기화하고 폴더를 클릭하면, 폴더 선택 대신 이전 파일 선택 상태가 되살아남
- **원인**: `clearWaferMapExplorerSelection()`이 시각적 선택만 지우고 `selectedImagePath`, `currentImagePath`, `contextMenuTargetPath`, `lastSelectedFolderPath` 같은 파일 포인터를 남겨 stale state가 다음 폴더 클릭에 재사용됨
- **수정**:
  - `clearWaferMapExplorerSelection()`에 전체 초기화 옵션을 추가해 grid selection과 file pointer를 함께 비움
  - 일반 폴더 클릭 시 stale 파일 선택을 먼저 지우고 `selectedFolders`, `lastSelectedFolder`, `lastSelectedFolderPath`를 폴더 기준으로 다시 설정
- **파일**: `js/main.js`

### 검증 시 주의: 8443이 구버전 JS를 계속 서빙하면 수정이 안 된 것처럼 보일 수 있음
- **증상**: 로컬 `js/main.js`에는 수정이 들어갔는데 UI에서는 예전 Measure 지연 동작이 계속 재현됨
- **원인**: `8443`에 떠 있는 오래된 `python -m api.main` 프로세스가 구버전 `js/main.js`를 계속 서빙함
- **대응**:
  - `8443` 프로세스를 내리고 `start.ps1`로 다시 기동
  - 검증 전 `https://localhost:8443/js/main.js` 응답에 `_prefetchCheckedMeasureThumbs`와 `Measure 그리드는 최초 렌더부터 올바른 URL을 사용하므로 legend/UI만 동기화` 문자열이 실제 포함되는지 확인

## Phase 48: Measure map 즉시 로드 + 폴더 선택 회귀 검증

**목적**: 새로고침 직후 첫 `Measure` 적용에서도 `BIN/F/Q` 그리드가 즉시 생성되는지, 그리고 그리드 초기화 후 폴더 클릭이 파일 선택으로 새지 않는지 검증한다.

**테스트 절차**:

1. `https://localhost:8443` 접속 후 새로고침한다.
2. `unknown` 폴더를 선택하고 처음 10개 이미지를 체크한다.
3. 상단 패널에서 `Measure`를 열고 `Failbit`, `BIN`, `FBT1000`, `QVL5000`를 선택한 뒤 `적용`한다.
4. 적용 직후 활성 페이지가 `measure`로 전환되고, 그리드가 즉시 채워지는지 확인한다.
5. 첫 4개 타일 URL이 각각 일반 썸네일, `bin_overlay`, `measure-thumb(f)`, `measure-thumb(q)` 패턴으로 바로 잡히는지 확인한다.
6. 오른쪽 클릭으로 그리드를 초기화한다.
7. 파일이 아닌 `unknown` 폴더를 한 번 클릭한다.
8. 폴더가 선택 상태로 남고, 마지막 파일 하이라이트가 되살아나지 않는지 확인한다.

**검증 포인트**:
- [ ] 새로고침 직후 첫 `Measure` 적용에서도 `measure` 그리드가 즉시 보임
- [ ] `F/Q` 타일이 뒤늦게 한 번 더 갈아끼워지지 않음
- [ ] 활성 페이지가 즉시 `measure`로 바뀜
- [ ] 첫 타일 URL들에 `bin_overlay`, `measure-thumb?field=f`, `measure-thumb?field=q`가 바로 포함됨
- [ ] 그리드 초기화 후 폴더 클릭 시 폴더가 선택되고 파일 선택이 복원되지 않음
- [ ] `selectedFolders`에는 폴더 경로가 남고 `selectedFiles`/`selectedImagePath`는 비어 있어야 함

**권장 확인 코드**:
```javascript
(() => ({
  activePageRole: window.viewer?.pageManager?.activePage?.role || null,
  currentGridImages: window.viewer?.currentGridImages?.length || 0,
  firstSources: [...document.querySelectorAll('#image-grid .grid-thumb-wrap img')]
    .slice(0, 4)
    .map(img => img.currentSrc || img.src),
  selectedFolders: [...(window.viewer?.selectedFolders || [])],
  selectedFiles: [...(window.viewer?.selectedFiles || [])],
  selectedImagePath: window.viewer?.selectedImagePath || null,
}))();
```

**PASS 기준**:
- `activePageRole === 'measure'`
- `currentGridImages > 0`
- `firstSources`에 `bin_overlay=1`, `measure-thumb`가 즉시 포함
- 폴더 재선택 직후 `selectedFolders = ['unknown']`, `selectedFiles = []`, `selectedImagePath = null`

**핵심 파일**:
- `js/main.js`: `_ensureRatioGradientCache`, `_prefetchCheckedMeasureThumbs`, `clearWaferMapExplorerSelection`, `_openMeasureTab`, `showGrid`

## Phase 49: Label Explorer 그리드 이미지 로드 실패 및 chip-positions 404 수정 검증

### chip-positions 파일 없을 때 404 대신 빈 결과 반환
- **버그**: classification 경로의 이미지에 positions 파일이 없으면 `/api/chip-positions`가 404를 반환하여 브라우저 콘솔에 `Failed to load resource: 404` 에러가 출력됨
- **원인**: `get_chip_positions` 엔드포인트에서 positions 파일이 없을 때 `HTTPException(404)`를 raise. classification 이미지는 positions 파일이 없을 수 있으므로 404가 아닌 빈 결과를 반환해야 함
- **수정**: `api/main.py` — positions 파일 미발견 시 `{"chips": [], "ftn_keys": [], "qtn_keys": []}`를 200으로 반환
- **파일**: `api/main.py`

### 그리드 instant load 실패 시 이미지가 영구히 빈 상태로 남는 버그
- **버그**: Label Explorer에서 Ctrl+클릭으로 그리드를 표시할 때, 일부 이미지가 로드되지 않고 빈 상태로 남음. 더블클릭으로 단일뷰 진입 후 다시 그리드로 돌아오면 모든 이미지가 정상 로드됨 (때로는 2번 반복 필요)
- **원인**: `showGridByLot`과 `showGridImmediately`의 instant load 블록에서 `img.src`를 직접 할당하는데, 에러 핸들러에 **재시도 로직이 없음**. 네트워크 타이밍/서버 부하로 실패하면 이미지가 영구히 `gridLoaded='error'` 상태로 남음. 반면 단일뷰 복귀 시 호출되는 `loadVisibleGridThumbnails()` → `startGridThumbnailLoad()`는 최대 3회 재시도 로직이 있어 이미지가 정상 로드됨
- **수정**:
  - `showGridImmediately` instant load error handler: `enqueueGridThumbnail()` + `drainGridLoadQueue()` 호출하여 큐 시스템의 재시도 로직 활용
  - `showGridByLot` instant load error handler: 동일하게 큐 시스템으로 재시도
  - `showGridByLot`에 300ms 후 `loadVisibleGridThumbnails()` 안전망 호출 추가 (스크롤 이벤트 settle 후 미로드 이미지 재시도)
- **파일**: `js/main.js`

### Label Explorer 그리드가 LOT 경로를 타면서 positions 없는 unknown/PNF 이미지가 초기 미표시되는 회귀
- **버그**: 오래된 unknown 이미지이지만 positions 파일이 없거나, PNF/non-indexed-color 계열이라 LOT 분류 정보가 맞지 않는 라벨 등록 이미지가 Label Explorer 그리드에서 처음엔 비어 있다가, 더블클릭으로 단일 이미지 뷰에 들어갔다가 다시 그리드로 돌아오면 뒤늦게 보임
- **재현 조건**: `asDF` 같은 Label Explorer 클래스에서 `unknown/Donut_invalid_main/AAD534_00C_07_20260501_010000_95.2_0_PT_NORMAL.png`, `unknown/Center_scratch/AAU220_00P_13_20260501_010000_96.0_2_EE_PWQ.PNG`처럼 positions 없는 unknown 이미지를 포함한 상태로 그리드 진입
- **원인**: Label Explorer가 `showGrid(..., true)`로 진입하면서도 `lotMode`가 켜져 있으면 여전히 `showGridByLot()` 경로를 탔다. 이 경로는 LOT 헤더/지연 로딩 전제를 두고 있어 Label Explorer의 혼합 이미지 집합에서 초기 썸네일 src 할당이 빠질 수 있었고, 단일뷰 복귀 시 재렌더링되며 뒤늦게 채워졌다
- **수정**:
  - `buildLabelExplorerGridState()`에 `forceFlatGrid: true` 저장
  - `showGridFromLabelExplorer()`, `showGridFromClass()`, `showGridFromMultipleClasses()`에서 `showGrid(..., true, true)` 호출
  - `showGrid()`가 `_transientGridRestoreState.forceFlatGrid`를 읽어 단일 이미지 복귀 시에도 flat-grid 경로를 유지
- **파일**: `js/main.js`

**테스트 절차**:

1. `https://localhost:8443` 접속 후 새로고침한다.
2. Label Explorer에서 `asDF` 폴더를 **Ctrl+클릭**하여 그리드에 이미지를 로드한다.
3. 모든 이미지(16개)가 정상 표시되는지 확인한다.
4. 브라우저 콘솔에 `chip-positions` 관련 404 에러가 없는지 확인한다.
5. `asdfasdf` 폴더도 **Ctrl+클릭**하여 두 클래스 모두 그리드에 표시되는지 확인한다.
6. 그리드에 **LOT 헤더가 생성되지 않고 flat-grid**로 바로 표시되는지 확인한다.
7. `unknown/Donut_invalid_main/AAD534_00C_07_20260501_010000_95.2_0_PT_NORMAL.png`, `unknown/Center_scratch/AAU220_00P_13_20260501_010000_96.0_2_EE_PWQ.PNG` 썸네일이 첫 진입에서 즉시 로드되는지 확인한다.
8. 그리드에서 위 두 이미지 중 하나를 **더블클릭**하여 단일뷰로 진입한다.
9. 다시 **더블클릭**하여 그리드로 복귀한다.
10. 이전에 보이던 이미지가 모두 그대로 정상 표시되고, 복귀 후에도 여전히 LOT 헤더 없이 flat-grid 상태인지 확인한다.
11. 존재하지 않는 이미지 경로로 chip-positions API를 직접 호출하여 200 + 빈 결과가 반환되는지 확인한다.

**검증 포인트**:
- [ ] Label Explorer Ctrl+클릭 후 모든 그리드 이미지가 즉시 정상 로드됨
- [ ] 콘솔에 `chip-positions` 404 에러가 없음
- [ ] Label Explorer 클래스 그리드는 LOT Mode ON이어도 LOT 헤더 없이 flat-grid로 렌더링됨
- [ ] positions 없는 unknown/PNF 이미지 썸네일이 첫 진입에서 바로 로드됨
- [ ] 단일뷰 진입→복귀 후에도 모든 이미지가 정상 표시되고 flat-grid 상태가 유지됨
- [ ] positions 파일이 없는 이미지에 대해 `/api/chip-positions`가 200 + `{"chips":[]}` 반환
- [ ] 그리드 instant load 실패 시 자동 재시도하여 이미지가 최종 로드됨

**권장 확인 코드**:
```javascript
(() => {
  const imgs = document.querySelectorAll('.grid-thumb-img');
  const loaded = [...imgs].filter(i => i.dataset.gridLoaded === 'true').length;
  const failed = [...imgs].filter(i => i.dataset.gridLoaded === 'error' || i.dataset.gridLoaded === 'false').length;
  return { total: imgs.length, loaded, failed };
})();
```

**API 테스트**:
```bash
# positions 없는 이미지 → 200 + 빈 결과 (기존: 404)
curl -sk "https://localhost:8443/api/chip-positions?path=classification/asDF/nonexistent.png"
# 기대 결과: {"chips":[],"ftn_keys":[],"qtn_keys":[]}
```

**PASS 기준**:
- `loaded === total` (모든 이미지 로드 성공)
- `failed === 0`
- chip-positions API가 404 대신 200 반환
- 콘솔에 thumbnail/chip-positions 관련 에러 없음

**핵심 파일**:
- `api/main.py`: `get_chip_positions` — 404 → 200 빈 결과 반환
- `js/main.js`: `showGridImmediately`, `showGridByLot` — instant load error handler에 큐 재시도 추가

---

## Phase 50: 검색 첫 실행 실패 + 다중검색 에러 + 이벤트루프 블로킹 수정 검증

**목적**: 서버 시작 직후 첫 검색이 "결과 없음"으로 실패하던 버그, 다중검색 모달에서 `suppressAlerts is not defined` 에러로 검색이 깨지던 버그, 대량 인덱스에서 동기 순차스캔이 이벤트루프를 블로킹하던 성능 문제가 수정되었는지 검증한다.

**배경 — 발견된 버그 3건**:

### 버그 1: 첫 검색 시 항상 "결과 없음" (ensure_ready_for_search 즉시 반환)
- **증상**: 서버 시작 후 첫 검색어 입력 → "검색 결과가 없습니다" alert. 새로고침 후 다시 검색하면 정상.
- **원인**: `IndexService.ensure_ready_for_search()` (api/index_service.py) 가 인덱스 미준비(building 중) 시 즉시 `False` 반환 → `SearchService.search()`에서 빈 `keys_slice` → fallback scan도 부족 → 0건 반환.
- **수정**: `ensure_ready_for_search(timeout=10.0)` — 빌드/캐시 로드 진행 중이면 최대 10초까지 `await asyncio.sleep(0.1)` 루프로 대기. `load_cache()`를 `loop.run_in_executor`로 비동기 실행하여 이벤트루프 블로킹 방지.
- **핵심 코드**:
  ```python
  # api/index_service.py — ensure_ready_for_search
  async def ensure_ready_for_search(self, timeout: float = 10.0) -> bool:
      if self.ready and self._keys:
          return True
      loop = asyncio.get_running_loop()
      loaded = await loop.run_in_executor(
          self._io_pool, lambda: self.load_cache(log=not self._cache_loaded)
      )
      if loaded and self._keys:
          return True
      if not self.building:
          asyncio.create_task(self.build(force=True, allow_background=True))
      deadline = asyncio.get_event_loop().time() + timeout
      while asyncio.get_event_loop().time() < deadline:
          if self.ready and self._keys:
              return True
          await asyncio.sleep(0.1)
      return bool(self.ready and self._keys)
  ```

### 버그 2: 다중검색 모달 에러 (suppressAlerts ReferenceError)
- **증상**: 다중검색 모달에서 LOT 입력 → 적용 클릭 → "검색 중 오류가 발생했습니다" 에러 표시. 콘솔: `ReferenceError: suppressAlerts is not defined`.
- **원인**: `performSearch(options)` (js/main.js) 에서 `const { suppressAlerts } = options` 가 `try` 블록 내부에서 선언됨 → `catch` 블록에서 접근 불가 (블록 스코프).
- **수정**: destructuring을 `try` 바깥으로 이동.
- **핵심 코드**:
  ```javascript
  // js/main.js — performSearch (수정 후)
  async performSearch(options = {}) {
      const { multiLotList = [], suppressAlerts = false } = options; // try 바깥
      try { /* ... */ } catch (error) {
          if (!suppressAlerts) alert('검색 중 오류가 발생했습니다.');
      }
  }
  ```

### 버그 3: 대량 인덱스 동기 순차스캔 이벤트루프 블로킹
- **증상**: 토큰 인덱스 미생성 상태(캐시 로드 직후)에서 501만 파일 검색 시 수 초간 서버 전체 응답 불가.
- **원인**: `SearchService.search()`에서 단순 검색 순차스캔과 fallback 파일시스템 스캔이 동기 실행 → 이벤트루프 블로킹.
- **수정**: 50000건 이상 순차스캔은 `run_in_executor`로 실행. fallback `_fallback_scan`도 executor로 이동.

**테스트 절차**:

### 49-1. 서버 재시작 직후 첫 검색 성공 확인
1. 서버 종료 후 재시작 (`RELOAD=0 HTTPS_PORT=8443 python -m api.main`)
2. 서버 기동 직후 (인덱스 빌드 중에) `/api/search?q=aau220&limit=100` API 호출
3. **pass 기준**: `success === true`, `results.length > 0`, alert 없음

### 49-2. UI 단순 검색 (AAU220)
1. 검색창에 `AAU220` 입력 → 검색 버튼 클릭
2. **pass 기준**: 그리드에 현재 `unknown`의 AAU220 결과가 표시되고, alert 없음, 이미지 정상 로드

### 49-3. UI AND/OR 논리 검색
1. 검색창에 `(AAU220 and 13) or (ABM792 and 05)` 입력 → 검색
2. **pass 기준**: 결과 > 0건, 두 LOT 모두 표시

### 49-4. 다중검색 모달 — noise LOT 파싱
1. `다중검색` 버튼 클릭 → 모달 열림
2. textarea에 noise 포함 3줄 입력:
   ```
   AAU220.J3 13
   ABM792.2	05
   AAV489 11
   ```
3. `적용` 버튼 클릭
4. **pass 기준**:
   - 모달 자동 닫힘 (`display === 'none'`)
   - 에러 메시지 없음 (`#multi-search-error` 비어있음)
   - 그리드에 현재 `unknown`에 존재하는 3개 LOT 이미지 표시
   - LOT 패널에 AAU220, ABM792, AAV489 표시
   - `suppressAlerts is not defined` 콘솔 에러 없음

### 49-5. 다중검색 에러 처리
1. 빈 textarea에서 `적용` → "LOT ID를 한 개 이상 입력하세요." 표시
2. ESC → 모달 닫힘

### 49-6. 검색 성능 (이벤트루프 블로킹 없음)
1. 검색 API 호출과 동시에 `/api/index-status` 호출
2. **pass 기준**: 검색 중에도 다른 API가 1초 이내 응답

### 다중검색 cold flat-grid 렌더 분리 측정 (showGrid vs thumbnail 생성)
`unknown` 다중검색이 느릴 때는 검색/필터링/DOM 렌더링과 썸네일 생성 병목을 반드시 분리해서 측정한다.

1. **진짜 cold 상태 강제**
   - `D:/project/data/wm-811k/thumbnails` 폴더를 통째로 삭제한다.
   - `8443` 서버를 완전히 내린 뒤 다시 시작한다.
   - 기존 Playwright 탭/세션을 재사용하지 말고 **새 브라우저 세션**으로 접속한다.
2. **썸네일 미존재 확인**
   - 샘플 512 썸네일 파일 2~3개가 실제로 없는지 확인한다.
   - 예: `unknown/Center_scratch/AAU220_00P_13_20260501_010000_96.0_2_EE_PWQ.png`, `unknown/Full_scratch/ABM792_00C_05_20260501_010000_68.2_30_EE_PWQ.png`, `unknown/Center_scratch/AAV489_00C_11_20260501_010000_96.0_2_EE_PWQ.png`
3. **LOT Mode 경로 배제**
   - `v.lotMode = false`로 강제한다.
   - `await v.changeFolder('D:\\project\\data\\wm-811k\\unknown')`로 폴더를 명시적으로 고정한다.
   - 목적은 `showGridByLot()`이 아니라 **flat-grid `showGrid()` 경로만** 측정하는 것이다.
4. **다중검색 실행**
   - `await v.performSearch({ multiLotList: ['aad534', 'aai158'], suppressAlerts: true })`
   - 반환 시간과 그리드 이미지 상태를 함께 기록한다.
5. **즉시/지연 상태를 단계별로 기록**
   - 반환 직후 `#image-grid .grid-thumb-img`의 `total`, `loaded`, `loading`
   - 300ms 후 동일 값
   - 2000ms 후 동일 값
   - 5000ms 후 동일 값
6. **판정 기준**
   - 검색 반환 시간: `< 50ms`
   - 반환 직후: `total >= 48` 이면 PASS, 이 시점의 `loaded === 0`은 허용
   - 300ms 후: `total >= 500` 이고 `loaded > 0`
   - 2000ms 후: `loaded >= 80`
   - 5000ms 후: `loaded >= 200`
7. **해석 규칙**
   - 검색 반환이 빠르고 그리드 셸이 즉시 붙으면 `performSearch()`/필터/`showGrid()` DOM 생성은 병목이 아니다.
   - 이후 `loaded` 증가가 느리면 병목은 cold `/api/thumbnail` 생성이다.
   - 이 측정에서 `LOT Mode`, warm 썸네일, 기존 브라우저 캐시가 섞이면 결과를 무효로 본다.

**검증 코드**:
```javascript
// 49-1: 서버 직후 검색 API
const [status, search] = await Promise.all([
  fetch('/api/index-status').then(r => r.json()),
  fetch('/api/search?q=aau220&limit=100').then(r => r.json())
]);
console.assert(search.success && search.results.length > 0, '첫 검색 성공');

// 49-4: 다중검색 모달
document.getElementById('multi-search-btn').click();
document.getElementById('multi-search-input').value = 'AAU220.J3 13\nABM792.2\t05\nAAV489 11';
document.getElementById('multi-search-apply').click();
// → 모달 닫힘, v.selectedImages.length === 1548, 에러 없음

// cold flat-grid 분리 측정
v.lotMode = false;
await v.changeFolder('D:\\project\\data\\wm-811k\\unknown');
const t0 = performance.now();
await v.performSearch({ multiLotList: ['aad534', 'aai158'], suppressAlerts: true });
const duration = performance.now() - t0;
const sampleState = () => {
  const imgs = Array.from(document.querySelectorAll('#image-grid .grid-thumb-img'));
  return {
    total: imgs.length,
    loaded: imgs.filter(img => img.complete && img.naturalWidth > 0).length,
    loading: imgs.filter(img => img.dataset.loading === 'true').length
  };
};
const now = sampleState();
await new Promise(r => setTimeout(r, 300));
const t300 = sampleState();
await new Promise(r => setTimeout(r, 1700));
const t2000 = sampleState();
await new Promise(r => setTimeout(r, 3000));
const t5000 = sampleState();
({ duration, now, t300, t2000, t5000 });
```

**결과 요약표**:

| 항목 | 기준 | 실측 |
|------|------|------|
| 서버 직후 첫 검색 | 결과 > 0 | 100건 (3.8ms) |
| UI 단순 검색 AAU220 | 결과 > 0, alert 없음 | PASS |
| 다중검색 noise 3줄 | 결과 > 0, 에러 없음 | PASS |
| suppressAlerts 에러 | 콘솔 에러 없음 | PASS |
| 이벤트루프 블로킹 | 검색 중 타 API 1초 이내 | PASS |
| cold flat-grid 검색 반환 | < 50ms | 18.7ms PASS |
| cold 즉시 그리드 셸 | `total >= 48`, `loaded === 0` 허용 | `total=48`, `loaded=0`, `loading=48` PASS |
| cold 300ms 진행률 | `total >= 500`, `loaded > 0` | `total=1000`, `loaded=8`, `loading=73` PASS |
| cold 2000ms 진행률 | `loaded >= 80` | `loaded=94`, `loading=50` PASS |
| cold 5000ms 진행률 | `loaded >= 200` | `loaded=257`, `loading=50` PASS |

**수정된 파일**:
- `api/index_service.py`: `ensure_ready_for_search()` — timeout 대기 + executor 비동기 캐시 로드
- `api/search_service.py`: 순차스캔/fallback을 executor로 이동
- `js/main.js`: `performSearch()` — suppressAlerts destructuring 위치 수정

## 2026-04-01 속도 최적화 히스토리 / 병렬 구조 / 병렬 튜닝 벤치

이 섹션은 2026-03-28 ~ 2026-04-01 동안 진행한 성능 작업을 한곳에 정리한 것이다.  
검색, cold thumbnail, failbit/bin/measure, Composite/Measure Composite의 병목 위치와 병렬 처리 전략을 분리해서 이해해야 한다.

### 1. 병목 구조를 어떻게 분리해서 봐야 하는가

L3 Tracker의 체감 지연은 대략 아래 4단계로 나뉜다.

1. 검색 API / 필터링
   - `/api/search`
   - LT/TM/STEP 필터
   - LOT ID 파싱 / classification 경로 정규화
2. 그리드 DOM 생성
   - `showGrid()` / `showGridImmediately()`
   - wrap/div/img/label 생성
   - LOT 그룹핑 여부, flat-grid 여부
3. 썸네일 URL 결정
   - 일반 thumbnail (`/api/thumbnail`)
   - failbit/composite 원본
   - BIN (`/api/bin-map-thumb` 또는 `/api/thumbnail?...bin_overlay=1`)
   - Measure (`/api/measure-thumb`)
4. 실제 이미지 생성/인코딩
   - cold thumbnail 생성
   - measure-thumb gradient heatmap 생성
   - bin-map-thumb 생성
   - composite/measure composite 저장

**핵심 규칙**:
- 검색이 느린지, DOM이 느린지, 썸네일 생성이 느린지를 반드시 분리해서 측정한다.
- `performSearch()`가 빠르고 그리드 셸이 즉시 뜨면, 병목은 거의 항상 cold `/api/thumbnail` 또는 overlay 변환이다.
- `measure-thumb`은 일반 thumbnail과 다른 경로이므로 따로 봐야 한다.
- `bin`도 이제 경량 전용 경로와 무거운 overlay 경로가 공존하므로 둘을 구분해야 한다.

### 2. 타입별 병렬 처리 구조 (최신 기준)

#### 2-1. failbit / composite 원본
- URL: 일반적으로 `/api/thumbnail?path=...&size=512`
- 프런트: 그리드 큐가 동시에 여러 장을 요청한다.
- 서버: 각 요청이 `THUMBNAIL_EXECUTOR`에서 병렬 처리된다.
- 특징: **배치 없음, 요청 병렬만 있음**

#### 2-2. BIN
- 기본 경로:
  - Grade 필터가 **없으면** `/api/bin-map-thumb`
  - Grade 필터가 **있으면** `/api/thumbnail?...&bin_overlay=1`
- 프런트: 그리드 큐가 동시에 여러 장을 요청한다.
- 서버:
  - `/api/bin-map-thumb`는 `THUMBNAIL_EXECUTOR`에서 병렬 처리
  - `/api/thumbnail?...bin_overlay=1`도 일반 thumbnail executor를 탄다
- 특징: **배치 없음, 요청 병렬만 있음**

#### 2-3. Measure (FBT/QVL)
- 경로: `/api/measure-thumb?path=...&field=f|q&key=...`
- 프런트:
  - visible grid thumbnail 요청은 일반 그리드 큐로 병렬 처리
  - 추가로 `_prefetchCheckedMeasureThumbs()`가 `/api/measure-thumb-batch`를 이미지별 병렬 워밍업
- 서버:
  - 단건 `/api/measure-thumb`는 `THUMBNAIL_EXECUTOR`
  - 배치 `/api/measure-thumb-batch`도 `THUMBNAIL_EXECUTOR`
- 특징: **요청 병렬 + 배치 워밍업 있음**

#### 2-4. Composite / Measure Composite 결과 생성
- 경로:
  - `/api/composite-map/*`
  - `/api/measure-composite-data`
  - `/api/measure-composite`
- 서버:
  - `COMPOSITE_EXECUTOR`
  - 별도 polling / status 경로
- 특징:
  - thumbnail executor와 분리된 별도 executor를 사용
  - 결과 생성 후 PNG/JPEG 저장 속도가 체감 지연을 크게 좌우

### 3. 여태 속도 측면에서 실제로 바꾼 것들

#### 3-1. 검색 / 그리드 렌더
- `performSearch()`가 검색 완료 전까지 썸네일 로딩을 기다리지 않도록 분리
- `showGrid()`에서 그리드 셸(DOM)을 먼저 붙이고, 실제 썸네일은 visible 범위부터 뒤에서 로드
- 그리드 셀 크기 변경 시 1000개 셀에 개별 width/height를 쓰지 않고 CSS 변수 기반으로 갱신
- `querySelectorAll()` 전체 재스캔을 줄이고 `gridThumbWraps` 배열을 누적 캐시
- `content-visibility: auto` / intrinsic size 적용으로 offscreen layout 비용 축소
- offsetTop/offsetHeight 캐시 + 이진 탐색으로 스크롤 시 visible 범위 계산 비용 축소

#### 3-2. cold 일반 thumbnail
- `showGridImmediately()`의 즉시 로드 경로를 큐/재시도와 맞물리게 조정
- JPEG/WEBP 저장 옵션을 빠른 설정으로 통일
- PIL JPEG 폴백의 `optimize=True` 제거
- pyvips 저장을 공통 fast helper로 통합:
  - `_jpegsave_fast_to_file`
  - `_jpegsave_fast_buffer`
  - `_webpsave_fast_to_file`
  - `_webpsave_fast_buffer`
- cold thumbnail 생성 worker 수를 executor 환경변수로 분리 가능하게 변경

#### 3-3. BIN
- Grade 필터가 없을 때 무거운 `bin_overlay=1` thumbnail 경로를 타지 않고 경량 `/api/bin-map-thumb`로 우회
- `_generate_bin_map_thumb()`가 positions JSON 캐시(`_load_positions_cached`)를 사용하도록 변경
- BIN thumbnail도 PIL만 쓰지 않고 pyvips fast WEBP buffer를 우선 사용
- BIN thumbnail도 `IO_POOL`이 아니라 `THUMBNAIL_EXECUTOR`에서 처리되게 변경

#### 3-4. Measure
- `/api/measure-thumb`는 원본 이미지 로드 없이 positions-only gradient heatmap 경로 유지
- `/api/measure-thumb-batch`를 다시 프런트 prefetch에 연결
- 다중 Measure 그리드 진입 직후 `_prefetchCheckedMeasureThumbs(sortedImages)`를 호출하여 visible 로드 전에 캐시를 먼저 채움
- 단건/배치 measure 모두 `THUMBNAIL_EXECUTOR`로 이동
- `measure-thumb` 404는 빈 회색 placeholder로 처리하여 깨진 이미지 아이콘 방지

#### 3-5. Composite / Measure Composite
- Composite/Measure background task polling을 1초 고정 대기에서 짧은 시작 + backoff로 변경
- indexed-color PNG 저장 경로에서 `compress_level` / `optimize`를 속도 위주로 조정
- `measure_composite.py` 저장 경로도 `compress_level=0`으로 변경
- startup 시 composite/measure 모듈 warmup을 걸어 첫 클릭 lazy import 비용을 줄이는 구조 추가

### 4. 병렬 튜닝용 환경변수 (최신)

이제 아래 4개를 스크립트에서 직접 조절할 수 있다.

| 환경변수 | 역할 | 적용 위치 |
|---|---|---|
| `THUMBNAIL_EXECUTOR_WORKERS` | 서버 썸네일 executor worker 수 | `api/main.py` |
| `THUMB_CLIENT_MAX_CONCURRENCY` | `ThumbnailManager` 동시 요청 수 | `api/config.py` → `/api/config` → `js/main.js` |
| `GRID_MAX_CONCURRENCY` | grid lazy loader 동시 요청 상한 | `api/config.py` → `/api/config` → `js/main.js` |
| `MEASURE_PREFETCH_CONCURRENCY` | `/api/measure-thumb-batch` 동시 prefetch 수 | `api/config.py` → `/api/config` → `js/main.js` |

**현재 기본값**:

#### Windows 로컬 (`start.ps1`)
- `THUMB_CLIENT_MAX_CONCURRENCY=14`
- `GRID_MAX_CONCURRENCY=48`
- `MEASURE_PREFETCH_CONCURRENCY=8`
- `THUMBNAIL_EXECUTOR_WORKERS=32`

#### Ubuntu 운영 (`start.sh`, 32C / 198GB 기준)
- `THUMB_CLIENT_MAX_CONCURRENCY=14`
- `GRID_MAX_CONCURRENCY=48`
- `MEASURE_PREFETCH_CONCURRENCY=8`
- `THUMBNAIL_EXECUTOR_WORKERS=64`

> 주의:
> - `start.sh` 값은 **32코어 / 198GB 서버 기준으로 스케일한 추천값**이다.
> - 로컬 16코어 벤치 결과를 기반으로 올린 값이므로, 실제 Ubuntu 서버에서 1회 이상 실측 검증이 필요하다.

### 5. 병렬 프로필 벤치 (2026-04-01, 로컬 16C, cold)

측정 조건:
- `D:/project/data/wm-811k/thumbnails` 삭제
- 8443 서버 재시작
- `unknown`에 실제 존재하는 `AAU220`, `ABM792`, `AAV489` 샘플
- generic/failbit 48장 burst
- bin 24장 burst
- measure-thumb 24장 burst
- measure-thumb-batch 12개 이미지 × 2 key

| profile | thumbExec | grid | measurePrefetch | thumbClient | generic total | generic p95 | bin total | measure total | measure-batch total |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| balanced | 24 | 40 | 6 | 12 | 1589.4ms | 972.6ms | 579.5ms | 156.4ms | 7142.3ms |
| high | 32 | 48 | 8 | 14 | 1530.4ms | 972.6ms | 492.7ms | 194.7ms | 6915.2ms |
| xhigh | 48 | 64 | 12 | 16 | 1307.6ms | 823.9ms | 615.7ms | 228.2ms | 7078.7ms |
| hybridA | 48 | 64 | 8 | 14 | 1413.9ms | 937.1ms | 583.0ms | 229.5ms | 7311.9ms |
| hybridB | 40 | 56 | 8 | 14 | 1494.0ms | 934.0ms | 620.6ms | 173.5ms | 6995.7ms |

**해석**:
- `generic/failbit`는 공격적으로 올릴수록 빨라지는 경향이 있다.
- `bin`과 `measure-batch`는 너무 높이면 오히려 흔들린다.
- 전체 균형은 `high (32 / 48 / 8 / 14)`가 가장 무난했다.
- 따라서 현재 기본값은 `high` 프로필을 채택했다.

### 6. 최신 cold API 실측 (2026-03-31)

썸네일 폴더 삭제 + 서버 재시작 후 API 직접 측정:

| 항목 | 실측 |
|---|---:|
| generic cold 48 total | 1597.7ms |
| generic cold 48 median | 927.0ms |
| generic cold 48 p95 | 1204.9ms |
| generic cold 48 max | 1311.7ms |
| 구형 BIN overlay (`/api/thumbnail?...bin_overlay=1`) | 169.7ms |
| 신규 BIN 경량 (`/api/bin-map-thumb`) | 26.3ms |
| measure-thumb 단건 | 9.1ms |
| measure-thumb-batch 2 key | 6.7ms |

**결론**:
- BIN은 전용 경량 경로가 압도적으로 빠르다.
- Measure는 이미 빠른 편이지만, batch warmup을 통해 그리드 첫 체감을 더 줄인다.
- generic/failbit는 여전히 cold thumbnail 생성이 가장 큰 비용이다.

### 7. E2E에서 반드시 추가로 검증해야 할 것

#### 7-1. `/api/config` 병렬 설정 반영 확인
서버를 올린 직후 아래 4개가 기대값과 같은지 본다.

```javascript
const cfg = await fetch('/api/config').then(r => r.json());
({
  THUMB_MAX_CONCURRENCY: cfg.THUMB_MAX_CONCURRENCY,
  GRID_MAX_CONCURRENCY: cfg.GRID_MAX_CONCURRENCY,
  MEASURE_PREFETCH_CONCURRENCY: cfg.MEASURE_PREFETCH_CONCURRENCY,
  THUMBNAIL_EXECUTOR_WORKERS: cfg.THUMBNAIL_EXECUTOR_WORKERS,
});
```

**pass 기준**:
- `start.ps1`로 띄운 로컬: `14 / 48 / 8 / 32`
- `start.sh` 운영 기준: `14 / 48 / 8 / 64`

#### 7-2. 타입별 URL 라우팅 확인

```javascript
const v = window.viewer;
v._measureCheckedItems = [
  { type: 'failbit', key: null, label: 'Failbit' },
  { type: 'bin', key: null, label: 'BIN' },
  { type: 'f', key: '1000', label: 'FBT1000' },
];
v._gridMeasureMap = [...v._measureCheckedItems];
[
  v._buildMeasureThumbUrl('unknown/AAU220_00P_13_20260501_010000_96.0_2_EE_PWQ.png', v._measureCheckedItems[0], ''),
  v._buildMeasureThumbUrl('unknown/AAU220_00P_13_20260501_010000_96.0_2_EE_PWQ.png', v._measureCheckedItems[1], ''),
  v._buildMeasureThumbUrl('unknown/AAU220_00P_13_20260501_010000_96.0_2_EE_PWQ.png', v._measureCheckedItems[2], ''),
];
```

**pass 기준**:
- failbit: `/api/thumbnail`
- bin: grade filter가 없으면 `/api/bin-map-thumb`
- f/q: `/api/measure-thumb`

#### 7-3. 병렬도별 재현 벤치

튜닝이 다시 필요하면 아래 순서로 반복한다.

1. `thumbnails` 폴더 삭제
2. 서버 완전 재시작
3. 새 브라우저 세션으로 접속
4. `/api/config`로 병렬 설정 확인
5. 아래 4개를 각각 측정
   - generic/failbit 48 burst
   - bin 24 burst
   - measure-thumb 24 burst
   - measure-thumb-batch 12×2 burst
6. `THUMBNAIL_EXECUTOR_WORKERS`, `GRID_MAX_CONCURRENCY`, `MEASURE_PREFETCH_CONCURRENCY`, `THUMB_CLIENT_MAX_CONCURRENCY`를 한 번에 하나씩만 바꿔 비교

#### 7-4. 해석 규칙
- generic만 빨라지고 bin/measure가 느려지면 `GRID_MAX_CONCURRENCY` 또는 `THUMBNAIL_EXECUTOR_WORKERS`가 과도한 것일 수 있다.
- measure batch가 늘어질 때는 `MEASURE_PREFETCH_CONCURRENCY`가 너무 높을 가능성이 크다.
- bin이 느리면 `/api/bin-map-thumb`를 타는지, grade filter 때문에 무거운 `bin_overlay=1` 경로로 떨어진 건 아닌지 먼저 확인한다.
- failbit는 아직 전용 batch가 없으므로, 보이는 썸네일의 요청 병렬도와 서버 executor가 전부다.

### 8. 최신 수정 파일 매핑

- `js/main.js`
  - grid shell 선렌더 + visible lazy load
  - measure prefetch 재활성화
  - BIN 경량 API 라우팅
  - polling backoff
  - 병렬 설정값 수신 (`/api/config`)
- `api/main.py`
  - fast JPEG/WEBP helper
  - BIN/Measure 단건/배치의 `THUMBNAIL_EXECUTOR` 이동
  - `/api/bin-map-thumb`
  - `/api/config`에 병렬 설정 노출
- `api/config.py`
  - `GRID_MAX_CONCURRENCY`
  - `MEASURE_PREFETCH_CONCURRENCY`
  - `THUMBNAIL_EXECUTOR_WORKERS`
- `api/composite_map.py`
  - indexed-color PNG 저장 경로 최적화
- `api/measure_composite.py`
  - composite 저장 compress level 최적화
- `start.ps1`
  - 로컬 16코어 기준 high profile 기본값
- `start.sh`
  - 32코어 / 198GB 기준 스케일된 기본값

## 버그 수정 이력 (2026-04-01, 생성 탭 복귀 시 wafer 그리드 스크롤 복원)

### Composite/Measure 생성 후 wafer 탭 복귀 시 그리드 스크롤 초기화
- **버그**: `wafer0` 그리드에서 이미지를 선택한 뒤 `Composite`로 `com0` 또는 `Measure`로 `mea0`를 생성하고 다시 `wafer0`를 클릭하면 그리드 스크롤이 맨 위로 초기화됨
- **원인**: `buildSavedViewSnapshot()`가 기존 `savedViewState`를 그대로 재사용하여, 생성 직전 DOM의 실제 `scrollTop` 대신 stale snapshot 값을 저장함
- **수정**: grid snapshot 생성 시 `getGridScrollWrapper()`에서 현재 `scrollTop`을 다시 읽어 저장하고, 기존 grid 이미지 목록은 보존
- **파일**: `js/main.js` (`buildSavedViewSnapshot`)

### E2E 검증 방법
1. `unknown`를 열고 flat grid 상태(`lotMode=false`)로 맞춘다.
2. `.grid-scroll-wrapper.scrollTop = 5200`으로 이동하고 임의 이미지 1개를 선택한다.
3. `window.viewer.handleCompositeCreate()`로 `com0`를 생성한다.
4. `wafer0` 탭으로 돌아와 `scrollTop === 5200`인지 확인한다.
5. 다시 `wafer0`에서 `.grid-scroll-wrapper.scrollTop = 6400`으로 이동하고 이미지 1개를 선택한다.
6. 유효한 measure key를 설정한 뒤 `window.viewer._openMeasureTab()`으로 `mea0`를 생성한다.
7. `wafer0` 탭으로 돌아와 `scrollTop === 6400`인지 확인한다.

### PASS 기준
- `com0` 생성 전후 `wafer0`의 `scrollTop`이 동일하다.
- `mea0` 생성 전후 `wafer0`의 `scrollTop`이 동일하다.
- 복귀 후 `.grid-scroll-wrapper`가 유지되고 `scrollHeight > 0`이다.

## Daily Cleanup (매일 새벽 2시 자동 정리)

### 개요
서버가 살아 있는 동안 매일 새벽 2:00 (KST)에 `composite_map`과 `thumbnails` 폴더를 통째로 삭제하고 빈 폴더로 재생성한다.
thumbnails는 요청 시 자동 재생성되므로 삭제해도 서비스에 영향 없다.

### 코드 위치
`api/main.py` 한 파일 안에 전부 있다.

#### 설정값 (환경변수)
```python
DAILY_CLEANUP_HOUR = 2       # 실행 시각 (시)
DAILY_CLEANUP_MINUTE = 0     # 실행 시각 (분)
DAILY_CLEANUP_ENABLED = True  # "0"/"false"/"no"/"off"로 비활성화 가능
```

#### 삭제 대상
| 폴더 | 경로 | 설명 |
|---|---|---|
| `composite_map` | `{PROJECT_ROOT}/composite_map/` | Composite Map 결과물 (heatmap, NPZ 등) |
| `thumbnails` | `{PROJECT_ROOT}/thumbnails/` | 썸네일 캐시 (요청 시 자동 재생성) |
| `positions/composite_map` | `{POSITIONS_ROOT}/composite_map/` | Composite용 positions 데이터 |

#### 핵심 함수
```
_wipe_and_recreate(folder)     → shutil.rmtree() + mkdir()
_daily_cleanup()               → 3개 폴더에 _wipe_and_recreate 실행
_daily_cleanup_loop(hour, min) → while True: sleep(다음 02:00까지) → _daily_cleanup()
_start_daily_cleanup()         → lifespan에서 호출, asyncio.create_task로 루프 시작
_stop_daily_cleanup()          → 서버 종료 시 task cancel
```

#### 동작 흐름
```
서버 시작
  └→ lifespan yield 전에 _start_daily_cleanup() 호출
       └→ asyncio.create_task(_daily_cleanup_loop(2, 0))
            └→ while True:
                 ├→ 다음 02:00까지 초 계산 → asyncio.sleep()
                 ├→ run_in_executor로 _daily_cleanup() 실행 (이벤트 루프 비블로킹)
                 │    ├→ composite_map: rmtree + mkdir
                 │    ├→ thumbnails: rmtree + mkdir
                 │    └→ positions/composite_map: rmtree + mkdir
                 └→ 로그 출력 후 다음 날 02:00까지 다시 sleep
```

#### E2E 검증 방법
```python
# 1. 설정값 확인
from api.main import DAILY_CLEANUP_ENABLED, DAILY_CLEANUP_HOUR, DAILY_CLEANUP_MINUTE
assert DAILY_CLEANUP_ENABLED == True
assert DAILY_CLEANUP_HOUR == 2
assert DAILY_CLEANUP_MINUTE == 0

# 2. 다음 실행 시각 확인
from api.main import _seconds_until_next_daily_run
wait, run_at = _seconds_until_next_daily_run(2, 0)
assert 0 < wait <= 86400  # 최대 24시간 이내

# 3. 수동 실행 테스트 (실제로 폴더가 비워지는지)
from api.main import _daily_cleanup
result = _daily_cleanup()
for name, info in result.items():
    assert info['ok'] == True
```

#### 이전 구조와의 차이
| 항목 | 이전 | 현재 |
|---|---|---|
| 삭제 대상 | composite_map만 | composite_map + thumbnails |
| 삭제 방식 | dir별 mtime 비교 → 개별 삭제 | 폴더 통째 rmtree |
| 모드 | daily / interval 2가지 | daily 1가지 |
| 환경변수 | 6개 | 3개 |
| 코드 라인 | ~211줄 | ~62줄 |

## Label/ChipLabel 이미지 — Wafer Map Explorer 완전 분리 (2026-04-01)

### 버그 현상
1. Label Explorer에서 라벨 이미지를 더블클릭하면 Wafer Map Explorer에서 **원본 파일이 하이라이트**됨
2. 좌우 네비게이션(← →)할 때도 Wafer Map Explorer가 따라 움직임
3. 라벨 이미지를 보면서 삭제하면 원본과 라벨 이미지 사이 전환이 반복되며 **떨림/진동** 발생

### 원인
- `resolveLabelExplorerImagePath()`가 원본 경로(`unknown/...`)를 반환 → `isClassificationPath()` 통과
- `updateWaferMapExplorerHighlight()`가 원본 경로를 받아 Wafer Map Explorer를 스크롤+하이라이트
- 라벨 삭제 후 `restoreSavedViewState()`가 Wafer Map Explorer의 상태를 복원 → 원본 ↔ 라벨 전환

### 수정
`updateWaferMapExplorerHighlight()` 진입점에서 4가지 조건으로 차단:

```javascript
updateWaferMapExplorerHighlight(imagePath) {
    if (!this.dom.fileExplorer || !imagePath) return;
    if (this.isClassificationPath(imagePath)) return;        // classification 경로
    if (this.gridViewSaveState?.source === 'labelExplorer') return;  // Label 그리드에서 진입
    if (this.isLabelExplorerGridActive?.()) return;           // Label 그리드 활성 상태
    if (this.activePageRole === 'label') return;              // label 탭
    // ... 정상 하이라이트 로직
}
```

추가 수정:
- `enterSingleImageMode()`: Label 그리드에서 진입 시 `fromLabelExplorer=true`
- `navigateSingleImageGrid()`: Label 이미지 네비게이션 시 `fromLabelExplorer=true`
- 라벨 삭제 후: `restoreSavedViewState()` 대신 Label 그리드로 복귀

### E2E 검증 코드

```javascript
// 전제: unknown 폴더가 Ctrl+클릭으로 선택된 상태, asDF 클래스에 라벨이 1개 이상 존재

// 1. Label Explorer 그리드 로드
const v = window.viewer;
await v.refreshLabelExplorer();
v.labelSelection.selected = (v.classToImgListCache?.['asDF'] || []).map(img => `asDF/${img.name}`);
v.showGridFromLabelExplorer(v.labelSelection.selected);

// 2. 그리드 확인
const grid = document.getElementById('image-grid');
assert(grid.hasAttribute('data-label-explorer-grid'));  // Label 그리드
assert(v.activePageRole === 'label');                    // label 탭

// 3. 더블클릭 전 Wafer Map Explorer 하이라이트 = 0
const beforeCount = document.querySelectorAll('#file-explorer a.selected, #file-explorer a.highlight').length;
assert(beforeCount === 0);

// 4. 더블클릭
grid.querySelectorAll('.grid-thumb-wrap')[0].ondblclick({ preventDefault(){}, stopPropagation(){} });
await new Promise(r => setTimeout(r, 2000));

// 5. 더블클릭 후 Wafer Map Explorer 하이라이트 = 0 (안 움직임)
const afterCount = document.querySelectorAll('#file-explorer a.selected, #file-explorer a.highlight').length;
assert(afterCount === 0);  // ← 이전에는 1이 됐음 (버그)

// 6. source가 labelExplorer인지
assert(v.gridViewSaveState?.source === 'labelExplorer');

// 7. 네비게이션 후에도 하이라이트 = 0
v.navigateSingleImageGrid(1);
await new Promise(r => setTimeout(r, 1500));
const navCount = document.querySelectorAll('#file-explorer a.selected, #file-explorer a.highlight').length;
assert(navCount === 0);  // ← 이전에는 1이 됐음 (버그)
```

### PASS 기준
| 항목 | 기대값 |
|---|---|
| Label 그리드 로드 후 `data-label-explorer-grid` | `true` |
| `activePageRole` | `'label'` |
| 더블클릭 전 Wafer Map Explorer 하이라이트 수 | `0` |
| 더블클릭 후 Wafer Map Explorer 하이라이트 수 | `0` |
| `gridViewSaveState.source` | `'labelExplorer'` |
| → 키 네비게이션 후 Wafer Map Explorer 하이라이트 수 | `0` |

### 수정 파일
- `js/main.js`
  - `updateWaferMapExplorerHighlight()`: classification 경로 + label 컨텍스트 차단
  - `enterSingleImageMode()`: `_fromLabelExplorer` 플래그
  - `navigateSingleImageGrid()`: `_navFromLabel` 플래그
  - 라벨 삭제 후 복원: Label 그리드 복귀 분기 추가

## 빈 폴더/필터 0건 시 상단 패널 유지 (2026-04-01)

### 버그 현상
빈 폴더를 Ctrl+클릭하거나 필터로 결과가 0건이 되면 `hideGrid()`가 호출되어 상단 패널(컬럼 슬라이더, 검색, LOT Mode 등)이 사라짐. 필터를 해제할 수 없는 상태가 됨.

### 수정
`showEmptyGridMessage(message)` 헬퍼 추가:
- 상단 패널(`grid-controls`)은 **유지**
- 그리드 영역에 안내 메시지만 표시
- `gridMode = true` 유지 → 필터 해제 시 정상 그리드로 복원 가능

### 메시지
| 상황 | 메시지 |
|---|---|
| 빈 폴더 | "선택한 폴더에 이미지가 없습니다" |
| 필터 0건 | "현재 필터 조건에 맞는 이미지가 없습니다" |

### E2E 검증

```javascript
// 1. unknown Ctrl+클릭 → 3000개 그리드
// 2. 존재하지 않는 LOT 필터 적용
const v = window.viewer;
v.filterLT = ['NONEXISTENT'];
await v._applyFilterToGrid();

// 3. 상단 패널이 보이는지
const gc = document.getElementById('grid-controls');
assert(gc.offsetHeight > 0);             // 상단 패널 유지
assert(v.gridMode === true);             // 그리드 모드 유지

// 4. 안내 메시지가 표시되는지
const grid = document.getElementById('image-grid');
assert(grid.textContent.includes('이미지가 없습니다'));

// 5. 필터 해제 → 복원
v.filterLT = [];
await v._applyFilterToGrid();
assert(v.selectedImages.length === 3000);  // 원래 이미지 복원
```

## 그리드/라벨 단일 보기 + Next 통합 검증 (2026-04-01)

### 검증 항목 및 PASS 기준

| # | 시나리오 | PASS 기준 | 비고 |
|---|---|---|---|
| 1 | 폴더 Ctrl+클릭 → 그리드 | `gridMode=true`, `wraps >= 1` | |
| 2 | 그리드 더블클릭 → 단일 모드 | `viewMode='gridImage'`, `source='grid'` | |
| 3 | 단일 모드 Next(→) | `selectedImagePath` 변경, Explorer 하이라이트 1 | 원본이므로 정상 |
| 4 | ESC → 그리드 복귀 | `gridMode=true`, `wraps` 유지 | |
| 5 | Label Explorer 그리드 | `data-label-explorer-grid` 존재, `role='label'` | |
| 6 | Label 더블클릭 → 단일 | `path`가 `classification/...`, Explorer 하이라이트 **0** | |
| 7 | Label Next 1회 | 다음 `classification/...` 이미지, Explorer **0** | |
| 8 | Label Next 2회 | 또 다음 이미지, Explorer **0** | |
| 9 | 빈 필터 메시지 | `gridControls.offsetHeight > 0`, 메시지 포함 | |

### 실측 결과 (2026-04-01)

```
p1_grid:      { images: 3000, wraps: 3000, gridMode: true }
p1_dblclick:  { viewMode: 'gridImage', explorerHighlight: 1, source: 'grid' }
p1_next:      { path: 'unknown/...0027...', explorerHighlight: 1 }
p1_esc:       { gridMode: true, wraps: 3000 }
p2_labelGrid: { isLabelGrid: true, wraps: 16, role: 'label' }
p2_dblclick:  { path: 'classification/asDF/...0003...', explorerHighlight: 0, source: 'labelExplorer' }
p2_next:      { path: 'classification/asDF/...0027...', explorerHighlight: 0 }
p2_next2:     { path: 'classification/asDF/...0051...', explorerHighlight: 0 }
p3_emptyFilter: { gridControlsVisible: true, message: '이미지가 없습니다...', gridMode: true }
```

### 핵심 규칙
- 일반 그리드(source='grid'): 더블클릭/Next 시 Explorer 하이라이트가 **따라가야** 한다
- Label 그리드(source='labelExplorer'): 더블클릭/Next 시 Explorer 하이라이트가 **절대 움직이면 안 된다**
- Label 경로는 `classification/...`이어야 하고, 원본 `unknown/...`로 빠지면 안 된다

---

## Phase 51: 위치별 토큰 검색 (token[0] / token[2]) 검증

**목적**: 검색이 파일명 `_` split 후 **위치별**로 동작하는지 검증. 모든 검색은 token[0] 기반, AND 오른쪽만 token[2] 추가 필터.

**배경**:
- 파일명 규칙: `LOT_BINTYPE_WAFER_TIMESTAMP.png` → `_` split → token[0]=LOT, token[2]=WAFER
- 검색어는 해당 위치의 토큰에 **포함(contains)** 매칭, **대소문자 무시**
- 기존에는 모든 토큰 위치에서 검색하여 의도하지 않은 결과가 나오던 문제 수정

**테스트 데이터**:
```
unknown/unknown_0005.png     → token[0]=wafer, token[2]=ring
unknown/unknown_0005.png → token[0]=wafer, token[2]=gradient
unknown/unknown_0010.png → token[0]=wafer, token[2]=cool
backup/Edge-Ring_1_padded.png                → token[0]=edge-ring, token[2]=padded
unknown/AAU220_00P_13_20260501_010000_96.0_2_EE_PWQ.png → token[0]=AAU220, token[2]=13
```

### 51-1. 단일 검색 — token[0] 전용

| # | 검색어 | 예상 결과 | 설명 |
|---|--------|----------|------|
| 1 | `edge` | backup/Edge-* 파일만 (16건) | token[0]="edge-ring","edge-loc" → "edge" 포함 ✓ |
| 2 | `wafer` | wafer_* 파일 전체 (112,006건) | token[0]="wafer" ✓ |
| 3 | `cool` | 0건 | token[0]="wafer" → "cool" 미포함 |
| 4 | `ring` | 0건 | token[0]="wafer" → "ring" 미포함 |
| 5 | `aau220` | >0건 | token[0]="aau220" ✓ |

**검증 포인트**: `unknown_*` 파일이 `edge` 검색에 나오면 **FAIL** (token[0]="wafer"이므로)

```javascript
const a1 = await (await fetch('/api/search?q=edge&folder=&limit=5')).json();
console.assert(a1.total === 16, `edge 검색: ${a1.total}건 (expected 16)`);
console.assert(!a1.results.some(r => r.startsWith('wafer_')), 'wafer_* 파일 혼입 금지');

const a2 = await (await fetch('/api/search?q=wafer&folder=&limit=5')).json();
console.assert(a2.total > 100000, `wafer 검색: ${a2.total}건`);

const a3 = await (await fetch('/api/search?q=cool&folder=&limit=5')).json();
console.assert(a3.total === 0, `cool 단독 검색: ${a3.total}건 (expected 0)`);

const a4 = await (await fetch('/api/search?q=ring&folder=&limit=5')).json();
console.assert(a4.total === 0, `ring 단독 검색: ${a4.total}건 (expected 0)`);
```

### 51-2. AND 검색 — token[0] + token[2]

| # | 검색어 | 예상 결과 | 설명 |
|---|--------|----------|------|
| 1 | `wafer and ring` | 3000건 | token[0]∋"wafer" + token[2]∋"ring" |
| 2 | `wafer and cool` | 3000건 | token[0]∋"wafer" + token[2]∋"cool" |
| 3 | `wafer and gradient` | 3000건 | token[0]∋"wafer" + token[2]∋"gradient" |
| 4 | `edge and 0005` | 0건 | token[0]∋"edge"(backup만) → token[2]∋"0005" 없음 |
| 5 | `aau220 and 13` | 125건 | token[0]∋"aau220" → token[2]∋"04" |

```javascript
const b1 = await (await fetch('/api/search?q=wafer+and+ring&folder=&limit=5')).json();
console.assert(b1.total === 3000, `wafer AND ring: ${b1.total}`);

const b4 = await (await fetch('/api/search?q=edge+and+0005&folder=&limit=5')).json();
console.assert(b4.total === 0, `edge AND 0005: ${b4.total} (expected 0)`);

const b5 = await (await fetch('/api/search?q=aau220+and+13&folder=&limit=5')).json();
console.assert(b5.total > 0, `aau220 AND 04: ${b5.total}`);
```

### 51-3. OR 검색 — token[0] 합집합

| # | 검색어 | 예상 결과 | 설명 |
|---|--------|----------|------|
| 1 | `edge or cool` | 16건 | token[0]∋"edge"(16) ∪ token[0]∋"cool"(0) |
| 2 | `aau220 or abm792` | 1024건 | token[0]∋"aau220"(500) ∪ token[0]∋"abm792"(524) |

```javascript
const c1 = await (await fetch('/api/search?q=edge+or+cool&folder=&limit=5')).json();
console.assert(c1.total === 16, `edge OR cool: ${c1.total}`);

const c2 = await (await fetch('/api/search?q=aau220+or+abm792&folder=&limit=5')).json();
console.assert(c2.total > 1000, `aau220 OR abm792: ${c2.total}`);
```

### 51-4. 복합 검색 — (A and B) or (C and D)

| # | 검색어 | 예상 결과 | 설명 |
|---|--------|----------|------|
| 1 | `(wafer and ring) or (wafer and cool)` | 6000건 | 3000+3000 |
| 2 | `(wafer and ring) or (wafer and gradient)` | 6000건 | 3000+3000 |
| 3 | `(aau220 and 13) or (abm792 and 05)` | >0건 | 두 LOT 교차 |

```javascript
const d1 = await (await fetch('/api/search?q=(wafer+and+ring)+or+(wafer+and+cool)&folder=&limit=5')).json();
console.assert(d1.total === 6000, `복합 검색: ${d1.total}`);
```

### 51-5. 대소문자 무시

| # | 검색어 | 예상 결과 | 설명 |
|---|--------|----------|------|
| 1 | `WAFER and RING` | 3000건 | 대문자 → 소문자 자동 변환 |
| 2 | `Edge` | 16건 | Edge → edge 자동 변환 |
| 3 | `Wafer AND Cool` | 3000건 | 혼합 대소문자 |

```javascript
const e1 = await (await fetch('/api/search?q=WAFER+and+RING&folder=&limit=5')).json();
console.assert(e1.total === 3000, `대소문자: ${e1.total}`);

const e2 = await (await fetch('/api/search?q=Edge&folder=&limit=5')).json();
console.assert(e2.total === 16, `Edge 대소문자: ${e2.total}`);
```

### 51-6. 위치 교차 검증 (핵심)

token[0]과 token[2]가 뒤바뀌면 결과가 달라져야 한다.

| # | 검색어 | 예상 | 역방향 | 역방향 결과 |
|---|--------|------|--------|------------|
| 1 | `wafer and ring` | 3000건 | `ring and wafer` | 0건 (token[0]∋"ring" 없음) |
| 2 | `aau220 and 13` | 125건 | `13 and aau220` | 0건 (token[0]∋"04" 없음) |

```javascript
const f1 = await (await fetch('/api/search?q=ring+and+wafer&folder=&limit=5')).json();
console.assert(f1.total === 0, `역방향 ring AND wafer: ${f1.total} (expected 0)`);

const f2 = await (await fetch('/api/search?q=13+and+aau220&folder=&limit=5')).json();
console.assert(f2.total === 0, `역방향 04 AND aau220: ${f2.total} (expected 0)`);
```

**pass 기준**:
- 51-1: 단일 검색 5건 모두 token[0] 기반 결과
- 51-2: AND 검색 5건 모두 token[0]+token[2] 교차 결과
- 51-3: OR 검색 2건 token[0] 합집합
- 51-4: 복합 검색 결과 정확
- 51-5: 대소문자 무시 3건
- 51-6: 역방향 AND 0건 (위치 구분 증명)

### 51-7. 다중검색 (LOT multi) + query 조합

| # | 검색어 | lot_multi | 결과 | 서버(ms) | 모드 |
|---|--------|-----------|------|----------|------|
| 1 | (없음) | aau220,abm792,aai216 | >0건 | 10ms | lot-index |
| 2 | (없음) | aau220,abm792,aav489,aai216,aad534,aai158 | 3120건 | 13ms | lot-index |
| 3 | (없음) | aau220 | >0건 | 2.6ms | lot-index |
| 4 | `aau220 and 13` | aau220 | 141건 | 1.2ms | query+lot |
| 5 | `abm792 and 05` | abm792 | 144건 | 1.4ms | query+lot |
| 6 | `04` | aau220 | 141건 | 3.2ms | query+lot |

> **주의**: lot_multi path는 글로벌 인덱스 사용 불가 (subset이므로), 순차스캔 fallback 사용.
> 그래서 #4(141건) vs 전체 AND(125건) 차이 발생 — lot_multi는 파일명 전체 매칭, 전체는 위치별 매칭.

```javascript
// lot_multi + AND 조합 테스트
const g1 = await (await fetch('/api/search?q=&folder=&limit=5000&lot_multi=aau220,abm792,aai216')).json();
console.assert(g1.total === 1548, `LOT multi 3개: ${g1.total}`);

const g2 = await (await fetch('/api/search?q=aau220+and+13&folder=&limit=5000&lot_multi=aau220')).json();
console.assert(g2.total > 0, `LOT multi + AND: ${g2.total} (expected > 0)`);
```

### 51-8. 폴더 한정 검색

| # | 검색어 | 폴더 | 결과 | 서버(ms) | 모드 |
|---|--------|------|------|----------|------|
| 1 | `aau220` | unknown | >0건 | 2.8ms | simple |
| 2 | `aau220 and 13` | unknown | 141건 | 1.9ms | logical |

> **주의**: 폴더 한정 시 글로벌 인덱스 사용 불가, 순차스캔 fallback.

### 실측 결과 (2026-04-01)

**위치별 토큰 검색 (전체)**:

| 테스트 | 검색어 | 예상 | 실측 | 서버(ms) | 판정 |
|--------|--------|------|------|----------|------|
| 51-1-1 | `edge` | 16 | 16 | 0.7 | PASS |
| 51-1-2 | `wafer` | 112006 | 112006 | 313 | PASS |
| 51-1-3 | `cool` | 0 | 0 | 0.6 | PASS |
| 51-1-4 | `aau220` | 500 | 500 | 1.7 | PASS |
| 51-2-1 | `wafer and ring` | 3000 | 3000 | 11.6 | PASS |
| 51-2-2 | `wafer and cool` | 3000 | 3000 | 11.2 | PASS |
| 51-2-3 | `edge and 0005` | 0 | 0 | 0.6 | PASS |
| 51-2-4 | `aau220 and 13` | 125 | 125 | 1.2 | PASS |
| 51-3-1 | `edge or cool` | 16 | 16 | 0.6 | PASS |
| 51-3-2 | `aau220 or abm792` | 1024 | 1024 | 3.6 | PASS |
| 51-4-1 | `(wafer and ring) or (wafer and cool)` | 6000 | 6000 | 21 | PASS |
| 51-4-2 | `(aau220 and 13) or (abm792 and 05)` | >0 | 251 | 1.7 | PASS |
| 51-5-1 | `WAFER and RING` | 3000 | 3000 | 11 | PASS |
| 51-5-2 | `Edge` | 16 | 16 | 0.5 | PASS |
| 51-6-1 | `ring and wafer` (역방향) | 0 | 0 | 0.6 | PASS |
| 51-6-2 | `13 and aau220` (역방향) | 0 | 0 | 0.6 | PASS |

**다중검색 (LOT multi)**:

| 테스트 | 검색어 | lot_multi | 실측 | 서버(ms) | 판정 |
|--------|--------|-----------|------|----------|------|
| 51-7-1 | (없음) | 3개 LOT | 1548 | 10 | PASS |
| 51-7-2 | (없음) | 6개 LOT | 3120 | 13 | PASS |
| 51-7-3 | (없음) | 1개 LOT | 500 | 2.6 | PASS |
| 51-7-4 | `aau220 and 13` | aau220 | 141 | 1.2 | PASS |
| 51-7-5 | `abm792 and 05` | abm792 | 144 | 1.4 | PASS |
| 51-7-6 | `04` | aau220 | 141 | 3.2 | PASS |

**폴더 한정**:

| 테스트 | 검색어 | 폴더 | 실측 | 서버(ms) | 판정 |
|--------|--------|------|------|----------|------|
| 51-8-1 | `aau220` | unknown | 500 | 2.8 | PASS |
| 51-8-2 | `aau220 and 13` | unknown | 141 | 1.9 | PASS |

## Phase 52: 서버 Cold Start 즉시 폴더/이미지 로딩 속도 측정

서버를 새로 시작한 직후 **대기 시간 없이** 페이지 접속 → 폴더 리스트 → Ctrl+클릭으로 이미지 로딩까지의 전체 시간을 측정한다.

> 역할 분리: 이 Phase는 **빠른 smoke check**다. 썸네일 삭제 + 브라우저 캐시 초기화 + 3단계 분절 계측이 필요한 권위 벤치는 Phase 61, 62를 사용한다.

### 핵심 원칙: No Sleep — 즉시 재시도
- `browser_wait_for(time: N)` 같은 대기를 사용하지 않는다.
- 폴더 리스트가 안 나오면 즉시 재시도 (최대 20회, 간격 0).
- 이미지가 로드 안 되면 즉시 재확인 (최대 30회, 간격 0).
- 로컬 Playwright `page.evaluate`로 DOM 상태를 폴링하되 JS `setTimeout` 없이 즉시 반복.

### 측정 순서

1. **서버 시작**: `python -m api.main` 백그라운드 실행
2. **즉시 접속**: 로컬 Playwright `page.goto('https://localhost:443')` — 서버가 안 뜨면 즉시 재시도
3. **폴더 리스트 확인**: `nav` 안의 `summary[data-path]` 개수 > 0 될 때까지 즉시 폴링
4. **시간 기록**: `performance.timing.loadEventEnd - navigationStart` = 페이지 로드 시간
5. **폴더 Ctrl+클릭**: `unknown` (position 있는 폴더) summary 찾아서 click
6. **그리드 이미지 로드 확인**: `.grid-thumb-img[data-grid-loaded="true"]` 개수 > 0 즉시 폴링
7. **뷰포트 내 로드 완료 확인**: 뷰포트 안 이미지 중 placeholder 0개 될 때까지 폴링

```javascript
// 폴더 리스트 즉시 폴링 (no sleep)
let folders = 0;
for (let i = 0; i < 20; i++) {
  folders = document.querySelectorAll('nav[aria-label="폴더 및 파일 목록"] summary[data-path]').length;
  if (folders > 0) break;
}
// 타이밍
const perf = performance.timing;
const pageLoadMs = perf.loadEventEnd - perf.navigationStart;
```

### pass 기준
| 항목 | 기준 |
|------|------|
| 페이지 로드 (서버 시작 직후) | < 8초 |
| 폴더 리스트 표시 | > 0개 |
| 그리드 이미지 로드 (뷰포트) | 뷰포트 내 placeholder 0개 (20초 이내) |

## Phase 53: 탭 다중 전환 이미지 보존 안정성

여러 탭에 서로 다른 폴더 이미지를 로드한 후 빠르게 왕복 전환하여 이미지가 사라지지 않는지 검증한다.

### 테스트 순서

1. **탭 0**: `unknown` 폴더 Ctrl+클릭 → 그리드 이미지 로드 대기
2. **탭 1 생성**: `+` 버튼 클릭 → `unknown` 폴더 Ctrl+클릭 → 로드 대기
3. **탭 2 생성**: `+` 버튼 클릭 → `unknown` 폴더 Ctrl+클릭 → 로드 대기
4. **빠른 전환 10회**: 탭 0→1→2→0→1→2→0→1→2→0 (각 전환 후 `setTimeout` 없이 즉시 확인)
5. **각 전환 후 검증**: `.grid-thumb-img` 총 개수 > 0 && 뷰포트 내 로드된 이미지 > 0

```javascript
// 탭 전환 + 즉시 검증 (no sleep)
const tabs = document.querySelectorAll('.page-tab');
const results = [];
for (let i = 0; i < 10; i++) {
  tabs[i % tabs.length].click();
  // 즉시 상태 확인
  const grid = document.querySelector('.image-grid');
  const imgs = grid ? grid.querySelectorAll('.grid-thumb-img') : [];
  let loaded = 0;
  for (const img of imgs) {
    if (img.dataset.gridLoaded === 'true' && img.naturalWidth > 1) loaded++;
  }
  results.push({ tab: i % tabs.length, total: imgs.length, loaded });
}
```

### pass 기준
| 항목 | 기준 |
|------|------|
| 모든 전환 후 그리드 이미지 수 | > 0 (빈 그리드 없음) |
| 각 탭의 이미지 수 일관성 | 같은 탭이면 같은 이미지 수 |
| 이미지 사라짐 | 0건 (이전 전환 대비 감소 없음) |

## Phase 54: f/q Missing 이미지 그리드 로드 + 뷰포트 placeholder 검증

position JSON에서 f/q 값이 누락된 이미지가 그리드에서 정상 로드되는지 검증한다.
테스트 데이터: `unknown` 폴더 (f missing / q missing / both missing / normal 4종 변형).

### 사전 조건
- `D:/project/data/positions/unknown/` 에 변형 position JSON 존재
- `D:/project/data/wm-811k/unknown/` 에 대응 이미지 PNG 존재
- 서버가 `unknown` 폴더를 인덱스에 포함

### 테스트 순서

1. **그리드 로드**: `unknown` 폴더 Ctrl+클릭
2. **뷰포트 이미지 로드 확인**: 뷰포트 내 `.grid-thumb-img` 전부 `gridLoaded=true` + `naturalWidth > 1` 즉시 폴링
3. **스크롤 50%**: `grid-scroll-wrapper.scrollTop = scrollHeight * 0.5`
4. **스크롤 후 뷰포트 확인**: placeholder 0개 즉시 폴링 (최대 30회)
5. **스크롤 100%**: 맨 아래까지 스크롤
6. **스크롤 후 뷰포트 확인**: placeholder 0개 즉시 폴링
7. **서버 에러 확인**: `/api/thumbnail` 응답에 500 에러 없음

```javascript
// 뷰포트 내 placeholder 즉시 폴링
function checkViewportLoaded() {
  const sw = document.querySelector('.grid-scroll-wrapper');
  const scrollTop = sw.scrollTop, viewH = sw.clientHeight;
  const imgs = document.querySelectorAll('.grid-thumb-img');
  let vpLoaded = 0, vpPlaceholder = 0;
  for (const img of imgs) {
    const wrap = img.closest('.grid-thumb-wrap');
    if (!wrap) continue;
    const top = wrap.offsetTop, h = wrap.offsetHeight;
    if (top + h > scrollTop && top < scrollTop + viewH) {
      if (img.dataset.gridLoaded === 'true' && img.naturalWidth > 1) vpLoaded++;
      else vpPlaceholder++;
    }
  }
  return { vpLoaded, vpPlaceholder };
}

// 최대 30회 즉시 재시도
for (let i = 0; i < 30; i++) {
  const r = checkViewportLoaded();
  if (r.vpPlaceholder === 0 && r.vpLoaded > 0) break;
}
```

### pass 기준
| 항목 | 기준 |
|------|------|
| 총 이미지 수 | 143개 |
| 뷰포트 내 placeholder (초기) | 0개 |
| 스크롤 50% 후 뷰포트 placeholder | 0개 |
| 스크롤 100% 후 뷰포트 placeholder | 0개 |
| 서버 500 에러 | 0건 |
| f/q missing 이미지와 normal 이미지 로드 차이 | 없음 |

## Phase 55: MY LOT / Composite / Label → Explorer 하이라이트 격리 검증

MY LOT, Composite, Label 모드에서 이미지를 열었을 때 Wafer Map Explorer에서 관련 없는 파일이 하이라이트되지 않는지 검증한다.

### 핵심 원칙
- `applyWaferMapExplorerHighlight`는 전체 경로 exact match만 사용 (partial match 제거됨)
- MY LOT 경로(`my-lot/...`), Composite 경로(`composite_map/...`), Label 경로(`classification/...`)는 Explorer에 없으므로 자연스럽게 하이라이트 안 됨
- MY LOT `showGrid` 진입 시 `selectedFolders` + Explorer `summary.selected` 클리어

### 테스트 순서

1. **폴더 선택**: `unknown` Ctrl+클릭 → Explorer에 `unknown` 하이라이트 확인 (1개)
2. **MY LOT 그리드 보기**: MY LOT API에서 그룹 조회 → 이미지 경로로 `showGrid` 호출
3. **하이라이트 확인**: Explorer `summary.selected` 개수 = **0** (MY LOT 진입 시 클리어됨)
4. **더블클릭 단일 이미지**: MY LOT 그리드에서 첫 이미지 더블클릭 → 단일 이미지 모드
5. **하이라이트 확인**: Explorer `a.selected` 및 `a[style*="background"]` 개수 = **0** (exact match 실패)

```javascript
// MY LOT 그리드 보기 후 Explorer 하이라이트 확인
const nav = document.querySelector('nav[aria-label="폴더 및 파일 목록"]');
const selectedAfter = nav.querySelectorAll('summary.selected').length;
const blueLinks = nav.querySelectorAll('a[style*="background"]').length;
console.assert(selectedAfter === 0, `MY LOT 후 폴더 하이라이트: ${selectedAfter} (expected 0)`);
console.assert(blueLinks === 0, `MY LOT 후 파일 하이라이트: ${blueLinks} (expected 0)`);
```

### pass 기준
| 항목 | 기준 |
|------|------|
| 폴더 선택 후 하이라이트 | 1개 (정상) |
| MY LOT 그리드 진입 후 Explorer 하이라이트 | 0개 |
| MY LOT 단일 이미지 후 Explorer 하이라이트 | 0개 |
| 일반 폴더 이미지 더블클릭 후 Explorer 하이라이트 | 1개 (해당 파일, 정상) |

## Phase 56: Composite 비동기 완료 → 탭 보류 + toast 검증

Composite 생성을 시작한 후 다른 탭으로 전환, Composite 완료 시 자동 탭 전환 없이 toast("완성")만 표시되고, 해당 탭을 열면 결과가 렌더링되는지 검증한다.

### 테스트 순서

1. **탭 0**: `unknown` 폴더 로드 → 20개 선택
2. **Composite 시작**: `handleCompositeCreate()` 호출 → composite 탭 자동 생성
3. **즉시 탭 0으로 전환**: Composite 폴링 진행 중에 원래 탭으로 돌아감
4. **Composite 완료 대기**: `compositePageTasks`에서 해당 탭의 status 확인
5. **toast 확인**: DOM에 "완성" 텍스트가 포함된 fixed toast 요소 존재 확인
6. **탭 0 유지 확인**: 현재 activePageId가 여전히 탭 0인지 확인 (자동 전환 안 됨)
7. **composite 탭 클릭**: composite 탭으로 전환 → `applyPageState`에서 `pendingResult` 감지 → 자동 렌더링
8. **결과 확인**: 그리드에 Grade heatmap + sum map 이미지 표시

```javascript
// Composite 완료 후 탭 0에 머물러 있는지 확인
const currentPage = viewer.pageManager?.activePageId;
console.assert(currentPage !== compositePageId, '자동 탭 전환 안 됨');

// toast 확인
const toast = document.querySelector('[style*="position: fixed"][style*="z-index"]');
console.assert(toast?.textContent?.includes('완성'), 'toast에 "완성" 포함');
```

### pass 기준
| 항목 | 기준 |
|------|------|
| Composite 시작 시 탭 생성 | composite 탭 1개 생성 |
| 다른 탭 전환 후 자동 복귀 | 없음 (탭 0 유지) |
| "완성" toast 표시 | DOM에 존재 |
| composite 탭 클릭 시 결과 렌더링 | 그리드에 heatmap 이미지 표시 |

## Phase 57: WF 다중검색 (드롭다운 + 모달 + API)

Wafer 다중검색 기능 전체 흐름을 검증한다.

### 테스트 순서

1. **드롭다운 열기**: `#multi-search-btn` 클릭 → `#multi-search-dropdown` 표시 확인
2. **항목 확인**: "LOT 다중검색", "WF 다중검색" 2개 항목
3. **WF 모달 열기**: `[data-mode="wf"]` 클릭 → `#wf-search-modal` display=flex
4. **입력 + 검색**: textarea에 "AAU220 13\nABM792 05" 입력 → `#wf-search-apply` 클릭
5. **API 검증**: `/api/search?lot_wafer=aau220:04,abm792:01` → 200, total>0
6. **결과 확인**: 그리드에 결과 이미지 표시, 모달 자동 닫힘
7. **LOT 모달 확인**: 드롭다운에서 "LOT" 선택 → 기존 `#multi-search-modal` 열림

### pass 기준
| 항목 | 기준 |
|------|------|
| 드롭다운 | 2개 항목 표시 |
| WF 모달 | 열기/닫기 정상 |
| WF 검색 | API 200 + 결과 > 0 |
| LOT 모달 | 기존 동작 유지 |

## Phase 58: JS/CSS ETag 캐시 검증

정적 자산의 ETag 기반 캐시 무효화를 검증한다.

### 테스트 순서

1. **JS ETag 확인**: `fetch('/js/main.js')` → `ETag` 헤더 존재
2. **JS 304 검증**: `If-None-Match: <etag>` → 304 응답
3. **CSS ETag 확인**: `fetch('/css/style.css')` → `ETag` 헤더 존재
4. **Cache-Control**: `no-cache` 확인 (매번 검증 강제)
5. **서빙된 main.js 확인**: `/js/main.js` 응답 본문에서 상대 import 경로가 `?v=`를 포함하는지 확인
6. **worker 경로 확인**: `/js/fetch-optimizer.js`, `/js/bitmap-loader.js` 응답 본문에서 worker URL이 `?v=`를 포함하는지 확인

### pass 기준
| 항목 | 기준 |
|------|------|
| JS ETag | 비어있지 않은 문자열 |
| JS 304 | If-None-Match → status 304 |
| CSS ETag | 비어있지 않은 문자열 |
| Cache-Control | "no-cache" 포함 |
| Module import versioning | `./*.js?v=<version>` 포함 |
| Worker versioning | `/js/*worker.js?v=<version>` 포함 |

## Phase 59: 성능 벤치마크

주요 작업의 응답 시간을 측정하고 임계값을 초과하면 FAIL 처리한다.

### 측정 항목 및 임계값
| 항목 | 임계값 | 측정 방법 |
|------|--------|-----------|
| 폴더→그리드 로드 | <2000ms | Ctrl+클릭 → .grid-thumb-wrap 2000개 대기 |
| 더블클릭→단일 이미지 | <1000ms | dblclick → viewMode=gridImage 대기 |
| ESC→그리드 복귀 | <500ms | ESC → gridMode=true 대기 |
| WF 검색 API (cold) | <500ms | `/api/search?lot_wafer=...` fetch |
| WF 검색 API (warm) | <50ms | 2회차 호출 |
| LOT 검색 API | <100ms | `/api/search?lot_multi=...` fetch |

### 2026-04-11 측정 결과 (RELOAD=0, 인덱스 완료)
| 항목 | 측정값 | 판정 |
|------|--------|------|
| 폴더→그리드 | 287ms | PASS |
| 더블클릭→단일 | 16ms | PASS |
| ESC→그리드 | 65ms | PASS |
| WF 검색 (cold) | 314ms | PASS |
| WF 검색 (warm) | 5ms | PASS |
| LOT 검색 | 11ms | PASS |

## Phase 60: Classification 인덱스 즉시 일관성

classification/classification_chips 경로가 인덱스에 포함된 상태에서 추가/이름변경/삭제가 즉시 조회 결과에 반영되는지 검증한다.

### 테스트 순서
1. **임시 클래스 생성 + 분류 추가**: 임시 클래스(`codex_tmp_*`)를 만들고 이미지 1개를 `/api/classify`로 분류
2. **즉시 조회**: `/api/classes/{class}/images` 결과에 새 `classification/...` 경로가 즉시 포함되는지 확인
3. **클래스 이름 변경**: `/api/classes/rename` 실행 후 이전 클래스는 404, 새 클래스는 renamed 경로를 즉시 반환하는지 확인
4. **배치 분류 추가**: 임시 클래스에 `/api/classify/batch`로 이미지 2개 추가
5. **배치 분류 삭제**: `/api/classify/delete` 실행 후 `/api/classes/{class}/images` 결과가 즉시 빈 배열이 되는지 확인
6. **클래스 폴더 삭제**: `/api/classes/delete` 실행 후 `/api/classes/{class}/images`가 404인지 확인
7. **MY LOT Explorer 격리 회귀**: MY LOT Grid 진입 전 Explorer 선택을 만든 뒤 `openSelectionInViewer()` 실행 → `summary.selected`가 0개인지 확인

### pass 기준
| 항목 | 기준 |
|------|------|
| 단건 분류 즉시 반영 | `/api/classes/{class}/images` 결과 > 0 |
| rename 즉시 반영 | old class 404 + new class 결과 > 0 |
| 배치 삭제 즉시 반영 | 삭제 직후 결과 0 |
| 클래스 삭제 즉시 반영 | 삭제 직후 404 |
| MY LOT Explorer 격리 | `summary.selected === 0`, `selectedFolders.size === 0` |

#### BUG-18: Classification 인덱스 rename/delete 후 stale state (2026-04-11)
**증상**: 클래스 이름 변경 후 새 클래스 `/api/classes/{new}/images`가 빈 배열을 반환하거나, 배치 삭제 후 삭제된 이미지가 계속 조회됨
**원인**: `class_to_keys`는 단건 add/remove만 갱신하고, `/api/classes/rename`, `/api/classes/delete`, `/api/classify/delete` 배치 경로는 인덱스를 갱신하지 않음
**수정**: `IndexService`에 `rename_classification_prefix`, `delete_classification_prefix` 추가 + rename/class delete/batch delete 엔드포인트에서 즉시 반영
**결과**: rename 후 새 클래스 조회 정상, 배치 삭제 후 결과 즉시 0개, 삭제 카운트도 실제 삭제 개수만 반영
**평가**: Phase 60에서 단건 추가 → rename → batch delete → class delete를 순서대로 실행해 각 단계 직후 `/api/classes/{class}/images` 응답이 즉시 바뀌는지 확인한다. stale 결과가 한 번이라도 남으면 FAIL
**파일**: `api/index_service.py`, `api/main.py`

## Phase 61: Thumbnail Cache 삭제 후 unknown Cold Start

썸네일/인덱스 캐시를 지운 뒤 다시 시작했을 때, Wafer Map Explorer가 첫 접속에서 즉시 보이고 `unknown` 첫 그리드 썸네일 생성이 시작되는지 확인하는 **smoke cold** Phase다. 권위 기준과 FAIL 계약은 아래 Phase 62를 따른다.

### 테스트 순서
1. **기존 서버 중지**: 실행 중인 `python -m api.main` 프로세스를 모두 종료
2. **앱 캐시 삭제**: `{ROOT_DIR}/thumbnails/`, `{ROOT_DIR}/.file_index_cache.txt`, `{ROOT_DIR}/.file_index_cache_*.lock` 삭제
3. **랜덤 free port 기동**: `RELOAD=0`으로 새 포트에 서버 시작
4. **브라우저 캐시 초기화**: 새 브라우저 컨텍스트 + HTTP cache / cookie clear
5. **첫 페이지 로드**: 첫 HTTP 요청으로 `GET /`
6. **폴더 목록 확인**: `summary[data-path="unknown"]` 표시 확인
7. **unknown 일반 클릭**: 하위 파일 리스트가 표시되는지 확인
8. **unknown Ctrl+클릭**: 그리드 진입 후 첫 viewport 썸네일 로딩 시작 확인
9. **보조 계측**: 첫 `/api/files/recursive?path=unknown`와 첫 `/api/thumbnail?...` 시간 기록

### 주의
- 브라우저가 이전 썸네일을 304로 재검증하면 서버 캐시 삭제 효과가 가려질 수 있다.
- 이 Phase는 반드시 브라우저 캐시를 비운 뒤 실행한다.

### pass 기준
| 항목 | 기준 |
|------|------|
| 첫 페이지 폴더 목록 | 첫 브라우저 요청에서 `summary[data-path="unknown"]` 표시 |
| unknown 파일 리스트 | 클릭 후 파일 항목 표시 |
| 첫 viewport 썸네일 | Ctrl+클릭 후 3000ms 이내 첫 `img[data-grid-loaded="true"]` |
| Cold files/recursive | 첫 호출 < 1500ms |
| Cold thumbnail | 첫 호출 < 2500ms |

### 2026-04-11 strict cold 측정 참고치
| 항목 | 측정값 |
|------|--------|
| browser folder list | 90.8ms / 94.9ms / 93.8ms |
| browser unknown list | 42.1ms / 28.1ms / 35.8ms |
| browser first grid image | 2270.3ms / 2196.7ms / 2190.1ms |
| browser total to grid | 2403.2ms / 2319.7ms / 2319.7ms |

## Phase 62: [CRITICAL] Cold Start 3단계 분절 성능 측정

**⚠️ 최우선 벤치마크** — authoritative **strict cold** 측정이다. 서버를 완전히 내리고 앱 캐시(썸네일, 인덱스)와 브라우저 HTTP 캐시를 비운 뒤, 첫 브라우저 요청이 곧바로 `/`를 치도록 하여 유저 체감 초기 로딩을 측정한다. 실험 방법이 다르면 결과를 인정하지 않고 FAIL로 본다.

### 측정 대상 (권위 5구간)

| 구간 | 측정 항목 |
|------|----------|
| **A** | 브라우저 첫 `GET /` → Wafer Map Explorer `unknown` 폴더 항목 표시 |
| **B** | `unknown` 일반 클릭 → 파일 리스트 표시 |
| **C** | `unknown` Ctrl+클릭 → 첫 viewport 썸네일 1장 로드 |
| **D** | 서버 시작 시각 → 폴더 리스트 표시 |
| **E** | 서버 시작 시각 → 첫 viewport 썸네일 1장 로드 |

### 준비 (매 측정마다)

1. **기존 서버 완전 종료**
   - 실행 중인 `python -m api.main` 프로세스를 모두 종료한다.
   - 기존 리스너가 살아 있거나 `.file_index_cache_*.lock`가 남아 있으면 FAIL이다.
2. **앱 캐시 삭제**
   - `{ROOT_DIR}/thumbnails` 전체 삭제
   - `{ROOT_DIR}/.file_index_cache.txt` 삭제
   - `{ROOT_DIR}/.file_index_cache_*.lock` 삭제
3. **새 random free port 확보**
   - 매 run마다 OS가 비어 있는 새 포트를 할당한다.
   - 8443/8444 고정 재사용 금지
4. **서버 재기동**
   - `RELOAD=0` 필수
   - readiness 확인은 **TCP listen**만 사용
   - `/api/index-status`, `/api/config`, `/`, `/health` 등 HTTP 요청으로 사전 워밍하면 FAIL
5. **브라우저 strict cold**
   - 새 브라우저 컨텍스트 생성
   - HTTP cache / cookies clear
   - 첫 HTTP 요청은 Playwright의 `page.goto(BASE_URL)` 이어야 한다
6. **무지연 인터랙션**
   - 폴더 목록 표시 즉시 `unknown` 클릭
   - 파일 리스트 표시 즉시 `unknown` Ctrl+클릭
   - 임의 `sleep`, `waitForTimeout(>100ms)`, 인위적 대기 삽입 금지

### Playwright 측정 스크립트

```javascript
// 브라우저 HTTP 캐시 완전 초기화 (필수)
const client = await page.context().newCDPSession(page);
await client.send('Network.clearBrowserCache');
await client.send('Network.clearBrowserCookies');
await client.detach();

const navStart = performance.now();
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
await page.locator('summary[data-path="unknown"]').waitFor();
const folderListMs = performance.now() - navStart;

const unknownStart = performance.now();
await page.locator('summary[data-path="unknown"]').click();
await page.locator('summary[data-path="unknown"] + .folder-content a[data-path^="unknown/"]').first().waitFor();
const unknownListMs = performance.now() - unknownStart;

const gridStart = performance.now();
await page.locator('summary[data-path="unknown"]').click({ modifiers: ['Control'] });
await page.locator('#image-grid img[data-grid-loaded="true"]').first().waitFor();
const firstGridImageMs = performance.now() - gridStart;

return {
  folderListMs,
  unknownListMs,
  firstGridImageMs,
  totalToGridMs: folderListMs + unknownListMs + firstGridImageMs,
};
```

### 성능 기준 (2026-04-11 strict cold baseline)

| 항목 | baseline median | PASS | FAIL |
|------|---------------|------|------|
| A. browser folder list | 93.8ms | `<= 150ms` | `> 200ms` |
| B. browser unknown list | 35.8ms | `<= 60ms` | `> 120ms` |
| C. browser first grid image | 2196.7ms | `<= 2400ms` | `> 3000ms` |
| A+B+C. browser total to grid | 2319.7ms | `<= 2500ms` | `> 3200ms` |
| D. server start -> folder list | 1639.6ms | `<= 1800ms` | `> 2200ms` |
| E. server start -> first grid image | 3864.4ms | `<= 4200ms` | `> 5000ms` |

### FAIL 계약

- 아래 중 하나라도 해당하면 **즉시 FAIL**:
- 캐시 삭제가 incomplete (`thumbnails`, `.file_index_cache.txt`, `.file_index_cache_*.lock` 잔존)
- random free port 미사용
- 첫 브라우저 `GET /` 전에 어떤 HTTP warm 요청이라도 발생
- 폴더 목록 이후 `unknown` 클릭, 파일 리스트 이후 `Ctrl+click` 사이에 인위적 대기 삽입
- 위 표의 FAIL threshold를 한 번이라도 초과

### 주의사항

- 반드시 **3회 이상 반복**하고 median을 기록한다.
- 결과 보고에는 3회 raw 값과 median을 모두 남긴다.
- 정적 자산 버전 문자열 계산은 **요청 경로가 아니라 초기화/변경 감지 시점**에 끝나 있어야 한다.
- 요청마다 JS/CSS 전체를 `glob()` / `stat()` 순회하면 A 구간이 바로 느려진다. 변경 시 반드시 이 Phase로 회귀 측정 필수다.

### 2026-04-11 strict cold 결과

| run | browser folder | unknown list | first grid image | browser total | server->folder | server->grid |
|-----|----------------|--------------|------------------|---------------|----------------|--------------|
| 1 | 90.8ms | 42.1ms | 2270.3ms | 2403.2ms | 1647.3ms | 3959.7ms |
| 2 | 94.9ms | 28.1ms | 2196.7ms | 2319.7ms | 1639.6ms | 3864.4ms |
| 3 | 93.8ms | 35.8ms | 2190.1ms | 2319.7ms | 1499.2ms | 3725.1ms |
| median | 93.8ms | 35.8ms | 2196.7ms | 2319.7ms | 1639.6ms | 3864.4ms |

**결론**: 현재 authoritative cold path에서 explorer 폴더 리스트는 이미 충분히 빠르다. 회귀 감시는 A/B 구간보다 C/E 구간, 즉 `unknown` recursive listing 이후 첫 cold thumbnail 생성 경로에 더 민감해야 한다.

## Phase 63: JS 모듈 그래프 / Worker 캐시 무효화

신규 기능이 배포됐는데도 일부 유저가 이전 JS를 계속 쓰는 회귀를 막기 위해, top-level `main.js`뿐 아니라 하위 ES module import와 worker URL까지 동일 버전 문자열이 전파되는지 검증한다.

### 테스트 순서
1. **index.html 버전 확인**: HTML 응답에서 `/js/main.js?v=<version>` 또는 동일 수준의 버전 쿼리스트링 존재 확인
2. **main.js 본문 확인**: `/js/main.js` 응답 본문에서 `./fetch-optimizer.js?v=...`, `./page-manager.js?v=...`, `./search.js?v=...` 같은 상대 import가 버전 문자열을 포함하는지 확인
3. **dynamic import 확인**: `/js/main.js` 응답 본문에서 `./composite-colors.js?v=...`, `./my-lot.js?v=...` 가 버전 문자열을 포함하는지 확인
4. **worker 경로 확인 1**: `/js/fetch-optimizer.js` 응답 본문에서 `/js/cache-worker.js?v=...` 확인
5. **worker 경로 확인 2**: `/js/bitmap-loader.js` 응답 본문에서 `/js/bitmap-worker.js?v=...` 확인
6. **ETag 재검증**: `/js/main.js`, `/css/style.css` 각각 `If-None-Match` 재요청 시 304 확인

### pass 기준
| 항목 | 기준 |
|------|------|
| HTML main.js version | `?v=` 포함 |
| Static import version | 상대 import 경로 모두 `?v=` 포함 |
| Dynamic import version | lazy import 경로 모두 `?v=` 포함 |
| Worker version | worker URL `?v=` 포함 |
| JS 304 | `If-None-Match` → 304 |
| CSS 304 | `If-None-Match` → 304 |

### 2026-04-11 측정 결과
| 항목 | 측정값 | 판정 |
|------|--------|------|
| `/js/main.js` ETag | `\"be4abdc51d95\"` | PASS |
| `/css/style.css` ETag | `\"ae6c305be917\"` | PASS |
| `/js/main.js` 304 | PASS | PASS |
| main.js 상대 import | `fetch-optimizer/page-manager/search` 모두 `?v=d963085-35787b3c9a56` | PASS |
| main.js dynamic import | `composite-colors/my-lot` 모두 `?v=d963085-35787b3c9a56` | PASS |
| worker URL | `cache-worker/bitmap-worker` 모두 `?v=d963085-35787b3c9a56` | PASS |

#### BUG-16: WF 검색 5백만 파일 순차 스캔 (2026-04-11)
**증상**: WF 다중검색(`lot_wafer`) API가 977ms 소요 (LOT 검색 14ms 대비 70배 느림)
**원인**: `_lot_wafer_scan()`이 LOT 인덱스 대신 keys_slice 전체(5M)를 순차 스캔
**수정**: LOT 인덱스(`lot_search`)로 후보 추출 → 후보(~200개)만 wafer 필터링 (`_lot_wafer_filter_indexed`)
**결과**: 977ms → 5ms (195배 개선)
**평가**: Phase 57로 WF UI/API 결과를 확인하고, Phase 59에서 cold/warm 지연을 측정한다. `lot_wafer`가 cold < 500ms, warm < 50ms를 넘기면 FAIL
**파일**: `api/search_service.py`

#### BUG-17: JS/CSS 파일 ETag 미설정 (2026-04-11)
**증상**: 일부 유저가 이전 JS 파일 캐시를 사용 (Cache-Control: no-cache는 있지만 ETag 없이 검증 불가)
**원인**: `cache_control_middleware`에서 JS/CSS에 `no-cache`만 설정, ETag 미생성
**수정**: 파일 mtime+size 기반 weak ETag(`W/"hash"`) 자동 생성 → 변경 없으면 304, 변경 있으면 200+새 파일
**평가**: Phase 58에서 `/js/main.js`, `/css/style.css` 응답의 `ETag` 존재 여부와 `If-None-Match` 재요청 시 `304`를 확인한다. 둘 중 하나라도 빠지면 FAIL
**파일**: `api/main.py` (cache_control_middleware)

#### BUG-19: 서버 재기동 직후 first-hit 2초대 지연 (2026-04-11)
**증상**: 서버를 막 재기동한 직후 첫 `GET /`, `/api/config`, `/api/browse-folders`, `/js/main.js`가 공통으로 2~3초 이상 지연됨  
**원인**: startup 초기에 전체 트리 디스크 워밍과 무거운 인덱스 load/build가 사용자 첫 요청과 겹쳐 same-process 경합을 일으킴  
**수정**: 전체 3depth 디스크 워밍 제거 → `unknown` 중심 targeted warm으로 축소, 로컬 HTTPS self-warm으로 핵심 API/JS first-hit 제거, 인덱스 load/build/후속 캐시 빌드는 `BACKGROUND_TASKS_PAUSED` 해제 후(user idle) 시작하도록 변경
**결과**: 서버 재기동 직후 외부 first-hit 기준 `/api/index-status` 9~10ms, `/api/config` 8~9ms, `/api/browse-folders` 25~28ms, `/` 13~15ms  
**평가**: Phase 61과 Phase 62를 함께 사용한다. 썸네일 캐시 삭제 + 브라우저 캐시 초기화 + 서버 재기동 후 `unknown` 파일 리스트와 첫 viewport 썸네일이 기준 시간 안에 뜨는지 확인한다. Step 1~3 중 하나라도 임계값을 넘기면 FAIL
**파일**: `api/main.py`

#### BUG-20: top-level main.js만 버전이 바뀌고 하위 모듈/worker는 예전 JS를 유지하던 문제 (2026-04-11)
**증상**: 신규 기능 배포 후에도 일부 유저 환경에서 main.js는 새 요청을 타지만, 하위 ES module import 또는 worker가 예전 캐시를 사용해 기능이 안 보이거나 동작이 섞임
**원인**: 버전 문자열이 top-level asset까지만 적용되고, `main.js` 내부의 static import / dynamic import / worker URL에는 동일 버전이 전파되지 않음
**수정**: `index.html`의 JS/CSS URL에 공통 `?v=`를 부여하고, `/js/{filename}` 서빙 시 JS 본문 내부의 상대 import / dynamic import / worker URL에도 같은 버전 문자열을 주입하도록 변경
**평가**: Phase 63에서 HTML의 main.js URL, `/js/main.js` 본문의 static import / dynamic import, `/js/fetch-optimizer.js`와 `/js/bitmap-loader.js`의 worker URL까지 모두 동일 `?v=`가 붙는지 확인한다. 모듈 그래프 중 한 군데라도 빠지면 FAIL
**파일**: `api/main.py`

#### BUG-14: Permission Editor "all" 사용자 표시 오류 (2026-04-10)
**증상**: Permission Editor 모달에서 loginId="all" 와일드카드 사용자가 "(이름없음) (all) · ROLE_ADMIN"으로 표시
**원인**: `loginId === "all"`일 때 displayName 매핑 로직이 없어 일반 사용자와 동일하게 처리
**수정**: `loginId === "all"`이면 "모든 사용자 · ROLE_ADMIN"으로 표시 ("(all)" ID 미노출)
**평가**: Phase 25에서 Permission Editor 첫 행에 "모든 사용자"가 표시되고 `(all)` ID가 노출되지 않는지 확인한다. 둘 중 하나라도 어긋나면 FAIL
**파일**: `js/main.js`, `js/main.min.js`

#### BUG-15: 새 페이지 추가 시 Label Explorer 이전 상태 잔류 (2026-04-10)
**증상**: 페이지 탭 추가(+) 시 Label Explorer가 이전 페이지의 폴더 펼침 상태와 하이라이트를 그대로 유지
**원인**: `restoreLabelExplorerState()`에서 `labelExplorerState === null`(새 빈 페이지)일 때 기존 상태를 초기화하지 않음
**수정**: `labelExplorerState`가 null이면 `selected`, `selectedClasses`, `lastClicked` 초기화 + `openFolders` 전체 false + `refreshLabelExplorer()` 호출
**평가**: Phase 21에서 새 탭 생성 직후 Label Explorer의 폴더 열림, 선택 하이라이트, 이미지 항목이 모두 초기 상태인지 확인한다. 이전 탭 흔적이 보이면 FAIL
**파일**: `js/main.js`, `js/main.min.js`

#### BUG-21: Chip Label ↔ Wafer 연결/오버레이/선택 회귀 묶음 (2026-05-02)
**증상**: chip label 이미지와 원본 wafer가 파일명 suffix 차이 때문에 연결되지 않거나, chip label에서 wafer/lot 보기가 빠지고, wafer 단일 보기의 chip label overlay/legend/폴더 표시 및 label 선택 동작이 서로 어긋남. 줌 레벨 전환 시 개인색 PLTE가 깨지는 회귀도 함께 발생.

**계약**
- chip wafer key는 파일명 앞 5개 토큰 `product/bottom/wafer/date/time`이다. 예: `AAU220_00P_13_20260501_010000`. 이 prefix가 같으면 wafer filename에 `96.0_2` 같은 추가 토큰이 있어도 같은 wafer label로 판단한다.
- chip label 관련 wafer/lot 보기는 Label Explorer, chip-label grid 다중 선택 context menu, chip-label single image context menu에서 모두 보여야 한다.
- chip label → wafer/lot 보기 결과는 새 wafer tab으로 열고, lot/wafer 기준으로 중복 제거한다. 결과 경로는 원본 wafer여야 하며 `classification_chips` 또는 `obj_id_maps` 파생 경로가 나오면 FAIL.
- 동일 wafer filename이 여러 원본 폴더에 존재해도 `/api/classify/chips`가 기록한 `.chip_source_map.json` 원본 경로를 우선 사용해 label을 만든 wafer로 돌아가야 한다. manifest가 없거나 원본이 삭제된 기존 label만 후보 검색 fallback을 사용한다.
- chip label에서 열린 wafer single view는 상단 filename panel에 소속 folder를 보여야 하고, 좌하단 chip label legend/overlay가 보여야 한다. 반대로 chip label image single view는 folder line/separator를 숨겨야 한다.
- chip label overlay 기본 active label은 `invalid_main`을 제외한다. overlay alpha는 `0.2`이고, fill은 chip interior에만 들어가 wafer chip boundary가 남아야 한다. legend width는 기존 264px 대비 약 15% 줄인 220~230px 범위로 유지한다.
- chip label legend 우클릭은 모든 label을 끈다. legend 위 drag는 wafer image pan을 일으키면 FAIL.
- `scratch` 클릭 후 Shift+`fork` 클릭은 contiguous range인 `scratch`, `bank_boundary`, `scratch_rot`, `fork` 전체를 선택해야 한다. fork 1개만 선택되면 FAIL.
- legend Ctrl-drag는 지나간 label을 toggle하고, Ctrl+Shift-drag는 기존 선택에 range를 add한다. wafer canvas Ctrl+Shift-drag는 Shift rectangle-add path를 타서 chip을 2개 이상 multi-select해야 한다.
- 개인색 pyramid는 모든 `SERVER_CONFIG.PYRAMID_LEVELS`에서 PLTE/background color가 유지되어야 한다. pyvips, Pillow fallback, speed fallback 모두 personal PLTE patch를 보존해야 하며 현재 personalized pyramid cache rev는 `pyramid_v4`이다.

**평가**
- `scripts/e2e_chunk1.js`의 `chip-label-prefix-wafer` record에서 위 계약을 모두 검사한다.
- prefix lookup path/speed, wafer/lot context menu, grid/single right-click path, folder display, legend default/clear/range/drag, overlay alpha/interior/zoom consistency, personalized pyramid all-level pixel sample이 하나라도 실패하면 FAIL.
- 대표 fixture:
  - wafer: `unknown/Center_scratch/AAU220_00P_13_20260501_010000_96.0_2_EE_PWQ.PNG`
  - chip: `classification_chips/bank_boundary/AAU220_00P_13_20260501_010000_EE_PWQ_X13_Y11_B285.PNG`

**파일**
- API/cache: `api/full_app.py`, `api/main.py`, `api/search_service.py`
- UI: `js/main.js`, `js/chip-annotator.js`, `js/semiconductor-renderer.js`, `js/thumbnail-navigator.js`, `css/style.css`, `index.html`
- E2E: `scripts/e2e_chunk1.js`, `scripts/run-e2e-playwright.ps1`

#### BUG-22: unknown archive 폴더가 전역 검색 결과에 섞이는 회귀 (2026-05-09)
**증상**: 전체 E2E가 `WARMUP search cache`에서 멈추거나, Phase `3v unknown 실제 파일명 기반 text 검색`이 `unknown_pre_v5_260507/...` 또는 `unknown_multi/...` 같은 archive/generated 경로를 `outsideUnknown`으로 보고 FAIL.
**원인**: `scripts/run-e2e-playwright.ps1`의 검색 warmup LOT 목록이 현재 전역 검색에서 제외되는 파생 폴더에만 남은 샘플을 사용했고, `SearchService.global_only_excluded_folders`가 `unknown_pre*`, `unknown_Normal_pre*`, `unknown_384`, `unknown_448` archive/generated 스냅샷을 루트 전역 검색에서 제외하지 않음.
**수정**: warmup LOT 목록 앞에 현재 검색 가능한 `unknown`/실데이터 LOT를 추가하고, `api/search_service.py`에서 archive/generated unknown 스냅샷을 global-only exclusion에 추가한다. 명시적 `folder=unknown_pre_v5_260507`, `folder=unknown_384`, `folder=unknown_448` 검색은 계속 허용한다.
**평가**: runner 로그에 `SEARCH_READY ... total>=1`이 찍혀야 하며, Phase `3v`의 global text/LOT/WF 검색에서 `outsideUnknown=[]`이어야 한다.
**파일**: `api/search_service.py`, `scripts/run-e2e-playwright.ps1`

#### BUG-23: Chip label legend range 테스트가 round-25 이름을 참조 (2026-05-09)
**증상**: Phase `chip-label-prefix-wafer`가 `scratch -> particle_blast range setup failed`로 FAIL. 실제 legend는 `scratch`, `bank_boundary`, `scratch_rot`, `fork`, `invalid_main`.
**원인**: round 26에서 `particle_blast`는 `fork`, `scratch_21deg`는 `scratch_rot`로 rename되었고 API도 legacy class를 거부하지만, E2E Shift-click range 기대값이 old class name을 계속 참조함.
**수정**: `scripts/e2e_chunk1.js`의 range-click 대상과 실패 메시지를 `scratch -> fork`로 갱신한다.
**평가**: Phase `chip-label-prefix-wafer`에서 Shift+`fork` 클릭 후 active/filter가 `scratch`, `bank_boundary`, `scratch_rot`, `fork` contiguous range와 일치해야 한다.
**파일**: `scripts/e2e_chunk1.js`, `api/full_app.py`

#### BUG-24: 다중 Shot/Chip Composite와 export 정합성 회귀 (2026-08-07)
- `scripts/e2e_chunk2.js`의 `selected-region-composite`는 실제 P001 fixture에서 단일 Shot, 다중 Chip, 동일 형상 Shot 4/5 두 개, chip 1개인 partial Shot 8을 검사한다. Partial Shot도 canonical `4×6` canvas와 동일한 chip cell 크기를 유지해야 하며, 보이는 chip 수만 positions에 남겨야 한다.
- `layout-chip-coordinates`는 단일 보기 좌표 box가 `Chip(Grid)`, `Chip(Pos)`, `Radious`, `Shot(Grid)` 순서이고 Pos/Radius가 소수 1자리인지 확인한다. TSV export는 `CHIP_COORD_X(mm)`, `CHIP_COORD_Y(mm)`를 별도 컬럼으로 확인한다. Shot 버튼의 partial edge 경계는 canonical `4×6` Shot extent를 유지하고 실제 캔버스에서 보이는 영역까지만 표시해야 하며, chip 크기를 축소/확장하지 않아야 한다.
- 두 Shot 결과는 단일 Shot 결과와 `width`, `height`, canonical chip 격자 `4×6`이 같아야 한다. positions chip 수는 canonical 첫 Shot의 24개, `selected_source_chip_count`는 두 Shot 합계 48개, `composite_sample_count`는 source image 수×Shot 수여야 한다.
- `selected_shot_groups`가 없는 기존 Chip 요청도 유지해야 하며, positions가 결과 output canvas로 비동기 복사된 뒤 `/api/chip-positions`에서 chip rect/canvas를 다시 확인한다.
- `selected-region-export`는 Chip/Shot context menu를 실제로 열고, Shot 이미지 PNG 다운로드, Shot TSV 다운로드, clipboard TSV header의 `CHIP_COORD_X(mm)`, `CHIP_COORD_Y(mm)`, `RADIUS(mm)`, `SHOT_ID`, `SHOT_X`, `SHOT_Y`를 확인한다. `SHOT` 튜플 컬럼은 없어야 하며, 세 mm 값은 소수 셋째 자리까지 기록되어야 한다. Chip export도 같은 schema와 선택 행 수를 확인한다.
- 선택 Chip/Shot export에는 선택 집합 기준 `GROUP_CHIP_COUNT`, `GROUP_GOOD`, `GROUP_BAD`, `GROUP_YIELD(%)`, `GROUP_YIELD_SOURCE`가 있어야 한다. Per-chip `yld`가 없으면 BIN 기준 Good/Bad 수율을 사용하고, Wafer-level `yield`만 있는 fixture 값을 chip별 yld로 복제하면 FAIL이다. 단일보기 선택 리스트에도 같은 선택 summary가 보여야 한다.
- 선택 Chip/Shot context menu에는 선택 crop을 MY LOT pendingPaths와 Label modal로 넘기는 항목이 있어야 한다. Shot crop은 브라우저 다운로드만 검증하면 부족하며, 서버 저장 경로(`/api/selection-crops`)를 기존 MY LOT/Label 흐름에 연결해야 한다.
- UI 상태 플래그만으로 PASS 처리하지 않는다. API request body의 `selected_shot_groups`, output image dimensions, positions count, 다운로드 suggested filename을 모두 기록한다.
- Chip Composite는 선택 Chip 3개를 한 Chip 크기의 canonical canvas에 누적해야 한다. 선택 Chip을 원래 Shot 위치에 여러 개 배치한 결과가 나오면 FAIL이다. output image와 positions canvas는 첫 Chip 크기, positions chip 수는 1, `selected_chip_count=3`, `composite_sample_count=3`이어야 한다.

#### BUG-25: Composite 요청의 SAML LoginId 전달
- bootstrap SAML은 성공 후 URL handoff만 사용하므로 Composite/Measure Composite 요청에도 `LoginId` query가 전달되어야 한다. 결과가 `composite_map/notsaml`에 생기면 FAIL이다.
- `selected-region-composite`는 non-fallback LoginId가 `/api/composite-map` POST URL에 포함되는지 확인하고, export는 `SHOT` 튜플 컬럼 제거와 mm 3자리 값을 확인한다.

#### BUG-27: 독립 좌표 목록과 Shot 내부 Chip ID 부분 선택
- P001 단일 이미지에서 `#chip-coordinate-select-modal`을 실제 context menu 경로로 열고, 자유형 textarea 대신 visible input cell table을 사용해야 한다. `Shot X/Y`와 `Chip X/Y`에는 검색어로 후보를 좁히고 좌표를 새 행에 넣는 빠른 드롭다운이 있어야 한다.
- 패널이 `Shot X/Y`, `Chip X/Y`, `Chip ID` 세 독립 list를 가로로 보여주는지 확인한다. Shot과 Chip은 X/Y 두 열, Chip ID는 ID 한 열이며 Chip X/Y 소수 입력은 Chip Pos(mm)로 해석한다. Tab/쉼표/줄바꿈 붙여넣기가 각 list의 시작 cell부터 여러 행으로 채워지고 입력값이 셀에 남아야 한다.
- X/Y만 입력하면 해당 단위 전체, X/Y+Chip ID를 같은 행에 입력하면 해당 단위 내부의 특정 Chip, Chip ID만 입력하면 현재 선택 Shot 범위의 ID만 대상으로 해야 한다. 동작 표시는 `기존 선택 바꾸기`, `현재 선택에 추가`, `현재 선택에서 해제`처럼 모호하지 않아야 한다.
- 셀 입력은 `완료` 클릭 전에도 지도에 즉시 반영되어야 하고, 패널은 modeless fixed/드래그 가능하며 overlay backdrop이나 지도 입력 차단이 없어야 한다. 범위 선택을 켜면 X/Y range slider와 숫자 범위 입력이 같은 선택 상태를 실시간으로 갱신해야 한다. Shot 좌표 입력 시 canonical 4×6 picker 하나를 Chip ID list 안에 표시하고, 여러 Shot이면 대표 Shot 하나를 그려 선택된 Shot 전체의 같은 슬롯에 적용한다. layout의 EDS 위치에 따라 bottom-left→right→up 순서로 Chip ID를 배치하며, 없는 edge Chip은 빈 칸으로 둔다. 셀 클릭은 Shot 모드를 유지한 채 선택된 Shot들의 같은 Chip 영역을 즉시 토글해야 한다.
- Shot 두 개를 먼저 표로 선택한 뒤 `Chip ID` + `해제`/`추가`를 적용했을 때 selected Chip 수가 `48 -> 47 -> 48`이고 Shot 모드/Shot 수가 유지되어야 한다. Chip ID list로 전환해도 Chip ID list 안의 canonical Shot 네모, 내부 Chip 경계, Chip ID가 유지되어야 하며, 기본 상태는 Shot 내부 Chip 전체 선택이다. 네모의 Chip ID 셀 클릭은 선택된 Shot들에서 같은 Chip 영역을 해제/복구해 picker 선택 수가 `48 -> 46 -> 48`이 되고 각 Shot이 `24 -> 23 -> 24`인지 확인한다. Chip ID는 현재 선택 Shot 범위 밖의 같은 ID를 건드리면 안 된다. 독립적인 wafer 원점 Radius 가이드 원/선은 제공하지 않는다.
- per-chip/per-shot `yld`가 실제 positions/layout 데이터에 있을 때만 상세 YIELD를 검증한다. wafer-level `yield`만 있는 fixture에서는 UI가 개별 YIELD를 복제하지 않고 `개별 YIELD 데이터 없음`과 wafer YIELD를 분리해 표시해야 한다.
- Guard: `scripts/e2e_chunk2.js` record `coordinate-selection-cells`. DOM visibility, 세 list의 cell values, Chip list 내부의 선택된 한 Shot 4×6 picker 실제 셀/경계/Chip ID/aria-checked/순서, selection Set, `_getSelectedShotGroups()`, Shift marquee preview/부분 교차, Chip·Radius AND 범위를 함께 확인하고 상태 플래그만으로 PASS 처리하지 않는다.

#### BUG-28: layout zone 컬럼 계약
- BUG-29: Parquet가 integer 의미 컬럼을 float64로 반환해 문자열 1.0 변환 실패가 발생하지 않는지 확인한다. partial Shot은 canonical 4x6 경계와 cell 크기를 유지하고, 선택 외곽선은 canonical 크기로 표시하되 선택색은 실제 존재하는 Chip만 채운다. layout-chip-coordinates는 모든 partial group의 경계 존재/크기, hover/선택 geometry 일치, 실제 Chip pixel 변화와 빈 슬롯 pixel 불변, Chip(Grid)=x_abs/y_abs를 확인한다.
- `layout.txt` 끝에 `zone_id`, `zone_type`을 유지한다. 현재 circle fixture는 `C20`, `C80`, `E1`, `E20`과 `zone_type=circle`을 사용하며, area/edge family는 각각 `TOP_LEFT/CENTER/RIGHT/BOTTOM`, `INNER/EDGE`로 예약한다.
- `layout-chip-coordinates`는 API로 로드된 P001 row에서 zone 값을 확인한다.
- Pivot layout guard: `zone_id`/`zone_type`이 없는 새 Parquet에서 `edge`, `area`, `circle` 중 비어 있지 않은 zone 값을 API의 canonical `zone_type`/`zone_id`로 복원하고, 첫 Shot load가 `FieldRef.Name(zone_id)` 오류 없이 완료되는지 확인한다.

#### BUG-30: Shot geometry, immediate boundary, and Border pixel guard
- Shot Position UI guard: the Chip ID panel displays 0-based Shot-internal positions from bottom-left `(0,0)` upward, never raw layout `chip_id` values. Shot X/Y and Chip X/Y tables use bounded internal scroll regions so the Chip/Radius range panel remains visible.
- `layout-chip-coordinates` must use the real P001 single-image flow and verify that layout-driven canonical geometry is shared by Shot boundary, Shot hover/selection, Shot(Grid), Chip X/Y real-time selection, and Shot picker slots. Partial groups must keep the nominal 4x6 boundary and never disappear. The picker must use the same screen Y direction as Chip X/Y selection while numbering its cells bottom-left to right, then upward.
- The same phase must clear the boundary cache, call the real `#single-shot-boundary-btn`, and record both the synchronous first-on render time and actual purple boundary pixels. PASS requires `firstOnMs < 10`, `firstOnPixels > 50`, and the cached boundary count to equal the 43 Shot groups. This is a client render-time guard, not a locator-click or network-load time.
- `systematic-measure-single-lot-wafer` must enable the real Border state and fetch the original PNG both with and without `border_normalize=1`. PASS requires identical IDAT bytes and client overlay hash, no client border renderer, PLTE changes only in indices 11~23, and every index 11~23 equal to Normal index 10.
- `coordinate-selection-cells` must use the product-selector-style single text input and filtered dropdown for both Shot X/Y and Chip X/Y, then paste decimal Chip(Pos) values into the Chip X/Y cells and require `selectionMode=chip` with one selected Chip. Integer Shot X/Y remains strict; Chip X/Y accepts both integer grid coordinates and decimal position coordinates. Opening the modeless panel must clear existing Chip/Shot selection, show a full 4x6 Chip ID palette with every cell unchecked, and omit the prior selection/YIELD summary plus independent-input guidance text. The palette must prefer layout Shot `(0, 0)` when full; if it is partial or absent, it must use a full Shot and fill missing slots from other Shots rather than reflecting the currently entered/selected Shot coordinate. It must show no title, Shot name, or selected-count text; its 24 cells are numbered bottom-left to right (`1` through `4`), then upward (`5` through `8`) to `24`. With no explicit Shot X/Y scope, clicking a palette Chip ID applies its matching slot to every Shot; picker right-click clears all selection, `Ctrl+A` selects every slot, and `Shift+click` or `Shift+drag` adds a contiguous slot range.
- The Shot X/Y and Chip X/Y Quick dropdowns are multi-select controls: clicking an item must keep the dropdown open, retain existing rows, and expose every selected option through `aria-selected=true` plus the selected style. Their list viewports must not be capped at two rows. `X=-2`, `Y=3`, `-2,*`, `*,3` wildcard queries must filter on the corresponding coordinate and offer a batch select option. Picker right-click clear must clear selected chips and all three Shot/Chip/Chip ID rows. `Chip 범위 선택` and `Radius 범위 선택` are simultaneously available and use AND semantics; Radius renders one `Radius(mm)` annulus axis from layout chip-center coordinates. Any selection source, including a full-shot Chip ID palette click, must repopulate all three lists from the selected chips. Shift marquee must visibly render and include each partially intersected palette cell. The actual wafer Shift marquee has the same partial-intersection rule. The `coordinate-selection-cells` phase must cover these DOM and selected-chip outcomes without using only viewer state flags.

#### BUG-31: Single-image fixed panel and partial Shot fill guard
- In the real P001 `gridImage` view, double-click `#color-legend-top`, `#color-legend-bottom`, `#chip-info-container`, and `#minimap-container` one by one. Each action must keep the same selected path, `gridMode=false`, `viewMode=gridImage`, and all four panels visibly sized.
- Repeat zoom-button input and canvas pan six times and apply the same four-panel assertion after every cycle. This catches a navigation event that accidentally switches to grid and hides all single-view chrome.
- Exit that detail view through the real unobstructed center-canvas `dblclick` handler. In the returned grid, `#grid-color-legend-bottom` must be visible with nonzero size; the single-view transition hides that legend, so `_showGridVisual()` must restore it. Re-enter with the real thumbnail `dblclick`; the re-entry must keep `gridMode=false`, `viewMode=gridImage`, the same image path, and all four fixed panels visibly sized. This guards both the `PageManager.applyPageState()` versus `enterGridImageViewMode()` transition race and the `enterSingleImageMode()` ordering contract: hide the old grid canvas first, then synchronously apply the single-image panel mode and its legends before asynchronous image fetch/decode starts.
- Set `E2E_CAPTURE_PANEL_ROUNDTRIP=1` only when visual evidence is requested. The phase then records three screenshots in order: initial grid, single image after thumbnail double-click, and grid after the single-image canvas double-click.
- Select the smallest partial Shot. Its canonical outline remains 4x6, the existing Chip center must change to the selection RGBA, and a missing slot center must remain byte-for-byte unchanged.
