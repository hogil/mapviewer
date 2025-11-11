 Refactoring Design Document

  목표

  Class Manager의 wafer/chip 모드 전환이 Wafer Map Explorer에 영향을 주지 않도록 구조 개선

  현재 문제점

  1. 복잡한 Root 구조

  - ROOT_MAP = {"wafer": IMAGES_ROOT, "chip": CHIPS_ROOT}
  - current_root, current_root_name 전역 변수로 서버 상태 관리
  - 모드 전환 시 _switch_root() 함수가 전역 상태 변경
  - Wafer Map Explorer가 서버 root 변경에 영향받음

  2. 외부 경로 의존

  - CHIPS_ROOT: 외부 독립 경로
  - CHIP_ANNOTATIONS_ROOT: 외부 독립 경로
  - 경로 관리 복잡도 증가

  3. API 설계 문제

  - /api/class-mode POST 엔드포인트가 서버 전역 상태 변경
  - 모든 API 엔드포인트에 folder 파라미터 전달 필요
  - 클라이언트-서버 간 상태 동기화 복잡

  개선 설계

  1. 경로 구조 단순화

  Before

  IMAGES_ROOT = /appdata/appuser/images
  CHIPS_ROOT = /appdata/appuser/chips  (외부 경로)
  POSITIONS_ROOT = /appdata/appuser/position
  CHIP_ANNOTATIONS_ROOT = /appdata/appuser/chip_annotations  (외부 경로)

  After

  IMAGES_ROOT = /appdata/appuser/images
    ├── classification/           (wafer 모드)
    ├── classification_chips/     (chip 모드)
    ├── chip_annotations/
    ├── chip_images/
    ├── thumbnails/
    └── yolo_datasets/

  POSITIONS_ROOT = /appdata/appuser/position

  → 총 2개 경로만 사용

  2. 모드 처리 방식 변경

  Before (서버 상태 기반)

  # 서버 전역 변수
  current_root = ROOT_MAP[current_root_name]

  # 모드 전환 시
  def _switch_root(mode):
      global current_root, current_root_name
      current_root_name = mode
      current_root = ROOT_MAP[mode]
      # 전체 시스템에 영향

  After (파라미터 기반)

  # 전역 변수 없음
  IMAGES_ROOT = Path("/appdata/appuser/images")

  # 모드별 경로 함수
  def _classification_dir(mode: str = "wafer") -> Path:
      if mode == "chip":
          return IMAGES_ROOT / "classification_chips"
      return IMAGES_ROOT / "classification"

  # API 호출 시 mode 파라미터로 전달
  @app.get("/api/classes")
  async def get_classes(mode: str = Query("wafer")):
      classification_dir = _classification_dir(mode)
      # ...

  3. API 변경사항

  Removed

  - POST /api/class-mode (서버 상태 변경 엔드포인트 삭제)
  - 모든 엔드포인트의 folder 파라미터 제거

  Modified

  - GET /api/classes?mode=wafer|chip
  - POST /api/classes?mode=wafer|chip
  - DELETE /api/classes/{name}?mode=wafer|chip
  - GET /api/classes/{name}/images?mode=wafer|chip
  - POST /api/classify (body에 mode 추가)
  - DELETE /api/classify (body에 mode 추가)
  - POST /api/classify/batch (body에 mode 추가)

  chip_annotations 구조 개선

  // Before: 단일 폴더 정보만 저장
  {
    "marked_chips": [...],
    "metadata": {...}
  }

  // After: current_folder를 키로 사용하여 컨텍스트 보존
  {
    "wm-811k": {
      "marked_chips": [...],
      "metadata": {...}
    },
    "another_folder": {
      "marked_chips": [...],
      "metadata": {...}
    }
  }

  4. 프론트엔드 변경

  js/main.js

  // Before: 서버 동기화
  async setClassMode(mode) {
      await this.syncServerMode(mode);  // 서버 상태 변경
      await this.changeFolder(data.current_folder);  // 폴더까지 변경됨
  }

  // After: 클라이언트 모드만 변경
  async setClassMode(mode) {
      this.classMode = mode;
      this.updateClassModeButtons();
      if (this.labelManager) {
          await this.labelManager.refreshAll();  // UI만 새로고침
      }
      // Wafer Map Explorer는 영향 없음
  }

  js/labels.js

  // Before: folder 파라미터 전달
  const apiUrl = `/api/classes?folder=${currentFolder}`;

  // After: mode 파라미터 전달
  const mode = this.viewer?.classMode || 'wafer';
  const apiUrl = `/api/classes?mode=${mode}`;

  5. 환경 변수 정리

  Before

  export IMAGES_ROOT="/appdata/appuser/images"
  export CHIPS_ROOT="/appdata/appuser/chips"
  export POSITIONS_ROOT="/appdata/appuser/position"
  export CHIP_ANNOTATIONS_ROOT="/appdata/appuser/chip_annotations"

  After

  export IMAGES_ROOT="/appdata/appuser/images"
  export POSITIONS_ROOT="/appdata/appuser/position"

  설계 원칙

  1. Stateless API

  - 서버는 전역 상태를 유지하지 않음
  - 모든 요청에 필요한 컨텍스트(mode)를 파라미터로 전달
  - 클라이언트가 상태 관리 책임

  2. 단일 책임 원칙

  - Wafer Map Explorer: 이미지 탐색 및 뷰어
  - Class Manager: 분류 관리 (mode에 따라 독립적)
  - 두 컴포넌트는 독립적으로 동작

  3. 경로 계층 구조

  - 모든 메타데이터는 IMAGES_ROOT 하위
  - SKIP_DIRS로 검색에서 제외
  - 관리 단순화

  기대 효과

  1. 독립성

  - Class Manager 모드 변경이 Wafer Map Explorer에 영향 없음
  - 각 컴포넌트 독립적으로 동작

  2. 단순성

  - 2개 경로만 관리 (IMAGES_ROOT, POSITIONS_ROOT)
  - 전역 상태 제거로 버그 감소
  - API 인터페이스 단순화

  3. 확장성

  - 새로운 모드 추가 용이
  - 경로 관리 간편
  - 테스트 용이

  4. 일관성

  - 모든 메타데이터가 동일한 구조
  - classification/ vs classification_chips/ 명확한 구분
  - 폴더 컨텍스트 보존

  마이그레이션 계획

  Phase 1: Backend 리팩토링

  1. api/config.py: 경로 구조 변경
  2. api/main.py: 전역 변수 제거, mode 파라미터 추가
  3. chip_annotations 구조 개선

  Phase 2: Frontend 리팩토링

  1. js/labels.js: mode 파라미터 추가
  2. js/main.js: 서버 동기화 제거

  Phase 3: 환경 설정

  1. start.ps1/sh: CHIPS_ROOT 제거
  2. 테스트 및 검증

  Phase 4: 데이터 마이그레이션 (필요시)

  1. 기존 CHIPS_ROOT 데이터 → IMAGES_ROOT/classification_chips 이동
  2. chip_annotations JSON 구조 변환