/**
 * Wafer Navigator
 * 플로팅 웨이퍼 네비게이터 - 드래그, 리사이즈, 윈도우 스냅 기능
 */

export class ThumbnailNavigator {
    constructor(viewer) {
        this.viewer = viewer;
        this.container = document.getElementById('thumbnail-navigator');
        this.header = this.container?.querySelector('.thumbnail-navigator-header');
        this.closeBtn = this.container?.querySelector('.thumbnail-navigator-close');
        this.list = document.getElementById('thumbnail-navigator-list');
        this.resizeHandle = this.container?.querySelector('.thumbnail-navigator-resize-handle');
        this.snapOverlay = document.getElementById('snap-zone-overlay');

        // 상태
        this.isVisible = false;
        this.isDragging = false;
        this.isResizing = false;
        this.layout = 'horizontal'; // 'vertical' or 'horizontal' (default: horizontal)

        // 위치 및 크기 (디폴트: Wafer Map Explorer 위)
        this.position = { x: 10, y: 10 };
        this.size = { width: 380, height: 130 };

        // 스냅 존 설정
        this.snapThreshold = 20; // px
        this.snapZones = {
            left: { x: 0, y: 0, width: 300, height: 0, layout: 'vertical' },
            right: { x: 0, y: 0, width: 300, height: 0, layout: 'vertical' },
            top: { x: 0, y: 0, width: 0, height: 150, layout: 'horizontal' },
            bottom: { x: 0, y: 0, width: 0, height: 150, layout: 'horizontal' }
        };

        // 드래그 상태
        this.dragStart = { x: 0, y: 0 };
        this.resizeStart = { x: 0, y: 0, width: 0, height: 0 };

        // 현재 이미지 리스트
        this.imageList = [];
        this.currentImageIndex = -1;

        if (this.container) {
            this.init();
        }
    }

    init() {
        // 이벤트 바인딩
        this.bindEvents();

        // 초기 레이아웃 설정
        this.container.classList.add(this.layout);

        // 디폴트 크기 계산 (viewer container의 70%)
        this.calculateDefaultSize();

        // sessionStorage에서 복원
        this.restoreFromSession();
    }

    calculateDefaultSize() {
        const viewerContainer = document.querySelector('.viewer-container');
        if (viewerContainer) {
            const containerWidth = viewerContainer.offsetWidth;
            const containerHeight = viewerContainer.offsetHeight;

            // 너비: 70%, 높이: 130px (horizontal 레이아웃)
            this.size.width = Math.floor(containerWidth * 0.7);
            this.size.height = 130;
        }
    }

    bindEvents() {
        // 닫기 버튼
        if (this.closeBtn) {
            this.closeBtn.addEventListener('click', () => this.hide());
        }

        // 드래그 이벤트
        if (this.header) {
            this.header.addEventListener('mousedown', (e) => this.startDrag(e));
        }

        // 리사이즈 이벤트
        if (this.resizeHandle) {
            this.resizeHandle.addEventListener('mousedown', (e) => this.startResize(e));
        }

        // 전역 이벤트
        document.addEventListener('mousemove', (e) => this.onMouseMove(e));
        document.addEventListener('mouseup', (e) => this.onMouseUp(e));
    }

    startDrag(e) {
        if (e.target.closest('.thumbnail-navigator-close')) return;

        this.isDragging = true;
        this.dragStart = {
            x: e.clientX - this.position.x,
            y: e.clientY - this.position.y
        };

        e.preventDefault();
    }

    startResize(e) {
        this.isResizing = true;
        this.resizeStart = {
            x: e.clientX,
            y: e.clientY,
            width: this.size.width,
            height: this.size.height
        };

        e.preventDefault();
        e.stopPropagation();
    }

    onMouseMove(e) {
        if (this.isDragging) {
            this.handleDrag(e);
        } else if (this.isResizing) {
            this.handleResize(e);
        }
    }

    handleDrag(e) {
        const x = e.clientX - this.dragStart.x;
        const y = e.clientY - this.dragStart.y;

        // 스냅 존 감지
        const snapZone = this.detectSnapZone(e.clientX, e.clientY);

        if (snapZone) {
            this.showSnapPreview(snapZone);
        } else {
            this.hideSnapPreview();
            this.position = { x, y };
            this.updatePosition();
        }
    }

