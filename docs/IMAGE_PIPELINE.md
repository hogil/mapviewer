# Image & Position File Generation Rules

이 문서는 현재 코드가 실제로 사용하는 이미지/팔레트/`positions.json` 계약을 정리합니다. 정본 코드는 `api/main.py`, `api/config.py`, `js/chip-annotator.js`입니다.

## 런타임 루트

기본 루트는 `api/config.py` 기준이며, 시작 스크립트가 이를 override할 수 있습니다.

- Windows 기본값
  - `IMAGES_ROOT=D:/project/data/wm-811k`
  - `POSITIONS_ROOT=D:/project/data/positions`
- Linux 기본값
  - `IMAGES_ROOT=/appdata/appuser/images`
  - `POSITIONS_ROOT=/appdata/appuser/positions`

## 현재 이미지 응답 진입점

이미지 관련 런타임 진입점은 아래 API입니다.

- `GET /api/image`
- `GET /api/thumbnail`
- `GET /api/image/crop`

세 엔드포인트 모두 필요 시 다음 파라미터를 함께 처리할 수 있습니다.

- `personalized`
- `scheme`
- `grade_filter`
- `bottom_filter`

PNG 원본은 서버가 팔레트를 메모리에서 패치한 뒤 그대로 응답하거나, 그 상태로 썸네일/피라미드를 생성합니다.

## 팔레트 인덱스 계약

palette 이미지에서 의미 있는 인덱스는 아래 순서를 기준으로 사용합니다.

| 인덱스 | 의미 |
|--------|------|
| `0..7` | `Grade0..Grade7` |
| `8` | `background` |
| `9` | `text` |
| `10` | `bottom.Normal` |
| `11` | `bottom.Invalid` |
| `12..23` | `bottom.B285..B390` |
| `31` | composite/fallback 배경 또는 white mask 용도로 사용 가능 |

`Normal`과 `Invalid`는 BIN이 아니라 고정 border 인덱스입니다.

## 썸네일과 피라미드 기본값

`api/config.py` 기본값:

- `THUMBNAIL_SIZE=512`
- `THUMBNAIL_FORMAT=PNG`
- `THUMBNAIL_QUALITY=100`
- `PYRAMID_LEVELS=0.2,0.5,0.7,1.0`
- `PYRAMID_FORMAT=WEBP`
- `PYRAMID_Q=100`
- `PYRAMID_KERNEL=cubic`

실제 런타임은 `start.ps1`, `start.sh`가 `JPEG` 등으로 override할 수 있습니다.

## 리사이즈 규칙

현재 구현에서 썸네일/피라미드 리사이즈는 cubic/BICUBIC 계열이 기준입니다.

- 썸네일: pyvips 또는 Pillow의 cubic/BICUBIC 경로
- 피라미드: `PYRAMID_KERNEL` 기준, 현재 기본 `cubic`

문서에서 Lanczos3를 현재 구현처럼 설명하면 맞지 않을 수 있습니다.

## positions.json 조회 규칙

서버의 positions 조회 엔드포인트:

- `GET /api/chip-positions`

서버는 positions JSON을 정규화해서 다시 쓰지 않고, 찾은 원본 JSON을 그대로 반환합니다.

경로 lookup은 현재 두 단계입니다.

1. 우선 경로의 첫 컴포넌트를 제거한 trimmed path
2. 실패 시 레거시 full parent path

즉 positions 경로는 하나의 canonical path만 있다고 가정하면 안 됩니다.

## positions.json에서 UI가 실제로 쓰는 필드

프런트의 chip overlay와 hit-test는 `js/chip-annotator.js` 기준으로 아래 필드를 직접 사용합니다.

- `coord.grid_edges.xs`
- `coord.grid_edges.ys`
- `chips[].rect`
- `chips[].x_abs`
- `chips[].y_abs`
- `chips[].x_cal`
- `chips[].y_cal`
- `chips[].b`

추가 메타데이터는 표시용으로 읽을 수 있습니다.

- `partid`
- `device`
- `pgm`

