Pyramid Format Probe
====================

이 문서는 두 개의 핵심 파일을 소개하고, 썸네일 피라미드 포맷/품질을 결정하고 적용하는 절차를 정리합니다.

1. `scripts/pyramid_format_probe.py`
   - 목적: 특정 원본 이미지를 여러 포맷(PNG, JPEG, WebP)과 품질(Q95/Q100)로 변환해서 **저장 시간**과 **출력 용량**을 한 번에 비교합니다.
   - 사용법:
     1. 파일 상단의 `SOURCE_IMAGE_PATH`, `LEVEL`, `OUTPUT_DIR`를 원하는 값으로 수정합니다.
     2. 가상환경을 활성화한 뒤 `python scripts/pyramid_format_probe.py` 실행.
     3. 콘솔에 각 포맷의 용량/시간이 출력되며, 결과물은 `OUTPUT_DIR` 경로 아래 저장됩니다.
     4. 여러 샘플·레벨에 대해 반복 실행해 적합한 포맷/품질 조합을 선택합니다.

2. `api/config.py`
   - 목적: 서비스 전역 설정을 담당하며, 피라미드 썸네일 포맷/품질도 이 파일에서 제어합니다.
   - 관련 항목:
     - `PYRAMID_FORMAT`: `PNG`, `JPEG`, `WEBP` 중 하나. (기본값: `PNG`)
    - `PYRAMID_Q`: 손실 압축 포맷(JPEG/WEBP)의 품질 값. 0~100 숫자.
    - `PYRAMID_PNG_COMPRESSION`: PNG 저장 시 compress level(0~9).
    - `PYRAMID_PNG_EFFORT`: PNG 압축 효율/속도 조절 (1=가장 빠름, 10=가장 느림).
    - `PYRAMID_LOADER_MODE`: `random_late_copy`(기본) 또는 `seq_early_copy`.
    - `USE_TURBOJPEG`: `1`이면 TurboJPEG로 JPEG 저장을 시도합니다.
    - `TURBOJPEG_PATH`: TurboJPEG DLL/so 경로(미지정 시 자동 검색).
   - FastAPI가 부팅될 때 `.env` 또는 환경 변수에서 값을 읽습니다. 환경 변수를 사용하지 않는다면 이 파일의 기본값을 직접 수정해도 됩니다.

적용 절차
---------
1. `pyramid_format_probe.py`로 후보 포맷/품질을 테스트하고, 용량·성능 사이에서 원하는 조합을 결정합니다.
2. 선택한 조합에 맞게 환경 변수나 `api/config.py`에서 아래 값을 설정합니다.
   - 예: WebP Q95를 쓰고 싶다면
     ```
     PYRAMID_FORMAT=WEBP
     PYRAMID_Q=95
     ```
   - PNG Level 6을 쓰고 싶다면
     ```
     PYRAMID_FORMAT=PNG
     PYRAMID_PNG_COMPRESSION=6
     ```
3. 애플리케이션을 재시작하면 새로운 설정으로 피라미드 썸네일을 생성합니다.

참고 사항
---------
- `api/main.py`의 `_generate_pyramid_sync` 함수에서 `config.PYRAMID_FORMAT`, `config.PYRAMID_Q`, `config.PYRAMID_PNG_COMPRESSION`, `config.PYRAMID_PNG_EFFORT`을 읽어 실제 인코더를 선택합니다.
- 설정 변경 후 기존 피라미드 파일이 이미 생성된 상태라면, 동일 포맷/품질로 재생성하려면 캐시된 파일을 삭제하거나 캐시 무효화 전략을 고려하세요.
