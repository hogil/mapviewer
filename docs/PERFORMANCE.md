# 성능 최적화 가이드

이 문서는 "이상적인 최적화 아이디어"가 아니라 현재 코드와 시작 스크립트가 실제로 어떻게 동작하는지를 기준으로 정리합니다.

정본:

- `api/main.py`
- `api/config.py`
- `start.ps1`
- `start.sh`
- `index.html`

## 현재 서버 기본 원칙

- 서버는 HTTPS 전용으로 동작합니다.
- 인증서가 없거나 SSL 설정이 맞지 않으면 시작이 중단될 수 있습니다.
- Uvicorn worker는 현재 코드 경로에서 사실상 1로 고정됩니다.

즉 과거 문서처럼 다중 Uvicorn worker 확장을 권장하면 현재 구현과 충돌합니다.

## 현재 압축 상태

예전의 Brotli/GZip 미들웨어 설명은 현재 기준 정본이 아닙니다.

- `BrotliMiddleware`, `GZipMiddleware`는 현재 비활성화 상태
- Python 3.13 관련 이슈 때문에 활성 운영 경로가 아님

따라서 "현재 서버는 Brotli/GZip 압축을 사용한다"는 설명은 틀립니다.

## HTTP2 / Keep-Alive

`start.ps1`, `start.sh`에는 `HTTP2`, `KEEP_ALIVE` 환경변수가 남아 있지만, 현재 Python 서버 시작 경로의 핵심 동작을 결정하는 스위치로 적극 사용되지는 않습니다.

문서 기준으로는 "스크립트에 변수는 있으나 서버 실행 코드의 핵심 최적화 스위치는 아님" 정도로 보는 것이 맞습니다.

## 현재 캐시 헤더

현재 캐시 정책은 경로별로 다릅니다.

- `/`: `max-age=3600`
- `/api/image`: `no-store`
- `/api/thumbnail`: `no-store`
- 피라미드 이미지 응답: `max-age=31536000, immutable`

즉 "썸네일 1주일 immutable" 같은 일반론은 현재 코드와 다릅니다.

## 인덱스/검색 관련 성능

인덱스는 `.file_index_cache.txt`를 먼저 로드하고, 서버 응답을 막지 않는 백그라운드 빌드를 즉시 시작합니다.

관련 설정:

- `INDEX_WORKERS`
- `SEARCH_WORKERS`
- `INDEX_REFRESH_INTERVAL_MINUTES`
- `SEARCH_FALLBACK_MAX_FILES`
- `SEARCH_FALLBACK_TIMEOUT_MS`

운영 스크립트는 검색 폴백을 사실상 비활성화하는 값으로 실행합니다.

## 썸네일/피라미드 런타임 값

`api/config.py`의 기본값보다 실제 시작 스크립트 override가 더 중요합니다.

### Windows `start.ps1`

- `THUMBNAIL_FORMAT=JPEG`
- `THUMBNAIL_QUALITY=100`
- `PYRAMID_FORMAT=JPEG`
- `PYRAMID_Q=100`
- `PYRAMID_KERNEL=cubic`
- `PYRAMID_LOADER_MODE=random`
- `USE_TURBOJPEG=1`

### Ubuntu `start.sh`

- `THUMBNAIL_FORMAT=JPEG`
- `THUMBNAIL_QUALITY=100`
- `PYRAMID_FORMAT=JPEG`
- `PYRAMID_Q=100`
- `PYRAMID_KERNEL=cubic`
- `PYRAMID_LOADER_MODE=random`
- `USE_TURBOJPEG=1`

## 현재 concurrency 관련 핵심값

- `IO_THREADS`
- `THUMBNAIL_SEM`
- `THUMB_PREFETCH_BATCH`
- `THUMB_CLIENT_MAX_CONCURRENCY`
- `INDEX_WORKERS`
- `SEARCH_WORKERS`
- `VIPS_CONCURRENCY`
- `COMPOSITE_MAX_WORKERS`
- `COMPOSITE_RENDER_WORKERS`
- `COMPOSITE_SAVE_WORKERS`

하지만 Uvicorn 자체는 단일 worker 고정이라는 점이 가장 중요합니다.

## preload와 프런트 네트워크 경로

예전 문서의 preload/modulepreload 설명은 현재 `index.html` 기준 최신이 아닙니다.

현재는:

