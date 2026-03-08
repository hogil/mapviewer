# Chip Annotation System

Chip Annotation은 wafer 이미지 위에 chip overlay를 띄우고, 선택한 chip의 라벨을 저장하거나 chip crop 이미지를 내보내는 기능입니다. 현재 구현 정본은 `api/main.py`와 `js/chip-annotator.js`입니다.

관련 문서:

- 공통 이미지/좌표 계약: `docs/IMAGE_PIPELINE.md`

## 현재 구성

Chip Annotation은 별도 좌표 생성기를 저장소 안에 두고 있지 않습니다. 현재 저장소는 이미 존재하는 `positions.json`을 읽어 overlay와 저장 기능을 제공합니다.

핵심 파일:

- `api/main.py`
- `api/config.py`
- `js/chip-annotator.js`
- `js/main.js`

## positions 의존성

Chip Annotation은 입력 이미지에 대응하는 `positions.json`이 있어야 정상 동작합니다.

실제로 사용하는 필드:

- `coord.grid_edges`
- `chips[].rect`
- `chips[].x_abs`
- `chips[].y_abs`
- `chips[].x_cal`
- `chips[].y_cal`
- `chips[].b`

메타데이터 표시에는 `partid`, `device`, `pgm`이 사용될 수 있습니다.

## 현재 annotation 저장 구조

과거 설계 문서의 복잡한 단일 payload 구조가 아니라, 현재 구현은 versioned multi-entry JSON 구조를 사용합니다.

개념적으로는 아래와 같습니다.

```json
{
  "_version": 2,
  "folder_key_a": {
    "marked_chips": [
      {
        "x_abs": 10,
        "y_abs": 20,
        "class_name": "defect"
      }
    ],
    "metadata": {
      "status": "draft",
      "total_marked_chips": 1,
      "created_at": "2026-03-08T10:00:00",
      "updated_at": "2026-03-08T10:10:00",
      "created_by": "user1",
      "updated_by": "user1",
      "class_distribution": {
        "defect": 1
      }
    }
  }
}
```

중요한 점:

- annotation 파일은 folder scope별 엔트리를 담을 수 있음
- 핵심 데이터는 `marked_chips`와 `metadata`
- 문서에서 `history`, `comments`, `bbox_normalized`, YOLO 전용 필드를 현재 구현처럼 설명하면 맞지 않음

## 저장 위치

현재 구현은 설정 이름보다 helper 동작이 더 중요합니다.

- annotation 저장: 현재 folder context 기준 `chip_annotations/.../<image>_chips.json`
- chip 분류 이미지 저장: `classification_chips/<class>/...`
- chip crop 추출: `chip_images/<class>/...`

즉 annotation 저장은 단순 전역 `CHIP_ANNOTATIONS_ROOT` 한 곳만의 문제로 설명하면 부정확할 수 있습니다.

## 현재 API

좌표/annotation:

- `GET /api/chip-positions`
- `GET /api/chip-annotations`
- `POST /api/chip-annotations`

chip 분류/추출:

- `POST /api/classify/chips`
- `GET /api/classify/chips/{wafer_name}`
- `POST /api/chip-images/extract`

## API 의미

### `GET /api/chip-positions`

이미지에 대응하는 `positions.json`을 찾아 반환합니다.

### `GET /api/chip-annotations`

현재 이미지/폴더 컨텍스트에 대한 chip annotation을 읽습니다.

### `POST /api/chip-annotations`

선택 chip의 annotation 상태를 저장합니다.

### `POST /api/classify/chips`

단순 annotation 저장만 하는 API가 아닙니다.

- `classification_chips/<class>/`에 chip crop PNG 저장
- annotation도 함께 upsert

### `POST /api/chip-images/extract`

선택된 chip 또는 전달된 chip 목록을 crop PNG로 저장합니다. 현재 구현 기준으로는 YOLO export가 아니라 chip crop 추출 API입니다.

## 현재 UI 동작

`js/chip-annotator.js`는 positions 기반 overlay를 직접 사용합니다.

- chip hover/선택
- 좌표 표시
- class assignment
- 저장 후 복원

과거 문서의 `Chip Mode`, `C` 키, `G` 키 같은 설명은 현재 코드 기준으로 최신 보장이 약합니다. 현재 문서는 실제 API와 저장 구조를 기준으로 유지합니다.

## 현재 저장소에 없는 것

다음 항목은 현재 저장소 구현 기준으로 사용법 문서에서 제거해야 합니다.

- `docs/CHIP_ANNOTATION_QUICKSTART.md`
- `scripts/generate_positions_from_image.py`
- `scripts/generate_demo_wafer.py`
- `scripts/export_chip_crops.py`
- `POST /api/export-yolo-dataset`

이 항목들은 현재 저장소에서 구현/제공되지 않거나 문서 기준에서 제거된 상태입니다.

## 문제 확인 포인트

### overlay가 보이지 않을 때

- `positions.json`이 실제로 존재하는지 확인
- `/api/chip-positions?path=...` 응답이 비어 있지 않은지 확인
- 브라우저 콘솔에서 chip annotator 초기화 오류가 없는지 확인

### 저장이 안 될 때

- `POST /api/chip-annotations` 응답 확인
- 현재 folder context가 기대한 위치인지 확인
- annotation JSON이 versioned 구조로 저장되는지 확인

