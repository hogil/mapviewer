# Chip Annotation System 사용 가이드

## 📋 개요

L3 Tracker에 추가된 Chip Annotation 시스템은 웨이퍼 맵 이미지에서 개별 칩(die)을 마킹하고 분류할 수 있는 기능입니다.

## 🚀 주요 기능

1. **Die Grid 오버레이** - 웨이퍼 맵의 칩 그리드 시각화
2. **Chip 선택 및 마킹** - 마우스로 개별 칩 선택 또는 드래그로 영역 선택
3. **좌표 표시** - 마우스 호버 시 칩 좌표 (x, y) 표시
4. **Class/Label 할당** - 선택한 칩에 분류 및 라벨 지정
5. **YOLO 데이터 추출** - 마킹된 칩을 별도 이미지로 추출하여 YOLO 학습 데이터 생성

## 📁 폴더 구조

```
D:\project\
├── data\               # 원본 웨이퍼 이미지 (PROJECT_ROOT)
│   └── wm-811k\
│       └── palette_5mb\
│           └── wafer_palette_5mb.png
├── positions\          # Chip 좌표 정보 (POSITIONS_ROOT - 자동 생성)
│   └── wm-811k\
│       └── palette_5mb\
│           └── wafer_palette_5mb_positions.json
├── chip_annotations\   # 사용자 마킹 정보 (CHIP_ANNOTATIONS_ROOT)
│   └── wm-811k\
│       └── palette_5mb\
│           └── wafer_palette_5mb_chips.json
└── chip_images\        # 추출된 칩 이미지 (CHIP_IMAGES_ROOT - YOLO 학습용)
    └── defect_class\
        ├── wafer_chip_10_20.png
        └── wafer_chip_10_20.png.json
```

## 🔧 사전 준비

### 1. Positions JSON 생성

웨이퍼 이미지에 대해 칩 좌표 정보를 생성해야 합니다:

```bash
cd D:\project\mapviewer
python scripts/generate_positions_from_image.py D:/project/data/wm-811k/palette_5mb/wafer_palette_5mb.png
```

출력 예시:
```
이미지 크기: 7788x7788
추정 그리드: 324x324
감지된 칩 개수: 66993

✅ Positions JSON 생성 완료: D:\project\positions\wm-811k\palette_5mb\wafer_palette_5mb_positions.json
   - 총 66993개 칩
   - 그리드 크기: 324x324
   - 이미지 크기: 7788x7788
```

### 2. 환경 변수 설정 (선택 사항)

**기본 경로 (자동 설정됨):**
- **Windows:** `D:/project/positions`, `D:/project/chip_annotations`, `D:/project/chip_images`
- **Ubuntu:** `/appdata/appuser/positions`, `/appdata/appuser/chip_annotations`, `/appdata/appuser/chip_images`

기본값을 변경하려면 환경 변수를 설정하세요:

```bash
# Windows (선택 사항 - 기본값이 이미 설정되어 있음)
set POSITIONS_ROOT=D:/project/positions
set CHIP_ANNOTATIONS_ROOT=D:/project/chip_annotations
set CHIP_IMAGES_ROOT=D:/project/chip_images

# Ubuntu
export POSITIONS_ROOT=/appdata/appuser/positions
export CHIP_ANNOTATIONS_ROOT=/appdata/appuser/chip_annotations
export CHIP_IMAGES_ROOT=/appdata/appuser/chip_images
```

## 🎮 사용 방법

### 1. 이미지 로드

1. L3 Tracker 웹 페이지 열기: `https://localhost:8443`
2. 왼쪽 파일 탐색기에서 웨이퍼 이미지 선택
3. 이미지가 뷰어에 표시됨

### 2. Chip Annotation 모드 활성화

**방법 1: 버튼 클릭**
- 우측 상단 `Chip Mode` 버튼 클릭

**방법 2: 키보드 단축키**
- `C` 키 누르기

### 3. Die Grid 표시

Chip Mode 활성화 후:

**방법 1: 버튼 클릭**
- 우측 상단 `Grid` 버튼 클릭

**방법 2: 키보드 단축키**
- `G` 키 누르기

### 4. Chip 선택

**단일 선택**
- 마우스로 칩 클릭

**다중 선택**
- `Ctrl` 키를 누른 채로 여러 칩 클릭

**영역 선택**
- 마우스 드래그로 영역 선택 (사각형 내 모든 칩 선택)

**좌표 확인**
- 마우스를 칩 위에 올리면 `Chip (x, y)` 툴팁 표시

### 5. Class/Label 할당 (개발 중)

선택한 칩에 분류를 할당하려면:

```javascript
// 브라우저 콘솔에서 실행
viewer.chipAnnotator.markSelectedChips('defect_class', 'scratch');
```

### 6. Annotations 저장

**방법 1: 버튼 클릭**
- 우측 상단 `Save` 버튼 클릭

**방법 2: 키보드 단축키**
- `Ctrl + S` (또는 Mac에서 `Cmd + S`)

