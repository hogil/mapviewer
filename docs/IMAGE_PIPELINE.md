# Image & Position File Generation Rules

이 문서는 L3 Tracker에서 웨이퍼 이미지와 position JSON 파일을 생성하는 규칙을 설명합니다.
AI/외부 도구가 호환 파일을 생성할 때 이 규칙을 따라야 합니다.

---

## 1. 이미지 파일 형식

### 기본 규격

| 항목 | 값 |
|------|-----|
| 포맷 | PNG (palette-indexed, PIL mode=`P`) |
| 컬러 모드 | 팔레트 인덱스 (RGB가 아닌 정수) |
| 인덱스 범위 | 0 ~ 31 |
| 이미지 형태 | 정사각형 (rotation 후 square resize) |

### 팔레트 인덱스 체계 (고정)

픽셀 값은 RGB 값이 아닌 팔레트 테이블 인덱스이며, 아래 순서를 **고정**으로 사용합니다.

| 인덱스 | 키 | 의미 |
|--------|-----|------|
| 0~7 | `Grade0`~`Grade7` | 칩 내부 Grade |
| 8 | `background` | 배경 |
| 9 | `text` | 텍스트 |
| 10 | `bottom.Normal` | Normal 테두리 |
| 11 | `bottom.Invalid` | Invalid 테두리 |
| 12 | `bottom.B285` | 00P BIN |
| 13 | `bottom.B286` | 00P BIN |
| 14 | `bottom.B287` | 00P BIN |
| 15 | `bottom.B288` | 00P BIN |
| 16 | `bottom.B290` | 00P BIN |
| 17 | `bottom.B291` | 00P BIN |
| 18 | `bottom.B300` | 00C BIN |
| 19 | `bottom.B385` | 00C BIN |
| 20 | `bottom.B386` | 00C BIN |
| 21 | `bottom.B388` | 00C BIN |
| 22 | `bottom.B389` | 00C BIN |
| 23 | `bottom.B390` | 00C BIN |

`Normal/Invalid`는 BIN이 아니라 고정 테두리 인덱스(10, 11)입니다.

### BIN 타입 분기

제품 타입(00P vs 00C)에 따라 적용되는 BIN 코드 세트가 다릅니다.

| 제품 타입 | BIN 코드 세트 |
|----------|---------------|
| **00P** | 285, 286, 287, 288, 290, 291 |
| **00C** | 300, 385, 386, 388, 389, 390 |

각 BIN 코드는 `color-legends.json`의 `bottom` 섹션에서 `B{코드}` 키로 색상이 정의됩니다.
예: `"B285": "#0099FF"`, `"B300": "#AAAAAA"`

---

## 2. 이미지 전처리

이미지는 저장 전 두 단계의 변환을 거칩니다.

### 단계 1: 회전 (Rotation)
- 웨이퍼 노치(notch) 방향에 맞춰 이미지를 회전
- 회전 각도는 웨이퍼 메타데이터에서 결정

### 단계 2: 정사각형 리사이즈 (Square Resize)
- 회전 후 정사각형 비율로 리사이즈
- 최종 이미지는 항상 정사각형 (width == height)

**중요:** position JSON의 모든 좌표는 이 변환(회전 + 리사이즈) 이후의 픽셀 좌표입니다.

---

## 3. Position JSON 파일

### 파일 경로 규칙

기본 저장 경로는 `positions_root` 기준이며, 이미지와 동일한 stem 이름을 사용합니다.

```text
{positions_root}/{p1}/{p2}/{YYYYMMDD}/{image_stem}.json
```

예시:
```text
images/ASDF/EQ01/20260306/LOT1_STEP_W01_20260306_101530.png
positions/ASDF/EQ01/20260306/LOT1_STEP_W01_20260306_101530.json
```

참고: 서버 조회 시에는 위 경로를 우선 사용하고, 일부 레거시 경로도 fallback으로 탐색할 수 있습니다.

### 적재 조건

**00P, 00C 구분 없이** 모든 이미지에 대해 position 파일이 생성됩니다.

### JSON 구조

```json
{
  "kind": "00P",
  "coord": {
    "grid_edges": {
      "xs": [0, 100, 200, 300],
      "ys": [0, 100, 200, 300]
    },
    "canvas": { "width": 300, "height": 300 }
  },
  "chips": [
    {
      "x_abs": 10,
      "y_abs": 20,
      "b": "285",
      "x_cal": -12,
      "y_cal": 8,
      "rect": {
        "x0": 0,
        "y0": 0,
        "x1": 100,
        "y1": 100,
        "quad": [[0, 0], [100, 0], [100, 100], [0, 100]]
      }
    },
    ...
  ]
}
```

### 필드 설명

#### `coord.grid_edges`
칩 그리드의 경계선 좌표 배열입니다.

| 필드 | 타입 | 설명 |
|------|------|------|
| `xs` | int[] | 열(column) 경계 x좌표 배열 (오름차순) |
| `ys` | int[] | 행(row) 경계 y좌표 배열 (오름차순) |

