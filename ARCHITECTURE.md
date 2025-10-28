# L3 Tracker 시스템 아키텍처

## 목차
1. [시스템 개요](#시스템-개요)
2. [기술 스택](#기술-스택)
3. [아키텍처 다이어그램](#아키텍처-다이어그램)
4. [핵심 컴포넌트](#핵심-컴포넌트)
5. [데이터 플로우](#데이터-플로우)
6. [성능 최적화](#성능-최적화)
7. [보안 고려사항](#보안-고려사항)

## 시스템 개요

L3 Tracker는 반도체 웨이퍼맵 불량 분석을 위한 웹 기반 시스템으로, 대용량 이미지 처리와 AI 기반 패턴 분류를 지원합니다.

### 핵심 설계 원칙
- **모듈화**: 각 컴포넌트는 독립적으로 동작 가능
- **확장성**: 새로운 기능 추가가 용이한 구조
- **성능**: 대용량 이미지 처리 최적화
- **사용성**: 직관적인 UI/UX

## 기술 스택

### Frontend
- **Core**: Vanilla JavaScript (ES6+)
- **Rendering**: Canvas API, WebGL
- **Build**: No build step (순수 모듈 시스템)
- **Style**: CSS3 with CSS Variables

### Backend
- **Framework**: FastAPI + Uvicorn
- **Image Processing**: Pillow (썸네일), 내부 파일 인덱싱
- **Auth/SSO**: OneLogin python3-saml (SAML SP 최소구현)
- **Async**: asyncio, background tasks
- **Storage**: 파일 시스템 (JSON 통계/로그)

### DevOps
- **Version Control**: Git
- **Testing**: pytest, Jest
- **Documentation**: JSDoc, Sphinx

## 아키텍처 다이어그램

```
┌─────────────────────────────────────────────────────────────┐
│                        Client Browser                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐    │
│  │    UI Layer   │  │  Renderer    │  │   Cache      │    │
│  │  (index.html) │  │  (Canvas)    │  │  Manager     │    │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘    │
│         │                  │                  │             │
│  ┌──────▼──────────────────▼──────────────────▼──────┐    │
│  │            Application Layer (main.js)              │    │
│  └─────────────────────┬───────────────────────────┘    │
│                        │                                   │
└────────────────────────┼───────────────────────────────────┘
                         │ HTTP/WebSocket
┌────────────────────────┼───────────────────────────────────┐
│                        ▼                                   │
│  ┌─────────────────────────────────────────────────┐      │
│  │            Flask Application Server              │      │
│  │                  (app.py)                       │      │
│  └────┬──────────┬──────────┬──────────┬─────────┘      │
│       │          │          │          │                  │
│  ┌────▼───┐ ┌───▼────┐ ┌──▼───┐ ┌────▼────┐            │
│  │ Image  │ │Thumbnail│ │ AI   │ │ Label   │            │
│  │Handler │ │ Service │ │Engine│ │ Manager │            │
│  └────┬───┘ └────┬────┘ └──┬───┘ └────┬────┘            │
│       │          │          │          │                  │
│  ┌────▼──────────▼──────────▼──────────▼─────┐           │
│  │           File System Storage              │           │
│  │  ├── images/                              │           │
│  │  ├── thumbnails/                          │           │
│  │  ├── labels/                              │           │
│  │  └── classification/                      │           │
│  └────────────────────────────────────────────┘           │
│                      Backend Server                        │
└─────────────────────────────────────────────────────────────┘
```

## 핵심 컴포넌트

### 1. Frontend Components

#### SemiconductorRenderer
**위치**: `/js/semiconductor-renderer.js`

고성능 이미지 렌더링 엔진으로 이미지 피라미드 기술을 활용합니다.

**주요 기능**:
- 이미지 피라미드 생성 및 관리
- Lanczos3 알고리즘 다운샘플링
- 픽셀 완벽 렌더링
- GPU 가속 최적화

**클래스 구조**:
```javascript
class SemiconductorRenderer {
    constructor(canvas, options)
    async loadImage(image)
    async generateImagePyramid(image)
    render()
    fitToContainer(width, height, margin)
    getInfo()
    destroy()
}
```

#### WaferMapViewer
**위치**: `/main.js`

메인 애플리케이션 컨트롤러로 전체 UI 상태를 관리합니다.

**책임**:
- 파일 탐색기 관리
- 이미지 뷰어 제어
- 그리드/싱글 뷰 전환
- 이벤트 핸들링

#### ThumbnailManager
**위치**: `/main.js`

썸네일 캐싱 및 로딩을 담당하는 매니저입니다.

**특징**:
- LRU 캐시 구현
- 비동기 배치 로딩
- 메모리 관리
- Blob URL 관리

### 2. Backend Components

#### FastAPI Application
**위치**: `/api/main.py`

주요 엔드포인트:
```python
GET /api/files            # 폴더 탐색
GET /api/image            # 원본 이미지 제공 (ETag/Cache-Control)
GET /api/thumbnail        # 썸네일(고품질) 제공
POST /api/classify        # 이미지에 클래스(라벨) 부여
DELETE /api/classify      # 라벨 제거
GET /api/classes          # 클래스 목록
GET /saml/metadata        # SP 메타데이터
GET /saml/login           # IdP 리다이렉트 시작
POST /saml/acs            # Assertion Consumer Service
GET /saml/dev-login       # 개발용 계정 주입
GET /api/whoami           # 세션 확인 (session_user, session_meta)
GET /api/sso/ping         # 외부 SSO 헬스 체크
```

#### AI Classification Engine
**위치**: `/api/classifier.py`

ResNet50 기반 딥러닝 분류 엔진입니다.

**아키텍처**:
```python
Input (224x224x3)
    ↓
ResNet50 (pretrained)
    ↓
Global Average Pooling
    ↓
Dense (256, ReLU)
    ↓
Dropout (0.5)
    ↓
Dense (9, Softmax)
    ↓
Output (9 classes)
```

#### Image Processing Pipeline
**위치**: `/api/image_handler.py`

이미지 전처리 및 변환을 담당합니다.

**처리 단계**:
1. 이미지 로드 및 검증
2. 크기 정규화
3. 색상 공간 변환
4. 노이즈 제거
5. 엣지 강조

## 데이터 플로우

### 이미지 로딩 플로우
```
1. User selects image
    ↓
2. Frontend requests image
    ↓
3. Backend loads from disk
    ↓
4. Image preprocessing
    ↓
5. Generate pyramid levels
    ↓
6. Send to frontend
    ↓
7. Render on canvas
```

### AI 분류 플로우
```
1. Select images for classification
    ↓
2. Batch upload to server
    ↓
3. Preprocess images
    ↓
4. Run through AI model
    ↓
5. Generate predictions
    ↓
6. Save results
    ↓
7. Update UI
```

## 성능 최적화

### 1. 이미지 피라미드
- **목적**: 대용량 이미지 빠른 렌더링
- **구현**: 3단계 해상도 (1x, 0.5x, 0.25x)
- **효과**: 메모리 75% 절감, 렌더링 3배 향상

### 2. 캐싱 전략
```javascript
// 썸네일 캐시
Cache-Control: max-age=86400
ETag: {file_hash}

// 이미지 캐시
LRU Cache (500 items max)
TTL: 10 minutes
```

### 3. 비동기 처리
- Web Workers for heavy computation
- Async/await for I/O operations
- Request queuing for rate limiting

### 4. 메모리 관리
```javascript
// 주기적 정리
setInterval(() => {
    thumbnailManager.cleanupOldCache();
    performGarbageCollection();
}, 5 * 60 * 1000); // 5분마다
```

## 보안 고려사항

### 1. 입력 검증
- 파일 경로 트래버설 방지
- 이미지 파일 타입 검증
- 파일 크기 제한 (100MB)

### 2. 인증/인가
- 현재: 로컬 전용 (localhost only)
- 향후: JWT 기반 인증 계획

### 3. 데이터 보호
- HTTPS 전송 (프로덕션)
- 민감 데이터 암호화
- 로그 파일 접근 제한

## 확장성 고려사항

### 1. 수평 확장
- Stateless 아키텍처
- 로드 밸런서 지원 가능
- 분산 파일 시스템 호환

### 2. 수직 확장
- GPU 가속 활용
- 멀티스레딩 지원
- 메모리 캐시 확장

### 3. 마이크로서비스 전환
```
Future Architecture:
- Image Service
- AI Service  
- Thumbnail Service
- Label Service
- API Gateway
```

## 모니터링 및 로깅

### 1. 로깅 레벨
```python
DEBUG: 상세 디버그 정보
INFO: 일반 정보
WARNING: 경고 메시지
ERROR: 오류 상황
CRITICAL: 심각한 오류
```

### 2. 메트릭 수집
- 응답 시간
- 처리량
- 오류율
- 메모리 사용량
- CPU 사용률

### 3. 헬스/워커
- 실행: `python -m api.main` (HTTPS 전용)
- 워커: FastAPI는 단일 워커로 고정 (`UVICORN_WORKERS=1`). 여러 워커는 인덱스/캐시 중복을 유발함.
- 예) Windows: `setx UVICORN_WORKERS 1`, Ubuntu: `export UVICORN_WORKERS=1`

## 개발 가이드라인

### 1. 코드 스타일
- JavaScript: ESLint + Prettier
- Python: PEP 8 + Black
- 주석: JSDoc / Docstring

### 2. 커밋 컨벤션
```
feat: 새로운 기능
fix: 버그 수정
docs: 문서 수정
style: 코드 포맷팅
refactor: 리팩토링
test: 테스트 추가
chore: 빌드 업무
```

### 3. 브랜치 전략
```
main        (프로덕션)
  ├── develop   (개발)
  ├── feature/* (기능)
  ├── hotfix/*  (긴급 수정)
  └── release/* (릴리즈 준비)
```

## 향후 로드맵

### 단기 (3개월)
- [ ] WebAssembly 이미지 처리
- [ ] Progressive Web App 지원
- [ ] 다국어 지원 (i18n)

### 중기 (6개월)
- [ ] 실시간 협업 기능
- [ ] 클라우드 스토리지 연동
- [ ] 모바일 앱 개발

### 장기 (1년)
- [ ] AI 모델 자동 학습
- [ ] 빅데이터 분석 플랫폼
- [ ] IoT 장비 연동

---

*Last Updated: 2025-01-10*
*Version: 2.0.0*