**저장 위치 (Windows):** `D:\project\chip_annotations\wm-811k\palette_5mb\wafer_palette_5mb_chips.json`
**저장 위치 (Ubuntu):** `/appdata/appuser/chip_annotations/wm-811k/palette_5mb/wafer_palette_5mb_chips.json`

### 7. Chip 이미지 추출 (YOLO 학습용)

```javascript
// 브라우저 콘솔에서 실행
await viewer.chipAnnotator.exportToYOLO('defect_dataset');
```

**추출된 이미지 위치 (Windows):** `D:\project\chip_images\defect_dataset\`
**추출된 이미지 위치 (Ubuntu):** `/appdata/appuser/chip_images/defect_dataset/`

## ⌨️ 키보드 단축키

| 키 | 기능 |
|---|---|
| `C` | Chip Mode 토글 |
| `G` | Die Grid 표시/숨김 (Chip Mode 활성화 시) |
| `Ctrl + S` | Chip Annotations 저장 (Chip Mode 활성화 시) |

## 📊 데이터 구조

### Positions JSON (`*_positions.json`)

```json
{
  "image_path": "D:/project/data/wm-811k/palette_5mb/wafer_palette_5mb.png",
  "root": "WAFER",
  "step": "DEMO",
  "wafer": "001",
  "coord": {
    "rot_code": 5,
    "tiles_w_rot": 324,
    "tiles_h_rot": 324,
    "grid_edges": {
      "xs": [0, 24, 48, ...],
      "ys": [0, 24, 48, ...]
    },
    "canvas": {
      "width": 7788,
      "height": 7788
    }
  },
  "chips": [
    {
      "x_abs": -162,
      "y_abs": -162,
      "b": "B000",
      "rect": {
        "x0": 1000,
        "y0": 1600,
        "x1": 1024,
        "y1": 1624
      }
    }
  ]
}
```

### Chip Annotations JSON (`*_chips.json`)

```json
{
  "marked_chips": [
    {
      "x_abs": 10,
      "y_abs": 20,
      "class": "defect_class",
      "label": "scratch",
      "bbox": {
        "x0": 2400,
        "y0": 4800,
        "x1": 2424,
        "y1": 4824
      },
      "marked_at": "2025-01-15T10:30:00.000Z",
      "marked_by": "ho.choi"
    }
  ],
  "metadata": {
    "status": "active",
    "total_marked_chips": 15,
    "created_at": "2025-01-15T10:00:00.000Z",
    "created_by": "ho.choi",
    "updated_at": "2025-01-15T10:30:00.000Z",
    "updated_by": "ho.choi",
    "class_distribution": {
      "defect_class": 15
    }
  }
}
```

## 🔌 API 엔드포인트

### GET `/api/chip-positions`

Positions JSON 로드

**Parameters:**
- `path` (string): 이미지 경로

**Response:**
```json
{
  "chips": [...],
  "coord": {...}
}
```

### GET `/api/chip-annotations`

Chip Annotations 로드

**Parameters:**
- `path` (string): 이미지 경로

**Response:**
```json
{
  "marked_chips": [...],
  "metadata": {...}
}
```

### POST `/api/chip-annotations`

Chip Annotations 저장

**Request Body:**
```json
{
  "image_path": "wm-811k/palette_5mb/wafer_palette_5mb.png",
  "marked_chips": [...]
}
```

### POST `/api/chip-images/extract`

Chip 이미지 추출

**Request Body:**
```json
{
  "image_path": "wm-811k/palette_5mb/wafer_palette_5mb.png",
  "chips": [...],
  "class_name": "defect_class",
  "create_label": true
}
```

## 🐛 문제 해결

### Positions JSON을 찾을 수 없다는 오류

**원인:** 이미지에 대한 positions JSON이 생성되지 않음

**해결책:**
```bash
python scripts/generate_positions_from_image.py <이미지_경로>
```

### Chip Mode 활성화가 안됨

**원인:** JavaScript 에러 또는 초기화 실패

**해결책:**
1. 브라우저 개발자 도구 열기 (F12)
2. Console 탭에서 에러 메시지 확인
3. 페이지 새로고침 (F5)

### Grid가 표시되지 않음

**원인:** Positions JSON이 로드되지 않음

**해결책:**
1. Chip Mode를 껐다가 다시 켜기
2. 브라우저 콘솔에서 `viewer.chipAnnotator.positionsData` 확인

## 📚 추가 정보

- **설계 문서**: `CHIP_ANNOTATION_SYSTEM_DESIGN.md`
- **구현 파일**:
  - Backend: `api/main.py` (line 4807-5030)
  - Frontend: `js/chip-annotator.js`
  - Config: `api/config.py` (line 42-46)
  - Script: `scripts/generate_positions_from_image.py`

## 🎯 향후 개발 계획

- [ ] UI에서 직접 Class/Label 할당 기능
- [ ] Chip 이미지 미리보기
- [ ] Annotation 히스토리 추적
- [ ] 다중 사용자 협업 기능
- [ ] YOLO 포맷 자동 변환
- [ ] Annotation 통계 대시보드
