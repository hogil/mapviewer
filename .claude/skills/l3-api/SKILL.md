---
name: l3-api
description: "L3 Tracker FastAPI 엔드포인트 개발 및 수정. API 추가, 라우트 변경, 이미지 처리 로직 수정, 캐싱 전략 변경 시 사용한다. '엔드포인트 추가', 'API 만들어', '서버 로직 수정', '캐시 설정', '썸네일 처리' 등의 요청에 반응한다."
argument-hint: [엔드포인트-또는-기능-설명]
---

# L3 API - FastAPI 엔드포인트 개발

요청: `$ARGUMENTS`

## 프로젝트 컨벤션

### 절대규칙

1. 서버 시작 경로(`lifespan`, preload, 인덱스 빌드)는 요청 처리보다 앞에서 블로킹되면 안 된다.
2. positions 파일은 직접 계산 가능한 후보 경로만 확인하고 전체 디렉토리 스캔(`rglob`, `os.walk`)으로 찾지 않는다.
3. classification / my-lot / composite 같은 파생 경로를 API에서 받을 때는 가능하면 원본 경로와 함께 다뤄서 심링크/하드링크/캐시 충돌을 줄인다.
4. 캐시 정책을 바꾸는 엔드포인트라면 ETag, Cache-Control, `_t=` cache buster, 메모리 캐시 무효화 지점을 같이 검토한다.
5. `wm-811k/benchmark_4m/`는 인덱스/검색 성능 테스트용 0바이트 더미 400만 파일 데이터다. 이미지 처리 대상으로 삼지 말고, 인덱스 성능 평가 경로에서는 임의로 제외하지 않는다.

### 엔드포인트 패턴

기존 엔드포인트 구조를 따른다:

```python
@app.get("/api/your-endpoint")
async def your_endpoint(request: Request, param: str = Query(...)):
    login_id = _current_login_id(request)
    # 로직
    return JSONResponse({"status": "ok", "data": result})
```

### 필수 확인 사항

1. **인증**: `_current_login_id(request)` 사용, FALLBACK_LOGIN_ID = config의 값
2. **CORS/HTTPS**: production은 HTTPS only
3. **비동기**: I/O 작업은 `await` / `run_in_executor` 사용
4. **로깅**: 기존 pretty-table 로거 패턴 유지
5. **에러 처리**: `JSONResponse` + 적절한 status_code
6. **Non-blocking startup**: `yield` 전 무거운 작업 금지, 필요 시 `asyncio.create_task` 사용
7. **경로 해석**: `safe_resolve_path`, `relkey_from_any_path`, classification/original path 규칙을 먼저 확인
8. **호환성**: Label Explorer, MY LOT, 단일 이미지 모드가 같은 API를 공유할 때 상태 오염이 없는지 확인

### 이미지 처리 규칙

- 품질: Q=100, Lanczos3 (변경 금지)
- 썸네일: `ThumbnailService` 사용 (pyvips)
- Pyramid 레벨: `[0.25, 0.5, 0.75, 1.0]`
- VIPS_CONCURRENCY=1 (웹서버에서 필수)

### 캐싱 패턴

```python
# ETag + Cache-Control 패턴 (기존 /api/image 참고)
etag = f'"{file_hash}"'
if request.headers.get("if-none-match") == etag:
    return Response(status_code=304)
return Response(content=data, headers={
    "ETag": etag,
    "Cache-Control": "public, max-age=86400"
})
```