- `dns-prefetch`는 남아 있음
- 예전 preload/modulepreload는 정본으로 보기 어려움

## 현재 이미지 경로 최적화 포인트

- 원본과 썸네일은 `no-store`
- 피라미드는 장기 immutable 캐시
- 개인색/필터는 캐시 경로 자체를 분리
- composite는 별도 결과 경로와 캐시를 사용
- grid 썸네일은 TurboJPEG 사용 가능 시 해당 경로를 활용

## 2026-06-08 formal E2E 성능 기준값

실행 명령:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run-e2e-playwright.ps1 -Headless
```

세션:

- `SESSION=20260608-075006-6b0cd897`
- `BASE_URL=https://127.0.0.1:8443`
- `SUMMARY=D:\project\mapviewer\.codex-tmp\e2e-sessions\20260608-075006-6b0cd897\e2e-summary.json`
- `COLD_START_SUMMARY=D:\project\mapviewer\.codex-tmp\e2e-sessions\20260608-075006-6b0cd897\cold-start-summary.json`
- `REPORT=D:\project\mapviewer\.codex-tmp\e2e-sessions\20260608-075006-6b0cd897\e2e-report.txt`

최종 판정:

- `RESULT_SUMMARY status=PASS pass=27 fail=0`
- `PROCESS_CLEANUP status=PASS`
- stderr는 비어 있었고, timeout/warning/runtime exception은 없었다.

핵심 성능값:

| 항목 | 값 | 의미 |
|------|----|------|
| Fresh boot `domLoadedMs` | `1043ms` | 첫 `GET /`부터 `DOMContentLoaded`까지 |
| Fresh boot `viewerReadyMs` | `1644ms` | 첫 `GET /`부터 `window.viewer` 및 `window.__l3FullViewerReady=true`까지 |
| Fresh boot `explorerReadyMs` | `1657ms` | 첫 `GET /`부터 Explorer folder DOM 준비까지 |
| Viewer init after DOM | `601ms` | `viewerReadyMs - domLoadedMs`; DOM 이후 full viewer 준비 구간 |
| Fresh boot grid | `gridCount=5000`, `wraps=5000`, `visibleWraps=4`, `loadedVisible=4` | recursive `unknown` 5000장 그리드가 실제 DOM/visible thumbnail까지 뜬 상태 |
| Unknown grid/index phase | `loadMs=2030ms`, `count=5000`, `wraps=5000`, `broken=0` | phase `36,37,38,40`; 인덱스 build 시간이 아니라 unknown 5000장 그리드/DOM/무결성 확인 wall time |
| Cache/FQ grouped phase | `fqLoadMs=1921ms`, `fqCount=5000`, `wraps=5000`, `placeholders=0` | phase `46,52,53,54,55,58,59,61,62,63`; 단일 F/Q 생성 시간이 아니라 grouped grid/cache/FQ-missing/asset-version 검증 wall time |
| Search exact | `5.119ms` | `api exact q` |
| Search logical OR | `30.34ms` | `api logical or` |
| Search `lot_multi` | `0.886ms` | indexed LOT multi-search |
| Search `lot_wafer` | `0.625ms` | indexed LOT/Wafer search |
| Composite 10장 | `elapsedSec=3.9`, `processingTime=2.94`, `numba.warmed=true`, `threads=16` | browser wall time 및 server-reported composite processing time |
| Chip label wafer lookup | `annotationAvgMs=2.6`, `lookupMs=70.1` | chip label annotation 평균 및 wafer lookup |
| MY LOT lot 10 | `lotSaveMs=114.4`, `lotGridReadyMs=68`, `lotGridVisibleMs=16` | LOT 10개 paste/save/grid visible |
| MY LOT wafer 30 | `waferSaveMs=287.4`, `waferPositionVerifyMs=148`, `waferGridReadyMs=47`, `waferGridVisibleMs=42` | wafer 30개 save/grid visible; `waferPositionVerifyMs`는 E2E 검증 시간이지 save/copy 시간이 아님 |
| MY LOT total | `3160ms` | `mylot-wafer30-lot10-perf` 전체 wall time |

Fresh boot 비교 참고:

