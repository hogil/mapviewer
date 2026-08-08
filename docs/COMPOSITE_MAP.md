# Composite Map

Composite Map은 여러 웨이퍼 이미지를 같은 좌표계로 합쳐 grade map과 average 계열 맵을 생성하는 기능입니다. 실제 구현 정본은 `api/composite_map.py`와 `api/main.py`입니다.

## 핵심 파일

- `api/composite_map.py`
- `api/composite_colors.py`
- `api/personal_colors.py`
- `api/main.py`
- `logs/color-legends.json`

## 출력 위치

현재 결과는 사용자별 단일 세션 경로에 유지됩니다.

```text
IMAGES_ROOT/composite_map/{login_id}/current
```

새 생성이 시작되면 해당 사용자의 기존 composite 결과는 정리되고 현재 결과 1세트만 남습니다.

## 대표 출력물

파일 확장자는 고정 PNG가 아닙니다. `COMPOSITE_FORMAT` 설정에 따라 `PNG` 또는 `JPEG`로 저장될 수 있습니다.

- `Grade_0.*` ~ `Grade_7.*`
- `square_average.*`
- `square_weighted_average.*`
- `square_average_{grades}.*`
- `square_weighted_average_{grades}.*`
- `square_maps_data.npz`
- 각 결과 이미지에 대응하는 `positions.json`

## 생성 흐름

```text
이미지 선택
  → 입력 이미지 정규화 및 로드
  → grade_counts 계산
  → positions.json 기반 chip 영역(base_indices) 생성
  → grade map 8장 생성
  → average map 2장 생성
  → NPZ 캐시 저장
  → 결과용 positions.json 복사
  → 필요 시 subset / recolor 재생성
```

## 선택 Chip/Shot Composite

단일 이미지 보기에서 Chip 또는 Shot을 선택하면 컨텍스트 메뉴의 `선택 Chip/Shot Composite Map 만들기`로 현재 이미지의 선택 영역만 Composite Map으로 생성할 수 있습니다.

- Chip 모드: 선택한 여러 `x_abs/y_abs` chip을 첫 Chip 크기의 canonical 한 칸에 누적한다. 결과 positions에는 canonical Chip 1개만 남고 `selected_chip_count`/`composite_sample_count`에 실제 선택 수를 기록한다
- Shot 모드: 선택한 Shot에 속한 모든 chip 좌표를 같은 상대 chip 격자에 누적한다
- 선택 영역 결과는 전체 wafer 캔버스를 유지하지 않고 canonical Chip 또는 Shot의 정확한 사각형 크기로 생성한다
- Shot 결과 positions는 첫 번째 canonical Shot의 chip 격자를 사용하고, Chip 결과 positions는 canonical Chip 1개를 사용한다
- Shot의 chip 수는 요청 목록이 아니라 원본 positions에 실제 존재하는 해당 Shot chip 수로 확정
- 기존 그리드 이미지 선택 기반 `Composite 만들기` 동작은 변경하지 않음

## 입력 이미지 규칙

- `POST /api/composite-map`는 최대 256장까지 허용합니다.
- 입력 이미지 중 positions 파일이 하나라도 발견되면, positions가 없는 이미지는 composite 계산에서 제외합니다.
- 입력 이미지 전체에 positions가 전혀 없을 때만 positions 없이 fallback 계산을 수행합니다.

## 스킴 결정 규칙

Composite는 클라이언트가 임의 scheme 문자열을 밀어 넣는 방식보다 현재 로그인 사용자 기준 스킴을 우선합니다.

- full composite 생성: 현재 `login_id`
- recolor: 현재 `login_id`
- subset: 현재 `login_id`, 없으면 NPZ에 저장된 scheme
- 로그인 정보가 없으면 `ANONYMOUS_LOGIN_ID`

즉 composite 배경과 개인색 기반 팔레트는 현재 사용자 기준으로 결정됩니다.

## 3영역 렌더링

모든 composite 결과는 아래 3영역 모델을 따릅니다.

1. 배경
   chip 바깥은 개인색의 `background`
2. chip border
   단일 device 입력이면 개인색의 `bottom.Normal`
3. chip interior
   grade map은 grade 개인색, average 계열은 composite gradient

positions가 있으면 chip 사각형을 기준으로 base canvas를 만들고, wafer 바깥의 원형 더미 영역도 전부 배경으로 바꿉니다.

## Grade Map

`Grade_n.*`는 특정 grade의 존재만 강조합니다.

- chip 바깥: 개인색 `background`
- chip 테두리: `bottom.Normal` 또는 숨김
- 해당 grade가 있는 픽셀: `Grade n` 개인색
- 같은 chip 내부의 나머지 픽셀: `Grade0`

## Average Map

현재 full average 계열은 두 종류입니다.

- `square_average.*`
- `square_weighted_average.*`

렌더링 규칙:

- chip 바깥: 개인색 `background`
- chip 테두리: `bottom.Normal` 또는 숨김
- 계산 대상 chip 내부: 사용자별 composite gradient
- 계산되지 않은 내부 기본 바탕: `Grade0`

계산은 chip 내부 마스크만 대상으로 하므로, chip도 아니고 배경도 아닌 중간 dummy 영역은 남기지 않습니다.

## Device 수에 따른 border

입력 이미지의 positions 메타데이터에서 unique device 수를 샘플링해 판정합니다.

