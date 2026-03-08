# Local Fail-Bit Dataset Spec

이 문서는 사내 로컬 데이터셋인 `palette_5mb`, `palette_3k`를 처음 보는 AI가 바로 재생성할 수 있도록 만드는 실행 스펙입니다.

정본 범위는 아래 3개입니다.

- 생성 절차와 명령: 이 문서
- 공통 이미지/positions 계약: `docs/IMAGE_PIPELINE.md`
- 외부 파이프라인과 파일명 필터 메모: `docs/FAILBIT_DUAL_PIPELINE.md`

실제 재생성 스크립트는 `scripts/refresh_failbit_local_maps.py`입니다.

## 목표

이 스펙의 목적은 다음 2가지를 동시에 만족하는 것입니다.

1. 기존 로컬 더미 데이터셋과 동일한 구조를 유지한다.
2. wafer를 둥글게 보이게 하던 dummy zone 없이, chip rectangle과 background만 남는 단순한 palette PNG를 만든다.

## 정본 경로

이미지 출력 경로:

- `D:/project/data/wm-811k/palette_5mb`
- `D:/project/data/wm-811k/palette_3k`

입력 positions 경로:

- `D:/project/data/positions/palette_5mb`
- `D:/project/data/positions/palette_3k`

이 로컬 스펙에서는 **positions JSON이 정본**입니다. PNG는 JSON을 기준으로 다시 그립니다.

## 파일 인벤토리

### `palette_5mb`

아래 6개 세트를 고정으로 사용합니다.

- `wafer_palette_5mb`
- `wafer_palette_10mb`
- `wafer_palette_15mb`
- `wafer_palette_20mb`
- `wafer_palette_25mb`
- `wafer_palette_30mb`

각 stem마다 아래 2개 파일이 1쌍입니다.

- 이미지: `D:/project/data/wm-811k/palette_5mb/<stem>.png`
- positions: `D:/project/data/positions/palette_5mb/<stem>.json`

이 6개는 단순 이름이 아니라 실제 파일 크기 타깃도 의미합니다.

- `wafer_palette_5mb.png` -> `5 MiB`
- `wafer_palette_10mb.png` -> `10 MiB`
- `wafer_palette_15mb.png` -> `15 MiB`
- `wafer_palette_20mb.png` -> `20 MiB`
- `wafer_palette_25mb.png` -> `25 MiB`
- `wafer_palette_30mb.png` -> `30 MiB`

palette PNG는 구조상 압축률이 너무 높아서 렌더링만 하면 목표 용량보다 훨씬 작아집니다. 따라서 생성 후 PNG 내부에 ancillary padding chunk를 추가해서 표시 결과는 유지한 채 파일 크기를 정확히 맞춥니다.

### `palette_3k`

총 `3000`쌍을 유지합니다.

- 이미지 패턴: `wafer_p3k_0001.png` ... `wafer_p3k_3000.png`
- JSON 패턴: `wafer_p3k_0001.json` ... `wafer_p3k_3000.json`

현재 로컬 synthetic 계약에서는 `palette_3k` PNG가 모두 동일한 이미지를 공유해도 됩니다. 현재 기본 생성 방식은 `palette_5mb/wafer_palette_5mb.png`를 source image로 사용해서 `3000`개 PNG로 복제하는 것입니다.

참고:

- `palette_3k`의 positions JSON은 계속 `wafer_p3k_0001.json` ... `wafer_p3k_3000.json` 구조를 유지합니다.
- 하지만 현재 PNG 정본은 JSON 렌더링 결과가 아니라 `wafer_palette_5mb.png` 복제본입니다.
- 즉 현재 로컬 contract에서 `palette_3k`는 "좌표 JSON은 3k 세트 유지, PNG는 5MB source image 3000장 복제"입니다.

## 좌표계와 캔버스

현재 로컬 positions JSON의 공통 구조는 아래와 같습니다.

- canvas size: `2304 x 2304`
- chip size: `96 x 96`
- grid shape: `20 cols x 20 rows`
- chip count: `332`
- `grid_edges.xs`: `192`부터 `2112`까지 `96` 간격
- `grid_edges.ys`: `192`부터 `2112`까지 `96` 간격