- 저장된 과거 boot smoke 51개 기준 `viewerReadyMs` 평균은 `1154ms`, median은 `1053ms`, P75는 `1292ms`, 범위는 `648~1894ms`.
- 2026-06-08 formal phase `0`의 `viewerReadyMs=1644ms`는 과거 평균/median보다 느린 쪽이지만 과거 범위 밖은 아니다.
- 이번 측정에서 증가분은 `WaferMapViewer` 생성보다 `domLoadedMs=1043ms` 구간 영향이 크다. 성능 회귀를 판단할 때 `domLoadedMs`와 `viewerReadyMs - domLoadedMs`를 분리해서 본다.

## 문서에서 제거해야 하는 오래된 설명

현재 기준으로 아래 설명은 정본이 아닙니다.

- Brotli/GZip 적용 수치
- HTTP/2 효과 수치
- preload 최적화 수치
- 다중 Uvicorn worker 권장표
- 구현 여부가 불명확한 프런트 최적화 아이디어 목록

## 2026-09-11 감사 수정: 저장된 E2E 성능 및 인코더 오류 재검증

비교 기록은 `20260823-073945-7cfd0957`, `20260823-075159-3a4066b7` 전체 E2E다. 두 실행은 각각 38/38 PASS였지만 서버 로그에는 WebP 인코더 실패가 있었다. runner의 성공 여부만으로 이미지 파생 캐시의 정상 생성을 판단하지 않는다.

| 기록 항목 | 8월 두 실행 | 의미 |
|---|---:|---|
| viewerReadyMs | 372 / 372 ms | 브라우저 진입 후 viewer readiness |
| loadMs | 1624 / 1717 ms | unknown 5000장 grid load, index build 시간 아님 |
| fqLoadMs | 1582 / 1634 ms | grouped grid/cache/FQ-missing 폴더 load, 단일 F/Q 생성 아님 |
| Composite 브라우저 wall time | 3002 / 3016 ms | 10개 원본으로 생성 완료까지 |
| Composite 서버 처리 | 2.41 / 2.52 s | 서버에서 보고한 처리 시간 |
| MY LOT 10 LOT 저장 | 91.5 / 89 ms | 브라우저 저장 요청 wall time |
| MY LOT 30 wafer 저장 | 289.2 / 268.9 ms | 브라우저 저장 요청 wall time |

피라미드 인코더 재현은 6400×6400 dense 입력의 0.7 배율을 사용했다. WebP Q100/effort1이 실패하고 기존 fallback이 원본 PNG를 `.webp`로 게시하는 문제를 수정했다. WebP effort/method4, 설정된 품질 사용, writer별 unique temp, 인코더 실패 전파를 확인했다. 격리된 실제 인코더 회귀 7개에서 demand WebP 4480×4480 2397ms, JPEG Q100 4480×4480 202ms, Pillow WebP fallback 3888ms를 기록했다. 이 수치는 1회 실행 및 서로 다른 포맷/인코더 조건이므로 반복 성능 평균이나 품질 등가 속도 비교가 아니다.

E2E 설정을 일반 `start.ps1`/`start.sh`와 같은 JPEG/Q100/cubic으로 명시했다. 8월의 WebP 경로와 포맷 조건이 다르며 캐시 상태도 통제하지 않았다. 새 프로세스 실행과 strict cold cache 삭제는 구분한다.

Chunk2 재시험 `20260911-002241-abd13aec`은 13/13 PASS, grid 5000개/visible loaded 5개/broken 0, `loadMs=1695`, `integrityCheckMs=17`이다. 별도 `total_files=850998`은 준비된 인덱스 크기이며 1695ms 동안 스캔한 파일 수가 아니다. 기존 integrity guard는 화면 밖 content-visibility 셀의 img geometry까지 읽어 renderer 계산을 유발했다. wrapper 기준으로 visible 셀을 먼저 고른 뒤 내부 이미지만 검사하도록 바꿨고, 기존 픽셀/수량/timeout 기준은 낮추지 않았다.

### NPZ 생명주기 수정 전 전체 E2E 실측: 20260911-002556-a0380b12

`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-e2e-playwright.ps1 -Chunk all -Headless` 실행 결과는 **39/39 PASS, exitCode=0, PROCESS_CLEANUP=PASS**다. Chunk1 18개/142.8초, Chunk2 11개/166.8초, Chunk3 8개/243.2초 및 서버 로그·통계 동시 저장 검사 2개가 통과했다. 실행 주소는 `https://127.0.0.1:8444`이며, 해당 임시 E2E 서버는 종료 후 정리되었다.

