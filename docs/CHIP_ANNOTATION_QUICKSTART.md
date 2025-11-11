# Chip Annotation Quickstart

이 문서는 `wafer_palette_5mb.png` 샘플을 기반으로 칩 좌표/라벨링/크롭 흐름을 빠르게 체험하는 방법을 설명합니다.

## 1. 샘플 데이터 생성

```powershell
cd D:\project\mapviewer
python scripts/generate_demo_wafer.py
```

생성 결과
- 이미지: `wafer/images/LINE1/PALETTE/20250108/wafer_palette_5mb.png`
- positions JSON: `D:\project\data\position\LINE1\PALETTE\20250108\wafer_palette_5mb.json`
- chip annotations JSON: `D:\project\data\position\LINE1\PALETTE\20250108\wafer_palette_5mb_chips.json`

## 2. 서버 환경 변수

```powershell
$env:PROJECT_ROOT="D:\project\mapviewer\wafer\images"
$env:PROJECT_DATA_ROOT="D:\project\data"
python -m api.main
```

`PROJECT_DATA_ROOT`를 지정하면 positions/annotations는 `D:\project\data\position`, 칩 크롭 이미지는 `D:\project\data\chip_images`에 저장됩니다.

## 3. 칩 오버레이 사용법

1. 웹앱에서 `LINE1/PALETTE/20250108/wafer_palette_5mb.png`를 **더블클릭**해 단일 이미지 모드로 진입
2. 오른쪽 **Chip Annotation** 카드에서 상태와 클래스 분포 확인
3. 조작 방법
   - 단일 선택: 클릭
   - 선택 토글: `Ctrl`+클릭 (macOS는 `⌘`)
   - 추가 선택: `Shift`+클릭
   - 박스 선택: `Ctrl` 또는 `Shift`를 누른 채 드래그
   - 라벨 제거: `Alt`+클릭
   - Fail List에서 클래스를 선택한 뒤 **Apply Selected Class** 버튼 또는 단일 클릭으로 라벨 부여
4. “Save Labels” 버튼으로 `/api/chip-annotations`에 저장하면 새로고침 후에도 칩 라벨이 복원됩니다.
5. “Save Chip Images” 버튼을 누르면 선택된 칩(없으면 라벨된 칩 전부)을 잘라 `D:\project\data\chip_images\<line>\<process>\<day>\<wafer>\<class>\chip_xxxx.png`로 저장하고 미리보기가 즉시 표시됩니다.

## 4. 스크립트로 칩 크롭 내보내기

여러 이미지를 일괄 처리하려면 스크립트를 사용할 수 있습니다.

```powershell
python scripts/export_chip_crops.py `
  --image LINE1/PALETTE/20250108/wafer_palette_5mb.png `
  --include-unlabeled `
  --limit 64
```

`manifest.json`에는 저장된 PNG 경로가 담기므로 외부 학습 파이프라인에서 그대로 활용할 수 있습니다.
