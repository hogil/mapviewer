# 파일 인덱스 & 검색

## 파일 인덱스 자동 재빌드

서버 시작 시 1회 인덱스 구축 후, `INDEX_REFRESH_INTERVAL_MINUTES`(기본 30분) 주기로 자동 재빌드.

### 설정
- `INDEX_REFRESH_INTERVAL_MINUTES=0` → 자동 재빌드 비활성화
- `start.ps1` / `start.sh`에 기본값 30 설정

### 동작
- 사용자 요청 중이면 대기, 재빌드 진행 중이면 건너뜀
- 서버 종료 시 백그라운드 작업 안전하게 취소
- 로그: `🔁 [INDEX] 자동 재빌드 시작` / `🛑 [INDEX] 자동 재빌드 루프 종료`

### 테스트
```bash
INDEX_REFRESH_INTERVAL_MINUTES=1 python -m api.main
# 파일 추가 후 1~2분 뒤 /api/files/all 에서 확인
```

---

## 다중 LOT 검색

엑셀/텍스트에서 복사한 대량 LOT 번호를 한 번에 검색하는 기능.

### 파일명 규칙
```
{LOT}_{제품명}_{버전}.png
→ LOT = 파일명의 첫 번째 '_' 이전 부분
```

### 아키텍처
- 백엔드 인덱스에 `by_lot` 딕셔너리 추가 (`dict[str, list[str]]`)
- LOT 기준 O(1) lookup
- 기존 OR 검색 대비 62.5배 빠름 (40ms vs 2500ms)

### UI
- "다중검색" 버튼 → 모달에서 LOT 목록 줄바꿈 입력
- 자동 중복 제거, 각 LOT별 결과 수 표시
- 결과를 그리드에 표시 (기존 검색 결과와 동일한 흐름)

### 처리 로직
```python
# 서버 측
lots = [l.strip() for l in body.splitlines() if l.strip()]
lots = list(dict.fromkeys(lots))  # 중복 제거 (순서 유지)
result = []
for lot in lots:
    result.extend(index.by_lot.get(lot, []))
```
