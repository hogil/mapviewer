# 피라미드 썸네일 생성 워크플로우

## 개요
피라미드 썸네일은 여러 해상도 레벨(0.2, 0.5, 0.7, 1.0)로 이미지를 미리 생성하여 줌 레벨에 따라 적절한 해상도를 제공합니다.

---

## 1. 클라이언트 측 (Frontend) - `js/main.js`

### 1.1 이미지 로드 요청

```javascript
// loadImage() 또는 loadPyramidLevel() 호출 시
const personalizedParams = this.getPersonalizedParams();
// 예: "&personalized=true&scheme=change" 또는 ""

const url = `/api/image?path=${encodeURIComponent(imagePath)}&level=${level}${personalizedParams}`;
```

**개인색 설정 활성화 시:**
- `personalized=true&scheme={scheme}` 파라미터 포함
- 예: `&personalized=true&scheme=change&_t=1234567890` (캐시 버스팅 포함)

**개인색 설정 비활성화 시:**
- 파라미터 없음 (빈 문자열)

---

## 2. 서버 측 (Backend) - `api/main.py`

### 2.1 엔드포인트 진입: `get_image()`

```python
@app.get("/api/image")
async def get_image(
    request: Request,
    path: str,
    level: Optional[float] = None,
    personalized: bool = False,
    scheme: Optional[str] = None
)
```

**파라미터:**
- `path`: 이미지 파일 경로
- `level`: 피라미드 레벨 (0.2, 0.5, 0.7, 1.0)
- `personalized`: 개인색 설정 활성화 여부
- `scheme`: 색상 스킴 이름 (예: "change")

---

### 2.2 피라미드 경로 결정

**개인색 설정 활성화:**
```python
pyramid_dir = config.THUMBNAIL_DIR / f"pyramid_{scheme}_{int(level*100)}"
# 예: pyramid_change_100, pyramid_change_70, pyramid_change_50, pyramid_change_20
```

**개인색 설정 비활성화:**
```python
pyramid_dir = config.THUMBNAIL_DIR / f"pyramid_{int(level*100)}"
# 예: pyramid_100, pyramid_70, pyramid_50, pyramid_20
```

**파일 경로:**
```python
pyramid_path = pyramid_dir / f"{stem}_L{int(level*100)}.{format_ext}"
# 예: wafer001_L100.webp
```

---

### 2.3 캐시 확인

**개인색 설정 활성화:**
- ✅ `pyramid_{scheme}_{level}` 경로의 파일만 확인
- ❌ `pyramid_{level}` 경로의 파일은 무시 (비개인색 캐시)

**개인색 설정 비활성화:**
- ✅ `pyramid_{level}` 경로의 파일만 확인
- ❌ `pyramid_{scheme}_{level}` 경로의 파일은 무시 (개인색 캐시)

**캐시 히트 조건:**
- 파일이 존재하고 크기가 0보다 큼
- 파일 수정 시간이 원본 이미지보다 최신

---

### 2.4 피라미드 생성: `_generate_pyramid_sync()`

#### 📌 **케이스 A: 개인색 설정 활성화**

**A-1. 레벨 1.0 생성 시:**
```
1. 원본 PNG 이미지 로드 (PIL)
2. 팔레트 모드(P) 변환 (필요시)
3. 색상 스킴 데이터 로드
4. 팔레트 교체 (swap_first16_colors)
5. RGB 변환 후 numpy 배열로 변환
6. pyvips Image로 변환
7. 원본 크기 유지 (리사이즈 없음)
8. 저장: pyramid_{scheme}_100/wafer001_L100.webp
```

**A-2. 다른 레벨 생성 시 (0.7, 0.5, 0.2):**
```
1. 레벨 1.0 파일 확인: pyramid_{scheme}_100/wafer001_L100.webp
2. 레벨 1.0 파일이 있으면:
   - 레벨 1.0 파일 로드 (pyvips)
   - 레벨에 맞게 리사이즈 (예: 0.7 = 70% 크기)
   - 저장: pyramid_{scheme}_70/wafer001_L70.webp
3. 레벨 1.0 파일이 없으면:
   - 원본 이미지 로드 (pyvips)
   - 레벨에 맞게 리사이즈
   - 저장: pyramid_{scheme}_70/wafer001_L70.webp
```

#### 📌 **케이스 B: 개인색 설정 비활성화**