    handleResize(e) {
        const deltaX = e.clientX - this.resizeStart.x;
        const deltaY = e.clientY - this.resizeStart.y;

        let newWidth = this.resizeStart.width + deltaX;
        let newHeight = this.resizeStart.height + deltaY;

        // 최소/최대 크기 제한
        newWidth = Math.max(150, Math.min(newWidth, window.innerWidth - this.position.x - 20));
        newHeight = Math.max(150, Math.min(newHeight, window.innerHeight - this.position.y - 20));

        this.size = { width: newWidth, height: newHeight };
        this.updateSize();
    }

    onMouseUp(e) {
        if (this.isDragging) {
            // 스냅 존에 드롭된 경우
            const snapZone = this.detectSnapZone(e.clientX, e.clientY);
            if (snapZone) {
                this.applySnap(snapZone);
            }
            this.hideSnapPreview();
            this.saveToSession();
        }

        if (this.isResizing) {
            this.saveToSession();
        }

        this.isDragging = false;
        this.isResizing = false;
    }

    detectSnapZone(mouseX, mouseY) {
        const { innerWidth, innerHeight } = window;

        // 왼쪽
        if (mouseX < this.snapThreshold) {
            return {
                name: 'left',
                x: 0,
                y: 0,
                width: 300,
                height: innerHeight,
                layout: 'vertical'
            };
        }

        // 오른쪽
        if (mouseX > innerWidth - this.snapThreshold) {
            return {
                name: 'right',
                x: innerWidth - 300,
                y: 0,
                width: 300,
                height: innerHeight,
                layout: 'vertical'
            };
        }

        // 상단
        if (mouseY < this.snapThreshold) {
            return {
                name: 'top',
                x: 0,
                y: 0,
                width: innerWidth,
                height: 150,
                layout: 'horizontal'
            };
        }

        // 하단
        if (mouseY > innerHeight - this.snapThreshold) {
            return {
                name: 'bottom',
                x: 0,
                y: innerHeight - 150,
                width: innerWidth,
                height: 150,
                layout: 'horizontal'
            };
        }

        return null;
    }

    showSnapPreview(zone) {
        if (!this.snapOverlay) return;

        this.snapOverlay.style.display = 'block';
        this.snapOverlay.style.left = `${zone.x}px`;
        this.snapOverlay.style.top = `${zone.y}px`;
        this.snapOverlay.style.width = `${zone.width}px`;
        this.snapOverlay.style.height = `${zone.height}px`;
    }

    hideSnapPreview() {
        if (this.snapOverlay) {
            this.snapOverlay.style.display = 'none';
        }
    }

    applySnap(zone) {
        this.position = { x: zone.x, y: zone.y };
        this.size = { width: zone.width, height: zone.height };
        this.layout = zone.layout;

        // 레이아웃 클래스 전환
        this.container.classList.remove('vertical', 'horizontal');
        this.container.classList.add(this.layout);

        this.updatePosition();
        this.updateSize();
    }

    updatePosition() {
        if (!this.container) return;
        this.container.style.left = `${this.position.x}px`;
        this.container.style.top = `${this.position.y}px`;
    }

    updateSize() {
        if (!this.container) return;
        this.container.style.width = `${this.size.width}px`;
        this.container.style.height = `${this.size.height}px`;
    }

    /**
     * 썸네일 네비게이터 표시
     */
    show() {
        if (!this.container) return;

        this.isVisible = true;
        this.container.style.display = 'flex';
        this.updatePosition();
        this.updateSize();

        // 썸네일 렌더링
        this.render();
    }

    /**
     * 썸네일 네비게이터 숨김
     */
    hide() {
        if (!this.container) return;

        this.isVisible = false;
        this.container.style.display = 'none';
        this.clearThumbnails();
    }

    /**
     * 토글
     */
    toggle() {
        if (this.isVisible) {
            this.hide();
        } else {
            this.show();
        }
    }

    /**
     * 이미지 리스트 설정 및 렌더링
     * @param {Array<string>} images - 이미지 경로 배열
     * @param {string} currentImagePath - 현재 이미지 경로
     */
    setImages(images, currentImagePath) {
        this.imageList = images || [];
        this.currentImageIndex = this.imageList.indexOf(currentImagePath);

        if (this.isVisible) {
            this.render();
        }
    }

    /**
     * 썸네일 렌더링
     */
    render() {
        if (!this.list) return;

        // 기존 썸네일 제거
        this.clearThumbnails();

        if (this.imageList.length === 0) {
            this.list.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">No images</p>';
            return;
        }

        // 썸네일 생성
        this.imageList.forEach((imagePath, index) => {
            const item = this.createThumbnailItem(imagePath, index);
            this.list.appendChild(item);
        });

        // 현재 이미지로 스크롤
        this.scrollToCurrentImage();
    }