| 측정 항목 | 최종 전체 실행 | 8월 두 전체 실행 |
|---|---:|---:|
| DOMContentLoaded | 77 ms | 78–80 ms |
| Viewer ready | 293 ms | 372 ms |
| Explorer ready | 307 ms | 385–386 ms |
| unknown 5000장 grid loadMs | 1687 ms | 1624–1717 ms |
| 별도 visible image integrityCheckMs | 9 ms | 별도 기록 없음 |
| grouped cache/FQ-missing fqLoadMs | 1541 ms | 1582–1634 ms |
| Exact LOT API 평균 | 18.3 ms (표준편차 0.1) | 18.1–18.3 ms |
| Logical OR API 평균 | 37.1 ms (표준편차 0.3) | 36.0–37.4 ms |
| 100 LOT API 평균 | 3.3 ms (표준편차 0.2) | 3.4 ms |
| 100 LOT/wafer API 평균 | 4.9 ms (표준편차 0.3) | 4.9 ms |
| Chip annotation 평균 | 2.3 ms | 2.4–2.6 ms |
| Wafer lookup | 4.3 ms | 3.7–3.8 ms |
| Composite 10장 browser wall time | 2991.9 ms | 3001.8–3016.3 ms |
| Composite 10장 server processing | 2.25 s | 2.41–2.52 s |
| MY LOT 10 LOT 저장 | 88.3 ms | 89.0–91.5 ms |
| MY LOT 30 wafer 저장 | 209.6 ms | 268.9–289.2 ms |
| MY LOT 성능 record 전체 | 2852 ms | 3034–3327 ms |

grid 상태는 `count=5000`, `wraps=5000`, `visibleImages=5`, `loadedVisible=5`, `broken=0`이다. **인덱스 크기는 별도로 `total_files=850998`, `total_dirs=789`, `ready=true`, `building=false`**이며 grid loadMs 동안 이 파일들을 스캔했다는 의미가 아니다. `fqLoadMs=1541`은 기존 `<3000ms` 기준을 통과했고 `placeholders=0`이다. Composite Numba는 `warmed=true`, `threads=16`; runner warmup은 전체 1.532초 중 Numba 보고 시간 0.539초였다.

MY LOT LOT 10개는 이미지 11개를 표시했고 wafer 30개는 positions 30개를 확인했다. LOT grid ready/visible은 139/15ms, wafer grid ready/visible은 28/38ms였다. `waferPositionVerifyMs=124`는 테스트의 positions 확인 시간이며 저장 처리 시간에 합산하지 않는다. 검색 API 통계는 각 시나리오 3회 측정이다. UI 100 LOT/wafer 입력은 각각 104행을 반환했고 8월에는 103행이었으므로, 인덱스와 fixture 구성이 완전히 동일한 비교는 아니다.

세 chunk와 서버 stderr는 모두 0바이트이고 timeout·인코더 실패·IMAGE API ERROR·통계 저장 실패는 없었다. 서버 stdout에는 기존 클래스 정리 `Class not found` 28건, 의도한 없는 이미지/삭제 후 폴더 404 경고 4건 외에 **00:30:59 `[NPZ] save failed (square_maps_data_tmp.npz): [Errno 2] No such file or directory` 경고 1건**이 확인되었다. 이 경고는 완료 응답 뒤에 남은 NPZ writer와 다음 Composite cleanup의 충돌로 확인하여 수정했으며, 아래 최종 세션에서 재검증했다. 회귀 로그 guard는 `matches=[]`였지만 당시 guard에는 이 NPZ 경고가 포함되지 않았다.

위 NPZ 경고를 제외한 측정 지표에서 새로운 성능 회귀를 뒷받침하는 근거는 확인하지 못했다. 다만 단일 최신 세션과 두 과거 세션 비교이며, JPEG/Q100 대 과거 WebP 및 캐시 상태 차이가 있어 개선 비율을 일반화하지 않는다. `cold-start-summary.json`은 **strictCold=false**, 1회 existing-server cache smoke이다. 세 번의 캐시 삭제 cold-start benchmark 결과가 아니다.

원본 결과: `D:/project/mapviewer/.codex-tmp/e2e-sessions/20260911-002556-a0380b12/e2e-summary.json`, `D:/project/mapviewer/.codex-tmp/e2e-sessions/20260911-002556-a0380b12/cold-start-summary.json`, `D:/project/mapviewer/output/audit-fixes-20260911/full.out.log`.