즉, full 20x20 grid를 쓰지만 실제 chip은 400개 전체가 아니라 `332`개만 존재합니다. 어떤 위치에 chip이 있는지는 반드시 `chips[]`를 기준으로 판단해야 합니다.

## positions JSON 필수 필드

생성 스크립트와 UI가 기대하는 최소 필드는 아래와 같습니다.

- top-level:
  - `image_path`
  - `kind`
  - `partid`
  - `device`
  - `pgm`
- `coord`:
  - `canvas.width`
  - `canvas.height`
  - `chip_size.width`
  - `chip_size.height`
  - `grid_edges.xs`
  - `grid_edges.ys`
  - `grid_shape.cols`
  - `grid_shape.rows`
- `chips[]`:
  - `x_abs`
  - `y_abs`
  - `x_cal`
  - `y_cal`
  - `b`
  - `g`
  - `rect.x0`
  - `rect.y0`
  - `rect.x1`
  - `rect.y1`
  - `rect.quad`

PNG 재생성에는 사실상 `chips[].g`, `chips[].b`, `chips[].rect`, `coord.canvas`가 핵심입니다. 그러나 UI 호환성을 위해 좌표 메타데이터도 함께 유지해야 합니다.

## 팔레트 인덱스 계약

생성 PNG는 palette-indexed `P` 이미지여야 하며, 인덱스 의미는 아래와 같습니다.

- `0..7`: `Grade0..Grade7`
- `8`: background
- `9`: text
- `10`: `Normal` border
- `11`: `Invalid` border
- `12..17`: `B285`, `B286`, `B287`, `B288`, `B290`, `B291`
- `18..23`: `B300`, `B385`, `B386`, `B388`, `B389`, `B390`
- `31`: background와 같은 RGB로 둬도 됨

현재 로컬 생성 스크립트는 `logs/color-legends.json`의 `default` scheme를 읽어 palette를 채웁니다.

## border 매핑 규칙

`chips[].b` 값은 아래처럼 팔레트 인덱스로 매핑합니다.

- `Normal` -> `10`
- `Invalid` -> `11`
- `285` or `B285` -> `12`
- `286` or `B286` -> `13`
- `287` or `B287` -> `14`
- `288` or `B288` -> `15`
- `290` or `B290` -> `16`
- `291` or `B291` -> `17`
- `300` or `B300` -> `18`
- `385` or `B385` -> `19`
- `386` or `B386` -> `20`
- `388` or `B388` -> `21`
- `389` or `B389` -> `22`
- `390` or `B390` -> `23`

비어 있거나 알 수 없는 값은 `Normal(10)`으로 처리합니다.

## 렌더링 알고리즘

이미지는 반드시 아래 순서로 생성합니다.

### 1. 빈 캔버스 생성

- `coord.canvas.width`, `coord.canvas.height` 크기의 `uint8` 배열을 만든다.
- 배열 전체를 background index `8`로 채운다.

이 단계에서 wafer 원형 dummy zone은 존재하지 않습니다. 즉 chip rectangle 바깥은 처음부터 끝까지 background입니다.

### 2. chip rectangle 그리기

각 `chips[]`에 대해:

1. `rect.x0`, `rect.y0`, `rect.x1`, `rect.y1`를 읽는다.
2. rectangle 전체를 먼저 border index로 채운다.
3. 그 안쪽 1px inset 영역(`x0+1:x1-1`, `y0+1:y1-1`)을 chip interior로 사용한다.

즉 border thickness는 정확히 `1px`입니다.

현재 로컬 데이터 기준으로:

- outer chip area: `96 x 96 = 9216` px
- inner chip area: `94 x 94 = 8836` px
- border pixel count: `9216 - 8836 = 380` px

### 3. chip interior grade 채우기

chip interior는 `chips[].g` 값으로 채웁니다.

