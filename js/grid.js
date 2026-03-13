/**
 * 그리드 모드 관련 기능들
 * 썸네일 표시, 선택 관리, 그리드 레이아웃
 */

import { isImageFile, debounce, isElementVisible, chunkArray } from './utils.js';

/**
 * 그리드 매니저 클래스
 */
export class GridManager {
    constructor(viewer) {
        this.viewer = viewer;
        this.container = null;
        this.currentImages = [];
        this.selectedIndices = [];
        this.loadingThumbnails = new Set();

        // 지연 로딩을 위한 Intersection Observer
        this.observer = null;
        this.initIntersectionObserver();

        // 디바운싱된 업데이트 함수
        this.debouncedUpdateSelection = debounce(() => this.updateSelectionUI(), 100);

        // 드래그 감지용 변수
        this.isDragging = false;
        this.mouseDownPos = null;
        this.dragThreshold = 5; // 5px 이상 이동하면 드래그로 간주

        // 🔥 스크롤 디바운스 (스크롤 멈춘 후 100ms 후 로드)
        this.scrollDebounceTimer = null;
        this.isScrolling = false;

        // 🔥 진행 중인 이미지 로드 요청 취소용
        this.abortControllers = new Map(); // index -> AbortController
        
        // 🔥 동시 로딩 제한 (서버 부하 방지)
        this.concurrentLoads = 0;
        this.maxConcurrentLoads = 16; // 🔥 8 → 16으로 증가 (성능 개선)
        this.loadQueue = [];
        // 🔥 스크롤 중에 발견된 아이템들을 저장하는 큐
        this.scrollPendingItems = new Set();
    }
    
    /**
     * 그리드 초기화
     */
    init() {
        this.container = document.getElementById('grid-container');
        if (!this.container) {
            console.error('그리드 컨테이너를 찾을 수 없습니다.');
            return;
        }
        this.bindEvents();
    }
    
    /**
     * Intersection Observer 초기화 (지연 로딩용)
     */
    initIntersectionObserver() {
        if ('IntersectionObserver' in window) {
            // 🔥 뷰포트 1.5배 영역만 관찰 (위아래 25%씩 = 50% 추가)
            const viewportHeight = window.innerHeight;
            const margin = Math.round(viewportHeight * 0.25);
            this.observer = new IntersectionObserver(
                (entries) => this.handleIntersection(entries),
                {
                    root: null,
                    rootMargin: `${margin}px 0px ${margin}px 0px`,
                    threshold: 0.1
                }
            );
        }
    }
    