이 값들은 top-level뿐 아니라 `meta`, `metadata`, `header`, `info` 같은 중첩 객체에서도 휴리스틱하게 탐색될 수 있습니다.

## 최소 positions.json 예시

```json
{
  "image_path": "wm-811k/example.png",
  "coord": {
    "grid_edges": {
      "xs": [0, 100, 200],
      "ys": [0, 100, 200]
    },
    "canvas": {
      "width": 200,
      "height": 200
    }
  },
  "chips": [
    {
      "x_abs": 10,
      "y_abs": 20,
      "x_cal": -1,
      "y_cal": 1,
      "b": "285",
      "rect": {
        "x0": 0,
        "y0": 0,
        "x1": 100,
        "y1": 100,
        "quad": [[0, 0], [100, 0], [100, 100], [0, 100]]
      }
    }
  ]
}
```

## Chip Annotation과의 관계

Chip Annotation은 positions를 직접 참조합니다.

- overlay hit-test
- 좌표 표시
- chip crop 위치 계산
- composite에서 device 수 판정

따라서 `device`, `partid`, `pgm` 같은 메타데이터를 단순 표시용 optional 정보로만 축소하면 불완전할 수 있습니다.

## 현재 로컬 fail-bit 샘플 데이터 규칙

현재 사내 로컬 PC에서 사용하는 샘플 데이터는 아래 경로를 기준으로 유지합니다.

- `D:/project/data/wm-811k/palette_5mb`
- `D:/project/data/wm-811k/palette_3k`
- `D:/project/data/positions/palette_5mb`
- `D:/project/data/positions/palette_3k`

이 로컬 더미 데이터셋은 아래 추가 규칙을 따릅니다.

### 1. full grade chip의 95% / 5% 규칙

chip interior가 `Grade1..Grade7` 중 하나로 100% 채워져 있는 칩은 그대로 두지 않습니다.

- chip border는 유지
- interior 픽셀의 약 95%는 원래 grade 유지
- interior 픽셀의 약 5%는 `Grade0`로 랜덤 치환

즉 synthetic dataset에서도 완전한 단색 grade chip 대신, 소량의 `Grade0` 노이즈가 섞인 형태를 사용합니다.

### 2. wafer 원형 더미 영역 제거

wafer를 둥글게 보이게 하려고 chip 바깥에 남겨 둔 dummy 픽셀은 최종 데이터셋에서 유지하지 않습니다.

- chip rectangle 바깥 픽셀은 모두 background index `8`
- dummy outside-chip 인덱스는 남기지 않음

즉 chip 영역과 배경 영역 사이에 별도의 원형 dummy zone이 있으면 안 됩니다.

## 로컬 재생성 구현

로컬 fail-bit dataset 재생성용 구현은 아래 스크립트를 사용합니다.

```text
scripts/refresh_failbit_local_maps.py
```

처음 보는 AI가 그대로 재생성할 수 있어야 하는 상세 절차, 파일 인벤토리, deterministic seed 규칙, `palette_3k`의 `wafer_palette_5mb.png` 복제 규칙은 `docs/LOCAL_FAILBIT_DATASET_SPEC.md`를 따릅니다.

## chip annotation 저장과의 차이

이 문서는 `positions.json` 계약 문서입니다. chip annotation 저장 포맷은 별도 문서인 `docs/CHIP_ANNOTATION.md`를 따릅니다.

현재 annotation JSON은 설계 문서의 과거 예시보다 훨씬 단순하며, versioned multi-entry 구조를 사용합니다.

## color legends

개인색 및 composite 색 설정은 아래 파일을 사용합니다.

```text
logs/color-legends.json
```

주요 섹션:

- 사용자별 personal palette
- `composite` 하위 사용자별 gradient
- `lastModified` 기준 캐시 분리

## 외부 파이프라인에 대한 범위

현재 저장소에는 로컬 fail-bit synthetic dataset 재생성 스크립트가 포함되어 있습니다. 다만 이 문서는 여전히 앱이 소비하는 공통 계약 문서로 유지합니다.

외부 fail-bit 파이프라인 메모는 `docs/FAILBIT_DUAL_PIPELINE.md`를 참고합니다.