열 n개이면 `xs`의 길이는 n+1 (양쪽 끝 포함).
행 m개이면 `ys`의 길이는 m+1.

#### `chips` 배열 (각 항목)

| 필드 | 타입 | 설명 |
|------|------|------|
| `x_abs` | int | 원본 절대 X 좌표 |
| `y_abs` | int | 원본 절대 Y 좌표 |
| `b` | string | BIN 코드 문자열 (예: `"285"`) |
| `x_cal` | int | 중심 기준 보정 X 좌표 |
| `y_cal` | int | 중심 기준 보정 Y 좌표 |
| `rect` | object | 타일 픽셀 영역 (`x0`,`y0`,`x1`,`y1`,`quad`) |

### UI에서 클릭 → 타일 찾기

사용자가 이미지의 (px, py) 좌표를 클릭했을 때 해당 칩을 찾는 방법:

```python
def find_chip_at(position, px, py):
    xs = position["coord"]["grid_edges"]["xs"]
    ys = position["coord"]["grid_edges"]["ys"]

    # 이진 탐색으로 열/행 인덱스 찾기
    col = bisect_right(xs, px) - 1
    row = bisect_right(ys, py) - 1

    # 범위 체크
    if col < 0 or col >= len(xs) - 1: return None
    if row < 0 or row >= len(ys) - 1: return None

    # 해당 셀에 속한 칩 찾기 (rect 기반)
    return next(
        (
            c for c in position["chips"]
            if c["rect"]["x0"] <= px < c["rect"]["x1"]
            and c["rect"]["y0"] <= py < c["rect"]["y1"]
        ),
        None
    )
```

---

## 4. color-legends.json

### 파일 경로
```
logs/color-legends.json
```

### 구조

최상위 키 = 사용자 로그인 ID (SAML username 기준).
특수 키: `"default"` (기본 팔레트), `"composite"` (복합 맵 팔레트), `"_preview_*"` (미리보기 임시 상태).

```json
{
  "default": { ... },
  "composite": {
    "{userId}": {
      "quantile0": "#FFFFFF",
      "quantile10": "#FFE6E6",
      ...
      "quantile100": "#FF0000",
      "modified": false
    }
  },
  "{userId}": {
    "top": {
      "Grade0": "#FFFFFF",
      "Grade1": "#9B9B9B",
      "Grade2": "#009619",
      "Grade3": "#0000FF",
      "Grade4": "#D91DFF",
      "Grade5": "#FFFF00",
      "Grade6": "#FF0000",
      "Grade7": "#000000"
    },
    "bottom": {
      "Normal": "#BEBEBE",
      "Invalid": "#FF9900",
      "B285": "#0099FF",
      "B286": "#FF714F",
      "B287": "#66FFCC",
      "B288": "#DA26CD",
      "B290": "#FFD700",
      "B291": "#32CD32",
      "B300": "#AAAAAA",
      "B385": "#00C8FF",
      "B386": "#FF00C8",
      "B388": "#00FF66",
      "B389": "#FF6666",
      "B390": "#6666FF"
    },
    "background": "#FEFEFE",
    "text": "#000001",
    "Username": "홍길동",
    "DeptName": "개발팀",
    "lastModified": "YYMMDD_HHmmss",
    "modified": false
  }
}
```

### 필드 설명

| 필드 | 설명 |
|------|------|
| `top` | Grade0~Grade7 색상 (칩 내부 Grade에 적용) |
| `bottom` | Normal/Invalid/BIN별 색상 (오버레이에 적용) |
| `background` | 웨이퍼 배경색 |
| `text` | 텍스트/레이블 색상 |
| `Username` | 사용자 실명 (표시용, 선택 필드) |
| `DeptName` | 부서명 (선택 필드) |
| `lastModified` | 마지막 수정 시각, 형식: `"YYMMDD_HHmmss"` |
| `modified` | default 팔레트에서 변경 여부 |

### bottom 키 목록

| 키 | 의미 |
|----|------|
| `Normal` | 정상 칩 테두리 (팔레트 인덱스 10) |
| `Invalid` | 유효하지 않은 칩 테두리 (팔레트 인덱스 11) |
| `B285`~`B291` | 00P 타입 BIN 코드별 색상 |
| `B300`, `B385`~`B390` | 00C 타입 BIN 코드별 색상 |

새 사용자 항목 생성 시 `bottom`에 사용 가능한 모든 BIN 코드 키를 포함하는 것을 권장합니다.
(00P/00C 모두 포함 → 렌더링 시 해당 제품 타입의 코드만 사용됨)

### `composite` 섹션

복합 맵(Composite Map)에 사용되는 0~100% 분위수 색상 그라데이션 설정.
최상위 `"composite"` 키 아래에 사용자 ID별로 정의됩니다.

| 키 | 설명 |
|----|------|
| `quantile0`~`quantile100` | 10단계 분위수 색상 (quantile0=최솟값, quantile100=최댓값) |
| `modified` | 사용자가 변경했는지 여부 |
| `lastModified` | 마지막 수정 시각 (선택) |