캐시를 장기 보관하지 않아야 하는 엔드포인트(`thumbnail`, `image`, `measure-thumb`, JS/CSS`)는 위 예시를 그대로 복사하지 말고, 현재 코드베이스의 `no-cache` 정책과 맞춰야 한다.

### 파일 경로 규칙

- `PROJECT_ROOT`: 이미지 루트 (config에서)
- 경로 조합: `Path(PROJECT_ROOT) / relative_path`
- 경로 검증: `..` 등 path traversal 방지
- skip dirs: `classification`, `thumbnails`
- positions 조회: 이미지 stem 기준 직접 경로 계산 우선, 전체 스캔 금지
- classification 응답: 가능한 경우 `original_relative` 같이 내려 원본 경로를 복원할 수 있게 유지

### Worker 제약

- `UVICORN_WORKERS=1` (중복 인덱싱 방지)
- 동시성은 `IO_THREADS`, `THUMBNAIL_SEM`으로 조절
- 무거운 인덱스/검색 폴백은 executor로 넘기고, 이벤트 루프에서 대량 순차 스캔하지 않는다

## 개발 흐름

1. `api/main.py` 읽기 → 기존 패턴 파악
2. 필요한 import/config 확인
3. 엔드포인트 작성
4. `python -m api.main` 으로 로컬 테스트
5. curl/Playwright로 동작 확인
6. Label Explorer / MY LOT / Composite / Measure 중 어느 소비자가 이 API를 호출하는지 역추적
7. 캐시 무효화, 원본 경로 복원, fallback LoginId 처리까지 함께 점검

## 최근 수정 메모 (2026-04-11)

### SAML 로그인 간헐 실패와 다중 Uvicorn worker (2026-06-05)

- 증상: 운영에서 `/saml/login` 또는 `/saml/acs`가 됐다가 안 됐다가 하며 `python3-saml 라이브러리가 설치되지 않았습니다`를 반환할 수 있었다. 시작 스크립트의 `python3-saml import ok`와 충돌하는 증상이다.
- 원인: `api/full_app.py`는 `OneLogin_Saml2_Auth` / `_SAML_RUNTIME_READY` 전역 캐시를 써서 한 번 실패한 import 상태를 계속 재사용했고, 실제 import exception을 숨긴 채 "설치 안 됨"으로만 보고했다. `python -m api.main` 자식 프로세스가 여러 개 보일 때도 요청을 처리한 PID를 확인한 뒤 진짜 Uvicorn worker인지 판단해야 한다.
- 필수 계약:
  - `/saml/login`, `/saml/acs`, `/saml/metadata`는 full app lazy import, index load/build, thumbnail warmup, composite warmup, measure/composite 모듈과 독립이어야 한다. SAML 라우트는 `api.full_app` 준비를 기다리다가 IdP redirect나 ACS 처리를 지연시키면 안 된다.
  - SAML 성공 handoff는 기존 URL redirect만 사용한다: `/?saml_success=true&LoginId=...&Username=...&DeptName=...`.
  - SAML login handoff를 위해 `session_user`, `saml_login_id`, `saml_user_meta` 같은 쿠키를 새로 추가하지 않는다. 쿠키 기반 세션으로 바꾸려면 별도 auth 설계 변경으로 다룬다.
  - SAML-only 수정에서 `api/measure_composite.py`, composite startup warmup, 이미지/composite worker 설정을 함께 바꾸지 않는다. 그쪽 병목은 별도 성능 이슈로 분리한다.
- 수정 패턴:
  - FastAPI/Uvicorn process worker는 항상 1개로 둔다. `api/config.py::DEFAULT_WORKERS`도 1로 고정하고, `api/main.py` / `api/full_app.py`의 `uvicorn.run(..., workers=1)` 계약을 유지한다.
  - SAML runtime은 요청 처리 시점에 import한다. 실패 시 PID, `sys.executable`, `sys.prefix`, 실제 exception을 로그와 HTTP detail에 남긴다.
  - `/saml/login`과 `/saml/acs` 로그에는 PID/Python 경로를 남겨 성공/실패가 다른 worker에서 나는지 즉시 비교할 수 있게 한다.
- 구현 위치: `api/main.py::saml_login()`, `saml_acs()`, `saml_metadata()`를 catch-all `LazyFullAppProxy`보다 먼저 등록한다. 요청마다 로컬 SAML auth 객체를 만들고 executor에서 처리한다. `/api/auth/user`는 bootstrap SAML 성공 메타가 있으면 즉시 반환하고, 없으면 준비된 full app에만 non-blocking forward한다. `api/full_app.py::_import_saml_runtime()`은 direct full-app 경로의 전역 import 실패 캐시를 제거한다.
- 평가: 서버 시작 직후 브라우저 `GET /`가 `AUTO_LOGIN=1`일 때 `/saml/login`으로 즉시 넘어가야 하고, `/saml/login`은 explorer/full-app/composite 준비를 기다리지 않고 IdP redirect를 시작해야 한다. `BOOTSTRAP_FULL_APP_DELAY_SECONDS=30`을 강제로 넣고 `/saml/login` 동시 요청을 보내도 `503 full app is still warming up`이 나오면 안 된다. 반복 로그인 시 `/saml/login`/`/saml/acs` 로그의 PID와 runtime import 성공 여부가 일관되어야 한다. `scripts/e2e_saml_bootstrap_smoke.js`와 `scripts/run-e2e-saml-bootstrap-smoke.ps1 -Iterations 10`으로 서버 재시작 후 웹 접속/SAML login 시도 회귀를 잡는다.

### SAML restart priority and stale install-message guard (2026-06-10)

- 증상: 서버 재시작 후 새 접속에서 SAML 시작이 지연되거나, 운영 로그에 옛 `python3-saml 라이브러리가 설치되지 않았습니다` 문구가 다시 보일 수 있었다.
- 원인: SAML이 full-app/bootstrap warmup 순서와 섞이면 새 인증 시작이 우선 처리되지 않을 수 있고, 구형 full-app SAML import guard는 import 실패를 한 번 캐시한 뒤 실제 예외 없이 "설치 안 됨"으로 포장했다. `AUTO_LOGIN=0`/수동 로그인 재시작 흐름에서는 full-app idle import와 composite/thumbnail warmup이 첫 SAML 요청보다 먼저 native image/XML 라이브러리를 import할 수 있다. 이 PID에서 `pyvips`/시스템 라이브러리가 먼저 incompatible `libxml2`를 잡으면 이후 `xmlsec` import가 `lxml & xmlsec libxml2 library version mismatch`로 실패하고, 다음 service restart에서 import 순서가 바뀌면 사라져 랜덤처럼 보인다. `measure_composite` import-time ProcessPool도 stop/restart 때 다수 `python -m api.main` 자식 프로세스로 보여 원인 판단을 흐렸다.
- 수정 패턴: `AUTO_LOGIN=1`에서 `GET /`는 현재 프로세스의 즉시 ACS 성공 handoff가 아니면 무조건 `/saml/login`으로 보낸다. `/saml/login`/`acs`/`metadata`는 SAML 전용 executor에서 실행하고, full_app, search index, thumbnails, composite, 이전 LoginId query/cookie/cache 상태를 보지 않는다. bootstrap startup은 full-app idle import를 예약하기 전에 SAML runtime을 preload해서 `OneLogin`/`xmlsec` native libraries가 `pyvips`/composite warmup보다 먼저 로드되게 한다. measure ProcessPool은 shutdown 시 명시적으로 닫는다.
- 평가: `systemctl restart uvicorn` 직후 startup 로그에 `[BOOTSTRAP SAML] runtime preloaded reason=bootstrap-startup-before-full-app`가 full-app/composite warmup보다 먼저 보여야 한다. 첫 접속 로그가 `[BOOTSTRAP SAML LOGIN]`으로 시작해야 하며, old Korean install message가 보이면 최신 bootstrap 경로가 배포되지 않았거나 `api.full_app`를 직접 타는 것이다. `lxml & xmlsec libxml2 library version mismatch`가 다시 나오면 로그의 `origins`와 `loaded_native_libs`에서 conda env와 `/usr/lib` native library mixing을 확인한다.

### stats.json concurrent save guard (2026-06-10)

- 증상: `logs/stats.json` 파일이 있는데도 `통계 저장 실패: [Errno 2] No such file or directory: 'logs/stats.json.tmp' -> 'logs/stats.json'`가 서버 로그에 찍힐 수 있었다.
- 원인: `api/access_logger.py::AccessLogger._save_stats()`가 모든 저장에 같은 임시 파일명 `stats.json.tmp`를 사용했다. 새로고침/동시 접속 또는 여러 Python 프로세스 저장이 겹치면 한 저장이 tmp를 `stats.json`으로 옮긴 뒤 다른 저장이 같은 tmp를 다시 `os.replace()`하려고 해서 실패했다.
- 수정 패턴: stats 저장은 프로세스 내부 thread lock과 `stats.json.lock` 파일 lock을 동시에 잡고, 파일에서 최신 stats를 다시 읽은 뒤 병합/저장/replace까지 한 critical section 안에서 끝낸다. 임시 파일은 pid/thread/time을 포함한 고유 파일명만 사용하고 실패 시 자기 tmp만 정리한다.
- 평가: `scripts/e2e_chunk1.js`의 `7,12,20 Class / MY LOT / stats`는 동일 LoginId로 root page를 동시 오픈해 page-visit 저장 race를 만든다. `scripts/e2e_stats_save_race.py`는 `AccessLogger._save_stats()`를 thread/process 동시성으로 직접 stress 한다. `scripts/run-e2e-playwright.ps1`는 `stats-save-race`와 `server-log-guards` progress record를 항상 만들고, 서버 stdout/stderr에 `통계 저장 실패` 또는 기존 `stats.json.tmp` 실패 문구가 있으면 전체 E2E를 FAIL 처리한다.

### Cold Start first-hit 2~3초 지연

- 증상: 서버 재기동 직후 첫 `GET /`, `/api/config`, `/api/browse-folders`, `/js/main.js`가 함께 2~3초대까지 느려짐
- 원인: startup 초기에 전체 트리 디스크 워밍과 무거운 인덱스 load/build가 첫 사용자 요청과 같은 프로세스에서 경합함
- 수정:
  - 전체 3depth 디스크 워밍 제거
  - `palette_3k` 중심 targeted warm만 유지
  - 로컬 HTTPS self-warm으로 `/`, `/api/config`, `/api/browse-folders`, `/js/main.js`, `files/recursive` first-hit 선행
  - 인덱스 load/build와 후속 캐시 빌드는 `BACKGROUND_TASKS_PAUSED` 해제 후(user idle) 시작
  - internal self-warm 요청은 `X-L3-Startup-Warm` 헤더로 user-priority / access-tracking 경로에서 제외
- 구현 위치: `api/main.py`

### 배포 후 일부 유저가 이전 JS를 계속 쓰는 문제

- 증상: 신규 기능을 배포했는데도 일부 클라이언트가 이전 JS 모듈을 계속 사용함
- 원인: top-level `main.js`만 버전이 바뀌고, 하위 static import / dynamic import / worker URL은 예전 경로를 그대로 참조할 수 있었음
- 수정:
  - `index.html`의 `/js/*.js`, `/css/*.css`에 동일 버전 서명 `?v=...` 부여
  - `/js/{filename}` 서빙 시 JS 본문 내부의 상대 import, dynamic import, worker URL에도 같은 `?v=...`를 주입
  - JS/CSS는 `Cache-Control: no-cache` + `ETag` + mtime lazy reload를 함께 사용해 재검증 강제
- 구현 위치: `api/main.py`

### Chip Label 원본 Wafer 해석 계약 (2026-05-02)

- chip label과 원본 wafer 매칭 key는 파일명 앞 5개 토큰 `product/bottom/wafer/date/time`이다. 예: `AAU220_00P_13_20260501_010000`.
- suffix가 다른 pair도 같은 key면 같은 wafer로 본다. 예: chip `AAU220_00P_13_20260501_010000_EE_PWQ_X13_Y11_B285.PNG` ↔ wafer `AAU220_00P_13_20260501_010000_96.0_2_EE_PWQ.PNG`.
- `/api/chip-annotations`와 `/api/chip-label-wafer` 류 경로는 `classification_chips`/`obj_id_maps` 파생 경로를 원본 wafer path로 역해석해야 한다.
- chip label → wafer/lot 결과는 lot/wafer 기준으로 중복 제거하고 원본 wafer만 반환해야 한다. derived path가 응답에 남으면 UI context menu와 E2E 모두 FAIL 처리한다.
- UI `Wafer 보기`가 기존 `/api/search` 결과를 재사용하는 경우에는 결과 목록에서 `_xN_yN(_b...)` chip crop 파일명을 먼저 제외한 뒤 lot/wafer dedupe를 수행한다. 속도 회귀를 막기 위해 이 보정 때문에 서버 전체 파일 lookup을 추가하지 않는다.
- 매칭 성능 회귀를 막기 위해 prefix lookup은 전체 이미지 파일 순차 탐색으로 되돌리지 않는다. `scripts/e2e_chunk1.js`의 `chip-label-prefix-wafer` record에서 path/speed를 함께 확인한다.

### Composite Subset 이벤트루프 블로킹 (2026-05-11)

- 증상: `unknown` 이미지로 Composite Map을 만든 뒤 `Subset 만들기`를 실행하면, subset 완료 전까지 다른 탭/단일 이미지의 `/api/image` 로드가 밀릴 수 있었다.
- 원인: `/api/composite-subset`이 `async` 엔드포인트 안에서 `create_subset_map()`과 composite thumbnail cache invalidation을 직접 실행해 NPZ load/render/write 동안 이벤트 루프를 막았다.
- 수정 패턴: 기존 JSON 응답 계약은 유지하되, subset cache invalidation과 `create_subset_map()`은 `COMPOSITE_EXECUTOR`의 `run_in_executor`로 실행한다. 이미지 로드 지연을 timeout 완화로 숨기지 않는다.
- 평가: `unknown` 재귀 이미지로 composite 생성 → subset fetch pending 중 `/api/image` 또는 next/prev 이미지 전환이 subset 완료를 기다리지 않고 응답해야 한다.

### Selected Shot/Chip Composite 속도 (2026-08-11)

- 증상: selected Shot/Chip Composite가 일반 Wafer Composite보다 훨씬 느리게 느껴질 수 있다.
- 원인: Wafer Composite는 전체 이미지 batch/numba 누적을 타지만 selected Shot/Chip Composite는 선택 rect별 Python/numpy crop 루프를 탔다. `/api/composite-map` task 시작 시 LoginId composite thumbnail cache 전체를 삭제하면 운영 환경에서 시작 지연이 커진다.
- 수정 패턴: selected rect 누적은 `_numba_accumulate_selected()`를 우선 사용하고, numba가 없을 때만 numpy fallback을 쓴다. `/api/composite-map` 시작 경로에서는 LoginId 단위 composite thumbnail cache 전체를 지우지 않는다. `/api/thumbnail` fast path는 source mtime보다 오래된 thumbnail을 cached로 반환하지 않는다. Composite 결과 표시는 일반 이미지와 같이 grid `/api/thumbnail?size=512`, single `/api/image?level=...`를 유지한다.
- Shot Composite 경계는 chip마다 독립 border를 칠하지 말고 target grid edge 기준으로 최종 선폭을 그린다. 기본 내부/외곽 총 3px, 외곽 조정은 `SHOT_COMPOSITE_OUTER_BORDER_PX`로 한다. 내부 공유 경계가 6px가 되면 구현 오류다.

### Global logical search basic-index fallback (2026-05-11)

- 증상: full token index가 아직 준비되지 않은 cold/basic cache load 상태에서 UI global logical search가 `bintype AND _wafer_` 같은 실제 파일명 필드 검색을 0건으로 반환할 수 있었다.
- 원인: `api/index_service.py::_evaluate_logical_query()`가 token0/token2만 있는 상태에서도 token0을 전체 토큰 인덱스처럼 써서, LOT이 아닌 filename term이 매칭되지 않았다. `_wafer_`처럼 underscore delimiter가 포함된 term도 token2 index만으로는 매칭되지 않았다.
- 수정 패턴: token0/token2 fast path는 유지하되, logical term이 index hit를 만들지 못하거나 literal underscore delimiter를 포함하면 constraint 안에서 full filename fallback을 수행한다. UI 검색은 `folder` param 없이 global로 나가야 하며 stale folder scope를 API 요청이나 상태 검사에 노출하지 않는다.
- 평가: `scripts/e2e_chunk1.js` Phase `3v unknown 실제 파일명 기반 text 검색`의 API/UI 반복 검색이 non-empty `unknown/` 결과와 stable counts를 보여야 한다.

### MY LOT wafer pair search widening (2026-06-01)

- 증상: MY LOT Wafer 그룹에 같은 LOT의 일부 wafer만 등록했는데 LOT 그룹처럼 해당 LOT의 모든 wafer가 저장/표시될 수 있었다.
- 원인: MY LOT batch paste/search가 `/api/search`에 `q`, `lot_multi`, `lot_wafer`를 함께 보내면 `SearchService.search()`의 `q + lot_multi` 분기가 먼저 실행되어 `lot_wafer` pair 필터를 적용하지 않았다. 프론트의 `updateGroupEntries()`도 wafer 모드에서 저장된 pair를 LOT-only로 재검색해 그룹을 전체 LOT wafer로 확장할 수 있었다.
- 수정 패턴: `query_for_search`가 `lot_filter` 또는 `lot_wafer_pairs`와 결합되면 둘 다에서 LOT 후보를 만들고, indexed hit와 live fallback 모두 같은 `lot_wafer_pairs` 필터를 통과시킨다. MY LOT wafer update/save는 LOT/Wafer pair 단위로만 검색하고, 검색 결과 0건을 LOT 전체 검색으로 fallback하지 않는다. Numeric wafer는 leading zero를 제거해 `5 == 05`로 처리한다.
- 평가: 같은 LOT에서 여러 wafer 중 일부 pair만 붙여넣고 저장한 뒤 Wafer 그룹 Grid를 열었을 때 선택 pair 외 wafer가 없어야 한다. `/api/search?...lot_wafer=LOT:5...`는 파일명 wafer `05`를 찾아야 한다.

### Bootstrap forwarded Response handling (2026-08-18)

- 증상: full app lazy load 후 `/api/files?path=classification/<deleted-class>`가 404 대신 `Exception in ASGI application`과 `TypeError: Object of type JSONResponse is not JSON serializable`을 낼 수 있었다.
- 원인: `api/main.py::get_files()`가 full app handler에서 이미 생성한 Starlette `JSONResponse`를 다시 `JSONResponse(forwarded)`로 감쌌다.
- 수정 패턴: bootstrap route가 `_maybe_forward_to_full_app()` 결과를 받을 때, 결과가 `Response`이면 그대로 반환하고 dict/list 같은 JSON-serializable 값만 `JSONResponse`로 감싼다. `/api/files`처럼 bootstrap과 full app이 같은 route를 공유하는 경로는 deleted/missing classification folder 404 응답을 직접 확인한다.
- 평가: `scripts/e2e_chunk3.js` record `label-wafer-crud`는 삭제된 class folder의 `/api/files`가 stable 404인지 확인한다.

### Grid Coord Shot Composite와 Measure median (2026-08-18)

- 증상: grid에서 여러 wafer를 선택한 뒤 Coord로 Shot을 고르고 Composite를 만들면 대표 단일 이미지 하나만 source로 쓰이거나, gridImage 로드 후처리가 늦게 빈 selection sync를 실행해 coordinate list가 비워질 수 있었다. Measure Composite의 `med` 요구는 failbit/class index가 아니라 FBT/QVL 같은 measure 값에서 처리해야 한다.
- 수정 패턴: frontend는 grid Coord 진입 시 선택 wafer 목록을 `_pendingGridRegionComposite.sourceImages`에 보존하고, selected Shot/Chip Composite payload의 `image_paths`로 사용한 뒤 cleanup한다. Coord modal에 입력 state가 있으면 `chipAnnotator.updateSelectedChipsList()`의 자동 sync가 coordinate list를 덮지 않아야 한다. `/api/measure-composite`와 `/api/measure-composite-data`는 `aggregation=median`을 허용하고, `api/measure_composite.py`는 chip 좌표별 value list의 median을 계산한다. BIN/SYSTEMATIC은 계속 `count`를 `sum`으로 변환하고, failbit grade composite 경로는 변경하지 않는다.
- 평가: `scripts/e2e_chunk2.js` record `selected-region-composite`는 grid Coord selected Shot payload의 source image 2개와 pending cleanup을 확인하고, 브라우저에서 `/api/measure-composite-data` median 결과를 raw positions median과 비교한다.