- `g == 0`: interior 전체를 `Grade0(index 0)`로 채운다.
- `1 <= g <= 7`: interior 전체를 해당 grade index로 채운 뒤, 아래 95/5 규칙을 적용한다.
- grade가 비정상이면 `0`으로 fallback한다.

### 4. 95% / 5% sparsening 규칙

이 규칙은 **현재 로컬 더미 데이터셋에서 매우 중요**합니다.

적용 대상:

- `Grade1..Grade7` chip
- 정확히는 생성 시점에 interior가 단일 grade로 채워지는 모든 chip

적용 방식:

1. interior 픽셀 수를 구한다. 현재 기준 `8836` px.
2. 그중 약 `5%`를 `Grade0`로 바꾼다.
3. 나머지 약 `95%`는 원래 grade를 유지한다.

현재 스크립트는 아래 계산식을 사용합니다.

- `sparse_count = max(1, round(inner.size * 0.05))`
- 현재 `8836 * 0.05 = 441.8` 이므로 실제 치환 수는 `442`

즉 한 chip interior가 `Grade1..Grade7`일 경우:

- 약 `8394` px는 원래 grade 유지
- 정확히 `442` px는 `Grade0`로 치환

주의:

- border는 절대 건드리지 않습니다.
- 이 규칙은 chip exterior나 background에는 적용하지 않습니다.

## 랜덤 seed 규칙

랜덤처럼 보여도 결과는 재실행마다 동일해야 합니다. 따라서 pseudo-random은 deterministic seed를 사용합니다.

현재 스크립트는 아래 요소를 `|`로 연결한 뒤 SHA-256 해시를 만들고, 앞 8바이트를 seed로 사용합니다.

- JSON file name
- `x0`
- `y0`
- `x1`
- `y1`
- `grade`

즉 seed key는 개념적으로 아래와 같습니다.

```text
<json_name>|<x0>|<y0>|<x1>|<y1>|<grade>
```

이 방식의 목적:

- 파일마다 패턴이 고정된다.
- 같은 chip은 재생성해도 같은 5% 위치가 선택된다.
- chip 위치나 grade가 바뀌면 seed도 바뀐다.

## wafer dummy zone 제거 규칙

과거 local dataset에는 wafer를 둥글게 보이게 하려고 chip rectangle 바깥에 dummy index가 남아 있었습니다. 대표적으로 `24`, `28`, `29` 같은 index가 관찰됐습니다.

이 스펙에서는 그것을 금지합니다.

최종 규칙:

- chip rectangle 밖은 오직 background index `8`
- chip rectangle 안은 border + interior만 존재
- chip과 background 사이의 별도 원형 zone 없음

즉 최종 이미지는 시각적으로 "사각 chip들의 집합 + 바깥 배경"만 보여야 합니다.

## 실제 실행 명령

repo root에서 아래처럼 실행합니다.

```bash
python scripts/refresh_failbit_local_maps.py
```

특정 데이터셋만 다시 만들려면:

```bash
python scripts/refresh_failbit_local_maps.py --targets palette_5mb
python scripts/refresh_failbit_local_maps.py --targets palette_3k
```

`palette_3k`를 현재 기본 복제 방식 대신 전부 개별 렌더링하려면:

```bash
python scripts/refresh_failbit_local_maps.py --targets palette_3k --render-all-p3k
```

## 파일 크기 맞춤 규칙

`palette_5mb` 계열은 저장 후 PNG `IEND` 직전에 private ancillary chunk `paDd`를 삽입해 파일 크기를 맞춥니다.

- chunk type: `paDd`
- 목적: PNG 표시 결과는 유지하고 파일 크기만 증가
- payload: deterministic bytes
- 최종 목표: stem의 `<N>mb` 값을 `N * 1024 * 1024` bytes로 맞춤

즉 `wafer_palette_5mb.png`는 최종 파일 크기가 정확히 `5 * 1024 * 1024` bytes여야 합니다.

## `palette_3k` 생성 규칙

현재 기본 규칙:

1. 먼저 `palette_5mb/wafer_palette_5mb.png`를 생성한다.
2. 그 파일을 `palette_3k/wafer_p3k_0001.png` ... `wafer_p3k_3000.png`로 그대로 복제한다.
3. 따라서 현재 기본 상태에서 `palette_3k` PNG 3000장은 서로 동일 binary copy다.

