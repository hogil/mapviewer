# Fail-Bit Dual Pipeline

이 문서는 fail-bit 외부 파이프라인 계약과 로컬 dummy 데이터셋의 역할 분리를 설명하는 메모입니다.

정본 문서 구분:

- 공통 팔레트 인덱스, `positions.json`, 이미지 응답 계약: `docs/IMAGE_PIPELINE.md`
- 로컬 `palette_5mb` / `palette_3k` 재생성 절차와 seed 규칙: `docs/LOCAL_FAILBIT_DATASET_SPEC.md`

## 현재 저장소 범위

현재 저장소에는 로컬 fail-bit dataset 재생성 스크립트가 포함되어 있습니다.

- 스크립트: `scripts/refresh_failbit_local_maps.py`

하지만 이 문서의 주목적은 여전히 "외부 파이프라인 계약 설명"입니다. 로컬 데이터셋을 실제로 만드는 상세 절차는 `docs/LOCAL_FAILBIT_DATASET_SPEC.md`를 따릅니다.

## 핵심 원칙

- fail-bit PNG는 대응하는 `positions.json`을 함께 제공해야 합니다.
- 앱이 읽는 이미지/좌표 계약은 공통 규격 하나로 유지합니다.
- 파일명의 `-00P_`, `-00C_`는 입력 파일을 필터링하거나 묶을 때 사용하는 힌트입니다.
- 그 이후 렌더링/좌표/오버레이 계약은 공통 규격을 따릅니다.

## 파일명 필터

프로덕션 스타일 파이프라인에서는 파일명 중간 토큰으로 입력 대상을 나눌 수 있습니다.

- `-00P_`
- `-00C_`

이 구분은 파일 탐색과 그룹핑의 힌트로만 설명합니다. 문서에서 "00P 이미지", "00C 이미지"를 완전히 다른 이미지 규격처럼 설명하지 않습니다.

## BIN 코드 세트

파일명 필터 결과에 따라 주로 사용하는 BIN 집합은 아래와 같습니다.

### `-00P_`

- `285`
- `286`
- `287`
- `288`
- `290`
- `291`

### `-00C_`

- `300`
- `385`
- `386`
- `388`
- `389`
- `390`

공통 border 인덱스:

- `Normal` = palette index `10`
- `Invalid` = palette index `11`

## 메타데이터

fail-bit 데이터셋은 필요 시 아래 식별용 메타데이터를 가질 수 있습니다.

- `partid`
- `device`
- `pgm`

이 값들은 데이터셋 식별과 UI 표시, 일부 후속 로직에 쓰일 수 있지만, 문서 기준으로 파일명 필터 이후의 독립 이미지 규격을 정의하는 핵심 축은 아닙니다.

## 외부 파이프라인 메모

외부 생성기는 최소한 아래 계약을 만족해야 합니다.

- palette 인덱스는 앱과 호환되어야 함
- 이미지와 대응하는 `positions.json`이 있어야 함
- `coord.grid_edges`, `chips[].rect`, `x_abs/y_abs/x_cal/y_cal`, `b`를 제공해야 함

자세한 스키마는 `docs/IMAGE_PIPELINE.md`를 따릅니다.

## 현재 로컬 더미 데이터 규칙

사내 로컬 PC에서 유지하는 샘플 데이터셋은 아래 경로를 기준으로 사용합니다.

- `D:/project/data/wm-811k/palette_5mb`
- `D:/project/data/wm-811k/palette_3k`
- `D:/project/data/positions/palette_5mb`
- `D:/project/data/positions/palette_3k`

현재 로컬 규칙 요약:

- `Grade1..Grade7` chip interior는 그대로 두지 않고, interior 픽셀의 약 95%만 원래 grade로 유지합니다.
- 나머지 약 5% interior 픽셀은 deterministic random으로 `Grade0` 치환합니다.
- chip border는 유지하고, interior만 바꿉니다.
- wafer를 둥글게 보이게 하려고 chip 바깥에 남아 있던 dummy 영역은 전부 배경으로 정리합니다.
- 즉 chip rectangle 밖 픽셀은 최종적으로 background index `8`만 남아야 합니다.

`palette_3k`는 의도적으로 synthetic dataset일 수 있으므로, 현재 로컬 기본 규칙에서는 `palette_5mb/wafer_palette_5mb.png` 1장을 전체 PNG 3000장으로 복제하는 방식도 사용합니다.

세부 수치와 seed 공식은 `docs/LOCAL_FAILBIT_DATASET_SPEC.md`를 그대로 따릅니다.

## 보안 메모

프로덕션 파이프라인의 S3 자격 증명이나 환경별 실제 경로는 저장소 문서에 직접 적지 않고, 환경 변수나 외부 비밀 저장소로 분리합니다.
