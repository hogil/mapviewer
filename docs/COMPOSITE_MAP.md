# Composite Map

## 개요

여러 웨이퍼 맵을 선택하여 인덱스(0~7)별 출현 빈도를 히트맵으로 시각화하는 기능.
각 픽셀 위치에서 N개 이미지의 인덱스 분포를 집계해 8개의 히트맵을 생성한다.

---

## 아키텍처

### 처리 흐름
```
N개 이미지 선택
  → 픽셀값 // 32 로 인덱스(0~7) 변환
  → 좌표별 인덱스 카운트 누적
  → Sum Map (중앙값) + Grade Count 히트맵 생성
  → NPZ 캐시 저장 (recolor용)
```

### 핵심 파일
- `api/composite_map.py` – 생성 로직 (Full/Subset)
- `api/composite_colors.py` – 색상 스킴 관리
- `logs/color-legends.json` – 커스텀 컬러 설정

### 출력 구조
```
IMAGES_ROOT/
└── composite_map/
    └── {login_id}/{timestamp}/
        ├── index_0.png ~ index_7.png   (히트맵)
        └── data.npz                     (recolor 캐시)
```

---

## Full vs Subset Composite Map

| 항목 | Full | Subset |
|------|------|--------|
| 대상 인덱스 | 0~7 전체 | 선택된 인덱스만 |
| 비선택 인덱스 | 포함 | grade 0으로 이동 (0² = 0) |
| 값 범위 | 상대적으로 큼 | 좁음 (색상이 연하게 보임 – 정상) |
| calc_mask | 공유 | 별도 재계산 필요 (`only_low_mask=None`) |

**주의**: Subset은 Full의 `calc_mask` 재사용 금지 – 반드시 `grade_counts`에서 재계산.

---

## 성능 비교 (7788×7788 이미지 10개 기준)

| 방식 | 처리 시간 | 메모리 | 특징 |
|------|----------|--------|------|
| 기존 방식 | 10.49초 | 2,545 MB | `all_indices_list` 전체 보관 + np.median |
| **비트마스크** | **3.02초** | **173 MB** | presence_map + LUT, 3.48배 빠름, 93.2% 절감 |
| 하이브리드 | 8.82초 | 2,024 MB | presence_map + counts 배열, 카운트 기반 히트맵 가능 |

### 방식 선택 기준
- **Sum Map만 필요**: 비트마스크 (LUT 기반 O(1))
- **히트맵 그라데이션 필요**: 하이브리드 (counts 배열 유지)

### 비트마스크 원리
```python
# 각 픽셀에서 인덱스 0~7의 presence를 8비트로 인코딩
presence_map |= (1 << pixel_indices)  # 비트 OR 누적

# LUT: 256패턴 사전계산 → O(1) 중앙값
sum_map = lut[presence_map]
```

---

## 추가 최적화

| 최적화 | 효과 | 적용 여부 |
|--------|------|-----------|
| 배열 C-contiguous 보장 | 5-10% | ✅ 적용 |
| pyvips 로딩 | 50% 로딩 개선 | ✅ 적용 |
| 병렬 저장 (ThreadPoolExecutor) | 50% 저장 개선 | ✅ 적용 |
| PNG compress_level=0 | 10-15% 추가 | 조건부 |
| OpenCV PNG 저장 | 4배 빠름, 팔레트 모드 포기 | 미적용 |
| Numba JIT | 2-5배, 컴파일 오버헤드 | 미적용 |

---

## 색상 스킴

- 11포인트 그라데이션: Blue(0%) → Cyan → Green → Yellow → Orange → Red(100%)
- Min-Max 스케일링 후 백분율 매핑
- `logs/color-legends.json`에 커스텀 설정 저장
- Recolor: NPZ 캐시 활용으로 이미지 재계산 없이 색상만 변경