### NPZ 수정 후 최종 전체 E2E: 20260911-004354-853d34f4

새 E2E 서버에서 전체 재실행한 결과는 **39/39 PASS, exitCode=0, PROCESS_CLEANUP=PASS**다. Chunk1 18개, Chunk2 11개, Chunk3 8개와 서버 로그·통계 동시 저장 검사 2개가 통과했다. NPZ와 필요한 positions/gradient 통계를 완료 응답 전에 저장하고, writer별 임시 파일 및 짧은 atomic replace 잠금을 사용한다. 저장 실패는 기존 정상 NPZ를 삭제하지 않고 호출자에게 전달한다. recolor의 NPZ 실패와 실제 positions 쓰기 실패도 성공으로 숨기지 않는다. 격리된 실제 함수 회귀 검사는 9/9 PASS였다.

| 측정 항목 | NPZ 수정 후 최종 실행 | 8월 두 전체 실행 |
|---|---:|---:|
| DOMContentLoaded | 78 ms | 78–80 ms |
| Viewer ready | 296 ms | 372 ms |
| Explorer ready | 310 ms | 385–386 ms |
| unknown 5000장 grid loadMs | 1623 ms | 1624–1717 ms |
| 별도 visible image integrityCheckMs | 8 ms | 별도 기록 없음 |
| grouped cache/FQ-missing fqLoadMs | 1568 ms | 1582–1634 ms |
| Exact LOT API 평균 | 19.8 ms (표준편차 0.5) | 18.1–18.3 ms |
| Logical OR API 평균 | 40.5 ms (표준편차 0.4) | 36.0–37.4 ms |
| 100 LOT API 평균 | 3.4 ms (표준편차 0.2) | 3.4 ms |
| 100 LOT/wafer API 평균 | 5.0 ms (표준편차 0.1) | 4.9 ms |
| Chip annotation 평균 / wafer lookup | 2.3 / 3.5 ms | 2.4–2.6 / 3.7–3.8 ms |
| Composite 10장 browser wall time | 6592.4 ms | 3001.8–3016.3 ms |
| Composite 10장 server processing | 6.20 s | 2.41–2.52 s |
| MY LOT 10 LOT 저장 | 91.0 ms | 89.0–91.5 ms |
| MY LOT 30 wafer 저장 | 194.6 ms | 268.9–289.2 ms |
| MY LOT 성능 record 전체 | 3123 ms | 3034–3327 ms |

Composite 완료 대기 시간은 약 3초에서 **6.59초로 실제 증가했다**. 이제 완료 직후 subset이 사용하는 NPZ와 positions가 준비되어 있으므로 과거의 조기 완료 응답과 측정 범위도 달라졌다. 기존 10초 기준은 그대로 통과했지만 사용자 대기 시간 증가를 성능 개선으로 표현하지 않는다. 서버 로그의 load/positions lookup/mask/render 합계는 약 2.285초, 전체는 6.205초다. 차이 약 3.92초에는 새로 기다리는 저장 작업 등이 포함되지만, 로그에 저장 단계별 시간이 출력되지 않아 이를 정확한 NPZ 압축 시간으로 단정하지 않는다. 후속 개선 후보는 NPZ 압축을 렌더링과 겹쳐 실행하되 완료 응답 전에 두 작업을 모두 기다리는 방식이며, 실제 속도와 메모리 사용량은 별도 측정이 필요하다.

최종 E2E는 Composite 직후 subset 호출에서 `status=200`, `success=true`, 2개 결과, `elapsedMs=33.6`을 확인했다. 10장 Composite의 subset 전 NPZ는 48,019,507바이트, recolor 후에는 48,019,771바이트로 존재했다. 별도 큰 subset 작업은 2966ms였고 동시에 요청한 image-size 14ms 및 image 135ms가 subset 완료 전에 끝났다. Numba는 `warmed=true`, `threads=16`이었다.

