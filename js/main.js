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
import { ColorSchemeEditor } from './color-editor.js';
import { ChipAnnotator } from './chip-annotator.js';
import { ThumbnailNavigator } from './thumbnail-navigator.js';

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
const CLASSIFICATION_DIR_NAMES = ['classification', 'classification_chips', 'chips'];

// ✅ 미니맵 뷰포트 크기 제한 상수
const MINIMAP_VIEWPORT_MIN_SIZE = 0.05;  // 최소 5%
const MINIMAP_VIEWPORT_MAX_SIZE = 8.0;   // 최대 800% (더 큰 확대 가능)
const MINIMAP_ZOOM_PROTECTION_MS = 200;  // 미니맵 줌 중 패널 보호 시간(ms)
const PANEL_MIN_DY = -20;                 // 상단 패널이 숨지 않도록 하는 최소 dy 값

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

const FIT_RELATIVE_MARGIN = 0.85; // 초기 로드 시 15% 여유 (조금 더 작게 표시)

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
    constructor(viewer = null) {
        this.viewer = viewer; // WaferMapViewer 참조
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
        // 썸네일 캐시 키에 scheme 정보 포함
        const personalizedParams = this.viewer ? this.viewer.getPersonalizedParams() : '';
        const cacheKey = `${imgPath}${personalizedParams}`;
        
        const cached = this.cache.get(cacheKey);

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

        this.cache.set(cacheKey, { 
            loading: loadingPromise, 

            timestamp: Date.now() 
        });

        try {
            const url = await loadingPromise;
            
            // 썸네일 캐시 키에 scheme 정보 포함
            const personalizedParams = this.viewer ? this.viewer.getPersonalizedParams() : '';
            const cacheKey = `${imgPath}${personalizedParams}`;

            this.cache.set(cacheKey, { 
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
            
            // 썸네일 캐시 키에 scheme 정보 포함
            const personalizedParams = this.viewer ? this.viewer.getPersonalizedParams() : '';
            const cacheKey = `${imgPath}${personalizedParams}`;

            this.cache.delete(cacheKey);

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
            const personalizedParams = this.viewer ? this.viewer.getPersonalizedParams() : '';
            // 썸네일 캐시 버스팅을 위한 timestamp 추가 (scheme 변경 시 새로운 썸네일 요청)
            const cacheBuster = this.viewer?._personalizedColorCacheBuster || Date.now();
            const thumbnailUrl = `/api/thumbnail?path=${encodeURIComponent(imgPath)}&size=512${personalizedParams}&_t=${cacheBuster}`;

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

        this.colorEditor = new ColorSchemeEditor(this);

        this.bindEvents();

        this.init();
        this.debugMode = window.location.hash === "#debug";

        // 디바운싱된 showGrid

        this._showGridScheduled = false;

        // 썸네일 매니저

        this.thumbnailManager = new ThumbnailManager(this);

        // 제품 검색 드롭다운 키보드 탐색용
        this.highlightedIndex = -1;
        
        // contextmenu 이벤트 발생 플래그 (다음 click 이벤트 무시용)
        this.contextMenuJustShown = false;
        
        // 전역 AbortController 초기화 (모든 API 요청 중단용)
        this.globalAbortController = new AbortController();

        // 🔥 이미지 로드 전용 AbortController (next/prev 연속 클릭 시 이전 요청 중단)
        this.imageLoadAbortController = null;

        // 🔥 ROOT_DIR 캐시 (중복 API 호출 방지)
        this.cachedRootPath = null;
        
        // 반도체 특화 렌더러 초기화

        this.semiconductorRenderer = null;
        this.usingGpuRenderer = false;
        this.minimapPreview = null;

        this.initSemiconductorRenderer();
        this.initChipAnnotator();
        this.initThumbnailNavigator();

        // ✅ 방법 2: Ctrl 키 상태 안정화를 위한 변수 초기화
        this.wheelTimeout = null;
        this.lastCtrlKey = false;
        
        // ✅ 패널 보호 시스템
        this.panelProtected = false;     // 패널 보호 플래그
        this.zoomInProgress = false;     // 줌 진행 중 플래그
        this.panelProtectTimeout = null; // 디바운스 타이머
        this.minimapPanelProtectTimeout = null; // ✅ 미니맵 패널 보호 타이머

        // 🔥 그리드 스크롤 디바운스 (스크롤 멈춘 후 0.1초 후 로드)
        this.gridScrollDebounceTimer = null;
        this.isGridScrolling = false;

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

    initChipAnnotator() {
        if (this.dom?.overlayCanvas) {
            this.chipAnnotator = new ChipAnnotator(this.dom.overlayCanvas, this);
            this.debugLog('Chip Annotator 초기화 완료');
        } else {
            console.warn('overlayCanvas가 준비되지 않았습니다');
        }
    }

    initThumbnailNavigator() {
        this.thumbnailNavigator = new ThumbnailNavigator(this);
        this.debugLog('Thumbnail Navigator 초기화 완료');
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
            filterTestSelect: document.getElementById('filter-test-select'),
            personalizedColorButton: document.getElementById('personalized-color-button'),
            personalizedColorCheckbox: document.getElementById('personalized-color-checkbox'),
            permissionEditorButton: document.getElementById('permission-editor-button'),
            permissionModal: document.getElementById('permission-editor-modal'),
            permissionEditorClose: document.getElementById('permission-editor-close'),
            permissionRefreshBtn: document.getElementById('permission-refresh-btn'),
            permissionSearchInput: document.getElementById('permission-search-input'),
            permissionSearchResults: document.getElementById('permission-search-results'),
            permissionUserList: document.getElementById('permission-user-list'),
            permissionRegistrationTable: document.getElementById('permission-registration-table'),
            permissionRegistrationTbody: document.getElementById('permission-registration-tbody'),
            permissionAddRowBtn: document.getElementById('permission-add-row-btn'),
            permissionDeleteBtn: document.getElementById('permission-delete-btn'),
            permissionCancelBtn: document.getElementById('permission-cancel-btn'),
            permissionSaveBtn: document.getElementById('permission-save-btn'),

            colorLegendTop: document.getElementById('color-legend-top'),
            colorLegendBottom: document.getElementById('color-legend-bottom'),
            gridColorLegendBottom: document.getElementById('grid-color-legend-bottom'),
            chipLabelLegend: document.getElementById('chip-label-legend'),

            refreshBtn: document.getElementById('refresh-btn'),

            addClassBtn: document.getElementById('add-class-btn'),

            newClassInput: document.getElementById('new-class-input'),

            classList: document.getElementById('class-list'),

            labelStatus: document.getElementById('label-status'),

            deleteClassBtn: document.getElementById('delete-class-btn'),

            renameClassBtn: document.getElementById('rename-class-btn'),
            classModeWaferBtn: document.getElementById('class-mode-wafer-btn'),
            classModeChipBtn: document.getElementById('class-mode-chip-btn'),

            fileSearch: document.getElementById('file-search'),

            searchBtn: document.getElementById('search-btn'),
            multiSearchBtn: document.getElementById('multi-search-btn'),
            multiSearchModal: document.getElementById('multi-search-modal'),
            multiSearchInput: document.getElementById('multi-search-input'),
            multiSearchApply: document.getElementById('multi-search-apply'),
            multiSearchCancel: document.getElementById('multi-search-cancel'),
            multiSearchError: document.getElementById('multi-search-error'),
            compositeOverlay: document.getElementById('composite-overlay'),
            compositeHeatmapGrid: document.getElementById('composite-heatmap-grid'),
            compositeInfoText: document.getElementById('composite-info-text'),
            compositeCountLabel: document.getElementById('composite-count-label'),
            compositeCloseBtn: document.getElementById('composite-close-btn'),

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
        this.isMultiSearchOpen = false;
        this.permissionUsers = [];
        this.permissionSelectedUser = null;
        this.permissionFilterRole = 'ALL'; // 초기값: ALL
        this.permissionStatsUsers = null;
        this.permissionSearchSelectedIndex = -1;

        // 🔥 Composite Map 세션 관리
        this.isCompositeMode = false;
        this.sessionStack = [];  // Grid 세션 스택
        this.compositeSession = null;  // 현재 Composite 세션 정보

        this.updateContextMenuState();

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
        this.chipLabelLegendData = [];
        this.activeChipLabelClasses = null;
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
        this.classMode = 'wafer';
        
        // ✅ 단일 이미지 뷰 모드 상태
        this.viewMode = null;  // 'single' (파일 탐색기), 'gridImage' (그리드), null
        this.singleViewImageList = [];  // 파일 탐색기 모드: 같은 폴더의 모든 이미지
        this.singleViewImageIndex = -1;  // 파일 탐색기 모드: 현재 이미지 인덱스
        this.gridViewImageList = [];  // 그리드 모드: 선택된 이미지들
        this.gridViewImageIndex = -1;  // 그리드 모드: 현재 이미지 인덱스
        this.gridViewSaveState = null;  // 그리드 모드 저장 상태
        this.classToImgListCache = {};

        // 🔥 이미지 로드 버전 관리 (즉시 UI 반응을 위한 중복 로딩 방지)
        this._imageLoadVersion = 0;  // 이미지 로드 버전 (증가하는 카운터)

        this.selectedFolderForBrowser = '';
        this.productFolderPath = null;  // 🔥 제품 폴더 경로 저장 (classification 조회용)

        // 파일 필터 상태 (기본값: '' - Lot Type, 필터 적용 안 함)
        this.filterTestMode = '';

        // 개인색 설정 상태 (기본값: false)
        this.personalizedColorEnabled = true; // 🔥 기본값: 개인색 설정 활성화

        // Color Legends 데이터
        this.colorLegends = null;
        this.currentUser = null; // ✅ 초기값: null (아직 결정 안 됨, loadUserInfo()에서 설정됨)

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

        this.bindFilterEvents();

        this.bindClassModeEvents();
        this.bindChipLegendEvents();

        // T 키 토글 제거 - Navigator는 이미지 1개 보기 모드에서만 자동 표시됨
    }

    bindViewerEvents() {
        if (this.dom.viewerContainer)

            this.dom.viewerContainer.addEventListener('wheel', e => {
                if (this.gridMode) return; // grid 모드에서는 팬/줌 비활성화

                e.preventDefault(); // 스크롤 방지
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

        // 🔥 Overlay canvas 우클릭 이벤트: Chip context menu
        if (this.dom.overlayCanvas) {
            this.dom.overlayCanvas.addEventListener('contextmenu', e => {
                if (this.gridMode) return; // 그리드 모드에서는 처리 안 함
                if (!this.chipAnnotator || !this.chipAnnotator.positionsData) return;

                e.preventDefault();
                e.stopPropagation();

                // 선택된 chip 확인
                const selectedChips = this.chipAnnotator.getSelectedChipData();
                if (selectedChips.length === 0) return;

                this.showChipContextMenu(e, selectedChips);
            });
        }

        // 🔥 더블클릭 이벤트: 상세 보기 모드 종료 또는 그리드로 복귀
        if (this.dom.viewerContainer) {
            this.dom.viewerContainer.addEventListener('dblclick', e => {
                console.log('🖱️ [DBLCLICK] 더블클릭 감지:', {
                    viewMode: this.viewMode,
                    detailMode: this.detailMode,
                    isNavigating: this._isNavigating,
                    target: e.target
                });
                
                // 🔥 Step 0: Next/Prev 버튼 위에서는 더블클릭 무시 (버튼 클릭이 우선)
                const prevBtn = document.getElementById('prev-btn');
                const nextBtn = document.getElementById('next-btn');
                const isOnNavButton = (prevBtn && (e.target === prevBtn || prevBtn.contains(e.target))) ||
                                     (nextBtn && (e.target === nextBtn || nextBtn.contains(e.target)));
                if (isOnNavButton) {
                    console.log('🛑 [DBLCLICK] Next/Prev 버튼 위에서 더블클릭 무시');
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                
                // ✅ Step 1: 상세 모드 확인
                if (this.detailMode) {
                    console.log('🖱️ [DBLCLICK] → 상세 모드 종료');
                    this.exitDetailMode();
                    return;
                }
                
                // ✅ Step 2: 파일탐색기 모드 (single) - 2번 이동 (이미지 캔버스에서의 더블클릭에만 한정)
                if (this.viewMode === 'single') {
                    const isOnImageCanvas = this.dom.imageCanvas && (e.target === this.dom.imageCanvas || this.dom.imageCanvas.contains(e.target));
                    if (isOnImageCanvas) {
                        console.log('🖱️ [DBLCLICK] → 파일탐색기 모드: 2번 이동 (imageCanvas에서 발생)');
                        e.preventDefault();
                        this.handleDoubleClickNavigation();
                        return;
                    }
                }
                
                // ✅ Step 3: 그리드 이미지 모드 (gridImage) - 그리드 복귀
                if (this.viewMode === 'gridImage') {
                    console.log('🖱️ [DBLCLICK] → 그리드 이미지 모드: 그리드 복귀');
                    e.preventDefault();
                    this.exitSingleImageViewMode();
                    return;
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
        if (this.dom.zoomInBtn) {
            this.dom.zoomInBtn.addEventListener('click', () => {
                this.panelProtected = true;
                this.zoomInProgress = true;
                this.zoomAtCenter(ZOOM_FACTOR);
            });
        }

        if (this.dom.zoomOutBtn) {
            this.dom.zoomOutBtn.addEventListener('click', () => {
                this.panelProtected = true;
                this.zoomInProgress = true;
                this.zoomAtCenter(1 / ZOOM_FACTOR);
            });
        }

        if (this.dom.resetViewBtn) {
            this.dom.resetViewBtn.addEventListener('click', () => {
                this.panelProtected = true;
                this.zoomInProgress = true;
                this.resetViewWithAbsoluteOffset();
            });
        }

        if (this.dom.zoom50Btn) {
            this.dom.zoom50Btn.addEventListener('click', () => {
                this.panelProtected = true;
                this.zoomInProgress = true;
                this.setZoom(0.5);
            });
        }

        if (this.dom.zoom100Btn) {
            this.dom.zoom100Btn.addEventListener('click', () => {
                this.panelProtected = true;
                this.zoomInProgress = true;
                this.setZoom(1.0);
            });
        }

        if (this.dom.zoom200Btn) {
            this.dom.zoom200Btn.addEventListener('click', () => {
                this.panelProtected = true;
                this.zoomInProgress = true;
                this.setZoom(2.0);
            });
        }

        if (this.dom.zoom300Btn) {
            this.dom.zoom300Btn.addEventListener('click', () => {
                this.panelProtected = true;
                this.zoomInProgress = true;
                this.setZoom(3.0);
            });
        }
        
        // ✅ prev/next 버튼 클릭 이벤트
        const prevBtn = document.getElementById('prev-btn');
        const nextBtn = document.getElementById('next-btn');
        if (prevBtn) {
            // 🔥 더블클릭 방지: 버튼 위에서 더블클릭이 발생해도 무시
            prevBtn.addEventListener('dblclick', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('🛑 [NAV_BTN] Prev 버튼 더블클릭 무시');
            });
            prevBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // 🔥 버튼 클릭이 다른 모든 이벤트보다 우선 처리
                this.navigatePrevious();
            });
        }
        if (nextBtn) {
            // 🔥 더블클릭 방지: 버튼 위에서 더블클릭이 발생해도 무시
            nextBtn.addEventListener('dblclick', (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('🛑 [NAV_BTN] Next 버튼 더블클릭 무시');
            });
            nextBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                // 🔥 버튼 클릭이 다른 모든 이벤트보다 우선 처리
                this.navigateNext();
            });
        }
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

        // 🔥 Composite Mode 종료 (Wafer Map Explorer에서 다른 맵 선택 시)
        if (this.isCompositeMode) {
            console.log('🔄 Composite Mode 종료 (Wafer Map Explorer 오른쪽 클릭)');
            this.isCompositeMode = false;
            this.compositeSession = null;
            this.updateContextMenuState();
        }

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

        // ✅ Wafer Navigator 숨김
        if (this.thumbnailNavigator) {
            this.thumbnailNavigator.hide();
        }

        // 초기 상태로 복귀 - 검색창이 보이는 상태

        this.showInitialState();
        
        // 🔥 검색 텍스트 초기화 (일반 검색 및 다중 검색)
        if (this.dom.fileSearch) {
            this.dom.fileSearch.value = '';
        }
        if (this.dom.multiSearchInput) {
            this.dom.multiSearchInput.value = '';
        }

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

        // ⭐ fileNameDisplay 직접 숨기기 (hideFileName() 호출 대신 직접 처리)
        if (this.dom.fileNameDisplay) {
            this.dom.fileNameDisplay.style.display = 'none';
            this.debugLog('🔷 [DEBUG] fileNameDisplay 숨김 (hideImage)');
        }
        
        // ⭐ Chip Labels 숨기기
        if (this.dom.chipLabelLegend) {
            this.dom.chipLabelLegend.style.display = 'none';
            this.debugLog('🔷 [DEBUG] chipLabelLegend 숨김');
        }
        
        // 상태 초기화
        this.currentImage = null;
        this.currentImageBitmap = null;
        this.selectedImagePath = '';

        // 뷰어 컨테이너 클래스 제거

        if (this.dom.viewerContainer) {
            this.dom.viewerContainer.classList.remove('single-image-mode');
        }
        
        // ⭐ Chip Selection 패널 명시적으로 숨기기
        this.closeChipSelectionPanel();
        this.debugLog('🔷 [DEBUG] chipSelectionPanel 숨김');
        
        // ⭐ 화살표 버튼 숨기기
        this.viewMode = null;
        this.updateArrowButtonVisibility();
        this.debugLog('🔷 [DEBUG] 화살표 버튼 숨김');
    }

    // 파일명 표시

    showFileName(path) {
        if (this.dom.fileNameDisplay && this.dom.fileNameText && this.dom.filePathText) {
            const fileName = path.split('/').pop() || path.split('\\').pop() || path;
            // 파일명에서 확장자 제거
            const fileNameWithoutExt = fileName.replace(/\.[^.]+$/, '');

            this.dom.fileNameText.textContent = fileNameWithoutExt;

            // 상위의 상위 폴더 표시
            const parentFolder = this.getParentFolder(path);

            this.dom.filePathText.textContent = parentFolder;

            // 구분자 표시/숨김 처리
            const separator = document.getElementById('separator-text');
            if (separator) {
                separator.style.display = parentFolder ? 'inline' : 'none';
            }

            this.dom.fileNameDisplay.style.display = 'block';

            // 상단 바가 보이도록 캔버스 높이는 CSS 변수로 이미 확보됨
        }

        // ⭐ Chip Labels 표시 (단일 이미지 모드에서만)
        if (this.dom.chipLabelLegend) {
            this.dom.chipLabelLegend.style.display = 'block';
            this.debugLog('🟢 [DEBUG] chipLabelLegend 표시');
        }
    }

    // 상위의 상위 폴더명 추출 + 확장자 제거
    getParentFolder(fullPath) {
        const parts = fullPath.replace(/\\/g, '/').split('/');
        // 파일명 제거
        const fileName = parts.pop();
        // 파일명에서 확장자 제거
        const fileNameWithoutExt = fileName ? fileName.replace(/\.[^.]+$/, '') : '';

        // 상위의 상위 폴더명 반환 (없으면 빈 문자열)
        if (parts.length >= 2) {
            return parts[parts.length - 2];  // 상위의 상위 폴더
        }
        return '';
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
            // 🔥 제품 폴더 경로 저장 (classification 조회용)
            this.productFolderPath = data.current_folder;
            console.log('🔍 [STATE_DEBUG] currentFolderPath 업데이트 (init):', this.currentFolderPath);
            console.log('🔍 [STATE_DEBUG] productFolderPath 저장 (init):', this.productFolderPath);
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

                    if (this.isClassificationEntry(name) || name === 'thumbnails' || name === 'labels') {
                        return false;
                    }

                    // 2depth: classification/*, thumbnails/*, labels/* 제외

                    if (name.startsWith('thumbnails/') || name.startsWith('labels/')) {
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
            // 기본 선택(최상위)으로 돌아간 경우
            this.selectedProductName = null;
            await this.resetToImageFolder();
            if (this.labelManager && typeof this.labelManager.refreshAll === 'function') {
                try {
                    await this.labelManager.refreshAll();
                } catch (err) {
                    console.error('LabelManager 최상위 새로고침 실패:', err);
                }
            }
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
        const previousImagePath = this.selectedImagePath || null;
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
                // 🔥 제품 폴더 경로 저장 (classification 조회용)
                this.productFolderPath = result.current_folder;
                console.log('🔍 [STATE_DEBUG] currentFolderPath 변경 후 (changeFolder):', this.currentFolderPath);
                console.log('🔍 [STATE_DEBUG] productFolderPath 저장:', this.productFolderPath);
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

                    if (this.labelManager) {
                        try {
                            this.labelManager.classes = [];
                            if (this.labelManager.labelSelection) {
                                this.labelManager.labelSelection.selected = [];
                                this.labelManager.labelSelection.selectedClasses = [];
                            }
                            await this.labelManager.refreshAll();
                            console.log('🔍 [FOLDER_CHANGE_DEBUG] LabelManager 새로고침 완료');
                        } catch (labelErr) {
                            console.error('🔍 [FOLDER_CHANGE_DEBUG] LabelManager 새로고침 실패:', labelErr);
                        }
                    }

                    if (previousImagePath) {
                        this.selectedImagePath = previousImagePath;
                    }

                    // 🔄 Chip legend/annotator 상태 초기화 후 필요 시 재로딩
                    this.activeChipLabelClasses = null;
                    let chipLegendReloaded = false;
                    if (this.chipAnnotator) {
                        this.chipAnnotator.setLegendFilterClasses(null);
                        if (this.selectedImagePath) {
                            try {
                                await this.chipAnnotator.loadAnnotations(this.selectedImagePath);
                                chipLegendReloaded = true;
                            } catch (chipErr) {
                                console.warn('🔍 [FOLDER_CHANGE_DEBUG] chip annotations 재로딩 실패:', chipErr);
                                this.chipAnnotator.markedChips = [];
                                this.chipAnnotator.render();
                            }
                        } else {
                            this.chipAnnotator.markedChips = [];
                            this.chipAnnotator.render();
                        }
                    }
                    if (!chipLegendReloaded) {
                        this.chipLabelLegendData = [];
                        this.updateChipLabelLegend([]);
                    }
                    if (this.selectedImagePath) {
                        this.showFileName(this.selectedImagePath);
                    } else {
                        this.hideFileName();
                    }
                    this.renderColorLegends();
                    this.showColorLegends();
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

                    // 🔥 Fail List 갱신 (제품 선택 시)
                    this.updateLabelExplorerContent();
                    console.log('🔍 [FOLDER_CHANGE_DEBUG] Fail List 갱신 완료');
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
            
            // 🔥 클래스 캐시 무효화 (최상위 폴더의 클래스를 가져오기 위해)
            this.cachedClassList = null;
            this.classListPromise = null;

            // 🔥 클래스 캐시 삭제
            if (this.classToImgListCache) {
                this.classToImgListCache = {};
            }

            // 🔥 Label Explorer 폴더 상태 초기화
            if (this.labelSelection) {
                this.labelSelection.openFolders = {};
                this.labelSelection.selected = [];
                this.labelSelection.selectedClasses = [];
            }

            // 최상위 폴더의 파일 목록 로드
            await this.loadDirectoryContents(null, this.dom.fileExplorer);

            // 🔥 Class Manager 새로고침 (최상위 폴더의 클래스 표시)
            if (this.labelManager) {
                try {
                    this.labelManager.classes = [];
                    if (this.labelManager.labelSelection) {
                        this.labelManager.labelSelection.selected = [];
                        this.labelManager.labelSelection.selectedClasses = [];
                    }
                    await this.labelManager.refreshAll();
                    console.log('🔍 [ROOT_FOLDER] LabelManager 새로고침 완료');
                } catch (labelErr) {
                    console.error('🔍 [ROOT_FOLDER] LabelManager 새로고침 실패:', labelErr);
                }
            }

            // 클래스와 라벨 새로고침 (refreshLabelExplorer가 내부에서 getClassList() 호출)
            await this.refreshLabelExplorer();

            // 🔥 Fail List 갱신 (최상위 폴더로 이동 시)
            this.updateLabelExplorerContent();
            console.log('🔍 [ROOT_FOLDER] Fail List 갱신 완료');

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
                            !this.isClassificationEntry(folder.name) && 
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
        // ✅ 패널이 보호 중이면 절대 숨기지 않음
        if (this.panelProtected) {
            console.log('[PANEL] 보호 중 - 숨기기 취소');
            return;
        }
        
        // ✅ 줌 진행 중이면 절대 숨기지 않음
        if (this.zoomInProgress) {
            console.log('[PANEL] 줌 진행 중 - 숨기기 취소');
            return;
        }
        
        // 정상적인 경우에만 숨김
        if (this.dom.fileNameDisplay) {
            this.dom.fileNameDisplay.style.display = 'none';
            this.debugLog('🔷 [DEBUG] fileNameDisplay 숨김');
        }

        // ⭐ Chip Labels도 함께 숨기기
        if (this.dom.chipLabelLegend) {
            this.dom.chipLabelLegend.style.display = 'none';
            this.debugLog('🔷 [DEBUG] chipLabelLegend 숨김');
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

        // ✅ Chip selection panel 숨김
        const chipSelectionPanel = document.getElementById('chip-selection-panel');
        if (chipSelectionPanel) {
            chipSelectionPanel.style.display = 'none';
        }
        
        const selectedChipsList = document.getElementById('selected-chips-list');
        if (selectedChipsList) {
            selectedChipsList.style.display = 'none';
        }
        
        // ✅ Arrow buttons 숨김
        const prevBtn = document.getElementById('prev-btn');
        const nextBtn = document.getElementById('next-btn');
        if (prevBtn) prevBtn.style.display = 'none';
        if (nextBtn) nextBtn.style.display = 'none';
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
        // ✅ 방법 1: 모든 가능한 패널 강제 숨기기
        const selectorsToHide = [
            '#file-name',
            '#file-name-display', 
            '#detail-file-name',
            '.file-name-panel',
            '#chip-selection',
            '#chip-selection-panel',
            '.chip-selection-panel',
            '#selected-chips-list'
        ];
        
        selectorsToHide.forEach(selector => {
            try {
                const el = document.querySelector(selector);
                if (el) {
                    el.style.display = 'none';
                    el.style.removeProperty('visibility');
                    el.style.removeProperty('opacity');
                }
            } catch (e) {
                console.warn(`⚠️ [GRID] 선택자 오류: ${selector}`, e);
            }
        });
        
        // ✅ 방법 2: CSS 클래스 활용
        document.body.classList.add('grid-mode-active');
        
        this.gridMode = true; // 🔥 초기 화면도 gridMode로 설정 (상단 legend 표시용)
        
        // ✅ Chip Selection 패널 완전히 닫기
        this.closeChipSelectionPanel();

        // ✅ Chip selection panel 명시적으로 숨김
        const chipSelectionPanel = document.getElementById('chip-selection-panel');
        if (chipSelectionPanel) {
            chipSelectionPanel.style.display = 'none';
        }
        
        const selectedChipsList = document.getElementById('selected-chips-list');
        if (selectedChipsList) {
            selectedChipsList.style.display = 'none';
        }
        
        // ✅ Arrow buttons 숨김
        const prevBtn = document.getElementById('prev-btn');
        const nextBtn = document.getElementById('next-btn');
        if (prevBtn) prevBtn.style.display = 'none';
        if (nextBtn) nextBtn.style.display = 'none';
        
        // ✅ viewMode 초기화
        this.viewMode = null;

        if (this.dom.viewerContainer) {
            this.dom.viewerContainer.classList.add('grid-mode');

            this.dom.viewerContainer.classList.remove('single-image-mode');
        }
        
        // 🔥 초기 화면에서 상단 legend 표시
        this.showColorLegends();

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

            // 드래그 선택 처리

            if (!dragData.start) {
                // 드래그 시작점이 없으면 단순 클릭으로 처리
                if (!wasActive) {
                    handleTapSelection(e);
                }
                dragData.start = null;
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

            // 🔥 드래그 거리가 임계값 이하일 때만 탭 선택 처리 (드래그 선택이 실제로 발생하지 않았을 때만)
            if (Math.max(dragWidth, dragHeight) <= dragIntentThreshold) {
                // 드래그 선택이 활성화되지 않았을 때만 탭 선택 처리
                if (!wasActive) {
                    handleTapSelection(e);
                }
                dragData.start = null;
                return;
            }

            // 🔥 드래그 선택이 완료된 경우 (임계값 초과) - 탭 선택 처리하지 않음

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
            // 🔥 썸네일 로드 디바운스
            this.handleGridScroll();

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

        if (this.dom.multiSearchBtn) {
            this.dom.multiSearchBtn.addEventListener('click', () => this.openMultiSearchModal());
        }
        if (this.dom.multiSearchCancel) {
            this.dom.multiSearchCancel.addEventListener('click', () => this.closeMultiSearchModal());
        }
        if (this.dom.multiSearchApply) {
            this.dom.multiSearchApply.addEventListener('click', () => this.handleMultiSearchApply());
        }
        if (this.dom.multiSearchInput) {
            this.dom.multiSearchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.closeMultiSearchModal();
                    return;
                }
                // Enter → 검색 실행 (Shift+Enter, Ctrl+Enter는 기본 동작으로 다음 행 이동)
                if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    this.handleMultiSearchApply();
                    return;
                }
                if (e.key === 'Enter' && (e.shiftKey || e.ctrlKey)) {
                    e.preventDefault();
                    const textarea = e.currentTarget;
                    const start = textarea.selectionStart;
                    const end = textarea.selectionEnd;
                    const value = textarea.value;
                    textarea.value = `${value.slice(0, start)}\n${value.slice(end)}`;
                    textarea.selectionStart = textarea.selectionEnd = start + 1;
                }
            });
        }

        if (this.dom.permissionEditorButton) {
            this.dom.permissionEditorButton.addEventListener('click', () => this.openPermissionEditorModal());
        }
        if (this.dom.permissionEditorClose) {
            this.dom.permissionEditorClose.addEventListener('click', () => this.closePermissionEditorModal());
        }
        if (this.dom.permissionCancelBtn) {
            this.dom.permissionCancelBtn.addEventListener('click', () => this.closePermissionEditorModal());
        }
        if (this.dom.permissionRefreshBtn) {
            this.dom.permissionRefreshBtn.addEventListener('click', () => this.reloadPermissionUsers());
        }
        // 역할 필터 버튼들 (이벤트 위임 사용)
        if (this.dom.permissionModal) {
            this.dom.permissionModal.addEventListener('click', (e) => {
                if (e.target.classList.contains('permission-role-filter-btn')) {
                    const role = e.target.dataset.role;
                    this.setPermissionFilterRole(role);
                }
            });
        }
        // 검색 입력
        if (this.dom.permissionSearchInput) {
            this.dom.permissionSearchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    // 검색 결과가 열려있고 선택된 항목이 있으면 적용
                    if (this.dom.permissionSearchResults && this.dom.permissionSearchResults.classList.contains('is-open')) {
                        const rows = Array.from(this.dom.permissionSearchResults.querySelectorAll('.permission-search-row'));
                        if (rows.length > 0 && this.permissionSearchSelectedIndex >= 0 && this.permissionSearchSelectedIndex < rows.length) {
                            const selectedRow = rows[this.permissionSearchSelectedIndex];
                            const loginId = selectedRow.dataset.loginId;
                            const match = (this.permissionStatsUsers || []).find(item => item.loginId === loginId);
                            if (match) {
                                this.applyStatsUserToTable(match);
                            }
                        } else {
                            // 검색 결과가 없으면 검색 실행
                            this.handlePermissionSearch();
                        }
                    } else {
                        // 검색 결과가 없으면 검색 실행
                        this.handlePermissionSearch();
                    }
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.navigateSearchResults(1);
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.navigateSearchResults(-1);
                } else if (e.key === 'Escape') {
                    this.hidePermissionSearchResults();
                }
            });
            this.dom.permissionSearchInput.addEventListener('input', () => {
                this.handlePermissionSearch();
            });
        }
        // 테이블 행 추가
        if (this.dom.permissionAddRowBtn) {
            this.dom.permissionAddRowBtn.addEventListener('click', () => this.addPermissionTableRow());
        }
        // 저장 버튼
        if (this.dom.permissionSaveBtn) {
            this.dom.permissionSaveBtn.addEventListener('click', () => this.handlePermissionBatchSave());
        }
        // 삭제 버튼
        if (this.dom.permissionDeleteBtn) {
            this.dom.permissionDeleteBtn.addEventListener('click', () => this.handlePermissionDelete());
        }
        // 등급 드롭다운 버튼들
        document.addEventListener('click', (e) => {
            if (e.target.classList.contains('permission-role-dropdown-btn')) {
                const btn = e.target;
                const role = btn.dataset.role;
                const row = btn.closest('.permission-registration-row');
                if (row) {
                    const roleInput = row.querySelector('.permission-role-input');
                    if (roleInput) {
                        roleInput.value = role;
                        // ADMIN/SUPER 선택 시 폴더 입력 비활성화
                        this.updatePermissionFolderInputState(row, role);
                    }
                }
            }
        });
        // 폴더 입력 변경 시 ADMIN/SUPER 체크
        if (this.dom.permissionRegistrationTbody) {
            this.dom.permissionRegistrationTbody.addEventListener('input', (e) => {
                if (e.target.classList.contains('permission-role-input')) {
                    const row = e.target.closest('.permission-registration-row');
                    if (row) {
                        this.updatePermissionFolderInputState(row, e.target.value);
                    }
                }
            });
        }
        if (this.dom.compositeCloseBtn) {
            this.dom.compositeCloseBtn.addEventListener('click', () => this.exitCompositeMode());
        }

    }

    bindFilterEvents() {
        if (this.dom.filterTestSelect) {
            this.dom.filterTestSelect.addEventListener('change', async (e) => {
                this.filterTestMode = e.target.value || ''; // 빈 문자열은 'Lot Type' (필터 적용 안 함)
                // 필터 상태가 변경되면 파일 탐색기 다시 로드
                await this.loadDirectoryContents(this.currentFolderPrefix || null, this.dom.fileExplorer);
            });
        }

        if (this.dom.personalizedColorButton) {
            this.dom.personalizedColorButton.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.onPersonalColorButtonClick();
            });
        } else {
            // 나중에 다시 시도
            setTimeout(() => {
                const btn = document.getElementById('personalized-color-button');
                if (btn) {
                    this.dom.personalizedColorButton = btn;
                    btn.addEventListener('click', (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        this.onPersonalColorButtonClick();
                    });
                }
            }, 100);
        }

        // 🔥 개인색 설정은 항상 활성화되므로 체크박스 이벤트는 유지하되 UI에서 숨김
        // 체크박스가 없어도 내부적으로는 항상 활성화 상태로 동작
        if (this.dom.personalizedColorCheckbox) {
            // 체크박스를 숨김 (UI에서 제거되었지만 DOM에는 남아있을 수 있음)
            this.dom.personalizedColorCheckbox.style.display = 'none';
            this.dom.personalizedColorCheckbox.addEventListener('change', async (e) => {
                const wasEnabled = this.personalizedColorEnabled;
                this.personalizedColorEnabled = e.target.checked;
                console.log('🎨 [CHECKBOX] 개인색 설정:', this.personalizedColorEnabled ? '활성화' : '비활성화');
                console.log('🔍 [DEBUG] gridMode:', this.gridMode, '| selectedImagePath:', this.selectedImagePath);

                // 🔥 currentUser 설정 확인 (개인색 활성화 시에만 사용)
                if (this.personalizedColorEnabled) {
                    this.currentUser = this.currentUser || 'change';
                    console.log('🎨 [CHECKBOX] currentUser:', this.currentUser);
                }

                // 🔥 캐시 무효화를 위해 타임스탬프 추가 (체크박스 변경 시 항상)
                this._personalizedColorCacheBuster = Date.now();
                
                // 🔥 개인색 설정 변경 시 썸네일 캐시 완전 초기화 (다른 scheme의 썸네일 무시)
                if (this.thumbnailManager) {
                    this.thumbnailManager.cache.clear();
                }

                // 🔥 Legend 즉시 업데이트 (체크박스 변경 시 항상)
                console.log('🎨 [CHECKBOX] Legend 즉시 업데이트 시작');
                this.renderColorLegends();
                this.showColorLegends();
                console.log('🎨 [CHECKBOX] Legend 업데이트 완료');

                // 현재 화면 새로고침
                if (this.gridMode) {
                    // 그리드 모드인 경우: 그리드 다시 로드
                    console.log('🔄 [RELOAD] Grid mode - reloading grid');
                    const grid = document.getElementById('image-grid');
                    let currentImages = [];
                    if (grid) {
                        currentImages = Array.from(grid.querySelectorAll('.grid-thumb-wrap'))
                            .map(wrap => wrap.dataset.path)
                            .filter(Boolean);
                    }
                    
                    if (currentImages.length === 0) {
                        if (this.savedViewState && this.savedViewState.images && this.savedViewState.images.length > 0) {
                            currentImages = this.savedViewState.images;
                        } else if (this.selectedImages && this.selectedImages.length > 0) {
                            currentImages = this.selectedImages;
                        } else if (this.currentGridImages && this.currentGridImages.length > 0) {
                            currentImages = this.currentGridImages;
                        }
                    }
                    
                    console.log('🔍 [DEBUG] currentImages count:', currentImages.length);
                    if (currentImages.length > 0) {
                        // 🔥 썸네일 캐시 무효화를 위해 그리드 이미지들의 src를 강제로 업데이트
                        const gridImages = grid.querySelectorAll('.grid-thumb-img');
                        gridImages.forEach(img => {
                            if (img.src && img.src.includes('/api/thumbnail')) {
                                // URL에 캐시 버스터 추가하여 강제 새로고침
                                const url = new URL(img.src, window.location.origin);
                                url.searchParams.set('_t', Date.now());
                                img.src = url.toString();
                            }
                        });
                        
                        await this.showGrid(currentImages);
                    } else {
                        console.warn('⚠️ No images found in grid');
                    }
                } else {
                    // 단일 이미지 모드인 경우: 이미지 다시 로드 (체크박스 해제/체크 모두)
                    let imagePath = this.selectedImagePath;
                    if (!imagePath && this.currentImage) {
                        // currentImage.src에서 경로 추출: /api/image?path=...&level=...
                        const urlParams = new URLSearchParams(this.currentImage.src.split('?')[1]);
                        imagePath = urlParams.get('path');
                        console.log('🔍 [DEBUG] Extracted path from currentImage.src:', imagePath);
                    }

                    if (imagePath) {
                        console.log('🔄 [RELOAD] Single image mode - reloading:', imagePath, '| enabled:', this.personalizedColorEnabled);
                        
                        // 🔥 현재 줌/스케일/위치 저장 (체크박스 변경 시 유지)
                        const savedZoom = this.zoom;
                        const savedScale = this.transform.scale;
                        const savedDx = this.transform.dx;
                        const savedDy = this.transform.dy;
                        const savedCurrentPyramidLevel = this.currentPyramidLevel;
                        
                        // 🔥 피라미드 레벨 캐시 완전 초기화 (개인색 변경 시 모든 레벨 재로드 필요)
                        this.pyramidLevels = {};
                        this._pyramidLoading = new Set();
                        if (this.pyramidLoadingLevels) {
                            this.pyramidLoadingLevels.clear();
                        }
                        // 🔥 GPU 렌더러 캐시도 초기화
                        if (this.semiconductorRenderer) {
                            this.semiconductorRenderer.imagePyramid = {};
                            this.semiconductorRenderer.levelTextures.clear();
                        }
                        
                        // 🔥 이미지 다시 로드 (개인색 파라미터 포함/미포함)
                        await this.loadImage(imagePath);
                        
                        // 🔥 체크박스 변경 시에는 줌/스케일/위치 복원 (이미지 크기 유지)
                        if (this.currentImage && this.originalWidth && this.originalHeight) {
                            // 줌/스케일 복원
                            this.zoom = savedZoom;
                            this.transform.scale = savedScale;
                            
                            // 위치 복원
                            this.transform.dx = savedDx;
                            this.transform.dy = savedDy;
                            
                            // 줌 표시 업데이트
                            this.updateZoomDisplay();
                            
                            // 렌더링
                            this.scheduleDraw();
                            
                            // 피라미드 레벨 복원 (약간의 지연 후, 레벨이 로드될 때까지 대기)
                            setTimeout(async () => {
                                if (savedCurrentPyramidLevel) {
                                    // 저장된 레벨이 아직 로드되지 않았으면 다시 로드
                                    if (!this.pyramidLevels[savedCurrentPyramidLevel]) {
                                        console.log(`🔄 [CHECKBOX] 피라미드 레벨 ${savedCurrentPyramidLevel} 재로드 중...`);
                                        await this.updatePyramidLevel();
                                    } else {
                                        // 레벨이 이미 로드되어 있으면 활성화
                                        this.currentPyramidLevel = savedCurrentPyramidLevel;
                                        if (this.semiconductorRenderer?.isGpuAvailable()) {
                                            this.semiconductorRenderer.setActiveLevel(savedCurrentPyramidLevel);
                                        }
                                        this.scheduleDraw();
                                    }
                                } else {
                                    // 저장된 레벨이 없으면 현재 줌에 맞는 레벨로 업데이트
                                    this.updatePyramidLevel();
                                }
                            }, 100);
                            
                            console.log('🎨 [CHECKBOX] 줌/스케일 복원 완료:', {
                                zoom: savedZoom,
                                scale: savedScale,
                                dx: savedDx,
                                dy: savedDy,
                                level: savedCurrentPyramidLevel
                            });
                        }
                        
                        // 🔥 Legend 다시 렌더링 (이미지 로드 후 최종 확인)
                        this.renderColorLegends();
                        this.showColorLegends();
                        console.log('🎨 [CHECKBOX] 이미지 재로드 및 Legend 업데이트 완료');
                    } else {
                        console.warn('⚠️ No reload action: no image path found');
                        // 이미지 경로가 없어도 Legend는 이미 업데이트됨
                    }
                }
            });
        }
    }

    bindClassModeEvents() {
        const { classModeWaferBtn, classModeChipBtn } = this.dom;

        if (classModeWaferBtn) {
            classModeWaferBtn.addEventListener('click', () => { void this.setClassMode('wafer'); });
        }

        if (classModeChipBtn) {
            classModeChipBtn.addEventListener('click', () => { void this.setClassMode('chip'); });
        }

        this.updateClassModeButtons();
    }

    async setClassMode(mode) {
        const normalized = mode === 'chip' ? 'chip' : 'wafer';
        if (this.classMode === normalized) {
            return;
        }

        this.classMode = normalized;
        this.updateClassModeButtons();
        this.resetClassModeState();

        // 🔥 모드 변경 시 labelManager 상태 초기화
        if (this.labelManager) {
            // 🔥 this.classes는 초기화하지 않음! refreshClassList()가 백업할 수 있도록 유지
            // 🔥 refreshClassList()에서 backupClasses = [...this.classes]를 하므로
            // 🔥 여기서 초기화하면 백업할 클래스가 없어짐
            this.labelManager.isRefreshing = false;
            this.labelManager.pendingRefresh = false;
            
            // 🔥 DOM은 refreshAll() 완료 후에 자동으로 업데이트되므로 여기서 비우지 않음
            // 🔥 이렇게 하면 refreshAll()이 실패해도 이전 모드의 클래스가 유지됨
        }

        // 🔥 current_folder 복원 제거: 오직 changeFolder에서만 current_folder 변경 가능
        // 🔥 setClassMode는 changeFolder로 설정된 current_folder를 그대로 사용

        // 🔥 refreshAll()이 refreshClassList()와 refreshLabelExplorer()를 모두 호출하므로
        // 🔥 refreshLabelExplorer()를 별도로 호출하지 않음 (중복 API 호출 방지)
        if (this.labelManager && typeof this.labelManager.refreshAll === 'function') {
            this.labelManager.refreshAll()
                .then(() => {
                    console.log(`🔍 [CLASS_MODE] LabelManager 새로고침 완료 (mode=${normalized})`);
                    this.updateLabelExplorerContent();
                    console.log(`🔍 [CLASS_MODE] Fail List 갱신 완료 (mode=${normalized})`);
                })
                .catch((error) => {
                    console.error('❌ [CLASS_MODE] LabelManager refresh 실패:', error);
                    // 에러 발생 시에도 기본 상태는 유지하도록 시도
                    try {
                        this.updateLabelExplorerContent();
                    } catch (updateErr) {
                        console.error('❌ [CLASS_MODE] Fail List 갱신도 실패:', updateErr);
                    }
                });
        } else {
            // 🔥 labelManager가 없으면 refreshLabelExplorer만 호출
            this.refreshLabelExplorer()
                .then(() => {
                    console.log(`🔍 [CLASS_MODE] Label Explorer 새로고침 완료 (mode=${normalized})`);
                    this.updateLabelExplorerContent();
                    console.log(`🔍 [CLASS_MODE] Fail List 갱신 완료 (mode=${normalized})`);
                })
                .catch(err => {
                    console.error('❌ [CLASS_MODE] Label Explorer 새로고침 실패:', err);
                    // 에러 발생 시에도 기본 상태는 유지하도록 시도
                    try {
                        this.updateLabelExplorerContent();
                    } catch (updateErr) {
                        console.error('❌ [CLASS_MODE] Fail List 갱신도 실패:', updateErr);
                    }
                });
        }
    }

    resetClassModeState() {
        this.cachedClassList = null;
        this.classListPromise = null;
        this.classToImgListCache = {};
        this.classSelection = { selected: [], lastClicked: null };
        this.selectedClass = null;
        if (this.dom.deleteClassBtn) this.dom.deleteClassBtn.disabled = true;
        if (this.dom.renameClassBtn) this.dom.renameClassBtn.disabled = true;
        this.labelSelection = { selected: [], lastClicked: null, openFolders: {}, selectedClasses: [] };
        this.activeChipLabelClasses = null;
        this.renderChipLabelLegend();
        this.updateClassManagerButtons();
    }

    updateClassModeButtons() {
        const { classModeWaferBtn, classModeChipBtn } = this.dom;
        const states = [
            { btn: classModeWaferBtn, active: this.classMode === 'wafer' },
            { btn: classModeChipBtn, active: this.classMode === 'chip' }
        ];

        states.forEach(({ btn, active }) => {
            if (!btn) return;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-pressed', active ? 'true' : 'false');
            if (active) {
                btn.style.background = '#007acc';
                btn.style.borderColor = '#09f';
                btn.style.color = '#fff';
            } else {
                btn.style.background = '#1f1f1f';
                btn.style.borderColor = '#555';
                btn.style.color = '#bbb';
            }
        });
    }

    buildClassApiUrl(path, extraParams = {}) {
        const params = new URLSearchParams();
        const includeMode = !path.startsWith('/api/classify');
        if (includeMode && this.classMode) {
            params.set('mode', this.classMode);
        }
        Object.entries(extraParams).forEach(([key, value]) => {
            if (value === undefined || value === null || value === '') return;
            params.set(key, value);
        });

        const query = params.toString();
        return `${path}${query ? `?${query}` : ''}`;
    }

    getClassificationDirNames() {
        return CLASSIFICATION_DIR_NAMES;
    }

    getClassificationDirName() {
        return this.classMode === 'chip' ? 'classification_chips' : 'classification';
    }

    getTrimmedFolderPrefix() {
        if (!this.currentFolderPrefix) return '';
        const cleaned = this.currentFolderPrefix.replace(/\/+$/, '').split('/').filter(Boolean);
        if (cleaned.length === 0) return '';
        if (cleaned.length === 1) return cleaned[0];
        return cleaned.slice(1).join('/');
    }

    buildClassificationPath(subPath = '', { includePrefix = true } = {}) {
        const dirName = this.getClassificationDirName();
        const segments = [];

        const normalizePath = (value) => value
            .replace(/^\/+/, '')
            .replace(/\/+$/, '')
            .split('/')
            .filter(Boolean);

        // 🔥 Wafer 모드와 Chip 모드 모두 동일한 순서: {제품경로}/classification{_chips}/{클래스}
        // 🔥 오직 changeFolder에서 설정된 current_folder만 사용 (productFolderPath 사용 안 함)
        if (includePrefix) {
            // 🔥 currentFolderPrefix만 사용 (changeFolder에서 설정됨)
            if (this.currentFolderPrefix) {
                const prefixParts = normalizePath(this.currentFolderPrefix);
                if (prefixParts.length) {
                    segments.push(...prefixParts);
                }
            }
        }

        segments.push(dirName);

        if (subPath) {
            const subPathParts = normalizePath(subPath);
            if (subPathParts.length) {
                segments.push(...subPathParts);
            }
        }

        return segments.filter(Boolean).join('/');
    }

    getSelectedChipCount() {
        return this.chipAnnotator && this.chipAnnotator.selectedChips
            ? this.chipAnnotator.selectedChips.size
            : 0;
    }

    ensureChipSelectionForLabeling() {
        if (!this.chipAnnotator || !this.selectedImagePath) {
            alert('칩 라벨링을 하려면 단일 웨이퍼 이미지를 연 뒤 칩을 선택하세요.');
            return false;
        }
        const count = this.getSelectedChipCount();
        if (count === 0) {
            alert('Chip 모드에서는 칩을 선택한 후 라벨을 추가할 수 있습니다.');
            return false;
        }
        return true;
    }

    isClassificationEntry(name = '') {
        if (!name) return false;
        return this.getClassificationDirNames().some(dir =>
            name === dir || name.startsWith(`${dir}/`)
        );
    }

    isClassificationPath(path = '') {
        if (!path) return false;
        return this.getClassificationDirNames().some(dir =>
            path === dir ||
            path.startsWith(`${dir}/`) ||
            path.includes(`/${dir}/`)
        );
    }

    onPersonalColorButtonClick() {
        if (!this.colorEditor) {
            console.error('❌ colorEditor가 초기화되지 않았습니다.');
            this.showToast?.('색상 편집기를 초기화하지 못했습니다.', 1800);
            return;
        }
        this.colorEditor.open();
    }

    /**
     * URL에 personalized 파라미터 추가
     * @returns {string} URL 파라미터 (예: "&personalized=true&scheme=john")
     */
    getPersonalizedParams() {
        if (!this.personalizedColorEnabled) {
            console.log("PARAMS: personalizedColorEnabled=false, no scheme");
            return "";
        }
        
        // colorLegends가 로드되지 않았으면 빈 문자열 반환
        if (!this.colorLegends) {
            console.warn("PARAMS: colorLegends not loaded.");
            return "";
        }
        
        // 1. currentUser가 있고 해당 scheme이 존재하면 사용
        let scheme = this.currentUser || "change"; // fallback to "change"
        
        if (!this.colorLegends[scheme]) {
            console.warn(`PARAMS: Scheme '${scheme}' not found, falling back...`);
            // fallback 순서: change -> default -> 첫 번째 키
            if (this.colorLegends["change"]) {
                scheme = "change";
                console.log("PARAMS: Fallback to 'change'");
            } else if (this.colorLegends["default"]) {
                scheme = "default";
                console.log("PARAMS: Fallback to 'default'");
            } else {
                const keys = Object.keys(this.colorLegends);
                if (keys.length > 0) {
                    scheme = keys[0];
                    console.log(`PARAMS: Fallback to first key '${scheme}'`);
                } else {
                    scheme = "change";
                    console.warn("PARAMS: No schemes available, using 'change'");
                }
            }
        }
        
        // currentUser 로깅
        if (this.currentUser !== scheme) {
            console.log(`PARAMS: currentUser='${this.currentUser}' but using scheme='${scheme}'`);
        }
        
        let params = `&personalized=true&scheme=${encodeURIComponent(scheme)}`;
        
        // cacheBuster 추가
        if (this._personalizedColorCacheBuster) {
            params += `&_t=${this._personalizedColorCacheBuster}`;
        }
        
        // 디버그 로그 제거 (너무 자주 출력됨)
        // console.log(`PARAMS: Final params='${params}', scheme='${scheme}', currentUser='${this.currentUser}', enabled=${this.personalizedColorEnabled}`);
        return params;
    }

    /**
     * Initial application entry point.
     */

    async init() {
        this._drawScheduled = false; // draw() 스케줄링 플래그

        // ✅ 1단계: 서버 설정 로드 (병렬 가능)
        await this.loadServerConfig();
        
        // ✅ 2단계: 색상 정보 로드 (사용자 정보보다 먼저)
        await this.loadColorLegends();
        
        // ✅ 3단계: 사용자 정보 로드 (currentUser 설정)
        await this.loadUserInfo();
        
        // ✅ 4단계: 색상 렌더링 (모든 준비 완료 후)
        this.renderColorLegends();
        this.showColorLegends();

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
        try {
            await this.refreshLabelExplorer();
            // 🔥 추가: fail list 표시를 위해 updateLabelExplorerContent 호출
            this.updateLabelExplorerContent();
        } catch (err) {
            console.error('[INIT] Label Explorer 초기화 실패:', err);
        }
        
        // 나머지 작업들은 병렬로 실행하되 에러 발생 시에도 다른 작업은 계속 진행
        Promise.allSettled(initTasks);
        
        // 🔥 updateSubfolderList는 loadFolderBrowser 이후에 캐시가 설정되었으므로 백그라운드로 실행
        this.updateSubfolderList().catch(err => console.error('[INIT] Subfolder 업데이트 실패:', err));

        // 🔥 개인색 설정은 항상 활성화 (UI 체크박스 제거됨)
        this.personalizedColorEnabled = true;
        if (this.dom.personalizedColorCheckbox) {
            this.dom.personalizedColorCheckbox.checked = true;
            this.dom.personalizedColorCheckbox.style.display = 'none';
        }
        
        // ✅ renderColorLegends와 showColorLegends는 이미 위에서 호출됨 (4077-4078줄)
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
        // 디버그 로그 제거 (초기 로드 시에만 필요)
        // console.log("USER INFO: loadUserInfo called");
        // console.log("USER INFO: initialLoginIdFromUrl=", initialLoginIdFromUrl);
        // console.log("USER INFO: initialSamlSuccess=", initialSamlSuccess);
        // console.log("USER INFO: initialDevSuccess=", initialDevSuccess);
        
        try {
            const userInfoEl = document.getElementById("user-info");
            if (!userInfoEl) return;
            
            let displayed = false;
            
            // 1. SAML 로그인 성공
            if (initialSamlSuccess && initialLoginIdFromUrl && initialUsernameFromUrl) {
                const newInfo = `${initialLoginIdFromUrl}(${initialUsernameFromUrl})`;
                console.log("DEBUG: SAML login detected:", initialLoginIdFromUrl, initialUsernameFromUrl, initialDeptNameFromUrl, "currentHTML=", userInfoEl.innerHTML);
                
                // SAML 로그인 시 currentUser 설정
                this.currentUser = initialLoginIdFromUrl;
                this.username = initialUsernameFromUrl;
                this.deptName = initialDeptNameFromUrl;
                
                // colorLegends 확인
                if (!this.colorLegends) {
                    await this.loadColorLegends();
                }
                
                // 디버그 로그 제거
                // if (this.colorLegends && !this.colorLegends[this.currentUser]) {
                //     console.warn(`USER INFO: SAML - Scheme not found: '${this.currentUser}', will use fallback in renderColorLegends`);
                // } else if (this.colorLegends && this.colorLegends[this.currentUser]) {
                //     console.log(`USER INFO: SAML - Scheme found: '${this.currentUser}'`);
                // }
                
                if (!userInfoEl.innerHTML.includes(newInfo)) {
                    userInfoEl.innerHTML = `<div style="font-weight:600">${initialLoginIdFromUrl}(${initialUsernameFromUrl})</div><div style="font-size:10px;color:#666">${initialDeptNameFromUrl || 'Anonymous'}</div>`;
                }
                displayed = true;
            } 
            // 2. DEV 로그인 성공
            else if (initialDevSuccess && initialLoginIdFromUrl && initialUsernameFromUrl) {
                const newInfo = `${initialLoginIdFromUrl}(${initialUsernameFromUrl})`;
                
                // DEV 로그인 시 currentUser 설정
                this.currentUser = initialLoginIdFromUrl;
                this.username = initialUsernameFromUrl;
                this.deptName = initialDeptNameFromUrl;
                
                // colorLegends 확인
                if (!this.colorLegends) {
                    await this.loadColorLegends();
                }
                
                // 디버그 로그 제거
                // if (this.colorLegends && !this.colorLegends[this.currentUser]) {
                //     console.warn(`USER INFO: DEV - Scheme not found: '${this.currentUser}', will use fallback in renderColorLegends`);
                // } else if (this.colorLegends && this.colorLegends[this.currentUser]) {
                //     console.log(`USER INFO: DEV - Scheme found: '${this.currentUser}'`);
                // }
                
                if (!userInfoEl.innerHTML.includes(newInfo)) {
                    userInfoEl.innerHTML = `<div style="font-weight:600">${initialLoginIdFromUrl}(${initialUsernameFromUrl})</div><div style="font-size:10px;color:#666">${initialDeptNameFromUrl || 'Anonymous'}</div>`;
                }
                displayed = true;
            }
            
            // URL에서 파라미터 제거
            if (initialSamlSuccess || initialDevSuccess) {
                if (window.history?.replaceState) {
                    window.history.replaceState({}, "", window.location.pathname);
                }
            }
            
            // SAML/DEV로 표시됐으면 여기서 종료
            if (displayed) {
                // currentUser가 없으면 "change"로 설정
                this.currentUser = this.currentUser || "change";
                this.renderColorLegends(); // init에서도 호출됨
                return;
            }
            
            // 3. API로 사용자 정보 가져오기
            const apiUrl = initialLoginIdFromUrl 
                ? `/api/auth/user?LoginId=${encodeURIComponent(initialLoginIdFromUrl)}`
                : `/api/auth/user`;
            const response = await fetch(apiUrl);
            const data = await response.json();
            
            // colorScheme이 있으면 사용
            if (data.colorScheme) {
                this.currentUser = data.colorScheme;
            } else if (data.LoginId) {
                this.currentUser = data.LoginId;
            }
            // 디버그 로그 제거
            // console.log("USER INFO: API Response=", data);
            // console.log("USER INFO: API - currentUser set to", this.currentUser);
            
            if (data.authenticated && data.LoginId && data.Username) {
                const newInfo = `${data.LoginId}(${data.Username})`;
                if (!userInfoEl.innerHTML.includes(newInfo)) {
                    userInfoEl.innerHTML = `<div style="font-weight:600">${data.LoginId}(${data.Username})</div><div style="font-size:10px;color:#666">${data.DeptName || 'Anonymous'}</div>`;
                }
                this.username = data.Username;
                this.deptName = data.DeptName;
            }
            
        } catch (error) {
            console.error("DEBUG: loadUserInfo error", error);
        }
        
        // currentUser가 없으면 "change"로 설정
        this.currentUser = this.currentUser || "change";
        this.renderColorLegends(); // init에서도 호출됨
    }

    // 이미지 폴더 최상위로 리셋

    async resetToImageFolder() {
        const previousImagePath = this.selectedImagePath || null;
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
                    this.currentFolderPath = result.current_folder;
                    this.currentFolderPrefix = result.current_folder_prefix || '';
                    this.cachedClassList = null;
                    this.classListPromise = null;
                    if (this.classToImgListCache) {
                        this.classToImgListCache = {};
                    }
                if (previousImagePath) {
                    this.selectedImagePath = previousImagePath;
                }
                this.activeChipLabelClasses = null;
                let chipLegendReloaded = false;
                if (this.chipAnnotator) {
                    this.chipAnnotator.setLegendFilterClasses(null);
                    if (this.selectedImagePath) {
                        try {
                            await this.chipAnnotator.loadAnnotations(this.selectedImagePath);
                            chipLegendReloaded = true;
                        } catch (chipErr) {
                            console.warn('🔍 [RESET_ROOT] chip annotations 재로딩 실패:', chipErr);
                            this.chipAnnotator.markedChips = [];
                            this.chipAnnotator.render();
                        }
                    } else {
                        this.chipAnnotator.markedChips = [];
                        this.chipAnnotator.render();
                    }
                }
                if (!chipLegendReloaded) {
                    this.chipLabelLegendData = [];
                    this.updateChipLabelLegend([]);
                }
                if (this.selectedImagePath) {
                    this.showFileName(this.selectedImagePath);
                } else {
                    this.hideFileName();
                }
                this.renderColorLegends();
                this.showColorLegends();
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
            
            const sortedFiles = this.sortExplorerItems(files);

            // 제품 폴더 선택 시 label 캐시 초기화
            if (path) {
                this.clearParCache();
            }

            containerElement.innerHTML = this.createFileTreeHtml(sortedFiles, path || '');

            // classification 폴더 자동 확장 제거 (항상 닫힘)
        } catch (error) {
            containerElement.innerHTML = `<p style=\"color: #ff5555; padding: 10px;\">Error loading files.</p>`;

            console.error("[DEBUG] loadDirectoryContents error:", error);
        }
    }

    sortExplorerItems(items) {
        return [...(items || [])].sort((a, b) => {
            const isAFolder = a?.type === 'directory';
            const isBFolder = b?.type === 'directory';

            if (isAFolder && !isBFolder) return -1;
            if (!isAFolder && isBFolder) return 1;

            const nameA = a?.name || '';
            const nameB = b?.name || '';

            if (isAFolder && isBFolder) {
                // 폴더는 내림차순 (Z → A)
                return nameB.localeCompare(nameA, undefined, { numeric: true, sensitivity: 'base' });
            }

            // 파일은 오름차순 (A → Z)
            return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
        });
    }

    buildExplorerFullPath(folderPath, name) {
        const base = (folderPath || '').replace(/\\/g, '/').replace(/\/+$/g, '');
        return base ? `${base}/${name}` : name;
    }

    getParentExplorerPath(path) {
        if (path === null || path === undefined) return null;
        const normalized = (path || '').replace(/\\/g, '/').replace(/\/+$/g, '');
        if (!normalized) return null;
        const lastSlash = normalized.lastIndexOf('/');
        if (lastSlash === -1) return '';
        return normalized.slice(0, lastSlash);
    }

    async fetchExplorerEntries(folderPath) {
        const url = folderPath ? `/api/files?path=${encodeURIComponent(folderPath)}` : '/api/files';
        const data = await fetchJson(url, {
            signal: this.globalAbortController?.signal
        });

        const items = Array.isArray(data.items) ? data.items : [];
        const sorted = this.sortExplorerItems(items);
        const normalizedFolderPath = (folderPath || '').replace(/\\/g, '/').replace(/\/+$/g, '');

        const folders = [];
        const files = [];

        sorted.forEach(item => {
            if (!item || !item.name) return;
            const fullPath = item.path || this.buildExplorerFullPath(normalizedFolderPath, item.name);

            if (item.type === 'directory') {
                folders.push({ type: 'folder', name: item.name, path: fullPath });
            } else if (item.type === 'file' && this.isImageFile(item.name)) {
                files.push({ type: 'file', name: item.name, path: fullPath });
            }
        });

        return { folders, files };
    }

    async findFirstImageInExplorerFolder(folderPath) {
        const { folders, files } = await this.fetchExplorerEntries(folderPath);
        for (const folder of folders) {
            const imagePath = await this.findFirstImageInExplorerFolder(folder.path);
            if (imagePath) return imagePath;
        }
        if (files.length > 0) {
            return files[0].path;
        }
        return null;
    }

    async findLastImageInExplorerFolder(folderPath) {
        const { folders, files } = await this.fetchExplorerEntries(folderPath);
        for (let i = files.length - 1; i >= 0; i--) {
            const file = files[i];
            if (file?.path) return file.path;
        }
        for (let i = folders.length - 1; i >= 0; i--) {
            const folder = folders[i];
            const imagePath = await this.findLastImageInExplorerFolder(folder.path);
            if (imagePath) return imagePath;
        }
        return null;
    }

    async resolveExplorerEntryToImage(entry, direction) {
        if (!entry) return null;
        if (entry.type === 'file') {
            return entry.path;
        }
        if (entry.type === 'folder') {
            if (direction > 0) {
                return await this.findFirstImageInExplorerFolder(entry.path);
            }
            return await this.findLastImageInExplorerFolder(entry.path);
        }
        return null;
    }

    async findNextImageWithinFolder(folderPath, currentImagePath) {
        if (folderPath === null || folderPath === undefined) return null;
        const { files } = await this.fetchExplorerEntries(folderPath);
        if (!files || files.length === 0) return null;
        const normalizedTarget = this.normalizePath(currentImagePath);
        const index = files.findIndex(file => this.normalizePath(file.path) === normalizedTarget);
        if (index !== -1 && index + 1 < files.length) {
            return files[index + 1].path;
        }
        return null;
    }

    async findPreviousImageWithinFolder(folderPath, currentImagePath) {
        if (folderPath === null || folderPath === undefined) return null;
        const { files } = await this.fetchExplorerEntries(folderPath);
        if (!files || files.length === 0) return null;
        const normalizedTarget = this.normalizePath(currentImagePath);
        const index = files.findIndex(file => this.normalizePath(file.path) === normalizedTarget);
        if (index > 0) {
            return files[index - 1].path;
        }
        return null;
    }

    async findNextExplorerImagePath(currentPath) {
        if (!currentPath) return null;
        const normalized = currentPath.replace(/\\/g, '/').replace(/\/+$/g, '');
        const slashIndex = normalized.lastIndexOf('/');
        const folderPath = slashIndex === -1 ? '' : normalized.slice(0, slashIndex);

        const nextInFolder = await this.findNextImageWithinFolder(folderPath, normalized);
        if (nextInFolder) return nextInFolder;

        const parentPath = folderPath ? this.getParentExplorerPath(folderPath) : null;
        return await this.findNextImageFromParent(parentPath, folderPath);
    }

    async findPreviousExplorerImagePath(currentPath) {
        if (!currentPath) return null;
        const normalized = currentPath.replace(/\\/g, '/').replace(/\/+$/g, '');
        const slashIndex = normalized.lastIndexOf('/');
        const folderPath = slashIndex === -1 ? '' : normalized.slice(0, slashIndex);

        const prevInFolder = await this.findPreviousImageWithinFolder(folderPath, normalized);
        if (prevInFolder) return prevInFolder;

        const parentPath = folderPath ? this.getParentExplorerPath(folderPath) : null;
        return await this.findPreviousImageFromParent(parentPath, folderPath);
    }

    async findNextImageFromParent(parentPath, childEntryPath) {
        if (parentPath === null || parentPath === undefined) {
            return null;
        }

        const { folders, files } = await this.fetchExplorerEntries(parentPath);
        const entries = [...folders, ...files];
        if (entries.length === 0) {
            return null;
        }

        const normalizedChild = this.normalizePath(childEntryPath);
        let index = entries.findIndex(entry => this.normalizePath(entry.path) === normalizedChild);
        if (index === -1) {
            index = -1;
        }

        for (let i = index + 1; i < entries.length; i++) {
            const entry = entries[i];
            const imagePath = await this.resolveExplorerEntryToImage(entry, 1);
            if (imagePath) {
                return imagePath;
            }
        }

        const nextParent = this.getParentExplorerPath(parentPath);
        return await this.findNextImageFromParent(nextParent, parentPath);
    }

    async findPreviousImageFromParent(parentPath, childEntryPath) {
        if (parentPath === null || parentPath === undefined) {
            return null;
        }

        const { folders, files } = await this.fetchExplorerEntries(parentPath);
        const entries = [...folders, ...files];
        if (entries.length === 0) {
            return null;
        }

        const normalizedChild = this.normalizePath(childEntryPath);
        let index = entries.findIndex(entry => this.normalizePath(entry.path) === normalizedChild);
        if (index === -1) {
            index = entries.length;
        }

        for (let i = index - 1; i >= 0; i--) {
            const entry = entries[i];
            const imagePath = await this.resolveExplorerEntryToImage(entry, -1);
            if (imagePath) {
                return imagePath;
            }
        }

        const prevParent = this.getParentExplorerPath(parentPath);
        return await this.findPreviousImageFromParent(prevParent, parentPath);
    }

    async navigateToExplorerImage(targetPath, directionLabel = 'next') {
        if (!targetPath) return false;

        try {
            await this.loadFolderImageList(targetPath);
        } catch (error) {
            console.error('❌ [NAV_FOLDER] Failed to load folder list for path:', targetPath, error);
            return false;
        }

        this._imageLoadVersion += 1;
        const currentLoadVersion = this._imageLoadVersion;

        this.selectedImagePath = targetPath;
        this.showFileName(targetPath);
        this.selectedImages = [targetPath];
        this.updateWaferMapExplorerHighlight(targetPath);

        if (this.thumbnailNavigator && this.thumbnailNavigator.isVisible) {
            this.thumbnailNavigator.setImages(this.singleViewImageList, targetPath);
        }

        try {
            await this.loadImage(targetPath, false, currentLoadVersion);
            this.updatePyramidLevel();
            console.log(`✅ [NAV_FOLDER] Moved to ${directionLabel} entry:`, targetPath);
            return true;
        } catch (error) {
            console.error('❌ [NAV_FOLDER] Failed to load target image:', targetPath, error);
            return false;
        }
    }

    async ensureExplorerFolderOpen(folderPath) {
        if (!this.dom.fileExplorer || !folderPath) return;
        const normalized = folderPath.replace(/\\/g, '/').replace(/\/+$/g, '');
        if (!normalized) return;
        const escaped = (typeof CSS !== 'undefined' && CSS.escape) ? CSS.escape(normalized) : normalized.replace(/"/g, '\\"');
        const summary = this.dom.fileExplorer.querySelector(`summary.folder[data-path="${escaped}"]`);
        if (!summary) return;

        const details = summary.closest('details');
        if (!details) return;

        const contentDiv = summary.nextElementSibling;
        if (contentDiv && details.dataset.loaded !== 'true') {
            try {
                await this.loadDirectoryContents(normalized, contentDiv);
                details.dataset.loaded = 'true';
            } catch (error) {
                console.warn('⚠️ [EXPLORER] Failed to load folder contents for', normalized, error);
            }
        }

        details.open = true;
    }

    async ensureExplorerPathVisible(imagePath) {
        if (!this.dom.fileExplorer || !imagePath) return;
        const normalized = imagePath.replace(/\\/g, '/').replace(/\/+$/g, '');
        const slashIndex = normalized.lastIndexOf('/');
        if (slashIndex === -1) return;

        const folderPath = normalized.slice(0, slashIndex);
        if (!folderPath) return;

        const segments = folderPath.split('/').filter(Boolean);
        let currentPath = '';
        for (const segment of segments) {
            currentPath = currentPath ? `${currentPath}/${segment}` : segment;
            await this.ensureExplorerFolderOpen(currentPath);
        }
    }

    applyWaferMapExplorerHighlight(imagePath) {
        if (!this.dom.fileExplorer || !imagePath) return;

        const allLinks = Array.from(this.dom.fileExplorer.querySelectorAll('a[data-path]'));
        const normalizedTarget = this.normalizePath(imagePath);

        let targetLink = allLinks.find(link => {
            const linkPath = link.dataset.path;
            return linkPath && this.normalizePath(linkPath) === normalizedTarget;
        });

        if (!targetLink) {
            targetLink = allLinks.find(link => {
                const linkNorm = this.normalizePath(link.dataset.path || '');
                return linkNorm.endsWith(normalizedTarget) || normalizedTarget.endsWith(linkNorm);
            });
        }

        if (targetLink) {
            const parentDetails = targetLink.closest('details');
            if (parentDetails && !parentDetails.open) {
                parentDetails.open = true;
            }

            allLinks.forEach(link => {
                link.classList.remove('selected');
                link.style.removeProperty('background');
            });

            targetLink.classList.add('selected');
            targetLink.style.background = '#05b';
            targetLink.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }

    async findFirstImageInExplorerFolder(folderPath) {
        const { folders, files } = await this.fetchExplorerEntries(folderPath);
        for (const folder of folders) {
            const imagePath = await this.findFirstImageInExplorerFolder(folder.path);
            if (imagePath) return imagePath;
        }
        if (files.length > 0) {
            return files[0].path;
        }
        return null;
    }

    async findLastImageInExplorerFolder(folderPath) {
        const { folders, files } = await this.fetchExplorerEntries(folderPath);
        for (let i = files.length - 1; i >= 0; i--) {
            const file = files[i];
            if (file?.path) return file.path;
        }
        for (let i = folders.length - 1; i >= 0; i--) {
            const folder = folders[i];
            const imagePath = await this.findLastImageInExplorerFolder(folder.path);
            if (imagePath) return imagePath;
        }
        return null;
    }

    async resolveExplorerEntryToImage(entry, direction) {
        if (!entry) return null;
        if (entry.type === 'file') {
            return entry.path;
        }
        if (entry.type === 'folder') {
            if (direction > 0) {
                return await this.findFirstImageInExplorerFolder(entry.path);
            }
            return await this.findLastImageInExplorerFolder(entry.path);
        }
        return null;
    }

    async findNextImageWithinFolder(folderPath, currentImagePath) {
        if (folderPath === null || folderPath === undefined) return null;
        const { files } = await this.fetchExplorerEntries(folderPath);
        if (!files || files.length === 0) return null;
        const normalizedTarget = this.normalizePath(currentImagePath);
        const index = files.findIndex(file => this.normalizePath(file.path) === normalizedTarget);
        if (index !== -1 && index + 1 < files.length) {
            return files[index + 1].path;
        }
        return null;
    }

    async findPreviousImageWithinFolder(folderPath, currentImagePath) {
        if (folderPath === null || folderPath === undefined) return null;
        const { files } = await this.fetchExplorerEntries(folderPath);
        if (!files || files.length === 0) return null;
        const normalizedTarget = this.normalizePath(currentImagePath);
        const index = files.findIndex(file => this.normalizePath(file.path) === normalizedTarget);
        if (index > 0) {
            return files[index - 1].path;
        }
        return null;
    }

    async findNextExplorerImagePath(currentPath) {
        if (!currentPath) return null;
        const normalized = currentPath.replace(/\\/g, '/').replace(/\/+$/g, '');
        const slashIndex = normalized.lastIndexOf('/');
        const folderPath = slashIndex === -1 ? '' : normalized.slice(0, slashIndex);

        const nextInFolder = await this.findNextImageWithinFolder(folderPath, normalized);
        if (nextInFolder) return nextInFolder;

        const parentPath = folderPath ? this.getParentExplorerPath(folderPath) : null;
        return await this.findNextImageFromParent(parentPath, folderPath);
    }

    async findPreviousExplorerImagePath(currentPath) {
        if (!currentPath) return null;
        const normalized = currentPath.replace(/\\/g, '/').replace(/\/+$/g, '');
        const slashIndex = normalized.lastIndexOf('/');
        const folderPath = slashIndex === -1 ? '' : normalized.slice(0, slashIndex);

        const prevInFolder = await this.findPreviousImageWithinFolder(folderPath, normalized);
        if (prevInFolder) return prevInFolder;

        const parentPath = folderPath ? this.getParentExplorerPath(folderPath) : null;
        return await this.findPreviousImageFromParent(parentPath, folderPath);
    }

    async findNextImageFromParent(parentPath, childEntryPath) {
        if (parentPath === null || parentPath === undefined) {
            return null;
        }

        const { folders, files } = await this.fetchExplorerEntries(parentPath);
        const entries = [...folders, ...files];
        if (entries.length === 0) {
            return null;
        }

        const normalizedChild = this.normalizePath(childEntryPath);
        let index = entries.findIndex(entry => this.normalizePath(entry.path) === normalizedChild);
        if (index === -1) {
            index = -1;
        }

        for (let i = index + 1; i < entries.length; i++) {
            const entry = entries[i];
            const imagePath = await this.resolveExplorerEntryToImage(entry, 1);
            if (imagePath) {
                return imagePath;
            }
        }

        const nextParent = this.getParentExplorerPath(parentPath);
        return await this.findNextImageFromParent(nextParent, parentPath);
    }

    async findPreviousImageFromParent(parentPath, childEntryPath) {
        if (parentPath === null || parentPath === undefined) {
            return null;
        }

        const { folders, files } = await this.fetchExplorerEntries(parentPath);
        const entries = [...folders, ...files];
        if (entries.length === 0) {
            return null;
        }

        const normalizedChild = this.normalizePath(childEntryPath);
        let index = entries.findIndex(entry => this.normalizePath(entry.path) === normalizedChild);
        if (index === -1) {
            index = entries.length;
        }

        for (let i = index - 1; i >= 0; i--) {
            const entry = entries[i];
            const imagePath = await this.resolveExplorerEntryToImage(entry, -1);
            if (imagePath) {
                return imagePath;
            }
        }

        const prevParent = this.getParentExplorerPath(parentPath);
        return await this.findPreviousImageFromParent(prevParent, parentPath);
    }

    processPendingNavigationQueue() {
        if (this._pendingNavDirection) {
            const pending = this._pendingNavDirection;
            this._pendingNavDirection = 0;
            setTimeout(() => this.navigateSingleImageMode(pending), 10);
        }
    }

    createFileTreeHtml(nodes, parentPath) {
        nodes = Array.isArray(nodes) ? nodes : [];

        let html = '<ul>';

        for (const node of nodes) {
            // 🔥 classification, classification_chips, thumbnails 폴더 제외
            if (node.type === 'directory' && (
                this.isClassificationEntry(node.name) ||
                node.name === 'thumbnails' ||
                node.name === 'labels'
            )) {
                continue;
            }

            // 🔥 ROOT_DIR 기준 절대 경로 사용 (모든 depth 지원)
            const fullPath = node.root_relative || (parentPath ? `${parentPath}/${node.name}` : node.name);

            if (node.type === 'directory') {
                html += `<li><details><summary data-path="${fullPath}" class="folder">📁 ${node.name}</summary><div class="folder-content" style="padding-left: 0.5rem;"></div></details></li>`;
            } else if (node.type === 'file') {
                // 필터 적용
                if (this.filterTestMode && this.filterTestMode !== 'all') {
                    const fileName = node.name;
                    if (fileName.length > 7) {
                        const seventhChar = fileName.charAt(6);
                        const eighthChar = fileName.charAt(7);
                        const hasUnderscore = seventhChar === '_' || eighthChar === '_';

                        if (this.filterTestMode === 'remove') {
                            // Test 제거: 둘 다 _가 아니면 제외 (하나라도 _면 남김)
                            if (!hasUnderscore) {
                                continue;
                            }
                        } else if (this.filterTestMode === 'only') {
                            // Test 만: 하나라도 _가 있으면 제외 (둘 다 _가 아니어야 남김)
                            if (hasUnderscore) {
                                continue;
                            }
                        }
                    }
                }

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

            // 이미지 파일만 필터링하고 test 필터 적용
            const imageFiles = allFiles.filter(path => {
                if (!this.isImageFile(path)) return false;

                // Test 필터 적용
                if (this.filterTestMode && this.filterTestMode !== 'all') {
                    const fileName = path.split('/').pop() || path.split('\\').pop() || path;
                    if (fileName.length > 7) {
                        const seventhChar = fileName.charAt(6);
                        const eighthChar = fileName.charAt(7);
                        const hasUnderscore = seventhChar === '_' || eighthChar === '_';

                        if (this.filterTestMode === 'remove') {
                            // Test 제거: 둘 다 _가 아니면 제외
                            if (!hasUnderscore) {
                                return false;
                            }
                        } else if (this.filterTestMode === 'only') {
                            // Test 만: 하나라도 _가 있으면 제외
                            if (hasUnderscore) {
                                return false;
                            }
                        }
                    }
                }

                return true;
            });

            this.selectedImages = Array.from(new Set([...this.selectedImages, ...imageFiles]));

            this.debugLog(`폴더 ${folderPath}에서 ${imageFiles.length}개 이미지 선택됨`);
            
            // ✅ 그리드 진입 전 패널 닫기
            if (imageFiles.length > 1) {
                this.closeChipSelectionPanel();
            }
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

            // 해당 폴더의 파일들을 선택에서 제거 (test 필터 적용)
            const imageFiles = allFiles.filter(path => {
                if (!this.isImageFile(path)) return false;

                // Test 필터 적용
                if (this.filterTestMode && this.filterTestMode !== 'all') {
                    const fileName = path.split('/').pop() || path.split('\\').pop() || path;
                    if (fileName.length > 7) {
                        const seventhChar = fileName.charAt(6);
                        const eighthChar = fileName.charAt(7);
                        const hasUnderscore = seventhChar === '_' || eighthChar === '_';

                        if (this.filterTestMode === 'remove') {
                            // Test 제거: 둘 다 _가 아니면 제외
                            if (!hasUnderscore) {
                                return false;
                            }
                        } else if (this.filterTestMode === 'only') {
                            // Test 만: 하나라도 _가 있으면 제외
                            if (hasUnderscore) {
                                return false;
                            }
                        }
                    }
                }

                return true;
            });

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

    isMultiSearchModalOpen() {
        return !!this.isMultiSearchOpen;
    }

    setMultiSearchError(message = '') {
        if (this.dom?.multiSearchError) {
            this.dom.multiSearchError.textContent = message;
        }
    }

    openMultiSearchModal() {
        if (!this.dom?.multiSearchModal) return;
        this.dom.multiSearchModal.style.display = 'flex';
        if (this.dom.multiSearchInput) {
            if (!this.dom.multiSearchInput.value) {
                this.dom.multiSearchInput.value = '';
            }
            // 🔥 엑셀 셀 스타일이므로 그리드 라인 설정 불필요 (제거)
            setTimeout(() => this.dom.multiSearchInput?.focus(), 0);
        }
        this.setMultiSearchError('');
        this.isMultiSearchOpen = true;
        
        // 모달이 열려있을 때 ESC 키로 닫기 (전역 핸들러)
        this.multiSearchModalEscapeHandler = (e) => {
            if (e.key === 'Escape' && this.isMultiSearchOpen) {
                e.preventDefault();
                e.stopPropagation();
                this.closeMultiSearchModal();
            }
        };
        document.addEventListener('keydown', this.multiSearchModalEscapeHandler, true);
    }

    setupCharacterGrid(textarea) {
        if (!textarea) return;
        
        // 캔버스를 사용하여 실제 문자 폭 측정
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const computedStyle = window.getComputedStyle(textarea);
        
        // textarea의 폰트 스타일 적용
        ctx.font = `${computedStyle.fontSize} ${computedStyle.fontFamily}`;
        
        // 문자 'M'의 폭 측정 (monospace이므로 모든 문자가 동일한 폭)
        const charWidth = ctx.measureText('M').width;
        
        // CSS 변수로 문자 폭 설정
        textarea.style.setProperty('--char-width', `${charWidth}px`);
        
        // padding-left를 고려한 시작 위치 설정
        const paddingLeft = parseFloat(computedStyle.paddingLeft) || 14;
        textarea.style.setProperty('--grid-offset', `${paddingLeft}px`);
    }

    closeMultiSearchModal(clearText = false) {
        if (!this.dom?.multiSearchModal) return;
        this.dom.multiSearchModal.style.display = 'none';
        this.setMultiSearchError('');
        this.isMultiSearchOpen = false;
        
        // 🔥 검색 성공 시 텍스트 초기화
        if (clearText && this.dom.multiSearchInput) {
            this.dom.multiSearchInput.value = '';
        }
        
        // 전역 ESC 키 핸들러 제거
        if (this.multiSearchModalEscapeHandler) {
            document.removeEventListener('keydown', this.multiSearchModalEscapeHandler, true);
            this.multiSearchModalEscapeHandler = null;
        }
    }

    parseMultiSearchInput() {
        if (!this.dom?.multiSearchInput) {
            return { lots: [], error: 'LOT 입력 영역을 찾을 수 없습니다.' };
        }
        const raw = this.dom.multiSearchInput.value || '';
        const segments = raw.split(/[\n\r,;\t/]+/);
        const seen = new Set();
        const lots = [];
        const MAX = 100;
        for (const segment of segments) {
            const trimmed = segment.trim();
            if (!trimmed) continue;
            const key = trimmed.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            if (lots.length >= MAX) {
                return { lots: [], error: `LOT는 최대 ${MAX}개까지 입력할 수 있습니다. (현재 ${seen.size}개)` };
            }
            lots.push(trimmed);
        }
        if (!lots.length) {
            return { lots: [], error: 'LOT ID를 한 개 이상 입력하세요.' };
        }
        return { lots };
    }

    async handleMultiSearchApply() {
        const parsed = this.parseMultiSearchInput();
        if (parsed.error) {
            this.setMultiSearchError(parsed.error);
            return;
        }
        const lotList = parsed.lots;
        this.setMultiSearchError('');
        try {
            await this.performSearch({ multiLotList: [...lotList] });
            // 🔥 검색 성공 시 텍스트 초기화
            this.closeMultiSearchModal(true);
        } catch (error) {
            console.error('다중 LOT 검색 실패:', error);
            this.setMultiSearchError('검색 중 오류가 발생했습니다.');
        }
    }

    async openPermissionEditorModal() {
        if (!this.dom.permissionModal) return;
        this.permissionFilterRole = 'ALL'; // 초기값: ALL
        this.updatePermissionRoleFilters();
        await this.reloadPermissionUsers();
        this.dom.permissionModal.style.display = 'flex';
    }

    closePermissionEditorModal() {
        if (this.dom.permissionModal) {
            this.dom.permissionModal.style.display = 'none';
        }
        this.permissionSelectedUser = null;
        this.hidePermissionSearchResults();
        // 테이블 초기화 (첫 번째 행만 남기고 빈 상태로)
        if (this.dom.permissionRegistrationTbody) {
            const rows = this.dom.permissionRegistrationTbody.querySelectorAll('.permission-registration-row');
            rows.forEach((row, index) => {
                if (index > 0) row.remove();
                else {
                    row.querySelectorAll('.permission-table-input').forEach(input => {
                        input.value = '';
                    });
                    const roleInput = row.querySelector('.permission-role-input');
                    if (roleInput) roleInput.value = 'ROLE_POWER';
                    const folderInput = row.querySelector('.permission-folder-input');
                    if (folderInput) {
                        folderInput.value = '';
                        folderInput.disabled = false;
                        folderInput.style.backgroundColor = '';
                        folderInput.style.color = '';
                    }
                }
            });
        }
    }

    setPermissionFilterRole(role) {
        this.permissionFilterRole = role;
        this.updatePermissionRoleFilters();
        this.renderPermissionUserList();
    }

    updatePermissionRoleFilters() {
        const filterBtns = document.querySelectorAll('.permission-role-filter-btn');
        filterBtns.forEach(btn => {
            if (btn.dataset.role === this.permissionFilterRole) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });
    }

    async reloadPermissionUsers() {
        try {
            const res = await fetch('/api/roles/users');
            if (!res.ok) {
                throw new Error(await res.text());
            }
            const data = await res.json();
            this.permissionUsers = Array.isArray(data.users) ? [...data.users] : [];
            this.permissionUsers.sort((a, b) => {
                const nameA = ((a.username || '') + a.loginId).toLowerCase();
                const nameB = ((b.username || '') + b.loginId).toLowerCase();
                if (nameA < nameB) return -1;
                if (nameA > nameB) return 1;
                return 0;
            });
            this.renderPermissionUserList();
        } catch (error) {
            console.error('권한 목록 조회 실패:', error);
            this.showToast?.('권한 목록을 불러올 수 없습니다.', 2000);
        }
    }

    async ensureStatsUsersLoaded() {
        if (Array.isArray(this.permissionStatsUsers)) {
            return;
        }
        try {
            const res = await fetch('/api/stats/users');
            if (!res.ok) {
                throw new Error(await res.text());
            }
            const data = await res.json();
            const statsUsers = Array.isArray(data.users) ? data.users : [];
            this.permissionStatsUsers = statsUsers
                .map((user) => {
                    const profile = user.profile || {};
                    const loginId = profile.LoginId || profile.loginId || '';
                    const username = profile.Username || profile.username || '';
                    const dept = profile.DeptName || profile.deptName || '';
                    if (!loginId) return null;
                    return {
                        loginId,
                        username,
                        deptName: dept,
                        profile
                    };
                })
                .filter(Boolean);
        } catch (error) {
            console.error('stats 사용자 목록 조회 실패:', error);
            this.permissionStatsUsers = [];
            throw error;
        }
    }

    async handlePermissionSearch() {
        if (!this.dom.permissionSearchResults) return;
        const keywordRaw = this.dom.permissionSearchInput?.value?.trim() || '';
        const keyword = keywordRaw.toLowerCase();
        
        if (!keyword) {
            this.hidePermissionSearchResults();
            return;
        }
        
        try {
            await this.ensureStatsUsersLoaded();
        } catch {
            this.dom.permissionSearchResults.innerHTML = '<div style="padding:8px; color:#ff7b7b;">stats 정보를 불러올 수 없습니다.</div>';
            this.dom.permissionSearchResults.classList.add('is-open');
            return;
        }
        
        const entries = (this.permissionStatsUsers || []).filter((entry) => {
            const nameMatch = (entry.username || '').toLowerCase().includes(keyword);
            const idMatch = (entry.loginId || '').toLowerCase().includes(keyword);
            return nameMatch || idMatch;
        }).slice(0, 10);
        
        if (!entries.length) {
            this.dom.permissionSearchResults.innerHTML = '<div style="padding:8px; color:#9aa0a6;">검색 결과가 없습니다.</div>';
            this.dom.permissionSearchResults.classList.add('is-open');
            this.permissionSearchSelectedIndex = -1;
            return;
        }
        
        this.dom.permissionSearchResults.innerHTML = entries.map((entry, index) => `
            <div class="permission-search-row" data-login-id="${entry.loginId}" data-index="${index}">
                <div>
                    <div style="font-weight:600;">${entry.username || '(이름없음)'} <span style="color:#9aa0a6;">(${entry.loginId})</span></div>
                    <div style="color:#9aa0a6;">${entry.deptName || ''}</div>
                </div>
            </div>
        `).join('');
        
        // 클릭 이벤트
        this.dom.permissionSearchResults.querySelectorAll('.permission-search-row').forEach((row, index) => {
            row.addEventListener('click', () => {
                const loginId = row.dataset.loginId;
                const match = entries.find(item => item.loginId === loginId);
                if (match) {
                    this.applyStatsUserToTable(match);
                }
            });
            row.addEventListener('mouseenter', () => {
                this.permissionSearchSelectedIndex = index;
                this.updatePermissionSearchSelection();
            });
        });
        
        this.dom.permissionSearchResults.classList.add('is-open');
        this.permissionSearchSelectedIndex = 0;
        this.updatePermissionSearchSelection();
    }

    navigateSearchResults(direction) {
        if (!this.dom.permissionSearchResults || !this.dom.permissionSearchResults.classList.contains('is-open')) {
            return;
        }
        const rows = Array.from(this.dom.permissionSearchResults.querySelectorAll('.permission-search-row'));
        if (rows.length === 0) return;
        
        this.permissionSearchSelectedIndex += direction;
        if (this.permissionSearchSelectedIndex < 0) this.permissionSearchSelectedIndex = 0;
        if (this.permissionSearchSelectedIndex >= rows.length) this.permissionSearchSelectedIndex = rows.length - 1;
        
        this.updatePermissionSearchSelection();
        
        // 선택된 행으로 스크롤
        const selectedRow = rows[this.permissionSearchSelectedIndex];
        if (selectedRow) {
            selectedRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    updatePermissionSearchSelection() {
        if (!this.dom.permissionSearchResults) return;
        const rows = Array.from(this.dom.permissionSearchResults.querySelectorAll('.permission-search-row'));
        rows.forEach((row, index) => {
            if (index === this.permissionSearchSelectedIndex) {
                row.style.backgroundColor = 'rgba(0, 123, 204, 0.3)';
            } else {
                row.style.backgroundColor = '';
            }
        });
    }

    hidePermissionSearchResults() {
        if (this.dom.permissionSearchResults) {
            this.dom.permissionSearchResults.classList.remove('is-open');
            this.permissionSearchSelectedIndex = -1;
        }
    }

    applyStatsUserToTable(entry) {
        // 첫 번째 빈 행에 적용하거나 새 행 추가
        const tbody = this.dom.permissionRegistrationTbody;
        if (!tbody) return;
        
        let targetRow = null;
        const rows = tbody.querySelectorAll('.permission-registration-row');
        
        // 빈 행 찾기
        for (const row of rows) {
            const loginIdInput = row.querySelector('[data-field="loginId"]');
            if (loginIdInput && !loginIdInput.value.trim()) {
                targetRow = row;
                break;
            }
        }
        
        // 빈 행이 없으면 새 행 추가
        if (!targetRow) {
            this.addPermissionTableRow();
            const newRows = tbody.querySelectorAll('.permission-registration-row');
            targetRow = newRows[newRows.length - 1];
        }
        
        // 값 채우기
        const loginIdInput = targetRow.querySelector('[data-field="loginId"]');
        const usernameInput = targetRow.querySelector('[data-field="username"]');
        const deptNameInput = targetRow.querySelector('[data-field="deptName"]');
        const roleInput = targetRow.querySelector('[data-field="role"]');
        const folderInput = targetRow.querySelector('[data-field="folders"]');
        
        if (loginIdInput) loginIdInput.value = entry.loginId || '';
        if (usernameInput) usernameInput.value = entry.username || '';
        if (deptNameInput) deptNameInput.value = entry.deptName || '';
        if (roleInput) {
            roleInput.value = 'ROLE_POWER';
            // 등급 변경 시 폴더 입력 상태 업데이트
            this.updatePermissionFolderInputState(targetRow, 'ROLE_POWER');
        }
        if (folderInput && !folderInput.disabled) {
            folderInput.value = '*';
        }
        
        this.hidePermissionSearchResults();
        if (this.dom.permissionSearchInput) {
            this.dom.permissionSearchInput.value = '';
        }
    }

    renderPermissionUserList() {
        if (!this.dom.permissionUserList) return;
        const container = this.dom.permissionUserList;
        container.innerHTML = '';
        
        // 역할 필터링
        let filteredUsers = this.permissionUsers;
        if (this.permissionFilterRole !== 'ALL') {
            filteredUsers = this.permissionUsers.filter(user => user.role === this.permissionFilterRole);
        }
        
        if (!Array.isArray(filteredUsers) || filteredUsers.length === 0) {
            container.innerHTML = '<div style="padding:12px; color:#999;">등록된 사용자가 없습니다.</div>';
            return;
        }
        
        filteredUsers.forEach((user) => {
            const row = document.createElement('div');
            row.className = 'permission-user-row';
            row.dataset.loginId = user.loginId;
            const folders = Array.isArray(user.folders) ? user.folders.map(f => f.path).join(', ') : '';
            row.innerHTML = `
                <div>
                    <div style="font-weight:600;">${user.username || '(이름없음)'} <span style="color:#9aa0a6;">(${user.loginId || ''})</span></div>
                    <div style="font-size:12px; color:#9aa0a6;">
                        ${user.deptName || ''} · ${user.role || 'ROLE_USER'}${folders ? ' · ' + folders : ''}
                    </div>
                </div>
            `;
            row.onclick = () => this.selectPermissionUser(user.loginId);
            if (this.permissionSelectedUser && this.permissionSelectedUser.loginId === user.loginId) {
                row.classList.add('is-active');
            }
            container.appendChild(row);
        });
    }

    selectPermissionUser(loginId) {
        const user = this.permissionUsers.find((u) => u.loginId === loginId);
        if (!user) {
            this.permissionSelectedUser = null;
            this.renderPermissionUserList();
            return;
        }
        this.permissionSelectedUser = user;
        this.renderPermissionUserList();
    }

    addPermissionTableRow() {
        const tbody = this.dom.permissionRegistrationTbody;
        if (!tbody) return;
        
        const newRow = document.createElement('tr');
        newRow.className = 'permission-registration-row';
        newRow.innerHTML = `
            <td><input type="text" class="permission-table-input" data-field="loginId" placeholder=""></td>
            <td><input type="text" class="permission-table-input" data-field="username" placeholder=""></td>
            <td><input type="text" class="permission-table-input" data-field="deptName" placeholder=""></td>
            <td>
                <div class="permission-role-input-wrapper">
                    <input type="text" class="permission-table-input permission-role-input" data-field="role" placeholder="POWER" list="permission-role-list">
                    <button type="button" class="permission-role-dropdown-btn" data-role="ROLE_POWER">POWER</button>
                    <button type="button" class="permission-role-dropdown-btn" data-role="ROLE_ADMIN">ADMIN</button>
                    <button type="button" class="permission-role-dropdown-btn" data-role="ROLE_SUPER">SUPER</button>
                </div>
            </td>
            <td><input type="text" class="permission-table-input permission-folder-input" data-field="folders" placeholder="ASDF,XYZ 또는 *" style="font-family: monospace;"></td>
        `;
        
        // 등급 입력 변경 시 폴더 입력 상태 업데이트
        const roleInput = newRow.querySelector('.permission-role-input');
        if (roleInput) {
            roleInput.addEventListener('input', (e) => {
                this.updatePermissionFolderInputState(newRow, e.target.value);
            });
        }
        
        tbody.appendChild(newRow);
    }

    updatePermissionFolderInputState(row, role) {
        const folderInput = row.querySelector('.permission-folder-input');
        if (!folderInput) return;
        
        // ADMIN/SUPER 선택 시 폴더 입력 비활성화 및 *로 설정
        if (role === 'ROLE_ADMIN' || role === 'ROLE_SUPER') {
            folderInput.disabled = true;
            folderInput.value = '*';
            folderInput.style.backgroundColor = '#1a1a1a';
            folderInput.style.color = '#666';
        } else {
            folderInput.disabled = false;
            if (folderInput.value === '*') {
                folderInput.value = '';
            }
            folderInput.style.backgroundColor = '';
            folderInput.style.color = '';
        }
    }

    async handlePermissionBatchSave() {
        const tbody = this.dom.permissionRegistrationTbody;
        if (!tbody) return;
        
        const rows = tbody.querySelectorAll('.permission-registration-row');
        const usersToSave = [];
        const errors = [];
        
        for (const row of rows) {
            const loginIdInput = row.querySelector('[data-field="loginId"]');
            const usernameInput = row.querySelector('[data-field="username"]');
            const deptNameInput = row.querySelector('[data-field="deptName"]');
            const roleInput = row.querySelector('[data-field="role"]');
            const foldersInput = row.querySelector('[data-field="folders"]');
            
            const loginId = loginIdInput?.value.trim();
            if (!loginId) continue; // LoginId가 없으면 건너뛰기 (빈 행)
            
            const username = usernameInput?.value.trim() || '';
            const deptName = deptNameInput?.value.trim() || '';
            const role = roleInput?.value.trim() || 'ROLE_POWER';
            const foldersValue = foldersInput?.value.trim() || '*';
            
            // 제품 폴더 권한 처리 (2depth: API에서 positions/ASDF로 처리)
            let folders = [];
            if (role === 'ROLE_ADMIN' || role === 'ROLE_SUPER') {
                // ADMIN/SUPER는 API에서 자동으로 *로 처리
                folders = [{ path: '*', allow_label: true, allow_class: true }];
            } else if (foldersValue === '*') {
                folders = [{ path: '*', allow_label: true, allow_class: true }];
            } else {
                // 쉼표로 구분된 폴더 목록 (API에서 2depth 처리)
                // 공백 무시: 모든 공백 제거 후 쉼표로 분리
                const cleanedValue = foldersValue.replace(/\s+/g, ''); // 모든 공백 제거
                const folderList = cleanedValue.split(',').filter(f => f); // 빈 문자열 제거
                folders = folderList.map(folder => {
                    // API에서 positions/ prefix를 추가하므로 입력값 그대로 전송
                    // 단, 이미 /가 포함되어 있으면 그대로 사용
                    return {
                        path: folder,
                        allow_label: true,
                        allow_class: true
                    };
                });
                if (folders.length === 0) {
                    folders = [{ path: '*', allow_label: true, allow_class: true }];
                }
            }
            
            usersToSave.push({
                loginId,
                username,
                deptName,
                role,
                folders
            });
        }
        
        if (usersToSave.length === 0) {
            alert('저장할 사용자가 없습니다. LoginId를 입력하세요.');
            return;
        }
        
        try {
            // 배치 저장 (각 사용자별로 API 호출)
            const savePromises = usersToSave.map(user => 
                fetch('/api/roles/users', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(user)
                }).then(async res => {
                    if (!res.ok) {
                        const errorText = await res.text();
                        throw new Error(`${user.loginId}: ${errorText}`);
                    }
                    return res.json();
                })
            );
            
            await Promise.all(savePromises);
            await this.reloadPermissionUsers();
            this.showToast?.(`${usersToSave.length}명의 사용자 권한이 저장되었습니다.`, 2000);
            
            // 테이블 초기화 (첫 번째 행만 남기고 빈 상태로)
            rows.forEach((row, index) => {
                if (index > 0) row.remove();
                else {
                    row.querySelectorAll('.permission-table-input').forEach(input => {
                        input.value = '';
                    });
                    const roleInput = row.querySelector('.permission-role-input');
                    if (roleInput) roleInput.value = 'ROLE_POWER';
                    const folderInput = row.querySelector('.permission-folder-input');
                    if (folderInput) {
                        folderInput.value = '';
                        folderInput.disabled = false;
                        folderInput.style.backgroundColor = '';
                        folderInput.style.color = '';
                    }
                }
            });
        } catch (error) {
            console.error('권한 저장 실패:', error);
            alert(error.message || '권한을 저장할 수 없습니다.');
        }
    }

    async handlePermissionDelete() {
        if (!this.permissionSelectedUser || !this.permissionSelectedUser.loginId) {
            alert('삭제할 사용자를 선택하세요.');
            return;
        }
        const loginId = this.permissionSelectedUser.loginId;
        if (!confirm(`${loginId} 사용자를 삭제하시겠습니까?`)) {
            return;
        }
        try {
            const res = await fetch(`/api/roles/users/${encodeURIComponent(loginId)}`, {
                method: 'DELETE'
            });
            if (!res.ok) {
                throw new Error(await res.text());
            }
            await this.reloadPermissionUsers();
            this.permissionSelectedUser = null;
            this.renderPermissionUserList();
            this.showToast?.('삭제되었습니다.', 1600);
        } catch (error) {
            console.error('권한 삭제 실패:', error);
            alert(error.message || '삭제할 수 없습니다.');
        }
    }

    updateContextMenuState() {
        const createItem = document.getElementById('context-composite-create');
        const returnItem = document.getElementById('context-composite-return');
        if (!createItem || !returnItem) {
            console.warn('⚠️ 컨텍스트 메뉴 항목을 찾을 수 없습니다.');
            return;
        }
        if (this.isCompositeMode) {
            console.log('🔄 [CONTEXT_MENU] Composite Mode 활성화 - "이전 그리드로 돌아가기" 표시');
            // 🔥 강제로 display 속성 설정 (다른 스타일 오버라이드 방지)
            createItem.style.setProperty('display', 'none', 'important');
            returnItem.style.setProperty('display', 'block', 'important');
        } else {
            console.log('🔄 [CONTEXT_MENU] 일반 모드 - "Composite Map 만들기" 표시');
            // 🔥 강제로 display 속성 설정 (다른 스타일 오버라이드 방지)
            createItem.style.setProperty('display', 'block', 'important');
            returnItem.style.setProperty('display', 'none', 'important');
        }
    }

    /**
     * 현재 Grid 세션을 저장 (Composite Map으로 전환 전)
     */
    saveCurrentGridSession() {
        const grid = document.getElementById('image-grid');
        const scrollWrapper = grid?.parentElement;  // .grid-scroll-wrapper

        const session = {
            type: 'normal-grid',
            images: [...(this.currentGridImages || this.selectedImages || [])],
            selectedImages: [...(this.selectedImages || [])],
            gridSelectedIdxs: [...(this.gridSelectedIdxs || [])],
            scrollTop: scrollWrapper ? scrollWrapper.scrollTop : 0,
            timestamp: Date.now()
        };

        this.sessionStack.push(session);
        console.log('✅ Grid 세션 저장:', session);
    }

    /**
     * Composite Grid로 전환 (8개 히트맵 표시)
     */
    async switchToCompositeGrid(result) {
        if (!result?.heatmaps || result.heatmaps.length === 0) {
            alert('생성된 히트맵이 없습니다.');
            return;
        }

        // 🔥 히트맵 경로 추출 (index 0~7 순서대로)
        const heatmapPaths = result.heatmaps
            .sort((a, b) => a.index - b.index)
            .map(h => h.path);

        // 🔥 Sum Map 추가 (9번째 이미지)
        if (result.sum_map_path) {
            heatmapPaths.push(result.sum_map_path);
        }

        console.log('🔄 Composite Grid로 전환 (9개 이미지):', heatmapPaths);

        // 🔥 Grid 선택 상태 완전 초기화
        this.gridSelectedIdxs = [];
        this.selectedImages = heatmapPaths;  // 🔥 컬럼 슬라이더 작동을 위해 selectedImages 설정

        // 🔥 Grid를 9개 이미지로 교체 (선택 상태 초기화)
        await this.showGrid(heatmapPaths, true);  // skipSaveState=true

        // DOM에서도 선택 상태 제거
        const gridItems = document.querySelectorAll('.grid-thumb-wrap');
        gridItems.forEach(item => item.classList.remove('selected'));

        // 🔥 컬럼 슬라이더가 적용되도록 보장 (showGrid 후에도 컬럼 설정 유지)
        const gridColsRange = document.getElementById('grid-cols-range');
        if (gridColsRange) {
            gridColsRange.value = this.gridCols;
            document.documentElement.style.setProperty('--grid-cols', this.gridCols);
        }

        // Composite 세션 정보 저장
        this.compositeSession = {
            sourceImageCount: result.image_count || result.source_images,
            outputDir: result.output_dir,
            imageSize: result.image_size,
            processingTime: result.processing_time,
            generatedAt: result.generated_at
        };

        // Composite 모드 활성화
        this.isCompositeMode = true;

        this.updateContextMenuState();
    }

    /**
     * 이전 Grid로 복귀
     */
    async returnToPreviousGrid() {
        if (this.sessionStack.length === 0) {
            console.warn('⚠️ 복귀할 세션이 없습니다.');
            this.isCompositeMode = false;
            this.updateContextMenuState();
            return;
        }

        const session = this.sessionStack.pop();
        console.log('🔙 이전 Grid 복귀:', session);

        // Grid 복원
        await this.showGrid(session.images, true);  // skipSaveState=true

        // 선택 상태 복원
        this.selectedImages = session.selectedImages;
        this.currentGridImages = session.images;
        this.gridSelectedIdxs = session.gridSelectedIdxs;

        // 스크롤 위치 복원
        const grid = document.getElementById('image-grid');
        const scrollWrapper = grid?.parentElement;
        if (scrollWrapper && session.scrollTop !== undefined) {
            setTimeout(() => {
                scrollWrapper.scrollTop = session.scrollTop;
            }, 50);
        }

        // Composite 모드 비활성화
        this.isCompositeMode = false;
        this.compositeSession = null;

        this.updateContextMenuState();
    }


    /**
     * Composite Map 생성 핸들러 (Grid 교체 방식)
     */
    async handleCompositeCreate() {
        if (this.isCompositeMode) {
            this.showToast?.('Composite 모드에서 나간 후 다시 시도하세요.', 1800);
            return;
        }

        const selected = this.getSelectedImagesForModal();
        if (!selected.length) {
            alert('Composite Map을 만들 이미지를 선택하세요.');
            return;
        }

        // 🔥 로딩 오버레이 표시
        let loadingOverlay = null;
        try {
            // 🔥 로딩 오버레이 생성
            loadingOverlay = document.createElement('div');
            loadingOverlay.id = 'composite-loading-overlay';
            loadingOverlay.style.cssText = `
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.7);
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                z-index: 20000;
                color: #fff;
                font-size: 16px;
            `;
            
            // 🔥 스피너와 메시지
            const spinner = document.createElement('div');
            spinner.style.cssText = `
                width: 50px;
                height: 50px;
                border: 4px solid rgba(255, 255, 255, 0.3);
                border-top-color: #007acc;
                border-radius: 50%;
                animation: spin 1s linear infinite;
                margin-bottom: 20px;
            `;
            
            const message = document.createElement('div');
            message.textContent = `Composite Map 생성 중... (${selected.length}개 이미지 처리 중)`;
            message.style.cssText = `
                font-size: 16px;
                font-weight: 500;
                text-align: center;
            `;
            
            // 🔥 CSS 애니메이션 추가 (이미 있으면 추가하지 않음)
            if (!document.getElementById('composite-loading-spinner-style')) {
                const style = document.createElement('style');
                style.id = 'composite-loading-spinner-style';
                style.textContent = `
                    @keyframes spin {
                        0% { transform: rotate(0deg); }
                        100% { transform: rotate(360deg); }
                    }
                `;
                document.head.appendChild(style);
            }
            
            loadingOverlay.appendChild(spinner);
            loadingOverlay.appendChild(message);
            document.body.appendChild(loadingOverlay);

            // 🔥 1단계: 현재 Grid 세션 저장
            this.saveCurrentGridSession();

            // 🔥 2단계: API 호출하여 Composite Map 생성
            const res = await fetch('/api/composite-map', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image_paths: selected })
            });

            if (!res.ok) {
                throw new Error(await res.text());
            }

            const result = await res.json();
            console.log('✅ Composite Map 생성 완료:', result);

            // 🔥 로딩 오버레이 제거
            if (loadingOverlay && loadingOverlay.parentNode) {
                loadingOverlay.parentNode.removeChild(loadingOverlay);
            }

            // 🔥 3단계: Grid를 Composite Grid로 교체
            await this.switchToCompositeGrid(result);

            // 🔥 완료 메시지
            this.showToast?.('Composite Map 생성 완료!', 2000);

        } catch (error) {
            console.error('❌ Composite Map 생성 실패:', error);
            
            // 🔥 로딩 오버레이 제거
            if (loadingOverlay && loadingOverlay.parentNode) {
                loadingOverlay.parentNode.removeChild(loadingOverlay);
            }
            
            alert('Composite Map 생성에 실패했습니다.');

            // 세션 스택에서 저장한 상태 제거 (롤백)
            if (this.sessionStack.length > 0) {
                this.sessionStack.pop();
            }
        }
    }

    // 🔥 하위 호환성을 위해 exitCompositeMode() 유지 (returnToPreviousGrid로 리다이렉트)
    exitCompositeMode() {
        this.returnToPreviousGrid();
    }

    normalizeLotPayload(lots) {
        return (lots || [])
            .map(lot => (lot || '').trim().toLowerCase())
            .filter(Boolean);
    }

    async performSearch(options = {}) {
        try {
            const fileQuery = this.dom.fileSearch?.value?.trim() || '';
            const normalizedLots = this.normalizeLotPayload(options.multiLotList || []);
            if (!fileQuery && normalizedLots.length === 0) {
                alert('파일명을 입력하거나 LOT 다중검색을 설정해주세요.');
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
            if (normalizedLots.length) {
                this.debugLog(`➡️ LOT 필터 적용: ${normalizedLots.join(', ')}`);
            }

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
            const searchParams = new URLSearchParams();
            searchParams.set('q', fileQuery || '');
            if (normalizedLots.length) {
                // 🔥 여러 LOT를 쉼표로 구분하여 전달
                const lotMultiValue = normalizedLots.join(',');
                console.log(`[SEARCH] LOT 목록 전달: ${normalizedLots.length}개 -`, normalizedLots);
                console.log(`[SEARCH] lot_multi 파라미터 값:`, lotMultiValue);
                searchParams.set('lot_multi', lotMultiValue);
            }
            const searchUrl = `/api/search?${searchParams.toString()}`;
            console.log(`[SEARCH] 검색 URL:`, searchUrl);
            const res = await fetch(searchUrl);
            if (!res.ok) {
                throw new Error(`검색 API 응답 오류: ${res.status}`);
            }

            const data = await res.json();
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

            let matchedImages = data.results
                .map(normalizeResultPath)
                .filter(path => typeof path === 'string' && path.length > 0);

            // test 필터 적용
            if (this.filterTestMode && this.filterTestMode !== 'all') {
                const lowerQuery = 'test';
                matchedImages = matchedImages.filter(path => {
                    const basename = path.toLowerCase();
                    const hasTest = basename.includes(lowerQuery);

                    if (this.filterTestMode === 'remove') {
                        return !hasTest;  // test 제거
                    } else if (this.filterTestMode === 'only') {
                        return hasTest;   // test만
                    }
                    return true;
                });
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

            // 🔥 정렬된 그리드의 실제 이미지 경로 사용 (정렬된 인덱스로 정렬된 리스트에서 가져오기)
            const gridImages = this.currentGridImages || this.selectedImages;
            const selectedImagePaths = this.gridSelectedIdxs.map(idx => gridImages[idx]).filter(Boolean);

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

        // 메뉴 항목 이벤트 리스너 등록 (한 번만)
        if (!this.contextMenuInitialized) {
            this.initializeContextMenu();
            this.contextMenuInitialized = true;
        }

        // 🔥 Composite Mode 상태에 따라 메뉴 항목 업데이트 (메뉴 표시 전에 호출)
        this.updateContextMenuState();

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

        // 🔥 메뉴 표시 후에도 상태 확인 (디버깅용)
        console.log('🔄 [CONTEXT_MENU] showContextMenu - isCompositeMode:', this.isCompositeMode);
        const createItem = document.getElementById('context-composite-create');
        const returnItem = document.getElementById('context-composite-return');
        if (createItem && returnItem) {
            console.log('🔄 [CONTEXT_MENU] createItem.display:', createItem.style.display, 'returnItem.display:', returnItem.style.display);
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
        const compositeCreateItem = document.getElementById('context-composite-create');
        const compositeReturnItem = document.getElementById('context-composite-return');

        if (compositeCreateItem) {
            compositeCreateItem.onclick = () => {
                this.hideContextMenu();
                this.handleCompositeCreate();
            };
        }

        if (compositeReturnItem) {
            compositeReturnItem.onclick = () => {
                this.hideContextMenu();
                this.exitCompositeMode();
            };
        }

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

        this.updateContextMenuState();
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

            // 🔥 정렬된 그리드의 실제 이미지 경로 사용 (정렬된 인덱스로 정렬된 리스트에서 가져오기)
            const gridImages = this.currentGridImages || this.selectedImages;
            const imagePromises = this.gridSelectedIdxs.map(async (idx, index) => {
                const imagePath = gridImages[idx];

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

            // 🔥 정렬된 그리드의 실제 이미지 경로 사용 (정렬된 인덱스로 정렬된 리스트에서 가져오기)
            const gridImages = this.currentGridImages || this.selectedImages;
            const imagePromises = this.gridSelectedIdxs.map(async (idx, index) => {
                const imagePath = gridImages[idx];

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

            // 🔥 정렬된 그리드의 실제 이미지 경로 사용 (정렬된 인덱스로 정렬된 리스트에서 가져오기)
            const gridImages = this.currentGridImages || this.selectedImages;
            const selectedFiles = this.gridSelectedIdxs.map(idx => gridImages[idx]).filter(Boolean);
            
            // 🔥 YMS 방식: _ 로 split 해서 0번째와 2번째만 (tab 구분)
            const ymsList = selectedFiles.map(filePath => {
                const fileName = filePath.split('/').pop(); // 파일명만 추출
                const parts = fileName.split('_');
                const part0 = parts[0] || '';
                let part2 = parts[2] || '';
                // 🔥 확장자 제거 (part2에서)
                if (part2) {
                    part2 = part2.replace(/\.(png|jpg|jpeg|gif|bmp|tiff?)$/i, '');
                }
                return `${part0}\t${part2}`;
            }).join('\n');

            // 클립보드 권한 확인 및 요청

            const hasPermission = await this.ensureClipboardPermission();

            if (hasPermission && navigator.clipboard && navigator.clipboard.writeText) {
                try {
                    await navigator.clipboard.writeText(ymsList);

                    alert(`${selectedFiles.length}개 파일 정보가 클립보드에 복사되었습니다!`);
                } catch (error) {
                    console.error('클립보드 복사 실패:', error);

                    this.fallbackCopyText(ymsList, selectedFiles.length);
                }
            } else {
                // 권한이 없거나 API를 지원하지 않는 경우 폴백 사용

                this.fallbackCopyText(ymsList, selectedFiles.length);
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

            // 🔥 정렬된 그리드의 실제 이미지 경로 사용 (정렬된 인덱스로 정렬된 리스트에서 가져오기)
            const gridImages = this.currentGridImages || this.selectedImages;
            const selectedFiles = this.gridSelectedIdxs.map(idx => gridImages[idx]).filter(Boolean);

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
                // 🔥 Shift 클릭 시 모든 네트워크 요청 및 로딩 중단
                if (this.imageLoadAbortController) {
                    console.log('🛑 [SHIFT_CLICK] 이미지 로딩 중단');
                    this.imageLoadAbortController.abort();
                }
                if (this.globalAbortController) {
                    console.log('🛑 [SHIFT_CLICK] 모든 네트워크 요청 중단');
                    this.globalAbortController.abort();
                    this.globalAbortController = new AbortController();
                }
                // 피라미드 생성도 중단
                if (this.semiconductorRenderer && typeof this.semiconductorRenderer.cancelPyramid === 'function') {
                    this.semiconductorRenderer.cancelPyramid();
                }
                // 네비게이터 숨기기
                if (this.thumbnailNavigator) {
                    this.thumbnailNavigator.hide();
                }
                // 단일 이미지 모드 종료
                if (this.viewMode === 'single') {
                    this.viewMode = null;
                    this.singleViewImageList = [];
                    this.singleViewImageIndex = -1;
                }
                
                const [from, to] = [this.lastExplorerClickedIdx, idx].sort((a, b) => a - b);
                const range = allLinks.slice(from, to + 1).map(a => a.dataset.path);

                this.selectedImages = Array.from(new Set([...(this.selectedImages || []), ...range]));

                this.debugLog('🔷 [DEBUG] Shift 선택 - selectedImages:', this.selectedImages.length, '개');

                // Shift 범위 선택 시에는 항상 그리드 모드

                this.hideGrid();
                
                // ✅ Chip Selection 패널 완전히 닫기
                this.closeChipSelectionPanel();

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

                // 🔥 폴더 선택 시 반드시 chip selection panel 닫기
                this.closeChipSelectionPanel();  // ← 추가: 패널 강제 종료
                this.hideImage();  // Grid 모드 진입 전에 이미지 숨기기
                this.hideGrid();

                if (this.selectedImages.length > 0) {
                    this.showGrid(this.selectedImages);
                }
            } else {
                // 단일 클릭 - 이전 선택 모두 해제 후 새 항목 선택

                // 🔥 이전 선택된 모든 항목들의 시각적 표시 해제 (인라인 스타일 포함)
                const allLinks = Array.from(this.dom.fileExplorer.querySelectorAll('a[data-path]'));

                allLinks.forEach(link => {
                    link.classList.remove('selected');
                    // 🔥 드래그로 선택된 파일들의 인라인 배경색도 제거
                    link.style.removeProperty('background');
                    link.style.background = ''; // 기본 배경색으로 복원
                });

                // 🔥 이전 선택된 폴더들의 시각적 표시 해제
                const allFolders = Array.from(this.dom.fileExplorer.querySelectorAll('summary.folder'));

                allFolders.forEach(folder => {
                    folder.classList.remove('selected');
                });

                // 🔥 드래그 선택 초기화
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
                console.log('🔍 [FILE_CLICK] 파일 클릭:', path);
                console.log('🔍 [FILE_CLICK] isImageFile 체크:', this.isImageFile(path));

                if (this.isImageFile(path)) {
                    // ✅ 파일 탐색기에서 클릭: enterSingleViewMode() 호출
                    console.log('✅ [FILE_CLICK] 이미지 파일 확인됨, enterSingleViewMode 호출');
                    await this.enterSingleViewMode(path);
                } else {
                    // 이미지가 아니면 그리드 모드
                    console.log('ℹ️ [FILE_CLICK] 이미지 파일 아님, 그리드 모드로 전환');
                    
                    // ✅ Chip Selection 패널 완전히 닫기
                    this.closeChipSelectionPanel();

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
        const hasClassificationPath = this.selectedImages?.some(path => this.isClassificationPath(path));
        
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

    async loadImage(path, fromLabelExplorer = false, loadVersion = null) {
        // 🔥 이전 이미지 로딩 요청 즉시 중단 (next/prev 빠른 클릭 대응)
        if (this.imageLoadAbortController) {
            console.log('🛑 [LOAD_IMAGE] 이전 로딩 요청 중단');
            this.imageLoadAbortController.abort();
        }

        // 🔥 새로운 AbortController 생성
        this.imageLoadAbortController = new AbortController();
        const signal = this.imageLoadAbortController.signal;

        // 🔥 버전 체크: 이미 새로운 이미지 로딩이 시작된 경우 이전 호출 무시
        if (loadVersion !== null && loadVersion !== this._imageLoadVersion) {
            console.log(`🛑 [LOAD_IMAGE] 이전 버전 로딩 무시: ${loadVersion} (현재: ${this._imageLoadVersion})`);
            return;
        }

        try {
            // ✅ 이미지 로드 전에 색상 scheme 재로드 (서버에서 최신 색상 가져오기)
            // colorLegends가 없거나 비어있거나, currentUser의 스킴이 없을 때 재로드
            const needsReload = !this.colorLegends || 
                                Object.keys(this.colorLegends).length === 0 ||
                                (this.personalizedColorEnabled && this.currentUser && 
                                 this.colorLegends && !this.colorLegends[this.currentUser]);
            
            if (needsReload) {
                console.log('🔄 [LOAD_IMAGE] 색상 scheme 재로드 시작...');
                try {
                    // 🔥 signal 전달하여 취소 가능하도록
                    await this.loadColorLegends(signal);
                    console.log('✅ [LOAD_IMAGE] 색상 scheme 재로드 완료, currentUser:', this.currentUser);
                    
                    // 재로드 후에도 currentUser 스킴이 없으면 경고
                    if (this.personalizedColorEnabled && this.currentUser && 
                        this.colorLegends && !this.colorLegends[this.currentUser]) {
                        console.warn(`⚠️ [LOAD_IMAGE] Scheme not found after reload: ${this.currentUser}, will use fallback`);
                    }
                } catch (error) {
                    // 🔥 AbortError는 정상 (이미지 로딩 중단 시)
                    if (error?.name === 'AbortError') {
                        throw error; // 상위로 전파하여 navigateSingleImageMode에서 처리
                    }
                    console.warn('⚠️ [LOAD_IMAGE] 색상 scheme 재로드 실패:', error);
                    // 기본값 사용 계속 진행
                }
            } else {
                // ✅ colorLegends가 이미 있지만, 최신 데이터를 위해 선택적으로 재로드할 수도 있음
                // (현재는 필요할 때만 재로드)
                console.log('✅ [LOAD_IMAGE] colorLegends 이미 로드됨, currentUser:', this.currentUser);
            }
            
            // 🔥 Composite Mode 종료 (이미지 선택 시 자동 종료)
            // 단, composite mode의 그리드에서 단일 이미지로 들어간 경우(singleImageFromGrid)는 제외
            if (this.isCompositeMode && !this.singleImageFromGrid) {
                console.log('🔄 Composite Mode 종료 (이미지 선택됨)');
                this.isCompositeMode = false;
                this.compositeSession = null;
                this.updateContextMenuState();
            } else if (this.isCompositeMode && this.singleImageFromGrid) {
                console.log('🔄 Composite Mode 유지 (그리드에서 단일 이미지로 진입)');
            }

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
            const isClassificationPath = this.isClassificationPath(path);
            
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
            // 🔥 피라미드 로딩 세트도 초기화
            this._pyramidLoading = new Set();

            if (this.minimapPreview && typeof this.minimapPreview.close === 'function') {
                try { this.minimapPreview.close(); } catch (e) { /* noop */ }
            }
            this.minimapPreview = null;

            // 🔥 Label Explorer에서 호출된 경우 singleImageFromGrid 플래그 유지

            if (this.isClassificationPath(path) && this.singleImageFromGrid) {
                this.debugLog('🔷 loadImage - singleImageFromGrid 플래그 유지');
            }

        const timeline = {
            click: performance.now()
        };
        // [STEP 1] 이미지 크기 먼저 조회
        const tSizeStart = performance.now();
        timeline.sizeFetchStart = tSizeStart;
        const sizeResponse = await fetch(`/api/image/size?path=${encodeURIComponent(fullPath)}`, { signal });
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

        const calculatedZoom = fitScale * FIT_RELATIVE_MARGIN;

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

        const personalizedParams = this.getPersonalizedParams();
        const url = `/api/image?path=${encodeURIComponent(fullPath)}&level=${initialLevel}${personalizedParams}`;
        const tFetchStart = performance.now();
        timeline.imageFetchStart = tFetchStart;

        const response = await fetch(url, { signal });
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
        // 🔥 캐시 키에도 저장 (개인색 설정별로 구분)
        const initialCacheKey = `${initialLevel}_${this.personalizedColorEnabled ? 'p' : 'n'}_${this.currentUser || 'change'}`;
        this.pyramidLevels[initialCacheKey] = bitmap;
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

        // 🔥 FIT_RELATIVE_MARGIN 값 확인 및 resetView 호출
        console.log(`[LOAD_IMAGE] FIT_RELATIVE_MARGIN: ${FIT_RELATIVE_MARGIN}, resetView 호출 전 scale: ${this.transform.scale?.toFixed(4) || 'N/A'}`);
        this.resetView(false);
        console.log(`[LOAD_IMAGE] resetView 호출 후 transform.scale: ${this.transform.scale.toFixed(4)}`);

            // ❌ 제거됨: setTimeout으로 updatePyramidLevel 호출
            // pyramid level 업데이트는 네비게이션 함수에서만 호출

            // 🚀 모든 피라미드 레벨 background pre-fetch (사용자 대기 없음)
            this.prefetchAllPyramidLevels();

            this.dom.minimapContainer.style.display = 'block';

            this.dom.imageCanvas.style.display = 'block';

            this.dom.overlayCanvas.style.display = 'block';

            this.showFileName(fullPath);  // 🔥 fullPath 사용 (chipLabelLegend도 자동 표시됨)

            // ⭐ Chip Labels 표시 (단일 이미지 모드에서)
            if (this.dom.chipLabelLegend) {
                this.dom.chipLabelLegend.style.display = 'block';
                console.log('🟢 [SHOW_IMAGE] chipLabelLegend 표시');
            }

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
            // 🔥 singleImageFromGrid일 때는 덮어쓰지 않음 (그리드 상태 복원을 위해)
            const isClassificationPathEnd = this.isClassificationPath(path);

            if (!isClassificationPathEnd && !fromLabelExplorer && !this.singleImageFromGrid) {
                this.savedViewState = {
                    type: 'single',
                    imagePath: fullPath,
                    zoom: this.zoom,
                    offsetX: this.offsetX,
                    offsetY: this.offsetY
                };
            }

            // 🎨 Color Legends 표시 및 렌더링 (Single Image Mode)
            this.showColorLegends();
            this.renderColorLegends();

            // 🔬 Chip Positions 자동 로드 (annotations도 자동으로 로드됨)
            if (this.chipAnnotator) {
                try {
                    const loaded = await this.chipAnnotator.loadPositions(fullPath);
                    if (loaded) {
                        console.log('✅ Chip positions & annotations loaded successfully');
                    } else {
                        console.log('ℹ️ No chip positions found for this image');
                    }
                } catch (err) {
                    console.warn('Failed to load chip positions:', err);
                }
            }

            // ✅ viewMode 설정: wafer map explorer에서 호출된 경우 'single'로 설정
            if (!this.singleImageFromGrid) {
                // wafer map explorer나 label explorer에서 호출된 경우
                this.viewMode = 'single';

                // 🔥 이미 enterSingleViewMode()에서 폴더 이미지 리스트를 설정한 경우 덮어쓰지 않음
                // singleViewImageList가 비어있거나 현재 이미지만 있는 경우에만 업데이트
                if (!this.singleViewImageList || this.singleViewImageList.length === 0) {
                    this.singleViewImageList = [fullPath];
                    this.singleViewImageIndex = 0;
                }
            }

            // ✅ Arrow button visibility 업데이트
            this.updateArrowButtonVisibility();

            // ✅ Wafer Map Explorer 하이라이트 업데이트 (Label Explorer에서 온 경우는 제외 - 독립적 선택)
            if (!fromLabelExplorer) {
                this.updateWaferMapExplorerHighlight(fullPath);
            }
        } catch (err) {
            // 🔥 next/prev 빠른 클릭으로 인한 중단은 정상 동작 (에러 로그 억제)
            if (err.name === 'AbortError') {
                console.log('🛑 [LOAD_IMAGE] 이미지 로딩 중단됨 (next/prev 클릭)');
                return;
            }

            console.error(`Failed to load image: ${path}`, err);

            this.dom.minimapContainer.style.display = 'none';
            this.hideColorLegends();
        }
    }

    /**
     * ✅ Wafer Map Explorer 하이라이트 업데이트 (중앙 집중화)
     * @param {string} imagePath - 현재 이미지 경로
     */
    updateWaferMapExplorerHighlight(imagePath) {
        if (!this.dom.fileExplorer || !imagePath) return;

        this.ensureExplorerPathVisible(imagePath)
            .then(() => this.applyWaferMapExplorerHighlight(imagePath))
            .catch(error => {
                console.warn('⚠️ [EXPLORER] Failed to ensure path visibility:', error);
                this.applyWaferMapExplorerHighlight(imagePath);
            });
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
        // 🔥 개인색 설정이 변경되면 기존 캐시 무효화
        // 캐시 키에 개인색 설정 정보 포함하여 다른 설정의 캐시와 구분
        const cacheKey = `${level}_${this.personalizedColorEnabled ? 'p' : 'n'}_${this.currentUser || 'change'}`;
        const cachedBitmap = this.pyramidLevels[cacheKey];
        if (cachedBitmap) {
            // 캐시된 레벨이 현재 설정과 일치하면 사용
            this.pyramidLevels[level] = cachedBitmap; // 기존 코드 호환성 유지
            return;
        }

        // 이미 로딩 중이면 스킵 (중복 요청 방지)
        if (!this._pyramidLoading) {
            this._pyramidLoading = new Set();
        }
        const loadingKey = `${level}_${cacheKey}`;
        if (this._pyramidLoading.has(loadingKey)) {
            return;
        }
        this._pyramidLoading.add(loadingKey);

        const personalizedParams = this.getPersonalizedParams();
        const url = `/api/image?path=${encodeURIComponent(this.selectedImagePath)}&level=${level}${personalizedParams}`;
        console.log('🎨 [PYRAMID LOAD] level:', level, '| personalizedParams:', personalizedParams, '| enabled:', this.personalizedColorEnabled, '| currentUser:', this.currentUser, '| cacheKey:', cacheKey);
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

            // 🔥 캐시 무효화 강화: 개인색 설정 변경 시 브라우저 캐시도 무시
            const fetchOptions = {
                priority: 'high',
                cache: this._personalizedColorCacheBuster ? 'no-cache' : 'default', // 캐시 버스팅 시 브라우저 캐시 무시
                headers: {
                    Accept: 'image/png,image/apng,image/*;q=0.8',
                    // 🔥 캐시 무효화를 위한 헤더 추가
                    'Cache-Control': this._personalizedColorCacheBuster ? 'no-cache' : 'max-age=31536000'
                },
                // 🔥 이미지 로드 중단 시그널 추가 (next/prev 빠른 클릭 대응)
                signal: this.imageLoadAbortController?.signal
            };
            let response;
            tFetchStart = performance.now();
            try {
                response = await fetch(url, fetchOptions);
            } catch (fetchErr) {
                // AbortError는 그대로 throw하여 상위에서 처리
                if (fetchErr.name === 'AbortError') {
                    throw fetchErr;
                }
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
            // 🔥 캐시 키에도 저장 (개인색 설정별로 구분)
            this.pyramidLevels[cacheKey] = bitmap;
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
                // 🔥 피라미드 레벨 변경 시 transform은 변경하지 않음
                // transform.dx, dy는 항상 원본 이미지 크기(originalWidth, originalHeight) 기준으로 유지
                // draw 함수에서 피라미드 이미지를 원본 크기로 확대해서 그리므로 위치는 동일하게 유지됨
                this.currentImage = bitmap;
                this.currentPyramidLevel = level;
                if (this.semiconductorRenderer?.isGpuAvailable()) {
                    this.semiconductorRenderer.setActiveLevel(level);
                }
                
                // 🔥 이미지가 표시되어 있을 때는 view-controls 패널이 보이도록 보장
                if (this.currentImage && !this.gridMode) {
                    const viewControls = document.querySelector('.view-controls');
                    if (viewControls) {
                        viewControls.style.display = 'flex';
                    }
                }
                
                this.prepareMinimapPreview(bitmap).then(() => {
                    if (this.dom?.minimapContainer?.offsetWidth) {
                        requestAnimationFrame(() => this.updateMinimap());
                    }
                }).catch(() => {});
                this.scheduleDraw();

                const isCacheHit = cacheStatus === 'HIT' || cacheStatus === 'ORIGINAL';
                const prefix = isCacheHit ? '[SWITCH]' : '[ASYNC]';
                console.log(`${prefix} Lv${level} | ${this.originalWidth}×${this.originalHeight} → ${bitmap.width}×${bitmap.height} | Zoom:${this.transform.scale.toFixed(2)} | Cache:${cacheStatus} | ${timingSummary} | Transform adjusted: dx=${this.transform.dx.toFixed(1)}, dy=${this.transform.dy.toFixed(1)}`);
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
            this._pyramidLoading.delete(loadingKey);
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
                
                // 🔥 캐시 키 생성 (개인색 설정별로 구분)
                const cacheKey = `${bestLevel}_${this.personalizedColorEnabled ? 'p' : 'n'}_${this.currentUser || 'change'}`;

                // 현재 레벨과 다르면 교체

        if (bestLevel !== this.currentPyramidLevel) {
                        // 🔥 캐시 키와 일반 키 모두 확인
                        const cachedBitmap = this.pyramidLevels[cacheKey] || this.pyramidLevels[bestLevel];
                        
                        if (cachedBitmap) {
                                // 🔥 피라미드 레벨 변경 시 transform은 변경하지 않음
                                // transform.dx, dy는 항상 원본 이미지 크기(originalWidth, originalHeight) 기준으로 유지
                                // draw 함수에서 피라미드 이미지를 원본 크기로 확대해서 그리므로 위치는 동일하게 유지됨
                                this.currentImage = cachedBitmap;

                this.currentPyramidLevel = bestLevel;
                if (this.semiconductorRenderer?.isGpuAvailable()) {
                    this.semiconductorRenderer.setActiveLevel(bestLevel);
                }

                // 🔥 이미지가 표시되어 있을 때는 view-controls 패널이 보이도록 보장
                if (this.currentImage && !this.gridMode) {
                    const viewControls = document.querySelector('.view-controls');
                    if (viewControls) {
                        viewControls.style.display = 'flex';
                    }
                }

                this.scheduleDraw();

                // 📊 레벨 전환 로그
                console.log(`[SWITCH] Lv${bestLevel} | ${this.originalWidth}×${this.originalHeight} → ${this.currentImage.width}×${this.currentImage.height} | Zoom:${this.transform.scale.toFixed(2)} | CacheKey:${cacheKey} | Transform adjusted: dx=${this.transform.dx.toFixed(1)}, dy=${this.transform.dy.toFixed(1)}`);
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

        // ✅ transform 값 검증
        if (!Number.isFinite(this.transform.scale) || 
            !Number.isFinite(this.transform.dx) || 
            !Number.isFinite(this.transform.dy)) {
            console.error('[DRAW] transform 값이 유효하지 않음, 리셋:', {
                scale: this.transform.scale,
                dx: this.transform.dx,
                dy: this.transform.dy
            });
            this.resetViewWithAbsoluteOffset();
            return;
        }

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

        // 🔥 오버레이 캔버스 동기화
        if (this.dom.overlayCanvas) {
            this.dom.overlayCanvas.width = width;
            this.dom.overlayCanvas.height = height;
            this.dom.overlayCanvas.style.width = '100%';
            this.dom.overlayCanvas.style.height = '100%';
        }

        let usedGpu = false;
        if (this.semiconductorRenderer && this.usingGpuRenderer) {
            usedGpu = this.semiconductorRenderer.drawGpu({
                level: this.currentPyramidLevel,
                viewportWidth: width,
                viewportHeight: height,
                scale: this.transform.scale,
                translateX: this.transform.dx,
                translateY: this.transform.dy,
                originalWidth: this.originalWidth,
                originalHeight: this.originalHeight
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

        // ✅ transform 초기화 (누적 방지)
        this.imageCtx.resetTransform();

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

        // 🔥 단일 이미지 모드에서 파일명 패널 절대 보호
        if (this.currentImage && this.dom.fileNameDisplay) {
            if (this.dom.fileNameDisplay.style.display === 'none') {
                this.dom.fileNameDisplay.style.display = 'block';
                console.log('⚠️ EMERGENCY PANEL RESTORE: fileNameDisplay was hidden in draw()');
            }
        }

        // 🔥 Chip annotator 렌더링 (항상 시도)
        if (this.chipAnnotator) {
            this.chipAnnotator.render();
        }
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
        const finalScale = fitScale * FIT_RELATIVE_MARGIN;
        console.log(`[RESET_VIEW] FIT_RELATIVE_MARGIN: ${FIT_RELATIVE_MARGIN}, fitScale: ${fitScale.toFixed(4)}, final scale: ${finalScale.toFixed(4)}`);
        this.transform.scale = finalScale;

        // 파일명 패널 높이 고려 (CSS 변수에서 가져오기)

        const filenameBarHeight = 56; // --filename-bar-height와 동일
        this.zoom = this.transform.scale; // 🎯 zoom 값 동기화

                // 🎯 실제 센터링도 원본 이미지 크기 기준으로 적용

        this.transform.dx = (containerRect.width - this.originalWidth * this.transform.scale) / 2;

        // 파일명 패널과 줌 패널 사이 중앙 정렬 (이미지를 아래로 내리기 위해 오프셋 증가)

        this.transform.dy = (containerRect.height - this.originalHeight * this.transform.scale) / 2 + (filenameBarHeight * 0.6);

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

        // Alt/Shift/Ctrl 키가 눌려있으면 패닝 비활성화 (칩 선택 우선)
        if (e.altKey || e.ctrlKey || e.shiftKey) {
            return;
        }

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

        // ✅ 방법 2: Ctrl 키 상태 추적
        if (e.ctrlKey) {
            this.lastCtrlKey = true;
            clearTimeout(this.wheelTimeout);
            this.wheelTimeout = setTimeout(() => {
                this.lastCtrlKey = false;
            }, 100); // 100ms 동안 Ctrl 상태 유지
        }

        // 🔥 절대 원칙: 단일 이미지 모드에서는 상단 패널이 절대 사라져야 함
        if (this.currentImage && this.dom.fileNameDisplay) {
            // Ctrl 줌 시작 전에 패널 표시 확인
            if (e.ctrlKey && this.dom.fileNameDisplay.style.display === 'none') {
                this.dom.fileNameDisplay.style.display = 'block';
                console.log('🔒 PANEL RESTORE: fileNameDisplay restored before zoom');
            }
        }

        // ✅ 방법 1 & 2: Ctrl이 눌렸거나 최근에 눌렸으면 줌만 처리
        if (e.ctrlKey || this.lastCtrlKey) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation(); // ✅ 방법 1: 추가 방어

            // 🔥 미니맵 패널 보호 활성화
            this.panelProtected = true;
            this.zoomInProgress = true;
            
            if (this.dom.fileNameDisplay) {
                this.dom.fileNameDisplay.style.display = 'block';  // 패널 보이기
            }
            
            const scaleAmount = 1 - e.deltaY * 0.001;
            this.zoomAtPoint(scaleAmount, e.clientX, e.clientY);
            
            // 🔥 200ms 동안 패널 보호
            clearTimeout(this.panelProtectTimeout);
            this.panelProtectTimeout = setTimeout(() => {
                this.panelProtected = false;
                this.zoomInProgress = false;
                
                // 🔥 줌 완료 후 패널 보호 재확인
                if (this.currentImage && this.dom.fileNameDisplay) {
                    this.dom.fileNameDisplay.style.display = 'block';
                    console.log('🔒 PANEL FINAL CHECK: fileNameDisplay confirmed visible');
                }
            }, MINIMAP_ZOOM_PROTECTION_MS);
            
            return; // ✅ 방법 1: 명시적 return - else 블록 완전 제거
        }
        
        // ✅ Ctrl 없이 wheel 시 보호 해제
        this.panelProtected = false;
        this.zoomInProgress = false;

        // ✅ 방법 1: else 블록 완전 제거
        // Shift나 일반 wheel은 처리하지 않음 (단일 이미지 뷰에서는 불필요)
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
        // ✅ 줌 시작 시 패널 보호
        this.panelProtected = true;
        this.zoomInProgress = true;
        
        if (!this.currentImage || !this.originalWidth || !this.originalHeight) return;
        
        const viewerRect = this.dom.viewerContainer.getBoundingClientRect();
        const mouseX = clientX - viewerRect.left;
        const mouseY = clientY - viewerRect.top;
        
        // 🔥 현재 transform 값 저장 (계산 중 변경 방지)
        const oldDx = this.transform.dx;
        const oldDy = this.transform.dy;
        const oldScale = this.transform.scale;
        
        // ✅ oldScale 검증 강화 - 리셋하지 않고 안전한 값으로 설정
        if (Math.abs(oldScale) < 0.0001 || !Number.isFinite(oldScale)) {
            console.warn('[ZOOM] oldScale 무효, 안전한 값 설정:', oldScale);
            this.transform.scale = 1.0; // 리셋 대신 기본값 설정
            return;
        }
        
        // 🔥 마우스 포인트가 가리키는 이미지 좌표 계산 (원본 이미지 크기 기준)
        // 화면 좌표를 이미지 좌표로 변환: imgX = (screenX - dx) / scale
        const imgX = (mouseX - oldDx) / oldScale;
        const imgY = (mouseY - oldDy) / oldScale;
        
        // ✅ 계산된 이미지 좌표가 유효한지 확인 - resetView 호출하지 않음
        if (!Number.isFinite(imgX) || !Number.isFinite(imgY)) {
            console.warn('[ZOOM] 이미지 좌표 무효, 줌 취소:', { imgX, imgY, oldDx, oldDy, oldScale });
            return; // ✅ resetView 호출하지 않음
        }
        
        // ✅ 줌 레벨 제한 (0.05 ~ 5.0) - 최소값을 0.05로 낮춰서 더 축소 가능
        const minZoom = 0.05;  // 5% 축소 가능 (기존 0.1에서 0.05로 변경)
        const maxZoom = 5.0;    // 최대 500%
        const newScale = Math.max(minZoom, Math.min(maxZoom, oldScale * scale));
        
        // ✅ newScale이 이상하면 줌 취소 - resetView 호출하지 않음
        if (!Number.isFinite(newScale) || newScale < minZoom) {
            console.warn('[ZOOM] newScale 무효, 줌 취소:', newScale);
            return; // ✅ resetView 호출하지 않음
        }
        
        // 🔥 마우스 포인트가 가리키는 이미지 좌표가 같은 화면 위치에 오도록 transform 조정
        // 새로운 transform: screenX = imgX * newScale + newDx
        // 따라서: newDx = screenX - imgX * newScale
        // 빠른 줌 변경 시에도 마우스 포인트가 고정되도록 transform을 먼저 조정
        const newDx = mouseX - imgX * newScale;
        const newDy = mouseY - imgY * newScale;
        
        // ✅ 새로운 transform 값이 유효한지 확인 - resetView 호출하지 않음
        if (!Number.isFinite(newDx) || !Number.isFinite(newDy)) {
            console.warn('[ZOOM] transform 무효, 줌 취소:', { newDx, newDy, imgX, imgY, newScale });
            return; // ✅ resetView 호출하지 않음
        }
        
        this.transform.dx = newDx;
        this.transform.dy = newDy;
        this.transform.scale = newScale;
        this.zoom = newScale; // 🎯 zoom 값 동기화

        // ✅ transform 업데이트 후 렌더링
        this.updateZoomDisplay();
        this.updatePyramidLevel();
        this.scheduleDraw();
        
        // ✅ 줌 완료 후에도 보호 유지 (타임아웃으로 해제)
        clearTimeout(this.panelProtectTimeout);
        this.panelProtectTimeout = setTimeout(() => {
            this.panelProtected = false;
            this.zoomInProgress = false;
        }, 100);
    }

    zoomAtCenter(factor) {
        // ✅ 줌 시작 시 패널 보호
        this.panelProtected = true;
        this.zoomInProgress = true;
        
        const viewerRect = this.dom.viewerContainer.getBoundingClientRect();

        this.zoomAtPoint(factor, viewerRect.left + viewerRect.width / 2, viewerRect.top + viewerRect.height / 2);
        
        // ✅ 줌 완료 후에도 보호 유지 (타임아웃으로 해제)
        clearTimeout(this.panelProtectTimeout);
        this.panelProtectTimeout = setTimeout(() => {
            this.panelProtected = false;
            this.zoomInProgress = false;
        }, 100);
    }

    setZoom(level) {
        // ✅ 줌 시작 시 패널 보호
        this.panelProtected = true;
        this.zoomInProgress = true;
        
        // ✅ 줌 레벨 제한 (0.05 ~ 5.0) - 최소값을 0.05로 낮춰서 더 축소 가능
        const minZoom = 0.05;  // 5% 축소 가능 (기존 0.1에서 0.05로 변경)
        const maxZoom = 5.0;    // 최대 500%
        const scale = Math.max(minZoom, Math.min(maxZoom, level));
        
        const currentScale = this.transform.scale;
        const factor = scale / currentScale;

        this.zoomAtCenter(factor);
        
        // ✅ 줌 완료 후에도 보호 유지 (타임아웃으로 해제)
        clearTimeout(this.panelProtectTimeout);
        this.panelProtectTimeout = setTimeout(() => {
            this.panelProtected = false;
            this.zoomInProgress = false;
        }, 100);
    }

    // 리셋 버튼 전용: 초기 이미지 크기와 배치와 동일하게 적용

    resetViewWithAbsoluteOffset() {
        // ✅ 리셋 시에도 패널 보호 (이미 bindZoomEvents에서 설정됨)
        // 하지만 직접 호출될 수 있으므로 여기서도 보호
        this.panelProtected = true;
        this.zoomInProgress = true;
        
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

        const finalScale = fitScale * FIT_RELATIVE_MARGIN;
        console.log(`[RESET_VIEW_WITH_OFFSET] FIT_RELATIVE_MARGIN: ${FIT_RELATIVE_MARGIN}, fitScale: ${fitScale.toFixed(4)}, final scale: ${finalScale.toFixed(4)}`);
        this.transform.scale = finalScale;

        // 🎯 실제 센터링도 원본 이미지 크기 기준으로 적용

        this.transform.dx = (containerRect.width - this.originalWidth * this.transform.scale) / 2;

        // 파일명 패널과 줌 패널 사이 중앙 정렬 - 초기 로드와 동일 (이미지를 아래로 내리기 위해 오프셋 증가)

        this.transform.dy = (containerRect.height - this.originalHeight * this.transform.scale) / 2 + (filenameBarHeight * 0.6);

                this.zoom = this.transform.scale; // 🎯 zoom 값 동기화

                this.updateZoomDisplay();

        this.updatePyramidLevel(); // 🎯 피라미드 레벨 업데이트

        this.scheduleDraw();
        
        // ✅ 리셋 완료 후에도 보호 유지 (타임아웃으로 해제)
        clearTimeout(this.panelProtectTimeout);
        this.panelProtectTimeout = setTimeout(() => {
            this.panelProtected = false;
            this.zoomInProgress = false;
        }, 100);
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
        
        // 이미지 좌표계에서 뷰포트 크기 (픽셀)
        const viewW_img = viewW / viewScale;
        const viewH_img = viewH / viewScale;
        
        // 뷰포트 크기 (미니맵 스케일 적용)
        // ⭐ 줌이 작을수록 (viewScale이 작을수록) 뷰포트가 커짐
        // viewScale이 0.1이면 viewW_img는 viewW / 0.1 = viewW * 10이 됨
        let vpW = viewW_img * scale;
        let vpH = viewH_img * scale;
        
        // ⭐ 뷰포트 크기 제약 (maxSize 제한만 적용, 화면 높이 제한은 나중에)
        const minSize = Math.min(mapW, mapH) * MINIMAP_VIEWPORT_MIN_SIZE;
        const maxSize = Math.max(mapW, mapH) * MINIMAP_VIEWPORT_MAX_SIZE;
        
        // ⭐ maxSize 제한 적용 (8.0 = 800%까지 가능)
        // 계산된 크기가 maxSize보다 크면 maxSize로 제한
        const originalVpW = vpW;
        const originalVpH = vpH;
        vpW = Math.max(minSize, Math.min(maxSize, vpW));
        vpH = Math.max(minSize, Math.min(maxSize, vpH));
        
        // 디버깅: 제한 전후 비교
        if (originalVpW !== vpW || originalVpH !== vpH) {
            console.log('[MINIMAP] Viewport size limited:', { 
                original: { w: originalVpW.toFixed(1), h: originalVpH.toFixed(1) },
                limited: { w: vpW.toFixed(1), h: vpH.toFixed(1) },
                maxSize: maxSize.toFixed(1),
                mapSize: { w: mapW.toFixed(1), h: mapH.toFixed(1) },
                viewScale: viewScale.toFixed(3),
                scale: scale.toFixed(4)
            });
        }
        
        // ⭐ 뷰포트 위치 - 중심 정렬 방식
        // 메인 뷰포트가 이미지에서 차지하는 영역의 중심
        const viewportCenterX = viewX + viewW_img / 2;
        const viewportCenterY = viewY + viewH_img / 2;
        
        // 미니맵에서의 뷰포트 위치 (중심이 맞도록)
        let vpX = padX + (viewportCenterX * scale) - vpW / 2;
        let vpY = padY + (viewportCenterY * scale) - vpH / 2;
        
        // 뷰포트가 미니맵 경계 내에 있도록 제약
        vpX = Math.max(-vpW * 0.5, Math.min(mapW - vpW * 0.5, vpX));
        vpY = Math.max(-vpH * 0.5, Math.min(mapH - vpH * 0.5, vpY));
        
        // 🔥 추가: 뷰포트가 최대 크기 제한에 도달했으면 패널 보호 활성화
        // ⭐ 화면 높이 제한은 패널 보호를 위해서만 적용 (maxSize보다 우선하지 않음)
        // maxSize 제한이 우선이므로, 화면 높이 제한은 maxSize보다 작을 때만 적용
        const filenameBarHeight = 56;
        const maxViewportHeight = viewH - filenameBarHeight;
        
        // ⭐ 화면 높이 제한은 maxSize보다 작을 때만 적용
        // maxSize가 화면 높이보다 크면 maxSize를 사용 (뷰포트가 더 커질 수 있음)
        if (vpH > maxSize) {
            // maxSize가 우선이므로 이미 위에서 제한됨 (더 큰 확대 가능)
            // 화면 높이 제한은 적용하지 않음
        } else if (vpH > maxViewportHeight) {
            // maxSize 내에서 화면 높이 제한 적용 (패널 보호)
            // 하지만 maxSize가 화면 높이보다 크면 maxSize 우선
            if (maxSize <= maxViewportHeight) {
                vpH = maxViewportHeight;
                // 중심 유지하면서 높이 조정
                const currentCenterY = vpY + vpH / 2;
                vpY = currentCenterY - vpH / 2;
            }
            // maxSize > maxViewportHeight인 경우는 maxSize 사용 (제한 없음)
        }
        
        // 뷰포트가 최대 크기 제한에 근접하면 패널 보호 활성화
        if (vpW >= maxSize * 0.95 || vpH >= maxSize * 0.95) {
            console.log('🔒 MINIMAP: Viewport at max size - protecting panel');
            
            this.panelProtected = true;
            
            // transform.dy 보호
            if (this.dom.fileNameDisplay) {
                const minDy = PANEL_MIN_DY;
                if (this.transform.dy < minDy) {
                    this.transform.dy = minDy;
                }
            }
            
            clearTimeout(this.minimapPanelProtectTimeout);
            this.minimapPanelProtectTimeout = setTimeout(() => {
                this.panelProtected = false;
            }, MINIMAP_ZOOM_PROTECTION_MS);
        }
        
        // ✅ 계산 결과 검증
        if (!Number.isFinite(vpW) || !Number.isFinite(vpH) ||
            !Number.isFinite(vpX) || !Number.isFinite(vpY)) {
            console.warn('[MINIMAP] 계산 오류 - viewport 그리기 취소');
            return;
        }

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
            // 🔥 입력 필드 활성화 보장
            this.dom.newClassInput.disabled = false;
            this.dom.newClassInput.readOnly = false;
            this.dom.newClassInput.style.pointerEvents = 'auto';
            this.dom.newClassInput.style.userSelect = 'text';
            
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
        if (!force && this.cachedClassList && this.cachedClassList.length >= 0) {
            return this.cachedClassList;
        }
        if (!force && this.classListPromise) {
            return this.classListPromise;
        }

        const apiUrl = this.buildClassApiUrl('/api/classes');

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
                return classes;
            } catch (error) {
                console.error('클래스 목록 조회 실패:', error);
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
                
                // 디버그 로그 간소화 (성능 최적화)

                if (!isCtrl && !isShift) {
                    if (this.classMode === 'chip') {
                        if (!this.ensureChipSelectionForLabeling()) {
                            return;
                        }
                        this.addChipLabels(cls, false);
                        return;
                    }
                    // 🔥 성능 최적화: 직접 라벨링 (즉각 반응)
                    this.selectedClass = cls;

                    if (this.dom.labelStatus) this.dom.labelStatus.textContent = '';

                    let imagePaths = [];

                    // 🔥 Grid 모드: 체크된 이미지들 라벨링
                    if (this.gridMode && this.gridSelectedIdxs && this.gridSelectedIdxs.length > 0) {
                        // 🔥 정렬된 그리드의 실제 이미지 경로 사용 (정렬된 인덱스로 정렬된 리스트에서 가져오기)
                        const gridImages = this.currentGridImages || this.selectedImages;
                        
                        imagePaths = this.gridSelectedIdxs
                            .map(idx => gridImages[idx])
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
                    const apiUrl = this.buildClassApiUrl('/api/classify/batch');

                    fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ class_name: cls, images: imagePaths, mode: this.classMode })
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
                        if (this.classSelection.selected.includes(cls)) {
                            this.classSelection.selected = this.classSelection.selected.filter(c => c !== cls);
                        } else {
                            this.classSelection.selected.push(cls);
                        }

                        this.classSelection.lastClicked = cls;
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
            console.log('🔍 [ADD_CLASS_PERF] 클래스 추가 시작:', { count: names.length, names });

            const startTime = performance.now();

            for (const name of names) {
                try {
                    // 🔥 현재 폴더 및 모드 파라미터 추가
                    const apiUrl = this.buildClassApiUrl('/api/classes');
                    console.log(`🔍 [ADD_CLASS] classMode: ${this.classMode}, apiUrl: ${apiUrl}, className: ${name}`);

                    const response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name })
                    });
                    
                    console.log(`🔍 [ADD_CLASS] Response status: ${response.status}, ok: ${response.ok}`);

                    if (!response.ok) {
                        const errorText = await response.text();
                        let errorDetail = '';
                        try {
                            const errorJson = JSON.parse(errorText);
                            errorDetail = errorJson.detail || errorJson.message || errorText;
                        } catch {
                            errorDetail = errorText;
                        }
                        console.error(`❌ 클래스 '${name}' 추가 실패: HTTP ${response.status}, ${errorDetail}`);
                        alert(`클래스 '${name}' 추가 실패: ${errorDetail}`);
                        continue; // 실패한 클래스는 건너뛰고 계속 진행
                    }

                    const result = await response.json();

                    if (!result.success) {
                        const errorMsg = result.message || result.detail || 'Unknown error';
                        console.error(`❌ 클래스 '${name}' 추가 실패: ${errorMsg}`);
                        alert(`클래스 '${name}' 추가 실패: ${errorMsg}`);
                        continue; // 실패한 클래스는 건너뛰고 계속 진행
                    }

                    this.debugLog(`클래스 '${name}' 추가 성공:`, result);

                    successfulClasses.push(name); // 성공한 클래스 추가

                    // 🔥 개별 새로고침 제거 - 마지막에 한 번만 실행
                    // if (result.refresh_required) {
                    //     this.debugLog(`클래스 '${name}' 생성 완료 - Label Explorer 즉시 강제 새로고침`);
                    //     await this.refreshLabelExplorer();
                    // }
                } catch (error) {
                    console.error(`클래스 '${name}' 추가 중 오류 발생:`, error);

                    continue; // 오류 발생한 클래스는 건너뛰고 계속 진행
                }
            }

            this.dom.newClassInput.value = '';

            // 🔥 클래스 캐시 무효화하여 최신 데이터 가져오기
            this.cachedClassList = null;
            this.classListPromise = null;

            // 🔥 Label Explorer가 내부에서 getClassList()를 호출하므로 refreshClassList() 불필요
            await this.refreshLabelExplorer();
            
            // 🔥 추가: Fail List와 Label Explorer 즉시 업데이트
            this.updateLabelExplorerContent();

            // 성능 측정 완료
            const endTime = performance.now();
            console.log('🔍 [ADD_CLASS_PERF] 클래스 추가 완료:', { 
                totalTime: `${(endTime - startTime).toFixed(1)}ms`,
                successCount: successfulClasses.length,
                requestedCount: names.length
            });

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

        if (this.classMode === 'chip') {
            if (!this.ensureChipSelectionForLabeling()) {
                return;
            }
            if (!this.selectedClass) {
                alert('칩 라벨링을 위해 적용할 클래스를 선택하세요.');
                return;
            }
            await this.addChipLabels(this.selectedClass, false);
            return;
        }

        if (this.gridMode && this.gridSelectedIdxs && this.gridSelectedIdxs.length > 0 && this.selectedClass) {
            // 🔥 배치 API 사용

            // 🔥 정렬된 그리드의 실제 이미지 경로 사용 (정렬된 인덱스로 정렬된 리스트에서 가져오기)
            const gridImages = this.currentGridImages || this.selectedImages;
            const imagePaths = this.gridSelectedIdxs.map(idx => gridImages[idx]);

            // 🔥 모드 파라미터가 포함된 URL
            const apiUrl = this.buildClassApiUrl('/api/classify/batch');
            await fetch(apiUrl, {
                method: 'POST',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify({ class_name: this.selectedClass, images: imagePaths, mode: this.classMode })
            });

            // 🔥 Grid 모드: 캐시만 무효화 (refreshClassList 호출 안함 - 재귀 방지)
            this.classToImgListCache = {};
        } else if (this.selectedClass && this.selectedImagePath) {
            const requestBody = { class_name: this.selectedClass, image_path: this.selectedImagePath, mode: this.classMode };

            this.debugLog('단일 이미지 분류 요청 전송:', requestBody);

            // 🔥 모드 파라미터가 포함된 URL
            const apiUrl = this.buildClassApiUrl('/api/classify');
            const res = await fetch(apiUrl, {
                method: 'POST',

                headers: { 'Content-Type': 'application/json' },

                body: JSON.stringify(requestBody)
            });

            if (res.ok) {
                // Explorer에서 classification/클래스 폴더 자동 오픈

                const explorer = this.dom.fileExplorer;
                const classPath = this.buildClassificationPath(this.selectedClass);
                const classSummary = explorer?.querySelector(`summary[data-path="${classPath}"]`);

                if (classSummary) {
                    classSummary.parentElement.open = true;

                    this.loadDirectoryContents(classPath, classSummary.nextElementSibling);
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
        const apiUrl = this.buildClassApiUrl('/api/classes/rename');
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
                
                // 🔥 추가: Fail List와 Label Explorer 즉시 업데이트
                this.updateLabelExplorerContent();

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
        const apiUrl = this.buildClassApiUrl('/api/classes/delete');
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
        
        // 🔥 추가: Fail List와 Label Explorer 즉시 업데이트
        this.updateLabelExplorerContent();
        
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
            // 🔥 context-menu.js의 getSelectedFiles()와 동일하게 selectedImages 사용 (정렬된 리스트 보장)
            // currentGridImages 대신 selectedImages를 사용하여 정렬된 이미지 리스트 보장
            return this.gridSelectedIdxs
                .map(idx => this.selectedImages[idx])
                .filter(Boolean);
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

            // 🔥 모드 파라미터가 포함된 URL
            const apiUrl = this.buildClassApiUrl('/api/classify');

            for (const labelGroup of this.selectedLabelsForRemoval) {
                for (const fileName of labelGroup.fileNames) {
                    await fetch(apiUrl, {
                        method: 'DELETE',

                        headers: { 'Content-Type': 'application/json' },

                        body: JSON.stringify({
                            class_name: labelGroup.className,
                            image_name: fileName,
                            mode: this.classMode
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

        // 🔥 Chip 선택 확인
        const chipCount = this.chipAnnotator && this.chipAnnotator.selectedChips ? this.chipAnnotator.selectedChips.size : 0;

        if (chipCount > 0) {
            // Chip이 선택된 경우
            const imageName = this.selectedImagePath ? this.selectedImagePath.split('/').pop() : 'Unknown';
            currentImageInfo.innerHTML = `<strong>${chipCount} chip${chipCount > 1 ? 's' : ''} selected</strong><br>` +
                `Image: ${imageName}`;
        } else if (selectedImages.length > 0) {
            // 이미지가 선택된 경우
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
            currentImageInfo.textContent = 'No image or chips selected';
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
                        const labelPath = this.buildClassificationPath(cls);
                        const filesRes = await fetch(`/api/files?path=${encodeURIComponent(labelPath)}`);
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

        // 🔥 Chip 선택 확인 - Chip이 선택된 경우 별도 처리
        const chipCount = this.getSelectedChipCount();
        if (this.classMode === 'chip') {
            if (chipCount === 0) {
                alert('Chip 모드에서는 칩을 선택한 후 라벨을 추가할 수 있습니다.');
                return;
            }
            await this.addChipLabels(finalClassName, newClassName);
            return;
        }

        if (chipCount > 0) {
            // Chip 라벨링 처리 (Wafer 모드에서도 칩 선택 시)
            await this.addChipLabels(finalClassName, newClassName);
            return;
        }

        // 선택된 이미지들 가져오기 (기존 이미지 라벨링 로직)
        const selectedImages = this.getSelectedImagesForModal();

        if (selectedImages.length === 0) {
            alert('Please select at least one image');
            return;
        }

        try {
            // 새 클래스인 경우 먼저 클래스 생성

            if (newClassName) {
                // 🔥 현재 폴더 파라미터 추가
                const apiUrl = this.buildClassApiUrl('/api/classes');
                console.log(`🔍 [ADD_CLASS_NEW] classMode: ${this.classMode}, apiUrl: ${apiUrl}`);

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
                    const labelPath = this.buildClassificationPath(finalClassName);
                    const filesRes = await fetch(`/api/files?path=${encodeURIComponent(labelPath)}`);
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

                const allClasses = (await this.getClassList()).slice().sort();

                // 🔥 모드 파라미터가 포함된 삭제 API URL 생성
                const deleteApiUrl = this.buildClassApiUrl('/api/classify');

                for (const cls of allClasses) {
                    if (cls === finalClassName) continue; // 추가할 클래스는 제외

                    try {
                        // 🔥 현재 제품 폴더를 고려한 라벨 경로 생성
                        const labelPath = this.buildClassificationPath(cls);
                        const filesRes = await fetch(`/api/files?path=${encodeURIComponent(labelPath)}`);
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

                                        image_name: fileName,
                                        mode: this.classMode
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

            // 🔥 모드 파라미터가 포함된 URL
            const apiUrl = this.buildClassApiUrl('/api/classify/batch');

            // 🔥 배치 API로 한 번의 호출로 모든 이미지 처리
            this.debugLog('배치 API로 라벨 추가:', { class: finalClassName, images: imagesToProcess.length });

            const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ class_name: finalClassName, images: imagesToProcess, mode: this.classMode })
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

    async addChipLabels(finalClassName, isNewClass) {
        // 🔥 Chip 라벨링: 선택된 칩들을 크롭하여 저장
        if (!this.chipAnnotator || !this.selectedImagePath) {
            alert('No wafer image loaded');
            return;
        }

        const chipCoords = this.chipAnnotator.getSelectedChipCoords();
        if (!chipCoords || chipCoords.length === 0) {
            alert('No chips selected');
            return;
        }

        try {
            // 새 클래스인 경우 먼저 클래스 생성
            if (isNewClass) {
                const apiUrl = this.buildClassApiUrl('/api/classes');
                console.log(`🔍 [ADD_CLASS_CHIP] classMode: ${this.classMode}, apiUrl: ${apiUrl}`);

                await fetch(apiUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: finalClassName })
                });

                await this.getClassList(true);
            }

            // Chip 크롭 및 저장 API 호출
            const apiUrl = this.buildClassApiUrl('/api/classify/chips');

            console.log(`🔍 [CHIP_LABEL] Cropping ${chipCoords.length} chips for class "${finalClassName}"`);

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    class_name: finalClassName,
                    image_path: this.selectedImagePath,
                    chip_coords: chipCoords,  // [{x_abs, y_abs}, ...]
                    folder_prefix: this.currentFolderPrefix || ''
                })
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Chip labeling failed: ${response.status} - ${errorText}`);
            }

            const result = await response.json();
            const savedCount = result.saved_count || chipCoords.length;

            // Chip 선택 해제
            this.chipAnnotator.clearSelection();

            // 🔥 저장된 chip labels를 다시 로드하여 화면에 바로 mark 표시
            console.log('🔄 [CHIP_LABEL] Reloading chip annotations to show marks...');
            await this.chipAnnotator.loadAnnotations(this.selectedImagePath);

            // 모달 닫기
            this.closeAddLabelModal();

            // UI 업데이트 (Label Explorer)
            console.log('🔄 [CHIP_LABEL] Refreshing Label Explorer...');
            await this.refreshLabelExplorer();

        } catch (error) {
            console.error('Failed to add chip labels:', error);
            alert(`Failed to add chip labels: ${error.message}`);
        }
    }

    // --- LABEL EXPLORER ---

    async refreshLabelExplorer() {
        // 🔥 Label Explorer 새로고침 활성화
        // 🔥 중복 호출 방지
        if (this._isRefreshingLabelExplorer) {
            return;
        }

        this._isRefreshingLabelExplorer = true;

        try {
            const container = document.getElementById('label-explorer-list');

            if (!container) {
                this._isRefreshingLabelExplorer = false;
                return;
            }

        const scrollTop = container.scrollTop;

        // 기존 내용을 임시로 저장하여 스크롤 위치 유지
        const existingContent = container.innerHTML;

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

        // 🔥 최적화: labelManager.classes를 직접 사용 (API 호출 생략, 클래스 목록 유지)
        let classes = [];
        if (this.labelManager && this.labelManager.classes && this.labelManager.classes.length > 0) {
            // 🔥 labelManager.classes를 직접 사용 (이미 로드된 클래스 목록 사용)
            classes = this.labelManager.classes.map(cls => typeof cls === 'string' ? cls : cls.name);
            console.log('🔍 [REFRESH_LABEL_EXPLORER] labelManager.classes 사용:', classes.length, '개');
        } else {
            // 🔥 labelManager.classes가 비어있으면 getClassList() 호출 (최초 로드 시)
            try {
                classes = await this.getClassList();
                console.log('🔍 [REFRESH_LABEL_EXPLORER] getClassList() 호출:', classes.length, '개');
            } catch (error) {
                console.error('❌ [REFRESH_LABEL_EXPLORER] 클래스 조회 오류:', error);
                // 에러 발생 시에도 빈 배열로 계속 진행하여 UI가 깨지지 않도록 함
                classes = [];
            }
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
                        // 🔥 current_folder 복원 제거: buildClassificationPath가 productFolderPath를 직접 사용
                        // 🔥 최상위 폴더에서 특정 제품 폴더의 이미지를 선택한 경우,
                        // current_folder를 변경하지 않고 productFolderPath만 사용하여 경로 생성
                        
                        // 🔥 현재 제품 폴더를 고려한 라벨 경로 생성
                        // 🔥 buildClassificationPath는 productFolderPath를 우선 사용하므로 current_folder 변경 불필요
                        const labelPath = this.buildClassificationPath(cls);
                        
                        // 🔥 디버깅: 로드 주소와 current_folder 로그 출력
                        console.log(`🔍 [REFRESH_LABEL_EXPLORER] 클래스 '${cls}' 폴더 로드`);
                        console.log(`🔍 [REFRESH_LABEL_EXPLORER] 로드 주소: /api/files?path=${encodeURIComponent(labelPath)}`);
                        console.log(`🔍 [REFRESH_LABEL_EXPLORER] labelPath: ${labelPath}`);
                        console.log(`🔍 [REFRESH_LABEL_EXPLORER] currentFolderPath: ${this.currentFolderPath}`);
                        console.log(`🔍 [REFRESH_LABEL_EXPLORER] currentFolderPrefix: ${this.currentFolderPrefix}`);
                        console.log(`🔍 [REFRESH_LABEL_EXPLORER] productFolderPath: ${this.productFolderPath}`);
                        
                        // 🔥 current_folder 확인을 위한 API 호출 (로깅용)
                        try {
                            const currentFolderResponse = await fetch('/api/current-folder');
                            const currentFolderData = await currentFolderResponse.json();
                            console.log(`🔍 [REFRESH_LABEL_EXPLORER] 서버 current_folder: ${currentFolderData.current_folder}`);
                            console.log(`🔍 [REFRESH_LABEL_EXPLORER] 서버 current_folder_prefix: ${currentFolderData.current_folder_prefix}`);
                        } catch (err) {
                            console.error('❌ [REFRESH_LABEL_EXPLORER] current_folder 조회 실패:', err);
                        }
                        
                        const response = await fetch(`/api/files?path=${encodeURIComponent(labelPath)}`, {
                            signal: this.globalAbortController?.signal
                        });
                        
                        // 🔥 로드 완료 후 current_folder 재확인
                        try {
                            const afterResponse = await fetch('/api/current-folder');
                            const afterData = await afterResponse.json();
                            console.log(`🔍 [REFRESH_LABEL_EXPLORER] 로드 후 서버 current_folder: ${afterData.current_folder}`);
                            console.log(`🔍 [REFRESH_LABEL_EXPLORER] 로드 후 서버 current_folder_prefix: ${afterData.current_folder_prefix}`);
                        } catch (err) {
                            console.error('❌ [REFRESH_LABEL_EXPLORER] 로드 후 current_folder 조회 실패:', err);
                        }

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
                    const labelPath = this.buildClassificationPath(cls);
                    const imgRes = await fetch(`/api/files?path=${encodeURIComponent(labelPath)}`);
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

            // 🔥 모드 파라미터가 포함된 URL
            const deleteApiUrl = this.buildClassApiUrl('/api/classify/delete');


            const batchPromises = Object.entries(classToDel).map(async ([cls, images]) => {
                this.debugLog(`🗑️ DELETE 요청: class=${cls}, images=${images.length}개`, images);

                const response = await fetch(deleteApiUrl, {
                    method: 'POST',

                    headers: { 'Content-Type': 'application/json' },

                    body: JSON.stringify({ class: cls, images: images, mode: this.classMode })
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
        }
    }

    renderLabelExplorerContent(container, classes, classToImgList, labelSelection) {
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
                        const labelPath = this.buildClassificationPath(cls);
                        
                        // 🔥 디버깅: 로드 주소와 current_folder 로그 출력
                        console.log(`🔍 [LABEL_EXPLORER_CLICK] 클래스 '${cls}' 폴더 클릭`);
                        console.log(`🔍 [LABEL_EXPLORER_CLICK] 로드 주소: /api/files?path=${encodeURIComponent(labelPath)}`);
                        console.log(`🔍 [LABEL_EXPLORER_CLICK] labelPath: ${labelPath}`);
                        console.log(`🔍 [LABEL_EXPLORER_CLICK] currentFolderPath: ${this.currentFolderPath}`);
                        console.log(`🔍 [LABEL_EXPLORER_CLICK] currentFolderPrefix: ${this.currentFolderPrefix}`);
                        console.log(`🔍 [LABEL_EXPLORER_CLICK] productFolderPath: ${this.productFolderPath}`);
                        
                        // 🔥 current_folder 확인을 위한 API 호출 (로깅용)
                        fetch('/api/current-folder')
                            .then(res => res.json())
                            .then(data => {
                                console.log(`🔍 [LABEL_EXPLORER_CLICK] 서버 current_folder: ${data.current_folder}`);
                                console.log(`🔍 [LABEL_EXPLORER_CLICK] 서버 current_folder_prefix: ${data.current_folder_prefix}`);
                            })
                            .catch(err => {
                                console.error('❌ [LABEL_EXPLORER_CLICK] current_folder 조회 실패:', err);
                            });
                        
                        // 🔥 캐시 무시 - 항상 서버에서 최신 데이터 가져오기
                        fetch(`/api/files?path=${encodeURIComponent(labelPath)}`)
                            .then(res => res.json())
                            .then(data => {
                                const imgList = Array.isArray(data.items) ? data.items : [];

                                // 🔥 캐시 업데이트
                                if (!this.classToImgListCache) this.classToImgListCache = {};
                                this.classToImgListCache[cls] = imgList;

                                this.debugLog(`✅ 폴더 '${cls}' - ${imgList.length}개 이미지 로드 완료`);
                                
                                // 🔥 로드 완료 후 current_folder 재확인
                                fetch('/api/current-folder')
                                    .then(res => res.json())
                                    .then(data => {
                                        console.log(`🔍 [LABEL_EXPLORER_CLICK] 로드 후 서버 current_folder: ${data.current_folder}`);
                                        console.log(`🔍 [LABEL_EXPLORER_CLICK] 로드 후 서버 current_folder_prefix: ${data.current_folder_prefix}`);
                                    })
                                    .catch(err => {
                                        console.error('❌ [LABEL_EXPLORER_CLICK] 로드 후 current_folder 조회 실패:', err);
                                    });

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
                
                // 🔥 숫자를 고려한 오름차순 정렬 (5, 10, 15, 20, 25 순서)
                const sortedImgList = [...imgList].sort((a, b) => {
                    if (a.type !== 'file' || b.type !== 'file') {
                        // 파일이 아닌 항목은 원래 순서 유지
                        return 0;
                    }
                    // 숫자를 고려한 자연 정렬 (natural sort)
                    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
                });

                for (let i = 0; i < sortedImgList.length; ++i) {
                    const img = sortedImgList[i];

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

                                // ✅ Label Explorer용 이미지 리스트 설정 (navigator 지원)
                                this.singleViewImageList = imgList.map(item => item.root_relative);
                                this.naturalSortPaths(this.singleViewImageList);
                                const currentPath = selectedImg.root_relative;
                                this.singleViewImageIndex = this.singleViewImageList.findIndex(p =>
                                    this.normalizePath(p) === this.normalizePath(currentPath)
                                );
                                if (this.singleViewImageIndex === -1) {
                                    this.singleViewImageIndex = 0;
                                }

                                // ✅ viewMode 설정 (네비게이션 지원)
                                this.viewMode = 'single';
                                this.singleImageFromGrid = false;

                                this.loadImage(selectedImg.root_relative, true).then(() => {
                                    // ✅ Navigator 표시 (Label Explorer 이미지 리스트로)
                                    if (this.thumbnailNavigator) {
                                        this.thumbnailNavigator.show();
                                        this.thumbnailNavigator.setImages(this.singleViewImageList, currentPath);
                                    }
                                });  // 🔥 Label Explorer에서 호출 시 저장 안 함
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

                        // 🔥 모드 파라미터가 포함된 URL
                        const deleteApiUrl = this.buildClassApiUrl('/api/classify');

                        let deleteSuccess = true;
                        const failedDeletes = [];

                        for (const key of toDelete) {
                            const [delCls, delImg] = key.split('/');

                            try {
                                const response = await fetch(deleteApiUrl, {
                                method: 'DELETE',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ class_name: delCls, image_name: delImg, mode: this.classMode })
                            });
                                
                                if (!response.ok) {
                                    console.warn(`삭제 실패: ${delImg} (HTTP ${response.status})`);
                                    failedDeletes.push(delImg);
                                    deleteSuccess = false;
                                } else {
                                    console.log(`✅ 삭제 성공: ${delImg}`);
                                }
                            } catch (error) {
                                console.error(`삭제 오류: ${delImg}`, error);
                                failedDeletes.push(delImg);
                                deleteSuccess = false;
                            }
                        }
                        
                        // 삭제가 실패한 경우 UI 업데이트하지 않음
                        if (!deleteSuccess) {
                            console.warn(`일부 파일 삭제 실패 (${failedDeletes.length}개) - UI 업데이트 건너뜀:`, failedDeletes);
                            return;
                        }

                        labelSelection.selected = [];

                        // 해당 클래스의 이미지 리스트만 다시 fetch해서 ul만 갱신

                        // 🔥 현재 제품 폴더를 고려한 라벨 경로 생성
                        const labelPath = this.buildClassificationPath(cls);
                        const imgRes = await fetch(`/api/files?path=${encodeURIComponent(labelPath)}`);
                        const imgData = await imgRes.json();
                        const imgList = Array.isArray(imgData.items) ? imgData.items : [];
                        
                        // 🔥 숫자를 고려한 오름차순 정렬 (5, 10, 15, 20, 25 순서)
                        const sortedImgList = [...imgList].sort((a, b) => {
                            if (a.type !== 'file' || b.type !== 'file') {
                                // 파일이 아닌 항목은 원래 순서 유지
                                return 0;
                            }
                            // 숫자를 고려한 자연 정렬 (natural sort)
                            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
                        });

                        // ul 내부만 갱신

                        imgUl.innerHTML = '';

                        for (let i = 0; i < sortedImgList.length; ++i) {
                            const img = sortedImgList[i];

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

                                        this.loadImage(this.buildClassificationPath(selectedKey));
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

                                // 🔥 모드 파라미터가 포함된 URL
                                const deleteApiUrl = this.buildClassApiUrl('/api/classify');

                                for (const key of toDelete) {
                                    const [delCls, delImg] = key.split('/');

                                    await fetch(deleteApiUrl, {
                                        method: 'DELETE',

                                        headers: { 'Content-Type': 'application/json' },

                                        body: JSON.stringify({ class_name: delCls, image_name: delImg, mode: this.classMode })
                                    });
                                }

                                labelSelection.selected = [];

                                // 🔥 해당 클래스만 업데이트 (전체 새로고침 방지)
                                const deletedClasses = [...new Set(toDelete.map(key => key.split('/')[0]))];
                                
                                for (const cls of deletedClasses) {
                                    // 해당 클래스 캐시 무효화
                                    if (this.classToImgListCache && this.classToImgListCache[cls]) {
                                        delete this.classToImgListCache[cls];
                                    }
                                    
                                    // 해당 클래스 폴더만 다시 로드
                                    const labelPath = this.buildClassificationPath(cls);
                                    
                                    try {
                                        const response = await fetch(`/api/files?path=${encodeURIComponent(labelPath)}`);
                                        const data = await response.json();
                                        const imgList = Array.isArray(data.items) ? data.items : [];
                                        
                                        // 캐시 업데이트
                                        if (!this.classToImgListCache) this.classToImgListCache = {};
                                        this.classToImgListCache[cls] = imgList;
                                        
                                        console.log(`🔄 클래스 '${cls}' 이미지 목록 업데이트: ${imgList.length}개`);
                                    } catch (error) {
                                        console.error(`클래스 '${cls}' 이미지 목록 로드 실패:`, error);
                                    }
                                }
                                
                                // 해당 클래스 섹션만 다시 렌더링
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
        const container = document.getElementById('label-explorer-list');

        if (!container) {
            return;
        }

        const scrollTop = container.scrollTop;

        // 클래스 목록 다시 가져오기
        this.refreshClassList().then(async () => {
            // 🔥 refreshClassList()에서 캐시된 클래스 목록 사용 (중복 API 호출 제거)
            const classes = Array.isArray(this.cachedClassList) ? this.cachedClassList.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())) : [];
            const labelSelection = this.labelSelection;

            // classToImgList 재구성 (이미 로드된 것들만)
            let classToImgList = {};

            for (const cls of classes) {
                classToImgList[cls] = this.classToImgListCache?.[cls] || [];
            }

            // 전체 내용 다시 렌더링
            this.renderLabelExplorerContent(container, classes, classToImgList, labelSelection);
        
        // 스크롤 위치 복원
            container.scrollTop = scrollTop;
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
        // ✅ 방법 1: 모든 가능한 패널 강제 숨기기 (가장 확실)
        const selectorsToHide = [
            '#file-name',
            '#file-name-display', 
            '#detail-file-name',
            '.file-name-panel',
            '#chip-selection',
            '#chip-selection-panel',
            '.chip-selection-panel',
            '#selected-chips-list'
        ];
        
        selectorsToHide.forEach(selector => {
            try {
                const el = document.querySelector(selector);
                if (el) {
                    el.style.display = 'none';
                    el.style.removeProperty('visibility');
                    el.style.removeProperty('opacity');
                    // 디버그 로그 제거
                    // console.log(`✅ [GRID] 숨김 처리: ${selector}`);
                }
            } catch (e) {
                console.warn(`⚠️ [GRID] 선택자 오류: ${selector}`, e);
            }
        });
        
        // ✅ 방법 2: CSS 클래스 활용 (body에 클래스 추가)
        document.body.classList.add('grid-mode-active');
        
        // ✅ 패널 닫기 추가 (맨 앞에)
        this.closeChipSelectionPanel();

        // ✅ Wafer Navigator 숨김 (그리드 모드에서는 표시하지 않음)
        if (this.thumbnailNavigator) {
            this.thumbnailNavigator.hide();
        }

        this.gridMode = true;

        // 🔥 이미지를 이름 순으로 오름차순 정렬 (숫자 자연 정렬 적용)
        const sortedImages = [...images].sort((a, b) => {
            // 파일명만 추출 (경로 제거)
            const nameA = a.split('/').pop();
            const nameB = b.split('/').pop();
            // 🔥 숫자 자연 정렬 (예: 5가 10보다 앞에 옴)
            return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
        });

        this.selectedImages = sortedImages;
        this.currentGridImages = sortedImages;  // 🔥 currentGridImages 업데이트
        if (!this.gridSelectedIdxs) this.gridSelectedIdxs = [];
        
        // ✅ 그리드 모드 진입 시 선택된 웨이퍼 목록 초기화
        this.updateSelectedGridImagesList();
        
        const grid = document.getElementById('image-grid');
        const gridControls = document.getElementById('grid-controls');
        if (gridControls) gridControls.style.display = '';
        const gridColsRange = document.getElementById('grid-cols-range');
        if (gridColsRange) {
            gridColsRange.value = this.gridCols;
            document.documentElement.style.setProperty('--grid-cols', this.gridCols);
        }

        // 🔥 skipSaveState에 따라 스크롤 위치 저장/복원 결정
        const scrollWrapper = grid?.parentElement;  // .grid-scroll-wrapper
        let scrollTopToRestore = null;

        if (skipSaveState) {
            // 🔥 skipSaveState=true: 복원만 수행 (savedViewState에서 스크롤 위치 읽기)
            if (this.savedViewState && this.savedViewState.scrollTop !== undefined) {
                scrollTopToRestore = this.savedViewState.scrollTop;
                console.log('📜 [RESTORE] showGrid에서 스크롤 위치 복원 예정:', scrollTopToRestore);
            }
        } else {
            // 🔥 skipSaveState=false: Wafer Map Explorer - 현재 스크롤 위치 저장
            if (grid && grid.hasAttribute('data-label-explorer-grid')) {
                grid.removeAttribute('data-label-explorer-grid');
            }
            
            const currentScrollTop = scrollWrapper ? scrollWrapper.scrollTop : 0;
            
            this.savedViewState = {
                type: 'grid',
                images: [...sortedImages],  // 🔥 정렬된 이미지를 저장
                scrollTop: currentScrollTop
            };
        }

        // 🔥 그리드를 명시적으로 표시 (display: none에서 복원)
        if (grid) {
            grid.style.display = 'grid';
        }

        // ⭐ Grid 진입 시 단일 이미지 모드 UI 숨기기
        if (this.dom.fileNameDisplay) {
            this.dom.fileNameDisplay.style.display = 'none';
            this.debugLog('🟦 [SHOW_GRID] fileNameDisplay 숨김');
        }
        if (this.dom.chipLabelLegend) {
            this.dom.chipLabelLegend.style.display = 'none';
            this.debugLog('🟦 [SHOW_GRID] chipLabelLegend 숨김');
        }

        // ⭐ 파일명 패널 숨기기 (그리드 모드에서는 불필요)
        if (this.dom.fileNameDisplay) {
            this.dom.fileNameDisplay.style.display = 'none';
        }
        
        // 🔷 추가: 파일명 패널 명시적으로 숨기기 (다양한 선택자로 확인)
        const fileNamePanel = document.querySelector('[id*="file-name"]')
                            || document.querySelector('.file-name-panel')
                            || document.getElementById('file-name-display')
                            || document.getElementById('detail-file-name');
        if (fileNamePanel) {
            fileNamePanel.style.display = 'none';
        }

        const viewControls = document.querySelector('.view-controls');
        if (viewControls) viewControls.style.display = 'none';

        // 🎨 Color Legends 업데이트 (Grid Mode)
        this.showColorLegends();

        // 그리드 모드 클래스 추가 및 요소들 숨기기
        this.dom.viewerContainer.classList.add('grid-mode');
        this.dom.viewerContainer.classList.remove('single-image-mode');
        this.dom.minimapContainer.style.display = 'none';
        this.dom.imageCanvas.style.display = 'none';
        this.dom.overlayCanvas.style.display = 'none';
        
        // ⭐ 그리드 모드에서는 화살표 버튼 숨기기
        this.viewMode = null;
        this.updateArrowButtonVisibility();
        this.debugLog('🟦 [SHOW_GRID] 화살표 버튼 숨김');

        grid.innerHTML = '';
        // 🔥 DOM 재생성 시 캐시 초기화 (드래그 선택 정상 작동 위해 필수)
        this.gridThumbWraps = [];
        // grid 모드에서는 cursor를 default로
        this.dom.viewerContainer.style.cursor = 'default';
        this.showGridImmediately(sortedImages);
        setTimeout(() => {
            this.loadCurrentFolderThumbnails(sortedImages);
        }, 100);
        grid.classList.add('active');
        setTimeout(() => this.updateGridSquaresPixel(), 0);
        if (!this.gridResizeObserver) {
            this.gridResizeObserver = new ResizeObserver(() => this.updateGridSquaresPixel());
            this.gridResizeObserver.observe(grid);
        }
        
        // ⭐ 최종 확인: 모든 칩 선택 패널 강제 숨기기 (방법 2)
        setTimeout(() => {
            const chipPanels = [
                document.getElementById('chip-selection-panel'),
                document.getElementById('selected-chips-list'),
                ...Array.from(document.querySelectorAll('[id*="chip-selection"]')),
                ...Array.from(document.querySelectorAll('[class*="chip-selection"]')),
                ...Array.from(document.querySelectorAll('[id*="selected-chips"]')),
                ...Array.from(document.querySelectorAll('[class*="selected-chips"]'))
            ];
            
            chipPanels.forEach(el => {
                if (el) {
                    el.style.display = 'none';
                    el.style.visibility = 'hidden';
                    el.style.pointerEvents = 'none';
                }
            });
            // 디버그 로그 제거 (너무 자주 출력됨)
        }, 100);

        // 🔥 그리드 재생성 후 레이아웃 캐시 무효화 (드래그 영역 재계산용)
        this.invalidateGridGeometry();
        
        // 🔥 스크롤 위치 복원 (skipSaveState=true일 때만)
        if (skipSaveState && scrollTopToRestore !== null && scrollWrapper) {
            // 그리드 렌더링 완료 후 스크롤 위치 복원
            const restoreScroll = () => {
                // grid가 다시 생성되었으므로 scrollWrapper 다시 찾기
                const currentScrollWrapper = document.querySelector('.grid-scroll-wrapper');
                if (currentScrollWrapper) {
                    currentScrollWrapper.scrollTop = scrollTopToRestore;
                    console.log('📜 [RESTORE] 스크롤 위치 복원 완료:', scrollTopToRestore);
                    return true;
                }
                return false;
            };
            
            // 여러 번 시도 (DOM 렌더링 대기)
            requestAnimationFrame(() => {
                if (!restoreScroll()) {
                    setTimeout(() => {
                        if (!restoreScroll()) {
                            setTimeout(restoreScroll, 300);
                        }
                    }, 150);
                }
            });
        }
        
        // 🔥 Grid 스크롤 시 savedViewState 자동 업데이트 (Wafer Map Explorer에서만)
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
            // 🔥 이미지 경로를 data-path에 저장 (체크박스 변경 시 경로 추출용)
            wrap.dataset.path = imgPath;
            // 클릭 이벤트는 onMouseUp에서 처리하므로 여기서는 제거
            // wrap.onclick = e => { e.stopPropagation(); this.toggleGridImageSelect(idx, e); };
            wrap.ondblclick = e => { e.stopPropagation(); this.enterGridImageViewMode(idx); };
            
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

            const personalizedParams = this.getPersonalizedParams();
            // ✅ 캐시 버스터 추가 (색상 스킴 변경 시 새로운 썸네일 요청)
            const cacheBuster = this._personalizedColorCacheBuster || Date.now();
            const thumbnailUrl = `/api/thumbnail?path=${encodeURIComponent(imgPath)}&size=512${personalizedParams}&_t=${cacheBuster}`;

            // 🔥 data-src에 URL 저장 (스크롤 디바운스용)
            img.dataset.src = thumbnailUrl;

            // 🔥 초기 로드: 즉시 src에 할당 (화면 뜨자마자 로드)
            img.src = thumbnailUrl;

            thumbBox.appendChild(img);
            wrap.appendChild(thumbBox);
            // 파일명 (확장자 제거)
            const label = document.createElement('div');
            label.className = 'grid-thumb-label';
            const fileName = imgPath.split('/').pop();
            label.textContent = fileName.replace(/\.[^.]+$/, '');
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

    /**
     * 🔥 그리드 스크롤 핸들러 (디바운스: 0.1초 후 실행)
     */
    handleGridScroll() {
        // 스크롤 중임을 표시
        this.isGridScrolling = true;

        // 기존 타이머 클리어
        if (this.gridScrollDebounceTimer) {
            clearTimeout(this.gridScrollDebounceTimer);
        }

        // 0.1초 (100ms) 후 실행
        this.gridScrollDebounceTimer = setTimeout(() => {
            this.isGridScrolling = false;
            // 🔥 스크롤이 멈춘 후 현재 뷰포트의 썸네일만 로드
            this.loadVisibleGridThumbnails();
        }, 100);
    }

    /**
     * 🔥 현재 뷰포트에 보이는 그리드 썸네일만 즉시 로드
     */
    loadVisibleGridThumbnails() {
        const grid = document.getElementById('image-grid');
        const scrollWrapper = document.getElementById('image-grid-scroll-wrapper');

        if (!grid || !scrollWrapper) return;

        const thumbnails = grid.querySelectorAll('.grid-thumb-img[data-src]');
        const scrollRect = scrollWrapper.getBoundingClientRect();

        thumbnails.forEach((img) => {
            const imgRect = img.getBoundingClientRect();

            // 🔥 뷰포트에 보이는지 확인
            const isVisible = (
                imgRect.top < scrollRect.bottom &&
                imgRect.bottom > scrollRect.top &&
                imgRect.left < scrollRect.right &&
                imgRect.right > scrollRect.left
            );

            if (isVisible && img.dataset.src) {
                // 즉시 로드
                const src = img.dataset.src;
                if (img.src !== src) {
                    img.src = src;
                }
                // data-src 제거 (중복 로드 방지)
                delete img.dataset.src;
            }
        });
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
        
        // ✅ 방법 2: CSS 클래스 제거 (body에서 클래스 제거)
        document.body.classList.remove('grid-mode-active');
        
        // ✅ 선택된 웨이퍼 목록 패널 숨기기
        const panel = document.getElementById('selected-grid-images-panel');
        if (panel) {
            panel.style.display = 'none';
        }
        
        // ✅ 그리드 숨길 때는 chip selection을 유지 (단일 이미지 모드에서 사용)
        // viewMode가 null이면 chip selection도 숨김
        if (!this.viewMode || (this.viewMode !== 'single' && this.viewMode !== 'gridImage')) {
            const chipSelectionPanel = document.getElementById('chip-selection-panel');
            if (chipSelectionPanel) {
                chipSelectionPanel.style.display = 'none';
            }
            
            const selectedChipsList = document.getElementById('selected-chips-list');
            if (selectedChipsList) {
                selectedChipsList.style.display = 'none';
            }
        }

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

    // ✅ Chip Selection 패널 완전히 닫기
    closeChipSelectionPanel() {
        // 1. chip-selection-panel 숨기기
        const chipSelectionPanel = document.getElementById('chip-selection-panel');
        if (chipSelectionPanel) {
            chipSelectionPanel.style.display = 'none';
        }
        
        // 2. selected-chips-list 숨기기  
        const chipSelectionList = document.getElementById('selected-chips-list');
        if (chipSelectionList) {
            chipSelectionList.style.display = 'none';
        }
        
        // ✅ 추가: 모든 가능한 칩 선택 패널 강제 숨기기
        const allChipSelectionSelectors = [
            '#chip-selection-panel',
            '#selected-chips-list',
            '.chip-selection-panel',
            '.selected-chips-list',
            '[id*="chip-selection"]',
            '[class*="chip-selection"]',
            '[id*="selected-chips"]',
            '[class*="selected-chips"]'
        ];
        
        allChipSelectionSelectors.forEach(selector => {
            try {
                const elements = document.querySelectorAll(selector);
                elements.forEach(el => {
                    if (el) {
                        el.style.display = 'none';
                        el.style.visibility = 'hidden';
                        el.style.pointerEvents = 'none';
                    }
                });
            } catch (e) {
                // 무시
            }
        });
        
        // 3. ChipAnnotator 선택 해제 (⚠️ 주의: updateSelectedChipsList는 호출 안 함 - 재생성 방지)
        if (this.chipAnnotator) {
            if (typeof this.chipAnnotator.clearSelection === 'function') {
                this.chipAnnotator.clearSelection(false); // notifyViewer = false
            }
            // ❌ updateSelectedChipsList는 호출하지 않음 (재생성 방지)
        }
        
        // 🔥 추가: overlay canvas도 숨기기 (chip 선택 시각화 제거)
        if (this.dom.overlayCanvas) {
            this.dom.overlayCanvas.style.display = 'none';
        }
    }

    // 🔥 그리드 모드 활성화 (GridManager에서 호출)
    showGridMode() {
        // ✅ 방법 1: 모든 가능한 패널 강제 숨기기
        const selectorsToHide = [
            '#file-name',
            '#file-name-display', 
            '#detail-file-name',
            '.file-name-panel',
            '#chip-selection',
            '#chip-selection-panel',
            '.chip-selection-panel',
            '#selected-chips-list'
        ];
        
        selectorsToHide.forEach(selector => {
            try {
                const el = document.querySelector(selector);
                if (el) {
                    el.style.display = 'none';
                    el.style.removeProperty('visibility');
                    el.style.removeProperty('opacity');
                }
            } catch (e) {
                console.warn(`⚠️ [GRID] 선택자 오류: ${selector}`, e);
            }
        });
        
        // ✅ 방법 2: CSS 클래스 활용
        document.body.classList.add('grid-mode-active');
        
        this.gridMode = true;
        
        // ✅ Chip Selection 패널 완전히 닫기
        this.closeChipSelectionPanel();
        
        const grid = document.getElementById('image-grid');
        const gridControls = document.getElementById('grid-controls');
        if (gridControls) gridControls.style.display = '';
        
        // 그리드 컨트롤 표시
        this.dom.viewerContainer.classList.add('grid-mode');
        this.dom.viewerContainer.classList.remove('single-image-mode');
        this.dom.minimapContainer.style.display = 'none';
        this.dom.imageCanvas.style.display = 'none';
        this.dom.overlayCanvas.style.display = 'none';
        
        // ⭐ 그리드 모드에서는 화살표 버튼 숨기기
        this.viewMode = null;
        this.updateArrowButtonVisibility();
        
        // ⭐ 파일명 패널 숨기기 (다양한 선택자로 확인)
        if (this.dom.fileNameDisplay) {
            this.dom.fileNameDisplay.style.display = 'none';
            console.log('🔷 [GRID] fileNameDisplay 숨김');
        }
        
        // 🔷 추가: 파일명 패널 명시적으로 숨기기
        const fileNamePanel = document.querySelector('[id*="file-name"]')
                            || document.querySelector('.file-name-panel')
                            || document.getElementById('file-name-display')
                            || document.getElementById('detail-file-name');
        if (fileNamePanel) {
            fileNamePanel.style.display = 'none';
        }
        
        // ⭐ Chip Labels 숨기기
        if (this.dom.chipLabelLegend) {
            this.dom.chipLabelLegend.style.display = 'none';
            console.log('🔷 [GRID] chipLabelLegend 숨김');
        }
        
        // ⭐ currentImage 초기화
        this.currentImage = null;
        this.currentImageBitmap = null;
        this.selectedImagePath = '';
        
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
        
        // ✅ 키보드 화살표 좌우로 prev/next 이미지 기능 추가
        this.setupDetailModeNavigation();
    }
    
    // 🔥 상세 보기 모드 종료 (ESC/더블클릭)
    exitDetailMode() {
        console.log('🚪 [EXIT] 상세 보기 모드 종료');
        
        // ✅ 키보드 이벤트 리스너 제거
        if (this.boundDetailModeNavigationHandler) {
            document.removeEventListener('keydown', this.boundDetailModeNavigationHandler);
            this.boundDetailModeNavigationHandler = null;
        }
        
        this.detailMode = false;
        this.detailImagePath = null;
        
        // 🔥 저장된 상태 복원
        this.restoreWaferMapExplorerState();
    }
    
    /**
     * ✅ 상세 보기 모드에서 키보드 화살표 좌우로 prev/next 이미지 기능
     */
    setupDetailModeNavigation() {
        // ✅ 기존 리스너 제거 (중복 방지)
        if (this.boundDetailModeNavigationHandler) {
            document.removeEventListener('keydown', this.boundDetailModeNavigationHandler);
            this.boundDetailModeNavigationHandler = null;
        }
        
        // ← → 키보드 네비게이션
        document.addEventListener('keydown', this.boundDetailModeNavigationHandler = (e) => {
            if (!this.detailMode) return;
            
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                e.stopPropagation();
                this.navigateDetailModeImage(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                e.stopPropagation();
                this.navigateDetailModeImage(1);
            }
        });
    }
    
    /**
     * ✅ 상세 보기 모드에서 이미지 네비게이션
     * @param {number} direction -1 (이전), 1 (다음)
     */
    navigateDetailModeImage(direction) {
        if (!this.detailMode) {
            console.warn('⚠️ [NAV] Not in detail mode');
            return;
        }
        
        // ✅ grid 모드에서 온 경우 gridViewImageList 사용
        if (this.gridViewImageList && this.gridViewImageList.length > 0) {
            const currentIdx = this.findImageIndexInList(
                this.detailImagePath,
                this.gridViewImageList
            );
            
            if (currentIdx === -1) {
                console.warn('⚠️ [NAV] Current image not found in gridViewImageList');
                return;
            }
            
            let nextIdx = currentIdx + direction;
            if (nextIdx < 0) {
                nextIdx = this.gridViewImageList.length - 1;
            } else if (nextIdx >= this.gridViewImageList.length) {
                nextIdx = 0;
            }
            
            const nextImagePath = this.gridViewImageList[nextIdx];
            if (nextImagePath) {
                this.gridViewImageIndex = nextIdx;
                this.loadImage(nextImagePath).then(() => {
                    // ✅ pyramid level을 즉시 동기적으로 업데이트
                    this.updatePyramidLevel();
                    this.detailImagePath = nextImagePath;
                });
            }
            return;
        }
        
        // ✅ 파일 탐색기 모드에서 온 경우 singleViewImageList 사용
        if (this.singleViewImageList && this.singleViewImageList.length > 0) {
            if (this.singleViewImageIndex === -1) {
                this.singleViewImageIndex = this.singleViewImageList.findIndex(
                    path => this.normalizePath(path) === this.normalizePath(this.detailImagePath)
                );
            }
            
            if (this.singleViewImageIndex === -1) {
                console.warn('⚠️ [NAV] Current image not found in singleViewImageList');
                return;
            }
            
            let nextIdx = this.singleViewImageIndex + direction;
            if (nextIdx < 0) {
                nextIdx = this.singleViewImageList.length - 1;
            } else if (nextIdx >= this.singleViewImageList.length) {
                nextIdx = 0;
            }
            
            const nextImagePath = this.singleViewImageList[nextIdx];
            if (nextImagePath) {
                this.singleViewImageIndex = nextIdx;
                this.loadImage(nextImagePath).then(() => {
                    // ✅ pyramid level을 즉시 동기적으로 업데이트
                    this.updatePyramidLevel();
                    this.detailImagePath = nextImagePath;
                });
            }
            return;
        }
        
        console.warn('⚠️ [NAV] No image list available for navigation');
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
        
        // ✅ 선택된 웨이퍼 목록 업데이트
        this.updateSelectedGridImagesList();
    }

    /**
     * 그리드 모드에서 선택된 웨이퍼 목록 업데이트
     */
    updateSelectedGridImagesList() {
        const selectedList = [];

        // 선택된 인덱스들 반복
        if (this.gridSelectedIdxs && Array.isArray(this.gridSelectedIdxs) && this.currentGridImages) {
            for (const idx of this.gridSelectedIdxs) {
                if (idx >= 0 && idx < this.currentGridImages.length) {
                    const imagePath = this.currentGridImages[idx];
                    const fileName = imagePath.split('/').pop(); // 파일명 추출

                    // ✅ '_'로 split
                    const parts = fileName.split('_');

                    // ✅ 인덱스 0과 2 추출
                    let index0 = parts[0] || '';      // wafer
                    let index2 = parts[2] ? parts[2].replace(/\.(png|jpg|jpeg|gif)$/i, '') : ''; // 5mb

                    if (index0 && index2) {
                        // 중복 처리를 위해 imagePath도 포함
                        selectedList.push({ index0, index2, imagePath });
                    }
                }
            }
        }

        this.displaySelectedGridImages(selectedList);
    }

    /**
     * 선택된 웨이퍼 목록 표시
     */
    displaySelectedGridImages(selectedList) {
        const panel = document.getElementById('selected-grid-images-panel');
        const listDiv = document.getElementById('selected-grid-list');
        const countBadge = document.getElementById('selected-count-badge');
        
        if (!panel || !listDiv) {
            return;
        }
        
        if (selectedList.length === 0) {
            panel.style.display = 'none';
            listDiv.innerHTML = '';
            if (countBadge) countBadge.textContent = '0';
            return;
        }
        
        // 중복 제거 (파일명 전체 기준)
        const unique = Array.from(
            new Map(selectedList.map(item => [item.imagePath, item])).values()
        );
        
        // ✅ 개수 표시
        if (countBadge) {
            countBadge.textContent = `${unique.length}`;
        }
        
        // ✅ 최대 10개만 표시 (최근 추가된 것이 아래에 보이도록)
        // 전체 목록은 유지하되, 화면에는 최근 10개만 표시
        const displayItems = unique.slice(-10); // 마지막 10개
        const startIndex = unique.length - displayItems.length; // 시작 인덱스
        
        // ✅ 번호 + 값 표시
        const html = displayItems
            .map((item, idx) => {
                const actualIndex = startIndex + idx; // 실제 번호 (전체 목록 기준)
                // 안전하게 이스케이프
                const safePath = item.imagePath.replace(/'/g, "\\'");

                return `<div onclick="if(typeof viewer !== 'undefined') viewer.removeWaferFromSelectionByPath('${safePath}')" style="padding: 6px 10px; border-bottom: 1px solid rgba(255,255,255,0.04); cursor: pointer; color: #a0a0a0; font-size: 11px; font-family: 'Courier New', monospace; font-weight: 400; white-space: nowrap; transition: all 0.15s; background: rgba(30,30,30,0.5); display: flex; justify-content: space-between; align-items: center; gap: 8px;" onmouseover="this.style.background='rgba(50,100,180,0.25)'; this.style.color='#fff'" onmouseout="this.style.background='rgba(30,30,30,0.5)'; this.style.color='#a0a0a0'">
                    <span>${actualIndex + 1}</span>
                    <span>${item.index0} ${item.index2}</span>
                    <span style="opacity: 0.4; font-size: 9px; margin-left: auto;">✕</span>
                </div>`;
            })
            .join('');
        
        listDiv.innerHTML = html;
        panel.style.display = 'block';
        
        // ✅ 스크롤을 맨 아래로 (최근 추가된 것이 보이도록)
        setTimeout(() => {
            listDiv.scrollTop = listDiv.scrollHeight;
        }, 0);
        
        // ✅ 복사용 데이터 저장 (전체 목록)
        this.selectedWafersForCopy = unique;
    }

    /**
     * 파일 경로로 웨이퍼 선택 해제
     * 목록에서 클릭 시 해당 웨이퍼만 정확히 제거
     */
    removeWaferFromSelectionByPath(imagePath) {
        if (!this.gridMode || !this.currentGridImages) return;

        // 해당 파일의 인덱스 찾기
        const idx = this.currentGridImages.indexOf(imagePath);
        if (idx === -1) return;

        // 선택에서 제거
        if (this.gridSelectedSet) {
            this.gridSelectedSet.delete(idx);
        }
        const pos = this.gridSelectedIdxs.indexOf(idx);
        if (pos > -1) {
            this.gridSelectedIdxs.splice(pos, 1);
        }

        // UI 업데이트
        this.updateGridSelection();

        console.log(`🗑️ [WAFER_SELECTION] Removed: ${imagePath.split('/').pop()}, Remaining: ${this.gridSelectedIdxs.length}개`);
    }

    /**
     * ✅ 복사 버튼: 인덱스 0과 2를 탭으로 분리해서 복사
     */
    copySelectedWafers(event) {
        if (!this.selectedWafersForCopy || this.selectedWafersForCopy.length === 0) {
            console.warn('⚠️ [COPY] No wafers selected');
            return;
        }
        
        // ✅ 인덱스 0과 2를 탭으로 분리해서 복사
        const copyText = this.selectedWafersForCopy
            .map(w => `${w.index0}\t${w.index2}`)
            .join('\n');
        
        // 클립보드 복사
        navigator.clipboard.writeText(copyText).then(() => {
            console.log('✅ [COPY] Copied to clipboard:', copyText);
            
            // ✅ 복사 완료 메시지
            const copyBtn = event.target;
            const originalText = copyBtn.textContent;
            copyBtn.textContent = '✓ 복사됨';
            copyBtn.style.color = '#4caf50';
            
            setTimeout(() => {
                copyBtn.textContent = originalText;
                copyBtn.style.color = '#909090';
            }, 1500);
        }).catch(err => {
            console.error('❌ [COPY] Copy failed:', err);
        });
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
        // ✅ 화살표가 표시 중인지 확인
        const wasShowingArrow = this.viewMode === 'single' || this.viewMode === 'gridImage';
        
        // ✅ 상태 완전 초기화
        this.viewMode = null;
        this.gridSelectedIdxs = [];
        if (this.gridSelectedSet) {
            this.gridSelectedSet.clear();
        }
        this.selectedImages = [];
        this.singleImageFromGrid = false;
        this._isNavigating = false;
        this.gridViewImageList = [];
        this.gridViewImageIndex = -1;
        this.gridViewSaveState = null;
        
        // ✅ 화살표 숨김
        this.updateArrowButtonVisibility();
        
        // ✅ UI 업데이트
        const grid = document.getElementById('image-grid');
        if (grid) {
            const selectedWraps = grid.querySelectorAll('.grid-thumb-wrap.selected');
            selectedWraps.forEach(wrap => wrap.classList.remove('selected'));
        }

        this.gridLastClickedIdx = undefined;

        // ✅ 선택된 웨이퍼 목록 업데이트 (빈 목록)
        this.updateSelectedGridImagesList();
        
        // ✅ 이미지 캔버스 숨김
        this.hideImage();
        
        console.log('✅ [CLEAR] 선택 해제 완료', wasShowingArrow ? '(화살표 숨김)' : '(화살표 없음)');
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

            // ✅ 선택된 웨이퍼 목록 업데이트
            this.updateSelectedGridImagesList();

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

    /**
     * ✅ 파일 탐색기에서 단일 이미지 선택 → 단일보기 모드 진입
     * @param {string} imagePath 클릭한 이미지 경로
     */
    async enterSingleViewMode(imagePath) {
        console.log('✅ [SINGLE_VIEW] ENTER Single View Mode:', imagePath);

        // ✅ 네비게이션 큐 리셋
        this._isNavigating = false;
        this._pendingNavDirection = 0;

        // ✅ viewMode 설정
        this.viewMode = 'single';
        this.singleImageFromGrid = false;
        
        // ✅ 파일명과 경로에서 폴더 추출 (윈도우 백슬래시도 처리)
        const normalizedImagePath = imagePath.replace(/\\/g, '/');
        const lastSlash = Math.max(imagePath.lastIndexOf('/'), imagePath.lastIndexOf('\\'));
        const folderPath = lastSlash >= 0 ? imagePath.substring(0, lastSlash) : '';
        const fileName = lastSlash >= 0 ? imagePath.substring(lastSlash + 1) : imagePath;
        
        console.log('✅ [SINGLE_VIEW] Folder:', folderPath, 'File:', fileName);
        
        // ✅ 같은 폴더의 모든 이미지 목록 가져오기
        try {
            console.log('✅ [SINGLE_VIEW] Fetching folder contents:', folderPath);
            const response = await fetch(`/api/files?path=${encodeURIComponent(folderPath)}`);
            const data = await response.json();

            console.log('✅ [SINGLE_VIEW] API Response:', {
                totalItems: data.items ? data.items.length : 0,
                items: data.items ? data.items.slice(0, 10) : []
            });

            // 이미지 파일만 필터링
            this.singleViewImageList = (data.items || [])
                .filter(item => {
                    const isFile = item.type === 'file';
                    const isImage = this.isImageFile(item.name);
                    console.log('🔍 [FILTER]', item.name, '| isFile:', isFile, '| isImage:', isImage);
                    return isFile && isImage;
                })
                .map(item => {
                    // 경로 정규화: path가 있으면 사용, 없으면 폴더 경로 + 파일명
                    if (item.path) {
                        console.log('🔍 [MAP] Using item.path:', item.path);
                        return item.path;
                    } else {
                        const fullPath = folderPath ? `${folderPath}/${item.name}` : item.name;
                        console.log('🔍 [MAP] Building fullPath:', fullPath);
                        return fullPath;
                    }
                });

            console.log('✅ [SINGLE_VIEW] 필터링 후 이미지 리스트:', this.singleViewImageList);

            // ✅ 자연 정렬 (파일명 기준: 5 < 10 < 15)
            this.naturalSortPaths(this.singleViewImageList);

            console.log('✅ [SINGLE_VIEW] 정렬 후 이미지 리스트:', this.singleViewImageList);

        // ✅ 현재 이미지의 인덱스 찾기 (경로 정규화 후 비교)
            console.log('✅ [SINGLE_VIEW] 찾을 이미지 경로 (normalized):', normalizedImagePath);

            this.singleViewImageIndex = this.singleViewImageList.findIndex(f => {
                const normalized = f.replace(/\\/g, '/');
                const match = normalized === normalizedImagePath || normalized.endsWith(normalizedImagePath) || normalizedImagePath.endsWith(normalized);
                console.log('🔍 [FIND] 비교:', normalized, '==', normalizedImagePath, '| match:', match);
                return match;
            });

            console.log('✅ [SINGLE_VIEW] Single View Images Found', {
                totalCount: this.singleViewImageList.length,
                currentIndex: this.singleViewImageIndex,
                currentImage: imagePath,
                folderPath: folderPath,
                imageList: this.singleViewImageList.slice(0, 5) // 처음 5개만 로그
            });

            if (this.singleViewImageIndex === -1) {
                console.warn('⚠️ [SINGLE_VIEW] 현재 이미지를 폴더 목록에서 찾을 수 없습니다.');
                // 경로가 정확히 일치하지 않으면 파일명으로 다시 찾기
                const fileNameOnly = fileName.toLowerCase();
                console.log('🔍 [SINGLE_VIEW] 파일명으로 재검색:', fileNameOnly);

                this.singleViewImageIndex = this.singleViewImageList.findIndex(f => {
                    const fName = f.split('/').pop().toLowerCase();
                    console.log('🔍 [FIND_BY_NAME] 비교:', fName, '==', fileNameOnly);
                    return fName === fileNameOnly;
                });

                if (this.singleViewImageIndex === -1) {
                    // 🔥 리스트를 덮어쓰지 말고 목록 맨 앞에 추가
                    console.warn('⚠️ [SINGLE_VIEW] 파일명으로도 찾기 실패, 목록 맨 앞에 추가');
                    console.log('🔍 [SINGLE_VIEW] 기존 리스트 개수:', this.singleViewImageList.length);
                    this.singleViewImageList.unshift(imagePath);  // 맨 앞에 추가
                    this.singleViewImageIndex = 0;
                    console.log('✅ [SINGLE_VIEW] 추가 후 리스트 개수:', this.singleViewImageList.length);
                }
            }
            
            // 그리드 숨기기
            this.hideGrid();

            // ✅ 화살표 버튼 표시
            this.updateArrowButtonVisibility();

            // ✅ 키보드 이벤트 핸들러 설정 (ESC, ← →)
            // 기존 핸들러 제거
            if (this.boundSingleViewHandler) {
                document.removeEventListener('keydown', this.boundSingleViewHandler);
            }

            // ✅ 그리드 네비게이션 핸들러도 제거 (gridImage 모드가 아니므로)
            if (this.boundGridNavigationHandler) {
                document.removeEventListener('keydown', this.boundGridNavigationHandler);
                this.boundGridNavigationHandler = null;
            }

            document.addEventListener('keydown', this.boundSingleViewHandler = (e) => {
                if (this.detailMode && e.key === 'Escape') {
                    this.exitDetailMode();
                    return;
                }

                if (e.key === 'Escape') {
                    this.exitSingleImageViewMode();
                } else if (e.key === 'ArrowLeft') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.navigatePrevious();
                } else if (e.key === 'ArrowRight') {
                    e.preventDefault();
                    e.stopPropagation();
                    this.navigateNext();
                }
            });

            // ✅ imageCanvas 더블클릭 핸들러 설정 (파일탐색기 모드)
            if (this.dom.imageCanvas) {
                this.dom.imageCanvas.ondblclick = (e) => {
                    e.stopPropagation();
                    console.log('🖱️ [DBLCLICK] 이미지 캔버스 더블클릭 (파일탐색기 모드):', {
                        viewMode: this.viewMode
                    });

                    if (this.viewMode === 'single') {
                        console.log('🖱️ [DBLCLICK] → 파일탐색기 모드: 2번 이동');
                        this.handleDoubleClickNavigation();
                    }
                };
            }

            this.selectedImagePath = imagePath;

            console.log('✅ [SINGLE_VIEW] 이미지 로드 시작:', imagePath);

            // ✅ 이미지 로드 (try-catch로 감싸서 에러 처리)
            try {
                await this.loadImage(imagePath);
                console.log('✅ [SINGLE_VIEW] 이미지 로드 완료');
            } catch (loadError) {
                console.error('❌ [SINGLE_VIEW] 이미지 로드 실패:', loadError);
                // 로드 실패해도 계속 진행
            }

            // 🔥 Navigator 표시 (이미지 로드 성공 여부와 무관하게 항상 표시)
            console.log('✅ [SINGLE_VIEW] Navigator 표시 시작');
            if (this.thumbnailNavigator) {
                console.log('✅ [SINGLE_VIEW] thumbnailNavigator 존재 확인');
                try {
                    this.thumbnailNavigator.show();
                    console.log('✅ [SINGLE_VIEW] Navigator.show() 호출 완료');
                    this.thumbnailNavigator.setImages(this.singleViewImageList, imagePath);
                    console.log('✅ [NAVIGATOR] 표시 완료 - 이미지 개수:', this.singleViewImageList.length);
                } catch (navError) {
                    console.error('❌ [NAVIGATOR] 표시 실패:', navError);
                }
            } else {
                console.error('❌ [SINGLE_VIEW] thumbnailNavigator가 없습니다!');
            }

            console.log('✅ [SINGLE_VIEW] 단일 보기 모드 설정 완료', {
                viewMode: this.viewMode,
                imageCount: this.singleViewImageList.length,
                currentIndex: this.singleViewImageIndex,
                currentImage: imagePath
            });
        } catch (error) {
            console.error('❌ [SINGLE_VIEW] 폴더 목록 가져오기 실패:', error);
            console.error('❌ [SINGLE_VIEW] Error stack:', error.stack);

            // 실패 시 현재 이미지만 로드
            this.singleViewImageList = [imagePath];
            this.singleViewImageIndex = 0;
            this.viewMode = 'single';

            this.hideGrid();
            this.updateArrowButtonVisibility();

            console.log('✅ [SINGLE_VIEW] 에러 처리: 이미지 로드 시작');

            // ✅ 이미지 로드
            try {
                await this.loadImage(imagePath);
                console.log('✅ [SINGLE_VIEW] 에러 처리: 이미지 로드 완료');
            } catch (loadError) {
                console.error('❌ [SINGLE_VIEW] 에러 처리: 이미지 로드 실패:', loadError);
            }

            // 🔥 Navigator 표시 (에러 상황에서도 표시)
            console.log('✅ [SINGLE_VIEW] 에러 처리: Navigator 표시 시작');
            if (this.thumbnailNavigator) {
                console.log('✅ [SINGLE_VIEW] 에러 처리: thumbnailNavigator 존재 확인');
                try {
                    this.thumbnailNavigator.show();
                    console.log('✅ [SINGLE_VIEW] 에러 처리: Navigator.show() 호출 완료');
                    this.thumbnailNavigator.setImages(this.singleViewImageList, imagePath);
                    console.log('✅ [NAVIGATOR] 에러 처리: 표시 완료 - 이미지 개수:', this.singleViewImageList.length);
                } catch (navError) {
                    console.error('❌ [NAVIGATOR] 에러 처리: 표시 실패:', navError);
                }
            } else {
                console.error('❌ [SINGLE_VIEW] 에러 처리: thumbnailNavigator가 없습니다!');
            }
        }
    }

    /**
     * 그리드 모드에서 더블클릭 시: 선택된 이미지들로 단일 뷰 모드 진입
     * @param {number} idx 그리드에서 더블클릭한 이미지 인덱스
     */
    enterGridImageViewMode(idx) {
        // 하위 호환성을 위해 enterSingleImageMode로도 호출 가능
        this.enterSingleImageMode(idx);
    }
    
    enterSingleImageMode(idx) {
        console.log('[ENTER_SINGLE] Index:', idx);

        // ✅ 네비게이션 큐 리셋
        this._isNavigating = false;
        this._pendingNavDirection = 0;

        // viewMode를 'gridImage'로 설정
        this.viewMode = 'gridImage';
        this.singleImageFromGrid = true;

        const currentImages = this.currentGridImages;
        this.selectedImages = currentImages;
        this.gridViewImageList = [...currentImages];

        const normalizedCurrent = this.normalizePath(this.selectedImages[idx]);
        const actualGridIndex = currentImages.findIndex(img => {
            const normalizedImg = this.normalizePath(img);
            return normalizedImg === normalizedCurrent;
        });

        this.gridViewImageIndex = actualGridIndex !== -1 ? actualGridIndex : idx;

        console.log('[ENTER_SINGLE] gridViewImageIndex:', this.gridViewImageIndex);

        // ✅ 즉시 selectedImagePath 설정 (네비게이션 인덱스 계산에 필요)
        this.selectedImagePath = this.selectedImages[idx];

        // 1. Arrow button 표시
        this.updateArrowButtonVisibility();

        // 2. 키보드 좌우 키 네비게이션 설정
        this.setupGridImageNavigation();

        // 3. 그리드 숨김
        this.hideGrid(false);

        // 4. 이미지 로드
        this.loadImage(this.selectedImages[idx]).then(() => {
            // 5. Chip selection 업데이트
            if (this.chipAnnotator) {
                this.chipAnnotator.updateSelectedChipsList();
            }

            // 6. Wafer Navigator 자동 표시 및 업데이트 (그리드 목록)
            if (this.thumbnailNavigator) {
                this.thumbnailNavigator.show();
                this.thumbnailNavigator.setImages(this.gridViewImageList, this.selectedImages[idx]);
            }

            console.log('[ENTER_SINGLE] Ready');
        }).catch(error => {
            console.error('[ENTER_SINGLE] Error:', error);
        });
    }

    /**
     * 단일 이미지 뷰 모드 종료 (ESC 또는 X)
     * viewMode에 따라 분기: 'gridImage' → 그리드 복귀, 'single' → 파일 탐색기로
     */
    exitSingleImageViewMode() {
        // ✅ 하위 호환성 체크
        if (!this.viewMode) {
            if (!this.singleImageFromGrid) {
                console.log('⚠️ [EXIT] viewMode와 singleImageFromGrid가 모두 없으므로 종료하지 않음');
                return;
            }
            this.viewMode = 'gridImage';
        }

        console.log('🔄 [EXIT] 단일 이미지 뷰 모드 종료, viewMode:', this.viewMode, 'gridViewImageIndex:', this.gridViewImageIndex);

        // ✅ Step 1: 상태 먼저 초기화 (중요! - 화살표 버튼이 사라지도록)
        const savedViewMode = this.viewMode;
        this.viewMode = null;
        this.singleImageFromGrid = false;
        this._isNavigating = false;
        this._pendingNavDirection = 0; // ✅ 네비게이션 큐 리셋
        
        // ✅ Step 2: 이미지 리스트 초기화 (복원에 필요한 값 저장)
        this.singleViewImageList = [];
        this.singleViewImageIndex = -1;
        const savedGridViewImageList = this.gridViewImageList;
        const savedGridViewImageIndex = this.gridViewImageIndex;
        const savedGridViewSaveState = this.gridViewSaveState;
        this.gridViewImageList = [];
        this.gridViewImageIndex = -1;
        this.selectedImagePath = null;
        
        // ✅ Step 3: 화살표 버튼 숨김 (viewMode = null이므로)
        this.updateArrowButtonVisibility();

        // ✅ Wafer Navigator 숨김
        if (this.thumbnailNavigator) {
            this.thumbnailNavigator.hide();
        }

        // ✅ Chip selection 숨김
        if (this.chipAnnotator) {
            const selectedChipsList = document.getElementById('selected-chips-list');
            if (selectedChipsList) {
                selectedChipsList.style.display = 'none';
            }
            
            const chipSelectionPanel = document.getElementById('chip-selection-panel');
            if (chipSelectionPanel) {
                chipSelectionPanel.style.display = 'none';
            }
        }
        
        // ✅ Step 4: 그리드 복귀 및 스크롤 복원
        if (savedViewMode === 'gridImage') {
            console.log('🔄 [EXIT] 그리드 모드로 복귀');
            
            let imagesToShow = savedGridViewImageList;
            if (savedGridViewSaveState && savedGridViewSaveState.images && savedGridViewSaveState.images.length > 0) {
                imagesToShow = savedGridViewSaveState.images;
                this.selectedImages = [...savedGridViewSaveState.images];
                console.log('💾 [RESTORE] gridViewSaveState에서 이미지 목록 복원:', imagesToShow.length, '개');
            } else if (this.savedViewState && this.savedViewState.type === 'grid' && this.savedViewState.images && this.savedViewState.images.length > 0) {
                imagesToShow = this.savedViewState.images;
                this.selectedImages = [...this.savedViewState.images];
                console.log('💾 [RESTORE] savedViewState에서 이미지 목록 복원:', imagesToShow.length, '개');
            }
            
            if (!imagesToShow || imagesToShow.length === 0) {
                console.error('❌ [RESTORE] 복원할 이미지가 없습니다!');
                this.gridViewSaveState = null;
                return;
            }

            // ✅ 그리드 복귀
            this.showGrid(imagesToShow, true);
            
            // ✅ Composite Mode 상태 복원
            const saveState = savedGridViewSaveState || this.savedViewState;
            if (saveState && saveState.isCompositeMode) {
                console.log('🔄 [EXIT] Composite Mode 상태 복원');
                this.isCompositeMode = true;
                this.compositeSession = saveState.compositeSession;
                this.updateContextMenuState();
            }
            
            // ✅ 현재 이미지가 화면 중앙에 오도록 스크롤 조정
            setTimeout(() => {
                const grid = document.getElementById('image-grid');
                if (grid && savedGridViewImageIndex >= 0) {
                    const wraps = grid.querySelectorAll('.grid-thumb-wrap');
                    if (savedGridViewImageIndex < wraps.length) {
                        const targetWrap = wraps[savedGridViewImageIndex];
                        // 화면 중앙에 보이도록 스크롤
                        targetWrap.scrollIntoView({ 
                            behavior: 'smooth', 
                            block: 'center',
                            inline: 'center'
                        });
                        console.log('✅ [EXIT] 그리드 스크롤: 이미지', savedGridViewImageIndex, '를 화면 중앙에 표시');
                    }
                }
            }, 50);
        } else if (savedViewMode === 'single') {
            // ✅ 파일 탐색기로 복귀
            console.log('🔄 [EXIT] 파일 탐색기로 복귀');
            this.hideGrid();
        }
        
        // ✅ Step 5: 이벤트 리스너 정리
        if (this.boundGridEscapeHandler) {
            document.removeEventListener('keydown', this.boundGridEscapeHandler);
            this.boundGridEscapeHandler = null;
        }

        if (this.boundGridNavigationHandler) {
            document.removeEventListener('keydown', this.boundGridNavigationHandler);
            this.boundGridNavigationHandler = null;
        }

        if (this.boundSingleViewHandler) {
            document.removeEventListener('keydown', this.boundSingleViewHandler);
            this.boundSingleViewHandler = null;
        }

        this.dom.imageCanvas.onclick = null;
        this.dom.imageCanvas.ondblclick = null;
        
        // ✅ Step 6: 상태 완전 초기화
        this.gridViewSaveState = null;
    }
    
    /**
     * 하위 호환성을 위한 별칭
     */
    exitSingleImageMode() {
        this.exitSingleImageViewMode();
    }

    /**
     * 그리드 이미지 네비게이션 설정 (← → 키)
     */
    setupGridImageNavigation() {
        if (this.viewMode !== 'gridImage' && !this.singleImageFromGrid) return;

        // ✅ 기존 리스너 제거 (중복 방지)
        if (this.boundGridNavigationHandler) {
            document.removeEventListener('keydown', this.boundGridNavigationHandler);
            this.boundGridNavigationHandler = null;
        }

        // ✅ singleView 핸들러도 제거 (gridImage 모드이므로)
        if (this.boundSingleViewHandler) {
            document.removeEventListener('keydown', this.boundSingleViewHandler);
            this.boundSingleViewHandler = null;
        }

        // ← → 키보드 네비게이션
        document.addEventListener('keydown', this.boundGridNavigationHandler = (e) => {
            if (this.viewMode !== 'gridImage' && !this.singleImageFromGrid) return;

            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                e.stopPropagation(); // 이벤트 버블링 방지
                this.navigateSingleImageGrid(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                e.stopPropagation(); // 이벤트 버블링 방지
                this.navigateSingleImageGrid(1);
            }
        });
    }

    /**
     * 그리드 내 이미지 네비게이션 (← → 키) - 선택된 이미지들만 순회
     * @param {number} direction -1 (이전), 1 (다음)
     */
    navigateSingleImageGrid(direction) {
        // ✅ 조건 강화
        if (this.viewMode !== 'gridImage') {
            console.warn('⚠️ [NAV] Not in gridImage mode, current:', this.viewMode);
            return;
        }

        if (!this.gridViewImageList || !Array.isArray(this.gridViewImageList)) {
            console.warn('⚠️ [NAV] gridViewImageList not initialized');
            return;
        }

        if (this.gridViewImageList.length === 0) {
            console.warn('⚠️ [NAV] gridViewImageList is empty');
            return;
        }

        // ✅ 네비게이션 큐: 로딩 중이면 누적
        if (this._isNavigating) {
            this._pendingNavDirection = (this._pendingNavDirection || 0) + direction;
            console.log('⚠️ [NAV] Queuing navigation:', this._pendingNavDirection);

            // 🔥 즉시 피라미드 생성 취소 (빠른 반응)
            if (this.renderer && typeof this.renderer.cancelPyramid === 'function') {
                this.renderer.cancelPyramid();
            }
            return;
        }

        this._isNavigating = true;

        // 🔥 피라미드 생성 즉시 취소
        if (this.renderer && typeof this.renderer.cancelPyramid === 'function') {
            this.renderer.cancelPyramid();
        }
        
        // ✅ 현재 인덱스 찾기 (정규화된 경로 사용)
        const currentIdx = this.findImageIndexInList(
            this.selectedImagePath, 
            this.gridViewImageList
        );
        
        if (currentIdx === -1) {
            // ✅ gridViewImageIndex 사용 (fallback)
            const fallbackIdx = this.gridViewImageIndex >= 0 ? this.gridViewImageIndex : 0;
            console.warn('⚠️ [NAV] Current image not found in list, using gridViewImageIndex:', fallbackIdx);
            if (fallbackIdx >= 0 && fallbackIdx < this.gridViewImageList.length) {
                this.gridViewImageIndex = fallbackIdx;
                this._isNavigating = false;
                // fallback 인덱스로 재시도
                this.navigateSingleImageGrid(direction);
                return;
            } else {
                console.warn('⚠️ [NAV] Selected:', this.selectedImagePath);
                console.warn('⚠️ [NAV] List:', this.gridViewImageList.slice(0, 3));
                this._isNavigating = false;
                return;
            }
        }
        
        // ✅ 다음 인덱스 계산 및 범위 확인
        let nextIdx = currentIdx + direction;
        const listLength = this.gridViewImageList.length;
        
        if (nextIdx < 0) {
            nextIdx = listLength - 1;
        } else if (nextIdx >= listLength) {
            nextIdx = 0;
        }
        
        // ✅ 유효성 확인
        if (nextIdx < 0 || nextIdx >= listLength) {
            console.error('❌ [NAV] Invalid nextIdx:', nextIdx, 'listLength:', listLength);
            this._isNavigating = false;
            return;
        }
        
        const nextImagePath = this.gridViewImageList[nextIdx];
        if (!nextImagePath) {
            console.error('❌ [NAV] nextImagePath is undefined at index:', nextIdx);
            this._isNavigating = false;
            return;
        }

        // ✅ 인덱스 업데이트
        this.gridViewImageIndex = nextIdx;

        console.log('✅ [NAV] Grid navigation', direction > 0 ? '→' : '←',
                    'from', currentIdx, 'to', nextIdx, 'of', listLength);

        // 🔥 이미지 로드 버전 증가 (이전 로딩 작업 무효화)
        this._imageLoadVersion += 1;
        const currentLoadVersion = this._imageLoadVersion;

        // 🔥 피라미드 생성 즉시 취소
        if (this.renderer && typeof this.renderer.cancelPyramid === 'function') {
            this.renderer.cancelPyramid();
        }

        // 🔥 UI 즉시 업데이트 (0.001ms 반응)
        this.selectedImagePath = nextImagePath;  // 즉시 경로 업데이트
        this.showFileName(nextImagePath);  // 즉시 파일명 패널 업데이트

        // ✅ 파일 탐색기 선택 상태 동기화
        this.selectedImages = [nextImagePath];

        // ✅ Wafer Navigator 하이라이트 즉시 업데이트
        if (this.thumbnailNavigator && this.thumbnailNavigator.isVisible) {
            this.thumbnailNavigator.updateCurrentImage(nextImagePath);
        }

        this.loadImage(nextImagePath, false, currentLoadVersion)
            .then(() => {
                // ✅ pyramid level을 즉시 동기적으로 업데이트
                // resetView(false)에서 설정한 zoom 상태를 확정
                this.updatePyramidLevel();

                console.log('✅ [NAV] Successfully loaded image at index:', nextIdx);

                // ✅ 하이라이트 업데이트
                const grid = document.getElementById('image-grid');
                if (grid) {
                    const wraps = grid.querySelectorAll('.grid-thumb-wrap');
                    wraps.forEach((wrap, index) => {
                        if (index === nextIdx) {
                            wrap.classList.add('highlighted');
                        } else {
                            wrap.classList.remove('highlighted');
                        }
                    });
                }

                // ✅ 현재 이미지가 그리드에서 화면 중심에 보이도록 스크롤 조정
                if (grid) {
                    const wraps = grid.querySelectorAll('.grid-thumb-wrap');
                    if (nextIdx >= 0 && nextIdx < wraps.length) {
                        const targetWrap = wraps[nextIdx];
                        // 화면 중심에 보이도록 스크롤
                        targetWrap.scrollIntoView({
                            behavior: 'smooth',
                            block: 'center',
                            inline: 'center'
                        });
                        console.log(`✅ [NAV] 스크롤: 이미지 ${nextIdx}를 화면 중심에 표시`);
                    }
                }

                this._isNavigating = false;

                // ✅ 큐에 대기 중인 네비게이션 즉시 처리
                if (this._pendingNavDirection) {
                    const pending = this._pendingNavDirection;
                    this._pendingNavDirection = 0;
                    console.log('✅ [NAV] Processing queued navigation:', pending);
                    setTimeout(() => this.navigateSingleImageGrid(pending), 10); // 10ms로 단축
                }
            })
            .catch(err => {
                console.error('❌ [NAV] Failed to load image:', err);
                this._isNavigating = false;

                // ✅ 에러 시에도 큐 즉시 처리
                if (this._pendingNavDirection) {
                    const pending = this._pendingNavDirection;
                    this._pendingNavDirection = 0;
                    setTimeout(() => this.navigateSingleImageGrid(pending), 10); // 10ms로 단축
                }
            });
    }
    
    /**
     * ✅ 파일 탐색기 모드 네비게이션 - singleViewImageList 사용 (그리드 모드와 동일한 간단한 방식)
     * @param {number} direction -1 (이전), 1 (다음)
     */
    async navigateSingleImageMode(direction) {
        // 🔥 네비게이션 중이면 이전 요청 즉시 중단 (큐잉 제거 - 항상 최신 요청만 처리)
        if (this._isNavigating) {
            console.log('🛑 [NAV] 이전 네비게이션 중단, 새 요청 시작');
            // AbortController가 이미 loadImage에서 중단하므로 여기서는 플래그만 초기화
            this._isNavigating = false;
            this._pendingNavDirection = 0;
        }

        // ✅ singleViewImageList 검증
        if (!this.singleViewImageList || !Array.isArray(this.singleViewImageList)) {
            console.warn('⚠️ [NAV] singleViewImageList not initialized');
            return;
        }

        if (this.singleViewImageList.length === 0) {
            console.warn('⚠️ [NAV] singleViewImageList is empty');
            return;
        }

        this._isNavigating = true;

        // 🔥 피라미드 생성 즉시 취소
        if (this.semiconductorRenderer && typeof this.semiconductorRenderer.cancelPyramid === 'function') {
            this.semiconductorRenderer.cancelPyramid();
        }

        // ✅ 현재 인덱스 (singleViewImageIndex 사용)
        let currentIdx = this.singleViewImageIndex >= 0 ? this.singleViewImageIndex : 0;

        const listLength = this.singleViewImageList.length;

        // ✅ 폴더 경계 체크 (인덱스 기준으로 명확 처리)
        if (direction > 0 && currentIdx === listLength - 1) {
            await this.navigateToNextFolder();
            return;
        }
        if (direction < 0 && currentIdx === 0) {
            await this.navigateToPreviousFolder();
            return; // 이전 폴더로 이동했으므로 종료
        }

        // ✅ 다음 인덱스 계산
        let nextIdx = currentIdx + direction;

        // ✅ 같은 폴더 내에서 순환
        if (nextIdx < 0) {
            nextIdx = listLength - 1;
        } else if (nextIdx >= listLength) {
            nextIdx = 0;
        }

        const nextImagePath = this.singleViewImageList[nextIdx];

        if (!nextImagePath) {
            console.error('❌ [NAV] Next image path is undefined');
            this._isNavigating = false;
            return;
        }

        // ✅ 인덱스 업데이트
        this.singleViewImageIndex = nextIdx;

        // 🔥 이미지 로드 버전 증가 (이전 로딩 작업 무효화)
        this._imageLoadVersion += 1;
        const currentLoadVersion = this._imageLoadVersion;

        // 🔥 UI 즉시 업데이트 (0.001ms 반응)
        this.selectedImagePath = nextImagePath;
        this.showFileName(nextImagePath);

        // ✅ 파일 탐색기 선택 상태 동기화
        this.selectedImages = [nextImagePath];

        // ✅ Wafer Navigator 하이라이트 즉시 업데이트
        if (this.thumbnailNavigator && this.thumbnailNavigator.isVisible) {
            this.thumbnailNavigator.updateCurrentImage(nextImagePath);
        }

        // ✅ 이미지 로드 (loadImage 완료 시 자동으로 Wafer Map Explorer 하이라이트 업데이트됨)
        this.loadImage(nextImagePath, false, currentLoadVersion)
            .then(() => {
                // ✅ pyramid level을 즉시 동기적으로 업데이트
                this.updatePyramidLevel();

                console.log('✅ [NAV] Loaded image', nextIdx, nextImagePath);

                this._isNavigating = false;
            })
            .catch(err => {
                // 🔥 AbortError는 정상 (next/prev 연속 클릭)
                if (err?.name === 'AbortError') {
                    console.log('🛑 [NAV] 로딩 중단됨 (다음 요청 시작)');
                } else {
                    console.error('❌ [NAV] Load failed', err);
                }
                this._isNavigating = false;
            });
    }

    /**
     * ✅ 다음 폴더로 이동 (재귀적으로 첫 이미지 찾기)
     */
    async navigateToNextFolder() {
        try {
            const currentPath = this.selectedImagePath || this.singleViewImageList[this.singleViewImageIndex];
            if (!currentPath) {
                console.warn('⚠️ [NAV_FOLDER] No current path');
                return;
            }

            const nextImagePath = await this.findNextExplorerImagePath(currentPath);
            if (!nextImagePath) {
                console.warn('⚠️ [NAV_FOLDER] No next entry found in explorer order');
                return;
            }

            const moved = await this.navigateToExplorerImage(nextImagePath, 'next');
            if (!moved) {
                return;
            }
        } catch (error) {
            console.error('❌ [NAV_FOLDER] Failed to navigate to next folder:', error);
        } finally {
            this._isNavigating = false;
            this.processPendingNavigationQueue();
        }
    }

    /**
     * ✅ 이전 폴더로 이동 (마지막 이미지로)
     */
    async navigateToPreviousFolder() {
        try {
            const currentPath = this.selectedImagePath || this.singleViewImageList[this.singleViewImageIndex];
            if (!currentPath) {
                console.warn('⚠️ [NAV_FOLDER] No current path');
                return;
            }

            const prevImagePath = await this.findPreviousExplorerImagePath(currentPath);
            if (!prevImagePath) {
                console.warn('⚠️ [NAV_FOLDER] No previous entry found in explorer order');
                return;
            }

            const moved = await this.navigateToExplorerImage(prevImagePath, 'previous');
            if (!moved) {
                return;
            }
        } catch (error) {
            console.error('❌ [NAV_FOLDER] Failed to navigate to previous folder:', error);
        } finally {
            this._isNavigating = false;
            this.processPendingNavigationQueue();
        }
    }

    async loadFolderImageList(imagePath) {
        const lastSlash = Math.max(imagePath.lastIndexOf('/'), imagePath.lastIndexOf('\\'));
        const folderPath = lastSlash >= 0 ? imagePath.substring(0, lastSlash) : '';

        const response = await fetch(`/api/files?path=${encodeURIComponent(folderPath)}`);
        const data = await response.json();

        this.singleViewImageList = (data.items || [])
            .filter(item => item.type === 'file' && this.isImageFile(item.name))
            .map(item => item.path || `${folderPath}/${item.name}`);
        this.naturalSortPaths(this.singleViewImageList);

        // 현재 이미지 인덱스 찾기
        const normalizedImagePath = imagePath.replace(/\\/g, '/');
        this.singleViewImageIndex = this.singleViewImageList.findIndex(f => {
            const normalized = f.replace(/\\/g, '/');
            return normalized === normalizedImagePath || normalized.endsWith(normalizedImagePath) || normalizedImagePath.endsWith(normalized);
        });

        if (this.singleViewImageIndex === -1) {
            // 찾지 못하면 첫 번째로
            this.singleViewImageIndex = 0;
        }

        this.viewMode = 'single';
        console.log(`✅ [LOAD_FOLDER] Loaded ${this.singleViewImageList.length} images from folder, index: ${this.singleViewImageIndex}`);
    }

    /**
     * ✅ 재귀적으로 폴더 내 첫 번째 이미지 파일 찾기
     * @param {string} folderPath 폴더 경로
     * @param {HTMLElement} folderElement 폴더 요소 (summary.folder)
     * @returns {Promise<string|null>} 첫 번째 이미지 파일 경로 또는 null
     */
    async findFirstImageInFolderRecursive(folderPath, folderElement) {
        // 폴더 열기
        const detailsElement = folderElement.parentElement;
        if (!detailsElement.open) {
            const contentDiv = folderElement.nextElementSibling;
            await this.loadDirectoryContents(folderPath, contentDiv);
            detailsElement.dataset.loaded = 'true';
            detailsElement.open = true;
            // 폴더 내용 로드 대기
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // 폴더 내용 가져오기
        const contentDiv = folderElement.nextElementSibling;
        if (!contentDiv) return null;
        
        // 폴더 내 첫 번째 항목 찾기
        const firstItem = contentDiv.querySelector('li:first-child');
        if (!firstItem) return null;
        
        // 첫 번째 항목이 폴더인지 확인
        const firstFolder = firstItem.querySelector('summary.folder');
        if (firstFolder) {
            // 폴더면 재귀적으로 들어가기
            const subFolderPath = firstFolder.dataset.path;
            if (subFolderPath) {
                return await this.findFirstImageInFolderRecursive(subFolderPath, firstFolder);
            }
        }
        
        // 첫 번째 항목이 파일인지 확인
        const firstFile = firstItem.querySelector('a[data-path]');
        if (firstFile) {
            const filePath = firstFile.dataset.path;
            if (filePath) {
                // 이미지 파일인지 확인
                const isImage = /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(filePath);
                if (isImage) {
                    return filePath;
                }
            }
        }
        
        // 첫 번째 항목이 이미지가 아니면 다음 항목 찾기
        const allItems = contentDiv.querySelectorAll('li');
        for (const item of allItems) {
            const fileLink = item.querySelector('a[data-path]');
            if (fileLink) {
                const filePath = fileLink.dataset.path;
                if (filePath) {
                    const isImage = /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(filePath);
                    if (isImage) {
                        return filePath;
                    }
                }
            }
            
            // 파일이 아니면 폴더인지 확인하고 재귀적으로 들어가기
            const subFolder = item.querySelector('summary.folder');
            if (subFolder) {
                const subFolderPath = subFolder.dataset.path;
                if (subFolderPath) {
                    const imagePath = await this.findFirstImageInFolderRecursive(subFolderPath, subFolder);
                    if (imagePath) {
                        return imagePath;
                    }
                }
            }
        }
        
        return null;
    }

    async findLastImageInFolderRecursive(folderPath, folderElement) {
        const detailsElement = folderElement.parentElement;
        if (!detailsElement) return null;

        if (!detailsElement.open) {
            const contentDiv = folderElement.nextElementSibling;
            if (!contentDiv) return null;
            await this.loadDirectoryContents(folderPath, contentDiv);
            detailsElement.dataset.loaded = 'true';
            detailsElement.open = true;
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const contentDiv = folderElement.nextElementSibling;
        if (!contentDiv) return null;

        const items = Array.from(contentDiv.querySelectorAll('li')).reverse();

        for (const item of items) {
            const subFolder = item.querySelector('summary.folder');
            if (subFolder) {
                const subFolderPath = subFolder.dataset.path;
                if (subFolderPath) {
                    const imagePath = await this.findLastImageInFolderRecursive(subFolderPath, subFolder);
                    if (imagePath) {
                        return imagePath;
                    }
                }
            }

            const fileLink = item.querySelector('a[data-path]');
            if (fileLink) {
                const filePath = fileLink.dataset.path;
                if (filePath && /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(filePath)) {
                    return filePath;
                }
            }
        }

        return null;
    }

    /**
     * ✅ 재귀적으로 폴더 내 마지막 이미지 파일 찾기
     * @param {string} folderPath 폴더 경로
     * @param {HTMLElement} folderElement 폴더 요소 (summary.folder)
     * @returns {Promise<string|null>} 마지막 이미지 파일 경로 또는 null
     */
    async findLastImageInFolderRecursive(folderPath, folderElement) {
        // 폴더 열기
        const detailsElement = folderElement.parentElement;
        if (!detailsElement.open) {
            const contentDiv = folderElement.nextElementSibling;
            await this.loadDirectoryContents(folderPath, contentDiv);
            detailsElement.dataset.loaded = 'true';
            detailsElement.open = true;
            // 폴더 내용 로드 대기
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        // 폴더 내용 가져오기
        const contentDiv = folderElement.nextElementSibling;
        if (!contentDiv) return null;

        // 항목들을 뒤에서부터 검사
        const allItems = Array.from(contentDiv.querySelectorAll('li'));
        for (let i = allItems.length - 1; i >= 0; i--) {
            const item = allItems[i];

            // 하위 폴더가 있다면 가장 마지막 하위 이미지까지 재귀 탐색
            const subFolder = item.querySelector('summary.folder');
            if (subFolder) {
                const subFolderPath = subFolder.dataset.path;
                if (subFolderPath) {
                    const imagePath = await this.findLastImageInFolderRecursive(subFolderPath, subFolder);
                    if (imagePath) {
                        return imagePath;
                    }
                }
            }

            // 파일이면 이미지 여부 확인
            const fileLink = item.querySelector('a[data-path]');
            if (fileLink) {
                const filePath = fileLink.dataset.path;
                if (filePath && /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(filePath)) {
                    return filePath;
                }
            }
        }

        return null;
    }
    /**
     * ✅ 이전 이미지 (← / ArrowLeft)
     */
    navigatePrevious() {
        // ✅ 각 모드별로 명시적 확인
        if (this.viewMode === 'single') {
            this.navigateSingleImageMode(-1);
        } else if (this.viewMode === 'gridImage') {
            this.navigateSingleImageGrid(-1);
        } else {
            console.warn('⚠️ [NAV] Invalid viewMode:', this.viewMode);
        }
    }
    
    /**
     * ✅ 다음 이미지 (→ / ArrowRight)
     */
    navigateNext() {
        // ✅ 각 모드별로 명시적 확인
        if (this.viewMode === 'single') {
            this.navigateSingleImageMode(1);
        } else if (this.viewMode === 'gridImage') {
            this.navigateSingleImageGrid(1);
        } else {
            console.warn('⚠️ [NAV] Invalid viewMode:', this.viewMode);
        }
    }

    /**
     * ✅ 더블클릭 시 2번 이동 (파일탐색기 모드)
     */
    handleDoubleClickNavigation() {
        // 이미 네비게이션 중이면 스킵
        if (this._isNavigating) {
            console.log('⚠️ [DBLCLICK_NAV] 이미 네비게이션 중입니다. 스킵합니다.');
            return;
        }
        
        // viewMode 확인
        if (this.viewMode !== 'single') {
            console.warn('⚠️ [DBLCLICK_NAV] single 모드가 아닙니다. viewMode:', this.viewMode);
            return;
        }
        
        console.log('🔄 [DBLCLICK_NAV] 더블클릭: 2번 이동 시작');
        this._isNavigating = true;
        
        try {
            // ✅ 첫 번째 이동
            this.navigateNext();
            console.log('  → [DBLCLICK_NAV] 첫 번째 이동 완료');
            
            // ✅ 두 번째 이동 (150ms 후)
            setTimeout(() => {
                if (this.viewMode === 'single') {  // 모드가 변경되지 않았는지 확인
                    this.navigateNext();
                    console.log('  → [DBLCLICK_NAV] 두 번째 이동 완료');
                } else {
                    console.log('⚠️ [DBLCLICK_NAV] 모드가 변경되어 두 번째 이동 취소');
                }
                this._isNavigating = false;
            }, 150);
        } catch (error) {
            console.error('❌ [DBLCLICK_NAV] 더블클릭 네비게이션 실패:', error);
            this._isNavigating = false;
        }
    }
    
    /**
     * ✅ 경로 정규화 헬퍼 함수
     * @param {string} path 경로
     * @returns {string} 정규화된 경로
     */
    normalizePath(path) {
        if (!path) return '';
        return path.replace(/\\/g, '/').toLowerCase();
    }

    /**
     * ✅ 파일명 기준 자연 정렬 비교 (10 > 5를 올바르게 처리)
     */
    getNaturalCollator() {
        if (!this._naturalCollator) {
            this._naturalCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
        }
        return this._naturalCollator;
    }

    /**
     * 파일 경로에서 파일명만 추출
     */
    getFilenameOnly(path) {
        if (!path) return '';
        const p = path.replace(/\\/g, '/');
        return p.substring(p.lastIndexOf('/') + 1);
    }

    /**
     * 경로 배열을 파일명 기준 자연 정렬
     */
    naturalSortPaths(paths) {
        const collator = this.getNaturalCollator();
        return paths.sort((a, b) => {
            const ax = this.getFilenameOnly(a);
            const bx = this.getFilenameOnly(b);
            return collator.compare(ax, bx);
        });
    }

    /**
     * ✅ 이미지 목록에서 인덱스 찾기 (경로 정규화 사용)
     * @param {string} imagePath 찾을 이미지 경로
     * @param {Array<string>} imageList 이미지 목록
     * @returns {number} 인덱스 (-1 if not found)
     */
    findImageIndexInList(imagePath, imageList) {
        if (!imagePath || !imageList || !Array.isArray(imageList) || imageList.length === 0) {
            return -1;
        }
        
        const normalizedTarget = this.normalizePath(imagePath);
        
        return imageList.findIndex(item => 
            this.normalizePath(item) === normalizedTarget
        );
    }

    /**
     * ✅ 화살표 버튼 표시/숨김
     */
    updateArrowButtonVisibility() {
        const prevBtn = document.getElementById('prev-btn');
        const nextBtn = document.getElementById('next-btn');
        const navButtons = document.getElementById('single-image-nav-buttons');
        
        if (!prevBtn || !nextBtn) {
            console.warn('[Arrow] Navigation buttons not found');
            return;
        }
        
        // viewMode가 'single' 또는 'gridImage'일 때 표시
        const shouldShow = this.viewMode === 'single' || this.viewMode === 'gridImage';
        
        console.log('[Arrow] shouldShow:', shouldShow, 'viewMode:', this.viewMode);
        
        if (shouldShow) {
            if (navButtons) {
                navButtons.style.display = 'flex';
                navButtons.style.visibility = 'visible';
                navButtons.style.pointerEvents = 'auto';
            }
            if (prevBtn) {
                prevBtn.style.display = 'flex';
                prevBtn.style.visibility = 'visible';
                prevBtn.style.pointerEvents = 'auto';
            }
            if (nextBtn) {
                nextBtn.style.display = 'flex';
                nextBtn.style.visibility = 'visible';
                nextBtn.style.pointerEvents = 'auto';
            }
            console.log('[Arrow] Buttons visible - left and right');
        } else {
            if (navButtons) {
                navButtons.style.display = 'none';
                navButtons.style.visibility = 'hidden';
                navButtons.style.pointerEvents = 'none';
            }
            if (prevBtn) {
                prevBtn.style.display = 'none';
                prevBtn.style.visibility = 'hidden';
                prevBtn.style.pointerEvents = 'none';
            }
            if (nextBtn) {
                nextBtn.style.display = 'none';
                nextBtn.style.visibility = 'hidden';
                nextBtn.style.pointerEvents = 'none';
            }
            console.log('[Arrow] Buttons hidden');
        }
    }
    
    /**
     * ✅ 현재 그리드의 칸수와 셀 높이를 동적으로 계산
     * @returns {Object} { cols, cellHeight, cellWidth, wrapperHeight, gap, margin }
     */
    getGridDimensions() {
        const grid = document.getElementById('image-grid');
        if (!grid) {
            return { cols: 3, cellHeight: 340, cellWidth: 300, wrapperHeight: 800, gap: 10, margin: 0 };
        }
        
        // ✅ 그리드 컨테이너
        const gridWrapper = grid.parentElement;
        const wrapperWidth = gridWrapper?.clientWidth || 900;
        const wrapperHeight = gridWrapper?.clientHeight || 800;
        
        // ✅ 첫 번째 아이템 크기 측정
        const firstItem = grid.querySelector('.grid-thumb-wrap');
        if (!firstItem) {
            return { cols: 3, cellHeight: 340, cellWidth: 300, wrapperHeight, gap: 10, margin: 0 };
        }
        
        const rect = firstItem.getBoundingClientRect();
        const computedStyle = window.getComputedStyle(firstItem);
        
        // ✅ 실제 셀 크기 (padding, margin 포함)
        const margin = parseFloat(computedStyle.margin) || 0;
        const gap = this._getGridGap(grid);
        
        const cellWidth = rect.width;
        const cellHeight = rect.height;
        const totalCellWidth = cellWidth + 2 * margin + gap;
        
        // ✅ 실제 칼럼 수 계산
        const cols = Math.max(1, Math.floor(wrapperWidth / totalCellWidth));
        
        return {
            cols,
            cellHeight: cellHeight + 2 * margin,
            cellWidth,
            wrapperHeight,
            gap,
            margin
        };
    }

    /**
     * ✅ 그리드의 gap 값 계산
     * @param {HTMLElement} grid 그리드 요소
     * @returns {number} gap 값 (px)
     */
    _getGridGap(grid) {
        const style = window.getComputedStyle(grid);
        const gap = style.gap || '0px';
        const [gapH] = gap.split(' ');
        return parseFloat(gapH) || 0;
    }

    /**
     * ✅ 그리드 이미지 보기 모드에서 정확한 스크롤 계산
     * - 네비게이션한 이미지의 인덱스를 기반으로 스크롤 위치 계산
     * - 이미지 이동만큼 스크롤이 변함
     */
    updateGridScrollOnNavigation(imageIndexInList) {
        if (this.viewMode !== 'gridImage') {
            console.warn('⚠️ [SCROLL] Not in gridImage mode');
            return;
        }
        
        if (!this.gridViewSaveState) {
            console.warn('⚠️ [SCROLL] gridViewSaveState not set');
            return;
        }
        
        const selectedIndices = this.gridViewSaveState.selectedIndices;
        
        // ✅ 검증 강화
        if (!Array.isArray(selectedIndices)) {
            console.warn('⚠️ [SCROLL] selectedIndices is not an array:', selectedIndices);
            return;
        }
        
        if (selectedIndices.length === 0) {
            console.warn('⚠️ [SCROLL] selectedIndices is empty');
            return;
        }
        
        if (imageIndexInList < 0 || imageIndexInList >= selectedIndices.length) {
            console.warn('⚠️ [SCROLL] imageIndexInList out of range:', 
                         imageIndexInList, '/', selectedIndices.length);
            return;
        }
        
        const actualGridIndex = selectedIndices[imageIndexInList];
        
        // ✅ 그리드 요소 확인
        const grid = document.getElementById('image-grid');
        const scrollWrapper = grid?.parentElement;
        
        if (!grid || !scrollWrapper) {
            console.warn('⚠️ [SCROLL] Grid or scrollWrapper not found');
            return;
        }
        
        // ✅ 동적 그리드 차원 계산
        const { cols, cellHeight, wrapperHeight } = this.getGridDimensions();
        
        // ✅ 행 계산 (화살표 이동 수 // cols)
        const row = Math.floor(actualGridIndex / cols);
        
        // ✅ 스크롤 위치 = 행 위치 × 셀 높이
        const targetScrollTop = row * cellHeight;
        
        // ✅ 선택사항: 셀을 뷰포트 중앙에 배치
        const centerOffset = Math.max(0, (wrapperHeight - cellHeight * 1.5) / 2);
        const adjustedScrollTop = Math.max(0, targetScrollTop - centerOffset);
        
        console.log('✅ [SCROLL] Updated', {
            imageIndexInList,
            actualGridIndex,
            row,
            cols,
            cellHeight,
            targetScrollTop,
            adjustedScrollTop
        });
        
        // ✅ 부드러운 스크롤
        scrollWrapper.scrollTo({
            top: adjustedScrollTop,
            behavior: 'smooth'
        });
    }

    /**
     * ✅ 그리드 복귀 시 초기 스크롤 위치 계산
     * @param {Array<number>} selectedIndices 선택된 인덱스 배열
     * @returns {number} 스크롤 위치 (px)
     */
    _calculateGridScrollPosition(selectedIndices) {
        if (!Array.isArray(selectedIndices) || selectedIndices.length === 0) {
            return 0;
        }
        
        // ✅ 현재 보고 있는 이미지의 인덱스 (gridViewImageIndex 사용)
        let targetIndex = 0;
        if (this.gridViewImageIndex >= 0 && this.gridViewSaveState) {
            // gridViewImageIndex는 전체 그리드 이미지 목록의 인덱스
            targetIndex = this.gridViewImageIndex;
        } else {
            // fallback: 첫 번째 선택된 항목의 인덱스
            targetIndex = selectedIndices[0];
        }
        
        return this._calculateGridScrollPositionWithIndex(targetIndex, selectedIndices);
    }

    /**
     * ✅ 인덱스를 받아서 스크롤 위치 계산
     * @param {number} targetIndex 타겟 인덱스
     * @param {Array<number>} selectedIndices 선택된 인덱스 배열 (참고용)
     * @returns {number} 스크롤 위치 (px)
     */
    _calculateGridScrollPositionWithIndex(targetIndex, selectedIndices) {
        // ✅ 동적 그리드 차원
        const { cols, cellHeight } = this.getGridDimensions();
        
        // ✅ 행 계산
        const row = Math.floor(targetIndex / cols);
        
        // ✅ 스크롤 위치
        const scrollTop = row * cellHeight;
        
        console.log('✅ [CALC_SCROLL]', {
            targetIndex,
            cols,
            row,
            cellHeight,
            scrollTop
        });
        
        return scrollTop;
    }
    
    /**
     * 그리드에서 특정 이미지로 스크롤
     * @param {number} idx 이미지 인덱스
     */
    scrollToGridImage(idx) {
        const grid = document.getElementById('image-grid');
        if (!grid) return;
        
        const wraps = Array.from(grid.querySelectorAll('.grid-thumb-wrap'));
        if (idx >= 0 && idx < wraps.length) {
            const targetWrap = wraps[idx];
            targetWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
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
            const currentPath = this.buildClassificationPath(`${className}/${fileName}`);
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
            const labelPath = this.buildClassificationPath(className);
            
            // 🔥 경로 존재 여부 확인
            const response = await fetch(`/api/files?path=${encodeURIComponent(labelPath)}`);
            if (!response.ok) {
                this.debugLog(`클래스 '${className}' 폴더가 존재하지 않습니다.`);
                return;
            }
            
            const data = await response.json();
            const imageFiles = (data.items || [])

                .filter(item => item.type === 'file' && this.isImageFile(item.name))

                .map(item => {
                    // 현재 제품 폴더 내의 classification 경로 사용
                    return this.buildClassificationPath(`${className}/${item.name}`);
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
                    const labelPath = this.buildClassificationPath(className);
                    
                    // 🔥 경로 존재 여부 확인
                    const response = await fetch(`/api/files?path=${encodeURIComponent(labelPath)}`);
                    if (!response.ok) {
                        console.error(`클래스 '${className}' 폴더가 존재하지 않습니다.`);
                        return { className, images: [] };
                    }
                    
                    const data = await response.json();
                    const imageFiles = (data.items || [])

                        .filter(item => item.type === 'file' && this.isImageFile(item.name))

                        .map(item => this.buildClassificationPath(`${className}/${item.name}`));

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

    // ======================== 메모리 정리 ========================

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

    // --- CHIP LABEL LEGEND ---

    bindChipLegendEvents() {
        if (!this.dom.chipLabelLegend) return;
        this.dom.chipLabelLegend.addEventListener('click', (event) => this.handleChipLabelLegendClick(event));
    }

    updateChipLabelLegend(markedChips = []) {
        const chips = Array.isArray(markedChips) ? markedChips : [];
        const counts = new Map();

        chips.forEach(chip => {
            const className = chip?.class || chip?.label;
            if (!className) return;
            counts.set(className, (counts.get(className) || 0) + 1);
        });

        this.chipLabelLegendData = Array.from(counts.entries())
            .map(([className, count]) => ({ className, count }))
            .sort((a, b) => b.count - a.count || a.className.localeCompare(b.className));

        const availableClasses = new Set(this.chipLabelLegendData.map(item => item.className));
        if (this.activeChipLabelClasses instanceof Set) {
            this.activeChipLabelClasses = new Set(
                Array.from(this.activeChipLabelClasses).filter(cls => availableClasses.has(cls))
            );
        }
        // 기본값: 모든 클래스 활성화 (null이면 전체 표시)
        if (!(this.activeChipLabelClasses instanceof Set) && availableClasses.size > 0) {
            this.activeChipLabelClasses = null;
        }

        this.renderChipLabelLegend();
        if (this.chipAnnotator) {
            this.chipAnnotator.setLegendFilterClasses(this.activeChipLabelClasses);
        }
    }

    renderChipLabelLegend() {
        const legendEl = this.dom.chipLabelLegend;
        if (!legendEl) return;

        legendEl.innerHTML = '';

        const hasData = this.chipLabelLegendData && this.chipLabelLegendData.length > 0;
        if (!hasData) {
            legendEl.classList.remove('is-visible');
            legendEl.innerHTML = `
                <div class="chip-label-legend__title">Chip Labels</div>
                <div class="chip-label-empty">No chip labels</div>
            `;
            return;
        }

        legendEl.classList.add('is-visible');

        const title = document.createElement('div');
        title.className = 'chip-label-legend__title';
        title.textContent = 'Chip Labels';
        legendEl.appendChild(title);

        this.chipLabelLegendData.forEach(({ className, count }) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            const isActive = !this.activeChipLabelClasses || this.activeChipLabelClasses.has(className);
            btn.className = 'chip-label-pill' + (isActive ? ' is-active' : '');
            btn.setAttribute('data-chip-label', className);
            const colorDot = document.createElement('span');
            colorDot.className = 'chip-label-pill__dot';
            const colorHex = this.chipAnnotator?.getClassColorHex?.(className) || '#ff4d4d';
            colorDot.style.background = colorHex;

            const name = document.createElement('span');
            name.className = 'chip-label-pill__name';
            name.textContent = className;

            const counter = document.createElement('span');
            counter.className = 'chip-label-pill__count';
            counter.textContent = count.toString();

            btn.appendChild(colorDot);
            btn.appendChild(name);
            btn.appendChild(counter);

            legendEl.appendChild(btn);
        });
    }


    handleChipLabelLegendClick(event) {
        const target = event.target.closest('button[data-chip-label]');
        if (!target || !this.chipAnnotator) {
            return;
        }

        const className = target.getAttribute('data-chip-label');
        if (!className) {
            return;
        }

        if (!this.activeChipLabelClasses) {
            this.activeChipLabelClasses = new Set(this.chipLabelLegendData.map(item => item.className));
        }

        if (this.activeChipLabelClasses.has(className)) {
            this.activeChipLabelClasses.delete(className);
        } else {
            this.activeChipLabelClasses.add(className);
        }

        this.chipAnnotator.setLegendFilterClasses(this.activeChipLabelClasses);
        this.renderChipLabelLegend();
    }

    onManualChipSelection() {
        if (!this.activeChipLabelClasses) return;
        this.activeChipLabelClasses = null;
        if (this.chipAnnotator) {
            this.chipAnnotator.setLegendFilterClasses(null);
        }
        this.renderChipLabelLegend();
    }

    handleChipSelectionCleared() {
        if (!this.activeChipLabelClasses) return;
        this.activeChipLabelClasses = null;
        if (this.chipAnnotator) {
            this.chipAnnotator.setLegendFilterClasses(null);
        }
        this.renderChipLabelLegend();
    }

    // --- COLOR LEGENDS ---

    /**
     * Load color legends from JSON file
     */
    async loadColorLegends(signal = null) {
        try {
            // ✅ 캐시 버스터 추가하여 최신 색상 데이터 가져오기
            const cacheBuster = Date.now();
            const response = await fetch(`/logs/color-legends.json?_t=${cacheBuster}`, { signal });
            if (!response.ok) {
                throw new Error(`Failed to load color legends: ${response.status} ${response.statusText}`);
            }
            this.colorLegends = await response.json();
            // 디버그 로그 제거 (초기 로드 시에만 필요하면 주석 해제)
            // console.log('✅ [LOAD_COLORS] 색상 로드 완료:', Object.keys(this.colorLegends || {}).length, 'schemes');
            return this.colorLegends;
        } catch (error) {
            // 🔥 AbortError는 정상 (이미지 로딩 중단 시)
            if (error?.name === 'AbortError') {
                console.log('🛑 [LOAD_COLORS] 색상 로드 중단됨');
                throw error; // 상위로 전파하여 loadImage에서 처리
            }
            console.warn('⚠️ [LOAD_COLORS] 색상 로드 실패:', error);
            this.colorLegends = null;
            return null;
        }
    }

    /**
     * Render color legends for the current user
     */
    renderColorLegends() {
        if (!this.colorLegends) {
            return;
        }
        
        // 그리드 모드일 때는 grid legend만 렌더링
        if (this.gridMode) {
            if (this.dom.gridColorLegendBottom) {
                this.renderGridColorLegend();
            }
            return;
        }
        
        // 단일 이미지 모드일 때는 기존 legend 렌더링
        if (!this.dom.colorLegendTop || !this.dom.colorLegendBottom) {
            return;
        }
        
        // ✅ Scheme 결정 로직 개선 (우선순위: currentUser → change → default → 첫 번째 스킴)
        let schemeToUse = 'default';
        
        if (this.personalizedColorEnabled) {
            // ✅ 1순위: currentUser (존재하는 경우)
            if (this.currentUser && this.colorLegends[this.currentUser]) {
                schemeToUse = this.currentUser;
            } 
            // ✅ 2순위: change
            else if (this.colorLegends.change) {
                schemeToUse = 'change';
            }
            // ✅ 3순위: default
            else if (this.colorLegends.default) {
                schemeToUse = 'default';
            }
            // ✅ 4순위: 첫 번째 스킴
            else {
                const firstKey = Object.keys(this.colorLegends)[0];
                schemeToUse = firstKey || 'default';
            }
            // 디버그 로그 제거 (너무 자주 출력됨)
        } else {
            // 개인색 설정이 비활성화되어 있으면 항상 'default' 사용
            schemeToUse = 'default';
        }
        
        if (!schemeToUse) {
            return;
        }

        const userData = this.colorLegends[schemeToUse];

        if (!userData) {
            console.warn(`⚠️ No color legend data for scheme: ${schemeToUse}`);
            return;
        }

        // Render top legend
        // 🔥 TOP_KEYS 순서 보장하여 렌더링 (키 순서가 환경에 따라 달라질 수 있음)
        if (userData.top && typeof userData.top === 'object') {
            const TOP_KEYS = ['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7'];
            const topHtml = TOP_KEYS.map((label) => {
                const color = userData.top[label];
                if (color) {
                    return `
                        <div class="legend-item" data-section="top" data-key="${label}" style="cursor: pointer;">
                            <span class="legend-label">${label}</span>
                            <div class="legend-color-bar" data-section="top" data-key="${label}" style="background-color: ${color}; cursor: pointer;"></div>
                        </div>
                    `;
                }
                return '';
            }).filter(html => html).join('');
            this.dom.colorLegendTop.innerHTML = topHtml;
        } else {
            this.dom.colorLegendTop.innerHTML = '';
        }

        // Render bottom legend
        // 🔥 BOTTOM_KEYS 순서 보장하여 렌더링 (키 순서가 환경에 따라 달라질 수 있음)
        if (userData.bottom && typeof userData.bottom === 'object') {
            const BOTTOM_KEYS = ['Normal', 'Invalid', 'B285', 'B286', 'B287', 'B288'];
            const bottomHtml = BOTTOM_KEYS.map((label) => {
                // 🔥 "Border" 키가 있는 경우 "Normal"로 매핑 (Ubuntu 서버 호환성)
                let actualLabel = label;
                let color = userData.bottom[label];
                
                // "Normal" 키가 없으면 "Border" 키 확인
                if (label === 'Normal' && !color) {
                    if (userData.bottom['Border']) {
                        actualLabel = 'Border';
                        color = userData.bottom['Border'];
                    } else {
                        // "Normal"도 없고 "Border"도 없으면 fallback 색상 사용 (기본 회색)
                        color = '#BEBEBE';
                    }
                }
                
                if (color) {
                    // 🔥 "Border"를 "Normal"로 표시 및 data-key도 "Normal"로 설정
                    const displayLabel = actualLabel === 'Border' ? 'Normal' : label;
                    return `
                        <div class="legend-item" data-section="bottom" data-key="${displayLabel}" style="cursor: pointer;">
                            <span class="legend-label">${displayLabel}</span>
                            <div class="legend-color-bar" data-section="bottom" data-key="${displayLabel}" style="background-color: ${color}; cursor: pointer;"></div>
                        </div>
                    `;
                }
                return '';
            }).filter(html => html).join('');
            this.dom.colorLegendBottom.innerHTML = bottomHtml;
        } else {
            this.dom.colorLegendBottom.innerHTML = '';
        }
    }
    
    /**
     * Render color legend for grid mode (horizontal layout)
     */
    renderGridColorLegend() {
        if (!this.colorLegends || !this.dom.gridColorLegendBottom) {
            return;
        }
        
        // 🎨 Scheme 결정 로직 (개인색 설정 활성화 여부에 따라)
        // 개인색 설정이 체크되지 않으면 항상 'default' 사용
        let schemeToUse = 'default'; // 기본값
        
        if (this.personalizedColorEnabled) {
            // 개인색 설정이 활성화되어 있으면: LoginId가 있으면 LoginId 사용, 없으면 'change' 사용
            schemeToUse = this.currentUser || 'change';
        } else {
            // 개인색 설정이 비활성화되어 있으면 항상 'default' 사용
            schemeToUse = 'default';
        }
        
        // Scheme이 존재하는지 확인하고 없으면 fallback
        if (!this.colorLegends[schemeToUse]) {
            if (!this.personalizedColorEnabled && this.colorLegends.change) {
                schemeToUse = 'change';
            } else if (this.colorLegends.default) {
                schemeToUse = 'default';
            } else if (this.colorLegends.change) {
                schemeToUse = 'change';
            } else {
                const firstKey = Object.keys(this.colorLegends)[0];
                schemeToUse = firstKey || 'default';
            }
        }
        
        if (!schemeToUse) {
            return;
        }
        
        const userData = this.colorLegends[schemeToUse];
        
        if (!userData) {
            console.warn(`⚠️ No color legend data for scheme: ${schemeToUse}`);
            return;
        }
        
        // Render top legend first, then bottom legend
        let html = '';
        
        // 레이블 축약 함수
        const shortenLabel = (label) => {
            // Grade0, Grade1 등 → G0, G1
            if (label.startsWith('Grade')) {
                return label.replace('Grade', 'G');
            }
            // Normal → nor
            if (label === 'Normal') {
                return 'nor';
            }
            // Invalid → inv
            if (label === 'Invalid') {
                return 'inv';
            }
            // 나머지는 그대로
            return label;
        };
        
        // Top legend 그룹 (좌측 정렬)
        // 🔥 TOP_KEYS 순서 보장하여 렌더링 (키 순서가 환경에 따라 달라질 수 있음)
        html += '<div class="legend-group-top">';
        if (userData.top && typeof userData.top === 'object') {
            const TOP_KEYS = ['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7'];
            const topHtml = TOP_KEYS.map((label) => {
                const color = userData.top[label];
                if (color) {
                    return `
                        <div class="legend-item-grid">
                            <div class="legend-color-bar-grid" style="background-color: ${color};"></div>
                            <span class="legend-label-grid">${shortenLabel(label)}</span>
                        </div>
                    `;
                }
                return '';
            }).filter(html => html).join('');
            html += topHtml;
        }
        html += '</div>';
        
        // Bottom legend 그룹 (우측 정렬)
        // 🔥 BOTTOM_KEYS 순서 보장하여 렌더링 (키 순서가 환경에 따라 달라질 수 있음)
        html += '<div class="legend-group-bottom">';
        if (userData.bottom && typeof userData.bottom === 'object') {
            const BOTTOM_KEYS = ['Normal', 'Invalid', 'B285', 'B286', 'B287', 'B288'];
            const bottomHtml = BOTTOM_KEYS.map((label) => {
                // 🔥 "Border" 키가 있는 경우 "Normal"로 매핑 (Ubuntu 서버 호환성)
                let actualLabel = label;
                let color = userData.bottom[label];
                
                // "Normal" 키가 없으면 "Border" 키 확인
                if (label === 'Normal' && !color) {
                    if (userData.bottom['Border']) {
                        actualLabel = 'Border';
                        color = userData.bottom['Border'];
                    } else {
                        // "Normal"도 없고 "Border"도 없으면 fallback 색상 사용 (기본 회색)
                        color = '#BEBEBE';
                    }
                }
                
                if (color) {
                    // 🔥 "Border"를 "Normal"로 표시 (shortenLabel에서 "nor"로 변환)
                    const displayLabel = actualLabel === 'Border' ? 'Normal' : label;
                    return `
                        <div class="legend-item-grid">
                            <div class="legend-color-bar-grid" style="background-color: ${color};"></div>
                            <span class="legend-label-grid">${shortenLabel(displayLabel)}</span>
                        </div>
                    `;
                }
                return '';
            }).filter(html => html).join('');
            html += bottomHtml;
        }
        html += '</div>';
        
        this.dom.gridColorLegendBottom.innerHTML = html;
    }

    /**
     * Show color legends (Single Image Mode only)
     */
    showColorLegends() {
        if (this.gridMode) {
            // 그리드 모드일 때는 상단 패널 legend 표시
            if (this.dom.gridColorLegendBottom) {
                this.renderGridColorLegend();
                this.dom.gridColorLegendBottom.style.display = 'flex';
            }
            // 그리드 모드에서는 우측 legend 숨기기
            if (this.dom.colorLegendTop && this.dom.colorLegendBottom) {
                this.dom.colorLegendTop.style.display = 'none';
                this.dom.colorLegendBottom.style.display = 'none';
            }
        } else {
            // 그리드 모드가 아닐 때 (단일 이미지 모드)
            // 단일 이미지 모드일 때: 우측 legend만 표시 (상단 패널 legend 숨김)
            if (this.dom.colorLegendTop && this.dom.colorLegendBottom) {
                this.dom.colorLegendTop.style.display = 'block';
                this.dom.colorLegendBottom.style.display = 'block';
            }
            if (this.dom.gridColorLegendBottom) {
                this.dom.gridColorLegendBottom.style.display = 'none';
            }
        }
    }

    /**
     * Hide color legends
     */
    hideColorLegends() {
        if (this.dom.colorLegendTop && this.dom.colorLegendBottom) {
            this.dom.colorLegendTop.style.display = 'none';
            this.dom.colorLegendBottom.style.display = 'none';
        }
        if (this.dom.gridColorLegendBottom) {
            this.dom.gridColorLegendBottom.style.display = 'none';
        }
    }

    /**
     * Show chip context menu
     */
    showChipContextMenu(event, selectedChips) {
        // 기존 context menu 제거 (있다면)
        const existingMenu = document.getElementById('chip-context-menu');
        if (existingMenu) {
            existingMenu.remove();
        }

        // Context menu 생성
        const menu = document.createElement('div');
        menu.id = 'chip-context-menu';
        menu.className = 'context-menu';
        menu.style.cssText = `
            position: fixed;
            background: #2a2a2a;
            border: 1px solid #555;
            border-radius: 4px;
            padding: 4px 0;
            z-index: 10000;
            min-width: 200px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.6);
        `;

        // Chip 1개 선택 시: Chip 보기
        if (selectedChips.length === 1) {
            const viewItem = document.createElement('div');
            viewItem.className = 'context-menu-item';
            viewItem.style.cssText = `
                padding: 8px 16px;
                cursor: pointer;
                color: #fff;
                font-size: 14px;
            `;
            viewItem.textContent = 'Chip 보기';
            viewItem.onclick = () => {
                this.showChipViewModal(selectedChips[0]);
                menu.remove();
            };
            menu.appendChild(viewItem);
        }

        // Chip 여러개 선택 시: 좌표 복사 옵션
        if (selectedChips.length > 0) {
            const separator = document.createElement('div');
            separator.style.cssText = 'height: 1px; background: #555; margin: 4px 0;';
            menu.appendChild(separator);

            const copyCoordsItem = document.createElement('div');
            copyCoordsItem.className = 'context-menu-item';
            copyCoordsItem.style.cssText = `
                padding: 8px 16px;
                cursor: pointer;
                color: #fff;
                font-size: 14px;
            `;
            copyCoordsItem.textContent = `Chip 좌표 클립보드 복사 (${selectedChips.length}개)`;
            copyCoordsItem.onclick = () => {
                this.copyChipCoordinates(selectedChips);
                menu.remove();
            };
            menu.appendChild(copyCoordsItem);

            const copyTableItem = document.createElement('div');
            copyTableItem.className = 'context-menu-item';
            copyTableItem.style.cssText = `
                padding: 8px 16px;
                cursor: pointer;
                color: #fff;
                font-size: 14px;
            `;
            copyTableItem.textContent = `Chip 좌표 테이블 복사 (${selectedChips.length}개)`;
            copyTableItem.onclick = () => {
                this.copyChipCoordinatesAsTable(selectedChips);
                menu.remove();
            };
            menu.appendChild(copyTableItem);
        }

        // 메뉴 위치 설정
        menu.style.left = event.pageX + 'px';
        menu.style.top = event.pageY + 'px';
        document.body.appendChild(menu);

        // 외부 클릭 시 메뉴 제거
        const closeMenu = (e) => {
            if (!menu.contains(e.target)) {
                menu.remove();
                document.removeEventListener('click', closeMenu);
            }
        };
        setTimeout(() => document.addEventListener('click', closeMenu), 0);
    }

    /**
     * Show chip view modal
     */
    async showChipViewModal(chipData) {
        const modal = document.getElementById('chip-view-modal');
        const canvas = document.getElementById('chip-view-canvas');
        const absCoords = document.getElementById('chip-view-abs-coords');
        const relCoords = document.getElementById('chip-view-rel-coords');
        const bValue = document.getElementById('chip-view-b-value');
        const filePath = document.getElementById('chip-view-file-path');
        const colorLegend = document.getElementById('chip-view-color-legend');
        const closeBtn = document.getElementById('chip-view-close');

        if (!modal || !canvas || !absCoords || !relCoords || !bValue || !filePath || !colorLegend) {
            console.error('Chip view modal elements not found');
            return;
        }

        // chip 객체에서 직접 데이터 가져오기
        const chip = this.chipAnnotator.chips[chipData.index];
        if (!chip) {
            console.error('Chip not found at index:', chipData.index);
            return;
        }

        // 좌표 정보 표시 (chip 객체에서 직접 가져오기)
        // 절대 좌표: JSON 파일의 x_abs, y_abs 값 사용 (cal 값 절대 사용 안 함)
        if (chip.x_abs !== undefined && chip.y_abs !== undefined) {
            absCoords.textContent = `(${chip.x_abs}, ${chip.y_abs})`;
        } else {
            absCoords.textContent = '-';
        }
        
        // 상대 좌표: JSON 파일의 x_cal, y_cal 값 사용
        if (chip.x_cal !== undefined && chip.y_cal !== undefined) {
            relCoords.textContent = `(${chip.x_cal}, ${chip.y_cal})`;
        } else {
            relCoords.textContent = '-';
        }
        
        // b 값 표시 (JSON에서 숫자만 저장됨)
        if (chip.b !== undefined && chip.b !== null) {
            // 🔥 JSON에서 숫자만 저장되므로 그대로 표시
            bValue.textContent = String(chip.b);
        } else {
            bValue.textContent = '-';
        }
        
        filePath.textContent = this.selectedImagePath || '-';

        // Color Legend 렌더링 (Grade0~Grade7)
        await this.renderChipViewColorLegend(colorLegend);

        // Chip 이미지 로드
        const imageUrl = await this.chipAnnotator.getChipImageRegion(chipData.index);
        if (imageUrl) {
            const img = new Image();
            img.onload = () => {
                // 🔥 고정 크기로 표시 (400px 정사각형)
                const displaySize = 400;

                // Canvas 실제 크기 설정 (고정 크기)
                canvas.width = displaySize;
                canvas.height = displaySize;
                
                // CSS로 표시 크기 제한 (정사각형으로 꽉 차게)
                canvas.style.width = `${displaySize}px`;
                canvas.style.height = `${displaySize}px`;
                canvas.style.maxWidth = 'none';
                canvas.style.maxHeight = 'none';
                
                const ctx = canvas.getContext('2d');
                // 🔥 픽셀 완벽 렌더링 설정
                setPixelPerfectRendering(ctx);
                
                // 이미지를 정사각형 캔버스에 맞춰서 그리기 (비율 유지하면서 중앙 정렬)
                const imgAspect = img.width / img.height;
                let drawWidth = displaySize;
                let drawHeight = displaySize;
                let drawX = 0;
                let drawY = 0;
                
                if (imgAspect > 1) {
                    // 가로가 더 긴 경우
                    drawHeight = displaySize / imgAspect;
                    drawY = (displaySize - drawHeight) / 2;
                } else {
                    // 세로가 더 긴 경우
                    drawWidth = displaySize * imgAspect;
                    drawX = (displaySize - drawWidth) / 2;
                }
                
                ctx.drawImage(img, drawX, drawY, drawWidth, drawHeight);
                
                URL.revokeObjectURL(imageUrl);
            };
            img.onerror = () => {
                console.error('Failed to load chip image');
                // 🔥 고정 크기로 설정 (에러 시에도 동일)
                const fixedSize = 400;
                canvas.width = fixedSize;
                canvas.height = fixedSize;
                canvas.style.width = `${fixedSize}px`;
                canvas.style.height = `${fixedSize}px`;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#000';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.fillStyle = '#fff';
                ctx.font = '16px Arial';
                ctx.textAlign = 'center';
                ctx.fillText('이미지 로드 실패', canvas.width / 2, canvas.height / 2);
            };
            img.src = imageUrl;
        } else {
            // 이미지 로드 실패
            // 🔥 고정 크기로 설정
            const fixedSize = 400;
            canvas.width = fixedSize;
            canvas.height = fixedSize;
            canvas.style.width = `${fixedSize}px`;
            canvas.style.height = `${fixedSize}px`;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#fff';
            ctx.font = '16px Arial';
            ctx.textAlign = 'center';
            ctx.fillText('이미지 로드 실패', canvas.width / 2, canvas.height / 2);
        }

        // 모달 표시
        modal.style.display = 'flex';

        // 닫기 버튼 이벤트
        if (closeBtn) {
            closeBtn.onclick = () => {
                modal.style.display = 'none';
            };
        }

        // 모달 외부 클릭 시 닫기
        modal.onclick = (e) => {
            if (e.target === modal) {
                modal.style.display = 'none';
            }
        };
    }

    /**
     * Render color legend for chip view modal (Grade0~Grade7)
     */
    async renderChipViewColorLegend(container) {
        if (!container) return;

        try {
            // 사용자의 color scheme 가져오기 (color-editor에서 사용하는 방식)
            let schemeName = 'default';
            try {
                const userResponse = await fetch('/api/auth/user');
                if (userResponse.ok) {
                    const userData = await userResponse.json();
                    if (userData.colorScheme) {
                        schemeName = userData.colorScheme;
                    }
                }
            } catch (e) {
                console.warn('사용자 color scheme을 가져올 수 없습니다. default 사용:', e);
            }

            // color-legends.json 로드
            const response = await fetch('/logs/color-legends.json');
            if (!response.ok) {
                console.warn('Color legends를 가져올 수 없습니다.');
                container.innerHTML = '<div style="color: #999; font-size: 10px;">Color legend를 로드할 수 없습니다.</div>';
                return;
            }

            const legends = await response.json();
            const userScheme = legends[schemeName] || legends.default || {};
            const topColors = userScheme.top || {};

            // Grade0~Grade7 렌더링
            const TOP_KEYS = ['Grade0', 'Grade1', 'Grade2', 'Grade3', 'Grade4', 'Grade5', 'Grade6', 'Grade7'];
            container.innerHTML = '';

            TOP_KEYS.forEach((gradeKey, index) => {
                const color = topColors[gradeKey] || '#FFFFFF';
                const label = `G${index}`; // G0, G1, G2, ...

                const item = document.createElement('div');
                // 🔥 줄간격 줄이기 (gap: 10px → 4px, padding: 2px 0 → 1px 0)
                item.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 1px 0;';

                const colorBar = document.createElement('div');
                // 🔥 색상 바 크기 약간 줄이기
                colorBar.style.cssText = `width: 40px; height: 16px; background: ${color}; border: 1px solid #444; border-radius: 2px; flex-shrink: 0;`;

                const labelEl = document.createElement('span');
                // 🔥 글자 크기 줄이기 (15px → 12px)
                labelEl.style.cssText = 'color: #ccc; font-size: 12px; font-weight: 500;';
                labelEl.textContent = label;

                item.appendChild(colorBar);
                item.appendChild(labelEl);
                container.appendChild(item);
            });
        } catch (error) {
            console.error('Color legend 렌더링 오류:', error);
            container.innerHTML = '<div style="color: #999; font-size: 10px;">Color legend를 로드할 수 없습니다.</div>';
        }
    }

    /**
     * Copy chip coordinates to clipboard
     */
    async copyChipCoordinates(selectedChips) {
        if (!selectedChips || selectedChips.length === 0) {
            alert('복사할 chip이 없습니다.');
            return;
        }

        const coords = selectedChips.map(chip => `(${chip.x_abs}, ${chip.y_abs})`).join('\n');
        
        try {
            await navigator.clipboard.writeText(coords);
            alert(`${selectedChips.length}개 chip 좌표가 클립보드에 복사되었습니다.`);
        } catch (error) {
            console.error('클립보드 복사 실패:', error);
            alert('클립보드 복사에 실패했습니다.');
        }
    }

    /**
     * Copy chip coordinates as table to clipboard
     */
    async copyChipCoordinatesAsTable(selectedChips) {
        if (!selectedChips || selectedChips.length === 0) {
            alert('복사할 chip이 없습니다.');
            return;
        }

        if (!this.selectedImagePath) {
            alert('파일 경로를 찾을 수 없습니다.');
            return;
        }

        // 파일명에서 확장자 제거
        const fileName = this.selectedImagePath.split('/').pop().replace(/\.[^/.]+$/, '');
        // 파일명을 _로 split
        const nameParts = fileName.split('_');

        // 테이블 데이터 생성
        const tableData = selectedChips.map(chip => {
            const row = [...nameParts, chip.x_abs, chip.y_abs];
            return row.join('\t');
        });

        // TSV 형식으로 변환
        const tableText = tableData.join('\n');

        try {
            await navigator.clipboard.writeText(tableText);
            alert(`${selectedChips.length}개 chip 좌표가 테이블 형태로 클립보드에 복사되었습니다.`);
        } catch (error) {
            console.error('클립보드 복사 실패:', error);
            alert('클립보드 복사에 실패했습니다.');
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
