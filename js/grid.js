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
            this.observer = new IntersectionObserver(
                (entries) => this.handleIntersection(entries),
                {
                    root: null,
                    rootMargin: '100px',
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
        
        // 그리드 컨테이너 클릭 이벤트 (이벤트 위임)
        this.container.addEventListener('click', (e) => {
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
        
        // enterSingleImageMode 호출
        if (typeof this.viewer.enterSingleImageMode === 'function') {
            this.viewer.enterSingleImageMode(index);
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
        if (lowerName === 'square_average.png' || lowerName === 'square_average' || displayName === 'sum_map.png') {
            displayName = 'composite(square-avg)';
        } else if (lowerName === 'square_weighted_average.png' || lowerName === 'square_weighted_average' || lowerName.startsWith('sum_map_weighted')) {
            displayName = 'composite(weighted)';
        } else if (/^(index_|grade_)/i.test(displayName)) {
            displayName = displayName.replace(/^(index_|grade_)/i, 'Grade_');
            const nameWithoutExt = displayName.replace(/\.(png|jpg|jpeg|gif|webp)$/i, '');
            displayName = nameWithoutExt;
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
                this.loadThumbnail(entry.target);
                this.observer.unobserve(entry.target);
            }
        });
    }
    
    /**
     * 썸네일 로드
     * @param {HTMLElement} gridItem 그리드 아이템
     */
    async loadThumbnail(gridItem) {
        const src = gridItem.dataset.src;
        const index = parseInt(gridItem.dataset.index);
        
        if (!src || this.loadingThumbnails.has(index)) return;
        
        this.loadingThumbnails.add(index);
        
        try {
            const img = gridItem.querySelector('.grid-thumbnail');
            if (!img) return;
            
            // 이미지 프리로드
            const preloadImg = new Image();
            preloadImg.onload = () => {
                img.src = src;
                gridItem.classList.add('loaded');
            };
            preloadImg.onerror = () => {
                img.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iIzMzMyIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmaWxsPSIjZjAwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBkeT0iMC4zZW0iPkVycm9yPC90ZXh0Pjwvc3ZnPg==';
                gridItem.classList.add('error');
            };
            preloadImg.src = src;
            
        } catch (error) {
            console.error('썸네일 로드 오류:', error);
        } finally {
            this.loadingThumbnails.delete(index);
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
        this.loadingThumbnails.clear();
    }
    
    /**
     * 리소스 정리
     */
    cleanup() {
        if (this.observer) {
            this.observer.disconnect();
        }
        this.loadingThumbnails.clear();
        document.removeEventListener('keydown', this.handleKeyDown);
    }
}