    /**
     * 이벤트 바인딩
     */
    bindEvents() {
        if (!this.container) return;

        // 드래그 감지를 위한 mousedown 이벤트
        this.container.addEventListener('mousedown', (e) => {
            this.isDragging = false;
            this.mouseDownPos = { x: e.clientX, y: e.clientY };
        });

        // 마우스 이동 시 드래그 감지
        this.container.addEventListener('mousemove', (e) => {
            if (this.mouseDownPos) {
                const deltaX = Math.abs(e.clientX - this.mouseDownPos.x);
                const deltaY = Math.abs(e.clientY - this.mouseDownPos.y);

                if (deltaX > this.dragThreshold || deltaY > this.dragThreshold) {
                    this.isDragging = true;
                }
            }
        });

        // mouseup 시 초기화
        this.container.addEventListener('mouseup', () => {
            // 약간의 지연 후 초기화 (click 이벤트가 먼저 발생하도록)
            setTimeout(() => {
                this.mouseDownPos = null;
                this.isDragging = false;
            }, 10);
        });

        // 그리드 컨테이너 클릭 이벤트 (이벤트 위임)
        this.container.addEventListener('click', (e) => {
            // 드래그 중이었으면 클릭 무시
            if (this.isDragging) {
                return;
            }

            const gridItem = e.target.closest('.grid-item');
            if (gridItem) {
                const index = parseInt(gridItem.dataset.index);
                this.handleItemClick(index, e);
            }
        });

        // 더블클릭 이벤트 추가
        this.container.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();

            const gridItem = e.target.closest('.grid-item');
            if (!gridItem) {
                // grid-thumb-wrap도 체크 (main.js의 그리드 구조)
                const gridThumb = e.target.closest('.grid-thumb-wrap');
                if (gridThumb) {
                    const index = parseInt(gridThumb.dataset.index);
                    if (!isNaN(index)) {
                        this.handleDoubleClick(index);
                    }
                }
                return;
            }

            const index = parseInt(gridItem.dataset.index);
            if (!isNaN(index)) {
                this.handleDoubleClick(index);
            }
        });

        // 🔥 스크롤 이벤트 리스너 추가 (디바운스)
        this.container.addEventListener('scroll', () => {
            this.handleScroll();
        });

        // 키보드 이벤트
        document.addEventListener('keydown', (e) => this.handleKeyDown(e));
    }
    
    /**
     * 더블클릭 처리
     * @param {number} index 더블클릭된 아이템 인덱스
     */
    handleDoubleClick(index) {
        if (!this.viewer) return;
        
        console.log('Grid double-click at index:', index);
        
        // 🔥 my lot 또는 composite 그리드인지 확인
        const activePageRole = this.viewer.activePageRole;
        if (activePageRole === 'mylot' || activePageRole === 'composite') {
            // my lot 또는 composite 그리드에서는 enterGridImageViewMode 호출
            if (typeof this.viewer.enterGridImageViewMode === 'function') {
                this.viewer.enterGridImageViewMode(index);
            }
        } else {
            // 일반 그리드에서는 enterSingleImageMode 호출
            if (typeof this.viewer.enterSingleImageMode === 'function') {
                this.viewer.enterSingleImageMode(index);
            }
        }
    }
    
    /**
     * 그리드 표시
     * @param {Array<string>} images 이미지 경로 배열
     */
    show(images) {
        if (!this.container) return;
        
        this.currentImages = images.filter(img => isImageFile(img));
        this.selectedIndices = [];
        
        this.render();
        this.viewer.showGridMode();
    }
    
    /**
     * 그리드 렌더링
     */
    render() {
        // ✅ 그리드 모드 진입 시 Navigator 숨기기
        if (window.waferMapViewer && window.waferMapViewer.thumbnailNavigator) {
            window.waferMapViewer.thumbnailNavigator.hide();
        }

        if (!this.container || this.currentImages.length === 0) {
            this.container.innerHTML = '<p>표시할 이미지가 없습니다.</p>';
            return;
        }
        
        const fragment = document.createDocumentFragment();
        
        this.currentImages.forEach((imagePath, index) => {
            const gridItem = this.createGridItem(imagePath, index);
            fragment.appendChild(gridItem);
        });
        
        this.container.innerHTML = '';
        this.container.appendChild(fragment);
        
        // 지연 로딩 관찰 시작
        if (this.observer) {
            this.container.querySelectorAll('.grid-item[data-src]').forEach(item => {
                this.observer.observe(item);
            });
        }
    }
    
    /**
     * 그리드 아이템 생성
     * @param {string} imagePath 이미지 경로
     * @param {number} index 인덱스
     * @returns {HTMLElement} 그리드 아이템 요소
     */
    createGridItem(imagePath, index) {
        const item = document.createElement('div');
        item.className = 'grid-item';
        item.dataset.index = index;
        item.dataset.path = imagePath;
        item.dataset.src = `/api/thumbnail?path=${encodeURIComponent(imagePath)}`;
        
        // 플레이스홀더 이미지
        const img = document.createElement('img');
        img.className = 'grid-thumbnail';
        img.alt = imagePath.split('/').pop();
        img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzMzMyIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmaWxsPSIjNjY2IiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iMC4zZW0iPkxvYWRpbmcuLi48L3RleHQ+PC9zdmc+';
        
        // 파일명 표시
        const fileName = document.createElement('div');
        fileName.className = 'grid-filename';
        let displayName = imagePath.split('/').pop();
        const lowerName = (displayName || '').toLowerCase();
        const nameWithoutExt = (displayName || '').replace(/\.(png|jpg|jpeg|gif|webp)$/i, '');
        if (nameWithoutExt.toLowerCase() === 'square_average' || displayName === 'sum_map.png') {
            displayName = 'composite(square-avg)';
        } else if (nameWithoutExt.toLowerCase() === 'square_weighted_average' || lowerName.startsWith('sum_map_weighted')) {
            displayName = 'composite(weighted)';
        } else if (/^(index_|grade_)/i.test(displayName)) {
            displayName = nameWithoutExt.replace(/^(index_|grade_)/i, 'Grade_');
        }
        fileName.textContent = displayName;
        fileName.title = imagePath;
        
        // 선택 체크박스
        const checkbox = document.createElement('div');
        checkbox.className = 'grid-checkbox';
        checkbox.innerHTML = '✓';
        
        item.appendChild(img);
        item.appendChild(fileName);
        item.appendChild(checkbox);
        
        return item;
    }
    
    /**
     * Intersection Observer 콜백
     * @param {Array<IntersectionObserverEntry>} entries 관찰 항목들
     */
    handleIntersection(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const gridItem = entry.target;
                const src = gridItem.dataset.src;
                const index = parseInt(gridItem.dataset.index);

                // 이미 로드되었거나 로딩 중이면 건너뛰기
                if (!src || this.loadingThumbnails.has(index)) {
                    // 로드 완료된 경우에만 unobserve
                    if (!src) {
                        this.observer.unobserve(gridItem);
                    }
                    return;
                }

                // 🔥 스크롤 중에는 절대 요청하지 않음 — pending 큐에만 추가
                if (this.isScrolling) {
                    this.scrollPendingItems.add(gridItem);
                } else {
                    // 스크롤 중이 아니면 즉시 로드
                    this.loadThumbnail(gridItem).then(() => {
                        this.observer.unobserve(gridItem);
                    }).catch(() => {
                        this.observer.unobserve(gridItem);
                    });
                }
            }
        });
    }
    
    /**
     * 썸네일 로드
     * @param {HTMLElement} gridItem 그리드 아이템
     * @returns {Promise<void>} 로드 완료 Promise
     */
    async loadThumbnail(gridItem) {
        const src = gridItem.dataset.src;
        const index = parseInt(gridItem.dataset.index);

        if (!src || this.loadingThumbnails.has(index)) {
            return Promise.resolve();
        }

        // 🔥 동시 로딩 수 제한 (서버 부하 및 gzip 오류 방지)
        if (this.concurrentLoads >= this.maxConcurrentLoads) {
            await new Promise(resolve => this.loadQueue.push(resolve));
        }
        
        this.concurrentLoads++;

        // 🔥 기존 요청이 있으면 취소
        if (this.abortControllers.has(index)) {
            this.abortControllers.get(index).abort();
            this.abortControllers.delete(index);
        }

        this.loadingThumbnails.add(index);

        // 🔥 새로운 AbortController 생성
        const abortController = new AbortController();
        this.abortControllers.set(index, abortController);

        try {
            const img = gridItem.querySelector('.grid-thumbnail');
            if (!img) {
                return Promise.resolve();
            }

            // 🔥 fetch로 이미지 로드 (AbortController 사용)
            const response = await fetch(src, {
                signal: abortController.signal
            });

            if (!response.ok) throw new Error('Failed to load image');

            const blob = await response.blob();
            const imageUrl = URL.createObjectURL(blob);

            img.src = imageUrl;
            gridItem.classList.add('loaded');

            // 🔥 성공 시 data-src 제거 (중복 로드 방지)
            delete gridItem.dataset.src;

            // 메모리 정리 (이미지 로드 후)
            img.onload = () => URL.revokeObjectURL(imageUrl);

        } catch (error) {
            // 🔥 취소된 요청은 무시
            if (error.name === 'AbortError') {
                return Promise.resolve();
            }

            console.error('썸네일 로드 오류:', error);
            const img = gridItem.querySelector('.grid-thumbnail');
            if (img) {
                img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzMzMyIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmaWxsPSIjZjAwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iMC4zZW0iPkVycm9yPC90ZXh0Pjwvc3ZnPg==';
                gridItem.classList.add('error');
            }
        } finally {
            this.loadingThumbnails.delete(index);
            this.abortControllers.delete(index);
            
            // 🔥 동시 로딩 수 감소 및 대기 중인 다음 로드 시작
            this.concurrentLoads--;
            if (this.loadQueue.length > 0) {
                const nextResolve = this.loadQueue.shift();
                nextResolve();
            }
        }
    }
    
    /**
     * 그리드 아이템 클릭 처리
     * @param {number} index 클릭된 아이템 인덱스
     * @param {MouseEvent} event 마우스 이벤트
     */
    handleItemClick(index, event) {
        if (event.ctrlKey) {
            // Ctrl+클릭: 토글 선택
            this.toggleSelection(index);
        } else if (event.shiftKey && this.selectedIndices.length > 0) {
            // Shift+클릭: 범위 선택
            this.selectRange(index);
        } else {
            // 일반 클릭: 단일 선택
            this.selectSingle(index);
        }
        
        this.updateSelectionUI();
        // viewer의 gridSelectedIdxs 동기화
        this.viewer.gridSelectedIdxs = [...this.selectedIndices];
    }
    
    /**
     * 단일 선택
     * @param {number} index 인덱스
     */
    selectSingle(index) {
        this.selectedIndices = [index];
    }
    
    /**
     * 토글 선택
     * @param {number} index 인덱스
     */
    toggleSelection(index) {
        const existingIndex = this.selectedIndices.indexOf(index);
        if (existingIndex > -1) {
            this.selectedIndices.splice(existingIndex, 1);
        } else {
            this.selectedIndices.push(index);
        }
    }
    
    /**
     * 범위 선택
     * @param {number} endIndex 끝 인덱스
     */
    selectRange(endIndex) {
        if (this.selectedIndices.length === 0) {
            this.selectSingle(endIndex);
            return;
        }
        
        const startIndex = this.selectedIndices[this.selectedIndices.length - 1];
        const minIndex = Math.min(startIndex, endIndex);
        const maxIndex = Math.max(startIndex, endIndex);
        
        this.selectedIndices = [];
        for (let i = minIndex; i <= maxIndex; i++) {
            this.selectedIndices.push(i);
        }
    }
    
    /**
     * 모든 아이템 선택
     */
    selectAll() {
        this.selectedIndices = this.currentImages.map((_, index) => index);
        this.updateSelectionUI();
        this.viewer.gridSelectedIdxs = [...this.selectedIndices];
    }
    
    /**
     * 선택 해제
     */
    clearSelection() {
        this.selectedIndices = [];
        this.updateSelectionUI();
        this.viewer.gridSelectedIdxs = [];
    }
    
    /**
     * 선택 상태 UI 업데이트
     */
    updateSelectionUI() {
        if (!this.container) return;
        
        const gridItems = this.container.querySelectorAll('.grid-item');
        
        gridItems.forEach((item, index) => {
            const isSelected = this.selectedIndices.includes(index);
            item.classList.toggle('selected', isSelected);
        });
        
        // 선택 카운트 업데이트
        this.updateSelectionCount();
    }
    
    /**
     * 선택 카운트 업데이트
     */
    updateSelectionCount() {
        const countElement = document.getElementById('grid-selection-count');
        if (countElement) {
            const total = this.currentImages.length;
            const selected = this.selectedIndices.length;
            countElement.textContent = `${selected} / ${total} 선택됨`;
        }
    }
    
    /**
     * 키보드 이벤트 처리
     * @param {KeyboardEvent} event 키보드 이벤트
     */
    handleKeyDown(event) {
        if (!this.viewer.gridMode) return;
        
        switch (event.key) {
            case 'a':
            case 'A':
                if (event.ctrlKey) {
                    event.preventDefault();
                    this.selectAll();
                }
                break;
            case 'Escape':
                this.clearSelection();
                break;
            case 'Enter':
                // 단일 이미지 선택 시 상세 보기
                if (this.selectedIndices.length === 1) {
                    event.preventDefault();
                    const imagePath = this.currentImages[this.selectedIndices[0]];
                    if (imagePath) {
                        this.viewer.viewSingleImage(imagePath);
                    }
                }
                break;
        }
    }
    
    /**
     * 현재 선택된 이미지 경로들 반환
     * @returns {Array<string>} 선택된 이미지 경로들
     */
    getSelectedImages() {
        return this.selectedIndices.map(index => this.currentImages[index]).filter(Boolean);
    }
    
    /**
     * 그리드 숨기기
     */
    hide() {
        if (this.container) {
            this.container.innerHTML = '';
        }
        this.currentImages = [];
        this.selectedIndices = [];
        // 🔥 모든 진행 중인 요청 취소
        this.cancelAllLoads();
    }
    
    /**
     * 🔥 스크롤 핸들러 (디바운스: 50ms settle + 즉시 로드)
     * 스크롤 중에는 절대 요청하지 않으며, 진행 중인 요청도 모두 취소.
     * 스크롤 이벤트가 50ms 동안 없으면 "멈춤"으로 판정, 뷰포트 1.5배만 로드.
     */
    handleScroll() {
        // 🔥 스크롤 시작 시에만 진행 중인 요청 취소 (매 이벤트마다 반복 X)
        if (!this.isScrolling) {
            this.cancelAllLoads();
        }
        this.isScrolling = true;
        this.scrollPendingItems.clear();

        // 기존 타이머 클리어
        if (this.scrollDebounceTimer) {
            clearTimeout(this.scrollDebounceTimer);
        }

        // 🔥 50ms settle — scroll 이벤트 간격(~16ms)보다 충분히 길어야 진짜 멈춤 판정
        this.scrollDebounceTimer = setTimeout(() => {
            this.isScrolling = false;
            this.scrollPendingItems.clear();
            this.loadVisibleImages();
        }, 50);
    }

    /**
     * 🔥 모든 진행 중인 이미지 로드 취소
     */
    cancelAllLoads() {
        this.abortControllers.forEach((controller) => {
            controller.abort();
        });
        this.abortControllers.clear();
        this.loadingThumbnails.clear();
    }

    /**
     * 🔥 현재 뷰포트에 보이는 이미지만 즉시 로드
     */
    /**
     * 🔥 현재 뷰포트 1.5배 영역에 보이는 이미지만 즉시 로드
     * 스크롤이 멈춘 후 1ms 뒤에만 호출됨.
     */
    loadVisibleImages() {
        if (!this.container) return;

        const gridItems = this.container.querySelectorAll('.grid-item[data-src]');
        const containerRect = this.container.getBoundingClientRect();

        // 🔥 뷰포트 1.5배 영역: 위아래로 25%씩 확장
        const viewportHeight = containerRect.height;
        const verticalPadding = viewportHeight * 0.25;

        gridItems.forEach((gridItem) => {
            const itemRect = gridItem.getBoundingClientRect();

            // 🔥 뷰포트 1.5배 내에 있는지 확인
            const isVisible = (
                itemRect.top < containerRect.bottom + verticalPadding &&
                itemRect.bottom > containerRect.top - verticalPadding &&
                itemRect.left < containerRect.right &&
                itemRect.right > containerRect.left
            );

            if (isVisible) {
                const index = parseInt(gridItem.dataset.index);
                if (!this.loadingThumbnails.has(index)) {
                    this.loadThumbnail(gridItem);
                }
            }
        });
    }

    /**
     * 리소스 정리
     */
    cleanup() {
        if (this.observer) {
            this.observer.disconnect();
        }
        if (this.scrollDebounceTimer) {
            clearTimeout(this.scrollDebounceTimer);
        }
        // 🔥 모든 진행 중인 요청 취소
        this.cancelAllLoads();
        document.removeEventListener('keydown', this.handleKeyDown);
    }
}