왜 이렇게 하는가:

- 로컬 synthetic dataset을 빠르게 유지하기 쉽다.
- 샘플/테스트 용도로는 3000장 개별 렌더링이 필요하지 않다.
- 대신 positions JSON은 3000개를 유지하므로 UI 좌표/선택 테스트는 계속 가능하다.

예외:

- 정말 `palette_3k` JSON별 서로 다른 이미지를 만들어야 할 때만 `--render-all-p3k`를 사용한다.

## 생성 절차 체크리스트

처음 보는 AI는 아래 순서로 작업하면 됩니다.

1. `D:/project/data/positions/palette_5mb`와 `palette_3k` JSON이 존재하는지 확인한다.
2. `python scripts/refresh_failbit_local_maps.py`를 실행한다.
3. `palette_5mb` 6개 PNG가 생성되었는지 확인한다.
4. `wafer_palette_5mb.png`가 정확히 `5 MiB`인지 확인한다.
5. `palette_3k` 3000개 PNG가 생성되었는지 확인한다.
6. `palette_3k` PNG가 `wafer_palette_5mb.png`와 동일 binary copy인지 확인한다.
7. sample 이미지 몇 장을 열어 chip border와 interior가 맞는지 확인한다.
8. chip 바깥에 dummy ring이 없는지 확인한다.

## 검증 규칙

최소 검증은 아래를 수행합니다.

### 파일 수 검증

- `palette_5mb`: PNG 6개, JSON 6개
- `palette_3k`: PNG 3000개, JSON 3000개

### 구조 검증

- sample JSON에서 `partid`, `device`, `pgm` 확인
- sample JSON에서 `coord.grid_edges`와 `chips[].rect` 확인
- sample JSON에서 `image_path`가 파일명과 맞는지 확인

### 픽셀 검증

- chip rectangle 바깥 unique index가 `8`만 남는지 확인
- `Grade1..Grade7` chip 내부에서 `Grade0`가 섞였는지 확인
- border가 1px로 유지되는지 확인

### 파일 크기 검증

- `wafer_palette_5mb.png` -> `5 MiB`
- `wafer_palette_10mb.png` -> `10 MiB`
- `wafer_palette_15mb.png` -> `15 MiB`
- `wafer_palette_20mb.png` -> `20 MiB`
- `wafer_palette_25mb.png` -> `25 MiB`
- `wafer_palette_30mb.png` -> `30 MiB`

### `palette_3k` 템플릿 검증

현재 계약에서는 `wafer_p3k_0001.png`와 다른 `wafer_p3k_xxxx.png`들이 모두 `wafer_palette_5mb.png`의 복제본이어야 합니다.

- `wafer_p3k_0001.png`가 정상 생성되었는지
- 나머지 2999장이 동일 binary copy인지
- source인 `palette_5mb/wafer_palette_5mb.png`와 해시가 같은지

만약 향후 `palette_3k` JSON마다 다른 `g`/`b` 패턴을 실제 PNG에도 반영해야 하면 그 시점부터는 `--render-all-p3k`를 사용해야 합니다.

## 실패 시 우선 점검할 것

- positions JSON의 `rect`가 깨졌는지
- `coord.canvas`가 누락됐는지
- `chips[].g`, `chips[].b` 값이 비정상인지
- `logs/color-legends.json`의 `default` scheme가 깨졌는지
- `palette_3k` 복제 source인 `palette_5mb/wafer_palette_5mb.png`가 없거나 잘못 생성됐는지
- `palette_3k`를 복제 모드로 돌렸는데 실제로는 JSON별 서로 다른 PNG가 필요한 상황인지

## 구현 정본

문서보다 코드가 우선입니다. 현재 구현 정본은 아래 파일입니다.

- `scripts/refresh_failbit_local_maps.py`

문서와 코드가 어긋나면, 코드를 수정한 뒤 이 문서도 함께 갱신해야 합니다.
