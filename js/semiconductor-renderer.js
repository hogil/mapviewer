/**
 * 반도체 불량맵 전용 고성능 이미지 렌더러
 * 
 * @description
 * 4000x4000 픽셀 규모의 대형 반도체 웨이퍼맵 이미지를 왜곡 없이 렌더링하는 특화 렌더러.
 * 이미지 피라미드 기법을 사용하여 축소 시에도 세밀한 불량 패턴을 보존합니다.
 * 
 * @features
 * - 이미지 피라미드를 통한 다단계 해상도 지원 (1x, 0.5x, 0.25x)
 * - Lanczos3 알고리즘 기반 고품질 다운샘플링
 * - 픽셀 완벽 렌더링으로 앤티 앨리어싱 방지
 * - GPU 가속 최적화
 * - 반도체 불량 패턴 강조 기능
 * 
 * @author L3 Tracker Team
 * @version 2.0.0
 * @since 2025-01-10
 */

class SemiconductorRenderer {
    /**
     * 렌더러 생성자
     * @param {HTMLCanvasElement} canvas - 렌더링 대상 캔버스
     * @param {Object} options - 렌더러 옵션
     */
    constructor(canvas, options = {}) {
        if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
            throw new Error('유효한 캔버스 엘리먼트가 필요합니다.');
        }

        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', {
            alpha: false,
            desynchronized: true,
            willReadFrequently: false
        });
        
        // 기본 옵션 설정
        this.options = {
            preserveChipBoundaries: options.preserveChipBoundaries !== false,
            enhanceDefects: options.enhanceDefects !== false,
            chipBoundaryColor: options.chipBoundaryColor || '#00FF00',
            defectEnhancement: options.defectEnhancement || 2.0,
            minVisibleScale: options.minVisibleScale || 0.05,
            usePyramid: options.usePyramid !== false,
            debug: options.debug || false
        };
        
        // 상태 초기화
        this.currentImage = null; // HTMLImageElement | ImageBitmap
        this.imagePyramid = {};   // key -> ImageBitmap
        this.scale = 1.0;
        this.isGeneratingPyramid = false;
        this.generatingLevels = new Set(); // 진행 중인 레벨 키
        this.imageVersion = 0;            // 현재 이미지 버전
        this.pyramidVersion = 0;          // 피라미드 버전 (검증용)
        this._lastLevelKey = '1';         // 마지막으로 적용된 레벨 키
        this._lastEnsureAt = 0;           // 직전 보장 시각(ms)
        
        this.setupPixelPerfectCanvas();
    }
    
    /**
     * 픽셀 완벽 렌더링 설정
     * 브라우저의 이미지 보간을 완전히 비활성화하여 픽셀 단위 정확도 보장
     */
    setupPixelPerfectCanvas() {
        // 컨텍스트 이미지 스무딩 비활성화
        const smoothingProps = [
            'imageSmoothingEnabled',
            'mozImageSmoothingEnabled',
            'webkitImageSmoothingEnabled',
            'msImageSmoothingEnabled'
        ];
        
        smoothingProps.forEach(prop => {
            if (prop in this.ctx) {
                this.ctx[prop] = false;
            }
        });
        
        if ('imageSmoothingQuality' in this.ctx) {
            this.ctx.imageSmoothingQuality = 'low';
        }
        
        // CSS 픽셀 렌더링 최적화
        const pixelatedStyles = {
            'imageRendering': ['pixelated', '-moz-crisp-edges', '-webkit-crisp-edges', 'crisp-edges'],
            'msInterpolationMode': 'nearest-neighbor',
            'willChange': 'transform',
            'transform': 'translateZ(0)',
            'backfaceVisibility': 'hidden'
        };
        
        Object.entries(pixelatedStyles).forEach(([prop, value]) => {
            if (Array.isArray(value)) {
                value.forEach(val => {
                    try {
                        this.canvas.style[prop] = val;
                    } catch (e) {
                        // 브라우저가 지원하지 않는 속성 무시
                    }
                });
            } else {
                this.canvas.style[prop] = value;
            }
        });
    }
    
    /**
     * 이미지 로드 및 피라미드 생성
     * @param {HTMLImageElement} image - 로드할 이미지
     * @returns {Promise<void>}
     */
    async loadImage(image) {
        // HTMLImageElement 또는 ImageBitmap 허용
        const isValid = (typeof ImageBitmap !== 'undefined' && image instanceof ImageBitmap) || image instanceof HTMLImageElement;
        if (!isValid) {
            throw new Error('유효한 이미지 타입이 아닙니다. (HTMLImageElement | ImageBitmap)');
        }

        // 버전 증가 및 캐시 초기화
        this.imageVersion += 1;
        const version = this.imageVersion;
        this.currentImage = image;
        this.imagePyramid = { '1': image }; // 항상 원본은 현재 이미지
        this.pyramidVersion = version;
        this.generatingLevels.clear();
        this.isGeneratingPyramid = false;
        
        // 이미지 피라미드 "비차단" 생성 (백그라운드)
        if (this.options.usePyramid) {
            // await 하지 않음 → UI 블로킹 방지
            this.generateImagePyramid(image, version).catch(() => {/* 무시: 백그라운드 작업 */});
        }
        
        this.render();
    }
    
    /**
     * 이미지 피라미드 생성 (비동기)
     * @param {HTMLImageElement} image - 원본 이미지
     * @returns {Promise<void>}
     */
    async generateImagePyramid(image, version) {
        if (this.isGeneratingPyramid) {
            this.log('이미지 피라미드 생성 중... 중복 요청 무시');
            return;
        }

        this.isGeneratingPyramid = true;
        this.log('이미지 피라미드 생성 시작... (비동기, 병렬 처리)');

        try {
            // 원본은 즉시 사용 (ImageBitmap 보장 필요 없음)
            // 버전이 바뀌었으면 중단
            if (version !== this.imageVersion) return;
            this.imagePyramid['1'] = image;

            // 🔥 서버 설정에서 pyramid levels 가져오기
            const pyramidLevels = (window.SERVER_CONFIG && window.SERVER_CONFIG.PYRAMID_LEVELS) || [0.2, 0.5, 0.7, 1.0];
            // 1.0은 제외하고 나머지 레벨만 생성 (1.0은 원본)
            const levels = pyramidLevels.filter(l => l < 1.0).map(scale => ({
                key: scale.toString(),
                scale: scale
            }));

            // 병렬 생성 시작
            const tasks = levels.map(({ key, scale }) => {
                if (this.generatingLevels.has(key) || this.imagePyramid[key]) return null;
                this.generatingLevels.add(key);

                return (async () => {
                    try {
                        const bmp = await this.createResizedBitmap(image, scale);
                        // 최신 이미지인지 확인 후 반영
                        if (version === this.imageVersion) {
                            this.imagePyramid[key] = bmp;
                            this.pyramidVersion = version;
                            this.log(`피라미드 레벨 준비 완료: ${key} (${bmp.width}x${bmp.height})`);
                        }
                    } catch (e) {
                        console.warn(`레벨 생성 실패: ${key}`, e);
                    } finally {
                        this.generatingLevels.delete(key);
                    }
                })();
            }).filter(t => t !== null);

            // 유휴 시간에 병렬 실행
            if (typeof requestIdleCallback === 'function') {
                requestIdleCallback(() => Promise.all(tasks));
            } else {
                // 폴백: 즉시 실행
                Promise.all(tasks);
            }
        } catch (error) {
            console.error('이미지 피라미드 생성 실패:', error);
        } finally {
            this.isGeneratingPyramid = false;
        }
    }
    
    /**
     * 고품질 다운스케일링 (브라우저 네이티브 최적화)
     * @param {HTMLImageElement} srcImage - 원본 이미지
     * @param {number} scale - 축소 비율 (0 < scale <= 1)
     * @returns {Promise<ImageBitmap>}
     */
    async createResizedBitmap(srcImage, scale) {
        const dstWidth = Math.max(1, Math.floor(srcImage.width * scale));
        const dstHeight = Math.max(1, Math.floor(srcImage.height * scale));

        // 🔥 최적화: createImageBitmap 직접 사용 (가장 빠름)
        // 브라우저 네이티브 리샘플링 사용 (GPU 가속)
        if (typeof createImageBitmap === 'function') {
            try {
                return await createImageBitmap(srcImage, {
                    resizeWidth: dstWidth,
                    resizeHeight: dstHeight,
                    resizeQuality: 'high'  // 고품질 리샘플링
                });
            } catch (e) {
                // 폴백: 캔버스 사용
            }
        }

        // 폴백: OffscreenCanvas 또는 일반 Canvas 사용
        const hasOffscreen = typeof OffscreenCanvas !== 'undefined';
        const canvas = hasOffscreen ? new OffscreenCanvas(dstWidth, dstHeight) : document.createElement('canvas');
        if (!hasOffscreen) {
            canvas.width = dstWidth;
            canvas.height = dstHeight;
        }
        const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true, willReadFrequently: false });
        // 다운스케일 품질 우선
        ctx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(srcImage, 0, 0, dstWidth, dstHeight);

        if (hasOffscreen) {
            return canvas.transferToImageBitmap();
        }
        return await createImageBitmap(canvas);
    }
    
    /**
     * Lanczos3 가중치 계산
     * @param {number} x - X 거리
     * @param {number} y - Y 거리
     * @returns {number} 가중치 값
     */
    lanczos3Weight(x, y) {
        // 더 이상 사용하지 않지만, 하위 호환 유지 (미사용)
        const r = Math.sqrt(x * x + y * y);
        if (r === 0) return 1;
        if (r >= 3) return 0;
        const piR = Math.PI * r;
        const piR3 = piR / 3;
        return (Math.sin(piR) / piR) * (Math.sin(piR3) / piR3);
    }
    
    /**
     * 스케일 설정
     * @param {number} newScale - 새로운 스케일 값
     * @returns {number} 실제 적용된 스케일
     */
    setScale(newScale) {
        this.scale = Math.max(this.options.minVisibleScale, Math.min(10, newScale));
        // 줌 임계 변경 시, 필요한 레벨을 즉시(동기) 확보하여 첫 프레임부터 픽셀 축소 적용
        try {
            this._ensureImmediateLevelForScale();
        } catch (e) {
            // 동기 보장은 실패해도 무시하고 비동기 백필에 맡김
        }
        this.render();
        return this.scale;
    }
    
    /**
     * 메인 렌더링 함수
     * 핵심: 캔버스 크기는 항상 원본 × zoom으로 유지하고, 내부 픽셀 데이터만 변경
     */
    render() {
        if (!this.currentImage) return;
        
        // 이 렌더러는 이제 외부(main.js)가 사용 여부를 제어하므로
        // 내부에서 자동으로 캔버스를 다시 그리지 않음.
        // selectPyramidLevel()과 createDownscaledImage()만 제공하는 헬퍼 역할.
        // 하지만 피라미드 생성은 여전히 필요하므로 loadImage에서 호출됨.
        return;
    }
    
    /**
     * 최적의 피라미드 레벨 선택
     * zoom 배율에 따라 적절한 해상도의 이미지 선택
     * @returns {HTMLImageElement} 선택된 이미지
     */
    selectPyramidLevel() {
        let selected = this.currentImage;

        if (this.options.usePyramid) {
            // 🔥 서버 설정에서 thresholds와 levels 가져오기
            const thresholds = (window.SERVER_CONFIG && window.SERVER_CONFIG.PYRAMID_ZOOM_THRESHOLDS) || [0.25, 0.5, 0.75];
            const levels = (window.SERVER_CONFIG && window.SERVER_CONFIG.PYRAMID_LEVELS) || [0.2, 0.5, 0.7, 1.0];

            // threshold에 따라 최적 레벨 선택
            let targetLevel, targetKey;
            if (this.scale < thresholds[0]) {
                targetLevel = levels[0];
                targetKey = targetLevel.toString();
            } else if (this.scale < thresholds[1]) {
                targetLevel = levels[1];
                targetKey = targetLevel.toString();
            } else if (this.scale < thresholds[2]) {
                targetLevel = levels[2];
                targetKey = targetLevel.toString();
            } else {
                targetLevel = levels[3];
                targetKey = '1';
            }

            // 레벨이 1.0(원본)이 아니면 피라미드 이미지 사용
            if (targetLevel < 1.0) {
                if (!this.imagePyramid[targetKey]) {
                    this.generateImagePyramid(this.currentImage, this.imageVersion).catch(() => {});
                } else {
                    selected = this.imagePyramid[targetKey];
                    this._lastLevelKey = targetKey;
                }
            } else {
                // 원본 유지
                this._lastLevelKey = '1';
            }
        }
        return selected;
    }

    /**
     * 현재 scale에 필요한 레벨을 즉시 확보(동기)하여 첫 렌더부터 픽셀 축소가 반영되도록 한다.
     * - 캔버스 객체를 즉시 생성해 imagePyramid에 채워 넣고, 이후 고품질 ImageBitmap으로 비동기 대체
     */
    _ensureImmediateLevelForScale() {
        if (!this.currentImage || !this.options.usePyramid) return;
        const now = Date.now();
        // 🔥 최적화: 30ms로 축소 (더 빠른 응답)
        if (now - this._lastEnsureAt < 30) return;
        this._lastEnsureAt = now;

        // 🔥 서버 설정에서 thresholds와 levels 가져오기
        const thresholds = (window.SERVER_CONFIG && window.SERVER_CONFIG.PYRAMID_ZOOM_THRESHOLDS) || [0.25, 0.5, 0.75];
        const levels = (window.SERVER_CONFIG && window.SERVER_CONFIG.PYRAMID_LEVELS) || [0.2, 0.5, 0.7, 1.0];

        let key, scale;
        if (this.scale < thresholds[0]) {
            scale = levels[0];
            key = scale.toString();
        } else if (this.scale < thresholds[1]) {
            scale = levels[1];
            key = scale.toString();
        } else if (this.scale < thresholds[2]) {
            scale = levels[2];
            key = scale.toString();
        } else {
            return; // 원본이면 즉시 보장 불필요
        }

        if (this.imagePyramid[key]) return; // 이미 준비됨

        // 🔥 최적화: 즉시(동기) 캔버스 생성으로 첫 프레임 화질 반영
        const w = Math.max(1, Math.floor(this.currentImage.width * scale));
        const h = Math.max(1, Math.floor(this.currentImage.height * scale));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const cx = c.getContext('2d', { alpha: false, desynchronized: true, willReadFrequently: false });
        cx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in cx) cx.imageSmoothingQuality = 'high';
        cx.drawImage(this.currentImage, 0, 0, w, h);
        this.imagePyramid[key] = c; // 캔버스도 drawImage 대상 가능

        // 🔥 최적화: 고품질 ImageBitmap으로 비동기 교체 (우선순위 높음)
        this.createResizedBitmap(this.currentImage, scale).then(bmp => {
            // 최신 이미지인지 확인
            if (this.imageVersion === this.pyramidVersion || this.pyramidVersion === 0) {
                this.imagePyramid[key] = bmp;
                this.pyramidVersion = this.imageVersion;
                this.log(`즉시 레벨 업그레이드 완료: ${key}`);
            }
        }).catch(() => {});
    }
    
    /**
     * 컨테이너에 맞춤
     * @param {number} containerWidth - 컨테이너 너비
     * @param {number} containerHeight - 컨테이너 높이
     * @param {number} margin - 여백 비율 (0-1)
     * @returns {number} 적용된 스케일
     */
    fitToContainer(containerWidth, containerHeight, margin = 0.95) {
        if (!this.currentImage) return this.scale;
        
        const scaleX = containerWidth / this.currentImage.width;
        const scaleY = containerHeight / this.currentImage.height;
        
        return this.setScale(Math.min(scaleX, scaleY) * margin);
    }
    
    /**
     * 줌 인
     * @param {number} factor - 줌 배율
     */
    zoomIn(factor = 1.2) {
        this.setScale(this.scale * factor);
    }
    
    /**
     * 줌 아웃
     * @param {number} factor - 줌 배율
     */
    zoomOut(factor = 0.8) {
        this.setScale(this.scale * factor);
    }
    
    /**
     * 현재 렌더링 상태 정보
     * @returns {Object} 렌더링 정보
     */
    getInfo() {
        if (!this.currentImage) {
            return {
                status: 'No image loaded'
            };
        }
        
        let pyramidLevel = '원본';
        let pixelReduction = '100%';

        if (this.options.usePyramid && Object.keys(this.imagePyramid).length > 0) {
            // 🔥 서버 설정에서 thresholds와 levels 가져오기
            const thresholds = (window.SERVER_CONFIG && window.SERVER_CONFIG.PYRAMID_ZOOM_THRESHOLDS) || [0.25, 0.5, 0.75];
            const levels = (window.SERVER_CONFIG && window.SERVER_CONFIG.PYRAMID_LEVELS) || [0.2, 0.5, 0.7, 1.0];

            if (this.scale < thresholds[0]) {
                pyramidLevel = `${levels[0]}x`;
                pixelReduction = `${Math.round(levels[0] * 100)}%`;
            } else if (this.scale < thresholds[1]) {
                pyramidLevel = `${levels[1]}x`;
                pixelReduction = `${Math.round(levels[1] * 100)}%`;
            } else if (this.scale < thresholds[2]) {
                pyramidLevel = `${levels[2]}x`;
                pixelReduction = `${Math.round(levels[2] * 100)}%`;
            }
        }
        
        return {
            originalWidth: this.currentImage.width,
            originalHeight: this.currentImage.height,
            displayWidth: Math.floor(this.currentImage.width * this.scale),
            displayHeight: Math.floor(this.currentImage.height * this.scale),
            scale: this.scale,
            scalePercent: Math.round(this.scale * 100),
            pyramidLevel: pyramidLevel,
            pixelReduction: pixelReduction,
            pyramidEnabled: this.options.usePyramid,
            renderMode: '적응형 픽셀 렌더링',
            isGeneratingPyramid: this.isGeneratingPyramid
        };
    }
    
    /**
     * 디버그 로깅
     * @param {...any} args - 로그 인자
     */
    log(...args) {
        if (this.options.debug) {
            console.log('[SemiconductorRenderer]', ...args);
        }
    }
    
    /**
     * 리소스 정리
     */
    destroy() {
        // 이미지 피라미드 정리
        this.imagePyramid = {};
        this.currentImage = null;
        
        // 캔버스 정리
        if (this.ctx) {
            this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        
        this.log('렌더러 리소스 정리 완료');
    }
}

// 전역 사용을 위한 내보내기
if (typeof window !== 'undefined') {
    window.SemiconductorRenderer = SemiconductorRenderer;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SemiconductorRenderer;
}