grid는 `count=5000`, `wraps=5000`, `visibleImages=4`, `loadedVisible=4`, `broken=0`이다. **인덱스 크기는 별도로 `total_files=851008`, `total_dirs=789`, `ready=true`, `building=false`**이며 1623ms의 인덱스 구축을 뜻하지 않는다. MY LOT wafer positions 30개 검증은 123ms로 저장 시간과 별개다. Exact/OR 검색은 과거보다 각각 약 1.5–1.7ms/3.1–4.5ms 증가했으며 단일 세션의 작은 차이로 지속적인 회귀 여부를 확정하지 않는다. 100 LOT 및 LOT/wafer API 시간은 비슷했다.

완료된 서버 stdout 2635줄을 guard 패턴 외의 warning/error/traceback까지 검토했다. `Class not found` 오류 28건은 E2E 클래스 정리, 경고 4건은 의도한 없는 이미지 1건과 삭제된 클래스 폴더 3건이었다. 별도 API 400은 잘못된 MY LOT 입력 2건과 measure thumbnail 입력 3건, MY LOT 그룹 정리 404는 1건으로 테스트의 예상 응답이다. **예상하지 않은 5xx·NPZ/positions/recolor 저장 실패·인코더 실패·IMAGE API ERROR·통계 저장 실패는 없었다.** 세 chunk, 서버, 통계 검사 stderr는 모두 0바이트이고 확장된 `server-log-guards.matches=[]`다. 과거 NPZ 경고는 위 수정 전 기록에 보존했다.

최종 실행도 JPEG/Q100/cubic이며 8월 WebP 실행과 포맷 및 캐시 상태가 다르다. `cold-start-summary.json`은 `strictCold=false`, 1회 existing-server cache smoke이고, `fqLoadMs=1568`, `placeholders=0`, 기존 `<3000ms` 기준을 통과했다. 엄격한 캐시 삭제 3회 benchmark 또는 인덱스 전체 재구축 측정으로 해석하지 않는다.

최종 원본 결과: `D:/project/mapviewer/.codex-tmp/e2e-sessions/20260911-004354-853d34f4/e2e-summary.json`, `D:/project/mapviewer/.codex-tmp/e2e-sessions/20260911-004354-853d34f4/cold-start-summary.json`, `D:/project/mapviewer/.codex-tmp/e2e-sessions/20260911-004354-853d34f4/server-e2e-server-8444.out.log`, `D:/project/mapviewer/output/audit-fixes-20260911/final-full.out.log`.

### 복합 동작 확장 수정 후 최종 검증: 20260911-063401-2fdbfd7f

기존 전체 E2E는 **39/39 PASS, exitCode=0, PROCESS_CLEANUP=PASS**다. 앞서 새 서버에서 실행한 확장 세션 `20260911-063055-8abec91d`도 **32/32 PASS**(navigation8/storage9/composite8/edges5 및 로그·통계 guard2), exitCode0, process cleanup PASS다. 집중 회귀는 frontend14/API19/batch5/MY LOT storage13/open3/mutable thumbnail4/race6/Composite lifecycle3/persistence9/pyramid7, 총 **83/83 PASS**다.

확장 검사는 3개 viewport(1280×720, 1440×900, 1920×1080), seed17/53/101의 각12개 혼합 동작, 위치·주석 응답 역전, 저장 중 그룹 전환/rename/delete, 두 사용자 격리, 16개 잘못된 입력, 8개 동시 읽기, Composite 소스1/2/5장×Chip/edge/full Shot을 포함한다. 실제 화면의 이미지·positions·선택·스크롤과 출력 파일을 비교한다. 기존 all은 별도로 10개 cross-role 탭, 5000장 grid, Class/label CRUD, Measure/좌표/내보내기를 재검증했다.

| 측정 항목 | 최종 전체 실행 | 직전 전체004354 |
|---|---:|---:|
| DOMContentLoaded | 78 ms | 78 ms |
| Viewer / Explorer ready | 297 / 312 ms | 296 / 310 ms |
| unknown5000장 grid loadMs | 1680 ms | 1623 ms |
| visible image integrityCheckMs | 8 ms | 8 ms |
| grouped cache/FQ-missing fqLoadMs | 1549 ms | 1568 ms |
| Exact LOT API 평균(3회) | 18.1 ms | 19.8 ms |
| Logical OR API 평균(3회) | 36.5 ms | 40.5 ms |
| 100 LOT / LOT-wafer API 평균(각3회) | 3.3 / 4.8 ms | 3.4 / 5.0 ms |
| Chip annotation 평균 / wafer lookup | 2.3 / 3.5 ms | 2.3 / 3.5 ms |
| Composite10장 browser wall time | 6616.1 ms | 6592.4 ms |
| Composite10장 server processing | 5.93 s | 6.20 s |
| MY LOT10 LOT 저장 | 91.3 ms | 91.0 ms |
| MY LOT30 wafer 저장 | 220.7 ms | 194.6 ms |
| MY LOT 성능 record 전체 | 2755 ms | 3123 ms |