**모든 레벨:**
```
1. 원본 이미지 로드 (pyvips)
2. 레벨에 맞게 리사이즈
   - level < 1.0: shrink + resize 또는 resize만
   - level == 1.0: 원본 크기 유지
3. 저장: pyramid_{level}/wafer001_L{level}.webp
```

---

### 2.5 Background 처리: `_generate_other_levels_background()`

**요청된 레벨 생성 후:**
```python
# 현재 레벨 제외, 1.0 제외한 나머지 레벨들을 백그라운드에서 생성
other_levels = [0.7, 0.5, 0.2]  # 예: 현재 레벨이 1.0인 경우

# 파이프라인 실행 (원본 이미지 한 번만 읽고 여러 레벨 생성)
_generate_pyramid_pipeline(
    image_path,
    other_levels,
    stem,
    format_ext,
    personalized,  # 개인색 설정도 전달
    scheme         # 스킴도 전달
)
```

**개인색 설정 활성화 시:**
- 원본 이미지에 개인색 팔레트 적용
- 적용된 이미지를 기반으로 다른 레벨 생성

**개인색 설정 비활성화 시:**
- 원본 이미지를 그대로 사용하여 다른 레벨 생성

---

## 3. 전체 워크플로우 비교

### 📊 **개인색 설정 활성화 시**

```
사용자 이미지 선택
    ↓
[클라이언트] personalized=true&scheme=change 파라미터 추가
    ↓
[서버] get_image() 엔드포인트
    ↓
레벨 1.0 요청?
    ├─ YES → 원본 PNG 로드 → 팔레트 교체 → 저장 (pyramid_change_100/)
    └─ NO  → 레벨 1.0 파일 확인
             ├─ 존재 → 레벨 1.0 파일 로드 → 리사이즈 → 저장
             └─ 없음 → 원본 로드 → 리사이즈 → 저장
    ↓
백그라운드에서 다른 레벨 생성
    ├─ 원본 이미지에 개인색 적용
    └─ 적용된 이미지로 다른 레벨 생성
```

### 📊 **개인색 설정 비활성화 시**

```
사용자 이미지 선택
    ↓
[클라이언트] 파라미터 없음
    ↓
[서버] get_image() 엔드포인트
    ↓
요청된 레벨 확인
    ├─ 레벨 1.0 → 원본 로드 → 저장 (pyramid_100/)
    └─ 다른 레벨 → 원본 로드 → 리사이즈 → 저장
    ↓
백그라운드에서 다른 레벨 생성
    └─ 원본 이미지 그대로 사용하여 다른 레벨 생성
```

---

## 4. 주요 차이점 요약

| 항목 | 개인색 활성화 | 개인색 비활성화 |
|------|---------------|----------------|
| **디렉토리 경로** | `pyramid_{scheme}_{level}` | `pyramid_{level}` |
| **레벨 1.0 생성** | 원본 PNG → 팔레트 교체 → 저장 | 원본 → 저장 |
| **다른 레벨 생성** | 레벨 1.0 파일 기반 리사이즈 | 원본 기반 리사이즈 |
| **캐시 분리** | 완전 분리 (서로 다른 경로) | 기본 경로만 사용 |
| **Background 처리** | 개인색 적용된 이미지 사용 | 원본 이미지 사용 |

---

## 5. 최적화 포인트

1. **레벨 1.0 우선 생성**: 개인색이 적용된 레벨 1.0을 먼저 생성하면, 다른 레벨은 단순 리사이즈만 하면 됨
2. **캐시 분리**: 개인색/비개인색 캐시를 완전히 분리하여 혼선 방지
3. **Background 처리**: 사용자 대기 없이 다른 레벨 생성
4. **파이프라인**: 원본 이미지를 한 번만 읽고 여러 레벨 생성 (메모리 효율)

---

## 6. 문제 해결

### 레벨 1.0만 색상 적용되고 나머지는 적용 안됨
**원인**: 다른 레벨 생성 시 원본 이미지를 사용했음
**해결**: 레벨 1.0 파일을 기반으로 다른 레벨 생성하도록 수정

### 일부 레벨만 색상 적용됨
**원인**: 캐시 키에 개인색 설정 정보가 포함되지 않음
**해결**: 캐시 키에 `{level}_{personalized}_{scheme}` 형식 사용





