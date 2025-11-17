# Chip Annotation System 통합 문서

> L3 Tracker 웨이퍼 맵 분석 시스템의 Chip 단위 결함 마킹 및 YOLO 학습 데이터 생성 기능

**작성일:** 2025-01-08  
**대상 시스템:** L3 Tracker (Wafer Map Defect Analysis)

---

## 목차

1. [시스템 개요](#1-시스템-개요)
2. [아키텍처 및 폴더 구조](#2-아키텍처-및-폴더-구조)
3. [데이터 구조](#3-데이터-구조)
4. [API 엔드포인트](#4-api-엔드포인트)
5. [사용 방법](#5-사용-방법)
6. [문제 해결](#6-문제-해결)

---

## 1. 시스템 개요

### 1.1 배경

L3 Tracker는 반도체 웨이퍼 맵의 결함 패턴을 분석하는 시스템입니다. 현재는 웨이퍼 전체 이미지 단위로 분류를 수행하지만, 실제 제조 현장에서는 웨이퍼 내부의 **개별 Chip(Die) 단위로 결함을 분석**해야 합니다.

### 1.2 핵심 목표

1. **Chip 단위 마킹:** 사용자가 웨이퍼 이미지에서 결함 Chip 영역을 사각형으로 마킹하고 클래스 할당
2. **좌표 시스템:** 파이프라인이 자동 생성한 Chip 좌표 메타데이터 활용
3. **이력 관리:** 누가 언제 어떤 Chip을 마킹했는지 추적
4. **YOLO 학습 데이터:** 마킹된 Chip 정보를 YOLO 객체 탐지 포맷으로 자동 변환
5. **기존 시스템과의 호환:** 웨이퍼 레벨 분류 기능은 그대로 유지

---

## 2. 아키텍처 및 폴더 구조

### 2.1 경로 구조 (개선된 버전)

**단순화된 경로 구조:**

```
IMAGES_ROOT = /appdata/appuser/images
  ├── classification/           (wafer 모드)
  ├── classification_chips/     (chip 모드)
  ├── chip_annotations/        (사용자 마킹 데이터)
  ├── chip_images/              (추출된 칩 이미지)
  ├── thumbnails/
  └── yolo_datasets/            (YOLO 데이터셋)

POSITIONS_ROOT = /appdata/appuser/positions  (Chip 좌표 메타데이터)
```

**설계 원칙:**
- **Stateless API:** 서버는 전역 상태를 유지하지 않음, 모든 요청에 필요한 컨텍스트(mode)를 파라미터로 전달
- **단일 책임:** Wafer Map Explorer와 Class Manager는 독립적으로 동작
- **경로 계층 구조:** 모든 메타데이터는 IMAGES_ROOT 하위에 통합

### 2.2 데이터 흐름

```
[S3 Bucket] → [파이프라인] → [PNG 이미지] → /appdata/appuser/images/
                                    ↓
                            [Positions JSON] → /appdata/appuser/positions/
                                    ↓
                            [사용자 Chip 마킹] → /appdata/appuser/images/chip_annotations/
                                    ↓
                            [YOLO Dataset] → /appdata/appuser/images/yolo_datasets/
```

---

## 3. 데이터 구조

### 3.1 Positions JSON (파이프라인 자동 생성)

**경로:** `/appdata/appuser/positions/{p1}/{p2}/{day}/{root}_{step}_{wafer}_{stime}.json`

```json
{
  "image_path": "/appdata/appuser/images/LINE1/PROCESS_A/20250108/ROOT_STEP_WAFER_20250108_103000.png",
  "root": "ROOT",
  "step": "STEP",
  "wafer": "WAFER",
  "stime": "20250108_103000",
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
      "x_cal": -162,
      "y_cal": -162,
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

### 3.2 Chip Annotations JSON (사용자 생성)

**경로:** `/appdata/appuser/images/chip_annotations/{p1}/{p2}/{day}/{root}_{step}_{wafer}_{stime}_chips.json`

```json
{
  "image_path": "/appdata/appuser/images/LINE1/PROCESS_A/20250108/ROOT_STEP_WAFER_20250108_103000.png",
  "positions_ref": "/appdata/appuser/positions/LINE1/PROCESS_A/20250108/ROOT_STEP_WAFER_20250108_103000.json",
  "metadata": {
    "created_at": "2025-01-08T10:30:00Z",
    "created_by": "john.doe",
    "last_modified": "2025-01-08T14:20:00Z",
    "last_modified_by": "jane.smith",
    "status": "verified",
    "total_marked_chips": 15,
    "defect_chips": 12,
    "good_chips": 3
  },
  "marked_chips": [
    {
      "chip_id": "chip_001",
      "x_abs": -25,
      "y_abs": -10,
      "class": "defect_edge_loc",
      "bbox": {
        "x0": 1000,
        "y0": 1600,
        "x1": 1040,
        "y1": 1640
      },
      "bbox_normalized": {
        "center_x": 0.5125,
        "center_y": 0.410,
        "width": 0.010,
        "height": 0.010
      },
      "created_by": "john.doe",
      "created_at": "2025-01-08T10:35:00Z",
      "verified_by": "jane.smith",
      "verified_at": "2025-01-08T11:20:00Z",
      "history": [
        {
          "action": "create",
          "user": "john.doe",
          "timestamp": "2025-01-08T10:35:00Z",
          "class": "defect_edge_loc"
        }
      ],
      "comments": []
    }
  ],
  "class_distribution": {
    "defect_edge_loc": 8,
    "defect_scratch": 4,
    "good_chip": 3
  }
}
```

---

## 4. API 엔드포인트

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

Chip Annotations 로드 (없으면 빈 템플릿 반환)

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

Chip 이미지 추출 (YOLO 학습용)

**Request Body:**
```json
{
  "image_path": "wm-811k/palette_5mb/wafer_palette_5mb.png",
  "chips": [...],
  "class_name": "defect_class",
  "create_label": true
}
```

### POST `/api/export-yolo-dataset`

YOLO 데이터셋 생성

**Request Body:**
```json
{
  "filters": {
    "classes": ["defect_edge_loc", "defect_scratch"],
    "verified_only": true,
    "date_range": {
      "from": "2025-01-01",
      "to": "2025-01-31"
    }
  },
  "split_ratio": {
    "train": 0.8,
    "val": 0.2
  }
}
```

---

## 5. 사용 방법

### 5.1 사전 준비

**Positions JSON 생성:**

```bash
python scripts/generate_positions_from_image.py <이미지_경로>
```

### 5.2 기본 사용법

1. **이미지 로드**
   - L3 Tracker 웹 페이지 열기
   - 왼쪽 파일 탐색기에서 웨이퍼 이미지 선택

2. **Chip Annotation 모드 활성화**
   - 우측 상단 `Chip Mode` 버튼 클릭 또는 `C` 키

3. **Die Grid 표시**
   - 우측 상단 `Grid` 버튼 클릭 또는 `G` 키

4. **Chip 선택**
   - **단일 선택:** 마우스로 칩 클릭
   - **다중 선택:** `Ctrl` 키를 누른 채로 여러 칩 클릭
   - **영역 선택:** 마우스 드래그로 영역 선택
   - **좌표 확인:** 마우스를 칩 위에 올리면 `Chip (x, y)` 툴팁 표시

5. **Annotations 저장**
   - 우측 상단 `Save` 버튼 클릭 또는 `Ctrl + S`

### 5.3 키보드 단축키

| 키 | 기능 |
|---|---|
| `C` | Chip Mode 토글 |
| `G` | Die Grid 표시/숨김 (Chip Mode 활성화 시) |
| `Ctrl + S` | Chip Annotations 저장 (Chip Mode 활성화 시) |

### 5.4 YOLO 데이터셋 내보내기

1. "YOLO 데이터셋 내보내기" 버튼 클릭
2. 필터 설정:
   - 검증된 것만 (verified_only)
   - 특정 클래스만 선택
   - 날짜 범위 설정
3. "내보내기" 클릭
4. 생성된 데이터셋은 `/appdata/appuser/images/yolo_datasets/export_{timestamp}/`에 저장

---

## 6. 문제 해결

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

---

## 참고 자료

- **구현 파일:**
  - Backend: `api/main.py`
  - Frontend: `js/chip-annotator.js`
  - Config: `api/config.py`
  - Script: `scripts/generate_positions_from_image.py`

---

**문서 끝**