- device 1개 이하: 모든 chip border 표시
- device 2개 이상: 모든 chip border 숨김

이 규칙은 결과 이미지와 복사된 `positions.json` 모두에 동일하게 적용됩니다.

## positions.json 복사 규칙

Composite 결과에는 결과 이미지마다 대응하는 `positions.json`을 복사합니다.

- source는 입력 이미지 중 positions가 실제로 존재하는 첫 번째 이미지
- 단일 device면 chip의 `b`를 `Normal`로 설정
- 다중 device면 chip의 `b`를 제거

즉 이미지 자체 렌더링과 JS overlay 규칙이 어긋나지 않도록 맞춥니다.

## NPZ 캐시

`square_maps_data.npz`는 recolor와 subset의 기준 데이터입니다.

주요 저장 항목:

- `square_mean`
- `square_weighted`
- `base_indices`
- `calc_mask`
- `weighted_mask`
- `grade_counts`
- `color_scheme`
- `colors`

## Subset

Subset은 저장된 `grade_counts`를 다시 읽어 생성합니다.

- 선택되지 않은 grade는 분모에 포함하지 않음
- 계산 범위는 chip 내부만 사용
- 이전 subset 결과는 지우고 현재 선택 1세트만 유지

대표 파일명:

- `square_average_35.*`
- `square_weighted_average_35.*`

## Recolor

Recolor는 원본 이미지를 다시 읽지 않고 `square_maps_data.npz`를 사용합니다.

- full average map 2장 재색칠
- 이미 존재하는 subset average map도 함께 재색칠
- 배경/개인색 팔레트와 composite gradient를 현재 사용자 기준으로 다시 적용

## API

- `POST /api/composite-map`
- `GET /api/composite-map/status/{task_id}`
- `POST /api/composite-subset`
- `POST /api/composite-recolor`
- `GET /api/composite-colors`
- `POST /api/composite-colors`

선택 영역 요청은 기존 요청에 아래 필드를 추가합니다.

```json
{
  "selection_mode": "chip",
  "selected_chip_coords": [{"x_abs": 10, "y_abs": 0}]
}
```

`selection_mode`는 `chip` 또는 `shot`입니다. Chip 선택은 선택한 좌표만 tight crop으로 만들고, Shot 선택은 아래처럼 Shot별 chip 묶음을 함께 전송합니다.

```json
{
  "selection_mode": "shot",
  "selected_chip_coords": [
    {"x_abs": 10, "y_abs": 0},
    {"x_abs": 11, "y_abs": 0}
  ],
  "selected_shot_groups": [
    {
      "shot_id": "4",
      "shot_shape": {"cols": 4, "rows": 6},
      "chip_coords": [
        {"x_abs": 10, "y_abs": 0},
        {"x_abs": 11, "y_abs": 0}
      ]
    }
  ]
}
```

여러 Shot은 layout의 canonical `shot_shape`(예: `4×6`)와 chip 좌표의 Shot 내부 위치를 사용해 같은 chip 격자에 누적합니다. Partial Shot이나 chip이 1개뿐인 edge Shot도 canvas를 `1×1`로 줄이지 않고 canonical cell 크기를 유지하며, 실제 보이는 chip만 해당 위치에 그리고 나머지는 배경으로 둡니다. 결과 positions는 첫 번째 canonical Shot의 실제 chip 수와 상대 rect를 사용하며, `selected_shot_count`, `selected_source_chip_count`, `selected_shot_shape`, `composite_sample_count`를 반환합니다.

선택 영역 Composite 결과의 `image_size`와 positions canvas는 canonical Shot 크기와 일치해야 합니다. 현재 E2E fixture P001 Shot 4/5는 각각 24 chip, 4×6이며 두 Shot을 합친 결과도 24 chip, 4×6입니다.

단일 이미지 Chip/Shot context menu export는 공통 TSV 필드를 사용합니다. `PROCESS_ID`, `CHIP_ID`, `X_ABS`, `Y_ABS`, `BIN`, `CHIP_COORD_X(mm)`, `CHIP_COORD_Y(mm)`, `RADIUS(mm)`, `SHOT_ID`, `SHOT_X`, `SHOT_Y`, `FULL_SHOT_TYPE`가 포함됩니다. `SHOT` 튜플 컬럼은 사용하지 않으며 Shot 순서는 `SHOT_X`, `SHOT_Y`로 분리합니다. 세 mm 값은 소수 셋째 자리까지 기록합니다. Shot 선택에서는 선택 Shot별 crop PNG 다운로드와 TSV 저장을 제공합니다.

Composite/Measure Composite 요청은 bootstrap SAML handoff로 확보한 현재 `LoginId`를 query parameter로 전달합니다. 서버의 `_current_login_id()`가 이 값을 사용하므로 결과는 `composite_map/{LoginId}`에 저장되고 `composite_map/notsaml`로 섞이지 않습니다.

## 관련 설정

- `COMPOSITE_FORMAT`
- `COMPOSITE_JPEG_QUALITY`
- `COMPOSITE_MAX_WORKERS`
- `COMPOSITE_RENDER_WORKERS`
- `COMPOSITE_SAVE_WORKERS`
- `COMPOSITE_BATCH_SIZE`
- `DAILY_CLEANUP_ENABLED`
- `DAILY_CLEANUP_HOUR`
- `DAILY_CLEANUP_MINUTE`