    createThumbnailItem(imagePath, index) {
        const item = document.createElement('div');
        item.className = 'thumbnail-nav-item';
        if (index === this.currentImageIndex) {
            item.classList.add('active');
        }

        // 이미지 컨테이너
        const imageContainer = document.createElement('div');
        imageContainer.className = 'thumbnail-nav-item-image';

        const img = document.createElement('img');

        // 개인화된 색상 스킴 파라미터 추가
        const personalizedParams = this.viewer ? this.viewer.getPersonalizedParams() : '';
        const cacheBuster = this.viewer?._personalizedColorCacheBuster || Date.now();
        img.src = `/api/thumbnail?path=${encodeURIComponent(imagePath)}${personalizedParams}&_t=${cacheBuster}`;
        img.alt = imagePath.split('/').pop();
        img.loading = 'lazy';

        imageContainer.appendChild(img);

        // 파일명 표시
        const fileName = document.createElement('div');
        fileName.className = 'thumbnail-nav-item-filename';
        let displayName = imagePath.split('/').pop();

        // sum_map.png를 composite(median)으로 표시
        if (displayName === 'sum_map.png' || displayName === 'sum_map') {
            displayName = 'composite(median)';
        }
        // index_로 시작하는 파일명을 grade_로 변경
        else if (displayName.startsWith('index_')) {
            displayName = displayName.replace(/^index_/, 'grade_');
            // 확장자 제거 후 표시
            const nameWithoutExt = displayName.replace(/\.(png|jpg|jpeg|gif|webp)$/i, '');
            displayName = nameWithoutExt;
        }

        fileName.textContent = displayName;
        fileName.title = imagePath;

        item.appendChild(imageContainer);
        item.appendChild(fileName);

        // 클릭 이벤트
        item.addEventListener('click', () => {
            this.onThumbnailClick(imagePath, index);
        });

        return item;
    }

    onThumbnailClick(imagePath, index) {
        // 이미지 로드 (뷰 유지)
        if (this.viewer && typeof this.viewer.loadImage === 'function') {
            this.viewer.loadImage(imagePath, false, true);  // preserveView=true
        }

        // 하이라이트 업데이트
        this.updateHighlight(index);
    }

    updateHighlight(index) {
        if (!this.list) return;

        this.currentImageIndex = index;

        const items = this.list.querySelectorAll('.thumbnail-nav-item');
        items.forEach((item, i) => {
            if (i === index) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });

        // 스크롤
        this.scrollToIndex(index);
    }

    scrollToCurrentImage() {
        if (this.currentImageIndex >= 0) {
            this.scrollToIndex(this.currentImageIndex);
        }
    }

    scrollToIndex(index) {
        if (!this.list) return;

        const items = this.list.querySelectorAll('.thumbnail-nav-item');
        if (index >= 0 && index < items.length) {
            const targetItem = items[index];
            targetItem.scrollIntoView({
                behavior: 'smooth',
                block: 'center',
                inline: 'center'
            });
        }
    }

    clearThumbnails() {
        if (this.list) {
            this.list.innerHTML = '';
        }
    }

    /**
     * sessionStorage에 저장
     */
    saveToSession() {
        const state = {
            position: this.position,
            size: this.size,
            layout: this.layout
        };
        sessionStorage.setItem('thumbnailNavigator', JSON.stringify(state));
    }

    /**
     * sessionStorage에서 복원
     */
    restoreFromSession() {
        try {
            const saved = sessionStorage.getItem('thumbnailNavigator');
            if (saved) {
                const state = JSON.parse(saved);
                this.position = state.position || this.position;
                this.size = state.size || this.size;
                this.layout = state.layout || this.layout;

                // 레이아웃 클래스 적용
                this.container.classList.remove('vertical', 'horizontal');
                this.container.classList.add(this.layout);

                this.updatePosition();
                this.updateSize();
            }
        } catch (error) {
            console.warn('Failed to restore thumbnail navigator state:', error);
        }
    }

    /**
     * 현재 이미지 경로로 하이라이트 업데이트
     * @param {string} imagePath - 현재 이미지 경로
     */
    updateCurrentImage(imagePath) {
        const index = this.imageList.indexOf(imagePath);
        if (index >= 0) {
            this.updateHighlight(index);
        }
    }
}