grid는 count/wraps5000, visibleImages/loadedVisible4, broken0이다. 준비된 인덱스는 **851008파일/814디렉터리**이며 위1680ms는 인덱스 구축 시간이 아니다. MY LOT10 LOT은11이미지이며30 wafer의 positions 검증122ms는 저장 시간에 합산하지 않는다. Composite는 Numba warmed/16threads, runner warmup1.554초(Numba0.766초)였다.

큰 Subset2982ms 동안 image-size16ms 및 image135ms가 먼저 완료됐다. 확장 세션의 recolor4594.7ms 중에도 다른 이미지 응답17.9ms가 먼저 완료됐다. 이는 event loop가 작업 완료까지 막히던 회귀의 방지 근거이며, 해당 이미지 응답에는 캐시 영향이 있으므로 cold image decode17.9ms로 해석하지 않는다. 동일 사용자 Composite의 생성/cleanup/recolor/subset은 같은 출력 폴더 잠금으로 순서를 지키며, 다른 사용자 작업은 별개다. 이전833칩 writer가 최신1칩 작업을 덮던 경우를 PNG200×200/positions1/즉시Subset200×200으로 검증했다.

최종 pyramid 집중 검사에서는 demand WEBP2389ms/JPEG199ms, Pillow fallback3906ms, background WEBP2levels3299ms/JPEG396ms를 기록했다. 실제 인코더 실패 시 잘못된 파일을 게시하지 않음과 동시 demand/background도 통과했다. 포맷/바이트 크기/encoder 조건이 다르므로 속도 비율을 품질 등가 개선으로 일반화하지 않는다.

최종 전체는 JPEG/Q100/cubic, `strictCold=false`, existing-server cache smoke1회다. 일반적인 처리량이나 p95/p99, 4백만 파일 cold-index 재구축 성능을 측정한 결과가 아니다. 직전 실행 대비 grid+57ms, wafer save+26.1ms 등 작은 차이가 있지만 단일 세션만으로 지속적 회귀를 단정하지 않는다. Composite의 약6.6초 완료 시간은 필요한 NPZ/positions 저장까지 포함하며, 과거 조기 응답 약3초와 동등한 완료 범위가 아니다. 저장 단계 계측 후 렌더와 압축을 겹치는 최적화가 후속 후보이며 완료 전 내구성은 유지해야 한다.

확장 서버 로그1579행에서 예상 밖5xx/ERROR/Traceback/WinError32/NPZ·positions 저장 실패는0이다. 경고12개 중11개는 삭제된 소유 fixture 또는 의도한 없는 이미지404, **1개는 원인 미확정 thumbnail empty fallback**이다. 이후 실제 이미지/positions 검증은 통과했으나 해결됐다고 주장하지 않는다. 주입된 검색/권한503은 서버 장애와 구분했다. 각 단계의 결과와 로그 감사는 아래 보고서에서 확인한다.

정식 서버 로그는 stdout2785행/stderr0bytes다. ERROR/Traceback28쌍은 존재하지 않는 테스트 Class 정리(chip12/wafer16), 경고4건은 의도한 없는 이미지1개와 삭제된 Class조회3개다. 예상 밖5xx·저장 실패·WinError32는 없었으며, 확장 세션의 thumbnail fallback은 정식 세션에서는 재발하지 않았다. 로그 전체가 ERROR/Traceback0이라는 뜻은 아니다.

원본 및 해석: `D:/project/mapviewer/output/extended-audit-20260911/report.md`, `D:/project/mapviewer/output/extended-audit-20260911/extended-log-audit.md`, `D:/project/mapviewer/output/extended-audit-20260911/standard-log-audit.md`, `D:/project/mapviewer/.codex-tmp/e2e-sessions/20260911-063401-2fdbfd7f/e2e-summary.json`, `D:/project/mapviewer/.codex-tmp/e2e-sessions/20260911-063055-8abec91d/e2e-summary.json`.
