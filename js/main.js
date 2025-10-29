/**
 * WaferMapViewer
 * 
 * A class to manage the wafer map viewer application.
 * This includes:
 * - Lazy-loading file explorer
 * - Image panning and zooming
 * - A responsive minimap
 * - Sidebar resizing
 */

// 🚀 Fetch 최적화 import
import { optimizedFetch, fetchOptimizer } from './fetch-optimizer.js';

// Constants

const DEFAULT_GRID_COLS = 3;
const DEFAULT_THUMB_SIZE = 512;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH_RATIO = 0.5;
const MIN_DRAG_DISTANCE = 5;
const ZOOM_FACTOR = 1.2;
let THUMB_BATCH_SIZE = 24;
const DEBOUNCE_DELAY = 0;
const GRID_DRAG_CLICK_THRESHOLD = 14;

const initialUrlParams = new URLSearchParams(window.location.search);
const initialSamlSuccess = initialUrlParams.get('saml_success') === 'true';
const initialDevSuccess = initialUrlParams.get('dev_success') === 'true';
const initialLoginIdFromUrl = initialUrlParams.get('LoginId');
const initialUsernameFromUrl = initialUrlParams.get('Username');
const initialDeptNameFromUrl = initialUrlParams.get('DeptName');

async function decodeBitmapSmart(source, options) {
    const decodeSource = source;
    if (window.BitmapLoader && typeof window.BitmapLoader.decode === 'function') {
        try {
            return await window.BitmapLoader.decode(decodeSource, options);
        } catch (error) {
            console.warn('[BitmapLoader] decode fallback:', error);
        }
    }
    if (typeof createImageBitmap === 'function') {
        if (decodeSource && typeof decodeSource === 'object' && 'buffer' in decodeSource && decodeSource.buffer) {
            const type = decodeSource.type || 'image/jpeg';
            const blob = new Blob([decodeSource.buffer], { type });
            return await createImageBitmap(blob, options || undefined);
        }
        return await createImageBitmap(decodeSource, options || undefined);
    }
    throw new Error('ImageBitmap decoding not supported');
}

// 초기 맞춤 여유 (상대 비율)

const FIT_RELATIVE_MARGIN = 0.96; // 초기 로드 시 4% 여유 (2% 더 작게)

// 리셋 시 절대 퍼센트포인트 오프셋 (예: -0.02 => 2%p 더 작게)

const RESET_ABSOLUTE_PERCENT_OFFSET = -0.02;

// 🔥 서버 설정 (페이지 로드시 한번만 가져옴)
let SERVER_CONFIG = {
    PYRAMID_LEVELS: [0.2, 0.5, 0.7, 1.0],  // 기본값
    PYRAMID_ZOOM_THRESHOLDS: [0.25, 0.5, 0.75],  // 기본값
    THUMB_BATCH_SIZE: 24,
    THUMB_MAX_CONCURRENCY: 12
};

/**
 * Thumbnail Manager
 * 썸네일 로딩과 캐싱을 관리하는 클래스
 */

class ThumbnailManager {
    constructor() {
        this.cache = new Map(); // path -> { url, loading, timestamp }

        this.maxCacheSize = 500;

        this.cacheTimeout = 10 * 60 * 1000; // 10분

        this.concurrentLoads = 0;

        this.maxConcurrentLoads = SERVER_CONFIG.THUMB_MAX_CONCURRENCY ?? 12;

        this.loadQueue = [];

        this.abortController = null; // 진행 중인 요청 중단용
        this.debugMode = window.location.hash === '#debug';

        // 🚀 Intersection Observer 설정

        this.observer = new IntersectionObserver(

            (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        const imgPath = img.dataset.imagePath;

                        if (imgPath && !img.dataset.loaded) {
                            img.dataset.loaded = 'true';

                            this.loadThumbnail(imgPath).then(url => {
                                if (url && img.parentElement) {
                                    img.src = url;

                                    img.style.opacity = '1';
                                }
                            }).catch(() => {
                                img.style.backgroundColor = '#333';

                                img.style.opacity = '0.5';
                            });
                        }

                        this.observer.unobserve(img);
                    }
                });
            },

            {
                root: null,

                rootMargin: '200px', // 200px 미리 로드

                threshold: 0.01
            }

        );
    }

    setMaxConcurrentLoads(value) {
        const numeric = Number(value);
        if (Number.isFinite(numeric) && numeric > 0) {
            this.maxConcurrentLoads = Math.max(1, Math.floor(numeric));
        }
    }

    async loadThumbnail(imgPath) {
        const cached = this.cache.get(imgPath);

        // 유효한 캐시가 있으면 반환

        if (cached?.url && (Date.now() - cached.timestamp) < this.cacheTimeout) {
            return cached.url;
        }

        // 로딩 중이면 대기

        if (cached?.loading) {
            return cached.loading;
        }

        // 새로운 로딩 시작

        const loadingPromise = this.fetchThumbnail(imgPath);

        this.cache.set(imgPath, { 
            loading: loadingPromise, 

            timestamp: Date.now() 
        });

        try {
            const url = await loadingPromise;

            this.cache.set(imgPath, { 
                url, 

                timestamp: Date.now() 
            });

            this.trimCache();

            return url;
        } catch (error) {
            // 🔥 AbortError는 조용히 처리 (중단된 요청)

            if (error.name === 'AbortError') {
                return null;
            }

            this.cache.delete(imgPath);

            // console.warn(`썸네일 로드 실패: ${imgPath}`, error);

            return null;
        }
    }

    async fetchThumbnail(imgPath) {
        // 🚀 nul 파일 등 잘못된 경로 필터링

        if (!imgPath || imgPath === 'nul' || imgPath.trim() === '') {
            throw new Error(`잘못된 이미지 경로: ${imgPath}`);
        }

        // 동시 로딩 수 제한

        if (this.concurrentLoads >= this.maxConcurrentLoads) {
            await new Promise(resolve => this.loadQueue.push(resolve));
        }

        this.concurrentLoads++;

        // 🔥 AbortController 생성 (요청 중단용)

        if (!this.abortController) {
            this.abortController = new AbortController();
        }

        try {
            // 🔥 blob URL 대신 서버 URL 직접 사용 (CORS, GC 문제 해결)
            // timestamp를 추가하여 브라우저 캐싱 활용하면서도 새로고침 가능
            const thumbnailUrl = `/api/thumbnail?path=${encodeURIComponent(imgPath)}&size=512`;
            
            // 🔍 디버그: 썸네일 URL 로그
                                    // 서버 URL을 직접 반환 (브라우저가 자동으로 로드)
            return thumbnailUrl;
        } finally {
            this.concurrentLoads--;

            // 대기 중인 요청 처리
            if (this.loadQueue.length > 0) {
                const resolve = this.loadQueue.shift();
                resolve();
            }
        }
    }

    async preloadBatch(imagePaths) {
        // 이미 캐시된 것 제외

        const uncachedPaths = imagePaths.filter(path => {
            const cached = this.cache.get(path);

            return !cached || (!cached.url && !cached.loading);
        });

        if (uncachedPaths.length === 0) return;

        // 배치 크기 제한

        const batchSize = Math.min(uncachedPaths.length, THUMB_BATCH_SIZE || 24);
        const batch = uncachedPaths.slice(0, batchSize);

        // 서버 배치 프리로드 시도

        try {
            const response = await fetch('/api/thumbnail/preload', {
                method: 'POST',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify({ paths: batch }),

                signal: this.abortController?.signal
            });

            if (response.ok) {
                const result = await response.json();

                if (batch.length > 20) { // 대량 처리시만 로그

                    this.debugLog(`썸네일 생성: ${result.results?.length || batch.length}개`);
                }

                return result;
            } else if (response.status === 404) {
                // 404는 정상 (API 미지원) - 조용히 무시

                this.debugLog(`🚀 배치 프리로드 API 미지원 (404) - 클라이언트 캐시만 사용`);
            }
        } catch (error) {
            // 🔥 AbortError는 조용히 처리 (중단된 요청)

            if (error.name === 'AbortError') {
                return;
            }

            console.warn('썸네일 배치 로드 실패, 개별 로딩으로 전환:', error);
        }

        // 서버 배치 실패 시 개별 로딩

        const promises = batch.map(path => this.loadThumbnail(path));

        return Promise.allSettled(promises);
    }

    trimCache() {
        if (this.cache.size <= this.maxCacheSize) return;

        // 현재 DOM에서 사용 중인 썸네일 URL 수집

        const activeUrls = new Set();
        const images = document.querySelectorAll('.grid-thumb-img');

        images.forEach(img => {
            if (img.src && img.src.startsWith('blob:')) {
                activeUrls.add(img.src);
            }

            if (img.dataset.thumbnailUrl) {
                activeUrls.add(img.dataset.thumbnailUrl);
            }
        });

        const entries = Array.from(this.cache.entries())

            .filter(([_, data]) => data.url && !activeUrls.has(data.url)) // 사용 중이 아닌 URL만

            .sort((a, b) => a[1].timestamp - b[1].timestamp);
        
        const deleteCount = Math.max(0, this.cache.size - this.maxCacheSize);
        const toDelete = entries.slice(0, deleteCount);

        toDelete.forEach(([path, data]) => {
            if (data.url) URL.revokeObjectURL(data.url);

            this.cache.delete(path);
        });
    }

    clearCache() {
        this.cache.forEach(data => {
            if (data.url) URL.revokeObjectURL(data.url);
        });

        this.cache.clear();

        this.loadQueue.length = 0;

        this.concurrentLoads = 0;
    }

    // 진행 중인 모든 썸네일 로드 중단

    abortAll() {
        // 🔥 진행 중인 요청 중단

        if (this.abortController) {
            this.abortController.abort();

            this.abortController = null;
        }

        // 대기 중인 큐 비우기

        this.loadQueue.length = 0;

        this.concurrentLoads = 0;

        // 🔥 새로운 AbortController 생성 (다음 요청용)

        this.abortController = new AbortController();

        this.debugLog('🛑 모든 썸네일 로드 중단됨');
    }

    debugLog(...args) {
        if (this.debugMode) console.log(...args);
    }

    // 사용하지 않는 캐시 정리 (메모리 최적화)

    cleanupOldCache() {
        const now = Date.now();

        // 현재 DOM에서 사용 중인 썸네일 URL 수집

        const activeUrls = new Set();
        const images = document.querySelectorAll('.grid-thumb-img');

        images.forEach(img => {
            if (img.src && img.src.startsWith('blob:')) {
                activeUrls.add(img.src);
            }

            if (img.dataset.thumbnailUrl) {
                activeUrls.add(img.dataset.thumbnailUrl);
            }
        });

        const toDelete = [];

        this.cache.forEach((data, path) => {
            if (data.url && 

                (now - data.timestamp) > this.cacheTimeout && 

                !activeUrls.has(data.url)) { // 현재 사용 중이 아닌 것만 삭제

                toDelete.push(path);
            }
        });

        toDelete.forEach(path => {
            const data = this.cache.get(path);

            if (data?.url) URL.revokeObjectURL(data.url);

            this.cache.delete(path);
        });

        return toDelete.length;
    }

    getCacheStats() {
        const entries = Array.from(this.cache.values());

        return {
            total: this.cache.size,

            loaded: entries.filter(d => d.url).length,

            loading: entries.filter(d => d.loading).length,

            concurrent: this.concurrentLoads,

            queued: this.loadQueue.length
        };
    }
}

/**
 * 픽셀 완벽 렌더링을 위한 유틸리티 함수
 * 모든 브라우저에서 이미지 스무딩을 완전히 비활성화
 */

function setPixelPerfectRendering(ctx) {
    // 표준 속성

    ctx.imageSmoothingEnabled = false;

    // 벤더별 속성들 (브라우저 호환성)

    ctx.webkitImageSmoothingEnabled = false;

    ctx.mozImageSmoothingEnabled = false;

    ctx.msImageSmoothingEnabled = false;

    ctx.oImageSmoothingEnabled = false;

    // 고해상도 디스플레이를 위한 추가 설정

    if (ctx.imageSmoothingQuality) {
        ctx.imageSmoothingQuality = 'low';
    }
}

class WaferMapViewer {
    constructor() {
        this.cacheDom();

        this.initState();

        this.bindEvents();

        this.init();
        this.debugMode = window.location.hash === "#debug";

        // 디바운싱된 showGrid

        this._showGridScheduled = false;

        // 썸네일 매니저

        this.thumbnailManager = new ThumbnailManager();

        // 제품 검색 드롭다운 키보드 탐색용
        this.highlightedIndex = -1;
        
        // contextmenu 이벤트 발생 플래그 (다음 click 이벤트 무시용)
        this.contextMenuJustShown = false;
        
        // 전역 AbortController 초기화 (모든 API 요청 중단용)
        this.globalAbortController = new AbortController();
        
        // 🔥 ROOT_DIR 캐시 (중복 API 호출 방지)
        this.cachedRootPath = null;
        
        // 반도체 특화 렌더러 초기화

        this.semiconductorRenderer = null;
        this.usingGpuRenderer = false;
        this.minimapPreview = null;

        this.initSemiconductorRenderer();

        // 주기적인 메모리 정리 (5분마다)

        this.cleanupInterval = setInterval(() => {
            this.performCleanup();
        }, 5 * 60 * 1000);

        // 페이지 언로드시 정리

        window.addEventListener('beforeunload', () => {
            this.cleanup();
        });
    }

    initSemiconductorRenderer() {
        if (typeof SemiconductorRenderer !== 'undefined' && this.dom?.imageCanvas) {
            this.semiconductorRenderer = new SemiconductorRenderer(this.dom.imageCanvas, {
                preserveChipBoundaries: true,

                enhanceDefects: true,

                chipBoundaryColor: '#00FF00',

                defectEnhancement: 2.0
            });

            this.usingGpuRenderer = this.semiconductorRenderer.isGpuAvailable();
            this.debugLog('반도체 특화 렌더러 초기화 완료');
        } else {
            console.warn('SemiconductorRenderer 또는 imageCanvas가 준비되지 않았습니다');
        }
    }

    /**
     * Cache all necessary DOM elements for fast access.
     */

    cacheDom() {
        this.dom = {
            sidebar: document.querySelector('.sidebar'),

            resizer: document.getElementById('resizer'),

            resizerRight: document.getElementById('resizer-right'),

            fileExplorer: document.getElementById('file-explorer'),

            viewerContainer: document.getElementById('viewer-container'),

            imageCanvas: document.getElementById('image-canvas'),

            minimapContainer: document.getElementById('minimap-container'),

            minimapCanvas: document.getElementById('minimap-canvas'),

            minimapViewport: document.getElementById('minimap-viewport'),

            zoomInBtn: document.getElementById('zoom-in-btn'),

            zoomOutBtn: document.getElementById('zoom-out-btn'),

            zoomLevelInput: document.getElementById('zoom-level'),

            resetViewBtn: document.getElementById('reset-view-btn'),

            zoom50Btn: document.getElementById('zoom-50-btn'),

            zoom100Btn: document.getElementById('zoom-100-btn'),

            zoom200Btn: document.getElementById('zoom-200-btn'),

            zoom300Btn: document.getElementById('zoom-300-btn'),

            wrapperRight: document.querySelector('.wrapper-right'),

            overlayCanvas: document.getElementById('overlay-canvas'),

            fileNameDisplay: document.getElementById('file-name-display'),

            fileNameText: document.getElementById('file-name-text'),

            filePathText: document.getElementById('file-path-text'),

            subfolderSelect: document.getElementById('subfolder-select'),
            subfolderSearch: document.getElementById('subfolder-search'),
            subfolderDropdown: document.getElementById('subfolder-dropdown'),

            refreshBtn: document.getElementById('refresh-btn'),

            addClassBtn: document.getElementById('add-class-btn'),

            newClassInput: document.getElementById('new-class-input'),

            classList: document.getElementById('class-list'),

            labelStatus: document.getElementById('label-status'),

            deleteClassBtn: document.getElementById('delete-class-btn'),

            renameClassBtn: document.getElementById('rename-class-btn'),

            fileSearch: document.getElementById('file-search'),

            searchBtn: document.getElementById('search-btn'),

            productSearchInput: document.getElementById('product-search-input'),
        };

        for (const [key, el] of Object.entries(this.dom)) {
            if (!el) {
                // console.error(`[WaferMapViewer] DOM element not found: ${key}`);
            }
        }

        this.imageCtx = this.dom.imageCanvas?.getContext('2d', { willReadFrequently: false });

        this.minimapCtx = this.dom.minimapCanvas?.getContext('2d', { willReadFrequently: false });

        if (this.dom.imageCanvas) {
            this.dom.imageCanvas.style.willChange = 'transform';

            this.dom.imageCanvas.style.transform = 'translateZ(0)';
        }

        if (this.dom.minimapCanvas) {
            this.dom.minimapCanvas.style.willChange = 'transform';

            this.dom.minimapCanvas.style.transform = 'translateZ(0)';
        }
    }

    /**
     * Initialize the application's state.
     */

    initState() {
        this.imageCtx.imageSmoothingQuality = 'high';

        this.transform = { scale: 1, dx: 0, dy: 0 };
        this.zoom = 1; // 🎯 zoom 값 초기화

        this.isPanning = false;

        this.panStart = { x: 0, y: 0 };

        this.currentImage = null;

        this.selectedImages = [];

        this.gridMode = false;
        this.gridSelectedIdxs = [];
        this.gridSelectedSet = new Set();
        this._prevGridSelectedIdxs = new Set();
        this.gridLastClickedIdx = undefined;
        
        // 이미지 상세 보기 모드
        this.detailMode = false;
        this.detailImagePath = null;
        
        // 🔥 상태 저장 (Grid/Label Explorer 전환용)
        this.waferMapExplorerState = null;  // Wafer Map Explorer 상태 저장
        this.labelExplorerState = null;     // Label Explorer 상태 저장
        this.cachedProductFolders = null;   // 제품 폴더 캐시 (초기 로딩 속도 개선)
        this.productFoldersPromise = null;  // 제품 폴더 로딩 Promise
        this.cachedClassList = null;        // 클래스 목록 캐시
        this.classListPromise = null;       // 클래스 목록 로딩 Promise
        this.gridThumbWraps = [];
        this.invalidateGridGeometry();
        this.gridThumbRectCache = null;
        this.gridLayoutCache = null;
        this.gridDragIntentThreshold = GRID_DRAG_CLICK_THRESHOLD;
        this.gridSelectionPending = new Set();
        this.gridSelectionNeedsFullRefresh = false;
        this.gridSelectionCursor = 0;
        this.gridSelectionFrameId = null;
        this.gridSelectionIdleId = null;
        this.gridSelectionBatchSize = 1000; // 🚀 성능 향상: 배치 크기 증가
        this.gridSelectionHideThreshold = 500; // 🚀 성능 향상: 임계값 증가
        this.gridSelectionGridHidden = false;
        this.gridSelectionOriginalDisplay = null;

        this.gridCols = DEFAULT_GRID_COLS;

        this.gridThumbSize = DEFAULT_THUMB_SIZE;

        this.currentFolderPath = null;  // 🔥 ROOT_DIR로 초기화 (init에서 설정)
        console.log('🔍 [STATE_DEBUG] currentFolderPath 초기화: null');
        this.currentFolderPrefix = '';  // 🔥 파일 경로 앞에 붙일 접두사 (예: "performance_test4/")

        this.selectedFolderForBrowser = '';

        // 클래스 선택 상태 초기화 (Label Explorer와 Class Manager가 공유)

        this.classSelection = { selected: [], lastClicked: null };

        this.labelSelection = { selected: [], lastClicked: null, openFolders: {}, selectedClasses: [] };

        // Bind 'this' for event handlers that are dynamically added/removed

        this.boundHandleMouseMove = this.handleMouseMove.bind(this);

        this.boundHandleMouseUp = this.handleMouseUp.bind(this);

        this.boundSidebarMove = this.handleSidebarMove.bind(this);

        this.boundSidebarUp = this.handleSidebarUp.bind(this);

        // 우측 리사이저

        this.boundHandleRightMove = this.handleRightMove.bind(this);

        this.boundHandleRightUp = this.handleRightUp.bind(this);
    }

    /**
     * Bind all static event listeners. (함수 분리)
     */

    debugLog(...args) {
        if (this.debugMode) console.log(...args);
    }

    bindEvents() {
        this.bindViewerEvents();

        this.bindSidebarEvents();

        this.bindZoomEvents();

        this.bindFileExplorerEvents();

        this.bindGridEvents();

        this.bindMinimapEvents();

        this.bindGridControlEvents();
    }

    bindViewerEvents() {
        if (this.dom.viewerContainer)

            this.dom.viewerContainer.addEventListener('wheel', e => {
                if (this.gridMode) return; // grid 모드에서는 팬/줌 비활성화

                this.handleWheel(e);
            }, { passive: false });

        if (this.dom.viewerContainer)

            this.dom.viewerContainer.addEventListener('mousedown', e => {
                if (this.gridMode) return; // grid 모드에서는 팬(이동) 비활성화

                this.handleMouseDown(e);
            });

        // 싱글 이미지 모드에서 우클릭 시 원본 파일을 바로 저장

        if (this.dom.viewerContainer)

            this.dom.viewerContainer.addEventListener('contextmenu', e => {
                if (this.gridMode) return; // 그리드 모드에서는 기존 컨텍스트 사용

                if (!this.selectedImagePath) return;

                e.preventDefault();

                this.showSingleContextMenu(e);
            });

        // 🔥 더블클릭 이벤트: 상세 보기 모드 종료
        if (this.dom.viewerContainer) {
            this.dom.viewerContainer.addEventListener('dblclick', e => {
                if (this.detailMode) {
                    console.log('🖱️ [DBLCLICK] 더블클릭으로 상세 보기 모드 종료');
                    this.exitDetailMode();
                }
            });
        }

        if (this.dom.viewerContainer)

            new ResizeObserver(() => this.handleResize()).observe(this.dom.viewerContainer);
    }

    bindSidebarEvents() {
        if (this.dom.resizer)

            this.dom.resizer.addEventListener('mousedown', e => this.handleSidebarDown(e));

        if (this.dom.resizerRight)

            this.dom.resizerRight.addEventListener('mousedown', e => this.handleRightDown(e));
    }

    bindZoomEvents() {
        if (this.dom.zoomInBtn)

            this.dom.zoomInBtn.addEventListener('click', () => this.zoomAtCenter(ZOOM_FACTOR));

        if (this.dom.zoomOutBtn)

            this.dom.zoomOutBtn.addEventListener('click', () => this.zoomAtCenter(1 / ZOOM_FACTOR));

        if (this.dom.resetViewBtn)

            this.dom.resetViewBtn.addEventListener('click', () => this.resetViewWithAbsoluteOffset());

        if (this.dom.zoom50Btn)

            this.dom.zoom50Btn.addEventListener('click', () => this.setZoom(0.5));

        if (this.dom.zoom100Btn)

            this.dom.zoom100Btn.addEventListener('click', () => this.setZoom(1.0));

        if (this.dom.zoom200Btn)

            this.dom.zoom200Btn.addEventListener('click', () => this.setZoom(2.0));

        if (this.dom.zoom300Btn)

            this.dom.zoom300Btn.addEventListener('click', () => this.setZoom(3.0));
    }

    bindFileExplorerEvents() {
        if (this.dom.fileExplorer) {
            this.dom.fileExplorer.addEventListener('click', e => this.handleFileClick(e));

            this.dom.fileExplorer.addEventListener('contextmenu', e => this.handleFileRightClick(e));

            // 드래그 멀티 선택 초기화

            this.setupFileExplorerDragSelect();
            
            // 🔥 드래그 시각적 피드백 초기화 (Label Explorer와 동일)
            this.setupFileExplorerDragVisualFeedback();
        }
    }

    // Wafer Map Explorer 오른쪽 클릭 처리

    handleFileRightClick(e) {
        e.preventDefault();

        e.stopPropagation(); // 🚀 이벤트 버블링 방지

        this.debugLog('🚀 Wafer Map Explorer 오른쪽 클릭 감지됨');

        // 🔥 진행 중인 썸네일 로드 즉시 중단

        if (this.thumbnailManager) {
            this.thumbnailManager.abortAll();
        }
        
        // 🔥 현재 로딩 중인 이미지 중단
        this.abortCurrentImageLoading();

        // 🔥 모든 선택 상태 완전 초기화 (Grid 모드 포함)

        this.selectedImages = [];

        this.gridSelectedIdxs = [];
        this.gridSelectedSet = new Set();
        this._prevGridSelectedIdxs = new Set();
        this.gridLastClickedIdx = undefined;
        this.gridThumbWraps = [];
        this.invalidateGridGeometry();

        this.selectedFolders = new Set();

        this.lastExplorerClickedIdx = undefined;

        // 🔥 저장된 상태 변수들 초기화
        this.savedViewState = null;
        this.waferMapExplorerState = null;
        this.labelExplorerState = null;

        // 모든 선택 해제

        this.clearWaferMapExplorerSelection();

        // 그리드 모드 숨기기

        this.hideGrid();

        // 단일 이미지 모드도 숨기기

        this.hideImage();

        // 초기 상태로 복귀 - 검색창이 보이는 상태

        this.showInitialState();

        this.debugLog('🚀 Wafer Map Explorer: 오른쪽 클릭으로 모든 선택 해제 및 초기 상태 복귀');
    }

    // 단일 이미지 모드 숨기기

    hideImage() {
        this.debugLog('🔷 [DEBUG] hideImage() 호출됨');

        // 캔버스 숨기기

        if (this.dom.imageCanvas) {
            this.dom.imageCanvas.style.display = 'none';

            this.debugLog('🔷 [DEBUG] imageCanvas 숨김');
        }

        if (this.dom.overlayCanvas) {
            this.dom.overlayCanvas.style.display = 'none';

            this.debugLog('🔷 [DEBUG] overlayCanvas 숨김');
        }

        if (this.dom.minimapContainer) {
            this.dom.minimapContainer.style.display = 'none';

            this.debugLog('🔷 [DEBUG] minimapContainer 숨김');
        }

        // 파일명 표시 숨기기

        this.hideFileName();

        // 뷰어 컨테이너 클래스 제거

        if (this.dom.viewerContainer) {
            this.dom.viewerContainer.classList.remove('single-image-mode');
        }
    }

    // 파일명 표시

    showFileName(path) {
        if (this.dom.fileNameDisplay && this.dom.fileNameText && this.dom.filePathText) {
            const fileName = path.split('/').pop() || path.split('\\').pop() || path;

            this.dom.fileNameText.textContent = fileName;

            // 이미지폴더 root부터 상대경로로 표시

            const relativePath = this.getRelativePathFromImageFolder(path);

            this.dom.filePathText.textContent = relativePath;

            this.dom.fileNameDisplay.style.display = 'block';

            // 상단 바가 보이도록 캔버스 높이는 CSS 변수로 이미 확보됨
        }
    }

    // 이미지폴더 root부터 상대경로 계산

    getRelativePathFromImageFolder(fullPath) {
        if (!this.currentFolderPath) return fullPath;

        try {
            const fullPathObj = new URL(fullPath, 'file://').pathname;
            const currentPathObj = new URL(this.currentFolderPath, 'file://').pathname;

            if (fullPathObj.startsWith(currentPathObj)) {
                return fullPathObj.substring(currentPathObj.length).replace(/^[\/\\]/, '');
            }
        } catch (e) {
            // URL 파싱 실패 시 단순 문자열 처리

            const normalizedFull = fullPath.replace(/\\/g, '/');
            const normalizedCurrent = this.currentFolderPath.replace(/\\/g, '/');

            if (normalizedFull.startsWith(normalizedCurrent)) {
                return normalizedFull.substring(normalizedCurrent.length).replace(/^[\/\\]/, '');
            }
        }

        return fullPath;
    }

    // 현재 경로 업데이트

    async updateCurrentPath() {
        try {
            const response = await fetch('/api/current-folder');
            const data = await response.json();

            this.currentFolderPath = data.current_folder;
            console.log('🔍 [STATE_DEBUG] currentFolderPath 업데이트 (init):', this.currentFolderPath);
            this.currentFolderPrefix = data.current_folder_prefix || '';  // 🔥 파일 경로 접두사 저장

                                    // 하위폴더 목록 업데이트

            await this.updateSubfolderList();
        } catch (error) {
            console.error('현재 경로 업데이트 실패:', error);
        }
    }

    // 하위 폴더 목록 업데이트

    async updateSubfolderList() {
        try {
            // 🔥 loadFolderBrowser에서 이미 cachedProductFolders를 설정했으므로
            // loadSubfoldersFromFileExplorer 호출하여 드롭다운만 업데이트
            await this.loadSubfoldersFromFileExplorer();
        } catch (error) {
            console.error('하위 폴더 목록 업데이트 실패:', error);
        }
    }

    // 🔥 ROOT_DIR 경로 가져오기 (캐시 활용)
    async getRootPath() {
        if (this.cachedRootPath) {
            return this.cachedRootPath;
        }
        
        try {
            const response = await fetch('/api/root-folder');
            if (!response.ok) {
                throw new Error(`Failed to get root folder: ${response.status}`);
            }
            
            const data = await response.json();
            this.cachedRootPath = data.root_folder;
            return this.cachedRootPath;
        } catch (error) {
            console.error('ROOT_DIR 가져오기 실패:', error);
            return null;
        }
    }

    // 파일 탐색기에서 하위 폴더 목록 로드 (항상 이미지 폴더 최상위 기준)

    async loadSubfoldersFromFileExplorer() {
        try {
            // 🔥 이미 cachedProductFolders가 있으면 API 호출 생략하고 재사용
            if (this.cachedProductFolders && this.cachedProductFolders.length > 0) {
                this.debugLog('🔍 [LOAD_SUBFOLDERS] 캐시된 폴더 목록 사용:', this.cachedProductFolders.length, '개');
                // loadFolderBrowser에서 이미 설정된 cachedProductFolders를 재사용
                return;
            }
            
            // 🔥 캐시된 ROOT_DIR 경로 사용
            const imageRootPath = await this.getRootPath();
            if (!imageRootPath) {
                throw new Error('ROOT_DIR을 가져올 수 없습니다');
            }

            const response = await fetch(`/api/browse-folders?path=${encodeURIComponent(imageRootPath)}`);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();

            this.debugLog('Browse folders response:', data); // 디버깅용

            const folders = data.folders || [];

            // 폴더 필터링 (API에서 이미 내림차순 정렬됨)

            const filteredFolders = folders

                .filter(folder => {
                    const name = folder.name;

                    // 1depth: classification, thumbnails, labels 제외

                    if (name === 'classification' || name === 'thumbnails' || name === 'labels') {
                        return false;
                    }

                    // 2depth: classification/*, thumbnails/*, labels/* 제외

                    if (name.startsWith('classification/') || name.startsWith('thumbnails/') || name.startsWith('labels/')) {
                        return false;
                    }

                    return true;
                });
            
            if (this.dom.subfolderSelect) {
                // 현재 선택된 제품명을 유지

                const currentText = this.selectedProductName || '제품 선택';

                this.dom.subfolderSelect.innerHTML = `<option value="">${currentText}</option>`;

                // 최상위 폴더로 가기 옵션 추가

                const rootOption = document.createElement('option');

                rootOption.value = imageRootPath;

                rootOption.textContent = '🏠 최상위 폴더';

                rootOption.style.backgroundColor = '#444';

                rootOption.style.color = '#fff';

                this.dom.subfolderSelect.appendChild(rootOption);

                // 구분선 추가

                const separatorOption = document.createElement('option');

                separatorOption.disabled = true;

                separatorOption.textContent = '──────────────';

                separatorOption.style.color = '#666';

                this.dom.subfolderSelect.appendChild(separatorOption);

                filteredFolders.forEach(folder => {
                    const option = document.createElement('option');

                    // folder.path를 사용 (API에서 반환하는 전체 경로)

                    option.value = folder.path;

                    option.textContent = folder.name;

                    this.dom.subfolderSelect.appendChild(option);
                });

                this.debugLog(`하위 폴더 ${filteredFolders.length}개 로드됨`); // 디버깅용
            }
        } catch (error) {
            console.error('파일 탐색기에서 폴더 로드 실패:', error);
        }
    }

    // 하위 폴더 선택 처리

    async onSubfolderSelect(event) {
        const selectedPath = event.target.value;
        const selectedText = event.target.options[event.target.selectedIndex].text;

        if (!selectedPath) {
            // 기본 선택으로 돌아갔을 때

            this.selectedProductName = null;

            return;
        }

        // 선택된 제품명 저장 (최상위 폴더인 경우 특별 처리)

        if (selectedText === '🏠 최상위 폴더') {
            this.selectedProductName = '최상위 폴더';
        } else {
            this.selectedProductName = selectedText;
        }

        // 폴더 변경

        await this.changeFolder(selectedPath);
    }

    // 제품 검색 입력 처리 (디바운싱 적용)
    handleSubfolderSearch(event) {
        const query = event.target.value.toLowerCase().trim();
        
        // 🔥 디바운싱: 타이핑 중간에 검색하지 않고 마지막 입력 후 100ms 후에 검색
        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(() => {
            this.filterSubfolderOptions(query);
        }, 100);
    }

    // 제품 검색 드롭다운 표시
    showSubfolderDropdown() {
        console.log('🔍 [PRODUCT_DROPDOWN_DEBUG] showSubfolderDropdown 호출됨');
        
        if (this.dom.subfolderDropdown) {
            console.log('🔍 [PRODUCT_DROPDOWN_DEBUG] 드롭다운 표시 중');
            this.dom.subfolderDropdown.style.display = 'block';
            this.populateSubfolderDropdown();
        } else {
            console.warn('🔍 [PRODUCT_DROPDOWN_DEBUG] subfolderDropdown 요소가 없음');
        }
    }

    // 제품 검색 드롭다운 숨기기
    hideSubfolderDropdown() {
        if (this.dom.subfolderDropdown) {
            this.dom.subfolderDropdown.style.display = 'none';
        }
    }

    // 제품 검색 키보드 처리
    handleSubfolderKeydown(event) {
        const dropdown = this.dom.subfolderDropdown;
        if (!dropdown) return;

        // 🔥 보이는 항목만 선택 (필터링된 상태 고려)
        const allItems = Array.from(dropdown.querySelectorAll('.subfolder-item'));
        const visibleItems = allItems.filter(item => item.style.display !== 'none');
        
        if (visibleItems.length === 0) return;

        const currentActive = dropdown.querySelector('.subfolder-item.active');
        let activeIndex = currentActive ? visibleItems.indexOf(currentActive) : -1;

        switch (event.key) {
            case 'ArrowDown':
                event.preventDefault();
                // 활성 항목이 없으면 첫 번째 항목 선택
                if (activeIndex === -1) {
                    activeIndex = 0;
                } else {
                    activeIndex = Math.min(activeIndex + 1, visibleItems.length - 1);
                }
                break;
            case 'ArrowUp':
                event.preventDefault();
                if (activeIndex === -1) {
                    activeIndex = visibleItems.length - 1; // 맨 아래부터
                } else {
                    activeIndex = Math.max(activeIndex - 1, 0);
                }
                break;
            case 'Enter':
                event.preventDefault();
                if (currentActive && visibleItems.includes(currentActive)) {
                    currentActive.click();
                }
                return;
            case 'Escape':
                event.preventDefault();
                this.hideSubfolderDropdown();
                return;
        }

        // 활성 항목 업데이트
        allItems.forEach(item => item.classList.remove('active'));
        if (visibleItems[activeIndex]) {
            visibleItems[activeIndex].classList.add('active');
            // 스크롤하여 활성 항목이 보이도록
            visibleItems[activeIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    // 🔥 제품 폴더 목록 미리 로드 (초기화 시 백그라운드에서 실행)
    async preloadProductFolders() {
        if (this.cachedProductFolders && this.cachedProductFolders.length > 0) {
            return this.cachedProductFolders;
        }
        if (this.productFoldersPromise) {
            return this.productFoldersPromise;
        }
        console.log('🔍 [PRODUCT_PRELOAD] 제품 폴더 미리 로드 시작');
        this.productFoldersPromise = (async () => {
            try {
                const apiUrl = '/api/browse-folders?path=&force_root=true';
                const response = await fetch(apiUrl);
                const data = await response.json();

                if (Array.isArray(data.folders)) {
                    this.cachedProductFolders = data.folders;
                    console.log('🔍 [PRODUCT_PRELOAD] 제품 폴더 미리 로드 완료:', data.folders.length, '개');
                } else {
                    console.warn('🔍 [PRODUCT_PRELOAD] data.folders가 없음');
                    this.cachedProductFolders = this.cachedProductFolders || [];
                }
            } catch (error) {
                console.error('🔍 [PRODUCT_PRELOAD] 제품 폴더 미리 로드 실패:', error);
                this.cachedProductFolders = this.cachedProductFolders || [];
            } finally {
                this.productFoldersPromise = null;
            }
            return this.cachedProductFolders;
        })();
        return this.productFoldersPromise;
    }

    // 제품 검색 드롭다운 채우기
    async populateSubfolderDropdown() {
        console.log('🔍 [PRODUCT_DROPDOWN_DEBUG] populateSubfolderDropdown 호출됨');

        if (!this.dom.subfolderDropdown) {
            console.warn('🔍 [PRODUCT_DROPDOWN_DEBUG] subfolderDropdown 요소가 없음');
            return;
        }

        // 🔥 캐시가 있으면 바로 사용 (API 호출 생략)
        if (this.cachedProductFolders && this.cachedProductFolders.length > 0) {
            console.log('🔍 [PRODUCT_DROPDOWN_DEBUG] 캐시된 폴더 목록 사용:', this.cachedProductFolders.length, '개');
            this.renderSubfolderDropdown(this.cachedProductFolders);
            return;
        }

        // 🔥 캐시가 없으면 preloadProductFolders 대기 (중복 API 호출 방지)
        console.log('🔍 [PRODUCT_DROPDOWN_DEBUG] 캐시 없음 - preloadProductFolders 대기');
        const folders = await this.preloadProductFolders();
        
        if (folders && folders.length > 0) {
            console.log('🔍 [PRODUCT_DROPDOWN_DEBUG] preloadProductFolders 완료:', folders.length, '개');
            this.renderSubfolderDropdown(folders);
            } else {
            console.warn('🔍 [PRODUCT_DROPDOWN_DEBUG] 폴더 목록을 가져올 수 없음');
        }
    }

    // 제품 검색 드롭다운 렌더링
    renderSubfolderDropdown(folders) {
        if (!this.dom.subfolderDropdown) return;

        let html = '';

        // 최상위 폴더 옵션
        html += `
            <div class="subfolder-item" data-path="" data-name="최상위 폴더" style="padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #444;">
                <span style="margin-right: 8px;">🏠</span>최상위 폴더
            </div>
        `;

        // 구분선
        html += '<div style="height: 1px; background: #444; margin: 4px 0;"></div>';

        // 폴더 목록
        folders.forEach(folder => {
            const displayName = folder.name;
            html += `
                <div class="subfolder-item" data-path="${folder.path}" data-name="${displayName}" style="padding: 8px 12px; cursor: pointer; border-bottom: 1px solid #444;">
                    ${displayName}
                </div>
            `;
        });

        this.dom.subfolderDropdown.innerHTML = html;

        // 클릭 이벤트 추가
        this.dom.subfolderDropdown.querySelectorAll('.subfolder-item').forEach(item => {
            item.addEventListener('click', () => {
                const path = item.dataset.path;
                const name = item.dataset.name;
                this.selectSubfolderFromDropdown(path, name);
            });

            // 호버 효과
            item.addEventListener('mouseenter', () => {
                item.style.backgroundColor = '#444';
            });
            item.addEventListener('mouseleave', () => {
                item.style.backgroundColor = '';
            });
        });
    }

    // 드롭다운에서 제품 선택
    async selectSubfolderFromDropdown(path, name) {
        try {
            if (path) {
                await this.changeFolder(path);
            } else {
                await this.goToRootFolder();
            }
            
            // 검색 입력 필드에 선택된 이름 표시
            if (this.dom.subfolderSearch) {
                this.dom.subfolderSearch.value = name;
            }
            
            this.hideSubfolderDropdown();
        } catch (error) {
            console.error('제품 선택 실패:', error);
        }
    }

    // 제품 검색 필터링
    filterSubfolderOptions(query) {
        if (!this.dom.subfolderDropdown) return;

        const items = this.dom.subfolderDropdown.querySelectorAll('.subfolder-item');
        
        // 🔥 빠른 필터링: query가 비어있으면 모든 항목 표시
        if (query === '') {
            items.forEach(item => {
                item.style.display = 'block';
            });
            return;
        }

        // 🔥 최적화된 필터링
        items.forEach(item => {
            const name = item.dataset.name.toLowerCase();
            // startsWith 우선 검사 (더 빠름)
            if (name.startsWith(query) || name.includes(query)) {
                item.style.display = 'block';
            } else {
                item.style.display = 'none';
            }
        });
    }

    // 폴더 변경

    async changeFolder(newPath) {
        try {
            const response = await fetch('/api/change-folder', {
                method: 'POST',

                headers: {
                    'Content-Type': 'application/json',
                },

                body: JSON.stringify({ path: newPath }),
                signal: this.globalAbortController?.signal
            });

            const result = await response.json();

            if (result.success) {
                // 🔥 current_folder 업데이트 (검색 제한용)
                console.log('🔍 [STATE_DEBUG] currentFolderPath 변경 전:', this.currentFolderPath);
                this.currentFolderPath = result.current_folder;
                this.currentFolderPrefix = result.current_folder_prefix || '';
                console.log('🔍 [STATE_DEBUG] currentFolderPath 변경 후 (changeFolder):', this.currentFolderPath);
                console.info('🔍 [CHANGE_FOLDER DEBUG] currentFolderPath:', this.currentFolderPath);
                console.info('🔍 [CHANGE_FOLDER DEBUG] currentFolderPrefix:', this.currentFolderPrefix);

                // 폴더 변경 시 선택된 이미지들과 그리드 상태 초기화

                this.selectedImages = [];

                this.gridSelectedIdxs = [];
                this.gridSelectedSet = new Set();
                this._prevGridSelectedIdxs = new Set();
                this.gridLastClickedIdx = undefined;
                this.gridThumbWraps = [];
        this.invalidateGridGeometry();

                this.selectedImagePath = '';

                // 🔥 모든 캐시 초기화 (제품 선택 시마다)
                console.log('🔍 [CACHE_DEBUG] 제품 선택 시 모든 캐시 삭제 시작');
                await this.clearParCache();
                
                // 추가 캐시 삭제
                if (this.thumbnailManager) {
                    console.log('🔍 [CACHE_DEBUG] 제품 선택 시 썸네일 캐시 삭제:', this.thumbnailManager.cache.size, '개');
                    this.thumbnailManager.cache.clear();
                    this.thumbnailManager.abortAll();
                }
                
                // 클래스 캐시 삭제
                if (this.classToImgListCache) {
                    console.log('🔍 [CACHE_DEBUG] 제품 선택 시 classToImgListCache 삭제:', Object.keys(this.classToImgListCache).length, '개');
                    this.classToImgListCache = {};
                }
                
                console.log('🔍 [CACHE_DEBUG] 제품 선택 시 모든 캐시 삭제 완료');

                // 🔥 상태 변수 초기화 (제품 선택 시)
                console.log('🔍 [STATE_DEBUG] 제품 선택 시 상태 초기화 시작');
                this.savedViewState = null;
                this.waferMapExplorerState = null;
                this.labelExplorerState = null;
                
                // 🔥 Label Explorer 폴더 상태 초기화 (이전 제품의 열린 폴더 상태 제거)
                if (this.labelSelection) {
                    this.labelSelection.openFolders = {};
                    this.labelSelection.selected = [];
                    this.labelSelection.selectedClasses = [];
                }
                
                // 🔥 검색창 텍스트 초기화 (제품 선택 시)
                if (this.dom.fileSearch) {
                    this.dom.fileSearch.value = '';
                }
                if (this.dom.subfolderSearch) {
                    this.dom.subfolderSearch.value = '';
                }
                
                console.log('🔍 [STATE_DEBUG] 제품 선택 시 상태 초기화 완료');

                // 🔥 currentFolderPath 업데이트 완료 후 잠시 대기 (동기화 보장)
                await new Promise(resolve => setTimeout(resolve, 50));

                // 🔥 /api/current-folder 호출하여 서버 상태 업데이트
                try {
                    const response = await fetch('/api/current-folder');
                    const data = await response.json();
                    this.currentFolderPath = data.current_folder;
                    this.currentFolderPrefix = data.current_folder_prefix || '';
                    console.log('🔍 [FOLDER_CHANGE_DEBUG] /api/current-folder 업데이트 완료');
                    
                    // 🔥 폴더 변경 시 클래스 캐시 무효화 (새 폴더의 클래스를 가져오기 위해)
                    this.cachedClassList = null;
                    this.classListPromise = null;
                    console.log('🔍 [FOLDER_CHANGE_DEBUG] 클래스 캐시 무효화');
                } catch (error) {
                    console.error('🔍 [FOLDER_CHANGE_DEBUG] /api/current-folder 업데이트 실패:', error);
                }

                // 🔥 Label Explorer와 Class Manager 새로고침 (제품 선택 시)
                console.log('🔍 [FOLDER_CHANGE_DEBUG] 폴더 변경 후 Label Explorer 새로고침 시작');
                console.log('🔍 [FOLDER_CHANGE_DEBUG] currentFolderPath:', this.currentFolderPath);
                
                try {
                    // refreshLabelExplorer가 내부에서 getClassList() 호출하므로 중복 제거
                    await this.refreshLabelExplorer();
                    console.log('🔍 [FOLDER_CHANGE_DEBUG] Label Explorer 새로고침 완료');
                } catch (error) {
                    console.error('🔍 [FOLDER_CHANGE_DEBUG] Label Explorer 새로고침 실패:', error);
                }

                // 🔥 그리드 화면 완전 초기화 (제품 선택 시, 상단 패널 유지)

                this.hideGrid(false);

                this.hideImage();

                // 🔥 썸네일 캐시 완전 삭제 (404/500 오류 방지)

                if (this.thumbnailManager) {
                    this.thumbnailManager.cache.clear();

                    this.thumbnailManager.abortAll();
                }

                this.loadDirectoryContents(null, this.dom.fileExplorer);

                // 🔥 Wafer Map Explorer 업데이트 (제품 선택 시)
                await this.loadFolderBrowser(this.currentFolderPath);

                // 폴더 변경 메시지 제거
            } else {
                this.showToast('폴더 변경에 실패했습니다.');
            }
        } catch (error) {
            console.error('폴더 변경 실패:', error);

            this.showToast('폴더 변경에 실패했습니다.');
        }
    }

    // 절대경로를 이미지 폴더 기준 상대경로로 변환

    async getRelativePath(absolutePath) {
        try {
            const imageRootPath = await this.getRootPath();
            if (!imageRootPath) {
                return absolutePath.split(/[/\\]/).pop() || 'root';
            }

            const imageRoot = imageRootPath.replace(/\\/g, '/');
                const currentPath = absolutePath.replace(/\\/g, '/');

                // 이미지 폴더명 추출

                const imageFolderName = imageRoot.split('/').pop() || 'root';

                if (currentPath === imageRoot) {
                    return imageFolderName;
                } else if (currentPath.startsWith(imageRoot)) {
                    const relativePath = currentPath.substring(imageRoot.length).replace(/^\//, '');

                    return relativePath ? `${imageFolderName}/${relativePath}` : imageFolderName;
                } else {
                    return imageFolderName;
            }
        } catch (error) {
            console.error('상대경로 변환 실패:', error);
        }

        // 폴백: 경로의 마지막 부분만 반환

        return absolutePath.replace(/\\/g, '/').split('/').pop() || absolutePath;
    }

    // 폴더 브라우저 표시

    async showFolderBrowser() {
        const modal = document.getElementById('folder-browser-modal');

        if (!modal) return;

        modal.style.display = 'flex';

        try {
            // 🔥 캐시된 ROOT_DIR 경로 사용
            const imageRoot = await this.getRootPath();
            if (imageRoot) {
                const input = modal.querySelector('#folder-path-input');

                if (input) {
                    const relativePath = await this.getRelativePath(imageRoot);

                    input.value = relativePath;
                }

                this.currentBrowserPath = imageRoot;

                this.loadFolderBrowser(imageRoot);
            } else {
                // 폴백: 현재 폴더 사용

                const input = modal.querySelector('#folder-path-input');

                if (input) {
                    const relativePath = await this.getRelativePath(this.currentFolderPath || '');

                    input.value = relativePath;
                }

                this.currentBrowserPath = this.currentFolderPath || '';

                this.loadFolderBrowser(this.currentFolderPath);
            }
        } catch (error) {
            console.error('폴더 브라우저 초기화 실패:', error);

            // 폴백: 현재 폴더 사용

            const input = modal.querySelector('#folder-path-input');

            if (input) {
                const relativePath = await this.getRelativePath(this.currentFolderPath || '');

                input.value = relativePath;
            }

            this.currentBrowserPath = this.currentFolderPath || '';

            this.loadFolderBrowser(this.currentFolderPath);
        }
    }

    // 제품 검색 드롭다운 표시
    async showProductSearchDropdown() {
        this.debugLog('🔍 [DEBUG] showProductSearchDropdown 호출됨');
        try {
            // 🔥 캐시된 폴더 목록이 있으면 재사용
            if (this.cachedProductFolders && this.cachedProductFolders.length > 0) {
                this.debugLog('🔍 [DEBUG] 캐시된 폴더 목록 사용:', this.cachedProductFolders.length, '개');
                this.displayProductSearchDropdown(this.cachedProductFolders);
                return;
            }
            
            // 캐시가 없으면 API 호출
            const response = await fetch('/api/browse-folders?path=&force_root=true', {
                signal: this.globalAbortController?.signal
            });
            const data = await response.json();
            
            this.debugLog('🔍 [DEBUG] API 응답:', data.folders?.length, '개 폴더');
            
            if (data.folders && data.folders.length > 0) {
                this.cachedProductFolders = data.folders; // 캐시에 저장
                this.displayProductSearchDropdown(data.folders);
            }
        } catch (error) {
            console.error('제품 목록 로드 실패:', error);
        }
    }

    // 제품 검색 드롭다운 표시
    displayProductSearchDropdown(folders) {
        this.debugLog('🔍 [DEBUG] displayProductSearchDropdown 호출됨, 폴더 수:', folders.length);
        
        // 기존 드롭다운 제거
        this.hideProductSearchDropdown();
        
        // 키보드 탐색 인덱스 초기화
        this.highlightedIndex = -1;
        
        // 드롭다운 컨테이너 생성
        const dropdown = document.createElement('div');
        dropdown.id = 'product-search-dropdown';
        dropdown.style.cssText = `
            position: absolute;
            top: 100%;
            left: 0;
            right: 0;
            background: #2a2a2a;
            border: 1px solid #555;
            border-radius: 4px;
            max-height: 200px;
            overflow-y: auto;
            z-index: 1000;
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
        `;
        
        // 최상위 폴더로 이동 옵션 추가
        const rootItem = document.createElement('div');
        rootItem.style.cssText = `
            padding: 8px 12px;
            cursor: pointer;
            border-bottom: 1px solid #555;
            color: #4CAF50;
            font-weight: bold;
        `;
        rootItem.textContent = '🏠 최상위 폴더로 이동';
        rootItem.addEventListener('mouseenter', () => {
            rootItem.style.backgroundColor = '#444';
        });
        rootItem.addEventListener('mouseleave', () => {
            rootItem.style.backgroundColor = 'transparent';
        });
        rootItem.addEventListener('click', () => {
            this.goToRootFolder();
            this.hideProductSearchDropdown();
        });
        dropdown.appendChild(rootItem);
        
        // 제품 목록 추가
        folders.forEach(folder => {
            const item = document.createElement('div');
            item.style.cssText = `
                padding: 8px 12px;
                cursor: pointer;
                border-bottom: 1px solid #333;
                color: #fff;
            `;
            item.textContent = folder.name;
            item.addEventListener('mouseenter', () => {
                item.style.backgroundColor = '#444';
            });
            item.addEventListener('mouseleave', () => {
                item.style.backgroundColor = 'transparent';
            });
            item.addEventListener('click', () => {
                this.selectProduct(folder.path);
                this.hideProductSearchDropdown();
            });
            dropdown.appendChild(item);
        });
        
        // 입력 필드에 드롭다운 추가
        const inputContainer = this.dom.productSearchInput.parentElement;
        if (inputContainer) {
            inputContainer.style.position = 'relative';
            inputContainer.appendChild(dropdown);
            this.debugLog('🔍 [DEBUG] 드롭다운이 DOM에 추가됨');
        } else {
            console.error('🔍 [DEBUG] inputContainer를 찾을 수 없음');
        }
    }

    // 제품 검색 입력 처리
    handleProductSearchInput(e) {
        const query = e.target.value.toLowerCase();
        
        // 키보드 탐색 인덱스 초기화
        this.highlightedIndex = -1;
        
        // 드롭다운이 있으면 필터링
        const dropdown = document.getElementById('product-search-dropdown');
        if (dropdown) {
            const items = dropdown.querySelectorAll('div');
            items.forEach(item => {
                const text = item.textContent.toLowerCase();
                if (text.includes(query)) {
                    item.style.display = 'block';
                } else {
                    item.style.display = 'none';
                }
            });
        }
    }

    // 제품 검색 키보드 처리
    handleProductSearchKeydown(e) {
        const dropdown = document.getElementById('product-search-dropdown');
        if (!dropdown) return;
        
        const visibleItems = Array.from(dropdown.querySelectorAll('div')).filter(item => 
            item.style.display !== 'none'
        );
        
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            this.highlightedIndex = (this.highlightedIndex + 1) % visibleItems.length;
            this.updateHighlight(visibleItems);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            this.highlightedIndex = this.highlightedIndex <= 0 ? visibleItems.length - 1 : this.highlightedIndex - 1;
            this.updateHighlight(visibleItems);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            if (this.highlightedIndex >= 0 && this.highlightedIndex < visibleItems.length) {
                visibleItems[this.highlightedIndex].click();
            }
        } else if (e.key === 'Escape') {
            this.hideProductSearchDropdown();
        }
    }
    
    // 하이라이트 업데이트
    updateHighlight(visibleItems) {
        // 모든 항목에서 하이라이트 제거
        visibleItems.forEach(item => {
            item.style.backgroundColor = 'transparent';
        });
        
        // 현재 선택된 항목 하이라이트
        if (this.highlightedIndex >= 0 && this.highlightedIndex < visibleItems.length) {
            const selectedItem = visibleItems[this.highlightedIndex];
            selectedItem.style.backgroundColor = '#444';
            
            // 선택된 항목이 보이도록 스크롤
            selectedItem.scrollIntoView({ block: 'nearest' });
        }
    }

    // 제품 검색 Enter 키 처리 (기존 함수 유지)
    handleProductSearchEnter() {
        const query = this.dom.productSearchInput.value.trim();
        if (query) {
            // 첫 번째 매칭되는 제품 선택
            const dropdown = document.getElementById('product-search-dropdown');
            if (dropdown) {
                const visibleItems = Array.from(dropdown.querySelectorAll('div')).filter(item => 
                    item.style.display !== 'none'
                );
                if (visibleItems.length > 0) {
                    visibleItems[0].click();
                }
            }
        }
    }

    // 제품 검색 드롭다운 숨기기
    hideProductSearchDropdown() {
        const dropdown = document.getElementById('product-search-dropdown');
        if (dropdown) {
            dropdown.remove();
        }
    }

    // 제품 선택
    async selectProduct(productPath) {
        try {
            await this.changeFolder(productPath);
            // 제품 선택 후 입력 필드 초기화 및 드롭다운 숨기기
            if (this.dom.productSearchInput) {
                this.dom.productSearchInput.value = '';
            }
            this.hideProductSearchDropdown();
        } catch (error) {
            console.error('제품 선택 실패:', error);
        }
    }

    // 최상위 폴더로 이동
    async goToRootFolder() {
        try {
            this.debugLog('🏠 [DEBUG] 최상위 폴더로 이동');
            
            // 입력 필드 초기화
            if (this.dom.productSearchInput) {
                this.dom.productSearchInput.value = '';
            }
            
            // 🔥 검색창 텍스트 초기화 (최상위 폴더로 이동 시)
            if (this.dom.fileSearch) {
                this.dom.fileSearch.value = '';
            }
            if (this.dom.subfolderSearch) {
                this.dom.subfolderSearch.value = '';
            }
            
            // 선택된 이미지들과 그리드 상태 초기화
            this.selectedImages = [];
            this.gridSelectedIdxs = [];
            this.gridSelectedSet = new Set();
            this._prevGridSelectedIdxs = new Set();
            this.gridLastClickedIdx = undefined;
            this.gridThumbWraps = [];
        this.invalidateGridGeometry();
            this.selectedImagePath = '';
            
            // Label 캐시 초기화 (최상위 폴더로 이동 시)
            this.clearParCache();
            
            // 그리드 모드와 단일 이미지 모드 숨기기
            this.hideGrid();
            this.hideImage();
            
            // API를 통해 ROOT_DIR로 복원
            try {
                // 🔥 캐시된 ROOT_DIR 경로 사용
                const rootPath = await this.getRootPath();
                if (rootPath) {
                    
                    // currentFolderPath 설정
                    console.log('🔍 [STATE_DEBUG] currentFolderPath 변경 전 (goToRootFolder):', this.currentFolderPath);
                    this.currentFolderPath = rootPath;
                    this.currentFolderPrefix = '';  // 🔥 최상위 폴더는 빈 접두사
                    console.log('🔍 [STATE_DEBUG] currentFolderPath 변경 후 (goToRootFolder):', this.currentFolderPath);
                                        const response = await fetch('/api/change-folder', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ path: rootPath }),
                        signal: this.globalAbortController?.signal
                    });
                    
                    if (response.ok) {
                        this.debugLog('🏠 [DEBUG] ROOT_DIR 복원 완료');
                    } else {
                        console.warn('🏠 [DEBUG] ROOT_DIR 복원 실패, 계속 진행');
                    }
                } else {
                    console.warn('🏠 [DEBUG] ROOT_DIR 경로 조회 실패');
                }
            } catch (error) {
                console.warn('🏠 [DEBUG] ROOT_DIR 복원 중 오류:', error);
            }
            
            // 최상위 폴더의 파일 목록 로드
            await this.loadDirectoryContents(null, this.dom.fileExplorer);
            
            // 클래스와 라벨 새로고침 (refreshLabelExplorer가 내부에서 getClassList() 호출)
            await this.refreshLabelExplorer();
            
            // 초기 상태 표시 (상단 패널 포함)
            this.showInitialState();
            
            this.debugLog('🏠 [DEBUG] 최상위 폴더로 이동 완료');
        } catch (error) {
            console.error('최상위 폴더 이동 실패:', error);
        }
    }

    // 폴더 브라우저 이벤트 설정

    setupFolderBrowserEvents() {
        const modal = document.getElementById('folder-browser-modal');

        if (!modal) return;

        // 모달 닫기
        const closeBtn = modal.querySelector('.modal-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                modal.style.display = 'none';
            });
        }

        const cancelBtn = modal.querySelector('#folder-browser-cancel');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                modal.style.display = 'none';
            });
        }

        // 폴더 선택
        const selectBtn = modal.querySelector('#folder-browser-select');
        if (selectBtn) {
            selectBtn.addEventListener('click', async () => {
                if (this.selectedFolderForBrowser) {
                    await this.changeFolder(this.selectedFolderForBrowser);
                    modal.style.display = 'none';
                }
            });
        }

        // 경로 입력으로 이동
        const goToBtn = modal.querySelector('#go-to-folder-btn');
        if (goToBtn) {
            goToBtn.addEventListener('click', () => {
                const pathInput = modal.querySelector('#folder-path-input');
                const path = pathInput?.value.trim();
                if (path) {
                    this.loadFolderBrowser(path);
                }
            });
        }

        // 루트로 이동 (설정된 이미지폴더)

        const rootBtn = modal.querySelector('#folder-root-btn');

        if (rootBtn) {
            rootBtn.addEventListener('click', async () => {
                try {
                    // 🔥 캐시된 ROOT_DIR 경로 사용
                    const imageRoot = await this.getRootPath();
                    if (imageRoot) {

                        this.loadFolderBrowser(imageRoot);

                        const input = modal.querySelector('#folder-path-input');

                        if (input) {
                            const relativePath = await this.getRelativePath(imageRoot);

                            input.value = relativePath;
                        }
                    }
                } catch (error) {
                    console.error('루트 이동 실패:', error);
                }
            });
        }

        // 상위 폴더로 이동 (이미지폴더보다 위로는 제한)

        const upBtn = modal.querySelector('#folder-up-btn');

        if (upBtn) {
            upBtn.addEventListener('click', async () => {
                try {
                    // 🔥 캐시된 ROOT_DIR 경로 사용
                    const imageRootPath = await this.getRootPath();
                    if (!imageRootPath) {
                        console.error('루트 폴더 정보를 가져올 수 없습니다');
                        return;
                    }

                    const imageRoot = imageRootPath.replace(/\\/g, '/');

                    const currentPath = this.currentBrowserPath || '';
                    const current = currentPath.replace(/\\/g, '/');

                    if (!current || current === imageRoot) {
                        // 루트에서는 위로 갈 수 없음 - 아무 변화 없음

                        return;
                    }

                    const parent = current.replace(/\/$/,'').split('/').slice(0,-1).join('/');

                    // 이미지 루트보다 위로는 갈 수 없음

                    if (parent.length < imageRoot.length || !parent.startsWith(imageRoot)) {
                        this.loadFolderBrowser(imageRoot);

                        const input = modal.querySelector('#folder-path-input');

                        if (input) {
                            const relativePath = await this.getRelativePath(imageRoot);

                            input.value = relativePath;
                        }
                    } else {
                        this.loadFolderBrowser(parent);

                        const input = modal.querySelector('#folder-path-input');

                        if (input) {
                            const relativePath = await this.getRelativePath(parent);

                            input.value = relativePath;
                        }
                    }
                } catch (error) {
                    console.error('위로 이동 실패:', error);
                }
            });
        }

        // Enter 키로 이동

        modal.querySelector('#folder-path-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const pathInput = modal.querySelector('#folder-path-input');
                const path = pathInput.value.trim();

                if (path) {
                    this.loadFolderBrowser(path);
                }
            }
        });
    }

    // 폴더 브라우저 로드

    async loadFolderBrowser(path = '') {
        // 썸네일 캐시 삭제
        if (this.thumbnailManager) {
            this.thumbnailManager.cache.clear();
            this.thumbnailManager.abortAll();
        }

        try {
            // path가 없으면 설정된 루트 이미지폴더의 하위폴더들을 가져오기
            if (!path) {
                // 🚀 최적화: /api/root-folder 대신 /api/browse-folders?path=&force_root=true 사용
                // 이미 cachedProductFolders에 있으면 재사용
                if (this.cachedProductFolders && this.cachedProductFolders.length > 0) {
                    this.displayFoldersAsIcons(this.cachedProductFolders);
                    return;
                }
                
                const response = await fetch('/api/browse-folders?path=&force_root=true');
                    const data = await response.json();
                    const folders = (data.folders || [])

                        .filter(folder => 

                            folder.name !== 'classification' && 

                            folder.name !== 'thumbnails' &&

                            folder.name !== 'labels'

                        )

                        .sort((a, b) => b.name.toLowerCase().localeCompare(a.name.toLowerCase()));
                    
                    this.cachedProductFolders = folders;
                    this.displayFoldersAsIcons(folders);

                // 루트 경로 표시
                    const currentFolderText = document.getElementById('current-folder-text');
                    if (currentFolderText) {
                    currentFolderText.textContent = 'root';
                    }

                    this.currentBrowserPath = this.currentFolderPath || '';

                    return;
            }

            const response = await fetch(`/api/browse-folders?path=${encodeURIComponent(path)}`);
            const data = await response.json();
            const folders = data.folders || [];

            folders.sort((a,b)=> (b.name||'').toLowerCase().localeCompare((a.name||'').toLowerCase()));

            this.displayFoldersAsIcons(folders);

            // 현재 경로를 이미지 폴더명부터 표시

            const currentFolderText = document.getElementById('current-folder-text');

            if (currentFolderText) {
                // 🔥 캐시된 ROOT_DIR 경로 사용
                const imageRootPath = await this.getRootPath();
                if (imageRootPath) {
                    const imageRoot = imageRootPath.replace(/\\/g, '/');
                    const currentPath = path.replace(/\\/g, '/');

                    // 이미지 폴더명 추출 (경로의 마지막 부분)

                    const imageFolderName = imageRoot.split('/').pop() || 'root';

                    if (currentPath === imageRoot) {
                        currentFolderText.textContent = imageFolderName;
                    } else if (currentPath.startsWith(imageRoot)) {
                        const relativePath = currentPath.substring(imageRoot.length).replace(/^\//, '');

                        currentFolderText.textContent = relativePath ? `${imageFolderName}/${relativePath}` : imageFolderName;
                    } else {
                        currentFolderText.textContent = imageFolderName;
                    }
                } else {
                    // 폴백: 경로의 마지막 부분만 표시

                    const folderName = path.replace(/\\/g, '/').split('/').pop() || path;

                    currentFolderText.textContent = folderName;
                }
            }

            this.currentBrowserPath = path;
            
        } catch (error) {
            console.error('폴더 브라우저 로드 실패:', error);

            const folderList = document.getElementById('folder-list');

            if (folderList) {
                folderList.innerHTML = '<p style="color: #ff6b6b; text-align: center; padding: 20px;">폴더 로드에 실패했습니다.</p>';
            }
        }
    }

    // 폴더들을 아이콘 방식으로 표시

    displayFoldersAsIcons(folders) {
        const folderList = document.getElementById('folder-list');

        if (!folderList) return;

        folderList.innerHTML = '';

        if (folders.length === 0) {
            folderList.innerHTML = '<p style="color: var(--text-secondary-color); text-align: center; padding: 20px;">폴더가 없습니다.</p>';

            return;
        }

        // 그리드 레이아웃으로 아이콘 표시

        folderList.style.cssText = `

            display: grid;

            grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));

            gap: 12px;

            padding: 10px;

        `;

        folders.forEach(folder => {
            const folderItem = document.createElement('div');

            folderItem.className = 'folder-item';

            folderItem.style.cssText = `

                display: flex;

                flex-direction: column;

                align-items: center;

                padding: 16px 8px;

                background: var(--panel-color);

                border-radius: 8px;

                cursor: pointer;

                border: 2px solid transparent;

                transition: all 0.2s ease;

                text-align: center;

                min-height: 80px;

                justify-content: center;

            `;

            folderItem.innerHTML = `

                <div style="font-size: 32px; margin-bottom: 8px;">📁</div>

                <div style="font-size: 12px; font-weight: bold; word-break: break-word; line-height: 1.2;">${folder.name}</div>

            `;

            const openFolder = () => {
                // 이전 선택 제거

                folderList.querySelectorAll('.folder-item').forEach(item => {
                    item.style.background = 'var(--panel-color)';

                    item.style.borderColor = 'transparent';
                });

                // 현재 선택 표시

                folderItem.style.background = 'var(--accent-color)';

                folderItem.style.borderColor = 'var(--hover-color)';

                this.selectedFolderForBrowser = folder.path || (this.currentFolderPath ? `${(this.currentFolderPath.replace(/\\/g,'/')).replace(/\/$/,'')}/${folder.name}` : folder.name);

                // 더블클릭 시 즉시 해당 폴더로 들어가서 하위 폴더 표시

                this.loadFolderBrowser(this.selectedFolderForBrowser);

                const input = document.getElementById('folder-path-input');

                if (input) {
                    this.getRelativePath(this.selectedFolderForBrowser).then(relativePath => {
                        input.value = relativePath;
                    });
                }
            };

            folderItem.addEventListener('click', openFolder);

            folderItem.addEventListener('dblclick', async () => {
                this.selectedFolderForBrowser = folder.path || (this.currentFolderPath ? `${(this.currentFolderPath.replace(/\\/g,'/')).replace(/\/$/,'')}/${folder.name}` : folder.name);

                await this.changeFolder(this.selectedFolderForBrowser);

                const modal = document.getElementById('folder-browser-modal');

                if (modal) modal.style.display = 'none';
            });

            folderItem.addEventListener('mouseenter', () => {
                if (folderItem.style.background !== 'var(--accent-color)') {
                    folderItem.style.background = 'var(--hover-color)';
                }
            });

            folderItem.addEventListener('mouseleave', () => {
                if (folderItem.style.background !== 'var(--accent-color)') {
                    folderItem.style.background = 'var(--panel-color)';
                }
            });

            folderList.appendChild(folderItem);
        });
    }

    // 파일명 표시 숨기기

    hideFileName() {
        if (this.dom.fileNameDisplay) {
            this.dom.fileNameDisplay.style.display = 'none';
        }

        // 줌 바 숨기기 (이미지가 없을 때는 불필요)

        const viewControls = document.querySelector('.view-controls');

        if (viewControls) {
            viewControls.style.display = 'none';
        }

        // 현재 이미지 정리

        this.currentImage = null;

        this.currentImageBitmap = null;

        this.selectedImagePath = '';
    }

    // 초기 상태 표시 (검색창과 상단 컨트롤만 보이는 상태)

    showInitialState() {
        // 🔥 미니맵과 이미지 캔버스 숨기기 (초기 상태에서는 보이지 않아야 함)

        if (this.dom.minimapContainer) {
            this.dom.minimapContainer.style.display = 'none';
        }

        if (this.dom.imageCanvas) {
            this.dom.imageCanvas.style.display = 'none';
        }

        if (this.dom.overlayCanvas) {
            this.dom.overlayCanvas.style.display = 'none';
        }

        // 그리드 컨트롤 표시

        const gridControls = document.getElementById('grid-controls');

        if (gridControls) {
            gridControls.style.display = 'flex';
        }

        // 뷰어 컨테이너를 그리드 모드로 설정하되 빈 상태

        if (this.dom.viewerContainer) {
            this.dom.viewerContainer.classList.add('grid-mode');

            this.dom.viewerContainer.classList.remove('single-image-mode');
        }

        // 빈 그리드 표시 (검색 안내 메시지)

        const grid = document.getElementById('image-grid');

        if (grid) {
            grid.style.display = 'grid'; // 🔥 그리드 표시

            grid.innerHTML = `

                <div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #888;">

                    <p style="font-size: 16px; margin-bottom: 8px;">파일을 선택하거나 검색해보세요</p>

                    <p style="font-size: 14px; opacity: 0.7;">Wafer Map Explorer에서 파일/폴더를 클릭하거나 상단 검색창을 이용하세요</p>

                </div>

            `;
        }

        // 줌 바 숨기기 (초기 상태에서는 불필요)

        const viewControls = document.querySelector('.view-controls');

        if (viewControls) {
            viewControls.style.display = 'none';
        }

        // 커서 초기화

        if (this.dom.viewerContainer) {
            this.dom.viewerContainer.style.cursor = 'default';
        }

        this.debugLog('🔷 초기 상태 표시 완료 - 미니맵 숨김');
    }

    bindGridEvents() {
        const grid = document.getElementById('image-grid');
        const scrollWrapper = grid?.parentElement;

        if (!grid || !scrollWrapper) return;

        // 드래그 오버레이 생성 또는 가져오기

        let dragOverlay = document.getElementById('grid-drag-select');

        if (!dragOverlay) {
            dragOverlay = document.createElement('div');

            dragOverlay.id = 'grid-drag-select';

            dragOverlay.style.cssText = `

                position: absolute;

                display: none;

                background: rgba(0, 153, 255, 0.2);

                border: 2px solid #09f;

                border-radius: 3px;

                pointer-events: none;

                z-index: 1000;

                box-sizing: border-box;

            `;

            scrollWrapper.appendChild(dragOverlay);

            this.debugLog('드래그 오버레이 생성 및 추가됨');
        }

        // 드래그 오버레이가 올바른 부모에 있는지 확인

        if (dragOverlay.parentElement !== scrollWrapper) {
            scrollWrapper.appendChild(dragOverlay);

            this.debugLog('드래그 오버레이를 스크롤 래퍼로 이동');
        }

        grid.addEventListener('wheel', e => {
            if (!this.gridMode) return;

            if (e.ctrlKey) {
                e.preventDefault();

                let newCols = this.gridCols - Math.sign(e.deltaY);

                newCols = Math.max(1, Math.min(10, newCols));

                this.gridCols = newCols;

                const gridColsRange = document.getElementById('grid-cols-range');

                if(gridColsRange) gridColsRange.value = newCols.toString();

                document.documentElement.style.setProperty('--grid-cols', newCols.toString());

                if (this.selectedImages && this.selectedImages.length > 1) {
                    this.scheduleShowGrid();
                }
            } else if (e.shiftKey) {
                e.preventDefault();

                scrollWrapper.scrollLeft += e.deltaY;
            }
        }, { passive: false });

        // 드래그 상태 변수

        let dragData = {
            start: null,

            selecting: false,

            active: false,

            startTime: 0
        };

        // 좌표 변환 유틸리티 함수들

        const getScrollAdjustedCoords = (clientX, clientY) => {
            if (!scrollWrapper) return null;
            const rect = scrollWrapper.getBoundingClientRect();

            return {
                x: clientX - rect.left + scrollWrapper.scrollLeft,

                y: clientY - rect.top + scrollWrapper.scrollTop
            };
        };

        const getViewportCoords = (clientX, clientY) => {
            if (!scrollWrapper) return null;
            const rect = scrollWrapper.getBoundingClientRect();

            return {
                x: clientX - rect.left,

                y: clientY - rect.top
            };
        };

        // 드래그 박스 업데이트 함수 (성능 최적화)

        const updateDragBox = (startCoords, currentCoords) => {
            const left = Math.min(startCoords.x, currentCoords.x);
            const top = Math.min(startCoords.y, currentCoords.y);
            const width = Math.abs(currentCoords.x - startCoords.x);
            const height = Math.abs(currentCoords.y - startCoords.y);

            // 한번에 스타일 업데이트 (reflow 최소화)

            dragOverlay.style.cssText = `

                position: absolute;

                display: block;

                left: ${left}px;

                top: ${top}px;

                width: ${width}px;

                height: ${height}px;

                background: rgba(0, 153, 255, 0.2);

                border: 2px solid #09f;

                border-radius: 3px;

                pointer-events: none;

                z-index: 1000;

                box-sizing: border-box;

                will-change: transform;

            `;

            return { left, top, width, height };
        };

        // 마우스 다운 이벤트 - 드래그 준비

        scrollWrapper.addEventListener('mousedown', e => {
            if (!this.gridMode || e.button !== 0) return;

            e.preventDefault();

            e.stopPropagation();

            // 드래그 데이터 초기화

            dragData.startTime = Date.now();

            dragData.selecting = true;

            dragData.active = false;

            const startCoords = getScrollAdjustedCoords(e.clientX, e.clientY);
            if (!startCoords) {
                dragData.selecting = false;
                return;
            }
            dragData.start = startCoords;

            // 마우스 추적 시작

            startMouseTracking();

            document.body.style.userSelect = 'none';
        });

        // 마우스 움직임 이벤트 - 드래그 처리 (쓰로틀링 적용)

        let mouseMoveTimeoutId = null;

        document.addEventListener('mousemove', e => {
            if (!dragData.selecting || !dragData.start) return;

            // 쓰로틀링: 16ms마다 처리 (60fps)

            if (mouseMoveTimeoutId) return;

            mouseMoveTimeoutId = requestAnimationFrame(() => {
                mouseMoveTimeoutId = null;

                const currentCoords = getScrollAdjustedCoords(e.clientX, e.clientY);
                if (!currentCoords || !dragData.start || dragData.start.x === undefined || dragData.start.y === undefined) {
                    return;
                }

                const dragDistance = Math.abs(currentCoords.x - dragData.start.x) + Math.abs(currentCoords.y - dragData.start.y);

                // 최소 드래그 거리를 넘으면 드래그 박스 표시 시작

                if (!dragData.active && dragDistance > MIN_DRAG_DISTANCE) {
                    dragData.active = true;

                    // 🔥 그리드 드래그 선택 시에만 crosshair 커서 사용
                    if (!document.body.style.cursor || document.body.style.cursor === '') {
                        document.body.style.cursor = 'crosshair';
                    }

                    // 드래그 박스 초기 표시

                    dragOverlay.style.cssText = `

                        position: absolute;

                        display: block;

                        left: ${dragData.start.x}px;

                        top: ${dragData.start.y}px;

                        width: 0px;

                        height: 0px;

                        background: rgba(0, 153, 255, 0.2);

                        border: 2px solid #09f;

                        border-radius: 3px;

                        pointer-events: none;

                        z-index: 1000;

                        box-sizing: border-box;

                        will-change: transform;

                    `;
                }

                // 드래그가 활성화된 경우 박스 업데이트

                if (dragData.active) {
                    e.preventDefault();

                    updateDragBox(dragData.start, currentCoords);
                }
            });
        }, { passive: false });

        // 썸네일과 드래그 영역의 교차 검사 함수

        const findIntersectingThumbnails = (dragLeft, dragTop, dragRight, dragBottom) => {
            const wraps = (Array.isArray(this.gridThumbWraps) && this.gridThumbWraps.length > 0)
                ? this.gridThumbWraps
                : Array.from(grid.querySelectorAll('.grid-thumb-wrap'));
            if (!Array.isArray(this.gridThumbWraps) || this.gridThumbWraps.length === 0) {
                this.gridThumbWraps = wraps;
            }
            if (!wraps || wraps.length === 0) {
                return [];
            }

            let layout = this.gridLayoutCache;
            if (!layout || !layout.cellWidth) {
                layout = this.computeGridLayoutFromDom(grid, wraps);
            }

            const scrollRect = scrollWrapper.getBoundingClientRect();
            if (!Array.isArray(this.gridThumbRectCache) || this.gridThumbRectCache.length !== wraps.length) {
                this.gridThumbRectCache = new Array(wraps.length);
            }
            const rectCache = this.gridThumbRectCache;
            const resolveRect = (cell, idx) => {
                if (!cell) {
                    return null;
                }
                let cached = rectCache[idx];
                if (!cached) {
                    const domRect = cell.getBoundingClientRect();
                    cached = {
                        left: domRect.left - scrollRect.left + scrollWrapper.scrollLeft,
                        right: domRect.right - scrollRect.left + scrollWrapper.scrollLeft,
                        top: domRect.top - scrollRect.top + scrollWrapper.scrollTop,
                        bottom: domRect.bottom - scrollRect.top + scrollWrapper.scrollTop
                    };
                    rectCache[idx] = cached;
                }
                return cached;
            };

            if (layout && layout.cellWidth) {
                const { cellWidth, cellHeight, gapX, gapY, paddingLeft, paddingTop, cols } = layout;
                const totalItems = wraps.length;
                if (!cols || totalItems === 0) {
                    return [];
                }
                const strideX = cellWidth + gapX;
                const strideY = cellHeight + gapY;
                const rows = Math.ceil(totalItems / cols);
                const adjustedLeft = dragLeft - paddingLeft;
                const adjustedRight = dragRight - paddingLeft;
                const adjustedTop = dragTop - paddingTop;
                const adjustedBottom = dragBottom - paddingTop;
                const rawStartCol = Math.floor(adjustedLeft / strideX);
                const rawEndCol = Math.floor(adjustedRight / strideX);
                const rawStartRow = Math.floor(adjustedTop / strideY);
                const rawEndRow = Math.floor(adjustedBottom / strideY);

                if (rawEndCol < 0 || rawEndRow < 0 || rawStartCol >= cols || rawStartRow >= rows) {
                    return [];
                }

                const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
                const startCol = clamp(rawStartCol, 0, cols - 1);
                const endCol = clamp(rawEndCol, 0, cols - 1);
                const startRow = clamp(rawStartRow, 0, rows - 1);
                const endRow = clamp(rawEndRow, 0, rows - 1);
                const result = [];
                for (let row = startRow; row <= endRow; row += 1) {
                    const base = row * cols;
                    for (let col = startCol; col <= endCol; col += 1) {
                        const idx = base + col;
                        if (idx >= totalItems) {
                            break;
                        }
                        const cell = wraps[idx];
                        const rect = resolveRect(cell, idx);
                        if (!rect) {
                            continue;
                        }
                        if (dragRight >= rect.left && dragLeft <= rect.right && dragBottom >= rect.top && dragTop <= rect.bottom) {
                            result.push(idx);
                        }
                    }
                }
                return result;
            }

            const fallback = [];
            for (let idx = 0; idx < wraps.length; idx += 1) {
                const cell = wraps[idx];
                const rect = resolveRect(cell, idx);
                if (!rect) {
                    continue;
                }
                if (dragRight >= rect.left && dragLeft <= rect.right && dragBottom >= rect.top && dragTop <= rect.bottom) {
                    fallback.push(idx);
                }
            }
            return fallback;
        };

        const handleTapSelection = (event) => {
            const thumbWrap = event.target.closest('.grid-thumb-wrap');
            if (thumbWrap) {
                // 🔥 성능 최적화: data-index 사용 (indexOf 제거)
                const idx = parseInt(thumbWrap.dataset.index, 10);
                if (!isNaN(idx)) {
                    this.toggleGridImageSelect(idx, event);
                }
            } else if (!event.ctrlKey && !event.metaKey) {
                this.clearGridSelection();
            }
        };

        // ���콺�� �̺�Ʈ - �巡�� �Ϸ� �� ���� ó��

        const onMouseUp = (e) => {
            if (!dragData.selecting) return;

            // 상태 초기화

            const wasActive = dragData.active;

            dragData.selecting = false;

            dragData.active = false;

            document.body.style.userSelect = '';

            // 🔥 그리드 드래그 선택이 끝날 때만 커서 복원 (다른 드래그가 활성화되어 있지 않은 경우)
            if (document.body.style.cursor === 'crosshair') {
                document.body.style.cursor = '';
            }

            dragOverlay.style.display = 'none';

            // 마우스 추적 중지

            stopMouseTracking();

            // 단순 클릭인 경우 (드래그 박스가 활성화되지 않음)
            if (!wasActive) {
                handleTapSelection(e);
                dragData.start = null;
                return;
            }

            // 드래그 선택 처리

            if (!dragData.start) {
                console.warn('드래그 시작점이 없습니다.');

                return;
            }

            const currentCoords = getScrollAdjustedCoords(e.clientX, e.clientY);

            // 드래그 영역 계산

            const dragLeft = Math.min(dragData.start.x, currentCoords.x);
            const dragTop = Math.min(dragData.start.y, currentCoords.y);
            const dragRight = Math.max(dragData.start.x, currentCoords.x);
            const dragBottom = Math.max(dragData.start.y, currentCoords.y);

            // 최소 드래그 거리 검사

            const dragWidth = dragRight - dragLeft;
            const dragHeight = dragBottom - dragTop;
            const dragIntentThreshold = this.gridDragIntentThreshold || GRID_DRAG_CLICK_THRESHOLD;

            if (Math.max(dragWidth, dragHeight) <= dragIntentThreshold) {
                handleTapSelection(e);
                dragData.start = null;
                return;
            }

            // 교차하는 썸네일 찾기

            const newIdxs = findIntersectingThumbnails(dragLeft, dragTop, dragRight, dragBottom);
            this.ensureGridSelectionStructures();

            if (e.ctrlKey) {
                const added = [];
                const removed = [];
                newIdxs.forEach(idx => {
                    if (this.gridSelectedSet.has(idx)) {
                        this.gridSelectedSet.delete(idx);
                        removed.push(idx);
                        this.removeIndexSorted(this.gridSelectedIdxs, idx);
                    } else {
                        this.gridSelectedSet.add(idx);
                        added.push(idx);
                        this.insertIndexSorted(this.gridSelectedIdxs, idx);
                    }
                });
                // 항상 UI 업데이트 호출 (드래그 선택 후 즉시 반영)
                this.updateGridSelection();
            } else {
                const prevSet = this.gridSelectedSet ? new Set(this.gridSelectedSet) : new Set();
                const newSet = new Set(newIdxs);
                const added = [];
                newSet.forEach(idx => {
                    if (!prevSet.has(idx)) {
                        added.push(idx);
                    }
                });
                const removed = [];
                prevSet.forEach(idx => {
                    if (!newSet.has(idx)) {
                        removed.push(idx);
                    }
                });
                this.gridSelectedSet = newSet;
                this.gridSelectedIdxs = Array.from(newSet).sort((a, b) => a - b);
                // 항상 UI 업데이트 호출 (드래그 선택 후 즉시 반영)
                this.updateGridSelection();
            }
            if (newIdxs.length > 0) {
                this.gridLastClickedIdx = newIdxs[newIdxs.length - 1];
            }

            dragData.start = null;

            // 정리

            dragData.start = null;
        };

        // 이벤트 리스너 등록

        document.addEventListener('mouseup', onMouseUp);

        // 스크롤 중 드래그 박스 위치 실시간 업데이트 (디바운싱)

        let scrollTimeoutId = null;

        scrollWrapper.addEventListener('scroll', () => {
            if (!dragData.active || !dragData.start || dragOverlay.style.display !== 'block') return;

            // 스크롤 중 임시로 투명도 감소

            dragOverlay.style.opacity = '0.5';

            // 디바운싱: 스크롤 종료 후 위치 업데이트

            if (scrollTimeoutId) clearTimeout(scrollTimeoutId);

            scrollTimeoutId = setTimeout(() => {
                const lastMouseEvent = window.lastMouseEvent;

                if (lastMouseEvent && dragData.active) {
                    const currentCoords = getScrollAdjustedCoords(lastMouseEvent.clientX, lastMouseEvent.clientY);

                    updateDragBox(dragData.start, currentCoords);

                    dragOverlay.style.opacity = '1';
                }
            }, 50);
        }, { passive: true });

        // 마우스 이벤트 최적화 - 드래그 중에만 위치 추적

        let mouseTracker = null;
        const startMouseTracking = () => {
            if (!mouseTracker) {
                mouseTracker = (e) => { window.lastMouseEvent = e; };

                document.addEventListener('mousemove', mouseTracker, { passive: true });
            }
        };

        const stopMouseTracking = () => {
            if (mouseTracker) {
                document.removeEventListener('mousemove', mouseTracker);

                mouseTracker = null;

                window.lastMouseEvent = null;
            }
        };

         // 키보드 단축키 (grid 모드에서만)

        document.addEventListener('keydown', (e) => {
            if (!this.gridMode) return;

            if (e.key === 'Escape') {
                this.clearGridSelection();

                e.preventDefault();
            } else if (e.ctrlKey && (e.key === 'a' || e.key === 'A')) {
                this.selectAllGridImages();

                e.preventDefault();
            }
        });
    }

    bindMinimapEvents() {
        if (this.dom.minimapCanvas) {
            this.dom.minimapCanvas.addEventListener('click', e => this.handleMinimapClick(e));
        }

        // 뷰포트 드래그 기능 추가

        if (this.dom.minimapViewport) {
            this.dom.minimapViewport.addEventListener('mousedown', e => this.handleViewportDragStart(e));
        }

        // 바운드 함수들 추가

        this.boundHandleViewportDrag = this.handleViewportDrag.bind(this);

        this.boundHandleViewportDragEnd = this.handleViewportDragEnd.bind(this);
    }

    bindGridControlEvents() {
        const gridZoom = document.getElementById('grid-zoom-range');

        if (gridZoom) {
            gridZoom.addEventListener('input', e => {
                this.gridThumbSize = parseInt(e.target.value, 10);

                document.documentElement.style.setProperty('--thumb-size', this.gridThumbSize + 'px');
            });
        }

        const gridSelectAll = document.getElementById('grid-select-all');

        if (gridSelectAll) {
            gridSelectAll.onclick = () => {
                if (this.selectedImages) {
                    this.selectAllGridImages();
                }
            };
        }

        const gridDeselectAll = document.getElementById('grid-deselect-all');

        if (gridDeselectAll) {
            gridDeselectAll.onclick = () => {
                this.clearGridSelection();
            };
        }

        // 🔥 Wafer Map Explorer 버튼 클릭 이벤트 (하드 새로고침 + 캐시 삭제)
        const resetExplorerBtn = document.getElementById('reset-explorer-btn');
        if (resetExplorerBtn) {
            resetExplorerBtn.onclick = () => {
                this.hardRefreshWithCacheClear();
            };
        }

        // 🔥 캐시 초기화 버튼

        const clearCacheBtn = document.getElementById('clear-cache-btn');

        if (clearCacheBtn) {
            clearCacheBtn.onclick = () => {
                this.clearAllCache();
            };
        }

        const gridColsRange = document.getElementById('grid-cols-range');

        if (gridColsRange) {
            gridColsRange.addEventListener('input', e => {
                this.gridCols = parseInt(e.target.value, 10);

                document.documentElement.style.setProperty('--grid-cols', this.gridCols);

                if (this.selectedImages && this.selectedImages.length > 1) {
                    this.scheduleShowGrid();
                }
            });
        }

        const minusBtn = document.getElementById('grid-cols-minus');
        const plusBtn = document.getElementById('grid-cols-plus');

        if (minusBtn) {
            minusBtn.onclick = () => {
                this.gridCols = Math.max(1, this.gridCols - 1);

                document.getElementById('grid-cols-range').value = this.gridCols;

                document.documentElement.style.setProperty('--grid-cols', this.gridCols);

                if (this.selectedImages && this.selectedImages.length > 1) {
                    this.scheduleShowGrid();
                }
            };
        }

        if (plusBtn) {
            plusBtn.onclick = () => {
                this.gridCols = Math.min(10, this.gridCols + 1);

                document.getElementById('grid-cols-range').value = this.gridCols;

                document.documentElement.style.setProperty('--grid-cols', this.gridCols);

                if (this.selectedImages && this.selectedImages.length > 1) {
                    this.scheduleShowGrid();
                }
            };
        }

        // 파일명 검색 기능 이벤트 리스너

        if (this.dom.searchBtn) {
            this.dom.searchBtn.addEventListener('click', () => this.performSearch());
        }

        if (this.dom.fileSearch) {
            this.dom.fileSearch.addEventListener('keydown', e => {
                if (e.key === 'Enter') this.performSearch();
            });
        }
        
    }

    /**
     * Initial application entry point.
     */

    async init() {
        this._drawScheduled = false; // draw() 스케줄링 플래그

        // 🔥 초기화 시 병렬 작업 시작
        const backgroundInitTasks = [
            this.loadServerConfig(),
            this.loadUserInfo()
        ];

        if (this.dom.fileExplorer) {
            this.dom.fileExplorer.innerHTML = '';
        }

        // 먼저 이미지 폴더 최상위로 이동

        try {
            // 🔥 초기화 시 currentFolderPath를 ROOT_DIR로 설정
            const rootPath = await this.getRootPath();
            if (rootPath) {
                this.currentFolderPath = rootPath;
                this.currentFolderPrefix = '';
                this.debugLog('🔍 [INIT] ROOT_DIR로 초기화:', rootPath);
            }
            
            // 🔥 resetToImageFolder는 이미 ROOT_DIR이므로 불필요한 API 호출 스킵
            // await this.resetToImageFolder();

            // 🔥 초기화 작업들을 병렬로 실행 (UI 블로킹 최소화)
            const [serverData, folderBrowserResult] = await Promise.all([
                // loadFolderBrowser와 current-folder를 병렬로 처리
                (async () => {
                    const response = await fetch('/api/current-folder');
                    return await response.json();
                })(),
                // 1순위: Wafer Map Explorer 폴더 목록과 제품 선택 폴더 최우선 로딩
                // 🔥 초기화 시에는 빈 문자열로 ROOT_DIR의 하위 폴더만 가져오기 (force_root=true 사용)
                this.loadFolderBrowser('')
            ]);

            // 🔥 current folder 확인 및 ROOT_DIR로 강제 변경
            try {
                const serverCurrentPath = serverData.current_folder;
                
                // 🔥 서버의 현재 폴더가 ROOT_DIR과 다르면 강제로 ROOT_DIR로 변경
                if (rootPath && serverCurrentPath !== rootPath) {
                    console.log('🔍 [INIT] 서버가 ROOT_DIR이 아닌 폴더에 있음. ROOT_DIR로 강제 변경:', serverCurrentPath, '->', rootPath);
                    
                    const changeFolderResponse = await fetch('/api/change-folder', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: rootPath })
                    });
                    
                    if (changeFolderResponse.ok) {
                        console.log('🔍 [INIT] ROOT_DIR로 강제 변경 완료');
                        this.currentFolderPath = rootPath;
                        this.currentFolderPrefix = '';
                    } else {
                        console.warn('🔍 [INIT] ROOT_DIR로 강제 변경 실패, 서버 상태 유지');
                        this.currentFolderPath = serverCurrentPath;
                        this.currentFolderPrefix = serverData.current_folder_prefix || '';
                    }
                } else {
                    this.currentFolderPath = serverCurrentPath;
                    this.currentFolderPrefix = serverData.current_folder_prefix || '';
                }
                
                console.log('🔍 [INIT] currentFolderPath 최종:', this.currentFolderPath);
            } catch (error) {
                console.error('🔍 [INIT] current folder 확인 실패:', error);
            }

            this.showInitialState();

            // 🔥 2순위: File Explorer 로딩은 백그라운드로 실행
            if (this.dom.fileExplorer) {
                this.loadDirectoryContents(null, this.dom.fileExplorer).catch(err => {
                    console.error('[INIT] File Explorer 로딩 실패:', err);
                });
            }
        } catch (error) {
            console.error('[INIT] Explorer preload failed:', error);
        }

        // 🔥 3순위: 중요한 초기화 작업들을 병렬로 실행 (하지만 백그라운드)
        // loadFolderBrowser 이후에 백그라운드로 실행되어 UI 블로킹 없음
        const initTasks = [
            this.initClassification().catch(err => console.error('[INIT] Classification 초기화 실패:', err))
        ];
        
        // 🔥 refreshLabelExplorer는 즉시 실행하여 fail list 표시
        console.log('🔍 [INIT_DEBUG] Label Explorer 즉시 초기화 시작');
        try {
            await this.refreshLabelExplorer();
            console.log('🔍 [INIT_DEBUG] Label Explorer 초기화 완료');
            
            // 🔥 추가: fail list 표시를 위해 updateLabelExplorerContent 호출
            console.log('🔍 [INIT_DEBUG] Label Explorer 내용 업데이트 시작');
            this.updateLabelExplorerContent();
            console.log('🔍 [INIT_DEBUG] Label Explorer 내용 업데이트 완료');
        } catch (err) {
            console.error('[INIT] Label Explorer 초기화 실패:', err);
        }
        
        // 나머지 작업들은 병렬로 실행하되 에러 발생 시에도 다른 작업은 계속 진행
        Promise.allSettled(initTasks);
        
        // 🔥 updateSubfolderList는 loadFolderBrowser 이후에 캐시가 설정되었으므로 백그라운드로 실행
        this.updateSubfolderList().catch(err => console.error('[INIT] Subfolder 업데이트 실패:', err));
    }

    // 🔥 서버 설정 로드 (피라미드 레벨, zoom 기준 등)
    async loadServerConfig() {
        try {
            const response = await fetch('/api/config');
            if (!response.ok) {
                console.warn('[CONFIG] 서버 설정 로드 실패, 기본값 사용');
                return;
            }
            const config = await response.json();

            // 서버에서 받은 설정으로 업데이트
            if (config.PYRAMID_LEVELS && Array.isArray(config.PYRAMID_LEVELS)) {
                SERVER_CONFIG.PYRAMID_LEVELS = config.PYRAMID_LEVELS;
            }
            if (config.PYRAMID_ZOOM_THRESHOLDS && Array.isArray(config.PYRAMID_ZOOM_THRESHOLDS)) {
                SERVER_CONFIG.PYRAMID_ZOOM_THRESHOLDS = config.PYRAMID_ZOOM_THRESHOLDS;
            }
            if (typeof config.THUMB_BATCH_SIZE === "number") {
                THUMB_BATCH_SIZE = Math.max(1, Math.floor(config.THUMB_BATCH_SIZE));
                SERVER_CONFIG.THUMB_BATCH_SIZE = THUMB_BATCH_SIZE;
            }
            if (typeof config.THUMB_MAX_CONCURRENCY === "number") {
                SERVER_CONFIG.THUMB_MAX_CONCURRENCY = Math.max(1, Math.floor(config.THUMB_MAX_CONCURRENCY));
                if (this.thumbnailManager) {
                    this.thumbnailManager.setMaxConcurrentLoads(SERVER_CONFIG.THUMB_MAX_CONCURRENCY);
                }
            }

            console.log('[CONFIG] 서버 설정 로드 완료:', SERVER_CONFIG);
        } catch (error) {
            console.warn('[CONFIG] 서버 설정 로드 오류, 기본값 사용:', error);
        }
    }

    // 사용자 정보 로드 및 표시
    async loadUserInfo() {
        try {
            const userInfoEl = document.getElementById('user-info');
            if (!userInfoEl) return;

            let displayed = false;

            if (initialSamlSuccess && initialLoginIdFromUrl && initialUsernameFromUrl) {
                const newInfo = `${initialLoginIdFromUrl}(${initialUsernameFromUrl})`;
                console.log('[DEBUG] SAML 정보:', {
                    initialLoginIdFromUrl,
                    initialUsernameFromUrl,
                    initialDeptNameFromUrl,
                    currentHTML: userInfoEl.innerHTML
                });

                if (!userInfoEl.innerHTML.includes(newInfo)) {
                    userInfoEl.innerHTML = `
                        <div style="font-weight: 600;">${initialLoginIdFromUrl}(${initialUsernameFromUrl})</div>
                        <div style="font-size: 10px; color: #666;">${initialDeptNameFromUrl || 'Anonymous'}</div>
                    `;
                }
                displayed = true;
            } else if (initialDevSuccess && initialLoginIdFromUrl && initialUsernameFromUrl) {
                const newInfo = `${initialLoginIdFromUrl}(${initialUsernameFromUrl})`;
                if (!userInfoEl.innerHTML.includes(newInfo)) {
                    userInfoEl.innerHTML = `
                        <div style="font-weight: 600;">${initialLoginIdFromUrl}(${initialUsernameFromUrl})</div>
                        <div style="font-size: 10px; color: #666;">${initialDeptNameFromUrl || 'Anonymous'}</div>
                    `;
                }
                displayed = true;
            }

            if ((initialSamlSuccess || initialDevSuccess) && window.history?.replaceState) {
                window.history.replaceState({}, '', window.location.pathname);
            }

            if (displayed) {
                return;
            }

            const apiUrl = initialLoginIdFromUrl
                ? `/api/auth/user?LoginId=${encodeURIComponent(initialLoginIdFromUrl)}`
                : '/api/auth/user';
            const response = await fetch(apiUrl);
            const data = await response.json();

            if (data.authenticated && data.LoginId && data.Username) {
                const newInfo = `${data.LoginId}(${data.Username})`;
                if (!userInfoEl.innerHTML.includes(newInfo)) {
                    userInfoEl.innerHTML = `
                        <div style="font-weight: 600;">${data.LoginId}(${data.Username})</div>
                        <div style="font-size: 10px; color: #666;">${data.DeptName || 'Anonymous'}</div>
                    `;
                }
            }
        } catch (error) {
            console.error('[DEBUG] 사용자 정보 로드 오류:', error);
            // 오류 발생 시에도 아무것도 표시하지 않음
        }
    }

    // 이미지 폴더 최상위로 리셋

    async resetToImageFolder() {
        try {
            // 🔥 캐시된 ROOT_DIR 경로 사용
            const imageRootPath = await this.getRootPath();
            if (!imageRootPath) {
                throw new Error('ROOT_DIR을 가져올 수 없습니다');
            }

            // 🔥 이미 ROOT_DIR이면 불필요한 API 호출 생략
            if (this.currentFolderPath === imageRootPath) {
                this.debugLog('이미 ROOT_DIR 상태 - API 호출 생략');
                return;
            }

            const response = await fetch('/api/change-folder', {
                method: 'POST',

                headers: {
                    'Content-Type': 'application/json',
                },

                body: JSON.stringify({ path: imageRootPath }),
                signal: this.globalAbortController?.signal
            });

            const result = await response.json();

            if (result.success) {
                this.debugLog('이미지 폴더 최상위로 초기화됨');
            }
        } catch (error) {
            console.error('이미지 폴더 초기화 실패:', error);
        }
    }

    async loadDirectoryContents(path, containerElement) {
        this.debugLog("[DEBUG] loadDirectoryContents called with path:", path);

        try {
            const url = path ? `/api/files?path=${encodeURIComponent(path)}` : '/api/files';

            this.debugLog("[DEBUG] Fetching URL:", url);

            const data = await fetchJson(url, {
                signal: this.globalAbortController?.signal
            });

            const files = Array.isArray(data.items) ? data.items : [];

            // 제품 폴더 선택 시 label 캐시 초기화
            if (path) {
                this.clearParCache();
            }

            containerElement.innerHTML = this.createFileTreeHtml(files, path || '');

            // classification 폴더 자동 확장 제거 (항상 닫힘)
        } catch (error) {
            containerElement.innerHTML = `<p style=\"color: #ff5555; padding: 10px;\">Error loading files.</p>`;

            console.error("[DEBUG] loadDirectoryContents error:", error);
        }
    }

    createFileTreeHtml(nodes, parentPath) {
        nodes = Array.isArray(nodes) ? nodes : [];

        let html = '<ul>';

        for (const node of nodes) {
            // 🔥 ROOT_DIR 기준 절대 경로 사용 (모든 depth 지원)
            const fullPath = node.root_relative || (parentPath ? `${parentPath}/${node.name}` : node.name);

            if (node.type === 'directory') {
                html += `<li><details><summary data-path="${fullPath}" class="folder">📁 ${node.name}</summary><div class="folder-content" style="padding-left: 1rem;"></div></details></li>`;
            } else if (node.type === 'file') {
                const draggableAttr = 'draggable="true"';
                html += `<li><a href="#" data-path="${fullPath}" ${draggableAttr}>📄 ${node.name}</a></li>`;
            }
        }

        return html + '</ul>';
    }

    async selectAllFolderFiles(folderPath) {
        try {
            this.debugLog(`폴더 선택: ${folderPath}`);

            // API를 통해 폴더 내 모든 파일 가져오기 (재귀적)

            const allFiles = await this.getAllFilesInFolder(folderPath);

            if (!this.selectedImages) this.selectedImages = [];

            // 이미지 파일만 필터링하고 중복 제거

            const imageFiles = allFiles.filter(path => this.isImageFile(path));

            this.selectedImages = Array.from(new Set([...this.selectedImages, ...imageFiles]));

            this.debugLog(`폴더 ${folderPath}에서 ${imageFiles.length}개 이미지 선택됨`);
        } catch (error) {
            console.error(`폴더 파일 선택 실패: ${folderPath}`, error);
        }
    }

    async deselectFolderFiles(folderPath) {
        try {
            this.debugLog(`폴더 선택 해제: ${folderPath}`);

            // API를 통해 폴더 내 모든 파일 가져오기 (재귀적)

            const allFiles = await this.getAllFilesInFolder(folderPath);

            if (!this.selectedImages) this.selectedImages = [];

            // 해당 폴더의 파일들을 선택에서 제거

            const imageFiles = allFiles.filter(path => this.isImageFile(path));

            this.selectedImages = this.selectedImages.filter(p => !imageFiles.includes(p));

            this.debugLog(`폴더 ${folderPath}에서 ${imageFiles.length}개 이미지 선택 해제됨`);
        } catch (error) {
            console.error(`폴더 파일 선택 해제 실패: ${folderPath}`, error);
        }
    }

    async selectFolderRange(startFolder, endFolder) {
        try {
            // DOM에서 모든 폴더 요소 찾기

            const allFolders = Array.from(document.querySelectorAll('#file-explorer summary.folder'));

            const startIndex = allFolders.indexOf(startFolder);
            const endIndex = allFolders.indexOf(endFolder);

            if (startIndex === -1 || endIndex === -1) {
                console.error('범위 선택 실패: 폴더를 찾을 수 없음');

                return;
            }

            // 시작과 끝 인덱스 정렬

            const minIndex = Math.min(startIndex, endIndex);
            const maxIndex = Math.max(startIndex, endIndex);

            // 범위 내 모든 폴더 선택

            for (let i = minIndex; i <= maxIndex; i++) {
                const folderElement = allFolders[i];
                const path = folderElement.dataset.path;

                if (!folderElement.classList.contains('selected')) {
                    folderElement.classList.add('selected');

                    this.selectedFolders.add(path);

                    await this.selectAllFolderFiles(path);
                }
            }

            this.debugLog(`범위 선택: ${maxIndex - minIndex + 1}개 폴더 선택됨`);
        } catch (error) {
            console.error('폴더 범위 선택 실패:', error);
        }
    }

    async performSearch() {
        try {
            const fileQuery = this.dom.fileSearch?.value?.trim() || '';

            if (!fileQuery) {
                alert('파일명을 입력해주세요.');

                return;
            }

            // 즉시 버튼 피드백 제공

            const searchBtn = this.dom.searchBtn;
            const originalText = searchBtn?.textContent || '검색';

            if (searchBtn) {
                searchBtn.textContent = '검색 중...';

                searchBtn.disabled = true;

                searchBtn.style.opacity = '0.6';
            }

            this.debugLog(`파일명 검색 시작: "${fileQuery}"`);

            const startTime = performance.now();

            // 🔥 검색 전 모든 썸네일 캐시 강력 초기화 (404/500 오류 방지)

            if (this.thumbnailManager) {
                this.thumbnailManager.cache.clear();

                this.thumbnailManager.abortAll();
            }

            // 🔥 그리드 썸네일 DOM 요소들도 초기화 (이전 검색 결과 완전 제거)

            const grid = document.getElementById('image-grid');

            if (grid) {
                // 모든 이미지 URL 해제 (메모리 누수 방지)

                const images = grid.querySelectorAll('.grid-thumb-img');

                images.forEach(img => {
                    if (img.src && img.src.startsWith('blob:')) {
                        URL.revokeObjectURL(img.src);
                    }

                    img.src = ''; // 빈 URL로 설정
                });

                // 그리드 내용 완전 초기화

                grid.innerHTML = '';
            }

            // 서버 검색 API 사용: 프런트는 결과만 표시
            console.info('🔍 [SEARCH DEBUG] currentFolderPath:', this.currentFolderPath);
            console.info('🔍 [SEARCH DEBUG] 검색어:', fileQuery);

            const searchUrl = `/api/search?q=${encodeURIComponent(fileQuery)}`;
            const res = await fetch(searchUrl);
            if (!res.ok) {
                throw new Error(`검색 API 응답 오류: ${res.status}`);
            }

            const data = await res.json();
            console.info('🔍 [SEARCH DEBUG] 검색 결과 수:', data.results?.length || 0);
            if (!data || !data.success || !Array.isArray(data.results)) {
                throw new Error('검색 응답 형식이 올바르지 않습니다.');
            }

            const normalizeResultPath = (rawPath) => {
                if (typeof rawPath !== 'string') return null;
                const normalizedPath = rawPath.replace(/\\/g, '/');
                if (!normalizedPath.includes(':/')) {
                    return normalizedPath;
                }
                const parts = normalizedPath.split('/');
                const markerIdx = parts.indexOf('wm-811k');
                if (markerIdx >= 0 && markerIdx + 1 < parts.length) {
                    return parts.slice(markerIdx + 1).join('/');
                }
                return normalizedPath;
            };

            const matchedImages = data.results
                .map(normalizeResultPath)
                .filter(path => typeof path === 'string' && path.length > 0);

            if (matchedImages.length > 0) {
                console.info('🔍 [SEARCH DEBUG] 변환된 첫 번째 결과:', matchedImages[0]);
            }

            const endTime = performance.now();

            this.debugLog(`검색 완료: ${matchedImages.length}개 이미지 발견 (${(endTime - startTime).toFixed(1)}ms)`);

            // 버튼 상태 복원

            if (searchBtn) {
                searchBtn.textContent = originalText;

                searchBtn.disabled = false;

                searchBtn.style.opacity = '1';
            }

            if (matchedImages.length === 0) {
                alert('검색 결과가 없습니다.');

                return;
            }

            // 검색 결과를 그리드 모드로 표시

            this.selectedImages = matchedImages;

            this.gridSelectedIdxs = [];
        this.gridSelectedSet = new Set();
        this._prevGridSelectedIdxs = new Set();
        this.gridLastClickedIdx = undefined;
        this.gridThumbWraps = [];
        this.invalidateGridGeometry();

            this.showGrid(matchedImages);
            
        } catch (error) {
            console.error('검색 실패:', error);

            // 오류 시에도 버튼 상태 복원

            const searchBtn = this.dom.searchBtn;

            if (searchBtn) {
                searchBtn.textContent = '검색';

                searchBtn.disabled = false;

                searchBtn.style.opacity = '1';
            }

            alert('검색 중 오류가 발생했습니다.');
        }
    }

    downloadImage(imagePath) {
        try {
            const fileName = imagePath.split('/').pop();
            const downloadUrl = `/api/image?path=${encodeURIComponent(imagePath)}`;

            // 임시 링크 생성하여 다운로드

            const link = document.createElement('a');

            link.href = downloadUrl;

            link.download = fileName;

            link.style.display = 'none';

            document.body.appendChild(link);

            link.click();

            document.body.removeChild(link);

            this.debugLog(`이미지 다운로드: ${fileName}`);
        } catch (error) {
            console.error('이미지 다운로드 실패:', error);

            alert('이미지 다운로드에 실패했습니다.');
        }
    }

    downloadSelectedImages() {
        try {
            if (!this.gridSelectedIdxs || this.gridSelectedIdxs.length === 0) {
                alert('다운로드할 이미지를 선택해주세요.');

                return;
            }

            if (!this.selectedImages) {
                alert('선택된 이미지가 없습니다.');

                return;
            }

            const selectedImagePaths = this.gridSelectedIdxs.map(idx => this.selectedImages[idx]).filter(Boolean);

            if (selectedImagePaths.length === 0) {
                alert('유효한 이미지가 선택되지 않았습니다.');

                return;
            }

            this.debugLog(`${selectedImagePaths.length}개 이미지 다운로드 시작`);

            // 각 이미지를 순차적으로 다운로드 (브라우저 제한 고려)

            selectedImagePaths.forEach((imagePath, index) => {
                setTimeout(() => {
                    this.downloadImage(imagePath);
                }, index * 150); // 더 빠르게
            });

            // 진행 안내는 방해 없이 토스트로 간단히 표시

            this.showToast(`${selectedImagePaths.length}개 파일 다운로드 시작`, 1800);

            // 다운로드 완료 알림 (마지막 파일 다운로드 후)

            setTimeout(() => {
                alert(`${selectedImagePaths.length}개 파일 다운로드가 완료되었습니다.`);
            }, selectedImagePaths.length * 150 + 1000);
        } catch (error) {
            console.error('선택된 이미지 다운로드 실패:', error);

            alert('선택된 이미지 다운로드에 실패했습니다.');
        }
    }

    // 심플 토스트

    showToast(message, duration = 1500) {
        try {
            const toast = document.createElement('div');

            toast.textContent = message;

            toast.style.cssText = `

                position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);

                background: rgba(0,0,0,0.85); color: #fff; padding: 8px 14px;

                border-radius: 6px; z-index: 10000; font-size: 13px; box-shadow: 0 2px 10px rgba(0,0,0,0.3);

            `;

            document.body.appendChild(toast);

            setTimeout(() => toast.remove(), duration);
        } catch {}
    }

    showContextMenu(event, clickedIdx) {
        // 선택 상태를 변경하지 않고 컨텍스트 메뉴만 표시
        const contextMenu = document.getElementById('grid-context-menu');

        if (!contextMenu) return;

        // 메뉴 위치 설정
        contextMenu.style.display = 'block';
        contextMenu.style.left = event.pageX + 'px';
        contextMenu.style.top = event.pageY + 'px';

        // 화면 경계 체크

        const rect = contextMenu.getBoundingClientRect();

        if (rect.right > window.innerWidth) {
            contextMenu.style.left = (event.pageX - rect.width) + 'px';
        }

        if (rect.bottom > window.innerHeight) {
            contextMenu.style.top = (event.pageY - rect.height) + 'px';
        }

        // 메뉴 항목 이벤트 리스너 등록 (한 번만)

        if (!this.contextMenuInitialized) {
            this.initializeContextMenu();

            this.contextMenuInitialized = true;
        }

        // 외부 클릭으로 메뉴 숨기기

        this.hideContextMenuHandler = (e) => {
            if (!contextMenu.contains(e.target)) {
                this.hideContextMenu();
            }
        };

        document.addEventListener('click', this.hideContextMenuHandler);
    }

    hideContextMenu() {
        const contextMenu = document.getElementById('grid-context-menu');

        if (contextMenu) {
            contextMenu.style.display = 'none';
        }

        if (this.hideContextMenuHandler) {
            document.removeEventListener('click', this.hideContextMenuHandler);

            this.hideContextMenuHandler = null;
        }
    }

    initializeContextMenu() {
        const downloadItem = document.getElementById('context-download');
        const mergeCopyItem = document.getElementById('context-merge-copy');
        const mergeSaveItem = document.getElementById('context-merge-save');
        const listCopyItem = document.getElementById('context-list-copy');
        const tableCopyItem = document.getElementById('context-table-copy');
        const cancelItem = document.getElementById('context-cancel');

        if (downloadItem) {
            downloadItem.onclick = () => {
                this.hideContextMenu();

                this.downloadSelectedImages();
            };
        }

        if (mergeCopyItem) {
            mergeCopyItem.onclick = () => {
                this.hideContextMenu();

                this.mergeAndCopyImages();
            };
        }

        if (mergeSaveItem) {
            mergeSaveItem.onclick = () => {
                this.hideContextMenu();

                this.mergeAndSaveImages();
            };
        }

        if (listCopyItem) {
            listCopyItem.onclick = () => {
                this.hideContextMenu();

                this.copyFileList();
            };
        }

        if (tableCopyItem) {
            tableCopyItem.onclick = () => {
                this.hideContextMenu();

                this.copyFileListAsTable();
            };
        }

        if (cancelItem) {
            cancelItem.onclick = () => {
                this.hideContextMenu();
            };
        }
    }

    async mergeAndCopyImages() {
        try {
            if (!this.gridSelectedIdxs || this.gridSelectedIdxs.length === 0) {
                alert('합칠 이미지를 선택해주세요.');

                return;
            }

            const selectedCount = this.gridSelectedIdxs.length;

            // 최적 그리드 계산 (남는 칸 최소)

            let cols = Math.ceil(Math.sqrt(selectedCount));
            let rows = Math.ceil(selectedCount / cols);

            // Canvas 생성

            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            // 🔥 고품질 이미지 리샘플링 활성화 (이미지 스무딩 ON)
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';

            // 각 이미지 크기 (512px로 설정)

            const imageSize = 512;
            const filenameHeight = 32; // 파일명 표시 영역
            const rowPadding = 20; // 파일명과 다음 이미지 사이 여백
            const cellHeight = imageSize + filenameHeight + rowPadding;

            canvas.width = cols * imageSize;

            canvas.height = rows * cellHeight;

            // 배경을 흰색으로 설정

            ctx.fillStyle = '#FFFFFF';

            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const imagePromises = this.gridSelectedIdxs.map(async (idx, index) => {
                const imagePath = this.selectedImages[idx];

                // 🔥 썸네일 사용 (고품질, 이미 최적화된 이미지)
                const thumbnailUrl = await this.thumbnailManager.loadThumbnail(imagePath);
                const img = new Image();

                return new Promise((resolve, reject) => {
                    img.onload = () => {
                        const row = Math.floor(index / cols);
                        const col = index % cols;
                        const x = col * imageSize;
                        const y = row * cellHeight;

                        // 이미지를 비율 유지하며 중앙 정렬로 그리기

                        const scale = Math.min(imageSize / img.width, imageSize / img.height);
                        const scaledWidth = img.width * scale;
                        const scaledHeight = img.height * scale;
                        const offsetX = (imageSize - scaledWidth) / 2;
                        const offsetY = (imageSize - scaledHeight) / 2;

                        ctx.drawImage(img, x + offsetX, y + offsetY, scaledWidth, scaledHeight);

                        // 🔥 파일명 표시 (확장자 제거, 2depth 폴더명 포함)
                        const pathParts = imagePath.split('/');
                        const filename = pathParts.pop();
                        // 2depth 폴더명 가져오기 (index 1) - 3depth 이상일 때만 존재
                        const folderName = pathParts.length >= 2 ? pathParts[1] : '';

                        // 확장자 제거
                        const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));

                        // 2depth 폴더명과 파일명을 한 줄로 결합
                        let displayName = folderName ? `${folderName}/${nameWithoutExt}` : nameWithoutExt;
                        
                        ctx.fillStyle = '#000000';
                        ctx.font = '28px Arial';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';

                        // 파일명이 너무 길면 잘라내기
                        const maxWidth = imageSize - 10;
                        let metrics = ctx.measureText(displayName);
                        if (metrics.width > maxWidth) {
                            while (displayName.length > 0 && ctx.measureText(displayName + '...').width > maxWidth) {
                                displayName = displayName.substring(0, displayName.length - 1);
                            }
                            displayName = displayName + '...';
                        }

                        // 파일명 표시
                        ctx.fillText(displayName, x + imageSize / 2, y + imageSize + filenameHeight / 2);

                        // 🔥 테두리 그리기 (이미지 영역만, 안쪽으로 그려지도록 조정)
                        ctx.strokeStyle = '#CCCCCC';
                        ctx.lineWidth = 4;
                        const borderOffset = ctx.lineWidth / 2;
                        ctx.strokeRect(x + borderOffset, y + borderOffset, imageSize - ctx.lineWidth, imageSize - ctx.lineWidth);

                        resolve();
                    };

                    img.onerror = reject;

                    img.src = thumbnailUrl;
                });
            });

            await Promise.all(imagePromises);

            // Canvas를 Blob으로 변환하고 클립보드에 복사 (초고품질 PNG)

            canvas.toBlob(async (blob) => {
                try {
                    // 클립보드 권한 확인 및 요청

                    const hasPermission = await this.ensureClipboardPermission();

                    if (hasPermission && navigator.clipboard && navigator.clipboard.write) {
                        try {
                            const item = new ClipboardItem({ 'image/png': blob });
                            await navigator.clipboard.write([item]);
                            alert(`${selectedCount}개 이미지 클립보드 복사 완료 (${cols}x${rows})`);
                        } catch (clipError) {
                            // Document is not focused 오류 처리
                            throw new Error('클립보드 복사 실패: ' + clipError.message);
                        }
                    } else {
                        throw new Error('클립보드 권한이 없거나 API를 지원하지 않습니다.');
                    }
                } catch (error) {
                    console.error('클립보드 복사 실패:', error);

                    // 폴백: 다운로드 링크 생성

                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');

                    a.href = url;

                    a.download = `merged_images_${cols}x${rows}.png`;

                    document.body.appendChild(a);

                    a.click();

                    document.body.removeChild(a);

                    URL.revokeObjectURL(url);

                    this.showToast('클립보드 실패 → 파일로 저장 완료');
                }
            }, 'image/png');
        } catch (error) {
            console.error('이미지 합치기 실패:', error);

            alert('이미지 합치기에 실패했습니다.');
        }
    }

    async mergeAndSaveImages() {
        try {
            if (!this.gridSelectedIdxs || this.gridSelectedIdxs.length === 0) {
                alert('합칠 이미지를 선택해주세요.');

                return;
            }

            const selectedCount = this.gridSelectedIdxs.length;
            let cols = Math.ceil(Math.sqrt(selectedCount));
            let rows = Math.ceil(selectedCount / cols);
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            // 🔥 고품질 이미지 리샘플링 활성화 (이미지 스무딩 ON)
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';

            const imageSize = 512;
            const filenameHeight = 32; // 파일명 표시 영역
            const rowPadding = 20; // 파일명과 다음 이미지 사이 여백
            const cellHeight = imageSize + filenameHeight + rowPadding;

            canvas.width = cols * imageSize;

            canvas.height = rows * cellHeight;

            ctx.fillStyle = '#FFFFFF';

            ctx.fillRect(0, 0, canvas.width, canvas.height);

            const imagePromises = this.gridSelectedIdxs.map(async (idx, index) => {
                const imagePath = this.selectedImages[idx];

                // 🔥 썸네일 사용 (고품질, 이미 최적화된 이미지)
                const thumbnailUrl = await this.thumbnailManager.loadThumbnail(imagePath);
                const img = new Image();

                return new Promise((resolve, reject) => {
                    img.onload = () => {
                        const row = Math.floor(index / cols);
                        const col = index % cols;
                        const x = col * imageSize;
                        const y = row * cellHeight;
                        const scale = Math.min(imageSize / img.width, imageSize / img.height);
                        const scaledWidth = img.width * scale;
                        const scaledHeight = img.height * scale;
                        const offsetX = (imageSize - scaledWidth) / 2;
                        const offsetY = (imageSize - scaledHeight) / 2;

                        ctx.drawImage(img, x + offsetX, y + offsetY, scaledWidth, scaledHeight);

                        // 🔥 파일명 표시 (확장자 제거, 2depth 폴더명 포함)
                        const pathParts = imagePath.split('/');
                        const filename = pathParts.pop();
                        // 2depth 폴더명 가져오기 (index 1) - 3depth 이상일 때만 존재
                        const folderName = pathParts.length >= 2 ? pathParts[1] : '';

                        // 확장자 제거
                        const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));

                        // 2depth 폴더명과 파일명을 한 줄로 결합
                        let displayName = folderName ? `${folderName}/${nameWithoutExt}` : nameWithoutExt;
                        
                        ctx.fillStyle = '#000000';
                        ctx.font = '28px Arial';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';

                        // 파일명이 너무 길면 잘라내기
                        const maxWidth = imageSize - 10;
                        let metrics = ctx.measureText(displayName);
                        if (metrics.width > maxWidth) {
                            while (displayName.length > 0 && ctx.measureText(displayName + '...').width > maxWidth) {
                                displayName = displayName.substring(0, displayName.length - 1);
                            }
                            displayName = displayName + '...';
                        }

                        // 파일명 표시
                        ctx.fillText(displayName, x + imageSize / 2, y + imageSize + filenameHeight / 2);

                        // 🔥 테두리 그리기 (이미지 영역만, 안쪽으로 그려지도록 조정)
                        ctx.strokeStyle = '#CCCCCC';
                        ctx.lineWidth = 4;
                        const borderOffset = ctx.lineWidth / 2;
                        ctx.strokeRect(x + borderOffset, y + borderOffset, imageSize - ctx.lineWidth, imageSize - ctx.lineWidth);

                        resolve();
                    };

                    img.onerror = reject;

                    img.src = thumbnailUrl;
                });
            });

            await Promise.all(imagePromises);

            // 🔥 초고품질 PNG로 저장
            canvas.toBlob((blob) => {
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');

                a.href = url;

                a.download = `merged_images_${cols}x${rows}.png`;

                document.body.appendChild(a);

                a.click();

                document.body.removeChild(a);

                URL.revokeObjectURL(url);

                this.showToast(`합친 이미지 저장 완료 (${cols}x${rows})`);
            }, 'image/png');
        } catch (e) {
            console.error(e);

            alert('합친 이미지 저장에 실패했습니다.');
        }
    }

    showSingleContextMenu(event) {
        let menu = document.getElementById('single-context-menu');

        if (!menu) {
            menu = document.createElement('div');

            menu.id = 'single-context-menu';

            menu.style.cssText = 'position:absolute; display:none; background:#333; border:1px solid #555; border-radius:4px; padding:4px 0; z-index:10000; min-width:180px; color:#fff;';

            menu.innerHTML = `

                <div id="single-save" class="context-menu-item" style="padding:8px 12px; cursor:pointer; font-size:14px;">📥 원본 저장</div>

                <div id="single-copy" class="context-menu-item" style="padding:8px 12px; cursor:pointer; font-size:14px;">📋 이미지 클립보드 복사</div>

                <div class="context-menu-item" style="padding:8px 12px; border-top:1px solid #555; margin-top:4px;"></div>

                <div id="single-clear-state" class="context-menu-item" style="padding:8px 12px; cursor:pointer; font-size:14px;">🔄 복원 상태 초기화</div>

            `;

            document.body.appendChild(menu);

            menu.querySelector('#single-save').addEventListener('click', () => {
                if (this.selectedImagePath) this.downloadImage(this.selectedImagePath);

                this.hideSingleContextMenu();
            });

            menu.querySelector('#single-copy').addEventListener('click', async () => {
                await this.copyCurrentImageToClipboard();

                this.hideSingleContextMenu();
            });

            menu.querySelector('#single-clear-state').addEventListener('click', () => {
                this.savedViewState = null;

                alert('복원 상태가 초기화되었습니다.');

                this.hideSingleContextMenu();
            });
        }

        menu.style.left = event.pageX + 'px';

        menu.style.top = event.pageY + 'px';

        menu.style.display = 'block';

        this._singleMenuOutsideHandler = (e) => {
            if (!menu.contains(e.target)) this.hideSingleContextMenu();
        };

        document.addEventListener('click', this._singleMenuOutsideHandler);
    }

    hideSingleContextMenu() {
        const menu = document.getElementById('single-context-menu');

        if (menu) menu.style.display = 'none';

        if (this._singleMenuOutsideHandler) {
            document.removeEventListener('click', this._singleMenuOutsideHandler);

            this._singleMenuOutsideHandler = null;
        }
    }

    async copyCurrentImageToClipboard() {
        try {
            if (!this.selectedImagePath) return;

            const res = await fetch(`/api/image?path=${encodeURIComponent(this.selectedImagePath)}`);
            const blob = await res.blob();
            const img = await decodeBitmapSmart(blob);
            const canvas = document.createElement('canvas');

            canvas.width = img.width;

            canvas.height = img.height;

            const ctx = canvas.getContext('2d');

            // 픽셀 완벽한 렌더링을 위해 이미지 스무딩 비활성화

            setPixelPerfectRendering(ctx);

            ctx.drawImage(img, 0, 0);

            canvas.toBlob(async (out) => {
                try {
                    const hasPermission = await this.ensureClipboardPermission();

                    if (hasPermission && navigator.clipboard && navigator.clipboard.write) {
                        try {
                            const item = new ClipboardItem({ 'image/png': out });
                            await navigator.clipboard.write([item]);
                            this.showToast('이미지 클립보드 복사 완료');
                        } catch (clipError) {
                            // Document is not focused 오류 처리
                            throw new Error('no clipboard');
                        }
                    } else {
                        throw new Error('no clipboard');
                    }
                } catch (err) {
                    // 폴백: 다운로드

                    const url = URL.createObjectURL(out);
                    const a = document.createElement('a');

                    a.href = url; a.download = (this.selectedImagePath.split('/').pop() || 'image') + '.png';

                    document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);

                    this.showToast('클립보드 실패 → 파일로 저장');
                }
            }, 'image/png');
        } catch (e) {
            console.error(e);

            alert('이미지 클립보드 복사에 실패했습니다.');
        }
    }

    async copyFileList() {
        try {
            if (!this.gridSelectedIdxs || this.gridSelectedIdxs.length === 0) {
                alert('복사할 파일을 선택해주세요.');

                return;
            }

            const selectedFiles = this.gridSelectedIdxs.map(idx => this.selectedImages[idx]).filter(Boolean);
            const fileListText = selectedFiles.join('\n');

            // 클립보드 권한 확인 및 요청

            const hasPermission = await this.ensureClipboardPermission();

            if (hasPermission && navigator.clipboard && navigator.clipboard.writeText) {
                try {
                    await navigator.clipboard.writeText(fileListText);

                    alert(`${selectedFiles.length}개 파일 경로가 클립보드에 복사되었습니다!`);
                } catch (error) {
                    console.error('클립보드 복사 실패:', error);

                    this.fallbackCopyText(fileListText, selectedFiles.length);
                }
            } else {
                // 권한이 없거나 API를 지원하지 않는 경우 폴백 사용

                this.fallbackCopyText(fileListText, selectedFiles.length);
            }
        } catch (error) {
            console.error('파일 리스트 복사 실패:', error);

            alert('파일 리스트 복사에 실패했습니다.');
        }
    }

    fallbackCopyText(text, count, type = '파일 경로') {
        try {
            // 폴백: textarea 사용

            const textarea = document.createElement('textarea');

            textarea.value = text;

            textarea.style.position = 'fixed';

            textarea.style.opacity = '0';

            textarea.style.left = '-9999px';

            document.body.appendChild(textarea);

            textarea.select();

            document.execCommand('copy');

            document.body.removeChild(textarea);

            alert(`${count}개 ${type}가 클립보드에 복사되었습니다!`);
        } catch (error) {
            console.error('폴백 복사 실패:', error);

            alert('클립보드 복사에 실패했습니다. 데이터를 수동으로 복사해주세요.');
        }
    }

    async requestClipboardPermission() {
        try {
            // 이미 권한이 있는지 확인

            if (navigator.permissions && navigator.permissions.query) {
                const result = await navigator.permissions.query({ name: 'clipboard-write' });

                if (result.state === 'granted') {
                    return true;
                } else if (result.state === 'prompt') {
                    // 권한 요청 다이얼로그 표시

                    const permission = await navigator.permissions.request({ name: 'clipboard-write' });

                    return permission.state === 'granted';
                }
            }

            return false;
        } catch (error) {
            console.warn('클립보드 권한 확인 실패:', error);

            return false;
        }
    }

    async ensureClipboardPermission() {
        // 이미 권한이 있으면 true 반환

        if (navigator.clipboard && navigator.clipboard.writeText) {
            return true;
        }

        // 권한 요청 시도

        const hasPermission = await this.requestClipboardPermission();

        if (hasPermission) {
            // 권한 획득 후 클립보드 API 재시도

            return navigator.clipboard && navigator.clipboard.writeText;
        }

        return false;
    }

    async copyFileListAsTable() {
        try {
            if (!this.gridSelectedIdxs || this.gridSelectedIdxs.length === 0) {
                alert('복사할 파일을 선택해주세요.');

                return;
            }

            const selectedFiles = this.gridSelectedIdxs.map(idx => this.selectedImages[idx]).filter(Boolean);

            // 파일 정보를 테이블 형태로 변환

            const tableData = selectedFiles.map(filePath => {
                // 파일 경로에서 폴더와 파일명 분리

                const pathParts = filePath.split('/');
                const fileName = pathParts[pathParts.length - 1];
                const folder = pathParts.length > 1 ? pathParts[pathParts.length - 2] : '';

                // 확장자 제거

                const nameWithoutExt = fileName.replace(/\.[^/.]+$/, '');

                // 파일명을 _ 로 분할

                const nameParts = nameWithoutExt.split('_');

                return {
                    folder: folder || 'ROOT',

                    part1: nameParts[0] || '',

                    part2: nameParts[1] || '',

                    part3: nameParts[2] || '',

                    part4: nameParts[3] || '',

                    part5: nameParts[4] || ''
                };
            });

            // TSV (Tab-Separated Values) 형태로 테이블 생성

            const headers = ['Folder', 'Name_Part1', 'Name_Part2', 'Name_Part3', 'Name_Part4', 'Name_Part5'];
            let tableText = headers.join('\t') + '\n';

            tableData.forEach(row => {
                const values = [row.folder, row.part1, row.part2, row.part3, row.part4, row.part5];

                tableText += values.join('\t') + '\n';
            });

            // 클립보드 권한 확인 및 요청

            const hasPermission = await this.ensureClipboardPermission();

            if (hasPermission && navigator.clipboard && navigator.clipboard.writeText) {
                try {
                    await navigator.clipboard.writeText(tableText);

                    alert(`${selectedFiles.length}개 파일의 테이블 데이터가 클립보드에 복사되었습니다!\n(Excel에 붙여넣기 가능)`);
                } catch (error) {
                    console.error('클립보드 복사 실패:', error);

                    this.fallbackCopyText(tableText, selectedFiles.length, '테이블 데이터');
                }
            } else {
                // 권한이 없거나 API를 지원하지 않는 경우 폴백 사용

                this.fallbackCopyText(tableText, selectedFiles.length, '테이블 데이터');
            }
        } catch (error) {
            console.error('파일 리스트 테이블 복사 실패:', error);

            alert('파일 리스트 테이블 복사에 실패했습니다.');
        }
    }

    async getAllFilesInFolder(folderPath) {
        // 🔥 재귀 API 사용 - 백엔드에서 os.walk로 모든 파일 한 번에 조회
        try {
            const response = await fetch(`/api/files/recursive?path=${encodeURIComponent(folderPath)}`);
            const data = await response.json();

            if (data && data.success && Array.isArray(data.files)) {
                // ROOT_DIR 기준 절대 경로 배열 반환
                return data.files;
            }
        } catch (error) {
            console.error(`폴더 스캔 실패: ${folderPath}`, error);
        }

        return [];
    }

    isImageFile(filePath) {
        // 🚀 잘못된 파일명 제외

        if (!filePath || filePath === 'nul' || filePath.trim() === '') {
            return false;
        }

        const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.tiff', '.tif'];
        const extension = filePath.toLowerCase().substring(filePath.lastIndexOf('.'));

        return imageExtensions.includes(extension);
    }

    updateFileExplorerSelection() {
        // 시각적 선택 상태 업데이트

        this.dom.fileExplorer.querySelectorAll('a.selected').forEach(a => a.classList.remove('selected'));
        
        // 🔥 모든 파일 링크의 inline background style 초기화
        this.dom.fileExplorer.querySelectorAll('a[data-path]').forEach(link => {
            link.style.removeProperty('background');
            link.style.background = ''; // 기본 배경색으로 복원
        });

        if (this.selectedImages) {
            this.selectedImages.forEach(selPath => {
                const a = this.dom.fileExplorer.querySelector(`a[data-path="${selPath.replace(/"/g, '\\"')}"]`);

                if (a) {
                    a.classList.add('selected');
                    // 🔥 선택된 파일의 배경색 설정
                    a.style.background = '#05b';
                }
            });
        }

        // 뷰 모드 결정

        if (this.selectedImages && this.selectedImages.length > 1) {
            this.showGrid(this.selectedImages);
        } else if (this.selectedImages && this.selectedImages.length === 1) {
            this.hideGrid();

            this.loadImage(this.selectedImages[0]);

            this.selectedImagePath = this.selectedImages[0];
        } else {
            this.hideGrid();
        }

        if (this.selectedImages && this.selectedImages.length > 0) {
            this.selectedImagePath = this.selectedImages[this.selectedImages.length - 1];
        }
    }

    clearWaferMapExplorerSelection() {
        try {
            this.debugLog('🔷 [DEBUG] clearWaferMapExplorerSelection 시작:', {
                gridMode: this.gridMode,

                gridSelectedIdxs: this.gridSelectedIdxs,

                selectedImages: this.selectedImages,

                selectedImagesLength: this.selectedImages?.length,

                currentGridImages: this.currentGridImages,

                currentGridImagesLength: this.currentGridImages?.length
            });

            // Wafer Map Explorer 선택 해제

            // 🔥 Grid 모드에서는 selectedImages를 초기화하지 않음 (체크된 이미지 유지)

            if (!this.gridMode) {
                this.selectedImages = [];
            }

            this.selectedFolders = new Set();

            // 시각적 선택 상태 제거

            if (this.dom && this.dom.fileExplorer) {
                this.dom.fileExplorer.querySelectorAll('.selected').forEach(el => {
                    el.classList.remove('selected');
                });
                
                // 🔥 모든 파일 링크의 inline background style 초기화
                this.dom.fileExplorer.querySelectorAll('a[data-path]').forEach(link => {
                    link.style.removeProperty('background');
                    link.style.background = ''; // 기본 배경색으로 복원
                });
            }

            this.debugLog('Wafer Map Explorer 선택 해제됨');

            this.debugLog('🔷 [DEBUG] clearWaferMapExplorerSelection 완료:', {
                gridMode: this.gridMode,

                gridSelectedIdxs: this.gridSelectedIdxs,

                selectedImages: this.selectedImages,

                selectedImagesLength: this.selectedImages?.length,

                currentGridImages: this.currentGridImages,

                currentGridImagesLength: this.currentGridImages?.length
            });
        } catch (error) {
            console.warn('clearWaferMapExplorerSelection 내부 오류:', error);
        }
    }

    clearLabelExplorerSelection() {
        try {
            this.debugLog('🔷 [DEBUG] clearLabelExplorerSelection 시작:', {
                gridMode: this.gridMode,

                gridSelectedIdxs: this.gridSelectedIdxs,

                selectedImages: this.selectedImages,

                selectedImagesLength: this.selectedImages?.length,

                currentGridImages: this.currentGridImages,

                currentGridImagesLength: this.currentGridImages?.length
            });

            // Label Explorer 선택 해제

            if (this.labelSelection) {
                this.labelSelection.selected = [];

                this.labelSelection.selectedClasses = [];
            }

            // 저장된 뷰 상태로 복원

            if (this.savedViewState) {
                const savedState = { ...this.savedViewState };

                this.restoreSavedViewStateWithState(savedState);
            } else {
                this.hideGrid();

                this.hideImage();

                // 🔥 selectedImages는 초기화하지 않음 (Grid 모드에서 사용)

                this.currentImage = null;

                this.gridMode = false;

                this.currentGridImages = [];

                this.showInitialState();
            }

            this.updateLabelExplorerSelection();

            this.debugLog('🔷 [DEBUG] clearLabelExplorerSelection 완료:', {
                gridMode: this.gridMode,

                gridSelectedIdxs: this.gridSelectedIdxs,

                selectedImages: this.selectedImages,

                selectedImagesLength: this.selectedImages?.length,

                currentGridImages: this.currentGridImages,

                currentGridImagesLength: this.currentGridImages?.length
            });
        } catch (error) {
            console.warn('clearLabelExplorerSelection 오류:', error);
        }
    }

    setupLabelExplorerKeyboardShortcuts(classes, classToImgList, labelSelection) {
        // 이미 바인딩되어 있으면 중복 방지

        if (this.labelExplorerKeysSetup) return;

        this.labelExplorerKeysSetup = true;

        const handleKeyDown = (e) => {
            // Label Explorer 영역 내에서만 동작 (더 정확한 체크)

            const labelExplorerFrame = document.querySelector('.label-explorer-frame');
            const isInLabelExplorer = labelExplorerFrame && (

                labelExplorerFrame.contains(e.target) ||

                e.target === labelExplorerFrame ||

                e.target.closest('#label-explorer-list')

            );

            if (!isInLabelExplorer) return;

            try {
                if (e.key === 'Escape') {
                    // ESC: 선택 해제

                    labelSelection.selected = [];

                    labelSelection.selectedClasses = [];

                    // 이전 Grid 상태로 복귀 또는 이미지 숨기기

                    if (this.gridMode) {
                        this.debugLog('Label Explorer: ESC 키 → 이전 Grid 상태로 복귀');

                        this.restorePreviousGridState();
                    } else {
                        // 단일 이미지 모드에서도 이미지 숨기기

                        this.debugLog('Label Explorer: ESC 키 → 이미지 숨기기');

                        this.restorePreviousGridState(); // 이전 Grid 상태가 없으면 hideImage() 포함
                    }

                    this.updateLabelExplorerSelection();

                    try {
                        this.clearWaferMapExplorerSelection();
                    } catch (error) {
                        console.warn('clearWaferMapExplorerSelection error:', error);
                    }

                    e.preventDefault();

                    this.debugLog('Label Explorer: ESC로 전체 선택 해제');
                    
                } else if (e.ctrlKey && e.key === 'a') {
                    // Ctrl+A: 전체 이미지 선택

                    labelSelection.selected = [];

                    labelSelection.selectedClasses = [];

                    // 모든 이미지 선택

                    for (const cls of classes) {
                        const imgList = classToImgList[cls] || [];

                        for (const img of imgList) {
                            if (img.type === 'file') {
                                labelSelection.selected.push(`${cls}/${img.name}`);
                            }
                        }
                    }

                    // 전체 이미지 선택 시 그리드 모드로 전환

                    if (labelSelection.selected.length > 1) {
                        this.debugLog(`Label Explorer: Ctrl+A → 그리드 모드 (${labelSelection.selected.length}개 이미지)`);

                        this.showGridFromLabelExplorer(labelSelection.selected);
                    }

                    this.updateLabelExplorerSelection();

                    try {
                        this.clearWaferMapExplorerSelection();
                    } catch (error) {
                        console.warn('clearWaferMapExplorerSelection error:', error);
                    }

                    e.preventDefault();

                    this.debugLog(`Label Explorer: Ctrl+A로 ${labelSelection.selected.length}개 이미지 선택`);
                }
            } catch (error) {
                console.warn('Label Explorer 키보드 단축키 오류:', error);
            }
        };

        document.addEventListener('keydown', handleKeyDown);

        // 정리 함수 저장 (필요시 사용)

        this.cleanupLabelExplorerKeys = () => {
            document.removeEventListener('keydown', handleKeyDown);

            this.labelExplorerKeysSetup = false;
        };
    }

    async handleFileClick(e) {
        const target = e.target;

        this.debugLog('🔷 [DEBUG] Wafer Map Explorer 클릭 시작:', {
            target: target.tagName,

            className: target.className,

            gridMode: this.gridMode,

            gridSelectedIdxs: this.gridSelectedIdxs,

            selectedImages: this.selectedImages,

            selectedImagesLength: this.selectedImages?.length,

            currentGridImages: this.currentGridImages,

            currentGridImagesLength: this.currentGridImages?.length
        });

        // Handle folder expansion

        if (target.tagName === 'SUMMARY' && target.classList.contains('folder')) {
            // Ctrl/Shift 수정키 클릭 시 폴더가 펼쳐지지 않도록 기본 동작을 먼저 차단

            if (e.ctrlKey || (e.shiftKey && this.lastSelectedFolder)) {
                e.preventDefault();

                e.stopPropagation();

                // ctrl+클릭으로 폴더 선택/해제 (폴더 열리지 않음)

                if (e.ctrlKey) {
                    const path = target.dataset.path;

                    if (!this.selectedFolders) this.selectedFolders = new Set();

                    // 🔥 Label Explorer 선택만 해제 (savedViewState는 유지)

                    if (this.labelSelection) {
                        this.labelSelection.selected = [];

                        this.labelSelection.selectedClasses = [];

                        this.updateLabelExplorerSelection();
                    }

                    // 첫 번째 선택된 폴더 기록 (Shift 선택용)

                    if (!this.lastSelectedFolder && !target.classList.contains('selected')) {
                        this.lastSelectedFolder = target;
                    }

                    if (target.classList.contains('selected')) {
                        // 선택 해제

                        target.classList.remove('selected');

                        this.selectedFolders.delete(path);

                        await this.deselectFolderFiles(path);
                    } else {
                        // 선택 - 폴더는 열지 않고 선택만

                        target.classList.add('selected');

                        this.selectedFolders.add(path);

                        await this.selectAllFolderFiles(path);
                    }

                    // UI 업데이트

                    this.updateFileExplorerSelection();

                    return; // 추가 처리 방지
                }

                // shift+클릭으로 범위 선택 (폴더 열리지 않음)

                if (e.shiftKey && this.lastSelectedFolder) {
                    if (!this.selectedFolders) this.selectedFolders = new Set();

                    // 🔥 Label Explorer 선택만 해제 (savedViewState는 유지)

                    if (this.labelSelection) {
                        this.labelSelection.selected = [];

                        this.labelSelection.selectedClasses = [];

                        this.updateLabelExplorerSelection();
                    }

                    await this.selectFolderRange(this.lastSelectedFolder, target);

                    // UI 업데이트

                    this.updateFileExplorerSelection();

                    return;
                }
            }

            // 수정키가 아닐 때만 폴더 로드/펼침 처리

            const detailsElement = target.parentElement;

            if (!detailsElement.open && !detailsElement.dataset.loaded) {
                const path = target.dataset.path;
                const contentDiv = target.nextElementSibling;

                await this.loadDirectoryContents(path, contentDiv);

                detailsElement.dataset.loaded = 'true';
            }

            // 🔥 폴더 클릭 시에도 이전 선택 해제 (Ctrl/Shift가 아닐 때)

            if (!e.ctrlKey && !e.shiftKey) {
                // 이전 선택된 모든 항목들의 시각적 표시 해제

                const allLinks = Array.from(this.dom.fileExplorer.querySelectorAll('a[data-path]'));

                allLinks.forEach(link => {
                    link.classList.remove('selected');
                });

                // 이전 선택된 폴더들의 시각적 표시 해제

                const allFolders = Array.from(this.dom.fileExplorer.querySelectorAll('summary.folder'));

                allFolders.forEach(folder => {
                    if (folder !== target) {
                        folder.classList.remove('selected');
                    }
                });

                // 새로 클릭된 폴더 시각적 표시

                target.classList.add('selected');

                // 🔥 Label Explorer 선택도 해제

                if (this.labelSelection) {
                    this.labelSelection.selected = [];

                    this.labelSelection.selectedClasses = [];

                    this.updateLabelExplorerSelection();
                }
            }
        } 

        // Handle file selection (multi-select)

        else if (target.tagName === 'A') {
        e.preventDefault();

            const path = target.dataset.path;

            // 🔥 Label Explorer 선택만 해제 (savedViewState는 유지)

            if (this.labelSelection) {
                this.labelSelection.selected = [];

                this.labelSelection.selectedClasses = [];

                this.updateLabelExplorerSelection();
            }

            const allLinks = Array.from(this.dom.fileExplorer.querySelectorAll('a[data-path]'));
            const idx = allLinks.findIndex(a => a.dataset.path === path);

            if (e.shiftKey && this.lastExplorerClickedIdx !== undefined) {
                const [from, to] = [this.lastExplorerClickedIdx, idx].sort((a, b) => a - b);
                const range = allLinks.slice(from, to + 1).map(a => a.dataset.path);

                this.selectedImages = Array.from(new Set([...(this.selectedImages || []), ...range]));

                this.debugLog('🔷 [DEBUG] Shift 선택 - selectedImages:', this.selectedImages.length, '개');

                // Shift 범위 선택 시에는 항상 그리드 모드

                this.hideGrid();

                this.showGrid(this.selectedImages);
            } else if (e.ctrlKey) {
                if (!this.selectedImages) this.selectedImages = [];

                if (this.selectedImages.includes(path)) {
                    this.selectedImages = this.selectedImages.filter(p => p !== path);
                } else {
                    this.selectedImages.push(path);
                }

                this.debugLog('🔷 [DEBUG] Ctrl 선택 - selectedImages:', this.selectedImages.length, '개');

                // Ctrl 다중 선택 시에는 항상 그리드 모드

                this.hideGrid();

                if (this.selectedImages.length > 0) {
                    this.showGrid(this.selectedImages);
                }
            } else {
                // 단일 클릭 - 이전 선택 모두 해제 후 새 항목 선택

                // 🔥 이전 선택된 모든 항목들의 시각적 표시 해제

                const allLinks = Array.from(this.dom.fileExplorer.querySelectorAll('a[data-path]'));

                allLinks.forEach(link => {
                    link.classList.remove('selected');
                });

                // 🔥 이전 선택된 폴더들의 시각적 표시 해제

                const allFolders = Array.from(this.dom.fileExplorer.querySelectorAll('summary.folder'));

                allFolders.forEach(folder => {
                    folder.classList.remove('selected');
                });

                this.selectedImages = [path];

                this.selectedImagePath = path;

                // 새로 선택된 항목 시각적 표시

                target.classList.add('selected');

                // 🔥 Label Explorer 선택도 해제

                if (this.labelSelection) {
                    this.labelSelection.selected = [];

                    this.labelSelection.selectedClasses = [];

                    this.updateLabelExplorerSelection();
                }

                // 이미지 파일인지 확인

                if (this.isImageFile(path)) {
                    // 자세히보기 모드로 전환

                    this.hideGrid();

                    this.loadImage(path);
                } else {
                    // 이미지가 아니면 그리드 모드

                    this.showGrid(this.selectedImages);
                }
            }

            this.lastExplorerClickedIdx = idx;

            // Highlight all selected

            this.dom.fileExplorer.querySelectorAll('a.selected').forEach(a => a.classList.remove('selected'));

            this.selectedImages.forEach(selPath => {
                const a = this.dom.fileExplorer.querySelector(`a[data-path="${selPath.replace(/"/g, '\"')}"]`);

                if (a) a.classList.add('selected');
            });

            this.debugLog('🔷 [DEBUG] Wafer Map Explorer 파일 클릭 완료:', {
                gridMode: this.gridMode,

                gridSelectedIdxs: this.gridSelectedIdxs,

                selectedImages: this.selectedImages,

                selectedImagesLength: this.selectedImages?.length,

                currentGridImages: this.currentGridImages,

                currentGridImagesLength: this.currentGridImages?.length
            });
        }
    }

    // 파일 탐색기 드래그 멀티 선택

    setupFileExplorerDragSelect() {
        const container = this.dom.fileExplorer;

        if (!container) return;

        // 오버레이 준비

        container.style.position = container.style.position || 'relative';

        let overlay = document.getElementById('explorer-drag-select');

        if (!overlay) {
            overlay = document.createElement('div');

            overlay.id = 'explorer-drag-select';

            overlay.style.cssText = `

                position:absolute; left:0; top:0; width:0; height:0;

                border:2px solid #09f; background:rgba(0,153,255,0.15);

                border-radius:2px; pointer-events:none; display:none; z-index:1000;`;

            container.appendChild(overlay);
        }

        const getScrollAdjusted = (clientX, clientY) => {
            const rect = container.getBoundingClientRect();

            return {
                x: clientX - rect.left + container.scrollLeft,

                y: clientY - rect.top + container.scrollTop
            };
        };

        let dragging = false;
        let start = null;
        const onMouseDown = (e) => {
            if (e.button !== 0) return;

            // draggable 파일 링크 위에서는 박스 선택을 시작하지 않음
            const target = e.target;
            if (target.tagName === 'A' && target.hasAttribute('data-path') && target.draggable) {
                return; // 드래그 범위 선택 우선
            }

            dragging = true;

            start = getScrollAdjusted(e.clientX, e.clientY);

            overlay.style.left = start.x + 'px';

            overlay.style.top = start.y + 'px';

            overlay.style.width = '0px';

            overlay.style.height = '0px';

            overlay.style.display = 'block';

            e.preventDefault();
        };

        const onMouseMove = (e) => {
            if (!dragging || !start) return;

            const curr = getScrollAdjusted(e.clientX, e.clientY);
            const left = Math.min(start.x, curr.x);
            const top = Math.min(start.y, curr.y);
            const width = Math.abs(curr.x - start.x);
            const height = Math.abs(curr.y - start.y);

            overlay.style.left = left + 'px';

            overlay.style.top = top + 'px';

            overlay.style.width = width + 'px';

            overlay.style.height = height + 'px';
        };

        const intersects = (el, dragLeft, dragTop, dragRight, dragBottom) => {
            const elRect = el.getBoundingClientRect();
            const contRect = container.getBoundingClientRect();
            const left = elRect.left - contRect.left + container.scrollLeft;
            const top = elRect.top - contRect.top + container.scrollTop;
            const right = left + elRect.width;
            const bottom = top + elRect.height;

            return (

                dragRight >= left && dragLeft <= right && dragBottom >= top && dragTop <= bottom

            );
        };

        const onMouseUp = async (e) => {
            if (!dragging) return;

            dragging = false;

            overlay.style.display = 'none';

            const end = getScrollAdjusted(e.clientX, e.clientY);

            if (!start) return;

            const dragLeft = Math.min(start.x, end.x);
            const dragTop = Math.min(start.y, end.y);
            const dragRight = Math.max(start.x, end.x);
            const dragBottom = Math.max(start.y, end.y);

            // 최소 이동은 클릭으로 간주 → 기본 동작 유지

            if (Math.abs(end.x - start.x) + Math.abs(end.y - start.y) < 6) {
                start = null;

                return;
            }

            // 교차 요소 수집

            const fileLinks = Array.from(container.querySelectorAll('a[data-path]'));
            const folderSummaries = Array.from(container.querySelectorAll('summary.folder'));
            const hitFiles = fileLinks.filter(a => intersects(a, dragLeft, dragTop, dragRight, dragBottom)).map(a => a.dataset.path);
            const hitFolders = folderSummaries.filter(s => intersects(s, dragLeft, dragTop, dragRight, dragBottom));

            // 🔥 Label Explorer 선택만 해제 (savedViewState는 유지)

            if (this.labelSelection) {
                this.labelSelection.selected = [];

                this.labelSelection.selectedClasses = [];

                this.updateLabelExplorerSelection();
            }

            // Ctrl이면 토글, 아니면 교체

            if (e.ctrlKey) {
                // 파일 토글

                const current = new Set(this.selectedImages || []);

                for (const p of hitFiles) {
                    if (current.has(p)) current.delete(p); else current.add(p);
                }

                this.selectedImages = Array.from(current);

                // 폴더 토글 (파일 선택 반영 포함)

                if (!this.selectedFolders) this.selectedFolders = new Set();

                for (const s of hitFolders) {
                    const path = s.dataset.path;

                    if (s.classList.contains('selected')) {
                        s.classList.remove('selected');

                        this.selectedFolders.delete(path);

                        await this.deselectFolderFiles(path);
                    } else {
                        s.classList.add('selected');

                        this.selectedFolders.add(path);

                        await this.selectAllFolderFiles(path);
                    }
                }
            } else {
                // 교체 선택

                this.selectedImages = hitFiles;

                // 폴더 선택 교체

                this.selectedFolders = new Set();

                // 요약 선택 클래스 초기화

                container.querySelectorAll('summary.folder.selected').forEach(s => s.classList.remove('selected'));

                // 폴더 파일 추가 선택

                for (const s of hitFolders) {
                    const path = s.dataset.path;

                    s.classList.add('selected');

                    this.selectedFolders.add(path);

                    await this.selectAllFolderFiles(path);
                }
            }

            // UI 업데이트 및 그리드/이미지 표시 갱신

            this.updateFileExplorerSelection();

            start = null;
        };

        // 이벤트 등록

        container.addEventListener('mousedown', onMouseDown);

        document.addEventListener('mousemove', onMouseMove, { passive: true });

        document.addEventListener('mouseup', onMouseUp);
    }
    
    // 🔥 Wafer Map Explorer 드래그 시각적 피드백 (Label Explorer와 동일)
    setupFileExplorerDragVisualFeedback() {
        const container = this.dom.fileExplorer;
        if (!container) return;

        // 드래그 상태 변수
        let dragStartPath = null;
        let dragStartElement = null;

        // dragstart: 드래그 시작 시 배경색 변경
        container.addEventListener('dragstart', (e) => {
            const target = e.target;
            if (target.tagName === 'A' && target.hasAttribute('data-path')) {
                const path = target.dataset.path;
                
                dragStartPath = path;
                dragStartElement = target;
                
                e.dataTransfer.effectAllowed = 'all';
                e.dataTransfer.setData('text/plain', path);
                
                // 드래그 이미지 숨기기
                const emptyImg = document.createElement('img');
                emptyImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                e.dataTransfer.setDragImage(emptyImg, 0, 0);
                
                // 🔥 드래그 중 커서를 grabbing으로 변경 (다른 드래그가 없을 때만)
                if (!document.body.style.cursor || document.body.style.cursor === '') {
                    document.body.style.cursor = 'grabbing';
                }
                
                // 드래그 중 시각적 피드백
                target.style.removeProperty('background');
                target.style.setProperty('background', '#06b', 'important');
            }
        }, false);

        // dragover: 드래그 중간에 호버되는 파일 배경색 변경
        container.addEventListener('dragover', (e) => {
            // 🔥 모든 영역에서 기본 드래그 금지 방지
                e.preventDefault();
            e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                
            // 🔥 파일 링크에만 시각적 피드백 (공백 영역은 무시)
            const target = e.target;
            const fileLink = target.closest('a[data-path]');
            
            if (fileLink && fileLink !== dragStartElement) {
                const path = fileLink.dataset.path;
                const isSelected = this.selectedImages && this.selectedImages.includes(path);
                
                // 🔥 이미 선택된 파일이 아니면 호버 색상으로 변경
                if (!isSelected && fileLink.style.background !== 'rgb(0, 102, 187)' && fileLink.style.background !== '#06b') {
                    fileLink.style.background = '#04a';
                }
            }
        }, false);

        // dragleave: 호버 해제 시 원래 색으로 복원
        container.addEventListener('dragleave', (e) => {
            const target = e.target;
            const fileLink = target.closest('a[data-path]');
            
            if (fileLink && fileLink !== dragStartElement) {
                const path = fileLink.dataset.path;
                const isSelected = this.selectedImages && this.selectedImages.includes(path);
                
                // 🔥 호버 색상(#04a)인 경우만 원래 색으로 복원
                if (fileLink.style.background === 'rgb(0, 68, 170)' || fileLink.style.background === '#04a') {
                    fileLink.style.background = isSelected ? '#05b' : '';
                }
            }
        }, false);

        // drop: 드롭 시 범위 선택
        container.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            
            if (!dragStartPath) {
                dragStartPath = null;
                dragStartElement = null;
                return;
            }
            
            // 🔥 마우스 좌표 기준으로 가장 가까운 이미지 찾기 (항상 수행)
                const allLinks = Array.from(container.querySelectorAll('a[data-path]'));
            const mouseY = e.clientY;
            const mouseX = e.clientX;
            let closestLink = null;
            let minDistance = Infinity;
            
            for (const link of allLinks) {
                const rect = link.getBoundingClientRect();
                const linkCenterX = rect.left + rect.width / 2;
                const linkCenterY = rect.top + rect.height / 2;
                
                // 🔥 거리 계산 (X, Y 모두 고려)
                const dx = mouseX - linkCenterX;
                const dy = mouseY - linkCenterY;
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                if (distance < minDistance) {
                    minDistance = distance;
                    closestLink = link;
                }
            }
            
            if (closestLink && closestLink.dataset.path) {
                const endPath = closestLink.dataset.path;
                
                // 모든 파일 링크 가져오기 (이미지 파일만)
                const imagePaths = allLinks
                    .map(link => link.dataset.path)
                    .filter(path => this.isImageFile(path));
                
                const startIdx = imagePaths.indexOf(dragStartPath);
                const endIdx = imagePaths.indexOf(endPath);
                
                if (startIdx !== -1 && endIdx !== -1) {
                    const [from, to] = [startIdx, endIdx].sort((a, b) => a - b);
                    const range = imagePaths.slice(from, to + 1);
                    
                    // 기존 선택에 추가
                    this.selectedImages = Array.from(new Set([...(this.selectedImages || []), ...range]));
                    
                    // UI 업데이트
                    this.updateFileExplorerSelection();
                    
                    // 그리드 모드로 전환
                    if (range.length > 1) {
                        this.hideGrid();
                        this.showGrid(this.selectedImages);
                    } else if (range.length === 1) {
                        this.loadImage(range[0]);
                    }
                }
            }
            
            // 드래그 상태 초기화
            dragStartPath = null;
            dragStartElement = null;
            
            // 🔥 커서를 원래대로 복원 (grabbing 커서인 경우만)
            if (document.body.style.cursor === 'grabbing') {
                document.body.style.cursor = '';
            }
        }, false);

        // dragend: 드래그 종료 (캔슬) 시 원래 색으로 복원
        container.addEventListener('dragend', (e) => {
            const target = e.target;
            if (target.tagName === 'A' && target.hasAttribute('data-path')) {
                // UI 전체 업데이트로 배경색 복원
                this.updateFileExplorerSelection();
            }
            
            // 🔥 커서를 원래대로 복원 (grabbing 커서인 경우만)
            if (document.body.style.cursor === 'grabbing') {
                document.body.style.cursor = '';
            }
            
            // 드래그 상태 초기화
            dragStartPath = null;
            dragStartElement = null;
        }, false);
    }

    // --- IMAGE LOADING ---

    // 🔥 Label Explorer 진입 전 현재 상태 저장 (더 이상 필요 없음 - showGrid/loadImage에서 자동 저장)

    saveCurrentViewStateForLabelExplorer() {
        // 🔥 실제 스크롤 위치 가져오기
        const grid = document.getElementById('image-grid');
        const scrollWrapper = grid?.parentElement;
        const currentScrollTop = scrollWrapper ? scrollWrapper.scrollTop : 0;
        
        // 🔥 Label Explorer Grid인지 확인
        const isLabelExplorerGrid = grid && grid.hasAttribute('data-label-explorer-grid');
        
        // 🔥 classification 경로 체크
        const hasClassificationPath = this.selectedImages?.some(path => 
            path.includes('/classification/') || path.startsWith('classification/')
        );
        
        // 🔥 Grid 모드에서 현재 스크롤 위치를 savedViewState에 업데이트
        // 단, Label Explorer Grid이거나 classification 경로가 포함된 경우는 저장하지 않음
        if (this.gridMode && this.selectedImages && this.selectedImages.length > 0 && !isLabelExplorerGrid && !hasClassificationPath) {
            this.savedViewState = {
                type: 'grid',
                images: [...this.selectedImages],
                scrollTop: currentScrollTop
            };
        }
    }

    async loadImage(path, fromLabelExplorer = false) {
        try {
            // 🔥 그리드 배치 로딩 중단 (단일 이미지 로드 시)
            if (this.gridLoadingBatch) {
                console.log('🛑 [GRID] loadImage - 배치 로딩 중단 (단일 이미지 전환)');
                this.gridLoadingBatch = null;
            }

            // 🔥 그리드 모드에서 로딩 중인 이미지 중단 & UI 전환
            let grid = document.getElementById('image-grid');
            if (this.gridMode && grid) {
                const loadingImages = grid.querySelectorAll('.grid-thumb-img');
                let canceledCount = 0;
                loadingImages.forEach(img => {
                    if (!img.complete) {
                        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                        canceledCount++;
                    }
                });
                if (canceledCount > 0) {
                    console.log(`🛑 [GRID] loadImage - ${canceledCount}개 네트워크 요청 중단`);
                }
            }

            // 🔥 그리드 모드 → 단일 이미지 모드 전환
            this.gridMode = false;

            // 그리드 컨테이너 숨기기
            if (grid) {
                grid.style.display = 'none';
            }

            // 그리드 컨트롤(검색 패널) 숨기기
            const gridControls = document.getElementById('grid-controls');
            if (gridControls) {
                gridControls.style.display = 'none';
            }

            // 뷰어 컨테이너 클래스 전환
            if (this.dom.viewerContainer) {
                this.dom.viewerContainer.classList.remove('grid-mode');
                this.dom.viewerContainer.classList.add('single-image-mode');
            }

            // 🔥 path는 이미 ROOT_DIR 기준 절대 경로 (모든 depth 포함)
            const fullPath = path;

            // 🔥 Wafer Map Explorer에서만 상태 저장, Label Explorer에서는 저장하지 않음
            // Label Explorer Grid 체크 추가
            grid = document.getElementById('image-grid');
            const isLabelExplorerGrid = grid && grid.hasAttribute('data-label-explorer-grid');
            
            // 🔥 classification 경로 체크 개선 (제품 폴더 고려)
            const isClassificationPath = path.includes('/classification/') || path.startsWith('classification/');
            
            if (!fromLabelExplorer && !isClassificationPath && !isLabelExplorerGrid) {
                const scrollWrapper = grid?.parentElement;
                
                // Grid 모드에서 전환하는 경우
                if (this.gridMode && this.currentGridImages && this.currentGridImages.length > 0) {
                    this.savedViewState = {
                        type: 'grid',
                        images: [...this.currentGridImages],
                        scrollTop: scrollWrapper ? scrollWrapper.scrollTop : 0
                    };
                } 
                // 단일 이미지를 직접 선택하는 경우 (Wafer Map Explorer에서)
                else if (!this.gridMode && this.selectedImages && this.selectedImages.length === 1) {
                    this.savedViewState = {
                        type: 'single',
                        imagePath: fullPath,
                        zoom: this.zoom || 1.0,
                        offsetX: this.offsetX || 0,
                        offsetY: this.offsetY || 0
                    };
                }
            }

            this.selectedImagePath = fullPath;  // 🔥 fullPath 사용 (prefix 포함)

            this.pyramidLevels = {}; // 레벨별 캐시 초기화

            this.pyramidLoadingLevels = new Set(); // 로딩 중인 레벨 추적

            if (this.minimapPreview && typeof this.minimapPreview.close === 'function') {
                try { this.minimapPreview.close(); } catch (e) { /* noop */ }
            }
            this.minimapPreview = null;

            // 🔥 Label Explorer에서 호출된 경우 singleImageFromGrid 플래그 유지

            if (path.startsWith('classification/') && this.singleImageFromGrid) {
                this.debugLog('🔷 loadImage - singleImageFromGrid 플래그 유지');
            }

        const timeline = {
            click: performance.now()
        };
        // [STEP 1] 이미지 크기 먼저 조회
        const tSizeStart = performance.now();
        timeline.sizeFetchStart = tSizeStart;
        const sizeResponse = await fetch(`/api/image/size?path=${encodeURIComponent(fullPath)}`);
        if (!sizeResponse.ok) {
            throw new Error(`Failed to get image size: ${sizeResponse.status}`);
        }
        const sizeData = await sizeResponse.json();
        const tSizeEnd = performance.now();
        timeline.sizeFetchEnd = tSizeEnd;

        this.originalWidth = sizeData.width;
        this.originalHeight = sizeData.height;
        if (this.semiconductorRenderer?.isGpuAvailable()) {
            this.semiconductorRenderer.setImageSize(this.originalWidth, this.originalHeight);
            this.usingGpuRenderer = true;
        }

        // [STEP 2] resetView와 동일한 로직으로 초기 확대 비율 계산
        const containerRect = this.dom.viewerContainer.getBoundingClientRect();
        const effectiveW = Math.max(0, containerRect.width - 2);
        const effectiveH = Math.max(0, containerRect.height - 2);
        const imgRatio = this.originalWidth / this.originalHeight;
        const containerRatio = effectiveW / effectiveH;
        const fitScale = (imgRatio > containerRatio)
            ? effectiveW / this.originalWidth
            : effectiveH / this.originalHeight;

        const calculatedZoom = fitScale * FIT_RELATIVE_MARGIN * 0.88;

        // [STEP 3] 확대 기준으로 첫 피라미드 레벨 결정
        let initialLevel = 1.0;
        const thresholds = SERVER_CONFIG.PYRAMID_ZOOM_THRESHOLDS;
        const levels = SERVER_CONFIG.PYRAMID_LEVELS;

        if (calculatedZoom < thresholds[0]) {
            initialLevel = levels[0];
        } else if (calculatedZoom < thresholds[1]) {
            initialLevel = levels[1];
        } else if (calculatedZoom < thresholds[2]) {
            initialLevel = levels[2];
        } else {
            initialLevel = levels[3];
        }

        const url = `/api/image?path=${encodeURIComponent(fullPath)}&level=${initialLevel}`;
        const tFetchStart = performance.now();
        timeline.imageFetchStart = tFetchStart;

        const response = await fetch(url);
        const tFetchEnd = performance.now();
        timeline.imageFetchEnd = tFetchEnd;

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`[ERROR] 피라미드 이미지 로드 실패: ${fullPath}`, {
                level: initialLevel,
                status: response.status,
                statusText: response.statusText,
                error: errorText
            });
            throw new Error(`Failed to load pyramid image: ${response.status} ${response.statusText}`);
        }

        const contentType = response.headers.get('Content-Type') || 'image/jpeg';
        const tBufferStart = performance.now();
        timeline.bufferStart = tBufferStart;
        
        let bitmap;
        // ImageDecoder 스트리밍 시도 (브라우저 호환성 체크)
        if (typeof ImageDecoder !== 'undefined' && response.body) {
            try {
                const decoder = new ImageDecoder({ data: response.body, type: contentType });
                const { image } = await decoder.decode({ completeFramesOnly: true });
                const tBufferEnd = performance.now();
                timeline.bufferEnd = tBufferEnd;

                const tBitmapStart = performance.now();
                timeline.bitmapStart = tBitmapStart;
                bitmap = await createImageBitmap(image);
                const tBitmapEnd = performance.now();
                timeline.bitmapEnd = tBitmapEnd;
            } catch (e) {
                console.warn('[STREAMING] ImageDecoder 실패, 폴백 사용:', e);
                // 폴백: ArrayBuffer 사용
                const arrayBuffer = await response.arrayBuffer();
                const tBufferEnd = performance.now();
                timeline.bufferEnd = tBufferEnd;

                const tBitmapStart = performance.now();
                timeline.bitmapStart = tBitmapStart;
                bitmap = await decodeBitmapSmart({ buffer: arrayBuffer, type: contentType });
                const tBitmapEnd = performance.now();
                timeline.bitmapEnd = tBitmapEnd;
            }
        } else {
            // 폴백: ArrayBuffer 사용
            const arrayBuffer = await response.arrayBuffer();
            const tBufferEnd = performance.now();
            timeline.bufferEnd = tBufferEnd;

            const tBitmapStart = performance.now();
            timeline.bitmapStart = tBitmapStart;
            bitmap = await decodeBitmapSmart({ buffer: arrayBuffer, type: contentType });
            const tBitmapEnd = performance.now();
            timeline.bitmapEnd = tBitmapEnd;
        }

        this.pyramidLevels[initialLevel] = bitmap;
        if (this.semiconductorRenderer?.isGpuAvailable()) {
            this.semiconductorRenderer.uploadLevelBitmap(initialLevel, bitmap);
            this.semiconductorRenderer.setActiveLevel(initialLevel);
            this.usingGpuRenderer = true;
        }
        this.currentImageBitmap = bitmap;
        this.currentImage = bitmap;
        this.currentPyramidLevel = initialLevel;
        this.prepareMinimapPreview(bitmap).then(() => {
            if (this.dom?.minimapContainer?.offsetWidth) {
                requestAnimationFrame(() => this.updateMinimap());
            }
        }).catch(() => {});

        const clickToSizeFetch = Math.max(0, timeline.sizeFetchStart - timeline.click);
        const sizeFetch = Math.max(0, timeline.sizeFetchEnd - timeline.sizeFetchStart);
        const prepareTime = Math.max(0, timeline.imageFetchStart - timeline.sizeFetchEnd);
        const fetchTime = Math.max(0, timeline.imageFetchEnd - timeline.imageFetchStart);
        const bufferTime = Math.max(0, timeline.bufferEnd - timeline.bufferStart);
        const bitmapTime = Math.max(0, timeline.bitmapEnd - timeline.bitmapStart);
        const totalTime = Math.max(0, timeline.bitmapEnd - timeline.click);
        console.log(
            `[INIT] Lv${initialLevel} | ${this.originalWidth}×${this.originalHeight} → ${bitmap.width}×${bitmap.height} | Zoom:${calculatedZoom.toFixed(2)} | ` +
            `Click->SizeReq:${Math.round(clickToSizeFetch)}ms SizeFetch:${Math.round(sizeFetch)}ms Prep:${Math.round(prepareTime)}ms ` +
            `Fetch:${Math.round(fetchTime)}ms Buffer:${Math.round(bufferTime)}ms Bitmap:${Math.round(bitmapTime)}ms Total:${Math.round(totalTime)}ms`
        );

        this.resetView(false);

            // 🎯 resetView 완료 후 적절한 피라미드 레벨로 교체
            setTimeout(() => {
                                this.updatePyramidLevel();
            }, 50);

            // 🚀 모든 피라미드 레벨 background pre-fetch (사용자 대기 없음)
            this.prefetchAllPyramidLevels();

            this.dom.minimapContainer.style.display = 'block';

            this.dom.imageCanvas.style.display = 'block';

            this.dom.overlayCanvas.style.display = 'block';

            this.showFileName(fullPath);  // 🔥 fullPath 사용

            const viewControls = document.querySelector('.view-controls');

            if (viewControls) {
                viewControls.style.display = 'flex';
            }

            // Label Explorer 클래스 선택 초기화 (이미지 선택 시 클래스 선택 해제)
            if (this.labelSelection) {
                this.labelSelection.selectedClasses = [];
                this.updateLabelExplorerSelection();
            }

            this.scheduleDraw();
            
            // 🔥 Wafer Map Explorer에서 단일 이미지 로드 완료 후 savedViewState 업데이트
            // classification 경로 체크 개선 (제품 폴더 고려)
            const isClassificationPathEnd = path.includes('/classification/') || path.startsWith('classification/');
            
            if (!isClassificationPathEnd && !fromLabelExplorer) {
                this.savedViewState = {
                    type: 'single',
                    imagePath: fullPath,
                    zoom: this.zoom,
                    offsetX: this.offsetX,
                    offsetY: this.offsetY
                };
            }
        } catch (err) {
            console.error(`Failed to load image: ${path}`, err);

            this.dom.minimapContainer.style.display = 'none';
        }
    }

    /**
     * 모든 피라미드 레벨을 background에서 미리 다운로드
     * 서버에서 background 생성한 파일들을 클라이언트에서도 미리 받아둠
     *
     * 전략: 낮은 레벨부터 순차 다운로드 (작은 파일 → 큰 파일)
     * 예: 초기=0.7 → 0.2, 0.5, 1.0 순서
     *     초기=0.2 → 0.5, 0.7, 1.0 순서
     */
    async prefetchAllPyramidLevels() {
        if (!this.selectedImagePath) return;

        const levels = SERVER_CONFIG.PYRAMID_LEVELS;
        const currentLevel = this.currentPyramidLevel;
        const currentLevelKey = currentLevel != null ? String(currentLevel) : null;
        const remainingLevels = levels
            .map(level => (typeof level === 'number' ? level : parseFloat(level)))
            .filter(level => !Number.isNaN(level))
            .filter(level => currentLevelKey === null ? true : String(level) !== currentLevelKey);
        const priorityOrder = Array.from(new Set(remainingLevels))
            .filter(level => level < 1.0)  // Level 1.0 미만만 prefetch (1.0은 온디맨드)
            .sort((a, b) => a - b); // 낮은 레벨부터 순서대로

        if (priorityOrder.length === 0) {
            return;
        }

        console.log(`[PREFETCH] Background 순차 다운로드 시작: [${priorityOrder.join(', ')}]`);

        const prefetchStart = performance.now();
        let successCount = 0;
        
        // 순차 다운로드로 네트워크 대역폭 경쟁 방지
        for (const level of priorityOrder) {
            try {
                await this.loadPyramidLevel(level, true);
                successCount++;
                console.log(`[PREFETCH] Lv${level} 완료`);
            } catch (err) {
                console.warn(`[PREFETCH] Lv${level} 다운로드 실패, 건너뜀`, err);
            }
        }
        
        const elapsed = Math.round(performance.now() - prefetchStart);
        console.log(`[PREFETCH] 모든 레벨 다운로드 완료 | 성공:${successCount}/${priorityOrder.length} | Total:${elapsed}ms`);
    }

    async loadPyramidLevel(level, silent = false) {
        // 이미 로드되었으면 스킵
        if (this.pyramidLevels[level]) {
            return;
        }

        // 이미 로딩 중이면 스킵 (중복 요청 방지)
        if (!this._pyramidLoading) {
            this._pyramidLoading = new Set();
        }
        if (this._pyramidLoading.has(level)) {
            return;
        }
        this._pyramidLoading.add(level);

        const url = `/api/image?path=${encodeURIComponent(this.selectedImagePath)}&level=${level}`;
        let cacheStatus = 'MISS';

        try {
            const tStart = performance.now();
            let tFetchStart = 0;
            let tFetchEnd = 0;
            let tBufferStart = 0;
            let tBufferEnd = 0;
            let tBitmapStart = 0;
            let tBitmapEnd = 0;
            const formatTimingSummary = timings => {
                const segments = [];
                if (timings.queue >= 1) {
                    segments.push(`Wait:${Math.round(timings.queue)}ms`);
                }
                segments.push(`Fetch:${Math.round(timings.fetch)}ms`);
                if (timings.buffer >= 0) {
                    segments.push(`Buffer:${Math.round(timings.buffer)}ms`);
                }
                segments.push(`Bitmap:${Math.round(timings.bitmap)}ms`);
                segments.push(`Total:${Math.round(timings.total)}ms`);
                return segments.join(' ');
            };

            const fetchOptions = {
                priority: 'high',
                cache: 'force-cache',
                headers: {
                    Accept: 'image/png,image/apng,image/*;q=0.8'
                }
            };
            let response;
            tFetchStart = performance.now();
            try {
                response = await fetch(url, fetchOptions);
            } catch (fetchErr) {
                response = await fetch(url);
            }
            tFetchEnd = performance.now();

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            };

            cacheStatus = response.headers.get('X-Cache-Status') || 'MISS';

            const contentType = response.headers.get('Content-Type') || 'image/jpeg';
            tBufferStart = performance.now();
            
            let bitmap;
            // ImageDecoder 스트리밍 시도 (브라우저 호환성 체크)
            if (typeof ImageDecoder !== 'undefined' && response.body) {
                try {
                    const decoder = new ImageDecoder({ data: response.body, type: contentType });
                    const { image } = await decoder.decode({ completeFramesOnly: true });
                    tBufferEnd = performance.now();
                    
                    tBitmapStart = performance.now();
                    bitmap = await createImageBitmap(image);
                    tBitmapEnd = performance.now();
                } catch (e) {
                    console.warn('[STREAMING] ImageDecoder 실패, 폴백 사용:', e);
                    // 폴백: ArrayBuffer 사용
                    const arrayBuffer = await response.arrayBuffer();
                    tBufferEnd = performance.now();
                    
                    tBitmapStart = performance.now();
                    bitmap = await decodeBitmapSmart({ buffer: arrayBuffer, type: contentType });
                    tBitmapEnd = performance.now();
                }
            } else {
                // 폴백: ArrayBuffer 사용
                const arrayBuffer = await response.arrayBuffer();
                tBufferEnd = performance.now();
                
                tBitmapStart = performance.now();
                bitmap = await decodeBitmapSmart({ buffer: arrayBuffer, type: contentType });
                tBitmapEnd = performance.now();
            }

            this.pyramidLevels[level] = bitmap;
            if (this.semiconductorRenderer?.isGpuAvailable()) {
                this.semiconductorRenderer.uploadLevelBitmap(level, bitmap);
            }

            // 현재 줌에 적합하면 즉시 교체
            const bestLevel = this.getBestPyramidLevel(this.transform.scale);
            const timings = (() => {
                const tEnd = performance.now();
                return {
                    queue: Math.max(0, tFetchStart - tStart),
                    fetch: tFetchEnd - tFetchStart,
                    buffer: tBufferEnd - tBufferStart,
                    bitmap: tBitmapEnd - tBitmapStart,
                    total: tEnd - tStart
                };
            })();
            const timingSummary = formatTimingSummary(timings);

            if (bestLevel === level && !silent) {
                this.currentImage = bitmap;
                this.currentPyramidLevel = level;
                if (this.semiconductorRenderer?.isGpuAvailable()) {
                    this.semiconductorRenderer.setActiveLevel(level);
                }
                this.prepareMinimapPreview(bitmap).then(() => {
                    if (this.dom?.minimapContainer?.offsetWidth) {
                        requestAnimationFrame(() => this.updateMinimap());
                    }
                }).catch(() => {});
                this.scheduleDraw();

                const isCacheHit = cacheStatus === 'HIT' || cacheStatus === 'ORIGINAL';
                const prefix = isCacheHit ? '[SWITCH]' : '[ASYNC]';
                console.log(`${prefix} Lv${level} | ${this.originalWidth}×${this.originalHeight} → ${bitmap.width}×${bitmap.height} | Zoom:${this.transform.scale.toFixed(2)} | Cache:${cacheStatus} | ${timingSummary}`);
            } else if (silent) {
                console.log(`[PREFETCH] Lv${level} 다운로드완료 (${bitmap.width}×${bitmap.height}) | Cache:${cacheStatus} | ${timingSummary}`);
            }
        } catch (err) {
            // 🔥 사용자가 다른 이미지로 전환하여 중단된 경우 에러 로그 억제
            if (err.name === 'AbortError' || err.message?.includes('aborted')) {
                // fetch가 중단됨 (정상적인 상황)
                return;
            }
            // path가 비어있는 경우도 억제 (이미지 전환 중)
            if (path === '' || !path) {
                return;
            }
            // 그 외의 실제 에러만 로그 출력
            console.error(`[ERROR] 피라미드 로드 실패 level=${level}:`, err);
        } finally {
            this._pyramidLoading.delete(level);
        }
    }

       getBestPyramidLevel(scale) {
           // 🚀 줌 레벨에 따라 최적 피라미드 레벨 결정
           // scale <= 0.25: level 0.2 (25% 이하)
           // scale <= 0.5: level 0.5 (25%~50%)
           // 🔥 서버 설정에서 threshold와 level 가져오기
           const thresholds = SERVER_CONFIG.PYRAMID_ZOOM_THRESHOLDS;
           const levels = SERVER_CONFIG.PYRAMID_LEVELS;

           if (scale < thresholds[0]) return levels[0];
           if (scale < thresholds[1]) return levels[1];
           if (scale < thresholds[2]) return levels[2];
           return levels[3];
       }

    updatePyramidLevel() {
        // 줌 변경 시 호출 - 적절한 레벨로 교체

                if (!this.pyramidLevels) {
                        return;
        }

                const bestLevel = this.getBestPyramidLevel(this.transform.scale);

                // 현재 레벨과 다르면 교체

        if (bestLevel !== this.currentPyramidLevel) {
                        if (this.pyramidLevels[bestLevel]) {
                                // 이미 로드된 레벨이면 즉시 교체

                this.currentImage = this.pyramidLevels[bestLevel];

                this.currentPyramidLevel = bestLevel;
                if (this.semiconductorRenderer?.isGpuAvailable()) {
                    this.semiconductorRenderer.setActiveLevel(bestLevel);
                }

                this.scheduleDraw();

                // 📊 레벨 전환 로그
                console.log(`[SWITCH] Lv${bestLevel} | ${this.originalWidth}×${this.originalHeight} → ${this.currentImage.width}×${this.currentImage.height} | Zoom:${this.transform.scale.toFixed(2)}`);
            } else {
                // 로드되지 않은 레벨이면 로드 시작

                this.loadPyramidLevel(bestLevel);
            }
        }
    }

    // --- VIEWPORT & DRAWING ---

    /**
     * 🎨 [DRAW SYSTEM] 화면 그리기 예약
     * 
     * - requestAnimationFrame으로 draw() 함수 호출 예약
     * - 중복 호출 방지 (drawScheduled 플래그 사용)
     * - 브라우저의 다음 프레임에 draw() 실행
     */
    scheduleDraw() {
        if (this._drawScheduled) {
            return;
        }

        this._drawScheduled = true;

        requestAnimationFrame(() => {
            this._drawScheduled = false;
            this.draw();
        });
    }

    draw() {
        if (!this.currentImage) return;

        const { width, height } = this.dom.viewerContainer.getBoundingClientRect();

        this.dom.imageCanvas.width = width;

        this.dom.imageCanvas.height = height;

        this.dom.imageCanvas.style.width = '100%';

        this.dom.imageCanvas.style.height = '100%';

        this.dom.imageCanvas.style.display = 'block';

        this.dom.imageCanvas.style.margin = '0';

        this.dom.imageCanvas.style.position = 'absolute';

        this.dom.imageCanvas.style.left = '0';

        this.dom.imageCanvas.style.top = '0';

        this.dom.imageCanvas.style.right = '0';

        this.dom.imageCanvas.style.bottom = '0';

        this.dom.imageCanvas.style.zIndex = 1;

        this.dom.viewerContainer.style.position = 'relative';

        let usedGpu = false;
        if (this.semiconductorRenderer && this.usingGpuRenderer) {
            usedGpu = this.semiconductorRenderer.drawGpu({
                level: this.currentPyramidLevel,
                viewportWidth: width,
                viewportHeight: height,
                scale: this.transform.scale,
                translateX: this.transform.dx,
                translateY: this.transform.dy
            });
        }

        if (!usedGpu) {
        // Set canvas background to black

        this.imageCtx.save();

        this.imageCtx.setTransform(1, 0, 0, 1, 0, 0);

        this.imageCtx.globalAlpha = 1.0;

        this.imageCtx.fillStyle = '#000';

        this.imageCtx.fillRect(0, 0, width, height);

        this.imageCtx.restore();

        // Draw the image with pixel-perfect rendering (no interpolation)

        this.imageCtx.save();

        // Disable image smoothing for pixel-perfect display

        setPixelPerfectRendering(this.imageCtx);

        this.imageCtx.translate(this.transform.dx, this.transform.dy);

        this.imageCtx.scale(this.transform.scale, this.transform.scale);

        // 🎯 피라미드 레벨 이미지를 원본 크기로 확대해서 그리기 (위치/크기는 동일, 픽셀만 변화)

        if (this.pyramidLevels && this.currentPyramidLevel) {
            const pyramidImage = this.currentImage;
            const pyramidLevel = this.currentPyramidLevel;

            // 피라미드 이미지를 원본 크기로 확대해서 그리기 (화면상 크기는 동일)

            this.imageCtx.drawImage(

                pyramidImage, 

                0, 0, pyramidImage.width, pyramidImage.height,  // 소스 영역 (피라미드 이미지 전체)

                0, 0, this.originalWidth, this.originalHeight   // 대상 영역 (원본 크기)

            );
        } else {
            // 피라미드가 없으면 기존 방식

            this.imageCtx.drawImage(this.currentImage, 0, 0);
        }

        this.imageCtx.restore();
        }

        this.updateMinimap();
    }

    resetView(shouldDraw = true) {
        if (!this.currentImage) return;

        // 🔥 중복 호출 방지: 이미 리셋 중이면 스킵
        if (this._isResetting) {
                        return;
        }
        this._isResetting = true;

        const containerRect = this.dom.viewerContainer.getBoundingClientRect();

        // 컨테이너 경계선/스크롤 영향으로 인한 미세 클리핑 방지용 보정치(2px)

        const effectiveW = Math.max(0, containerRect.width - 2);
        const effectiveH = Math.max(0, containerRect.height - 2);

        // 🎯 원본 이미지 크기 사용 (피라미드 레벨과 무관)

        const imgRatio = this.originalWidth / this.originalHeight;
        const containerRatio = effectiveW / effectiveH;
        const fitScale = (imgRatio > containerRatio)

            ? effectiveW / this.originalWidth

            : effectiveH / this.originalHeight;

        // 기본은 상대 여유 적용 (초기 로드 등 일반 맞춤)

        this.transform.scale = fitScale * FIT_RELATIVE_MARGIN;

        // 파일명 패널 높이 고려 (CSS 변수에서 가져오기)

        const filenameBarHeight = 56; // --filename-bar-height와 동일

        // 이미지 크기를 조정 (줌 패널과 겹치지 않도록 여유 확보)

        const newScale = fitScale * FIT_RELATIVE_MARGIN * 0.88; // 88%로 조정 (줌 패널 고려)

                this.transform.scale = newScale;
        this.zoom = this.transform.scale; // 🎯 zoom 값 동기화

                // 🎯 실제 센터링도 원본 이미지 크기 기준으로 적용

        this.transform.dx = (containerRect.width - this.originalWidth * this.transform.scale) / 2;

        // 파일명 패널과 줌 패널 사이 중앙 정렬 (filenameBarHeight 약간만 오프셋)

        this.transform.dy = (containerRect.height - this.originalHeight * this.transform.scale) / 2 + (filenameBarHeight * 0.56);

        this.updateZoomDisplay();

        if (shouldDraw) this.scheduleDraw();

        // 🔥 리셋 플래그 해제 (다음 프레임에서)
        setTimeout(() => {
            this._isResetting = false;
        }, 0);
    }

    handleResize() {
        this.scheduleDraw();
    }

    // --- PAN & ZOOM HANDLERS ---

    handleMouseDown(e) {
        if (this.gridMode) return; // grid 모드에서는 팬(이동) 비활성화

        if (e.button !== 0) return; // Only left-click

        this.isPanning = true;

        this.panStart.x = e.clientX - this.transform.dx;

        this.panStart.y = e.clientY - this.transform.dy;

        document.addEventListener('mousemove', this.boundHandleMouseMove);

        document.addEventListener('mouseup', this.boundHandleMouseUp);

        this.dom.viewerContainer.style.cursor = 'grabbing';
    }

    handleMouseUp() {
        if (this.gridMode) return;

        this.isPanning = false;

        this.dom.viewerContainer.style.cursor = 'grab';

        document.removeEventListener('mousemove', this.boundHandleMouseMove);

        document.removeEventListener('mouseup', this.boundHandleMouseUp);
    }

    handleMouseMove(e) {
        if (this.gridMode) return;

        if (!this.isPanning) return;

        this.transform.dx = e.clientX - this.panStart.x;

        this.transform.dy = e.clientY - this.panStart.y;

        this.scheduleDraw();
    }

    /**
     * 🖱️ [GRID SCROLL SYSTEM] Grid 모드에서 마우스 휠 → 스크롤 변경 과정
     * 
     * 📌 Grid 모드에서는 브라우저 기본 스크롤 동작 사용
     * 
     * 1단계: 마우스 휠 이벤트 발생
     *    - 사용자가 마우스 휠을 위/아래로 움직임
     *    - 브라우저가 wheel 이벤트 생성
     *    - deltaY 값: 위로 스크롤(음수), 아래로 스크롤(양수)
     * 
     * 2단계: 이벤트 전파
     *    - wheel 이벤트가 DOM 트리를 따라 전파
     *    - .grid-scroll-wrapper 또는 #image-grid 요소에 도달
     * 
     * 3단계: 브라우저 기본 동작 실행
     *    - 브라우저가 자동으로 스크롤 처리
     *    - scrollTop 값 자동 변경
     *    - 스크롤바 위치 업데이트
     *    - 화면에 반영
     * 
     * 4단계: 스크롤 상태 저장
     *    - grid.scrollTop, grid.scrollLeft 값 자동 업데이트
     *    - 이 값들을 saveWaferMapExplorerState()에서 저장
     * 
     * 🔥 핵심: Grid 모드에서는 이 함수(handleWheel)가 호출되지 않음!
     *    - handleWheel은 Single Image 모드에서만 작동
     *    - Grid 모드는 브라우저가 알아서 처리
     */
    handleWheel(e) {
        // grid 모드에서는 뷰어 컨테이너 휠 이벤트 비활성화
        if (this.gridMode) {
            return;
        }

        // 🔥 상세 보기 모드에서 ESC 키로 빠져나가기
        if (this.detailMode && e.key === 'Escape') {
            this.exitDetailMode();
            return;
        }

        if (e.ctrlKey) {
            e.preventDefault();

            const scaleAmount = 1 - e.deltaY * 0.001;

            this.zoomAtPoint(scaleAmount, e.clientX, e.clientY);
            this.scheduleDraw();
        } else if (e.shiftKey) {
            // allow native scroll as well as pan
            this.transform.dx -= e.deltaY; // move horizontally

            this.scheduleDraw();
            // do not preventDefault
        } else {
            // allow native scroll as well as pan
            this.transform.dy -= e.deltaY; // move vertically

            this.scheduleDraw();
            // do not preventDefault
        }
    }

    /**
     * 🖱️ [SCROLL SYSTEM] 마우스 휠 이벤트 처리 흐름
     * 
     * 1. handleWheel(e) - 마우스 휠 이벤트 수신
     *    - Ctrl+휠: 줌 (zoomAtPoint 호출)
     *    - Shift+휠: 수평 이동 (transform.dx 변경)
     *    - 일반 휠: 수직 이동 (transform.dy 변경)
     * 
     * 2. zoomAtPoint(scale, clientX, clientY) - 줌 처리
     *    - 새로운 스케일 계산: newScale = this.transform.scale * scale
     *    - 변환 행렬 업데이트: transform.dx, transform.dy, transform.scale
     *    - scheduleDraw() 호출로 화면 갱신 예약
     * 
     * 3. scheduleDraw() - 화면 갱신 예약
     *    - requestAnimationFrame으로 draw() 함수 호출 예약
     *    - 중복 호출 방지 (drawScheduled 플래그 사용)
     * 
     * 4. draw() - 실제 화면 그리기
     *    - transform을 사용하여 이미지 위치/크기 계산
     *    - canvas에 이미지 렌더링
     * 
     * 🔥 실제 스크롤바 이동은 발생하지 않음!
     * - transform.dx, transform.dy로 이미지 위치만 이동
     * - 브라우저 스크롤바는 사용하지 않음 (pan 방식)
     */
    zoomAtPoint(scale, clientX, clientY) {
        const viewerRect = this.dom.viewerContainer.getBoundingClientRect();
        const x = clientX - viewerRect.left;
        const y = clientY - viewerRect.top;
        const newScale = this.transform.scale * scale;

        this.transform.dx = x - (x - this.transform.dx) * scale;

        this.transform.dy = y - (y - this.transform.dy) * scale;

        this.transform.scale = newScale;
        this.zoom = newScale; // 🎯 zoom 값 동기화

        this.updateZoomDisplay();

        this.updatePyramidLevel(); // 🎯 피라미드 레벨 업데이트

        this.scheduleDraw();
    }

    zoomAtCenter(factor) {
        const viewerRect = this.dom.viewerContainer.getBoundingClientRect();

        this.zoomAtPoint(factor, viewerRect.left + viewerRect.width / 2, viewerRect.top + viewerRect.height / 2);
    }

    setZoom(level) {
                const scale = level;
        const currentScale = this.transform.scale;
        const factor = scale / currentScale;

                this.zoomAtCenter(factor);
    }

    // 리셋 버튼 전용: 초기 이미지 크기와 배치와 동일하게 적용

    resetViewWithAbsoluteOffset() {
        if (!this.currentImage) return;

        const containerRect = this.dom.viewerContainer.getBoundingClientRect();
        const effectiveW = Math.max(0, containerRect.width - 2);
        const effectiveH = Math.max(0, containerRect.height - 2);

        // 🎯 원본 이미지 크기 사용 (피라미드 레벨과 무관)

        const imgRatio = this.originalWidth / this.originalHeight;
        const containerRatio = effectiveW / effectiveH;
        const fitScale = (imgRatio > containerRatio)

            ? effectiveW / this.originalWidth

            : effectiveH / this.originalHeight;
        
        // 파일명 패널 높이 고려 (CSS 변수에서 가져오기)

        const filenameBarHeight = 56; // --filename-bar-height와 동일

        // 이미지 크기를 조정 (�ם 패널과 겹치지 않도록) - 초기 로드와 동일

        this.transform.scale = fitScale * FIT_RELATIVE_MARGIN * 0.88;

        // 🎯 실제 센터링도 원본 이미지 크기 기준으로 적용

        this.transform.dx = (containerRect.width - this.originalWidth * this.transform.scale) / 2;

        // 파일명 패널과 줌 패널 사이 중앙 정렬 - 초기 로드와 동일

        this.transform.dy = (containerRect.height - this.originalHeight * this.transform.scale) / 2 + (filenameBarHeight * 0.56);

                this.zoom = this.transform.scale; // 🎯 zoom 값 동기화

                this.updateZoomDisplay();

        this.updatePyramidLevel(); // 🎯 피라미드 레벨 업데이트

        this.scheduleDraw();
    }

    updateZoomDisplay() {
        const displayValue = `${Math.round(this.transform.scale * 100)}%`;
        this.dom.zoomLevelInput.value = displayValue;
            }

    // --- MINIMAP ---

    async prepareMinimapPreview(imageBitmap) {
        try {
            if (!imageBitmap || !imageBitmap.width || !imageBitmap.height) {
                return;
            }

            const MAX_DIMENSION = 256;
            const srcW = imageBitmap.width;
            const srcH = imageBitmap.height;
            const scale = Math.min(1, MAX_DIMENSION / Math.max(srcW, srcH));
            const targetW = Math.max(1, Math.round(srcW * scale));
            const targetH = Math.max(1, Math.round(srcH * scale));
            let previewBitmap = null;

            if (typeof OffscreenCanvas !== 'undefined') {
                try {
                    const offscreen = new OffscreenCanvas(targetW, targetH);
                    const ctx = offscreen.getContext('2d', { alpha: false });

                    if (ctx) {
                        ctx.imageSmoothingEnabled = true;

                        if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

                        ctx.drawImage(imageBitmap, 0, 0, targetW, targetH);

                        if (typeof offscreen.convertToBlob === 'function') {
                            const blob = await offscreen.convertToBlob({ type: 'image/jpeg', quality: 1.0 });

                            previewBitmap = await decodeBitmapSmart(blob);
                        } else {
                            previewBitmap = await decodeBitmapSmart(offscreen);
                        }
                    }
                } catch (error) {
                    console.warn('⚠️ [MINIMAP] OffscreenCanvas preview 실패', error);
                }
            }

            if (!previewBitmap) {
                const canvas = document.createElement('canvas');

                canvas.width = targetW;

                canvas.height = targetH;

                const ctx = canvas.getContext('2d', { alpha: false });

                if (!ctx) return;

                ctx.imageSmoothingEnabled = true;

                if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

                ctx.drawImage(imageBitmap, 0, 0, targetW, targetH);

                let blob = null;

                if (typeof canvas.toBlob === 'function') {
                    blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 1.0));
                }

                if (blob) {
                    previewBitmap = await decodeBitmapSmart(blob);
                } else {
                    previewBitmap = await decodeBitmapSmart(canvas);
                }
            }

            if (this.minimapPreview && typeof this.minimapPreview.close === 'function') {
                try { this.minimapPreview.close(); } catch (e) { /* noop */ }
            }

            this.minimapPreview = previewBitmap;
        } catch (err) {
            console.warn('⚠️ [MINIMAP] preview 생성 실패', err);

            this.minimapPreview = null;
        }
    }

    updateMinimap() {
        if (!this.currentImage) return;

        // 미니맵 크기 및 이미지 크기

        const mapW = this.dom.minimapCanvas.width = this.dom.minimapContainer.offsetWidth;
        const mapH = this.dom.minimapCanvas.height = this.dom.minimapContainer.offsetHeight;

        // 🎯 미니맵도 원본 이미지 크기 사용 (피라미드 레벨과 무관)

        const imgW = this.originalWidth;
        const imgH = this.originalHeight;

        // 이미지 전체를 미니맵에 fit (pad 포함)

        const scale = Math.min(mapW / imgW, mapH / imgH);
        const padX = (mapW - imgW * scale) / 2;
        const padY = (mapH - imgH * scale) / 2;

        this.minimapCtx.clearRect(0, 0, mapW, mapH);

        if (this.minimapPreview) {
            this.minimapCtx.imageSmoothingEnabled = true;

            if ('imageSmoothingQuality' in this.minimapCtx) {
                this.minimapCtx.imageSmoothingQuality = 'high';
            }
        } else {
            setPixelPerfectRendering(this.minimapCtx);
        }

        const sourceImage = this.minimapPreview || this.currentImage;
        const srcWidth = (sourceImage && sourceImage.width) ? sourceImage.width : this.currentImage.width;
        const srcHeight = (sourceImage && sourceImage.height) ? sourceImage.height : this.currentImage.height;

        if (sourceImage) {
            this.minimapCtx.drawImage(

                sourceImage,

                0, 0, srcWidth, srcHeight,

                padX, padY, imgW * scale, imgH * scale

            );
        }

        // 메인 뷰의 영역(이미지 좌표계) → 미니맵 좌표계로 변환

        const { width: viewW, height: viewH } = this.dom.viewerContainer.getBoundingClientRect();
        const viewScale = this.transform.scale;
        const viewX = -this.transform.dx / viewScale;
        const viewY = -this.transform.dy / viewScale;
        const vpX = padX + viewX * scale;
        const vpY = padY + viewY * scale;
        const vpW = viewW / viewScale * scale;
        const vpH = viewH / viewScale * scale;

        // 뷰포트 사각형 스타일 적용

        const vp = this.dom.minimapViewport.style;

        vp.left = `${vpX}px`;

        vp.top = `${vpY}px`;

        vp.width = `${vpW}px`;

        vp.height = `${vpH}px`;

        vp.display = 'block';
    }

    // --- SIDEBAR RESIZING ---

    handleSidebarDown(e) {
        e.preventDefault();

        document.addEventListener('mousemove', this.boundSidebarMove);

        document.addEventListener('mouseup', this.boundSidebarUp);
    }

    handleSidebarMove(e) {
        const newWidth = e.clientX;
        const maxWidth = window.innerWidth * MAX_SIDEBAR_WIDTH_RATIO;

        if (newWidth > MIN_SIDEBAR_WIDTH && newWidth < maxWidth) {
            this.dom.sidebar.style.width = newWidth + 'px';

            this.handleResize();
        }
    }

    handleSidebarUp() {
        document.removeEventListener('mousemove', this.boundSidebarMove);

        document.removeEventListener('mouseup', this.boundSidebarUp);
    }

    // --- CLASSIFICATION ---

    async initClassification() {
        this.selectedClass = null;

        this.selectedClasses = [];

        this.selectedImagePath = null;

        this.classSelection = { selected: [], lastClicked: null };

        this.initAddLabelModal();
        // refreshClassList()는 initClassManager에서 호출됨

        this.dom.addClassBtn = document.getElementById('add-class-btn');

        this.dom.newClassInput = document.getElementById('new-class-input');

        this.dom.classList = document.getElementById('class-list');

        this.dom.labelStatus = document.getElementById('label-status');

        this.dom.deleteClassBtn = document.getElementById('delete-class-btn');
        this.dom.renameClassBtn = document.getElementById('rename-class-btn');

        // DOM 요소가 존재할 때만 이벤트 리스너 추가
        if (this.dom.deleteClassBtn) {
            this.dom.deleteClassBtn.addEventListener('click', () => this.deleteSelectedClasses());
        }

        if (this.dom.renameClassBtn) {
            this.dom.renameClassBtn.addEventListener('click', () => this.renameSelectedClass());
        }

        if (this.dom.addClassBtn) {
            this.dom.addClassBtn.addEventListener('click', () => this.addClass());
        }

        if (this.dom.newClassInput) {
            this.dom.newClassInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') this.addClass();
            });
        }

        // 폴더 관련 이벤트 리스너
        // subfolder-select 이벤트 추가 (제품 선택)
        if (this.dom.subfolderSelect) {
            this.dom.subfolderSelect.addEventListener('change', (e) => this.onSubfolderSelect(e));
        }

        // 제품 검색 기능 이벤트 리스너
        if (this.dom.subfolderSearch) {
            this.dom.subfolderSearch.addEventListener('input', (e) => this.handleSubfolderSearch(e));
            this.dom.subfolderSearch.addEventListener('focus', () => {
                this.dom.subfolderSearch.select();  // 텍스트 자동 선택
                this.showSubfolderDropdown();
            });
            this.dom.subfolderSearch.addEventListener('keydown', (e) => this.handleSubfolderKeydown(e));
        }

        // 검색 드롭다운 외부 클릭 시 숨기기
        document.addEventListener('click', (e) => {
            if (!this.dom.subfolderSearch?.contains(e.target) && !this.dom.subfolderDropdown?.contains(e.target)) {
                this.hideSubfolderDropdown();
            }
        });
        
        if (this.dom.productSearchInput) {
            this.dom.productSearchInput.addEventListener('focus', () => this.showProductSearchDropdown());
            this.dom.productSearchInput.addEventListener('input', (e) => this.handleProductSearchInput(e));
            this.dom.productSearchInput.addEventListener('keydown', (e) => this.handleProductSearchKeydown(e));
            
            // 입력 필드 외부 클릭 시 드롭다운 숨기기
            document.addEventListener('click', (e) => {
                // 드롭다운이 존재할 때만 체크 (성능 최적화)
                const dropdown = document.getElementById('product-search-dropdown');
                if (dropdown &&
                    !this.dom.productSearchInput.contains(e.target) &&
                    !dropdown.contains(e.target)) {
                    dropdown.remove();
                }
            });
        }

        if (this.dom.refreshBtn) {
            this.dom.refreshBtn.addEventListener('click', () => this.refreshAll());
        }

        // 폴더 브라우저 모달 이벤트

        this.setupFolderBrowserEvents();
    }

    async getClassList(force = false) {
        console.log('🔍 [GET_CLASS_LIST_DEBUG] 호출됨, force:', force);
        console.log('🔍 [GET_CLASS_LIST_DEBUG] cachedClassList:', this.cachedClassList);
        console.log('🔍 [GET_CLASS_LIST_DEBUG] classListPromise:', this.classListPromise);
        
        if (!force && this.cachedClassList && this.cachedClassList.length >= 0) {
            console.log('🔍 [GET_CLASS_LIST_DEBUG] 캐시된 클래스 목록 반환:', this.cachedClassList);
            return this.cachedClassList;
        }
        if (!force && this.classListPromise) {
            console.log('🔍 [GET_CLASS_LIST_DEBUG] 진행 중인 Promise 반환');
            return this.classListPromise;
        }

        const currentFolder = this.currentFolderPrefix;
        const apiUrl = currentFolder ? `/api/classes?folder=${encodeURIComponent(currentFolder)}` : '/api/classes';
        
        console.log('🔍 [GET_CLASS_LIST_DEBUG] API 호출:', apiUrl);
        console.log('🔍 [GET_CLASS_LIST_DEBUG] currentFolderPrefix:', currentFolder);

        const fetchPromise = (async () => {
            try {
                const res = await fetch(apiUrl, {
                    signal: this.globalAbortController?.signal
                });
                const data = await res.json();
                const classes = Array.isArray(data.classes)
                    ? data.classes.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))
                    : [];
                this.cachedClassList = classes;
                console.log('🔍 [GET_CLASS_LIST_DEBUG] API 응답 성공, 클래스 수:', classes.length);
                return classes;
            } catch (error) {
                console.error('🔍 [GET_CLASS_LIST_DEBUG] 클래스 목록 조회 실패:', error);
                if (!this.cachedClassList) {
                    this.cachedClassList = [];
                }
                throw error;
            } finally {
                this.classListPromise = null;
            }
        })();

        this.classListPromise = fetchPromise;
        try {
            return await fetchPromise;
        } catch (error) {
            if (!force && this.cachedClassList) {
                return this.cachedClassList;
            }
            throw error;
        }
    }

    async refreshClassList(forceFetch = true) {
        const container = this.dom.classList;
        const scrollTop = container ? container.scrollTop : 0;

        const classes = await this.getClassList(forceFetch);

        // 기존 버튼들을 저장 (삭제 전에)

        const existingButtons = Array.from(container.querySelectorAll('button'));

        // Class Manager frame 클릭 시 선택 해제

        const classFrame = document.querySelector('.classification-frame');

        if (classFrame && !classFrame.hasAttribute('data-click-bound')) {
            classFrame.setAttribute('data-click-bound', 'true');

            classFrame.addEventListener('click', (e) => {
                // 버튼이 아닌 곳 클릭 시 선택 해제

                if (!e.target.closest('button') && !e.target.closest('input')) {
                    this.classSelection.selected = [];

                    this.classSelection.lastClicked = null;

                    this.selectedClass = null;

                    this.updateClassListSelection();
                }
            });
        }

        // 기존 버튼들 모두 제거하고 새로 생성 (정렬 문제 해결)

        container.innerHTML = '';

        // 모든 클래스에 대해 버튼 생성

        classes.forEach(cls => {
            const btn = document.createElement('button');

            btn.textContent = cls;

            btn.className = 'class-btn' + (this.selectedClass === cls ? ' selected' : '');

            btn.style.padding = '4px 14px';

            btn.style.background = this.classSelection?.selected.includes(cls) ? '#09f' : '#222';

            btn.style.color = this.classSelection?.selected.includes(cls) ? '#fff' : '#fff';

            btn.style.border = this.classSelection?.selected.includes(cls) ? '2px solid #09f' : '1px solid #444';

            btn.style.borderRadius = '6px';

            btn.style.fontWeight = '500';

            btn.style.fontSize = '15px';

            btn.style.marginRight = '2px';

            btn.style.cursor = 'pointer';

            btn.style.display = 'flex';

            btn.style.flexWrap = 'wrap';

            btn.style.gap = '12px 12px';

            // 우클릭: 선택 해제

            btn.oncontextmenu = (e) => {
                e.preventDefault();

                if (this.classSelection && this.classSelection.selected.length > 0) {
                    this.classSelection.selected = [];

                    this.selectedClass = null;

                    this.dom.deleteClassBtn.disabled = true;
                    if (this.dom.renameClassBtn) this.dom.renameClassBtn.disabled = true;

                    this.updateClassListSelection();
                }

                return false;
            };

            // 🔥 드롭 이벤트 제거 (드래그는 이제 범위 선택용으로만 사용)

            btn.onclick = (e) => {
                const isCtrl = e.ctrlKey || e.metaKey;
                const isShift = e.shiftKey;
                
                console.log('🔍 [CLASS_CLICK_DEBUG] 클래스 버튼 클릭:', {
                    className: cls,
                    isCtrl: isCtrl,
                    isShift: isShift,
                    selectedCount: this.classSelection?.selected.length || 0,
                    eventKeys: {
                        ctrlKey: e.ctrlKey,
                        metaKey: e.metaKey,
                        shiftKey: e.shiftKey,
                        altKey: e.altKey
                    }
                });

                if (!isCtrl && !isShift) {
                    // 🔥 성능 최적화: 직접 라벨링 (즉각 반응)
                    this.selectedClass = cls;

                    if (this.dom.labelStatus) this.dom.labelStatus.textContent = '';

                    let imagePaths = [];

                    // 🔥 Grid 모드: 체크된 이미지들 라벨링
                    if (this.gridMode && this.gridSelectedIdxs && this.gridSelectedIdxs.length > 0) {
                        // 체크된 인덱스별로 이미지 경로 추출 (selectedImages가 비어있으면 currentGridImages 사용)
                        const sourceImages = this.selectedImages.length > 0 ? this.selectedImages : this.currentGridImages;

                        imagePaths = this.gridSelectedIdxs
                            .map(idx => sourceImages[idx])
                            .filter(path => path && path.trim() !== '');
                    }
                    // 🔥 단일 이미지 모드: 현재 이미지 라벨링
                    else if (!this.gridMode && this.selectedImagePath) {
                        imagePaths = [this.selectedImagePath];
                    }

                    if (imagePaths.length === 0) {
                        console.warn('라벨링할 이미지가 선택되지 않았습니다.');
                        return;
                    }

                    // 🔥 즉시 성공 피드백 (연두색)
                    const originalBg = btn.style.background;
                    const originalTransition = btn.style.transition;
                    btn.style.transition = 'all 0.2s ease';
                    btn.style.background = 'linear-gradient(135deg, #11998e 0%, #38ef7d 100%)';

                    // 🔥 색상 복원 (500ms 후)
                    setTimeout(() => {
                        btn.style.background = originalBg;
                        btn.style.transition = originalTransition;
                    }, 500);

                    // 🔥 백그라운드에서 API 처리 (완전 비동기, Fire-and-Forget)
                    const currentFolderPrefix = this.currentFolderPrefix || '';
                    const apiUrl = currentFolderPrefix ? `/api/classify/batch?folder=${encodeURIComponent(currentFolderPrefix)}` : '/api/classify/batch';

                    fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ class_name: cls, images: imagePaths })
                    }).then(response => {

                        if (!response.ok) {
                            return response.text().then(errorText => {
                                console.error('❌ 라벨 추가 실패:', response.status, errorText);
                            });
                        }
                        return response.json();
                    }).then(result => {
                        if (result && result.errors && result.errors > 0) {
                            console.warn(`⚠️ ${result.errors}개 파일 처리 실패`);
                        }

                        // 🔥 라벨 추가 후 Label Explorer 자동 새로고침 (즉시)
                        // 추가한 클래스 폴더가 열려있으면 캐시 무효화
                        if (this.labelSelection && this.labelSelection.openFolders && this.labelSelection.openFolders[cls]) {
                            console.log(`🔄 [AUTO_REFRESH] 폴더 '${cls}' 자동 새로고침`);
                            
                            // 해당 클래스 캐시 무효화
                            if (this.classToImgListCache && this.classToImgListCache[cls]) {
                                delete this.classToImgListCache[cls];
                            }
                            
                            // Label Explorer 새로고침 (열린 폴더 상태 유지)
                            this.refreshLabelExplorer();
                        }
                    }).catch(error => {
                        console.error('❌ 라벨 추가 중 오류:', error);
                    });

                    return;
                }

                // Ctrl/Shift 클릭: 클래스 선택/해제
                console.log('🔍 [CLASS_CLICK_DEBUG] Ctrl/Shift 클릭 감지:', { isCtrl, isShift });

                if (isCtrl || isShift) {
                    if (!this.classSelection) this.classSelection = { selected: [], lastClicked: null };

                    if (isShift && this.classSelection.lastClicked !== null) {
                        const all = classes;
                        const lastIdx = all.indexOf(this.classSelection.lastClicked);
                        const thisIdx = all.indexOf(cls);

                        if (lastIdx !== -1 && thisIdx !== -1) {
                            const [from, to] = [lastIdx, thisIdx].sort((a,b)=>a-b);
                            const range = all.slice(from, to+1);

                            this.classSelection.selected = Array.from(new Set([...this.classSelection.selected, ...range]));
                        }
                    } else if (isCtrl) {
                        console.log('🔍 [CLASS_CLICK_DEBUG] Ctrl 클릭 처리:', {
                            className: cls,
                            wasSelected: this.classSelection.selected.includes(cls),
                            beforeCount: this.classSelection.selected.length
                        });
                        
                        if (this.classSelection.selected.includes(cls)) {
                            this.classSelection.selected = this.classSelection.selected.filter(c => c !== cls);
                            console.log('🔍 [CLASS_CLICK_DEBUG] 클래스 선택 해제:', cls);
                        } else {
                            this.classSelection.selected.push(cls);
                            console.log('🔍 [CLASS_CLICK_DEBUG] 클래스 선택 추가:', cls);
                        }

                        this.classSelection.lastClicked = cls;
                        console.log('🔍 [CLASS_CLICK_DEBUG] 선택된 클래스 목록:', this.classSelection.selected);
                    }

                    this.selectedClass = this.classSelection.selected.length === 1 ? this.classSelection.selected[0] : null;

                    this.dom.deleteClassBtn.disabled = this.classSelection.selected.length === 0;
                    // Rename은 정확히 1개 선택되었을 때만 활성화
                    if (this.dom.renameClassBtn) this.dom.renameClassBtn.disabled = this.classSelection.selected.length !== 1;

                    this.updateClassListSelection();

                    return;
                }
            };

            container.appendChild(btn);
        });

        // 삭제된 클래스의 버튼 제거

        const existingClasses = existingButtons.map(btn => btn.textContent);
        const deletedClasses = existingClasses.filter(cls => !classes.includes(cls));

        deletedClasses.forEach(cls => {
            const btn = existingButtons.find(b => b.textContent === cls);

            if (btn) btn.remove();
        });

        // 선택 상태 업데이트

        this.updateClassListSelection();

        // 스크롤 위치 복원

        if (container) container.scrollTop = scrollTop;
    }

    // 전체 새로고침 함수

    async refreshAll() {
        this.debugLog('전체 새로고침 시작...');

        try {
            // 현재 폴더 다시 로드

            await this.loadFiles();

            // 클래스 목록 새로고침은 refreshLabelExplorer()에서 내부적으로 처리됨

            // 라벨 탐색기 새로고침

            await this.refreshLabelExplorer();

            this.debugLog('전체 새로고침 완료');
        } catch (error) {
            console.error('전체 새로고침 실패:', error);
        }
    }

    updateClassListSelection() {
        // 기존 버튼들의 선택 상태만 업데이트
        console.log('🔍 [SELECTION_DEBUG] updateClassListSelection 시작:', {
            selectedClasses: this.classSelection?.selected || [],
            selectedCount: this.classSelection?.selected.length || 0
        });

        const buttons = this.dom.classList.querySelectorAll('button');

        buttons.forEach(btn => {
            const cls = btn.textContent;

            btn.className = 'class-btn' + (this.selectedClass === cls ? ' selected' : '');

            btn.style.background = this.classSelection?.selected.includes(cls) ? '#09f' : '#222';

            btn.style.border = this.classSelection?.selected.includes(cls) ? '2px solid #09f' : '1px solid #444';
        });
    }

    async addClass() {
        const names = this.dom.newClassInput.value.split(',').map(s => s.trim()).filter(Boolean);

        if (!names.length) return;

        // 클래스명 유효성 검사

        const invalidNames = names.filter(name => {
            // 한글 자모나 특수문자 체크

            return /[^\x20-\x7E]/.test(name) || !/^[A-Za-z0-9_-]+$/.test(name);
        });

        if (invalidNames.length > 0) {
            alert(`다음 클래스명이 유효하지 않습니다: ${invalidNames.join(', ')}\n\n클래스명은 A-Z, a-z, 0-9, _, - 만 사용 가능합니다.`);

            return;
        }

        // 즉시 버튼 피드백 제공

        const addBtn = this.dom.addClassBtn;
        const originalText = addBtn?.textContent || 'Add Class';

        if (addBtn) {
            addBtn.textContent = '추가 중...';

            addBtn.disabled = true;

            addBtn.style.opacity = '0.6';
        }

        const successfulClasses = []; // 성공한 클래스들을 추적

        try {
            this.debugLog(`Adding classes: ${names.join(', ')}`);

            for (const name of names) {
                try {
                    // 🔥 현재 폴더 파라미터 추가
                    const currentFolder = this.currentFolderPrefix;
                    const apiUrl = currentFolder ? `/api/classes?folder=${encodeURIComponent(currentFolder)}` : '/api/classes';
                    console.log(`🔍 [ADD_CLASS] currentFolder: "${currentFolder}", apiUrl: ${apiUrl}`);

                    const response = await fetch(apiUrl, {
                        method: 'POST',

                        headers: { 'Content-Type': 'application/json' },

                        body: JSON.stringify({ name })
                    });

                    if (!response.ok) {
                        console.error(`클래스 '${name}' 추가 실패: HTTP ${response.status}`);

                        continue; // 실패한 클래스는 건너뛰고 계속 진행
                    }

                    const result = await response.json();

                    if (!result.success) {
                        console.error(`클래스 '${name}' 추가 실패: ${result.message || 'Unknown error'}`);

                        continue; // 실패한 클래스는 건너뛰고 계속 진행
                    }

                    this.debugLog(`클래스 '${name}' 추가 성공:`, result);

                    successfulClasses.push(name); // 성공한 클래스 추가

                    // API 응답에서 refresh_required 확인 후 즉시 Label Explorer 강제 새로고침

                    if (result.refresh_required) {
                        this.debugLog(`클래스 '${name}' 생성 완료 - Label Explorer 즉시 강제 새로고침`);

                        await this.refreshLabelExplorer();
                    }
                } catch (error) {
                    console.error(`클래스 '${name}' 추가 중 오류 발생:`, error);

                    continue; // 오류 발생한 클래스는 건너뛰고 계속 진행
                }
            }

            this.dom.newClassInput.value = '';

            // 🔥 Label Explorer가 내부에서 getClassList()를 호출하므로 refreshClassList() 불필요
            await this.refreshLabelExplorer();

            // 성공한 클래스 수 계산

            const successCount = successfulClasses.length;

            this.debugLog(`클래스 추가 결과: 요청 ${names.length}개, 성공 ${successCount}개`);

            if (successCount > 0) {
                this.debugLog(`성공적으로 ${successCount}개 클래스를 추가했습니다: ${successfulClasses.join(', ')}`);

                // 성공 메시지 표시 (선택사항)

                // alert(`성공적으로 ${successCount}개 클래스를 추가했습니다: ${successfulClasses.join(', ')}`);
            } else {
                this.debugLog('추가된 클래스가 없습니다');

                alert('추가된 클래스가 없습니다. 클래스명을 확인해주세요.');
            }
        } catch (error) {
            console.error('클래스 추가 중 예상치 못한 오류 발생:', error);

            // 에러가 발생해도 성공한 클래스가 있으면 성공으로 처리

            if (successfulClasses && successfulClasses.length > 0) {
                this.debugLog(`일부 클래스 추가 성공: ${successfulClasses.join(', ')}`);

                // alert(`일부 클래스 추가 성공: ${successfulClasses.join(', ')}`);
            } else {
                alert('클래스 추가 중 오류가 발생했습니다. 콘솔을 확인해주세요.');
            }
        } finally {
            // 버튼 상태 복원

            if (addBtn) {
                addBtn.textContent = originalText;

                addBtn.disabled = false;

                addBtn.style.opacity = '1';
            }
        }
    }

    async labelImage() {
        const container = document.getElementById('label-explorer-list');

        if (this.gridMode && this.gridSelectedIdxs && this.gridSelectedIdxs.length > 0 && this.selectedClass) {
            // 🔥 배치 API 사용

            const imagePaths = this.gridSelectedIdxs.map(idx => this.selectedImages[idx]);

            // 🔥 현재 폴더 파라미터 추가
            const currentFolder = this.currentFolderPrefix;
            const apiUrl = currentFolder ? `/api/classify/batch?folder=${encodeURIComponent(currentFolder)}` : '/api/classify/batch';
            await fetch(apiUrl, {
                method: 'POST',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify({ class_name: this.selectedClass, images: imagePaths })
            });

            // 🔥 Grid 모드: 캐시만 무효화 (refreshClassList 호출 안함 - 재귀 방지)
            this.classToImgListCache = {};
        } else if (this.selectedClass && this.selectedImagePath) {
            const requestBody = { class_name: this.selectedClass, image_path: this.selectedImagePath };

            this.debugLog('단일 이미지 분류 요청 전송:', requestBody);

            // 🔥 현재 폴더 파라미터 추가
            const currentFolder = this.currentFolderPrefix;
            const apiUrl = currentFolder ? `/api/classify?folder=${encodeURIComponent(currentFolder)}` : '/api/classify';
            const res = await fetch(apiUrl, {
                method: 'POST',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify(requestBody)
            });

            if (res.ok) {
                // Explorer에서 classification/클래스 폴더 자동 오픈

                const explorer = this.dom.fileExplorer;
                const classSummary = explorer.querySelector(`summary[data-path="classification/${this.selectedClass}"]`);

                if (classSummary) {
                    classSummary.parentElement.open = true;

                    this.loadDirectoryContents(`classification/${this.selectedClass}`, classSummary.nextElementSibling);
                }

                // UI 새로고침 (refreshLabelExplorer가 내부에서 getClassList() 호출)
                await this.refreshLabelExplorer();
            }
        }
    }

    async renameSelectedClass() {
        // 선택된 클래스가 정확히 1개여야 함
        const selectedClasses = this.classSelection.selected;

        if (selectedClasses.length === 0) {
            alert('Please select a class to rename');
            return;
        }

        if (selectedClasses.length > 1) {
            alert('Please select only one class to rename');
            return;
        }

        const oldName = selectedClasses[0];
        const newName = prompt(`Rename class "${oldName}" to:`, oldName);

        if (!newName || newName.trim() === '') {
            return; // 취소 또는 빈 입력
        }

        const trimmedNewName = newName.trim();

        if (trimmedNewName === oldName) {
            alert('New name is the same as old name');
            return;
        }

        try {
            // 🔥 현재 폴더 파라미터 추가
            const currentFolder = this.currentFolderPrefix;
            const apiUrl = currentFolder ? `/api/classes/rename?folder=${encodeURIComponent(currentFolder)}` : '/api/classes/rename';
            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    old_name: oldName,
                    new_name: trimmedNewName
                })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.detail || 'Failed to rename class');
            }

            const data = await response.json();

            if (data.success) {
                alert(`Class "${oldName}" renamed to "${trimmedNewName}" (${data.renamed_count} images updated)`);

                // Label Explorer 새로고침 (내부에서 getClassList() 호출)
                await this.refreshLabelExplorer();

                // 입력 필드 초기화
                this.dom.newClassInput.value = '';

                // 선택 해제
                this.classSelection.selected = [];
                this.selectedClass = null;
                if (this.dom.deleteClassBtn) this.dom.deleteClassBtn.disabled = true;
                if (this.dom.renameClassBtn) this.dom.renameClassBtn.disabled = true;
                this.updateClassListSelection();
            } else {
                throw new Error('Rename failed');
            }
        } catch (error) {
            console.error('Class rename error:', error);
            alert(`Failed to rename class: ${error.message}`);
        }
    }

    async deleteSelectedClasses() {
        let names = this.classSelection.selected;

        // 선택된 클래스가 없으면 텍스트박스에서 쉼표로 구분된 클래스들 가져오기

        if (names.length === 0) {
            const input = this.dom.newClassInput.value.trim();

            if (input) {
                names = input.split(',').map(s => s.trim()).filter(Boolean);
            }
        }

        if (names.length === 0) {
            alert('Please select classes or enter class names separated by commas');

            return;
        }

        const confirmMessage = names.length === 1 

            ? `Delete class "${names[0]}" and all its images?`

            : `Delete ${names.length} classes (${names.join(', ')}) and all their images?`;
            
        if (!confirm(confirmMessage)) return;

        this.debugLog(`Deleting classes: ${names.join(', ')}`);

        // 🔥 현재 폴더 파라미터 추가
        const currentFolder = this.currentFolderPrefix;
        const apiUrl = currentFolder ? `/api/classes/delete?folder=${encodeURIComponent(currentFolder)}` : '/api/classes/delete';
        const response = await fetch(apiUrl, {
            method: 'POST',

            headers: { 'Content-Type': 'application/json' },

            body: JSON.stringify({ names })
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const result = await response.json();

        if (!result.success) {
            throw new Error(result.message || 'Failed to delete classes');
        }

        // API 응답에서 refresh_required 확인 후 즉시 Label Explorer 강제 새로고침

        if (result.refresh_required) {
            this.debugLog('클래스 삭제 완료');
        }

        // 텍스트박스도 클리어
        this.dom.newClassInput.value = '';
        this.selectedClass = null;
        this.classSelection.selected = [];
        this.classSelection.lastClicked = null;

        // 🔥 refreshLabelExplorer가 내부에서 getClassList() 호출하므로 중복 제거
        await this.refreshLabelExplorer();
        this.loadDirectoryContents(null, this.dom.fileExplorer);

        this.debugLog(`Successfully deleted ${names.length} classes`);
    }

    // --- ADD LABEL MODAL ---

    initAddLabelModal() {
        const modal = document.getElementById('add-label-modal');
        const closeBtn = modal.querySelector('.modal-close');
        const cancelBtn = document.getElementById('modal-cancel');
        const addBtn = document.getElementById('modal-add-label');
        const removeBtn = document.getElementById('modal-remove-labels');
        const classSelect = document.getElementById('modal-class-select');
        const newClassInput = document.getElementById('modal-new-class-input');

        // 선택된 라벨 목록 초기화

        this.selectedLabelsForRemoval = [];

        // 모달 닫기 이벤트들

        closeBtn.onclick = () => this.closeAddLabelModal();

        cancelBtn.onclick = () => this.closeAddLabelModal();

        // 모달 배경 클릭시 닫기

        modal.onclick = (e) => {
            if (e.target === modal) this.closeAddLabelModal();
        };

        // Add Label 버튼

        addBtn.onclick = async () => {
            await this.addLabelFromModal();
        };

        // Remove Selected Labels 버튼

        if (removeBtn) {
            removeBtn.onclick = async () => {
                await this.removeSelectedLabels();
            };
        }

        // 드롭다운과 새 클래스 입력 필드 상호작용

        classSelect.onchange = () => {
            if (classSelect.value) {
                newClassInput.value = '';
            }
        };

        newClassInput.oninput = () => {
            if (newClassInput.value.trim()) {
                classSelect.value = '';
            }
        };

        // Enter 키로 라벨 추가

        newClassInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();

                this.addLabelFromModal();
            }
        };

        // ESC 키로 모달 닫기

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'flex') {
                this.closeAddLabelModal();
            }
        });
    }

    getSelectedImagesForModal() {
        // 그리드 모드에서 선택된 이미지들 반환

        if (this.gridMode && this.gridSelectedIdxs && this.gridSelectedIdxs.length > 0) {
            return this.gridSelectedIdxs.map(idx => this.selectedImages[idx]).filter(Boolean);
        }

        // 단일 이미지 모드에서는 현재 선택된 이미지 반환

        if (this.selectedImagePath) {
            return [this.selectedImagePath];
        }

        return [];
    }

    toggleLabelSelection(labelDiv) {
        const isSelected = labelDiv.classList.contains('selected');

        if (isSelected) {
            labelDiv.classList.remove('selected');

            const className = labelDiv.dataset.className;

            this.selectedLabelsForRemoval = this.selectedLabelsForRemoval.filter(item => item.className !== className);
        } else {
            labelDiv.classList.add('selected');

            const className = labelDiv.dataset.className;
            const fileNames = JSON.parse(labelDiv.dataset.fileNames);

            this.selectedLabelsForRemoval.push({ className, fileNames });
        }

        this.updateRemoveLabelButton();
    }

    showRemoveLabelButton() {
        const removeBtn = document.getElementById('modal-remove-labels');

        if (removeBtn) {
            removeBtn.style.display = 'block';
        }
    }

    hideRemoveLabelButton() {
        const removeBtn = document.getElementById('modal-remove-labels');

        if (removeBtn) {
            removeBtn.style.display = 'none';
        }
    }

    updateRemoveLabelButton() {
        const removeBtn = document.getElementById('modal-remove-labels');

        if (removeBtn) {
            const count = this.selectedLabelsForRemoval ? this.selectedLabelsForRemoval.length : 0;

            removeBtn.textContent = count > 0 ? `Remove Selected (${count})` : 'Remove Selected';

            removeBtn.disabled = count === 0;
        }
    }

    async removeSelectedLabels() {
        if (!this.selectedLabelsForRemoval || this.selectedLabelsForRemoval.length === 0) {
            alert('Please select labels to remove');

            return;
        }

        const totalToRemove = this.selectedLabelsForRemoval.reduce((sum, item) => sum + item.fileNames.length, 0);

        if (!confirm(`Remove ${totalToRemove} labels from ${this.selectedLabelsForRemoval.length} classes?`)) {
            return;
        }

        try {
            // 선택된 라벨들 제거

            // 🔥 현재 폴더 파라미터 추가
            const currentFolder = this.currentFolderPrefix;
            const apiUrl = currentFolder ? `/api/classify?folder=${encodeURIComponent(currentFolder)}` : '/api/classify';

            for (const labelGroup of this.selectedLabelsForRemoval) {
                for (const fileName of labelGroup.fileNames) {
                    await fetch(apiUrl, {
                        method: 'DELETE',

                        headers: { 'Content-Type': 'application/json' },

                        body: JSON.stringify({
                            class_name: labelGroup.className, 

                            image_name: fileName 
                        })
                    });
                }
            }

            alert(`Successfully removed ${totalToRemove} labels!`);

            // 기존 라벨 목록 새로고침

            const selectedImages = this.getSelectedImagesForModal();
            const existingLabelsList = document.getElementById('existing-labels-list');

            await this.loadExistingLabels(existingLabelsList, selectedImages);

            // UI 업데이트 (refreshLabelExplorer가 내부에서 getClassList() 호출)
            await this.refreshLabelExplorer();
            
        } catch (error) {
            console.error('Failed to remove labels:', error);

            alert('Failed to remove labels');
        }
    }

    async openAddLabelModal() {
        // 🔥 라벨 추가 모달 열기 전에 Wafer Map Explorer 상태 저장
        const grid = document.getElementById('image-grid');
        if (this.gridMode && this.selectedImages && this.selectedImages.length > 0) {
            const scrollWrapper = grid?.parentElement;
            this.savedViewState = {
                type: 'grid',
                images: [...this.selectedImages],
                scrollTop: scrollWrapper ? scrollWrapper.scrollTop : 0
            };
            console.log('💾 [LABEL-SAVE] 라벨 모달 열기 전 savedViewState 저장:', this.selectedImages.length, '개 이미지, scrollTop:', scrollWrapper?.scrollTop);
        } else {
            console.warn('⚠️ [LABEL-SAVE] 라벨 모달 열기: savedViewState 저장 조건 미충족');
        }

        const modal = document.getElementById('add-label-modal');
        const classSelect = document.getElementById('modal-class-select');
        const newClassInput = document.getElementById('modal-new-class-input');
        const currentImageInfo = document.getElementById('current-image-info');
        const existingLabelsList = document.getElementById('existing-labels-list');

        // 선택된 이미지들 정보 표시

        const selectedImages = this.getSelectedImagesForModal();

        if (selectedImages.length > 0) {
            if (selectedImages.length === 1) {
                const fileName = selectedImages[0].split('/').pop();

                currentImageInfo.textContent = fileName;
            } else {
                currentImageInfo.textContent = `${selectedImages.length} images selected`;

                currentImageInfo.innerHTML = `<strong>${selectedImages.length} images selected:</strong><br>` +

                    selectedImages.slice(0, 3).map(path => path.split('/').pop()).join(', ') +

                    (selectedImages.length > 3 ? ` and ${selectedImages.length - 3} more...` : '');
            }
        } else {
            currentImageInfo.textContent = 'No image selected';
        }

        // 클래스 목록 로드

        try {
            const classes = await this.getClassList();

            classSelect.innerHTML = '<option value="">-- Select a class --</option>';

            classes.forEach(cls => {
                const option = document.createElement('option');

                option.value = cls;

                option.textContent = cls;

                if (cls === this.selectedClass) {
                    option.selected = true;
                }

                classSelect.appendChild(option);
            });
        } catch (error) {
            console.error('Failed to load classes:', error);
        }

        // 새 클래스 입력 필드 초기화

        newClassInput.value = '';

        // 기존 라벨 목록 로드

        await this.loadExistingLabels(existingLabelsList, selectedImages);

        modal.style.display = 'flex';
    }

    async loadExistingLabels(container, selectedImages) {
        if (!selectedImages || selectedImages.length === 0) {
            container.textContent = 'No image selected';

            return;
        }

        try {
            // 모든 클래스에서 선택된 이미지들의 라벨 찾기

            const classes = await this.getClassList();

            const existingLabels = [];

            for (const imagePath of selectedImages) {
                const fileName = imagePath.split('/').pop();

                for (const cls of classes) {
                    try {
                        // 🔥 현재 제품 폴더를 고려한 라벨 경로 생성
                        const labelPath = this.currentFolderPrefix ? 
                            `${this.currentFolderPrefix}classification/${encodeURIComponent(cls)}` : 
                            `classification/${encodeURIComponent(cls)}`;
                        const filesRes = await fetch(`/api/files?path=${labelPath}`);
                        const filesData = await filesRes.json();
                        const files = filesData.items || [];

                        if (files.some(file => file.name === fileName)) {
                            existingLabels.push({
                                className: cls,

                                fileName: fileName,

                                imagePath: imagePath
                            });
                        }
                    } catch (err) {
                        // 클래스 폴더가 없을 수 있음
                    }
                }
            }

            if (existingLabels.length === 0) {
                container.textContent = selectedImages.length === 1 

                    ? 'No labels found for this image'

                    : 'No labels found for selected images';

                this.hideRemoveLabelButton();
            } else {
                container.innerHTML = '';

                // 클래스별로 그룹화

                const groupedLabels = {};

                existingLabels.forEach(label => {
                    if (!groupedLabels[label.className]) {
                        groupedLabels[label.className] = [];
                    }

                    groupedLabels[label.className].push(label.fileName);
                });

                // 그룹화된 라벨 표시 (선택 가능)

                Object.entries(groupedLabels).forEach(([className, fileNames]) => {
                    const labelDiv = document.createElement('div');

                    labelDiv.className = 'label-item selectable';

                    labelDiv.innerHTML = `<strong>${className}:</strong> ${fileNames.join(', ')}`;

                    labelDiv.dataset.className = className;

                    labelDiv.dataset.fileNames = JSON.stringify(fileNames);

                    // 클릭 이벤트 추가

                    labelDiv.onclick = () => this.toggleLabelSelection(labelDiv);

                    container.appendChild(labelDiv);
                });

                this.showRemoveLabelButton();
            }

            // 선택된 라벨 목록 초기화

            this.selectedLabelsForRemoval = [];

            this.updateRemoveLabelButton();
            
        } catch (error) {
            console.error('Failed to load existing labels:', error);

            container.textContent = 'Error loading labels';

            this.hideRemoveLabelButton();
        }
    }

    closeAddLabelModal() {
        const modal = document.getElementById('add-label-modal');
        const actionRadios = document.querySelectorAll('input[name="label-action"]');
        const newClassInput = document.getElementById('modal-new-class-input');
        const classSelect = document.getElementById('modal-class-select');

        // 모달 상태 초기화

        modal.style.display = 'none';

        // 라디오 버튼 초기화 (첫 번째 옵션 선택)

        actionRadios.forEach((radio, index) => {
            radio.checked = index === 0; // 'add-all' 옵션을 기본으로 선택
        });

        if (newClassInput) newClassInput.value = '';

        if (classSelect) classSelect.value = '';

        // 선택된 라벨 목록 초기화

        this.selectedLabelsForRemoval = [];

        // 기존 라벨 선택 상태 초기화

        const labelItems = document.querySelectorAll('#existing-labels-list .label-item.selected');

        labelItems.forEach(item => item.classList.remove('selected'));

        this.hideRemoveLabelButton();
    }

    async addLabelFromModal() {
        const classSelect = document.getElementById('modal-class-select');
        const newClassInput = document.getElementById('modal-new-class-input');
        const actionRadios = document.querySelectorAll('input[name="label-action"]');
        const selectedAction = Array.from(actionRadios).find(radio => radio.checked)?.value || 'add-all';

        // 선택된 클래스 또는 새 클래스명 확인

        const selectedClass = classSelect.value.trim();
        const newClassName = newClassInput.value.trim();

        let finalClassName = '';

        if (selectedClass && newClassName) {
            alert('Please select either an existing class or enter a new class name, not both');

            return;
        } else if (selectedClass) {
            finalClassName = selectedClass;
        } else if (newClassName) {
            finalClassName = newClassName;
        } else {
            alert('Please select a class or enter a new class name');

            return;
        }

        // 선택된 이미지들 가져오기

        const selectedImages = this.getSelectedImagesForModal();

        if (selectedImages.length === 0) {
            alert('Please select at least one image');

            return;
        }

        try {
            // 새 클래스인 경우 먼저 클래스 생성

            if (newClassName) {
                // 🔥 현재 폴더 파라미터 추가
                const currentFolder = this.currentFolderPrefix;
                const apiUrl = currentFolder ? `/api/classes?folder=${encodeURIComponent(currentFolder)}` : '/api/classes';
                console.log(`🔍 [ADD_CLASS_NEW] currentFolder: "${currentFolder}", apiUrl: ${apiUrl}`);

                await fetch(apiUrl, {
                    method: 'POST',

                    headers: { 'Content-Type': 'application/json' },

                    body: JSON.stringify({ name: finalClassName })
                });

                await this.getClassList(true);
            }

            let imagesToProcess = selectedImages;
            let removedCount = 0;
            let skippedCount = 0;

            // 액션에 따른 처리

            if (selectedAction === 'skip-existing') {
                // "존재하지 않는 라벨만 추가" 

                try {
                    // 🔥 현재 제품 폴더를 고려한 라벨 경로 생성
                    const labelPath = this.currentFolderPrefix ? 
                        `${this.currentFolderPrefix}classification/${encodeURIComponent(finalClassName)}` : 
                        `classification/${encodeURIComponent(finalClassName)}`;
                    const filesRes = await fetch(`/api/files?path=${labelPath}`);
                    const filesData = await filesRes.json();
                    const existingFiles = filesData.items ? filesData.items.map(f => f.name) : [];

                    // 이미 라벨이 있는 이미지들 제외

                    imagesToProcess = selectedImages.filter(imagePath => {
                        const fileName = imagePath.split('/').pop();

                        return !existingFiles.includes(fileName);
                    });

                    skippedCount = selectedImages.length - imagesToProcess.length;

                    if (imagesToProcess.length === 0) {
                        alert(`All selected images already have the "${finalClassName}" label!`);

                        return;
                    }
                } catch (err) {
                    // 클래스 폴더가 없으면 모든 이미지 처리

                    this.debugLog(`Class folder not found, processing all images`);
                }
            } else if (selectedAction === 'remove-and-add') {
                // "기존 라벨 제거 후 새 라벨 추가"

                // 먼저 모든 클래스에서 선택된 이미지들의 기존 라벨 제거

                // 🔥 현재 폴더의 클래스 목록 가져오기
                const currentFolder = this.currentFolderPrefix;
                const allClasses = (await this.getClassList()).slice().sort();

                // 🔥 현재 폴더 파라미터로 삭제 API URL 생성
                const deleteApiUrl = currentFolder ? `/api/classify?folder=${encodeURIComponent(currentFolder)}` : '/api/classify';

                for (const cls of allClasses) {
                    if (cls === finalClassName) continue; // 추가할 클래스는 제외

                    try {
                        // 🔥 현재 제품 폴더를 고려한 라벨 경로 생성
                        const labelPath = this.currentFolderPrefix ?
                            `${this.currentFolderPrefix}classification/${encodeURIComponent(cls)}` :
                            `classification/${encodeURIComponent(cls)}`;
                        const filesRes = await fetch(`/api/files?path=${labelPath}`);
                        const filesData = await filesRes.json();
                        const files = filesData.items || [];

                        for (const imagePath of selectedImages) {
                            const fileName = imagePath.split('/').pop();

                            if (files.some(file => file.name === fileName)) {
                                await fetch(deleteApiUrl, {
                                    method: 'DELETE',

                                    headers: { 'Content-Type': 'application/json' },

                                    body: JSON.stringify({
                                        class_name: cls,

                                        image_name: fileName
                                    })
                                });

                                removedCount++;
                            }
                        }
                    } catch (err) {
                        // 클래스 폴더가 없을 수 있음
                    }
                }
            }

            // selectedAction === 'add-all'인 경우는 모든 이미지에 추가 (기본 동작)

            // 처리할 이미지들에 라벨 추가 - 🔥 배치 API 사용 (성능 최적화)

            // 🔥 현재 폴더 파라미터 추가
            const currentFolder = this.currentFolderPrefix;
            const apiUrl = currentFolder ? `/api/classify/batch?folder=${encodeURIComponent(currentFolder)}` : '/api/classify/batch';

            // 🔥 배치 API로 한 번의 호출로 모든 이미지 처리
            this.debugLog('배치 API로 라벨 추가:', { class: finalClassName, images: imagesToProcess.length });

            const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ class_name: finalClassName, images: imagesToProcess })
            });

            if (!response.ok) {
                throw new Error(`Batch labeling failed: ${response.status}`);
            }

            // 성공 메시지

            const processedCount = imagesToProcess.length;
            let message = `Label "${finalClassName}" added to ${processedCount} image${processedCount > 1 ? 's' : ''} successfully!`;

            if (selectedAction === 'skip-existing' && skippedCount > 0) {
                message += ` (Skipped ${skippedCount} image${skippedCount > 1 ? 's' : ''} that already had this label)`;
            } else if (selectedAction === 'remove-and-add' && removedCount > 0) {
                message += ` (Removed ${removedCount} existing label${removedCount > 1 ? 's' : ''} from other classes)`;
            }

            alert(message);

            // 모달 닫기

            this.closeAddLabelModal();

            // UI 업데이트 - 강제 새로고침

            this.debugLog('라벨 추가 완료, UI 새로고침 시작...');

            // refreshLabelExplorer가 내부에서 getClassList() 호출하므로 중복 제거
            await this.refreshLabelExplorer();
            
        } catch (error) {
            console.error('Failed to add label:', error);

            alert('Failed to add label');
        }
    }

    // --- LABEL EXPLORER ---

    async refreshLabelExplorer() {
        // 🔥 Label Explorer 새로고침 활성화
        // 🔥 중복 호출 방지
        if (this._isRefreshingLabelExplorer) {
            console.log('🔍 [LABEL_EXPLORER_DEBUG] 중복 호출 방지됨');
            return;
        }

        this._isRefreshingLabelExplorer = true;
        console.log('🔍 [LABEL_EXPLORER_DEBUG] 새로고침 시작');

        try {
            const container = document.getElementById('label-explorer-list');

        if (!container) {
            console.warn('🔍 [LABEL_EXPLORER_DEBUG] Label Explorer container not found');
            return;
        }

        const scrollTop = container.scrollTop;

        // 기존 내용을 임시로 저장하여 스크롤 위치 유지
        const existingContent = container.innerHTML;

        console.log('🔍 [LABEL_EXPLORER_DEBUG] 기존 내용 길이:', existingContent.length);

        this.debugLog('Label Explorer 새로고침 시작...');

        // 🔥 라벨링 후인 경우 캐시 완전 초기화 (단일 이미지 모드와 Grid 모드 모두)

        if ((!this.gridMode && this.selectedImagePath) || (this.gridMode && this.gridSelectedIdxs && this.gridSelectedIdxs.length > 0)) {
            this.debugLog('🔷 [DEBUG] 라벨링 후 캐시 완전 초기화');

            // 🔥 캐시 완전 초기화 (열린 폴더도 모두 새로고침)
            this.classToImgListCache = {};
            
            // 🔥 열린 폴더 상태는 유지하되, 데이터는 다시 가져옴
            // (아래 코드에서 열린 폴더를 서버에서 다시 가져옴)
        } else if (!this.classToImgListCache) {
            this.classToImgListCache = {};
        }

        const batchLabelBtn = document.getElementById('label-explorer-batch-label-btn');
        const batchDeleteBtn = document.getElementById('label-explorer-batch-delete-btn');

        // 🔥 최적화: refreshClassList()에서 받은 캐시 사용 (API 호출 생략)
        let classes = [];
        try {
            classes = await this.getClassList();
        } catch (error) {
            console.error('Label Explorer 클래스 조회 오류:', error);
            return;
        }

        // 🔥 try 제거 - 이미 Line 10162에서 시작된 try 블록 안에 있음
        if (!this.labelSelection) this.labelSelection = { selected: [], lastClicked: null, openFolders: {}, selectedClasses: [] };

        const labelSelection = this.labelSelection;
        
        this.debugLog('Label Explorer 초기화:', {
            labelSelection: labelSelection,

            classes: classes.length,

            gridMode: this.gridMode,

            openFolders: Object.keys(labelSelection.openFolders).filter(k => labelSelection.openFolders[k])
        });

        // 기본: 모든 클래스 폴더 closed (Wafer Map Explorer와 동일하게)

        // 🔥 이미 열려있는 폴더는 유지

        for (const cls of classes) {
            if (labelSelection.openFolders[cls] === undefined) labelSelection.openFolders[cls] = false;
        }

        // --- Lazy loading: 모든 폴더는 닫힌 상태로 시작, 클릭 시에만 로드 ---

        let flatImageButtons = [];
        let classToImgList = {};

        // 🔥 모든 클래스 초기화 (열려있는 폴더는 캐시에서 로드)

        for (const cls of classes) {
            if (labelSelection.openFolders[cls] && this.classToImgListCache[cls]) {
                // 열려있는 폴더는 캐시에서 로드

                classToImgList[cls] = this.classToImgListCache[cls];
            } else {
                // 닫혀있는 폴더는 빈 배열

                classToImgList[cls] = [];
            }
        }

        // 🔥 라벨링 후인 경우 열린 폴더 강제 새로고침 (단일 이미지 모드와 Grid 모드 모두)

        if ((!this.gridMode && this.selectedImagePath) || (this.gridMode && this.gridSelectedIdxs && this.gridSelectedIdxs.length > 0)) {
            this.debugLog('🔷 [DEBUG] 라벨링 후 열린 폴더 강제 새로고침');

            // 🔥 열린 폴더의 이미지 목록을 서버에서 가져오기 (병렬 처리 최적화)

            const openFolders = classes.filter(cls => labelSelection.openFolders[cls]);
            
            // 🔥 모든 폴더를 병렬로 처리 (배치 제한 제거)
            const folderPromises = openFolders.map(async (cls) => {
                    try {
                        // 🔥 현재 제품 폴더를 고려한 라벨 경로 생성
                        const labelPath = this.currentFolderPrefix ? 
                            `${this.currentFolderPrefix}classification/${encodeURIComponent(cls)}` : 
                            `classification/${encodeURIComponent(cls)}`;
                        const response = await fetch(`/api/files?path=${labelPath}`, {
                            signal: this.globalAbortController?.signal
                        });

                        const data = await response.json();
                        const imgList = Array.isArray(data.items) ? data.items : [];

                        classToImgList[cls] = imgList;

                        this.classToImgListCache[cls] = imgList;

                        this.debugLog(`🔷 [DEBUG] 폴더 '${cls}' - ${imgList.length}개 이미지 새로고침 완료`);
                    } catch (error) {
                        console.error(`폴더 '${cls}' 새로고침 실패:`, error);
                    }
                });
                
            await Promise.all(folderPromises);
        }

        this.debugLog(`🚀 Label Explorer: ${classes.length}개 클래스 초기화 완료 (열린 폴더: ${Object.keys(labelSelection.openFolders).filter(k => labelSelection.openFolders[k]).length}개)`);

        // --- 빈 곳 클릭 시 Label Explorer만 선택 해제 (Wafer Map Explorer 선택 유지) ---

        container.onclick = (e) => {
            // 빈 영역을 클릭했을 때만 (버튼이나 다른 요소가 아닌)

            if (e.target === container || 

                (e.target.tagName === 'UL' && e.target.closest('#label-explorer-list'))) {
                // Ctrl/Shift 없이 클릭: Label Explorer만 선택 해제 (Wafer Map Explorer 선택 유지)

                if (!e.ctrlKey && !e.shiftKey) {
                    labelSelection.selected = [];

                    labelSelection.selectedClasses = [];

                    this.updateLabelExplorerSelection();

                    // Wafer Map Explorer 선택은 유지하도록 clearWaferMapExplorerSelection() 호출 제거

                    this.debugLog('Label Explorer: 빈 영역 클릭으로 Label Explorer만 선택 해제 (Wafer Map Explorer 선택 유지)');
                }
            }
        };

        // --- 우클릭으로 Label Explorer만 선택 해제 ---
        container.oncontextmenu = (e) => {
                        e.preventDefault();
            e.stopPropagation(); // 🚀 이벤트 버블링 방지 (Wafer Map Explorer 우클릭 방해 방지)

            // 🔥 무조건 이미지 정보 패널 숨기기
            if (this.dom.fileNameDisplay) {
                this.dom.fileNameDisplay.style.display = 'none';
            }

            // Label Explorer 선택 해제
            if (this.labelSelection) {
                this.labelSelection.selected = [];
                this.labelSelection.selectedClasses = [];
            }

            // savedViewState로 복원
            if (this.savedViewState) {
                if (this.savedViewState.type === 'grid' && this.savedViewState.images && this.savedViewState.images.length > 0) {
                    this.selectedImages = [...this.savedViewState.images];
                    this.showGrid(this.savedViewState.images, true);  // skipSaveState=true로 호출

                    // 파일명 패널 숨기기 (Label Explorer에서 돌아왔으므로)
                    if (this.dom.fileNameDisplay) {
                        this.dom.fileNameDisplay.style.display = 'none';
                    }
                    
                    // 스크롤 위치 복원
                    if (this.savedViewState.scrollTop !== undefined) {
                        setTimeout(() => {
                            const grid = document.getElementById('image-grid');
                            const scrollWrapper = grid?.parentElement;
                            if (scrollWrapper) {
                                scrollWrapper.scrollTop = this.savedViewState.scrollTop;
                            }
                        }, 100);
                    }
                } else if (this.savedViewState.type === 'single') {
                    this.loadImage(this.savedViewState.imagePath).then(() => {
                        this.zoom = this.savedViewState.zoom;
                        this.offsetX = this.savedViewState.offsetX;
                        this.offsetY = this.savedViewState.offsetY;
                        // 🔥 loadImage가 자동으로 렌더링하므로 render() 호출 불필요
                    });
                }
            } else {
                this.hideGrid();
                this.hideImage();
                this.selectedImages = [];
                this.currentImage = null;
                this.gridMode = false;
                this.currentGridImages = [];
                this.showInitialState();
            }

            this.updateLabelExplorerSelection();
                    };

        // --- 키보드 단축키 (Label Explorer 전용) ---

        this.setupLabelExplorerKeyboardShortcuts(classes, classToImgList, labelSelection);

        // Label Explorer 프레임(여백) 클릭 시 전체 선택 해제 (Windows 탐색기 스타일)

        const frame = document.querySelector('.label-explorer-frame');

        if (frame && !frame.hasAttribute('data-click-bound')) {
            frame.setAttribute('data-click-bound', 'true');

            frame.onclick = (e) => {
                                // 프레임 자체를 클릭하고, Ctrl/Shift가 없을 때만 Label Explorer만 선택 해제

                if (e.target === frame && !e.ctrlKey && !e.shiftKey) {
                                        // 🔥 무조건 이미지 정보 패널 숨기기
                    if (this.dom.fileNameDisplay) {
                        this.dom.fileNameDisplay.style.display = 'none';
                        console.log('🟢 [HIDE-PANEL] 프레임 클릭 시 파일명 패널 숨김');
                    }

                    // 🔥 직접 복원 로직 처리 (clearLabelExplorerSelection 사용 안함)

                    // Label Explorer 선택 해제 및 이전 상태 복원

                    if (this.labelSelection) {
                                                this.labelSelection.selected = [];

                        this.labelSelection.selectedClasses = [];
                    }

                                        // savedViewState로 복원

                    if (this.savedViewState && this.savedViewState.type === 'grid' && this.savedViewState.images.length > 0) {
                                                this.selectedImages = [...this.savedViewState.images];

                        this.showGrid(this.savedViewState.images, true);  // skipSaveState=true로 호출

                        // 파일명 패널 숨기기 (Label Explorer에서 돌아왔으므로)
                        if (this.dom.fileNameDisplay) {
                            this.dom.fileNameDisplay.style.display = 'none';
                        }

                        // 스크롤 위치 복원
                        if (this.savedViewState.scrollTop !== undefined) {
                            setTimeout(() => {
                                const grid = document.getElementById('image-grid');
                                const scrollWrapper = grid?.parentElement;
                                if (scrollWrapper) {
                                    scrollWrapper.scrollTop = this.savedViewState.scrollTop;
                                }
                            }, 100);
                        }
                    } else if (this.savedViewState && this.savedViewState.type === 'single') {
                                                this.loadImage(this.savedViewState.imagePath).then(() => {
                            this.zoom = this.savedViewState.zoom;

                            this.offsetX = this.savedViewState.offsetX;

                            this.offsetY = this.savedViewState.offsetY;

                            // 🔥 loadImage가 자동으로 렌더링하므로 render() 호출 불필요
                        });
                    } else {
                                                this.hideGrid();

                        this.hideImage();

                        this.selectedImages = [];

                        this.currentImage = null;

                        this.gridMode = false;

                        this.currentGridImages = [];

                        this.showInitialState();
                    }

                    this.updateLabelExplorerSelection();
                                    }
            };

            // 프레임 우클릭도 추가 (Windows 탐색기와 일관성)

            frame.oncontextmenu = (e) => {
                if (e.target === frame) {
                    e.preventDefault();

                    e.stopPropagation(); // 🚀 이벤트 버블링 방지

                    labelSelection.selected = [];

                    labelSelection.selectedClasses = [];

                    this.updateLabelExplorerSelection();

                    // Wafer Map Explorer 선택은 유지하도록 clearWaferMapExplorerSelection() 호출 제거

                    this.debugLog('Label Explorer 프레임: 우클릭으로 Label Explorer만 선택 해제 (Wafer Map Explorer 선택 유지)');
                }
            };
        }

        // Add Label 버튼: 모달 창 열기

        batchLabelBtn.disabled = false;

        batchLabelBtn.onclick = async () => {
            await this.openAddLabelModal();
        };

        // Delete Label 버튼: 항상 활성화

        batchDeleteBtn.disabled = false;

        batchDeleteBtn.onclick = async () => {

            const t0 = performance.now();

            if (labelSelection.selectedClasses.length === 0 && labelSelection.selected.length === 0) {
                alert('삭제할 라벨을 선택해주세요.');

                return;
            }

            // 클래스별로 이미지 그룹화

            const classToDel = {}; // { "className": ["img1.png", "img2.png", ...] }
            let totalToDelete = 0;

            // 클래스 선택: 해당 클래스 폴더 안의 모든 라벨 삭제 (클래스는 유지)

            if (labelSelection.selectedClasses.length) {
                for (const cls of labelSelection.selectedClasses) {
                    // 🔥 현재 제품 폴더를 고려한 라벨 경로 생성
                    const labelPath = this.currentFolderPrefix ? 
                        `${this.currentFolderPrefix}classification/${encodeURIComponent(cls)}` : 
                        `classification/${encodeURIComponent(cls)}`;
                    const imgRes = await fetch(`/api/files?path=${labelPath}`);
                    const imgData = await imgRes.json();
                    const imgList = Array.isArray(imgData.items) ? imgData.items : [];
                    const files = imgList.filter(f => f.type === 'file');

                    if (files.length > 0) {
                        classToDel[cls] = files.map(f => f.name);

                        totalToDelete += files.length;
                    }
                }
            }

            // 이미지 선택: 해당 라벨만 삭제

            if (labelSelection.selected.length) {
                labelSelection.selected.forEach(key => {
                    const [delCls, delImg] = key.split('/');

                    if (!classToDel[delCls]) classToDel[delCls] = [];

                    classToDel[delCls].push(delImg);

                    totalToDelete++;
                });
            }

            if (totalToDelete === 0) {
                return;
            }


            if (!confirm(`Delete ${totalToDelete} labels?`)) {
                return;
            }

            this.debugLog(`⏱ DELETE 요청 시작: ${totalToDelete}개 (${Object.keys(classToDel).length}개 클래스)`);

            const tDel = performance.now();

            // 🔥 클래스별 배치 DELETE 요청 병렬 처리

            // 🔥 현재 폴더 파라미터 추가
            const currentFolder = this.currentFolderPrefix;
            const deleteApiUrl = currentFolder ? `/api/classify/delete?folder=${encodeURIComponent(currentFolder)}` : '/api/classify/delete';


            const batchPromises = Object.entries(classToDel).map(async ([cls, images]) => {
                this.debugLog(`🗑️ DELETE 요청: class=${cls}, images=${images.length}개`, images);

                const response = await fetch(deleteApiUrl, {
                    method: 'POST',

                    headers: { 'Content-Type': 'application/json' },

                    body: JSON.stringify({ class: cls, images: images })
                });

                if (!response.ok) {
                    const errorText = await response.text();

                    console.error(`❌ DELETE 실패: class=${cls}`, {
                        status: response.status,

                        statusText: response.statusText,

                        error: errorText
                    });

                    throw new Error(`DELETE failed: ${response.status} ${response.statusText}`);
                }

                const result = await response.json();

                this.debugLog(`✅ DELETE 성공: class=${cls}, removed=${result.removed}개`, result);

                return result;
            });

            const results = await Promise.all(batchPromises);
            const totalRemoved = results.reduce((sum, r) => sum + (r.removed || 0), 0);

            this.debugLog(`⏱ DELETE 완료: ${(performance.now()-tDel).toFixed(1)}ms (${totalRemoved}/${totalToDelete}개 삭제됨)`);

            // 선택 상태 완전 초기화

            labelSelection.selectedClasses = [];

            labelSelection.selected = [];

            labelSelection.lastSelectedKey = null;

            // 🔥 DOM에서 직접 제거 (새로고침 없이)
            Object.entries(classToDel).forEach(([cls, images]) => {
                images.forEach(imgName => {
                    // Label Explorer에서 해당 항목 찾기
                    const container = document.getElementById('label-explorer-list');
                    if (container) {
                        const buttons = container.querySelectorAll('button.label-img-name');
                        buttons.forEach(btn => {
                            if (btn.textContent === imgName) {
                                const li = btn.closest('li');
                                const classLi = li?.parentElement?.closest('li');
                                if (classLi) {
                                    const folderSummary = classLi.querySelector('div');
                                    const folderCls = folderSummary?.textContent.replace(/[▾▸]/g, '').trim();
                                    if (folderCls === cls) {
                                        // 해당 li 제거
                                        li.remove();
                                    }
                                }
                            }
                        });

                        // 해당 클래스 폴더의 ul 찾기
                        const allClassFolders = container.querySelectorAll('li > div');
                        allClassFolders.forEach(folderDiv => {
                            const folderCls = folderDiv.textContent.replace(/[▾▸]/g, '').trim();
                            if (folderCls === cls) {
                                const ul = folderDiv.nextElementSibling;
                                if (ul && ul.tagName === 'UL') {
                                    // ul 안에 li가 없으면 "라벨된 이미지 없음" 메시지 표시
                                    const remainingItems = ul.querySelectorAll('li');
                                    if (remainingItems.length === 0) {
                                        ul.innerHTML = '<li style="color:#888;padding:4px 12px;">라벨된 이미지 없음</li>';
                                    }
                                }
                            }
                        });
                    }

                    // 캐시에서도 제거
                    if (this.classToImgListCache[cls]) {
                        const idx = this.classToImgListCache[cls].findIndex(img => img.name === imgName);
                        if (idx > -1) {
                            this.classToImgListCache[cls].splice(idx, 1);
                        }
                    }
                });
            });

            // 🔥 Class Manager와 Label Explorer 모두 새로고침
            const tRefresh = performance.now();
            // refreshLabelExplorer가 내부에서 getClassList() 호출하므로 중복 제거
            await this.refreshLabelExplorer();

            this.debugLog(`⏱ Label Explorer 새로고침: ${(performance.now()-tRefresh).toFixed(1)}ms`);

            // 🔥 Delete Label 후 선택 해제
            labelSelection.selected = [];
            labelSelection.selectedClasses = [];
            this.updateLabelExplorerSelection();

            // 🔥 Delete Label 후 자동으로 이전 상태로 복원
            // savedViewState가 있으면 복원, 없으면 초기 화면으로
            // (Label Explorer는 savedViewState를 업데이트하지 않으므로,
            //  savedViewState가 있다면 무조건 Wafer Map Explorer의 상태임)
            
            if (this.savedViewState) {
                try {
                    await this.restoreSavedViewState();
                } catch (error) {
                    console.warn('⚠️ [DELETE] 복원 중 오류 발생 - 초기 화면으로:', error);
                    // 오류 발생 시 초기 화면으로
                    this.hideGrid();
                    this.hideImage();
                    this.clearLabelExplorerSelection();
                }
            } else {
                // savedViewState가 없으면 초기 화면으로
                this.hideGrid();
                this.hideImage();
                this.clearLabelExplorerSelection();
            }

            this.debugLog(`⏱ Delete Label 전체: ${(performance.now()-t0).toFixed(1)}ms`);
        };

        // 전체 내용을 다시 렌더링하되 스크롤 위치 유지
        this.renderLabelExplorerContent(container, classes, classToImgList, labelSelection);
        
        // 스크롤 위치 복원

        if (container) container.scrollTop = scrollTop;

        this.debugLog('Label Explorer 새로고침 완료');
        } catch (error) {
            console.error('Label Explorer 새로고침 실패:', error);

            // 에러 발생 시 기존 내용 복원

            if (container) {
                container.innerHTML = existingContent;

                container.scrollTop = scrollTop;
            }
        } finally {
            // 🔥 중복 호출 방지 플래그 해제
            this._isRefreshingLabelExplorer = false;
            console.log('🔍 [LABEL_EXPLORER_DEBUG] 새로고침 완료');
        }
    }

    renderLabelExplorerContent(container, classes, classToImgList, labelSelection) {
        console.log('🔍 [RENDER_DEBUG] renderLabelExplorerContent 시작');
        console.log('🔍 [RENDER_DEBUG] classes:', classes);
        console.log('🔍 [RENDER_DEBUG] classToImgList keys:', Object.keys(classToImgList));
        
        container.innerHTML = '';

        // 전체 이미지들의 평평한 리스트 생성 (shift 선택용)

        let flatImageList = [];

        for (const cls of classes) {
            const imgList = classToImgList[cls] || [];

            for (const img of imgList) {
                if (img.type === 'file') {
                    flatImageList.push({ key: `${cls}/${img.name}`, className: cls, imgName: img.name });
                }
            }
        }

        // 트리 구조 렌더링

        const ul = document.createElement('ul');

        ul.style.listStyle = 'none';

        ul.style.paddingLeft = '0';

        for (const cls of classes) {
            const li = document.createElement('li');

            li.style.marginBottom = '4px';

            // 폴더 summary

            const folderSummary = document.createElement('div');

            folderSummary.style.cursor = 'pointer';

            folderSummary.style.display = 'flex';

            folderSummary.style.alignItems = 'center';

            folderSummary.style.userSelect = 'none';

            folderSummary.style.fontWeight = 'bold';

            folderSummary.style.fontSize = '15px';

            folderSummary.style.color = '#fff';

            folderSummary.style.padding = '2px 0';

            // 선택 강조

            const isClassSelected = labelSelection.selectedClasses.includes(cls);

            if (isClassSelected) {
                folderSummary.style.background = '#09f';

                folderSummary.style.color = '#fff';

                folderSummary.style.borderRadius = '6px';
            }

            const isOpen = labelSelection.openFolders[cls];

            folderSummary.innerHTML = `<span style=\"font-size:16px; margin-right:4px;\">${isOpen ? '▾' : '▸'}</span>${cls}`;

            folderSummary.onclick = (e) => {
                const isCtrl = e.ctrlKey || e.metaKey;
                const isShift = e.shiftKey;

                // 다른 Explorer 선택 해제

                try {
                    this.clearWaferMapExplorerSelection();
                } catch (error) {
                    console.warn('clearWaferMapExplorerSelection error:', error);
                }

                // 아무 modifier 없이 클릭: 열기/닫기 토글만

                if (!isCtrl && !isShift) {
                    const wasOpen = isOpen;
                    labelSelection.openFolders[cls] = !isOpen;

                    // 🔥 폴더를 열 때 항상 서버에서 최신 데이터 가져오기 (캐시 무시)
                    if (!wasOpen) {
                        this.debugLog(`🚀 폴더 열기: '${cls}' - 최신 이미지 로드 중...`);

                        // 🔥 현재 제품 폴더를 고려한 라벨 경로 생성
                        const labelPath = this.currentFolderPrefix ? 
                            `${this.currentFolderPrefix}classification/${encodeURIComponent(cls)}` : 
                            `classification/${encodeURIComponent(cls)}`;
                        
                        // 🔥 캐시 무시 - 항상 서버에서 최신 데이터 가져오기
                        fetch(`/api/files?path=${labelPath}`)
                            .then(res => res.json())
                            .then(data => {
                                const imgList = Array.isArray(data.items) ? data.items : [];

                                // 🔥 캐시 업데이트
                                if (!this.classToImgListCache) this.classToImgListCache = {};
                                this.classToImgListCache[cls] = imgList;

                                this.debugLog(`✅ 폴더 '${cls}' - ${imgList.length}개 이미지 로드 완료`);

                                // 🔥 fetch 완료 후 한 번만 업데이트
                                this.updateLabelExplorerContent();
                            })
                            .catch(err => {
                                console.error(`폴더 '${cls}' 이미지 로드 실패:`, err);

                                if (!this.classToImgListCache) this.classToImgListCache = {};
                                this.classToImgListCache[cls] = [];

                                // 🔥 에러 발생 시에도 한 번만 업데이트
                                this.updateLabelExplorerContent();
                            });
                    } else {
                        // 🔥 폴더를 닫을 때 캐시 무효화 (다음에 열 때 최신 데이터 가져오도록)
                        if (this.classToImgListCache && this.classToImgListCache[cls]) {
                            delete this.classToImgListCache[cls];
                            this.debugLog(`🗑️ 폴더 닫기: '${cls}' - 캐시 삭제`);
                        }
                        
                        // 🔥 폴더 닫을 때만 업데이트
                        this.updateLabelExplorerContent();
                    }

                    return;
                }

                // Ctrl/Shift로 클릭: 클래스 선택 (이미지 선택은 해제)

                labelSelection.selected = []; // 이미지 선택 해제

                if (isShift && labelSelection.lastClickedClass !== null) {
                    // Shift+클릭: 범위 선택

                    const all = classes;
                    const lastIdx = all.indexOf(labelSelection.lastClickedClass);
                    const thisIdx = all.indexOf(cls);

                    if (lastIdx !== -1 && thisIdx !== -1) {
                        const [from, to] = [lastIdx, thisIdx].sort((a,b)=>a-b);
                        const range = all.slice(from, to+1);

                        labelSelection.selectedClasses = Array.from(new Set([...labelSelection.selectedClasses, ...range]));
                    }
                } else if (isCtrl) {
                    // Ctrl+클릭: 토글 선택

                    if (labelSelection.selectedClasses.includes(cls)) {
                        labelSelection.selectedClasses = labelSelection.selectedClasses.filter(k => k !== cls);
                    } else {
                        labelSelection.selectedClasses = [...labelSelection.selectedClasses, cls];
                    }

                    labelSelection.lastClickedClass = cls;
                }

                // 클래스 선택에 따른 그리드 모드 전환

                if (labelSelection.selectedClasses.length === 1) {
                    // 단일 클래스 선택: 해당 클래스의 모든 이미지를 그리드로 표시

                    const selectedClass = labelSelection.selectedClasses[0];

                    this.debugLog(`Label Explorer: 클래스 '${selectedClass}' → 그리드 모드`);

                    this.showGridFromClass(selectedClass);
                } else if (labelSelection.selectedClasses.length > 1) {
                    // 다중 클래스 선택: 모든 선택된 클래스의 이미지를 그리드로 표시

                    this.debugLog(`Label Explorer: ${labelSelection.selectedClasses.length}개 클래스 → 그리드 모드`);

                    this.showGridFromMultipleClasses(labelSelection.selectedClasses);
                } else {
                    // 클래스 선택 없음: 이전 Grid 상태로 복귀 또는 이미지 숨기기

                    if (this.gridMode) {
                        this.debugLog('Label Explorer: 클래스 선택 해제 → 이전 Grid 상태로 복귀');

                        this.restorePreviousGridState();
                    } else {
                        // 단일 이미지 모드에서도 이미지 숨기기

                        this.debugLog('Label Explorer: 클래스 선택 해제 → 이미지 숨기기');

                        this.restorePreviousGridState(); // 이전 Grid 상태가 없으면 hideImage() 포함
                    }
                }

                this.updateLabelExplorerContent();

                // 클래스 매니저 버튼 상태 업데이트

                this.updateClassManagerButtons();
            };

            li.appendChild(folderSummary);

            // 이미지 리스트(펼쳐진 경우만)

            if (isOpen) {
                const imgUl = document.createElement('ul');

                imgUl.style.listStyle = 'none';

                imgUl.style.paddingLeft = '18px';

                imgUl.style.margin = '0';

                // robust: ul 내부 어디든(버튼/텍스트 제외) 클릭 시 선택 해제

                imgUl.addEventListener('click', (e) => {
                    // 버튼/텍스트/이미지 아닌 곳만

                    if (e.target === imgUl) {
                        labelSelection.selected = [];

                        labelSelection.selectedClasses = [];

                        // 이전 Grid 상태로 복귀 또는 이미지 숨기기

                        if (this.gridMode) {
                            this.debugLog('Label Explorer: 선택 해제 → 이전 Grid 상태로 복귀');

                            this.restorePreviousGridState();
                        } else {
                            // 단일 이미지 모드에서도 이미지 숨기기

                            this.debugLog('Label Explorer: 선택 해제 → 이미지 숨기기');

                            this.restorePreviousGridState(); // 이전 Grid 상태가 없으면 hideImage() 포함
                        }

                        // 클래스 매니저 버튼 상태 업데이트

                        this.updateClassManagerButtons();

                        this.updateLabelExplorerContent();
                    }
                }, true); // capture phase로 등록

                const imgList = classToImgList[cls] || [];

                for (let i = 0; i < imgList.length; ++i) {
                    const img = imgList[i];

                    if (img.type !== 'file') continue;

                    const imgLi = document.createElement('li');

                    imgLi.style.display = 'flex';

                    imgLi.style.alignItems = 'center';

                    imgLi.style.margin = '2px 0';

                    const imgBtn = document.createElement('button');

                    imgBtn.textContent = img.name;

                    imgBtn.className = 'label-img-name';

                    imgBtn.style.cursor = 'pointer';

                    imgBtn.style.padding = '4px 12px';

                    imgBtn.style.background = labelSelection.selected.includes(`${cls}/${img.name}`) ? '#08e' : '#222';

                    imgBtn.style.color = '#fff';

                    imgBtn.style.border = '1px solid #444';

                    imgBtn.style.borderRadius = '6px';

                    imgBtn.style.marginRight = '4px';

                    imgBtn.style.fontSize = '13px';

                    // 🔥 Drag 범위 선택 이벤트 추가
                    imgBtn.draggable = true;

                    // 🔥 마우스 hover 효과 추가 (선택된 아이템 제외)
                    imgBtn.onmouseover = (e) => {
                        const key = `${cls}/${img.name}`;
                        const isSelected = labelSelection.selected.includes(key);
                        // 선택된 항목에는 hover 효과 없음
                        if (!isSelected && !this.dragStartKey) {
                            imgBtn.style.background = '#08e'; // hover 색상
                        }
                    };
                    
                    imgBtn.onmouseout = (e) => {
                        const key = `${cls}/${img.name}`;
                        const isSelected = labelSelection.selected.includes(key);
                        // 선택되지 않은 항목만 원래 색으로 복원
                        if (!isSelected && !this.dragStartKey) {
                            imgBtn.style.background = '#222';
                        }
                    };

                    imgBtn.ondragstart = (e) => {
                        const key = `${cls}/${img.name}`;
                        
                        // 드래그 시작점 저장
                        this.dragStartKey = key;
                        this.dragStartClass = cls;
                        
                        // DataTransfer 설정
                        e.dataTransfer.effectAllowed = 'all';
                        e.dataTransfer.setData('text/plain', key);
                        
                        // 드래그 이미지 숨기기
                        const emptyImg = document.createElement('img');
                        emptyImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                        e.dataTransfer.setDragImage(emptyImg, 0, 0);
                        
                        // 드래그 중 시각적 피드백
                        imgBtn.style.removeProperty('background');
                        imgBtn.style.setProperty('background', '#07d', 'important');
                    };

                    imgBtn.ondragover = (e) => {
                        e.preventDefault();
                        
                        // 드래그 중인 요소 위로 마우스가 왔을 때
                        if (this.dragStartKey) {
                            const key = `${cls}/${img.name}`;
                            
                            // 같은 클래스 내에서만 범위 선택
                            if (this.dragStartClass === cls) {
                                // 호버 피드백
                                imgBtn.style.background = '#05b';
                            }
                        }
                    };

                    imgBtn.ondragleave = (e) => {
                        // 호버 피드백 제거
                        const key = `${cls}/${img.name}`;
                        const isSelected = labelSelection.selected.includes(key);
                        imgBtn.style.background = isSelected ? '#06c' : '#222';
                    };

                    imgBtn.ondrop = (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        
                        const endKey = `${cls}/${img.name}`;
                        
                        // 같은 클래스 내에서만 범위 선택
                        if (this.dragStartKey && this.dragStartClass === cls) {
                            // 평평한 이미지 리스트에서 시작과 끝 인덱스 찾기
                            const imgList = classToImgList[cls] || [];
                            const allKeys = imgList.filter(f => f.type === 'file').map(f => `${cls}/${f.name}`);
                            
                            const startIdx = allKeys.indexOf(this.dragStartKey);
                            const endIdx = allKeys.indexOf(endKey);
                            
                            if (startIdx !== -1 && endIdx !== -1) {
                                const [from, to] = [startIdx, endIdx].sort((a, b) => a - b);
                                const range = allKeys.slice(from, to + 1);
                                
                                // 기존 선택에 추가
                                labelSelection.selected = Array.from(new Set([...labelSelection.selected, ...range]));
                                
                                // 선택 상태 업데이트
                                this.updateLabelExplorerContent();
                                this.updateLabelExplorerSelection();
                                
                                // 다중 선택된 경우 Grid 모드로 전환
                                if (range.length > 1) {
                                    this.showGridFromLabelExplorer(labelSelection.selected);
                                } else if (range.length === 1) {
                                    // 단일 이미지는 클릭과 동일하게 처리
                                    const selectedKey = range[0];
                                    const fileName = selectedKey.split('/')[1];
                                    const imgList = this.classToImgListCache?.[cls] || [];
                                    const selectedImg = imgList.find(item => item.name === fileName);
                                    if (selectedImg?.root_relative) {
                                        this.saveCurrentViewStateForLabelExplorer();
                                        if (this.gridMode) {
                                            this.hideGrid();
                                        }
                                        this.loadImage(selectedImg.root_relative);
                                    }
                                }
                            }
                        }
                        
                        // 드래그 상태 초기화
                        this.dragStartKey = null;
                        this.dragStartClass = null;
                        
                        // 시각적 피드백 복원
                        const isSelected = labelSelection.selected.includes(endKey);
                        imgBtn.style.removeProperty('background');
                        imgBtn.style.background = isSelected ? '#06c' : '#222';
                    };

                    imgBtn.ondragend = (e) => {
                        // 드래그 상태 초기화
                        this.dragStartKey = null;
                        this.dragStartClass = null;
                        
                        // 시각적 피드백 복원
                        const key = `${cls}/${img.name}`;
                        const isSelected = labelSelection.selected.includes(key);
                        imgBtn.style.removeProperty('background');
                        imgBtn.style.background = isSelected ? '#06c' : '#222';
                    };

                    imgBtn.onclick = (e) => {
                        const isCtrl = e.ctrlKey || e.metaKey;
                        const isShift = e.shiftKey;
                        const key = `${cls}/${img.name}`;

                        this.debugLog('🔷 [DEBUG] Label Explorer 이미지 클릭 시작:', {
                            key: key,

                            gridMode: this.gridMode,

                            gridSelectedIdxs: this.gridSelectedIdxs,

                            selectedImages: this.selectedImages,

                            selectedImagesLength: this.selectedImages?.length,

                            currentGridImages: this.currentGridImages,

                            currentGridImagesLength: this.currentGridImages?.length
                        });

                        // 다른 Explorer 선택 해제

                        try {
                            this.clearWaferMapExplorerSelection();
                        } catch (error) {
                            console.warn('clearWaferMapExplorerSelection error:', error);
                        }

                        // 🔧 Grid 모드에서도 Label Explorer 선택 유지

                        // 그리드 모드 상태를 확인하고 선택 상태를 유지

                        if (this.gridMode) {
                            this.debugLog('🚀 Grid 모드에서 Label Explorer 선택 유지');

                            // 그리드 모드에서는 선택 상태를 유지하고 클래스 매니저 버튼 활성화

                            // 클래스 매니저 버튼 상태 업데이트

                            this.updateClassManagerButtons();
                        }

                        if (isShift && labelSelection.lastClicked !== null) {
                            // Shift+클릭: 범위 선택

                            const lastIdx = flatImageList.findIndex(item => item.key === labelSelection.lastClicked);
                            const thisIdx = flatImageList.findIndex(item => item.key === key);

                            if (lastIdx !== -1 && thisIdx !== -1) {
                                const [from, to] = [lastIdx, thisIdx].sort((a,b)=>a-b);
                                const range = flatImageList.slice(from, to+1).map(item => item.key);

                                labelSelection.selected = Array.from(new Set([...labelSelection.selected, ...range]));
                            }
                        } else if (isCtrl) {
                            // Ctrl+클릭: 토글 선택

                            if (labelSelection.selected.includes(key)) {
                                labelSelection.selected = labelSelection.selected.filter(k => k !== key);
                            } else {
                                labelSelection.selected = [...labelSelection.selected, key];
                            }

                            labelSelection.lastClicked = key;
                        } else {
                            // 단일 클릭: 이미 선택된 항목이면 해제, 다른 항목이면 새로 선택

                            if (labelSelection.selected.includes(key) && labelSelection.selected.length === 1) {
                                // 유일하게 선택된 항목을 다시 클릭: 해제

                                labelSelection.selected = [];

                                labelSelection.lastClicked = null;
                            } else {
                                // 새로운 항목 클릭 또는 다중 선택 상태: 기존 선택 해제 후 새로 선택

                                labelSelection.selected = [key];

                                labelSelection.lastClicked = key;
                            }
                        }

                        // 선택된 이미지에 따라 단일/그리드 모드 결정
                        if (labelSelection.selected.length > 0) {
                            if (labelSelection.selected.length === 1) {
                                // 단일 선택: 단일 이미지 모드
                                const selectedKey = labelSelection.selected[0];

                                this.debugLog(`Label Explorer: 단일 이미지 모드 - ${selectedKey}`);

                                this.debugLog('🔷 [DEBUG] Label Explorer 단일 이미지 모드 전 상태:', {
                                    gridMode: this.gridMode,

                                    gridSelectedIdxs: this.gridSelectedIdxs,

                                    selectedImages: this.selectedImages,

                                    selectedImagesLength: this.selectedImages?.length,

                                    currentGridImages: this.currentGridImages,

                                    currentGridImagesLength: this.currentGridImages?.length
                                });

                                // 🔥 Label Explorer 진입 전 현재 상태 저장

                                this.saveCurrentViewStateForLabelExplorer();

                                // grid mode 해제하고 single image mode로 전환

                                if (this.gridMode) {
                                    this.hideGrid();
                                }

                                // 🔥 Label Explorer 내에서는 저장하지 않음 (이미 저장된 상태 유지)

                                this.debugLog('🔄 [SAVE] Label Explorer 내 이동 - 저장하지 않음, 기존 상태 유지');

                                // 🔥 그리드 모드에서 온 경우 singleImageFromGrid 플래그 설정

                                if (this.gridMode) {
                                    this.singleImageFromGrid = true;

                                    this.selectedImages = this.currentGridImages || [];
                                }

                                // 🔥 root_relative 사용 (ROOT_DIR 기준 절대 경로)
                                const fileName = selectedKey.split('/')[1];
                                const imgList = this.classToImgListCache?.[cls] || [];
                                const selectedImg = imgList.find(item => item.name === fileName);
                                this.loadImage(selectedImg.root_relative, true);  // 🔥 Label Explorer에서 호출 시 저장 안 함
                            } else {
                                // 다수 선택: 그리드 모드

                                this.debugLog(`Label Explorer: 그리드 모드 - ${labelSelection.selected.length}개 이미지`);

                                this.debugLog('🔷 [DEBUG] Label Explorer 다중 선택 전 상태:', {
                                    gridMode: this.gridMode,

                                    gridSelectedIdxs: this.gridSelectedIdxs,

                                    selectedImages: this.selectedImages,

                                    selectedImagesLength: this.selectedImages?.length,

                                    currentGridImages: this.currentGridImages,

                                    currentGridImagesLength: this.currentGridImages?.length
                                });

                                this.showGridFromLabelExplorer(labelSelection.selected);
                            }
                        } else {
                            // 선택 없음: 이전 Grid 상태로 복귀 또는 이미지 숨기기

                            if (this.gridMode) {
                                this.debugLog('Label Explorer: 선택 해제 → 이전 Grid 상태로 복귀');

                                this.restorePreviousGridState();
                            } else {
                                // 단일 이미지 모드에서도 이미지 숨기기
                                this.debugLog('Label Explorer: 선택 해제 → 이미지 숨기기');

                                this.restorePreviousGridState(); // 이전 Grid 상태가 없으면 hideImage() 포함
                            }
                        }

                        // 강제로 업데이트 (약간의 지연 후)
                        setTimeout(() => {
                            this.updateLabelExplorerSelection();
                        }, 10);

                        this.debugLog('Label Explorer 선택 후 상태:', {
                            selected: labelSelection.selected,

                            selectedClasses: labelSelection.selectedClasses,

                            lastClicked: labelSelection.lastClicked
                        });
                    };

                    imgLi.appendChild(imgBtn);

                    const delBtn = document.createElement('button');

                    delBtn.textContent = '🗑️';

                    delBtn.className = 'label-img-del-btn';

                    delBtn.style.marginLeft = '4px';

                    delBtn.onclick = async (e) => {
                        e.stopPropagation();

                        let toDelete = [`${cls}/${img.name}`];

                        if (labelSelection.selected.includes(`${cls}/${img.name}`)) {
                            toDelete = labelSelection.selected;
                        }

                        // 🔥 현재 폴더 파라미터 추가
                        const currentFolder = this.currentFolderPrefix;
                        const deleteApiUrl = currentFolder ? `/api/classify?folder=${encodeURIComponent(currentFolder)}` : '/api/classify';

                        for (const key of toDelete) {
                            const [delCls, delImg] = key.split('/');

                            await fetch(deleteApiUrl, {
                                method: 'DELETE',

                                headers: { 'Content-Type': 'application/json' },

                                body: JSON.stringify({ class_name: delCls, image_name: delImg })
                            });
                        }

                        labelSelection.selected = [];

                        // 해당 클래스의 이미지 리스트만 다시 fetch해서 ul만 갱신

                        // 🔥 현재 제품 폴더를 고려한 라벨 경로 생성
                    const labelPath = this.currentFolderPrefix ? 
                        `${this.currentFolderPrefix}classification/${encodeURIComponent(cls)}` : 
                        `classification/${encodeURIComponent(cls)}`;
                    const imgRes = await fetch(`/api/files?path=${labelPath}`);
                        const imgData = await imgRes.json();
                        const imgList = Array.isArray(imgData.items) ? imgData.items : [];

                        // ul 내부만 갱신

                        imgUl.innerHTML = '';

                        for (let i = 0; i < imgList.length; ++i) {
                            const img = imgList[i];

                            if (img.type !== 'file') continue;

                            const labelKey = `${cls}/${img.name}`;
                            const imgLi = document.createElement('li');

                            imgLi.style.display = 'flex';

                            imgLi.style.alignItems = 'center';

                            imgLi.style.margin = '2px 0';

                            const imgBtn = document.createElement('button');

                            imgBtn.textContent = img.name;

                            imgBtn.className = 'label-img-name';

                            imgBtn.style.cursor = 'pointer';

                            imgBtn.style.padding = '4px 12px';

                            imgBtn.style.background = labelSelection.selected.includes(labelKey) ? '#06c' : '#222';

                            imgBtn.style.color = '#fff';

                            imgBtn.style.border = '1px solid #444';

                            imgBtn.style.borderRadius = '6px';

                            imgBtn.style.marginRight = '4px';

                            imgBtn.style.fontSize = '13px';

                            // 🔥 Drag 범위 선택 이벤트 추가 (동적 생성된 버튼)
                            imgBtn.draggable = true;

                            // 🔥 마우스 hover 효과 추가
                            imgBtn.onmouseover = (e) => {
                                const key = `${cls}/${img.name}`;
                                const isSelected = labelSelection.selected.includes(key);
                                if (!isSelected && !this.dragStartKey) {
                                    imgBtn.style.background = '#08e'; // hover 색상
                                }
                            };
                            
                            imgBtn.onmouseout = (e) => {
                                const key = `${cls}/${img.name}`;
                                const isSelected = labelSelection.selected.includes(key);
                                if (!this.dragStartKey) {
                                    imgBtn.style.background = isSelected ? '#06c' : '#222';
                                }
                            };

                            imgBtn.ondragstart = (e) => {
                                const key = `${cls}/${img.name}`;
                                
                                // 드래그 시작점 저장
                                this.dragStartKey = key;
                                this.dragStartClass = cls;
                                
                                // DataTransfer 설정
                                e.dataTransfer.effectAllowed = 'all';
                                e.dataTransfer.setData('text/plain', key);
                                
                                // 드래그 이미지 숨기기
                                const emptyImg = document.createElement('img');
                                emptyImg.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                                e.dataTransfer.setDragImage(emptyImg, 0, 0);
                                
                                // 드래그 중 시각적 피드백
                                imgBtn.style.removeProperty('background');
                                imgBtn.style.setProperty('background', '#07d', 'important');
                            };

                            imgBtn.ondragover = (e) => {
                                e.preventDefault();
                                
                                // 드래그 중인 요소 위로 마우스가 왔을 때
                                if (this.dragStartKey) {
                                    const key = `${cls}/${img.name}`;
                                    
                                    // 같은 클래스 내에서만 범위 선택
                                    if (this.dragStartClass === cls) {
                                        // 호버 피드백
                                        imgBtn.style.background = '#05b';
                                    }
                                }
                            };

                            imgBtn.ondragleave = (e) => {
                                // 호버 피드백 제거
                                const key = `${cls}/${img.name}`;
                                const isSelected = labelSelection.selected.includes(key);
                                imgBtn.style.background = isSelected ? '#06c' : '#222';
                            };

                            imgBtn.ondrop = (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                
                                const endKey = `${cls}/${img.name}`;
                                
                                // 같은 클래스 내에서만 범위 선택
                                if (this.dragStartKey && this.dragStartClass === cls) {
                                    // 현재 클래스의 이미지 리스트
                                    const allKeys = imgList.filter(f => f.type === 'file').map(f => `${cls}/${f.name}`);
                                    
                                    const startIdx = allKeys.indexOf(this.dragStartKey);
                                    const endIdx = allKeys.indexOf(endKey);
                                    
                                    if (startIdx !== -1 && endIdx !== -1) {
                                        const [from, to] = [startIdx, endIdx].sort((a, b) => a - b);
                                        const range = allKeys.slice(from, to + 1);
                                        
                                        // 기존 선택에 추가
                                        labelSelection.selected = Array.from(new Set([...labelSelection.selected, ...range]));
                                        
                                        // 선택 상태 업데이트
                                        this.updateLabelExplorerContent();
                                        this.updateLabelExplorerSelection();
                                        
                                        // 다중 선택된 경우 Grid 모드로 전환
                                        if (range.length > 1) {
                                            this.showGridFromLabelExplorer(labelSelection.selected);
                                        } else if (range.length === 1) {
                                            // 단일 이미지는 클릭과 동일하게 처리
                                            const selectedKey = range[0];
                                            const fileName = selectedKey.split('/')[1];
                                            const imgList = this.classToImgListCache?.[cls] || [];
                                            const selectedImg = imgList.find(item => item.name === fileName);
                                            if (selectedImg?.root_relative) {
                                                this.saveCurrentViewStateForLabelExplorer();
                                                if (this.gridMode) {
                                                    this.hideGrid();
                                                }
                                                this.loadImage(selectedImg.root_relative);
                                            }
                                        }
                                    }
                                }
                                
                                // 드래그 상태 초기화
                                this.dragStartKey = null;
                                this.dragStartClass = null;
                                
                                // 시각적 피드백 복원
                                const isSelected = labelSelection.selected.includes(endKey);
                                imgBtn.style.removeProperty('background');
                                imgBtn.style.background = isSelected ? '#06c' : '#222';
                            };

                            imgBtn.ondragend = (e) => {
                                // 드래그 상태 초기화
                                this.dragStartKey = null;
                                this.dragStartClass = null;
                                
                                // 시각적 피드백 복원
                                const key = `${cls}/${img.name}`;
                                const isSelected = labelSelection.selected.includes(key);
                                imgBtn.style.removeProperty('background');
                                imgBtn.style.background = isSelected ? '#06c' : '#222';
                            };

                            imgBtn.onclick = (e) => {
                                const isCtrl = e.ctrlKey || e.metaKey;
                                const isShift = e.shiftKey;
                                const key = `${cls}/${img.name}`;

                                // 다른 Explorer 선택 해제

                                try {
                                    this.clearWaferMapExplorerSelection();
                                } catch (error) {
                                    console.warn('clearWaferMapExplorerSelection error:', error);
                                }

                                if (isShift && labelSelection.lastClicked !== null) {
                                    // Shift+클릭: 현재 클래스 내에서 범위 선택

                                    const allKeys = imgList.filter(f => f.type === 'file').map(f => `${cls}/${f.name}`);
                                    const lastIdx = allKeys.indexOf(labelSelection.lastClicked);
                                    const thisIdx = allKeys.indexOf(key);

                                    if (lastIdx !== -1 && thisIdx !== -1) {
                                        const [from, to] = [lastIdx, thisIdx].sort((a,b)=>a-b);
                                        const range = allKeys.slice(from, to+1);

                                        labelSelection.selected = Array.from(new Set([...labelSelection.selected, ...range]));
                                    }
                                } else if (isCtrl) {
                                    // Ctrl+클릭: 토글 선택

                                    if (labelSelection.selected.includes(key)) {
                                        labelSelection.selected = labelSelection.selected.filter(k => k !== key);
                                    } else {
                                        labelSelection.selected = [...labelSelection.selected, key];
                                    }

                                    labelSelection.lastClicked = key;
                                } else {
                                    // 단일 클릭: 이미 선택된 항목이면 해제, 다른 항목이면 새로 선택

                                    if (labelSelection.selected.includes(key) && labelSelection.selected.length === 1) {
                                        // 유일하게 선택된 항목을 다시 클릭: 해제

                                        labelSelection.selected = [];

                                        labelSelection.lastClicked = null;
                                    } else {
                                        // 새로운 항목 클릭 또는 다중 선택 상태: 기존 선택 해제 후 새로 선택

                                        labelSelection.selected = [key];

                                        labelSelection.lastClicked = key;
                                    }
                                }

                                // 선택된 이미지에 따라 단일/그리드 모드 결정

                                if (labelSelection.selected.length > 0) {
                                    if (labelSelection.selected.length === 1) {
                                        // 단일 선택: 단일 이미지 모드

                                        const selectedKey = labelSelection.selected[0];

                                        this.debugLog(`Label Explorer (동적): 단일 이미지 모드 - ${selectedKey}`);

                                        // 🔥 Label Explorer 내부이므로 savedViewState 저장하지 않음
                                        // (Wafer Map Explorer에서만 저장)
                                        this.debugLog('🔷 [SKIP] Label Explorer 내부 - savedViewState 저장 건너뛰기');

                                        // grid mode 해제하고 single image mode로 전환

                                        if (this.gridMode) {
                                            this.hideGrid();
                                        }

                                        // 🔥 Label Explorer 내에서는 저장하지 않음 (이미 저장된 상태 유지)

                                        this.debugLog('🔄 [SAVE] Label Explorer 내 이동 - 저장하지 않음, 기존 상태 유지');

                                        // 🔥 그리드 모드에서 온 경우 singleImageFromGrid 플래그 설정

                                        if (this.gridMode) {
                                            this.singleImageFromGrid = true;

                                            this.selectedImages = this.currentGridImages || [];
                                        }

                                        this.loadImage(`classification/${selectedKey}`);
                                    } else {
                                        // 다수 선택: 그리드 모드

                                        this.debugLog(`Label Explorer (동적): 그리드 모드 - ${labelSelection.selected.length}개 이미지`);

                                        this.showGridFromLabelExplorer(labelSelection.selected);
                                    }
                                } else {
                                    // 선택 없음: 이전 Grid 상태로 복귀 또는 이미지 숨기기

                                    if (this.gridMode) {
                                        this.debugLog('Label Explorer (동적): 선택 해제 → 이전 Grid 상태로 복귀');

                                        this.restorePreviousGridState();
                                    } else {
                                        // 단일 이미지 모드에서도 이미지 숨기기

                                        this.debugLog('Label Explorer (동적): 선택 해제 → 이미지 숨기기');

                                        this.restorePreviousGridState(); // 이전 Grid 상태가 없으면 hideImage() 포함
                                    }
                                }

                                // 강제로 업데이트 (약간의 지연 후)

                                setTimeout(() => {
                                    this.updateLabelExplorerSelection();
                                }, 10);

                                this.debugLog('Label Explorer 선택 후 상태 (동적):', {
                                    selected: labelSelection.selected,

                                    selectedClasses: labelSelection.selectedClasses,

                                    lastClicked: labelSelection.lastClicked
                                });
                            };

                            imgLi.appendChild(imgBtn);

                            const delBtn = document.createElement('button');

                            delBtn.textContent = '🗑️';

                            delBtn.className = 'label-img-del-btn';

                            delBtn.style.marginLeft = '4px';

                            delBtn.onclick = async (e) => {
                                e.stopPropagation();

                                let toDelete = [labelKey];

                                if (labelSelection.selected.includes(labelKey)) {
                                    toDelete = labelSelection.selected;
                                }

                                // 🔥 현재 폴더 파라미터 추가
                                const currentFolder = this.currentFolderPrefix;
                                const deleteApiUrl = currentFolder ? `/api/classify?folder=${encodeURIComponent(currentFolder)}` : '/api/classify';

                                for (const key of toDelete) {
                                    const [delCls, delImg] = key.split('/');

                                    await fetch(deleteApiUrl, {
                                        method: 'DELETE',

                                        headers: { 'Content-Type': 'application/json' },

                                        body: JSON.stringify({ class_name: delCls, image_name: delImg })
                                    });
                                }

                                labelSelection.selected = [];

                                this.updateLabelExplorerContent();

                                // 클래스 매니저 버튼 상태 업데이트
                                this.updateClassManagerButtons();

                                // 🔥 개별 Delete 후 복원 처리
                                const grid = document.getElementById('image-grid');
                                const isLabelExplorerGrid = grid && grid.hasAttribute('data-label-explorer-grid');

                                if (isLabelExplorerGrid) {
                                    // Label Explorer Grid인 경우: savedViewState 무시하고 초기 화면으로
                                    this.savedViewState = null;
                                    this.clearLabelExplorerSelection();
                                } else if (this.savedViewState) {
                                    // Wafer Map Explorer인 경우: savedViewState로 복원
                                    await this.restoreSavedViewState();
                                }
                            };

                            imgLi.appendChild(delBtn);

                            imgUl.appendChild(imgLi);
                        }
                    };

                    imgLi.appendChild(delBtn);

                    imgUl.appendChild(imgLi);
                }

                li.appendChild(imgUl);
            }

            ul.appendChild(li);
        }

        container.appendChild(ul);
    }

    /**
     * 클래스 매니저 버튼 상태 업데이트
     */

    updateClassManagerButtons() {
        try {
            const batchLabelBtn = document.getElementById('batch-label-btn');
            const batchDeleteBtn = document.getElementById('batch-delete-btn');

            if (!batchLabelBtn || !batchDeleteBtn) return;

            const hasSelection = (this.labelSelection && 

                (this.labelSelection.selected.length > 0 || this.labelSelection.selectedClasses.length > 0));
            
            // 버튼 활성화/비활성화

            batchLabelBtn.disabled = !hasSelection;

            batchDeleteBtn.disabled = !hasSelection;

            // 시각적 상태 업데이트

            if (hasSelection) {
                batchLabelBtn.style.opacity = '1';

                batchDeleteBtn.style.opacity = '1';

                batchLabelBtn.style.cursor = 'pointer';

                batchDeleteBtn.style.cursor = 'pointer';
            } else {
                batchLabelBtn.style.opacity = '0.5';

                batchDeleteBtn.style.opacity = '0.5';

                batchLabelBtn.style.cursor = 'not-allowed';

                batchDeleteBtn.style.cursor = 'not-allowed';
            }

            this.debugLog(`🚀 클래스 매니저 버튼 상태 업데이트: 선택됨=${hasSelection}, 개별=${this.labelSelection?.selected.length || 0}, 클래스=${this.labelSelection?.selectedClasses.length || 0}`);
            
        } catch (error) {
            console.warn('클래스 매니저 버튼 상태 업데이트 오류:', error);
        }
    }

    updateLabelExplorerContent() {
        // 🔥 폴더 열기/닫기 시 전체 내용 다시 렌더링
        console.log('🔍 [UPDATE_CONTENT_DEBUG] updateLabelExplorerContent 시작');

        const container = document.getElementById('label-explorer-list');

        if (!container) {
            console.warn('🔍 [UPDATE_CONTENT_DEBUG] container not found');
            return;
        }

        const scrollTop = container.scrollTop;

        // 클래스 목록 다시 가져오기
        console.log('🔍 [UPDATE_CONTENT_DEBUG] refreshClassList 호출');
        this.refreshClassList().then(async () => {
            // 🔥 refreshClassList()에서 캐시된 클래스 목록 사용 (중복 API 호출 제거)
            const classes = Array.isArray(this.cachedClassList) ? this.cachedClassList.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) : [];
            const labelSelection = this.labelSelection;
            
            console.log('🔍 [UPDATE_CONTENT_DEBUG] 클래스 수:', classes.length);
            console.log('🔍 [UPDATE_CONTENT_DEBUG] 클래스 목록:', classes);

            // classToImgList 재구성 (이미 로드된 것들만)
            let classToImgList = {};

            for (const cls of classes) {
                classToImgList[cls] = this.classToImgListCache?.[cls] || [];
            }
            
            console.log('🔍 [UPDATE_CONTENT_DEBUG] classToImgList keys:', Object.keys(classToImgList));

            // 전체 내용 다시 렌더링
            console.log('🔍 [UPDATE_CONTENT_DEBUG] renderLabelExplorerContent 호출');
            this.renderLabelExplorerContent(container, classes, classToImgList, labelSelection);
        
        // 스크롤 위치 복원
            container.scrollTop = scrollTop;

            console.log('🔍 [UPDATE_CONTENT_DEBUG] Label Explorer 내용 업데이트 완료');
        });
    }

    updateLabelExplorerSelection() {
        // 선택 상태만 업데이트 (전체 재렌더링 없음)

        const container = document.getElementById('label-explorer-list');

        if (!container) return;

        // 이미지 버튼 선택 상태 업데이트

        const imgButtons = container.querySelectorAll('button.label-img-name');

        imgButtons.forEach(btn => {
            // 버튼이 속한 클래스를 찾기

            const li = btn.closest('li');
            const classLi = li?.parentElement?.closest('li');

            if (!classLi) return;

            const folderSummary = classLi.querySelector('div');

            if (!folderSummary) return;

            const cls = folderSummary.textContent.replace(/[▾▸]/g, '').trim();
            const imgName = btn.textContent;
            const key = `${cls}/${imgName}`;

            const isSelected = this.labelSelection.selected.includes(key);

            btn.style.background = isSelected ? '#09f' : '#222';

            btn.style.border = isSelected ? '2px solid #09f' : '1px solid #444';

            btn.style.color = '#fff';
        });

        // 폴더 선택 상태 업데이트

        const folderSummaries = container.querySelectorAll('div');

        folderSummaries.forEach(summary => {
            // 폴더 summary만 처리 (이미지 버튼의 부모 div 제외)

            if (summary.style.fontWeight === 'bold') {
                const cls = summary.textContent.replace(/[▾▸]/g, '').trim();
                const isSelected = this.labelSelection.selectedClasses.includes(cls);

                summary.style.background = isSelected ? '#09f' : 'transparent';

                summary.style.color = '#fff';

                summary.style.borderRadius = isSelected ? '6px' : '0';

                summary.style.padding = isSelected ? '4px 8px' : '2px 0';
            }
        });

        // 버튼 활성화 상태 업데이트 (항상 활성화)

        const batchLabelBtn = document.getElementById('label-explorer-batch-label-btn');
        const batchDeleteBtn = document.getElementById('label-explorer-batch-delete-btn');

        if (batchLabelBtn) {
            batchLabelBtn.disabled = false;
        }

        if (batchDeleteBtn) {
            batchDeleteBtn.disabled = false;
        }
    }

    handleRightDown(e) {
        e.preventDefault();

        document.addEventListener('mousemove', this.boundHandleRightMove);

        document.addEventListener('mouseup', this.boundHandleRightUp);
    }

    handleRightMove(e) {
        const minWidth = 260;
        const maxWidth = 600;
        const totalWidth = window.innerWidth;
        const newWidth = totalWidth - e.clientX;

        if (newWidth > minWidth && newWidth < maxWidth) {
            this.dom.wrapperRight.style.width = newWidth + 'px';

            this.handleResize();
        }
    }

    handleRightUp() {
        document.removeEventListener('mousemove', this.boundHandleRightMove);

        document.removeEventListener('mouseup', this.boundHandleRightUp);
    }

    /**
     * minimap 클릭 시 해당 위치로 메인 뷰 이동
     */

    handleMinimapClick(e) {
        if (!this.currentImage) return;

        const rect = this.dom.minimapCanvas.getBoundingClientRect();
        const mapW = rect.width, mapH = rect.height;
        const imgW = this.originalWidth, imgH = this.originalHeight;
        const scale = Math.min(mapW / imgW, mapH / imgH);
        const padX = (mapW - imgW * scale) / 2;
        const padY = (mapH - imgH * scale) / 2;

        // 클릭 좌표 → 미니맵 좌표

        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        // 미니맵 전체 영역에서 이미지 좌표로 변환 (패딩 영역 포함)

        let imgX, imgY;

        if (mx < padX) {
            // 왼쪽 패딩 영역

            imgX = (mx / padX - 1) * imgW * 0.5; // 이미지 왼쪽 영역으로 확장
        } else if (mx > padX + imgW * scale) {
            // 오른쪽 패딩 영역

            imgX = imgW + ((mx - padX - imgW * scale) / padX) * imgW * 0.5; // 이미지 오른쪽 영역으로 확장
        } else {
            // 이미지 영역

            imgX = (mx - padX) / scale;
        }

        if (my < padY) {
            // 위쪽 패딩 영역

            imgY = (my / padY - 1) * imgH * 0.5; // 이미지 위쪽 영역으로 확장
        } else if (my > padY + imgH * scale) {
            // 아래쪽 패딩 영역

            imgY = imgH + ((my - padY - imgH * scale) / padY) * imgH * 0.5; // 이미지 아래쪽 영역으로 확장
        } else {
            // 이미지 영역

            imgY = (my - padY) / scale;
        }

        // 메인 뷰의 중심이 imgX, imgY가 되도록 transform.dx, dy 조정

        const { width: viewW, height: viewH } = this.dom.viewerContainer.getBoundingClientRect();

        this.transform.dx = -(imgX - viewW / (2 * this.transform.scale)) * this.transform.scale;

        this.transform.dy = -(imgY - viewH / (2 * this.transform.scale)) * this.transform.scale;

        this.scheduleDraw();
    }

    /**
     * 뷰포트 드래그 시작
     */

    handleViewportDragStart(e) {
        if (!this.currentImage) return;

        e.preventDefault();

        e.stopPropagation();

        this.isViewportDragging = true;

        // 드래그 시작 위치 저장

        const rect = this.dom.minimapCanvas.getBoundingClientRect();

        this.viewportDragStart = {
            x: e.clientX - rect.left,

            y: e.clientY - rect.top
        };

        // 현재 뷰포트 위치 저장

        const vpStyle = this.dom.minimapViewport.style;

        this.viewportDragStartPos = {
            x: parseFloat(vpStyle.left) || 0,

            y: parseFloat(vpStyle.top) || 0
        };

        // 이벤트 리스너 추가

        document.addEventListener('mousemove', this.boundHandleViewportDrag);

        document.addEventListener('mouseup', this.boundHandleViewportDragEnd);

        // 커서 변경

        this.dom.minimapViewport.style.cursor = 'grabbing';

        document.body.style.userSelect = 'none';
    }

    /**
     * 뷰포트 드래그 중
     */

    handleViewportDrag(e) {
        if (!this.isViewportDragging || !this.currentImage) return;

        // 현재 마우스 위치

        const rect = this.dom.minimapCanvas.getBoundingClientRect();
        const currentX = e.clientX - rect.left;
        const currentY = e.clientY - rect.top;

        // 드래그 거리 계산

        const deltaX = currentX - this.viewportDragStart.x;
        const deltaY = currentY - this.viewportDragStart.y;

        // 새로운 뷰포트 위치

        const newVpX = this.viewportDragStartPos.x + deltaX;
        const newVpY = this.viewportDragStartPos.y + deltaY;

        // 미니맵 전체 영역으로 경계 확장

        const mapW = rect.width;
        const mapH = rect.height;
        const imgW = this.originalWidth;
        const imgH = this.originalHeight;
        const scale = Math.min(mapW / imgW, mapH / imgH);
        const padX = (mapW - imgW * scale) / 2;
        const padY = (mapH - imgH * scale) / 2;

        const vpW = parseFloat(this.dom.minimapViewport.style.width) || 0;
        const vpH = parseFloat(this.dom.minimapViewport.style.height) || 0;

        // 미니맵 전체 영역 내로 제한 (패딩 영역 포함)

        const clampedX = Math.max(0, Math.min(newVpX, mapW - vpW));
        const clampedY = Math.max(0, Math.min(newVpY, mapH - vpH));

        // 뷰포트 위치 업데이트

        this.dom.minimapViewport.style.left = `${clampedX}px`;

        this.dom.minimapViewport.style.top = `${clampedY}px`;

        // 메인 뷰 동기화 (확장된 좌표계 사용)

        this.syncMainViewFromViewportExtended(clampedX, clampedY, padX, padY, scale, mapW, mapH);
    }

    /**
     * 뷰포트 드래그 종료
     */

    handleViewportDragEnd(e) {
        if (!this.isViewportDragging) return;

        this.isViewportDragging = false;

        // 이벤트 리스너 제거

        document.removeEventListener('mousemove', this.boundHandleViewportDrag);

        document.removeEventListener('mouseup', this.boundHandleViewportDragEnd);

        // 커서 복원

        this.dom.minimapViewport.style.cursor = 'grab';

        document.body.style.userSelect = '';
    }

    /**
     * 뷰포트 위치를 기반으로 메인 뷰 동기화
     */

    syncMainViewFromViewport(vpX, vpY, padX, padY, scale) {
        if (!this.currentImage) return;

        // 뷰포트 중심점을 이미지 좌표로 변환

        const vpW = parseFloat(this.dom.minimapViewport.style.width) || 0;
        const vpH = parseFloat(this.dom.minimapViewport.style.height) || 0;
        const vpCenterX = vpX + vpW / 2;
        const vpCenterY = vpY + vpH / 2;

        const imgX = (vpCenterX - padX) / scale;
        const imgY = (vpCenterY - padY) / scale;

        // 메인 뷰의 중심이 해당 이미지 좌표가 되도록 transform 조정

        const { width: viewW, height: viewH } = this.dom.viewerContainer.getBoundingClientRect();

        this.transform.dx = -(imgX - viewW / (2 * this.transform.scale)) * this.transform.scale;

        this.transform.dy = -(imgY - viewH / (2 * this.transform.scale)) * this.transform.scale;

        this.scheduleDraw();
    }

    /**
     * 확장된 뷰포트 위치를 기반으로 메인 뷰 동기화 (패딩 영역 포함)
     */

    syncMainViewFromViewportExtended(vpX, vpY, padX, padY, scale, mapW, mapH) {
        if (!this.currentImage) return;

        // 뷰포트 중심점

        const vpW = parseFloat(this.dom.minimapViewport.style.width) || 0;
        const vpH = parseFloat(this.dom.minimapViewport.style.height) || 0;
        const vpCenterX = vpX + vpW / 2;
        const vpCenterY = vpY + vpH / 2;

        const imgW = this.originalWidth;
        const imgH = this.originalHeight;

        // 미니맵 전체 영역에서 이미지 좌표로 변환 (패딩 영역 포함)

        let imgX, imgY;

        if (vpCenterX < padX) {
            // 왼쪽 패딩 영역

            imgX = (vpCenterX / padX - 1) * imgW * 0.5;
        } else if (vpCenterX > padX + imgW * scale) {
            // 오른쪽 패딩 영역

            imgX = imgW + ((vpCenterX - padX - imgW * scale) / padX) * imgW * 0.5;
        } else {
            // 이미지 영역

            imgX = (vpCenterX - padX) / scale;
        }

        if (vpCenterY < padY) {
            // 위쪽 패딩 영역

            imgY = (vpCenterY / padY - 1) * imgH * 0.5;
        } else if (vpCenterY > padY + imgH * scale) {
            // 아래쪽 패딩 영역

            imgY = imgH + ((vpCenterY - padY - imgH * scale) / padY) * imgH * 0.5;
        } else {
            // 이미지 영역

            imgY = (vpCenterY - padY) / scale;
        }

        // 메인 뷰의 중심이 해당 이미지 좌표가 되도록 transform 조정

        const { width: viewW, height: viewH } = this.dom.viewerContainer.getBoundingClientRect();

        this.transform.dx = -(imgX - viewW / (2 * this.transform.scale)) * this.transform.scale;

        this.transform.dy = -(imgY - viewH / (2 * this.transform.scale)) * this.transform.scale;

        this.scheduleDraw();
    }

    // 현재 로딩 중인 이미지 중단
    abortCurrentImageLoading() {
        this.debugLog('🔷 [DEBUG] 현재 이미지 로딩 중단');
        
        // 전역 AbortController 중단 (모든 진행 중인 API 요청 중단)
        if (this.globalAbortController) {
            this.globalAbortController.abort();
            // 새로운 AbortController 생성
            this.globalAbortController = new AbortController();
        }
        
        // 피라미드 로딩 중인 레벨들 초기화
        if (this.pyramidLoadingLevels) {
            this.pyramidLoadingLevels.clear();
        }
        
        // 현재 이미지 상태 초기화
        this.currentImage = null;
        this.currentImageBitmap = null;
        this.selectedImagePath = '';
        
        // 피라미드 레벨 캐시 초기화
        this.pyramidLevels = {};
        
        // 이미지 캔버스 숨기기
        if (this.dom.imageCanvas) {
            this.dom.imageCanvas.style.display = 'none';
        }
        if (this.dom.overlayCanvas) {
            this.dom.overlayCanvas.style.display = 'none';
        }
        if (this.dom.minimapContainer) {
            this.dom.minimapContainer.style.display = 'none';
        }
        
        this.debugLog('🔷 [DEBUG] 이미지 로딩 중단 완료');
    }

    // 2. Grid rendering

    showGrid(images, skipSaveState = false) {
        this.gridMode = true;
        this.selectedImages = images;
        this.currentGridImages = images;  // 🔥 currentGridImages 업데이트
        if (!this.gridSelectedIdxs) this.gridSelectedIdxs = [];
        const grid = document.getElementById('image-grid');
        const gridControls = document.getElementById('grid-controls');
        if (gridControls) gridControls.style.display = '';
        const gridColsRange = document.getElementById('grid-cols-range');
        if (gridColsRange) {
            gridColsRange.value = this.gridCols;
            document.documentElement.style.setProperty('--grid-cols', this.gridCols);
        }

        // 🔥 skipSaveState=false면 Wafer Map Explorer, true면 Label Explorer
        if (!skipSaveState) {
            // Wafer Map Explorer: 항상 저장, Label Explorer 속성 제거
            if (grid && grid.hasAttribute('data-label-explorer-grid')) {
                grid.removeAttribute('data-label-explorer-grid');
            }
            
            // 🔥 현재 스크롤 위치 가져오기
            const scrollWrapper = grid?.parentElement;  // .grid-scroll-wrapper
            const currentScrollTop = scrollWrapper ? scrollWrapper.scrollTop : 0;
            
            this.savedViewState = {
                type: 'grid',
                images: [...images],
                scrollTop: currentScrollTop
            };
        }
        // Label Explorer는 skipSaveState=true이므로 여기 들어오지 않음

        // 🔥 그리드를 명시적으로 표시 (display: none에서 복원)
        if (grid) {
            grid.style.display = 'grid';
        }

        // 🔥 그리드 모드에서는 파일명 패널 숨기기 (Label Explorer에서 복원 시 필요)
        if (this.dom.fileNameDisplay) {
            this.dom.fileNameDisplay.style.display = 'none';
        }

        // 파일명 패널은 유지 (제품 변경 시 상단 패널 사라짐 방지) - 주석 유지

        const viewControls = document.querySelector('.view-controls');
        if (viewControls) viewControls.style.display = 'none';

        // 그리드 모드 클래스 추가 및 요소들 숨기기
        this.dom.viewerContainer.classList.add('grid-mode');
        this.dom.viewerContainer.classList.remove('single-image-mode');
        this.dom.minimapContainer.style.display = 'none';
        this.dom.imageCanvas.style.display = 'none';
        this.dom.overlayCanvas.style.display = 'none';

        grid.innerHTML = '';
        // 🔥 DOM 재생성 시 캐시 초기화 (드래그 선택 정상 작동 위해 필수)
        this.gridThumbWraps = [];
        // grid 모드에서는 cursor를 default로
        this.dom.viewerContainer.style.cursor = 'default';
        this.showGridImmediately(images);
        setTimeout(() => {
            this.loadCurrentFolderThumbnails(images);
        }, 100);
        grid.classList.add('active');
        setTimeout(() => this.updateGridSquaresPixel(), 0);
        if (!this.gridResizeObserver) {
            this.gridResizeObserver = new ResizeObserver(() => this.updateGridSquaresPixel());
            this.gridResizeObserver.observe(grid);
        }

        // 🔥 그리드 재생성 후 레이아웃 캐시 무효화 (드래그 영역 재계산용)
        this.invalidateGridGeometry();
        
        // 🔥 Grid 스크롤 시 savedViewState 자동 업데이트 (Wafer Map Explorer에서만)
        const scrollWrapper = grid?.parentElement;
        if (scrollWrapper && !skipSaveState) {
            // 기존 리스너 제거 (중복 방지)
            if (this.gridScrollHandler) {
                scrollWrapper.removeEventListener('scroll', this.gridScrollHandler);
            }
            
            // 디바운스된 스크롤 핸들러
            let scrollTimeout;
            this.gridScrollHandler = () => {
                clearTimeout(scrollTimeout);
                scrollTimeout = setTimeout(() => {
                    const isLabelExplorerGrid = grid && grid.hasAttribute('data-label-explorer-grid');
                    if (!isLabelExplorerGrid && this.gridMode && this.savedViewState && this.savedViewState.type === 'grid') {
                        this.savedViewState.scrollTop = scrollWrapper.scrollTop;
                        console.log('💾 [AUTO-SAVE] Grid 스크롤 시 위치 업데이트:', scrollWrapper.scrollTop);
                    }
                }, 200);
            };
            
            scrollWrapper.addEventListener('scroll', this.gridScrollHandler, { passive: true });
        }
    }

    showGridImmediately(images) {
        const grid = document.getElementById('image-grid');
        images.forEach((imgPath, idx) => {
            const wrap = document.createElement('div');
            wrap.className = 'grid-thumb-wrap' + (this.gridSelectedIdxs.includes(idx) ? ' selected' : '');
            // 🔥 성능 최적화: data-index 추가 (indexOf 대신 O(1) 룩업)
            wrap.dataset.index = idx;
            // 클릭 이벤트는 onMouseUp에서 처리하므로 여기서는 제거
            // wrap.onclick = e => { e.stopPropagation(); this.toggleGridImageSelect(idx, e); };
            wrap.ondblclick = e => { e.stopPropagation(); this.enterSingleImageMode(idx); };
            
            // 우클릭 컨텍스트 메뉴 표시
            wrap.oncontextmenu = e => {
                e.preventDefault();
                e.stopPropagation();
                // contextmenu 이벤트 발생 플래그 설정 (다음 click 이벤트 무시)
                this.contextMenuJustShown = true;
                // 선택 상태를 변경하지 않고 컨텍스트 메뉴만 표시
                this.showContextMenu(e, idx);
            };
            // 썸네일 이미지 컨테이너
            const thumbBox = document.createElement('div');
            thumbBox.className = 'grid-thumb-imgbox';
            const img = document.createElement('img');
            img.className = 'grid-thumb-img';
            img.alt = imgPath.split('/').pop();
            img.loading = 'lazy';
            img.decoding = 'async';
            img.style.opacity = '0';
            
            // 고품질 이미지 렌더링 설정
            img.style.imageRendering = 'high-quality';
            img.style.imageRendering = 'crisp-edges';
            img.style.imageRendering = '-webkit-optimize-contrast';
            
            // 브라우저 기본 drag&drop 방지
            img.ondragstart = e => e.preventDefault();
            
            // 이미지 로드 핸들러
            img.onload = () => {
                img.style.opacity = '1';
                // 원본 이미지 유지 - 썸네일로 교체하지 않음
            };
            
            // 고화질 썸네일로 시작 (빠른 로딩)
            // 🔥 imgPath는 이미 ROOT_DIR 기준 절대 경로
            
            img.onerror = (e) => {
                // 🔥 이미지 로드가 중단된 경우 (다른 이미지로 전환 시) 로그 출력 안 함
                const isAborted = !img.parentElement || // DOM에서 제거됨
                                 !img.src || // src가 비어있음
                                 img.src === window.location.href || // URL이 루트로 변경됨
                                 img.src.length < 20; // URL이 불완전함
                
                if (!isAborted) {
                    console.error(`❌ [THUMBNAIL ERROR] 썸네일 로드 실패:`, {
                        경로: imgPath,
                        URL: img.src,
                        에러타입: e.type,
                        인덱스: idx
                    });
                }
                
                // 실패시 기본 스타일 적용 (DOM에 연결되어 있을 때만)
                if (img.parentElement) {
                    img.style.backgroundColor = '#333';
                    img.style.opacity = '0.5';
                    
                    // 실패 후에도 썸네일 시도 (서버에서 썸네일이 생성되었을 수 있음)
                    // 단, 중단된 경우는 시도하지 않음
                    if (!isAborted) {
                        setTimeout(() => {
                            if (img.parentElement) {
                                this.replaceWithThumbnail(img, imgPath);
                            }
                        }, 500);
                    }
                }
            };
            
            const thumbnailUrl = `/api/thumbnail?path=${encodeURIComponent(imgPath)}&size=512`;
            if (idx === 0) {
                            }
            img.src = thumbnailUrl;
            thumbBox.appendChild(img);
            wrap.appendChild(thumbBox);
            // 파일명
            const label = document.createElement('div');
            label.className = 'grid-thumb-label';
            label.textContent = imgPath.split('/').pop();
            wrap.appendChild(label);
            grid.appendChild(wrap);
        });
    }

    async replaceWithThumbnail(img, imgPath) {
        if (!img || !img.parentElement) return; // 이미지가 DOM에서 제거되었으면 중단

        // 이미 썸네일로 교체되었거나 진행 중이면 중단

        if (img.dataset.thumbnailUrl || img.dataset.thumbnailLoading === 'true') {
            return;
        }

        img.dataset.thumbnailLoading = 'true';

        try {
            // 🔥 imgPath는 이미 ROOT_DIR 기준 절대 경로
            const thumbnailUrl = await this.thumbnailManager.loadThumbnail(imgPath);

            if (thumbnailUrl && img.parentElement && !img.dataset.thumbnailUrl) {
                // 이전 blob URL 정리 (원본 이미지 URL은 제외)

                const oldSrc = img.src;

                if (oldSrc && oldSrc.startsWith('blob:') && oldSrc !== thumbnailUrl) {
                    URL.revokeObjectURL(oldSrc);
                }

                img.src = thumbnailUrl;

                img.dataset.thumbnailUrl = thumbnailUrl;

                // 썸네일 로드 성공시 추가 스타일

                img.style.transition = 'opacity 0.2s ease';

                img.style.opacity = '1';
            }
        } catch (error) {
            console.warn('썸네일 교체 실패:', imgPath, error);
        } finally {
            img.dataset.thumbnailLoading = 'false';
        }
    }

    async loadCurrentFolderThumbnails(images) {
        if (images.length === 0) return;

        // 🔥 이전 썸네일 로드 중단

        if (this.thumbnailManager) {
            this.thumbnailManager.abortAll();
        }

        // 배치 크기 제한

        const batchSize = THUMB_BATCH_SIZE || 24;
        const currentImages = images.slice(0, batchSize);

        try {
            await this.thumbnailManager.preloadBatch(currentImages);
        } catch (error) {
            // 조용히 실패 처리
        }
    }

    async loadAllThumbnailsAtOnce(images) {
        if (images.length === 0) return;

        const startTime = Date.now();

        // 배치 프리로드 (대량 처리 시 자동 분할)

        await this.thumbnailManager.preloadBatch(images);

        // 썸네일 적용 - 병렬 처리

        const grid = document.getElementById('image-grid');

        if (!grid) return;

        const thumbWraps = Array.from(grid.querySelectorAll('.grid-thumb-wrap'));
        const loadPromises = thumbWraps.map(async (wrap, idx) => {
            if (idx >= images.length) return;

            const img = wrap.querySelector('.grid-thumb-img');
            const imgPath = images[idx];

            if (!img || !imgPath) return;

            try {
                const thumbnailUrl = await this.thumbnailManager.loadThumbnail(imgPath);

                if (thumbnailUrl && img.src !== thumbnailUrl) {
                    img.src = thumbnailUrl;

                    img.style.opacity = '1';
                }
            } catch (error) {
                // 조용히 실패 처리
            }
        });

        await Promise.allSettled(loadPromises);

        const elapsed = Date.now() - startTime;

        if (elapsed > 500) { // 500ms 이상일 때만 로그

            this.debugLog(`썸네일 로딩: ${images.length}개, ${elapsed}ms`);
        }
    }

    async checkWorkerStats() {
        // 워커 통계 체크 비활성화 (성능 최적화)

        return;
    }

    hideGrid(hideControls = true) {
        this.debugLog('🔷 [DEBUG] hideGrid() 호출됨');
        
        // 🔥 Label Explorer Grid인 경우 savedViewState 보호
        const grid = document.getElementById('image-grid');
        const isLabelExplorerGrid = grid && grid.hasAttribute('data-label-explorer-grid');
        const savedViewStateBackup = isLabelExplorerGrid ? this.savedViewState : null;

        // 🔥 1단계: 배치 로딩 즉시 중단
        if (this.gridLoadingBatch) {
            console.log('🛑 [GRID] hideGrid - 배치 로딩 중단');
            this.gridLoadingBatch = null;
        }

        // 🔥 2단계: DOM의 모든 로딩 중인 이미지 src 중단 (네트워크 요청 취소)
        if (grid) {
            const oldImages = grid.querySelectorAll('.grid-thumb-img');
            let canceledCount = 0;
            oldImages.forEach(img => {
                if (!img.complete) {  // 로딩 중인 이미지만
                    img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
                    canceledCount++;
                }
            });
            if (canceledCount > 0) {
                console.log(`🛑 [GRID] hideGrid - ${canceledCount}개 네트워크 요청 중단`);
            }
        }

        this.gridMode = false;

        // 그리드 상태 초기화

        this.gridSelectedIdxs = [];
        this.gridSelectedSet = new Set();
        this._prevGridSelectedIdxs = new Set();
        this.gridLastClickedIdx = undefined;
        this.gridThumbWraps = [];
        this.invalidateGridGeometry();

        // 그리드 정리 및 메모리 해제

        if (grid) {
            grid.classList.remove('active');

            // 이미지 URL 정리 (썸네일 캐시는 ThumbnailManager가 관리)

            const images = grid.querySelectorAll('.grid-thumb-img');

            images.forEach(img => {
                // 원본 이미지 blob URL만 해제 (썸네일은 캐시에서 관리됨)

                if (img.src && img.src.startsWith('blob:') && !img.dataset.thumbnailUrl) {
                    URL.revokeObjectURL(img.src);
                }

                // 모든 데이터 속성 정리

                delete img.dataset.thumbnailUrl;

                delete img.dataset.thumbnailLoading;

                // 스타일 초기화

                img.style.transition = '';
            });

            grid.innerHTML = '';

            this.gridThumbWraps = [];
        this.invalidateGridGeometry();
            this._prevGridSelectedIdxs = new Set();
        }

        // 화면 모드 전환

        this.dom.viewerContainer.classList.remove('grid-mode');

        // single-image-mode 클래스 제거 - 상단 패널이 사라지는 문제 해결

        // this.dom.viewerContainer.classList.add('single-image-mode');

        this.dom.imageCanvas.style.display = 'block';

        this.dom.overlayCanvas.style.display = 'block';

        this.dom.minimapContainer.style.display = 'block';

        // 컨트롤 전환 (hideControls가 true일 때만)

        if (hideControls) {
            const gridControls = document.getElementById('grid-controls');

            if (gridControls) gridControls.style.display = 'none';

            const viewControls = document.querySelector('.view-controls');

            if (viewControls) viewControls.style.display = 'flex';
        }

        // 파일명 표시 숨기기 (그리드 모드에서는 파일명을 표시하지 않음)

        this.hideFileName();

        // ResizeObserver 정리

        if (this.gridResizeObserver) {
            this.gridResizeObserver.disconnect();

            this.gridResizeObserver = null;
        }

        this.scheduleDraw();

        this.dom.viewerContainer.style.cursor = 'grab';
        
        // 🔥 Label Explorer Grid였다면 savedViewState 복원
        if (isLabelExplorerGrid && savedViewStateBackup) {
            this.savedViewState = savedViewStateBackup;
        }
    }

    // 🔥 그리드 모드 활성화 (GridManager에서 호출)
    showGridMode() {
        this.gridMode = true;
        const grid = document.getElementById('image-grid');
        const gridControls = document.getElementById('grid-controls');
        if (gridControls) gridControls.style.display = '';
        
        // 그리드 컨트롤 표시
        this.dom.viewerContainer.classList.add('grid-mode');
        this.dom.viewerContainer.classList.remove('single-image-mode');
        this.dom.minimapContainer.style.display = 'none';
        this.dom.imageCanvas.style.display = 'none';
        this.dom.overlayCanvas.style.display = 'none';
        
        if (grid) {
            grid.style.display = 'grid';
        }
    }

    // 🔥 단일 이미지 상세 보기
    viewSingleImage(imagePath) {
        console.log('🖼️ [VIEW] 단일 이미지 상세 보기:', imagePath);
        
        // 🔥 Grid 상태 저장
        this.saveWaferMapExplorerState();
        
        // 그리드 모드 해제
        this.hideGrid(false);
        
        // 이미지 로드
        this.loadImage(imagePath);
        
        // 상세 보기 모드 활성화
        this.detailMode = true;
        this.detailImagePath = imagePath;
    }
    
    // 🔥 상세 보기 모드 종료 (ESC/더블클릭)
    exitDetailMode() {
        console.log('🚪 [EXIT] 상세 보기 모드 종료');
        
        this.detailMode = false;
        this.detailImagePath = null;
        
        // 🔥 저장된 상태 복원
        this.restoreWaferMapExplorerState();
    }

    // 🔥 Wafer Map Explorer 상태 저장 (Grid/Single Image)
    saveWaferMapExplorerState() {
        const grid = document.getElementById('image-grid');
        const scrollWrapper = document.querySelector('.viewer-scroll-wrapper');
        const gridScrollWrapper = document.querySelector('.grid-scroll-wrapper');
        
        // Grid 스크롤 요소 찾기
        const gridScrollElement = gridScrollWrapper || grid;
        
        console.log('💾 [SAVE STATE] Wafer Map Explorer 상태 저장 시작');
        console.log('💾 [SAVE STATE] Grid 요소:', {
            grid: grid ? '있음' : '없음',
            gridScrollWrapper: gridScrollWrapper ? '있음' : '없음',
            gridScrollElement: gridScrollElement ? '있음' : '없음'
        });
        
        this.waferMapExplorerState = {
            gridMode: this.gridMode,
            currentImage: this.currentImage ? this.currentImage.src : null,
            scrollTop: gridScrollElement ? gridScrollElement.scrollTop : 0,
            scrollLeft: gridScrollElement ? gridScrollElement.scrollLeft : 0,
            viewerScrollTop: scrollWrapper ? scrollWrapper.scrollTop : 0,
            viewerScrollLeft: scrollWrapper ? scrollWrapper.scrollLeft : 0,
            scale: this.scale,
            panX: this.panX,
            panY: this.panY,
            selectedImages: this.selectedImages ? [...this.selectedImages] : [],
            gridSelectedIdxs: this.gridSelectedIdxs ? [...this.gridSelectedIdxs] : [],
            savedViewState: this.savedViewState ? {...this.savedViewState} : null
        };
        
        console.log('💾 [SAVE STATE] 저장된 값:', {
            gridMode: this.waferMapExplorerState.gridMode,
            currentImage: this.waferMapExplorerState.currentImage,
            gridScrollTop: this.waferMapExplorerState.scrollTop,
            gridScrollLeft: this.waferMapExplorerState.scrollLeft,
            viewerScrollTop: this.waferMapExplorerState.viewerScrollTop,
            viewerScrollLeft: this.waferMapExplorerState.viewerScrollLeft,
            scale: this.waferMapExplorerState.scale,
            panX: this.waferMapExplorerState.panX,
            panY: this.waferMapExplorerState.panY,
            selectedImagesCount: this.waferMapExplorerState.selectedImages.length,
            gridSelectedIdxsCount: this.waferMapExplorerState.gridSelectedIdxs.length
        });
        console.log('✅ [SAVE STATE] Wafer Map Explorer 상태 저장 완료');
    }

    // 🔥 Wafer Map Explorer 상태 복원
    restoreWaferMapExplorerState() {
        if (!this.waferMapExplorerState) {
            console.log('⚠️ [RESTORE] 저장된 Wafer Map Explorer 상태가 없습니다.');
            return;
        }
        
        console.log('🔄 [RESTORE] Wafer Map Explorer 상태 복원 시작:', {
            gridMode: this.waferMapExplorerState.gridMode,
            currentImage: this.waferMapExplorerState.currentImage,
            gridScrollTop: this.waferMapExplorerState.scrollTop,
            gridScrollLeft: this.waferMapExplorerState.scrollLeft,
            viewerScrollTop: this.waferMapExplorerState.viewerScrollTop,
            viewerScrollLeft: this.waferMapExplorerState.viewerScrollLeft,
            scale: this.waferMapExplorerState.scale,
            panX: this.waferMapExplorerState.panX,
            panY: this.waferMapExplorerState.panY
        });
        
        const state = this.waferMapExplorerState;
        
        // Grid 모드 복원
        if (state.gridMode && state.selectedImages && state.selectedImages.length > 0) {
            console.log('🔄 [RESTORE] Grid 모드로 복원 시작:', state.selectedImages.length, '개 이미지');
            this.showGrid(state.selectedImages, true); // skipSaveState=true
            
            // Grid 스크롤 복원
            setTimeout(() => {
                const grid = document.getElementById('image-grid');
                const gridScrollWrapper = document.querySelector('.grid-scroll-wrapper');
                const gridScrollElement = gridScrollWrapper || grid;
                
                console.log('🔄 [RESTORE] Grid 스크롤 요소:', {
                    grid: grid ? '있음' : '없음',
                    gridScrollWrapper: gridScrollWrapper ? '있음' : '없음',
                    gridScrollElement: gridScrollElement ? '있음' : '없음'
                });
                
                if (gridScrollElement) {
                    console.log('🔄 [RESTORE] Grid 스크롤 복원 전:', {
                        scrollTop: gridScrollElement.scrollTop,
                        scrollLeft: gridScrollElement.scrollLeft
                    });
                    
                    gridScrollElement.scrollTop = state.scrollTop;
                    gridScrollElement.scrollLeft = state.scrollLeft;
                    
                    console.log('🔄 [RESTORE] Grid 스크롤 복원 후:', {
                        scrollTop: gridScrollElement.scrollTop,
                        scrollLeft: gridScrollElement.scrollLeft,
                        savedScrollTop: state.scrollTop,
                        savedScrollLeft: state.scrollLeft
                    });
                }
                
                // Grid 선택 상태 복원
                if (state.gridSelectedIdxs && state.gridSelectedIdxs.length > 0) {
                    console.log('🔄 [RESTORE] Grid 선택 상태 복원 전:', {
                        gridSelectedIdxs: this.gridSelectedIdxs,
                        gridSelectedSet: Array.from(this.gridSelectedSet)
                    });
                    
                    this.gridSelectedIdxs = [...state.gridSelectedIdxs];
                    this.gridSelectedSet = new Set(state.gridSelectedIdxs);
                    
                    console.log('🔄 [RESTORE] Grid 선택 상태 복원 후:', {
                        gridSelectedIdxs: this.gridSelectedIdxs,
                        gridSelectedSet: Array.from(this.gridSelectedSet),
                        count: state.gridSelectedIdxs.length
                    });
                }
            }, 100);
        } 
        // Single Image 모드 복원
        else if (state.currentImage) {
            console.log('🔄 [RESTORE] Single Image 모드로 복원:', state.currentImage);
            this.loadImage(state.currentImage);
            
            // Viewer 스크롤 복원
            setTimeout(() => {
                const scrollWrapper = document.querySelector('.viewer-scroll-wrapper');
                if (scrollWrapper) {
                    scrollWrapper.scrollTop = state.viewerScrollTop;
                    scrollWrapper.scrollLeft = state.viewerScrollLeft;
                    console.log('🔄 [RESTORE] Viewer 스크롤 복원:', state.viewerScrollTop, state.viewerScrollLeft);
                }
                
                // Scale 및 Pan 복원
                if (state.scale !== undefined) {
                    this.scale = state.scale;
                    this.panX = state.panX;
                    this.panY = state.panY;
                    this.scheduleDraw();
                    console.log('🔄 [RESTORE] Scale/Pan 복원:', state.scale, state.panX, state.panY);
                }
            }, 100);
        }
        
        // savedViewState 복원
        if (state.savedViewState) {
            this.savedViewState = state.savedViewState;
            console.log('🔄 [RESTORE] savedViewState 복원:', state.savedViewState);
        }
        
        console.log('✅ [RESTORE] Wafer Map Explorer 상태 복원 완료');
    }

    // 🔥 Label Explorer 이전 Grid 상태로 복귀

    async restorePreviousGridState() {
        await this.restoreSavedViewState();
    }

    // 🔥 Label 캐시만 초기화 (제품 선택 시 사용)
    async clearParCache() {
        try {
            console.log('🔍 [CACHE_DEBUG] clearParCache 시작');
            this.debugLog('🧹 PAR 캐시 초기화 시작...');
    
            // 🔥 프론트엔드 캐시 먼저 초기화 (서버 오류와 무관하게)
            console.log('🔍 [CACHE_DEBUG] classToImgListCache 삭제 전:', Object.keys(this.classToImgListCache || {}).length, '개');
            this.classToImgListCache = {};
            console.log('🔍 [CACHE_DEBUG] classToImgListCache 삭제 완료');
    
            if (this.thumbnailManager) {
                console.log('🔍 [CACHE_DEBUG] 썸네일 캐시 삭제 전:', this.thumbnailManager.cache.size, '개');
                this.thumbnailManager.cache.clear();
                this.thumbnailManager.abortAll();
                console.log('🔍 [CACHE_DEBUG] 썸네일 캐시 삭제 완료');
            }
    
            // 서버 캐시 초기화 (실패해도 계속 진행)
            try {
                const response = await fetch('/api/cache', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' }
                });
        
                if (!response.ok) {
                    const errorText = await response.text();
                    console.warn('⚠️ 서버 캐시 초기화 실패 (프론트엔드 캐시는 삭제됨):', response.status, errorText);
                } else {
                    const result = await response.json();
                    this.debugLog('✅ 서버 PAR 캐시 초기화 완료:', result);
                }
            } catch (serverError) {
                console.warn('⚠️ 서버 캐시 초기화 중 오류 (프론트엔드 캐시는 삭제됨):', serverError);
            }
    
            // 🔥 UI 새로고침 (refreshLabelExplorer가 내부에서 getClassList() 호출)
            await this.refreshLabelExplorer();
    
            // ❌ 파일 인덱스 재구축은 생략 (파일 리스트 유지)
    
            this.debugLog('✅ PAR 캐시 초기화 완료 (파일 리스트 유지)');
            return true;
        } catch (error) {
            console.error('❌ PAR 캐시 초기화 오류:', error);
            return false;
        }
    }

    // 🔥 모든 캐시 초기화

    // 🔥 하드 새로고침 + 캐시 삭제 (Wafer Map Explorer 버튼)
    async hardRefreshWithCacheClear() {
        try {
            console.log('🔄 [HARD REFRESH] 하드 새로고침 + 캐시 삭제 시작...');

            // 1. 전체 캐시 삭제 (비동기로 실행, 완료를 기다리지 않음)
            this.clearAllCache();

            // 2. 상태 변수 초기화 (Wafer Map Explorer 버튼)
            console.log('🔍 [STATE_DEBUG] Wafer Map Explorer 버튼 - 상태 초기화');
            this.savedViewState = null;
            this.waferMapExplorerState = null;
            this.labelExplorerState = null;

            // 3. 즉시 하드 새로고침 (Ctrl+Shift+R과 동일)
            window.location.reload(true);
        } catch (error) {
            console.error('❌ [HARD REFRESH] 하드 새로고침 실패:', error);
            // 오류가 발생해도 새로고침은 실행
            window.location.reload(true);
        }
    }

    // 🔥 Explorer 전환 (Wafer Map ↔ Label Explorer)
    toggleExplorer() {
        const resetExplorerBtn = document.getElementById('reset-explorer-btn');
        const fileExplorer = document.getElementById('file-explorer');
        const labelExplorerFrame = document.querySelector('.label-explorer-frame');
        
        if (!resetExplorerBtn || !fileExplorer || !labelExplorerFrame) {
            console.error('❌ [TOGGLE] Explorer 요소를 찾을 수 없습니다.');
            return;
        }
        
        // 현재 상태 확인
        const isLabelExplorerVisible = labelExplorerFrame.style.display !== 'none';
        
        if (isLabelExplorerVisible) {
            // Label Explorer → Wafer Map Explorer
            console.log('🔄 [TOGGLE] Label Explorer → Wafer Map Explorer');
            
            // Label Explorer 숨기기
            labelExplorerFrame.style.display = 'none';
            
            // Wafer Map Explorer 표시
            fileExplorer.style.display = 'block';
            
            // 버튼 텍스트 변경
            resetExplorerBtn.textContent = 'Wafer Map Explorer';
            
            // 🔥 Wafer Map Explorer 상태 복원
            this.restoreWaferMapExplorerState();
        } else {
            // Wafer Map Explorer → Label Explorer
            console.log('🔄 [TOGGLE] Wafer Map Explorer → Label Explorer');
            
            // Wafer Map Explorer 숨기기
            fileExplorer.style.display = 'none';
            
            // Label Explorer 표시
            labelExplorerFrame.style.display = 'block';
            
            // 버튼 텍스트 변경
            resetExplorerBtn.textContent = 'Label Explorer';
            
            // 🔥 Label Explorer 상태 복원
            this.restoreLabelExplorerState();
        }
    }
    
    // 🔥 Label Explorer 상태 저장
    saveLabelExplorerState() {
        this.labelExplorerState = {
            selected: this.labelSelection ? [...this.labelSelection.selected] : [],
            lastClicked: this.labelSelection ? this.labelSelection.lastClicked : null,
            openFolders: this.labelSelection ? {...this.labelSelection.openFolders} : {},
            selectedClasses: this.labelSelection ? [...this.labelSelection.selectedClasses] : []
        };
        
        console.log('💾 [SAVE STATE] Label Explorer 상태 저장:', {
            selectedCount: this.labelExplorerState.selected.length,
            lastClicked: this.labelExplorerState.lastClicked,
            openFoldersCount: Object.keys(this.labelExplorerState.openFolders).length,
            selectedClassesCount: this.labelExplorerState.selectedClasses.length
        });
    }
    
    // 🔥 Label Explorer 상태 복원
    restoreLabelExplorerState() {
        if (!this.labelExplorerState) {
            console.log('⚠️ [RESTORE] 저장된 Label Explorer 상태가 없습니다.');
            return;
        }
        
        console.log('🔄 [RESTORE] Label Explorer 상태 복원 시작:', {
            selectedCount: this.labelExplorerState.selected.length,
            lastClicked: this.labelExplorerState.lastClicked,
            openFoldersCount: Object.keys(this.labelExplorerState.openFolders).length,
            selectedClassesCount: this.labelExplorerState.selectedClasses.length
        });
        
        const state = this.labelExplorerState;
        
        // Label Explorer 상태 복원
        if (this.labelSelection) {
            this.labelSelection.selected = [...state.selected];
            this.labelSelection.lastClicked = state.lastClicked;
            this.labelSelection.openFolders = {...state.openFolders};
            this.labelSelection.selectedClasses = [...state.selectedClasses];
            
            console.log('✅ [RESTORE] Label Explorer 상태 복원 완료');
        }
    }
    
    async resetExplorer() {
        try {
            console.log('🔄 [RESET EXPLORER] 초기화면으로 복원...');
            
            // 페이지 리로드로 간단하게 초기화
            window.location.reload();
            
            return true;
        } catch (error) {
            console.error('❌ [RESET EXPLORER] 초기화 실패:', error);
            return false;
        }
    }

    async clearAllCache() {
        try {
            this.debugLog('🧹 전체 캐시 초기화 시작...');

            const response = await fetch('/api/cache/all', {
                method: 'POST',

                headers: { 'Content-Type': 'application/json' }
            });

            if (!response.ok) {
                const errorText = await response.text();

                console.error('❌ 전체 캐시 초기화 실패:', response.status, errorText);

                console.error('캐시 초기화 실패:', response.status, response.statusText, errorText);

                return false;
            }

            const result = await response.json();

            this.debugLog('✅ 전체 캐시 초기화 완료:', result);

            // 🔥 삭제 전 항목 개수 미리 계산
            const dirCacheCount = this.classToImgListCache ? Object.keys(this.classToImgListCache).length : 0;
            const thumbnailCacheCount = this.thumbnailManager ? this.thumbnailManager.cache.size : 0;
            const pyramidCacheCount = this.pyramidLevels ? Object.keys(this.pyramidLevels).length : 0;
            const totalDeletedItems = dirCacheCount + thumbnailCacheCount + pyramidCacheCount;
            
            // 🔥 프론트엔드 캐시도 초기화

            this.classToImgListCache = {};

            if (this.thumbnailManager) {
                this.thumbnailManager.cache.clear();

                this.thumbnailManager.abortAll();
            }

            // 🔥 UI 강제 새로고침

            await this.refreshLabelExplorer();

            // refreshClassList()는 refreshAll()이나 refreshLabelExplorer()에서 처리됨

            // 🔥 파일 인덱스 재구축 요청

            try {
                await fetch('/api/files/all');

                this.debugLog('📁 파일 인덱스 재구축 요청 완료');
            } catch (error) {
                console.warn('파일 인덱스 재구축 요청 실패:', error);
            }

            console.log(`전체 캐시 초기화 완료! 삭제된 항목: ${totalDeletedItems}개`);

            return true;
            
        } catch (error) {
            console.error('❌ 캐시 초기화 오류:', error);

            // 오류 알림창 제거 (조용한 실행)

            return false;
        }
    }

    // 🔥 저장된 뷰 상태 복원 (기존 함수)

    async restoreSavedViewState() {
        // 🔥 무조건 이미지 정보 패널 숨기기 (Delete Label에서 호출될 때)
        if (this.dom.fileNameDisplay) {
            this.dom.fileNameDisplay.style.display = 'none';
        }

        if (!this.savedViewState) {

            // 초기 화면: 모두 숨기고 초기화

            this.hideGrid();

            this.hideImage();

            this.selectedImages = [];

            this.currentImage = null;

            this.gridMode = false;

            // File Explorer도 초기화 (선택 해제)

            const fileExplorer = document.getElementById('file-list');

            if (fileExplorer) {
                fileExplorer.querySelectorAll('.selected').forEach(el => {
                    el.classList.remove('selected');
                });
            }

            // 🔥 초기 상태 표시 (검색 안내 메시지)

            this.showInitialState();

            this.debugLog('🔷 [RESTORE] 초기 화면 복원 완료');

            return;
        }

        if (this.savedViewState.type === 'grid') {
            // Grid 모드로 복원

            this.selectedImages = [...this.savedViewState.images];

            this.showGrid(this.savedViewState.images, true);  // ✅ skipSaveState=true로 호출

            // 스크롤 위치 복원

            setTimeout(() => {
                const grid = document.getElementById('image-grid');
                const scrollWrapper = grid?.parentElement;  // .grid-scroll-wrapper

                if (scrollWrapper && this.savedViewState && this.savedViewState.scrollTop !== undefined) {
                    scrollWrapper.scrollTop = this.savedViewState.scrollTop;

                    this.debugLog('🔷 [RESTORE] 스크롤 복원:', {
                        scrollTop: this.savedViewState.scrollTop,
                        currentScrollTop: scrollWrapper.scrollTop,
                        scrollHeight: scrollWrapper.scrollHeight,
                        clientHeight: scrollWrapper.clientHeight
                    });
                }
            }, 100);
        } else if (this.savedViewState.type === 'single') {
            // 단일 이미지 모드로 복원

            await this.loadImage(this.savedViewState.imagePath);
            this.zoom = this.savedViewState.zoom;
            this.offsetX = this.savedViewState.offsetX;
            this.offsetY = this.savedViewState.offsetY;
            // 🔥 loadImage가 자동으로 렌더링하므로 render() 호출 불필요
        }

        // 🔥 savedViewState는 clearLabelExplorerSelection에서 관리하므로 여기서는 null로 설정하지 않음
    }

    // 🔥 저장된 뷰 상태 복원 (상태 객체를 직접 받는 함수)

    restoreSavedViewStateWithState(savedState) {
        this.debugLog('🔷 [RESTORE] 저장된 뷰 상태 복원 시작 (직접 전달)', savedState);

        this.debugLog('🔷 [RESTORE] 복원할 상태 타입:', savedState?.type);

        this.debugLog('🔷 [RESTORE] 복원할 상태 내용:', savedState);

        if (!savedState) {
            this.debugLog('🔷 [RESTORE] 저장된 상태 없음 → 초기 화면으로 복귀');

            // 초기 화면: 모두 숨기고 초기화

            this.hideGrid();

            this.hideImage();

            this.selectedImages = [];

            this.currentImage = null;

            this.gridMode = false;

            // File Explorer도 초기화 (선택 해제)

            const fileExplorer = document.getElementById('file-list');

            if (fileExplorer) {
                fileExplorer.querySelectorAll('.selected').forEach(el => {
                    el.classList.remove('selected');
                });
            }

            // 🔥 초기 상태 표시 (검색 안내 메시지)

            this.showInitialState();

            this.debugLog('🔷 [RESTORE] 초기 화면 복원 완료');

            return;
        }

        if (savedState.type === 'grid') {
            // Grid 모드로 복원

            this.debugLog('🔷 [RESTORE] Grid 모드 복원:', savedState.images.length, '개');

            this.selectedImages = [...savedState.images];

            this.showGrid(savedState.images);

            // 스크롤 위치 복원

            setTimeout(() => {
                const grid = document.getElementById('image-grid');
                const scrollWrapper = grid?.parentElement;
                if (scrollWrapper && savedState && savedState.scrollTop) {
                    scrollWrapper.scrollTop = savedState.scrollTop;

                    this.debugLog('🔷 [RESTORE] 스크롤 복원:', savedState.scrollTop);
                }
            }, 100);
        } else if (savedState.type === 'single') {
            // 단일 이미지 모드로 복원

            this.debugLog('🔷 [RESTORE] 단일 이미지 복원:', savedState.imagePath);

            this.loadImage(savedState.imagePath).then(() => {
                this.zoom = savedState.zoom;

                this.offsetX = savedState.offsetX;

                this.offsetY = savedState.offsetY;

                this.render();
            });
        } else if (savedState.type === 'grid' && savedState.images.length === 0) {
            // 🔥 빈 그리드 상태로 복원 (초기 상태)

            this.debugLog('🔷 [RESTORE] 빈 그리드 상태로 복원 (초기 상태)');

            this.hideGrid();

            this.hideImage();

            this.selectedImages = [];

            this.currentImage = null;

            this.gridMode = false;

            this.showInitialState();
        }

        this.debugLog('🔷 [RESTORE] 복원 완료');
    }

    ensureGridSelectionStructures() {
        if (!Array.isArray(this.gridSelectedIdxs)) {
            this.gridSelectedIdxs = [];
        }
        if (!this.gridSelectedSet) {
            this.gridSelectedSet = new Set(this.gridSelectedIdxs);
        }
        if (!this._prevGridSelectedIdxs) {
            this._prevGridSelectedIdxs = new Set(this.gridSelectedSet);
        }
        if (typeof this.gridSelectionCursor !== 'number') {
            this.gridSelectionCursor = 0;
        }
        if (typeof this.gridSelectionNeedsFullRefresh !== 'boolean') {
            this.gridSelectionNeedsFullRefresh = false;
        }
        if (!this.gridSelectionPending) {
            this.gridSelectionPending = new Set();
        }
    }

    ensureGridThumbWraps() {
        const grid = document.getElementById('image-grid');
        if (!grid) {
            this.gridThumbWraps = [];
        this.invalidateGridGeometry();
            return;
        }
        if (!Array.isArray(this.gridThumbWraps) || this.gridThumbWraps.length === 0) {
            this.gridThumbWraps = Array.from(grid.querySelectorAll('.grid-thumb-wrap'));
        }
    }

    computeGridLayoutFromDom(grid, cells) {
        if (!grid) {
            return null;
        }
        const computed = window.getComputedStyle(grid);
        const paddingLeft = parseFloat(computed.paddingLeft) || 0;
        const paddingTop = parseFloat(computed.paddingTop) || 0;
        const columnGap = parseFloat(computed.columnGap || computed.gap || '0') || 0;
        const rowGap = parseFloat(computed.rowGap || computed.gap || '0') || 0;
        let sampleCell = null;
        if (Array.isArray(cells)) {
            for (let i = 0; i < cells.length; i += 1) {
                if (cells[i]) {
                    sampleCell = cells[i];
                    break;
                }
            }
        }
        if (!sampleCell) {
            sampleCell = grid.querySelector('.grid-thumb-wrap');
        }
        let cellWidth = sampleCell ? sampleCell.offsetWidth : 0;
        let cellHeight = sampleCell ? sampleCell.offsetHeight : 0;
        if ((!cellWidth || !cellHeight) && sampleCell) {
            const rect = sampleCell.getBoundingClientRect();
            cellWidth = rect.width || cellWidth;
            cellHeight = rect.height || cellHeight || cellWidth;
        }
        if (!cellWidth || !cellHeight) {
            return null;
        }
        const cols = Math.max(1, this.gridCols || 1);
        this.gridLayoutCache = {
            cellWidth,
            cellHeight,
            gapX: columnGap,
            gapY: rowGap,
            paddingLeft,
            paddingTop,
            cols
        };
        this.gridThumbRectCache = null;
        return this.gridLayoutCache;
    }

    invalidateGridGeometry() {
        this.gridThumbRectCache = null;
        this.gridLayoutCache = null;
    }

    insertIndexSorted(arr, value) {
        let low = 0;
        let high = arr.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (arr[mid] < value) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        arr.splice(low, 0, value);
    }

    removeIndexSorted(arr, value) {
        let low = 0;
        let high = arr.length - 1;
        while (low <= high) {
            const mid = (low + high) >> 1;
            const midVal = arr[mid];
            if (midVal === value) {
                arr.splice(mid, 1);
                return;
            }
            if (midVal < value) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
    }

    updateGridSelection() {
        // 그리드의 선택 상태만 업데이트 (전체 재렌더링 없음)
        const grid = document.getElementById('image-grid');
        const wraps = grid.querySelectorAll('.grid-thumb-wrap');
        wraps.forEach((wrap, idx) => {
            const isSelected = this.gridSelectedIdxs.includes(idx);
            wrap.className = 'grid-thumb-wrap' + (isSelected ? ' selected' : '');
        });

        // 🔥 Wafer Map Explorer에서만 savedViewState 업데이트 (Label Explorer 제외)
        const isLabelExplorerGrid = grid && grid.hasAttribute('data-label-explorer-grid');
        if (!isLabelExplorerGrid && this.gridMode && this.selectedImages && this.selectedImages.length > 0) {
            const scrollWrapper = grid?.parentElement;
            this.savedViewState = {
                type: 'grid',
                images: [...this.selectedImages],
                scrollTop: scrollWrapper ? scrollWrapper.scrollTop : 0
            };
            console.log('💾 [AUTO-SAVE] Grid 선택 변경 시 savedViewState 업데이트:', this.selectedImages.length, '개 이미지, scrollTop:', scrollWrapper?.scrollTop);
        }
    }

    scheduleGridSelectionFlush() {
        if (this.gridSelectionFrameId !== null || this.gridSelectionIdleId !== null) {
            return;
        }
        const idle = typeof window.requestIdleCallback === 'function' ? window.requestIdleCallback : null;
        if (idle) {
            this.gridSelectionIdleId = idle((deadline) => {
                this.gridSelectionIdleId = null;
                this.flushGridSelectionUpdates(deadline);
            }, { timeout: 50 });
            return;
        }
        const raf = window.requestAnimationFrame || ((cb) => window.setTimeout(cb, 16));
        this.gridSelectionFrameId = raf(() => this.flushGridSelectionUpdates());
    }

    flushGridSelectionUpdates(deadline) {
        if (this.gridSelectionFrameId !== null) {
            this.gridSelectionFrameId = null;
        }
        this.ensureGridThumbWraps();
        const wraps = this.gridThumbWraps || [];
        if (!Array.isArray(wraps) || wraps.length === 0) {
            this.gridSelectionPending.clear();
            this.gridSelectionNeedsFullRefresh = false;
            this.gridSelectionCursor = 0;
            this.restoreGridVisibility();
            return;
        }

        const selectedSet = this.gridSelectedSet || new Set(this.gridSelectedIdxs || []);
        const batchLimit = this.gridSelectionBatchSize;
        const hasBudget = (remaining) => {
            if (deadline && typeof deadline.timeRemaining === 'function') {
                return deadline.timeRemaining() > 2 && remaining > 0;
            }
            return remaining > 0;
        };
        let processed = 0;

        if (this.gridSelectionNeedsFullRefresh) {
            while (this.gridSelectionCursor < wraps.length && hasBudget(batchLimit - processed)) {
                this.applyGridSelectionState(this.gridSelectionCursor, selectedSet);
                this.gridSelectionCursor += 1;
                processed += 1;
            }
            if (this.gridSelectionCursor >= wraps.length) {
                this.gridSelectionNeedsFullRefresh = false;
                this.gridSelectionCursor = 0;
            }
        } else {
            const iterator = this.gridSelectionPending.values();
            while (hasBudget(batchLimit - processed)) {
                const next = iterator.next();
                if (next.done) {
                    break;
                }
                const idx = next.value;
                this.gridSelectionPending.delete(idx);
                this.applyGridSelectionState(idx, selectedSet);
                processed += 1;
            }
        }

        if (!this.gridSelectionNeedsFullRefresh && this.gridSelectionPending.size === 0) {
            this.restoreGridVisibility();
            return;
        }

        this.scheduleGridSelectionFlush();
    }

    applyGridSelectionState(idx, selectedSet = null) {
        if (typeof idx !== 'number' || idx < 0) {
            return false;
        }
        const wraps = this.gridThumbWraps || [];
        const wrap = wraps[idx];
        if (!wrap) {
            return false;
        }
        const activeSet = selectedSet instanceof Set
            ? selectedSet
            : (this.gridSelectedSet || new Set(this.gridSelectedIdxs || []));
        const isSelected = activeSet instanceof Set ? activeSet.has(idx) : false;
        
        // 🚀 성능 최적화: 상태가 실제로 변경되는 경우에만 DOM 조작
        const hasClass = wrap.classList.contains('selected');
        if (isSelected && !hasClass) {
            wrap.classList.add('selected');
        } else if (!isSelected && hasClass) {
            wrap.classList.remove('selected');
        }
        return true;
    }

    hideGridForSelection(totalItems) {
        if (this.gridSelectionGridHidden) {
            return;
        }
        if (typeof totalItems === 'number' && totalItems < this.gridSelectionHideThreshold) {
            return;
        }
        const grid = document.getElementById('image-grid');
        if (!grid) {
            return;
        }
        this.gridSelectionOriginalDisplay = typeof grid.style.display === 'string' ? grid.style.display : null;
        grid.style.display = 'none';
        this.gridSelectionGridHidden = true;
    }

    restoreGridVisibility() {
        if (!this.gridSelectionGridHidden) {
            return;
        }
        const grid = document.getElementById('image-grid');
        if (grid) {
            if (this.gridSelectionOriginalDisplay !== null) {
                grid.style.display = this.gridSelectionOriginalDisplay;
            } else {
                grid.style.removeProperty('display');
            }
        }
        this.gridSelectionGridHidden = false;
        this.gridSelectionOriginalDisplay = null;
    }

    clearGridSelection() {
        console.time('🔍 clearGridSelection');

        // 🔥 최적화: 선택된 요소만 찾아서 클래스 제거 (전체 순회 방지)
        const grid = document.getElementById('image-grid');
        if (grid) {
            console.time('🔍 querySelectorAll');
            const selectedWraps = grid.querySelectorAll('.grid-thumb-wrap.selected');
            console.timeEnd('🔍 querySelectorAll');

            console.time('🔍 removeClass');
            selectedWraps.forEach(wrap => {
                wrap.classList.remove('selected');
            });
            console.timeEnd('🔍 removeClass');
        }

        this.gridSelectedIdxs = [];
        this.gridLastClickedIdx = undefined;

        // 🔥 savedViewState 업데이트 제거 (배열 복사가 느림)
        // 전체 해제 시에는 상태 업데이트 불필요

        console.timeEnd('🔍 clearGridSelection');
    }

    selectAllGridImages() {
        if (this.selectedImages) {
            // 🔥 최적화: 모든 요소에 selected 클래스 추가
            const grid = document.getElementById('image-grid');
            if (grid) {
                const wraps = grid.querySelectorAll('.grid-thumb-wrap');
                wraps.forEach(wrap => {
                    wrap.classList.add('selected');
                });
            }

            this.gridSelectedIdxs = this.selectedImages.map((_, i) => i);

            // savedViewState 업데이트 (updateGridSelection 호출 불필요)
            if (this.gridMode && this.selectedImages.length > 0) {
                const scrollWrapper = grid?.parentElement;
                this.savedViewState = {
                    type: 'grid',
                    images: [...this.selectedImages],
                    scrollTop: scrollWrapper ? scrollWrapper.scrollTop : 0
                };
            }
        }
    }

    toggleGridImageSelect(idx, e) {
        // contextmenu 이벤트가 방금 발생했다면 click 이벤트 무시
        if (this.contextMenuJustShown) {
            this.contextMenuJustShown = false;
            return;
        }

        if (!this.gridSelectedIdxs) this.gridSelectedIdxs = [];
        if (!this.gridSelectedSet) this.gridSelectedSet = new Set();

        const isCtrl = e && (e.ctrlKey || e.metaKey);
        const isShift = e && e.shiftKey;

        if (isShift && this.gridLastClickedIdx !== undefined) {
            // Shift+클릭: 범위 선택
            const [from, to] = [this.gridLastClickedIdx, idx].sort((a, b) => a - b);
            const range = [];
            for (let i = from; i <= to; ++i) {
                range.push(i);
                this.gridSelectedSet.add(i);
            }
            this.gridSelectedIdxs = Array.from(new Set([...this.gridSelectedIdxs, ...range]));
        } else if (isCtrl) {
            // Ctrl/Cmd+클릭: 토글 선택 (추가/제거)
            if (this.gridSelectedIdxs.includes(idx)) {
                this.gridSelectedIdxs = this.gridSelectedIdxs.filter(i => i !== idx);
                this.gridSelectedSet.delete(idx);
            } else {
                this.gridSelectedIdxs.push(idx);
                this.gridSelectedSet.add(idx);
            }
        } else {
            // 단일 클릭: 기존 선택 해제하고 현재 항목만 선택
            this.gridSelectedIdxs = [idx];
            this.gridSelectedSet = new Set([idx]);
        }

        this.gridLastClickedIdx = idx;
        this.updateGridSelection();
    }

    enterSingleImageMode(idx) {
        // 🔥 그리드에서 단일 이미지 모드로 전환 시 savedViewState 업데이트
        const grid = document.getElementById('image-grid');
        const isLabelExplorerGrid = grid && grid.hasAttribute('data-label-explorer-grid');
        const scrollWrapper = grid?.parentElement;  // .grid-scroll-wrapper
        
        // 🔥 Label Explorer Grid가 아닐 때만 savedViewState 업데이트
        if (!isLabelExplorerGrid && this.selectedImages && this.selectedImages.length > 0) {
            const savedScrollTop = scrollWrapper ? scrollWrapper.scrollTop : 0;
            
            this.savedViewState = {
                type: 'grid',
                images: [...this.selectedImages],
                scrollTop: savedScrollTop
            };
            console.log('💾 [SAVE] Grid → 단일 이미지 (enterSingleImageMode) 시 상태 저장:', {
                images: this.selectedImages.length,
                scrollTop: savedScrollTop
            });
        } else if (isLabelExplorerGrid) {
            console.log('🔍 [LABEL_EXPLORER] Label Explorer Grid에서 단일 이미지 전환 - 상태 저장 안 함');
        }

        this.hideGrid();

        this.loadImage(this.selectedImages[idx]);

        this.selectedImagePath = this.selectedImages[idx];

        this.singleImageFromGrid = true;

        document.addEventListener('keydown', this.boundGridEscapeHandler = (e) => {
            // 🔥 상세 보기 모드에서 ESC 키로 빠져나가기
            if (this.detailMode && e.key === 'Escape') {
                console.log('🚪 [ESC] 상세 보기 모드 종료');
                this.exitDetailMode();
                return;
            }
            
            if (e.key === 'Escape') this.exitSingleImageMode();
        });

        this.dom.imageCanvas.onclick = null;

        this.dom.imageCanvas.ondblclick = () => this.exitSingleImageMode();
    }

    exitSingleImageMode() {
        if (!this.singleImageFromGrid) return;

        // 🔥 skipSaveState=true로 호출 (이미 저장된 scrollTop 유지)
        this.showGrid(this.selectedImages, true);

        // 🔥 저장된 스크롤 위치 복원
        if (this.savedViewState && this.savedViewState.scrollTop !== undefined) {
            setTimeout(() => {
                const grid = document.getElementById('image-grid');
                const scrollWrapper = grid?.parentElement;
                if (scrollWrapper) {
                    scrollWrapper.scrollTop = this.savedViewState.scrollTop;
                }
            }, 100);
        }

        this.singleImageFromGrid = false;

        document.removeEventListener('keydown', this.boundGridEscapeHandler);

        this.dom.imageCanvas.onclick = null;

        this.dom.imageCanvas.ondblclick = null;
    }

    updateGridSquaresPixel() {
        const grid = document.getElementById('image-grid');

        if (!grid) return;

        const colCount = this.gridCols;
        const gap = 8; // 간격 줄임
        const gridWidth = grid.clientWidth;
        const gridHeight = grid.clientHeight;
        let cellWidth, cellHeight;
        const cells = grid.querySelectorAll('.grid-thumb-wrap');

        if (colCount === 1 && cells.length === 1) {
            // column이 1개이고 이미지도 1개면 썸네일이 grid 전체를 채움 (정사각형)

            cellWidth = gridWidth;

            cellHeight = gridWidth; // 정사각형
        } else {
            cellWidth = Math.floor((gridWidth - gap * (colCount - 1)) / colCount);

            cellHeight = cellWidth; // 정사각형
        }

        // 극한 최적화: 한번에 스타일 설정

        const gridStyle = `repeat(${colCount}, ${cellWidth}px)`;

        if (grid.style.gridTemplateColumns !== gridStyle) {
            grid.style.gridTemplateColumns = gridStyle;
        }

        // 극한 최적화: 배치로 스타일 설정

        const cellStyle = `${cellWidth}px`;

        cells.forEach(cell => {
            if (cell.style.width !== cellStyle) {
                cell.style.width = cellStyle;

                cell.style.height = cellStyle;
            }
        });

        const computed = window.getComputedStyle(grid);
        const paddingLeft = parseFloat(computed.paddingLeft) || 0;
        const paddingTop = parseFloat(computed.paddingTop) || 0;
        const columnGap = parseFloat(computed.columnGap || computed.gap || gap) || gap;
        const rowGap = parseFloat(computed.rowGap || computed.gap || gap) || gap;

        this.gridLayoutCache = {
            cellWidth,
            cellHeight,
            gapX: columnGap,
            gapY: rowGap,
            paddingLeft,
            paddingTop,
            cols: colCount
        };
        this.gridThumbRectCache = null;
    }

    scheduleShowGrid() {
        if (this._showGridScheduled) return;

        this._showGridScheduled = true;

        setTimeout(() => {
            this._showGridScheduled = false;

            this.showGrid(this.selectedImages);
        }, 0);
    }

    // Label Explorer에서 그리드 모드 전환

    showGridFromLabelExplorer(imageKeys) {
        if (!imageKeys || imageKeys.length === 0) return;

        // 🔥 savedViewState 백업 (Label Explorer Grid가 덮어쓰지 않도록)
        const savedViewStateBackup = this.savedViewState;

        // 🔥 이전 상태 저장 (한 번만 저장)

        this.debugLog('🔷 [DEBUG] showGridFromLabelExplorer - savedViewState:', this.savedViewState);

        this.debugLog('🔷 [DEBUG] showGridFromLabelExplorer - selectedImages:', this.selectedImages);

        this.debugLog('🔷 [DEBUG] showGridFromLabelExplorer - currentGridImages:', this.currentGridImages);

        if (!this.savedViewState) {
            // 🔥 savedViewState가 null이면 이전 상태가 없다는 뜻이므로 저장하지 않음

            this.debugLog('🔄 [SAVE] showGridFromLabelExplorer - 이전 상태 없음, 저장하지 않음');
        }

        // 🔥 key (className/fileName)에서 현재 제품 폴더 기준 경로 생성
        // 서버의 classify_images_batch가 classification 경로를 자동으로 원본 경로로 변환 (캐시 사용)
        const actualPaths = imageKeys.map(key => {
            const [className, fileName] = key.split('/');
            // 현재 제품 폴더 내의 classification 경로 사용
            const currentPath = this.currentFolderPrefix ? 
                `${this.currentFolderPrefix}classification/${className}/${fileName}` : 
                `classification/${className}/${fileName}`;
            return currentPath;
        });

        // 🔥 Label Explorer에서 온 Grid에 우클릭 이벤트 추가

        const gridElement = document.getElementById('image-grid');

        if (gridElement && !gridElement.hasAttribute('data-label-explorer-grid')) {
            gridElement.setAttribute('data-label-explorer-grid', 'true');

            gridElement.oncontextmenu = (e) => {
                // Grid item이 아닌 Grid 자체를 클릭한 경우에만
                if (e.target === gridElement || e.target.classList.contains('grid-thumb-wrap')) {
                    e.preventDefault();
                    e.stopPropagation();
                    this.clearLabelExplorerSelection();
                    this.debugLog('🔷 Label Explorer Grid: 우클릭으로 선택 해제');
                }
            };
        }

        this.debugLog('Label Explorer → Grid Mode:', {
            originalPaths: imageKeys,

            actualPaths: actualPaths,

            count: actualPaths.length
        });

        // Wafer Map Explorer 선택 해제

        this.clearWaferMapExplorerSelection();

        // 그리드 모드로 전환

        this.selectedImages = actualPaths;

        // 🔥 그리드 컨테이너 표시 확인

        const grid = document.getElementById('image-grid');

        if (grid) {
            grid.style.display = 'grid';

            this.debugLog('🔷 [DEBUG] 그리드 컨테이너 표시 설정 완료');
        }

        this.showGrid(actualPaths, true);  // 🔥 라벨 Explorer에서 호출 시 상태 저장 건너뛰기
        
        // 🔥 savedViewState 복원 (showGrid가 덮어쓸 수 있으므로)
        this.savedViewState = savedViewStateBackup;
    }

    // 클래스의 모든 이미지로 그리드 모드 전환

    async showGridFromClass(className) {
        try {
            // 🔥 showGridFromClass는 Label Explorer 클래스 전체 보기용이므로 savedViewState 저장 안 함
            this.debugLog('🔷 [SKIP] showGridFromClass - Label Explorer 클래스 전체 보기, savedViewState 저장 건너뛰기');

            // 🔥 현재 제품 폴더를 고려한 라벨 경로 생성
            const labelPath = this.currentFolderPrefix ? 
                `${this.currentFolderPrefix}classification/${encodeURIComponent(className)}` : 
                `classification/${encodeURIComponent(className)}`;
            
            // 🔥 경로 존재 여부 확인
            const response = await fetch(`/api/files?path=${labelPath}`);
            if (!response.ok) {
                this.debugLog(`클래스 '${className}' 폴더가 존재하지 않습니다.`);
                return;
            }
            
            const data = await response.json();
            const imageFiles = (data.items || [])

                .filter(item => item.type === 'file' && this.isImageFile(item.name))

                .map(item => {
                    // 현재 제품 폴더 내의 classification 경로 사용
                    return this.currentFolderPrefix ? 
                        `${this.currentFolderPrefix}classification/${className}/${item.name}` : 
                        `classification/${className}/${item.name}`;
                });

            if (imageFiles.length === 0) {
                this.debugLog(`클래스 '${className}'에 이미지가 없습니다.`);

                return;
            }

            this.debugLog(`클래스 '${className}' → Grid Mode:`, {
                className: className,

                imageCount: imageFiles.length,

                images: imageFiles
            });

            // Wafer Map Explorer 선택 해제

            this.clearWaferMapExplorerSelection();

            // 그리드 모드로 전환

            this.selectedImages = imageFiles;

            this.showGrid(imageFiles, true);  // 🔥 라벨 Explorer에서 호출 시 상태 저장 건너뛰기

            // 🔥 Label Explorer에서 온 Grid에 우클릭 이벤트 추가

            const gridElement = document.getElementById('image-grid');

            if (gridElement) {
                gridElement.setAttribute('data-label-explorer-grid', 'true');

                // grid.js의 GridManager가 contextmenu 이벤트를 처리하도록 함
                // gridElement.oncontextmenu 핸들러를 제거
                // gridElement.oncontextmenu = (e) => {
                //     if (e.target === gridElement || e.target.classList.contains('grid-thumb-wrap')) {
                //         e.preventDefault();
                //         e.stopPropagation();
                //         this.clearLabelExplorerSelection();
                //         this.debugLog('🔷 Label Explorer Grid: 우클릭으로 선택 해제');
                //     }
                // };
            }
        } catch (error) {
            console.error(`클래스 '${className}' 이미지 로드 실패:`, error);
        }
    }

    // 다중 클래스의 모든 이미지로 그리드 모드 전환

    async showGridFromMultipleClasses(classNames) {
        try {
            // 🔥 이전 상태 저장 (한 번만 저장)

            if (!this.savedViewState) {
                // 🔥 savedViewState가 null이면 이전 상태가 없다는 뜻이므로 저장하지 않음

                this.debugLog('🔄 [SAVE] showGridFromMultipleClasses - 이전 상태 없음, 저장하지 않음');
            }

            this.debugLog('다중 클래스 그리드 모드:', classNames);

            let allImageFiles = [];

            // 각 클래스의 이미지들을 병렬로 가져오기

            const fetchPromises = classNames.map(async (className) => {
                try {
                    // 🔥 현재 제품 폴더를 고려한 라벨 경로 생성
                    const labelPath = this.currentFolderPrefix ? 
                        `${this.currentFolderPrefix}classification/${encodeURIComponent(className)}` : 
                        `classification/${encodeURIComponent(className)}`;
                    
                    // 🔥 경로 존재 여부 확인
                    const response = await fetch(`/api/files?path=${labelPath}`);
                    if (!response.ok) {
                        console.error(`클래스 '${className}' 폴더가 존재하지 않습니다.`);
                        return { className, images: [] };
                    }
                    
                    const data = await response.json();
                    const imageFiles = (data.items || [])

                        .filter(item => item.type === 'file' && this.isImageFile(item.name))

                        .map(item => {
                            // 현재 제품 폴더 내의 classification 경로 사용
                            return this.currentFolderPrefix ? 
                                `${this.currentFolderPrefix}classification/${className}/${item.name}` : 
                                `classification/${className}/${item.name}`;
                        });

                    return { className, images: imageFiles };
                } catch (error) {
                    console.error(`클래스 '${className}' 로드 실패:`, error);

                    return { className, images: [] };
                }
            });

            const results = await Promise.all(fetchPromises);

            // 모든 이미지를 하나의 배열로 합치기

            results.forEach(result => {
                allImageFiles.push(...result.images);

                this.debugLog(`클래스 '${result.className}': ${result.images.length}개 이미지`);
            });

            if (allImageFiles.length === 0) {
                this.debugLog('선택된 클래스들에 이미지가 없습니다.');

                return;
            }

            this.debugLog(`다중 클래스 → Grid Mode:`, {
                classes: classNames,

                totalImages: allImageFiles.length,

                imagesPerClass: results.map(r => ({ class: r.className, count: r.images.length }))
            });

            // Wafer Map Explorer 선택 해제

            this.clearWaferMapExplorerSelection();

            // 그리드 모드로 전환

            this.selectedImages = allImageFiles;

            this.debugLog(`🚀 다중 클래스 그리드 표시 시작: ${allImageFiles.length}개 이미지`);

            this.showGrid(allImageFiles, true);  // 🔥 라벨 Explorer에서 호출 시 상태 저장 건너뛰기

            this.debugLog(`✅ 다중 클래스 그리드 표시 완료`);

            // 🔥 Label Explorer에서 온 Grid에 우클릭 이벤트 추가

            const gridElement = document.getElementById('image-grid');

            if (gridElement) {
                gridElement.setAttribute('data-label-explorer-grid', 'true');

                // grid.js의 GridManager가 contextmenu 이벤트를 처리하도록 함
                // gridElement.oncontextmenu 핸들러를 제거
                // gridElement.oncontextmenu = (e) => {
                //     if (e.target === gridElement || e.target.classList.contains('grid-thumb-wrap')) {
                //         e.preventDefault();
                //         e.stopPropagation();
                //         this.clearLabelExplorerSelection();
                //         this.debugLog('🔷 Label Explorer Grid: 우클릭으로 선택 해제');
                //     }
                // };
            }
        } catch (error) {
            console.error('다중 클래스 이미지 로드 실패:', error);
        }
    }

    // 주기적인 메모리 정리

    performCleanup() {
        try {
            // 썸네일 캐시 정리

            const cleaned = this.thumbnailManager.cleanupOldCache();

            // 가비지 컬렉션 힌트 (브라우저가 지원하는 경우)

            if (window.gc && typeof window.gc === 'function') {
                window.gc();
            }

            if (cleaned > 0) {
                this.debugLog(`메모리 정리: ${cleaned}개 썸네일 캐시 제거`);
            }
        } catch (error) {
            console.warn('메모리 정리 중 오류:', error);
        }
    }

    // 전체 정리 (페이지 종료시)

    cleanup() {
        try {
            // 인터벌 정리

            if (this.cleanupInterval) {
                clearInterval(this.cleanupInterval);

                this.cleanupInterval = null;
            }

            // 썸네일 캐시 정리

            this.thumbnailManager.clearCache();

            // ResizeObserver 정리

            if (this.gridResizeObserver) {
                this.gridResizeObserver.disconnect();

                this.gridResizeObserver = null;
            }

            if (this.gridSelectionFrameId !== null) {
                const caf = window.cancelAnimationFrame || window.clearTimeout;
                if (typeof caf === 'function') {
                    caf(this.gridSelectionFrameId);
                }
                this.gridSelectionFrameId = null;
            }
            if (this.gridSelectionIdleId !== null) {
                const cancelIdle = window.cancelIdleCallback || window.clearTimeout;
                if (typeof cancelIdle === 'function') {
                    cancelIdle(this.gridSelectionIdleId);
                }
                this.gridSelectionIdleId = null;
            }
            if (this.gridSelectionPending) {
                this.gridSelectionPending.clear();
            }
            this.gridSelectionNeedsFullRefresh = false;
            this.gridSelectionCursor = 0;
            this.restoreGridVisibility();
            
            // 전역 변수 정리

            if (window.lastMouseEvent) {
                window.lastMouseEvent = null;
            }
            
        } catch (error) {
            console.warn('정리 중 오류:', error);
        }
    }
}

window.addEventListener('wheel', function(e) {
    if (e.ctrlKey) {
        e.preventDefault();

        if (window.viewer && window.viewer.gridMode) {
            let newCols = window.viewer.gridCols - Math.sign(e.deltaY);

            newCols = Math.max(1, Math.min(10, newCols));

            window.viewer.gridCols = newCols;

            document.getElementById('grid-cols-range').value = newCols;

            document.documentElement.style.setProperty('--grid-cols', newCols);

            if (window.viewer.selectedImages && window.viewer.selectedImages.length > 1) {
                window.viewer.showGrid(window.viewer.selectedImages);
            }
        }
    }
}, { passive: false });

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { 
        window.viewer = new WaferMapViewer(); 
        // AUTO_LOGIN 체크 및 자동 SAML 로그인
        checkAutoLogin();
    });
} else {
    window.viewer = new WaferMapViewer();
    // AUTO_LOGIN 체크 및 자동 SAML 로그인
    checkAutoLogin();
}

// AUTO_LOGIN 체크 함수
async function checkAutoLogin() {
    try {
        if (initialSamlSuccess || initialDevSuccess) {
            console.log('AUTO_LOGIN 활성화 - 이번 요청은 SAML 완료 상태로 감지됨, 재로그인 건너뜀');
            return;
        }

        // 서버 설정 확인
        const configResponse = await fetch('/api/config');
        const config = await configResponse.json();

        if (!config.AUTO_LOGIN) {
            return;
        }
        
        // AUTO_LOGIN이 활성화되어 있으면 자동으로 /saml/login 호출
        console.log('AUTO_LOGIN 활성화 - 자동 SAML 로그인 시작');
        const loginUrl = config.DEFAULT_ORG_URL 
            ? `/saml/login?org_url=${config.DEFAULT_ORG_URL}` 
            : '/saml/login';
        // 🔥 페이지를 완전히 새로고침하여 이전 JavaScript 상태를 제거
        window.location.replace(loginUrl);
    } catch (error) {
        console.error('AUTO_LOGIN 체크 실패:', error);
    }
}

async function fetchJson(url, options = {}) {
    const res = await fetch(url, options);

    if (!res.ok) {
        let err = await res.json().catch(() => ({}));

        throw new Error(err.error || res.statusText);
    }

    return res.json();
} 

// 성능 모니터링 및 디버그 도구 (개발자용)

if (window.location.hash === '#debug') {
    let stats = document.createElement('div');

    stats.id = 'performance-stats';

    stats.style.cssText = `

        position: fixed;

        top: 10px;

        right: 10px;

        background: rgba(0,0,0,0.8);

        color: white;

        padding: 10px;

        font-family: monospace;

        font-size: 12px;

        z-index: 10000;

        border-radius: 5px;

    `;

    document.body.appendChild(stats);

    setInterval(() => {
        if (window.viewer && window.viewer.thumbnailManager) {
            const cacheStats = window.viewer.thumbnailManager.getCacheStats();
            const memInfo = window.performance && window.performance.memory ? 

                `RAM: ${Math.round(window.performance.memory.usedJSHeapSize / 1024 / 1024)}MB` : 'RAM: N/A';
            
            // DOM의 썸네일 상태 확인

            const gridImages = document.querySelectorAll('.grid-thumb-img');
            const thumbnailImages = Array.from(gridImages).filter(img => img.dataset.thumbnailUrl);
            const loadingImages = Array.from(gridImages).filter(img => img.dataset.thumbnailLoading === 'true');

            stats.innerHTML = `

                <div><strong>🚀 성능 최적화 상태</strong></div>

                <div>썸네일 캐시: ${cacheStats.loaded}/${cacheStats.total}</div>

                <div>로딩 중: ${cacheStats.loading}</div>

                <div>대기 중: ${cacheStats.queued}</div>

                <div>DOM 썸네일: ${thumbnailImages.length}/${gridImages.length}</div>

                <div>교체 중: ${loadingImages.length}</div>

                <div>${memInfo}</div>

                <div>그리드 모드: ${window.viewer.gridMode ? 'ON' : 'OFF'}</div>

            `;
        }
    }, 1000);
}

// WaferMapViewer 최적화 완료

