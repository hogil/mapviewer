# Fail-Bit Dual Pipeline

외부 fail-bit 파이프라인과 앱 간의 데이터 계약을 설명하는 문서입니다.

공통 팔레트 인덱스, `positions.json`, 이미지 응답 계약은 `docs/IMAGE_PIPELINE.md`를 참조합니다.

## 핵심 원칙

- fail-bit PNG는 대응하는 `positions.json`을 함께 제공해야 합니다.
- 앱이 읽는 이미지/좌표 계약은 공통 규격 하나로 유지합니다.
- 파일명의 `-00P_`, `-00C_`는 입력 파일을 필터링하거나 묶을 때 사용하는 힌트입니다.
- 렌더링/좌표/오버레이 계약은 공통 규격을 따릅니다.

## 파일명 필터

프로덕션 파이프라인에서는 파일명 중간 토큰으로 입력 대상을 나눕니다.

- `-00P_` → BIN: `285`, `286`, `287`, `288`, `290`, `291`
- `-00C_` → BIN: `300`, `385`, `386`, `388`, `389`, `390`

공통 border 인덱스:

- `Normal` = palette index `10`
- `Invalid` = palette index `11`

## 외부 파이프라인 계약

외부 생성기는 최소한 아래를 만족해야 합니다.

- palette 인덱스가 앱과 호환 (`docs/IMAGE_PIPELINE.md` 참조)
- 이미지와 대응하는 `positions.json` 제공
- `coord.grid_edges`, `chips[].rect`, `x_abs/y_abs/x_cal/y_cal`, `b` 필드 포함
- 식별용 메타데이터: `partid`, `device`, `pgm` (선택)

## 보안 메모

프로덕션 파이프라인의 S3 자격 증명이나 환경별 실제 경로는 저장소 문서에 직접 적지 않고, 환경 변수나 외부 비밀 저장소로 분리합니다.
