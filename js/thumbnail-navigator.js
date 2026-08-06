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

        this.resizeHandleRight = this.container?.querySelector('.thumbnail-navigator-resize-handle-right');

        this.resizeHandleLeft = this.container?.querySelector('.thumbnail-navigator-resize-handle-left'); // 🔥 왼쪽 리사이즈 핸들

        this.snapOverlay = document.getElementById('snap-zone-overlay');

        this.onPointerMove = this.onMouseMove.bind(this);

        this.onPointerUp = this.onMouseUp.bind(this);



        // 상태

        this.isVisible = false;

        this.isDragging = false;

        this.isResizing = false;

        this.isResizingWidth = false; // 너비만 조절 (오른쪽 핸들)
        this.isResizingWidthLeft = false; // 🔥 왼쪽 핸들 너비 조절

        this.layout = 'vertical'; // 'vertical' or 'horizontal' (default: vertical)

        this.isFloating = false;



        // 위치 및 크기 (디폴트)

        this.position = { x: 10, y: 10 };

        this.size = { width: 100, height: 450 };



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

        // 🔥 스크롤 디바운스 (스크롤 멈춘 후 0.1초 후 로드)

        this.scrollDebounceTimer = null;

        this.isScrolling = false;

        // 🔥 Virtual Scroll 상태 (300개 이상일 때 활성화)
        this._vsEnabled = false;
        this._vsItemSize = 0;       // 아이템 높이(vertical) 또는 너비(horizontal) + gap
        this._vsGap = 8;            // CSS gap
        this._vsPadding = 8;        // CSS padding
        this._vsSpacer = null;      // 총 높이를 잡는 spacer div
        this._vsRenderedRange = { start: -1, end: -1 };
        this._vsItemMap = new Map(); // index → DOM element
        this._vsScrollRAF = null;
        this._vsThreshold = 300;    // 이 개수 이상이면 virtual scroll 활성화
        this._vsContentWidth = 0;   // 스크롤바 제외한 콘텐츠 너비



        if (this.container) {

            this.init();

        }

    }



    init() {

        // Navigator를 sidebar 내부로 이동
        const sidebar = document.querySelector('.sidebar');

        if (sidebar && this.container && this.container.parentElement !== sidebar) {

            sidebar.appendChild(this.container);

        }



        // 이벤트 바인딩

        this.bindEvents();



        // 초기 레이아웃 설정

        this.container.classList.add(this.layout);



        // 디폴트 크기 계산

        this.calculateDefaultSize();



        // sessionStorage에서 복원 (위치는 복원하지 않음 - 항상 고정)

        this.restoreFromSession();

    }



    calculateDefaultSize() {

        // 내부 표시 영역을 정확히 80x500(px)로 보장하기 위한 외곽 크기

        // 내부 = 컨테이너 - 보더(2) - 헤더(32) - 패딩(상하 5*2, 좌우 5*2)

        // width: 80 = W - 2 - 10  => W = 92

        // height: 500 = H - 2 - 32 - 10 => H = 544
        // 🔥 기본 너비 증가: 92px → 120px (글자 영역 확대)

        this.size.width = 120;

        this.size.height = 544;

    }



    calculateNavigatorPosition() {

        if (!this.container) return;



        // file-explorer 요소 찾기

        const fileExplorer = document.getElementById('file-explorer');

        if (!fileExplorer) return;



        // sidebar 요소 찾기 (네비게이터의 부모)

        const sidebar = this.container.parentElement;

        if (!sidebar) return;



        // file-explorer의 sidebar 기준 상대 위치 계산

        const sidebarRect = sidebar.getBoundingClientRect();

        const explorerRect = fileExplorer.getBoundingClientRect();

        const topOffset = explorerRect.top - sidebarRect.top;



        // sidebar의 높이와 bottom 여백을 고려하여 높이 계산

        const sidebarHeight = sidebarRect.height;

        const bottomMargin = 12; // bottom 여백

        const calculatedHeight = sidebarHeight - topOffset - bottomMargin;



        // 네비게이터의 top을 file-explorer의 top에 맞춤

        this.container.style.top = `${topOffset}px`;

        this.container.style.bottom = `${bottomMargin}px`;

        this.container.style.transform = 'none';



        // 높이를 동적으로 계산하여 설정

        this.size.height = Math.max(150, calculatedHeight); // 최소 높이 150px 보장

    }



    bindEvents() {

        // 🔥 닫기 버튼 - 네비게이터만 숨기기 (단일 이미지 모드는 유지)

        if (this.closeBtn) {

            this.closeBtn.addEventListener('click', () => {

                // 🔥 네비게이터만 숨기기 (기능은 유지 - 넥스트/프리브 버튼 계속 동작)

                this.hide();

            });

        }

        if (this.header) {

            this.header.addEventListener('pointerdown', (e) => {

                if (e.button !== undefined && e.button !== 0) return;

                this.startDrag(e);

            });

        }



        if (this.resizeHandle) {

            this.resizeHandle.addEventListener('pointerdown', (e) => {

                if (e.button !== undefined && e.button !== 0) return;

                this.startResize(e);

            });

        }



        if (this.resizeHandleRight) {

            this.resizeHandleRight.addEventListener('pointerdown', (e) => {

                if (e.button !== undefined && e.button !== 0) return;

                this.startResizeWidth(e);

            });

        }

        // 🔥 왼쪽 리사이즈 핸들 이벤트
        if (this.resizeHandleLeft) {

            this.resizeHandleLeft.addEventListener('pointerdown', (e) => {

                if (e.button !== undefined && e.button !== 0) return;

                this.startResizeWidthLeft(e);

            });

        }



        document.addEventListener('pointermove', this.onPointerMove);

        document.addEventListener('pointerup', this.onPointerUp);

        window.addEventListener('resize', () => {
            if (this.isVisible) {
                this.calculateNavigatorPosition();
                this.updateSize();
            }
            this.keepWithinViewport();
        });

        // 🔥 스크롤 이벤트 리스너 추가 (디바운스)

        if (this.list) {

            this.list.addEventListener('scroll', () => {

                this.handleScroll();

            });

        }





        // 드래그 비활성화 (위치 고정)

        // 리사이즈도 비활성화 (크기 고정)



        // 전역 이벤트는 필요 없음 (드래그/리사이즈 비활성화)

    }



    startDrag(e) {

        if (e.target.closest('.thumbnail-navigator-close')) return;



        this.prepareFloatingPosition();

        this.isDragging = true;

        this.dragStart = {

            x: e.clientX - this.position.x,

            y: e.clientY - this.position.y

        };



        e.preventDefault();

        e.stopPropagation(); // 🔥 부모 요소로 이벤트 전파 차단 (explorer 스크롤과 독립)

        if (e.pointerId !== undefined && typeof e.target.setPointerCapture === 'function') {

            e.target.setPointerCapture(e.pointerId);

        }

    }



    startResize(e) {

        this.prepareFloatingPosition();

        this.isResizing = true;

        this.resizeStart = {

            x: e.clientX,

            y: e.clientY,

            width: this.size.width,

            height: this.size.height

        };



        e.preventDefault();

        e.stopPropagation();

        if (e.pointerId !== undefined && typeof e.target.setPointerCapture === 'function') {

            e.target.setPointerCapture(e.pointerId);

        }

    }



    startResizeWidth(e) {

        this.prepareFloatingPosition();

        this.isResizingWidth = true;

        this.resizeStart = {

            x: e.clientX,

            y: e.clientY,

            width: this.size.width,

            height: this.size.height

        };



        e.preventDefault();

        e.stopPropagation();

        if (e.pointerId !== undefined && typeof e.target.setPointerCapture === 'function') {

            e.target.setPointerCapture(e.pointerId);

        }

    }

    // 🔥 왼쪽 핸들 너비 조절 시작
    startResizeWidthLeft(e) {

        this.prepareFloatingPosition();

        this.isResizingWidthLeft = true;

        this.resizeStart = {

            x: e.clientX,

            y: e.clientY,

            width: this.size.width,

            height: this.size.height,

            positionX: this.position.x // 왼쪽 위치 저장

        };



        e.preventDefault();

        e.stopPropagation();

        if (e.pointerId !== undefined && typeof e.target.setPointerCapture === 'function') {

            e.target.setPointerCapture(e.pointerId);

        }

    }



    onMouseMove(e) {

        if (this.isDragging) {

            this.handleDrag(e);

        } else if (this.isResizing) {

            this.handleResize(e);

        } else if (this.isResizingWidth) {

            this.handleResizeWidth(e);

        } else if (this.isResizingWidthLeft) {

            this.handleResizeWidthLeft(e);

        }

    }



    handleDrag(e) {

        const x = e.clientX - this.dragStart.x;

        const y = e.clientY - this.dragStart.y;

        const currentWidth = this.container?.offsetWidth || this.size.width;

        const currentHeight = this.container?.offsetHeight || this.size.height;

        const maxX = Math.max(0, window.innerWidth - currentWidth);

        const maxY = Math.max(0, window.innerHeight - currentHeight);

        const clampedX = Math.min(Math.max(0, x), maxX);

        const clampedY = Math.min(Math.max(0, y), maxY);



        // 스냅 존 감지

        const snapZone = this.detectSnapZone(e.clientX, e.clientY);



        if (snapZone) {

            this.showSnapPreview(snapZone);

        } else {

            this.hideSnapPreview();

            this.position = { x: clampedX, y: clampedY };

            this.updatePosition();

        }

    }



    handleResize(e) {

        const deltaX = e.clientX - this.resizeStart.x;

        const deltaY = e.clientY - this.resizeStart.y;



        let newWidth = this.resizeStart.width + deltaX;

        let newHeight = this.resizeStart.height + deltaY;



        // 최소/최대 크기 제한
        // 🔥 최소 너비 증가: 80px → 100px (글자 영역 확대)

        newWidth = Math.max(100, Math.min(newWidth, window.innerWidth - this.position.x - 20));

        newHeight = Math.max(150, Math.min(newHeight, window.innerHeight - this.position.y - 20));



        this.size = { width: newWidth, height: newHeight };

        this.updateSize();

    }



    handleResizeWidth(e) {

        const deltaX = e.clientX - this.resizeStart.x;



        let newWidth = this.resizeStart.width + deltaX;



        // 최소/최대 너비 제한
        // 🔥 최소 너비 증가: 80px → 100px (글자 영역 확대)

        newWidth = Math.max(100, Math.min(newWidth, window.innerWidth - this.position.x - 20));



        this.size.width = newWidth;

        this.updateSize();

    }

    // 🔥 왼쪽 핸들 너비 조절 처리
    handleResizeWidthLeft(e) {

        const deltaX = e.clientX - this.resizeStart.x;



        // 왼쪽에서 드래그하므로 deltaX만큼 너비 감소 (음수 방향)

        let newWidth = this.resizeStart.width - deltaX;



        // 최소/최대 너비 제한
        // 🔥 최소 너비 증가: 80px → 100px (글자 영역 확대)

        newWidth = Math.max(100, Math.min(newWidth, 600));



        // 너비가 변경되면 위치도 조정 (오른쪽 모서리 고정)

        const widthDiff = newWidth - this.size.width;



        this.size.width = newWidth;



        // position이 있을 때만 위치 조정 (플로팅 모드)

        if (this.isFloating && this.position.x !== undefined) {

            this.position.x -= widthDiff;

            this.updatePosition();

        } else {

            this.updateSize();

        }

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



        if (this.isResizingWidth) {

            this.saveToSession();

        }

        if (this.isResizingWidthLeft) {

            this.saveToSession();

        }



        this.isDragging = false;

        this.isResizing = false;

        this.isResizingWidth = false;

        this.isResizingWidthLeft = false;

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

        this.prepareFloatingPosition();

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

        this.container.style.position = 'fixed';

        this.container.style.left = `${this.position.x}px`;

        this.container.style.top = `${this.position.y}px`;

        this.container.style.right = 'auto';

        this.container.style.bottom = 'auto';

        this.container.style.transform = 'none';

        this.container.style.margin = '0';

        this.isFloating = true;

    }



    updateSize() {

        if (!this.container) return;

        // 크기만 설정 (위치는 CSS 고정)

        this.container.style.width = `${this.size.width}px`;

        this.container.style.height = `${this.size.height}px`;

        // left, top은 설정하지 않음 (CSS의 right, top, transform 유지)

    }



    /**

     * 썸네일 네비게이터 표시

     */

    show() {

        if (!this.container) return;



        this.isVisible = true;

        this.container.style.display = 'flex';



        // 네비게이터 위치 및 크기 동적 계산
        this.calculateNavigatorPosition();



        // 기본 너비 설정 (높이는 calculateNavigatorPosition에서 설정됨)
        // 🔥 기본 너비 증가: 92px → 120px (글자 영역 확대)

        this.size.width = 120;



        // 위치는 CSS로 고정 (updatePosition 호출 안 함)

        // 크기만 설정

        this.updateSize();

        if ((!this.imageList || this.imageList.length === 0) && this.viewer) {

            const viewerList = (this.viewer.singleViewImageList && this.viewer.singleViewImageList.length > 0)

                ? [...this.viewer.singleViewImageList]

                : (this.viewer.selectedImagePath ? [this.viewer.selectedImagePath] : []);



            if (viewerList.length > 0) {

                const currentPath = this.viewer.selectedImagePath || viewerList[0];

                this.setImages(viewerList, currentPath);

                return;

            }

        }





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

    setImages(images, currentImagePath, forceRender = false) {

        this.imageList = images || [];



        // ✅ 정규화된 경로로 비교 (백슬래시, 대소문자 등 처리)

        const normalizedCurrent = String(currentImagePath || '').replace(/\\/g, '/').toLowerCase();

        this.currentImageIndex = this.imageList.findIndex(path => {

            const normalized = String(path || '').replace(/\\/g, '/').toLowerCase();

            return normalized === normalizedCurrent ||

                   normalized.endsWith(normalizedCurrent) ||

                   normalizedCurrent.endsWith(normalized);

        });



        if (this.currentImageIndex === -1) {

            console.warn('[WAFER_NAV] Current image not found in list:', currentImagePath);

            console.warn('[WAFER_NAV] First 5 items in list:', this.imageList.slice(0, 5));

        }



        console.log(`[WAFER_NAV] setImages called - imageList length: ${this.imageList.length}, currentIndex: ${this.currentImageIndex}`);



        if (this.isVisible || forceRender) {
            this.render();
        }

    }

    /**
     * 🔥 메인 이미지 로드 완료 후 호출 — 나머지 썸네일을 점진적으로 로드
     */
    loadRemainingThumbnails() {
        if (!this.list) return;
        const imgs = this.list.querySelectorAll('img[data-src]');
        if (imgs.length === 0) return;
        let idx = 0;
        const BATCH = 8;
        const loadBatch = () => {
            const end = Math.min(idx + BATCH, imgs.length);
            for (; idx < end; idx++) {
                const img = imgs[idx];
                if (img.dataset.src && !img.src) {
                    img.src = img.dataset.src;
                    delete img.dataset.src;
                }
            }
            if (idx < imgs.length) {
                requestAnimationFrame(loadBatch);
            }
        };
        requestAnimationFrame(loadBatch);
    }



    /**

     * 썸네일 렌더링

     */

    render() {

        if (!this.list) return;

        this.clearThumbnails();

        if (this.imageList.length === 0) {

            this.list.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">No images</p>';

            return;

        }

        // 🔥 300개 미만: 기존 방식 (전체 DOM 생성)
        if (this.imageList.length < this._vsThreshold) {

            this._vsEnabled = false;
            const fragment = document.createDocumentFragment();

            this.imageList.forEach((imagePath, index) => {

                fragment.appendChild(this.createThumbnailItem(imagePath, index));

            });

            this.list.appendChild(fragment);

            requestAnimationFrame(() => {

                this.list.offsetHeight;

                this.scrollToCurrentImage();

            });

            return;

        }

        // 🔥 Virtual Scrolling: 보이는 아이템만 DOM에 렌더링
        this._vsEnabled = true;
        this._measureItemSize();

        this.list.style.position = 'relative';
        this.list.style.display = 'block';

        this._vsSpacer = document.createElement('div');
        const totalSize = this._vsPadding +
            this.imageList.length * this._vsItemSize - this._vsGap + this._vsPadding;
        if (this.layout === 'vertical') {
            this._vsSpacer.style.height = `${totalSize}px`;
            this._vsSpacer.style.width = '100%';
        } else {
            this._vsSpacer.style.width = `${totalSize}px`;
            this._vsSpacer.style.height = '100%';
        }
        this._vsSpacer.style.pointerEvents = 'none';
        this.list.appendChild(this._vsSpacer);

        this._vsRenderedRange = { start: -1, end: -1 };
        this._vsItemMap = new Map();

        requestAnimationFrame(() => {
            this._vsContentWidth = this.list.clientWidth;
            if (this.currentImageIndex >= 0) {
                this._vsScrollToIndex(this.currentImageIndex);
            }
            this._vsRenderVisible();
        });

    }



    /**
     * 🔥 Virtual Scroll: 아이템 크기 측정 (flex 모드에서 측정 후 block으로 전환)
     */
    _measureItemSize() {
        const temp = document.createElement('div');
        temp.className = 'thumbnail-nav-item';
        temp.style.visibility = 'hidden';

        const imgContainer = document.createElement('div');
        imgContainer.className = 'thumbnail-nav-item-image';
        temp.appendChild(imgContainer);

        const fileName = document.createElement('div');
        fileName.className = 'thumbnail-nav-item-filename';
        fileName.textContent = 'X';
        temp.appendChild(fileName);

        // List는 아직 flex 모드 → 자연 크기 측정 가능
        this.list.appendChild(temp);
        temp.offsetHeight; // force layout

        if (this.layout === 'vertical') {
            this._vsItemSize = temp.offsetHeight + this._vsGap;
        } else {
            this._vsItemSize = temp.offsetWidth + this._vsGap;
        }

        this.list.removeChild(temp);

        if (this._vsItemSize <= this._vsGap) {
            this._vsItemSize = 100 + this._vsGap;
        }
    }

    /**
     * 🔥 Virtual Scroll: 보이는 범위만 DOM에 렌더링
     */
    _vsRenderVisible() {
        if (!this._vsEnabled || !this.list) return;

        const isVertical = this.layout === 'vertical';
        const scrollPos = isVertical ? this.list.scrollTop : this.list.scrollLeft;
        const viewSize = isVertical ? this.list.clientHeight : this.list.clientWidth;

        const BUFFER = 20;

        let startIndex = Math.floor((scrollPos - this._vsPadding) / this._vsItemSize);
        let endIndex = Math.ceil((scrollPos + viewSize - this._vsPadding) / this._vsItemSize);

        startIndex = Math.max(0, startIndex - BUFFER);
        endIndex = Math.min(this.imageList.length - 1, endIndex + BUFFER);

        if (startIndex === this._vsRenderedRange.start && endIndex === this._vsRenderedRange.end) {
            return;
        }

        // 범위 밖 아이템 제거
        for (const [idx, el] of this._vsItemMap) {
            if (idx < startIndex || idx > endIndex) {
                el.remove();
                this._vsItemMap.delete(idx);
            }
        }

        const contentWidth = this._vsContentWidth || this.list.clientWidth;
        const itemWidth = contentWidth - this._vsPadding * 2;

        // 새 아이템 추가
        for (let i = startIndex; i <= endIndex; i++) {
            if (this._vsItemMap.has(i)) continue;

            const item = this.createThumbnailItem(this.imageList[i], i);
            item.style.position = 'absolute';

            const pos = this._vsPadding + i * this._vsItemSize;
            if (isVertical) {
                item.style.top = `${pos}px`;
                item.style.left = `${this._vsPadding}px`;
                item.style.width = `${itemWidth}px`;
            } else {
                item.style.left = `${pos}px`;
                item.style.top = `${this._vsPadding}px`;
                item.style.height = `calc(100% - ${this._vsPadding * 2}px)`;
            }

            this.list.appendChild(item);
            this._vsItemMap.set(i, item);
        }

        this._vsRenderedRange = { start: startIndex, end: endIndex };
    }

    /**
     * 🔥 Virtual Scroll: 특정 인덱스로 즉시 스크롤
     */
    _vsScrollToIndex(index) {
        if (!this.list) return;

        const isVertical = this.layout === 'vertical';
        const viewSize = isVertical ? this.list.clientHeight : this.list.clientWidth;
        const targetPos = this._vsPadding + index * this._vsItemSize - viewSize / 2 + this._vsItemSize / 2;

        if (isVertical) {
            this.list.scrollTop = Math.max(0, targetPos);
        } else {
            this.list.scrollLeft = Math.max(0, targetPos);
        }
    }

    /**
     * 🔥 Virtual Scroll: 렌더된 아이템의 data-src를 src로 전환
     */
    _vsLoadVisibleImages() {
        for (const [, item] of this._vsItemMap) {
            const img = item.querySelector('img');
            if (img && img.dataset.src) {
                img.style.display = 'none';
                img.src = img.dataset.src;
                delete img.dataset.src;
            }
        }
    }

    /**
     * 🔥 Virtual Scroll: 특정 인덱스 주변 썸네일 로드
     */
    _vsLoadNearbyImages(index, range = 30) {
        const start = Math.max(0, index - range);
        const end = Math.min(this.imageList.length - 1, index + range);

        for (let i = start; i <= end; i++) {
            const item = this._vsItemMap.get(i);
            if (!item) continue;
            const img = item.querySelector('img');
            if (img && img.dataset.src) {
                img.style.display = 'none';
                img.src = img.dataset.src;
                delete img.dataset.src;
            }
        }
    }

    /**
     * 색상 스킴 변경 시 DOM 재생성 없이 기존 img.src/data-src만 갱신
     */
    refreshThumbnailUrls(currentPath) {
        if (!this.list || !this.viewer || !this.imageList.length) return;

        const personalizedParams = this.viewer.getPersonalizedParams ? this.viewer.getPersonalizedParams() : '';
        const cacheBuster = this.viewer._personalizedColorCacheBuster || Date.now();
        const hasBusterInParams = typeof personalizedParams === 'string' && personalizedParams.includes('_t=');
        const cacheSuffix = hasBusterInParams ? '' : `&_t=${cacheBuster}`;

        // currentIndex 갱신
        if (currentPath) {
            const norm = currentPath.replace(/\\/g, '/');
            const idx = this.imageList.findIndex(p => {
                const pn = p.replace(/\\/g, '/');
                return pn === norm || pn.endsWith(norm) || norm.endsWith(pn);
            });
            if (idx !== -1) this.currentImageIndex = idx;
        }

        // 🔥 Virtual Scroll: 렌더된 아이템만 갱신 후 재생성 강제
        if (this._vsEnabled) {
            for (const [idx, el] of this._vsItemMap) {
                el.remove();
            }
            this._vsItemMap.clear();
            this._vsRenderedRange = { start: -1, end: -1 };
            this._vsRenderVisible();
            return;
        }

        const items = this.list.querySelectorAll('.thumbnail-nav-item');
        const priorityRange = 30;

        items.forEach((item, i) => {
            const img = item.querySelector('img');
            if (!img) return;
            const imagePath = this.imageList[i];
            if (!imagePath) return;

            // 🔥 Measure overlay 모드 판별 후 적절한 URL 사용
            let newUrl;
            const v = this.viewer;
            // 🔥 다중 Measure: _gridMeasureMap에서 인덱스별 measure item 참조
            const measureItem = v?._gridMeasureMap ? v._gridMeasureMap[i] : null;
            if (measureItem && v._buildMeasureThumbUrl) {
                newUrl = v._buildMeasureThumbUrl(imagePath, measureItem, cacheSuffix);
                newUrl = newUrl.replace('size=512', 'size=256');
            } else {
                const systematic = v?._measureCheckedItems?.find((item) => item.type === 'systematic');
                const isMeasure = v && (v.isMeasureGradientMode()) && v._ratioActiveItemKey;
                if (systematic && v._buildMeasureThumbUrl) {
                    newUrl = v._buildMeasureThumbUrl(imagePath, systematic, cacheSuffix)
                        .replace('size=512', 'size=256');
                } else if (isMeasure) {
                    const loginId = v.getCurrentLoginId();
                    const gf = v.selectedGradientRanges?.size > 0
                        ? Array.from(v.selectedGradientRanges).sort((a,b)=>a-b).join(',') : '';
                    newUrl = `/api/measure-thumb?path=${encodeURIComponent(imagePath)}&field=${v.overlayMode}&key=${encodeURIComponent(v._ratioActiveItemKey)}&size=256&scheme=${encodeURIComponent(loginId)}${gf ? '&gradient_filter=' + gf : ''}${cacheSuffix}`;
                } else if (v && v.overlayMode === 'bin') {
                    newUrl = `/api/thumbnail?path=${encodeURIComponent(imagePath)}${personalizedParams}&bin_overlay=1${cacheSuffix}`;
                } else {
                    newUrl = `/api/thumbnail?path=${encodeURIComponent(imagePath)}${personalizedParams}${cacheSuffix}`;
                }
            }
            const distance = Math.abs(i - this.currentImageIndex);

            if (distance <= priorityRange) {
                img.style.display = 'none';
                img.src = newUrl;
                delete img.dataset.src;
            } else {
                img.dataset.src = newUrl;
            }
        });
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

        const cacheBuster = this.viewer?._personalizedColorCacheBuster || '';
        const hasCacheBusterInParams = typeof personalizedParams === 'string' && personalizedParams.includes('_t=');
        const cacheSuffix = (hasCacheBusterInParams || !cacheBuster) ? '' : `&_t=${cacheBuster}`;

        // 🔥 Measure overlay 모드 판별 후 적절한 URL 사용
        let thumbnailUrl;
        const v = this.viewer;
        // 🔥 다중 Measure 모드: _gridMeasureMap에서 인덱스별 measure item 참조
        const measureItem = v?._gridMeasureMap ? v._gridMeasureMap[index] : null;
        if (measureItem && v._buildMeasureThumbUrl) {
            thumbnailUrl = v._buildMeasureThumbUrl(imagePath, measureItem, cacheSuffix);
            // Navigator용 size=256으로 변경
            thumbnailUrl = thumbnailUrl.replace('size=512', 'size=256');
        } else if (v?._measureCheckedItems?.some((item) => item.type === 'systematic') && v._buildMeasureThumbUrl) {
            const systematic = v._measureCheckedItems.find((item) => item.type === 'systematic');
            thumbnailUrl = v._buildMeasureThumbUrl(imagePath, systematic, cacheSuffix)
                .replace('size=512', 'size=256');
        } else if (v && (v.isMeasureGradientMode()) && v._ratioActiveItemKey) {
            const loginId = v.getCurrentLoginId();
            const gf = v.selectedGradientRanges?.size > 0
                ? Array.from(v.selectedGradientRanges).sort((a,b)=>a-b).join(',') : '';
            thumbnailUrl = `/api/measure-thumb?path=${encodeURIComponent(imagePath)}&field=${v.overlayMode}&key=${encodeURIComponent(v._ratioActiveItemKey)}&size=256&scheme=${encodeURIComponent(loginId)}${gf ? '&gradient_filter=' + gf : ''}${cacheSuffix}`;
        } else if (v && v.overlayMode === 'bin') {
            thumbnailUrl = `/api/thumbnail?path=${encodeURIComponent(imagePath)}${personalizedParams}&bin_overlay=1${cacheSuffix}`;
        } else {
            thumbnailUrl = `/api/thumbnail?path=${encodeURIComponent(imagePath)}${personalizedParams}${cacheSuffix}`;
        }

        img.alt = imagePath.split('/').pop();

        // 🔥 이미지 로드 완료 시에만 표시 (로딩 중 표시 제거)
        img.style.display = 'none'; // 기본적으로 숨김

        img.onload = () => {
            // 🔥 이미지 로드 완료 시에만 표시
            img.style.display = 'block';
        };

        img.onerror = () => {
            // 🔥 로드 실패 시에도 숨김 유지 (검은 화면)
            img.style.display = 'none';
        };

        // 🔥 현재 인덱스 주변(±30개)만 즉시 로드, 나머지는 data-src에만 저장

        // 빠른 next/prev 반응을 위해 범위를 넓게 설정

        const distance = Math.abs(index - this.currentImageIndex);

        const priorityRange = 5; // 🔥 현재 이미지 기준 ±5만 즉시 (메인 이미지 블로킹 방지)



        if (distance <= priorityRange) {

            // 우선 로드: 즉시 src 할당

            img.src = thumbnailUrl;

        } else {

            // 지연 로드: data-src에만 저장 (스크롤 멈춘 후 로드)

            img.dataset.src = thumbnailUrl;

        }



        imageContainer.appendChild(img);



        // 파일명 표시

        const fileName = document.createElement('div');

        fileName.className = 'thumbnail-nav-item-filename';

        let displayName = imagePath.split('/').pop();
        const lowerName = (displayName || '').toLowerCase();
        const nameWithoutExt = (displayName || '').replace(/\.(png|jpg|jpeg|gif|webp)$/i, '');

        if (nameWithoutExt.toLowerCase() === 'square_average' || displayName === 'sum_map.png') {
            displayName = 'composite(square-avg)';
        } else if (nameWithoutExt.toLowerCase() === 'square_weighted_average' || lowerName.startsWith('sum_map_weighted')) {
            displayName = 'composite(weighted)';
        } else {
            let processedName = nameWithoutExt;

            if (/^index_/i.test(nameWithoutExt)) {
                processedName = nameWithoutExt.replace(/^index_/i, 'Grade_');
            } else if (/^grade_/i.test(nameWithoutExt)) {
                processedName = nameWithoutExt.replace(/^grade_/i, 'Grade_');
            }

            const parts = processedName.split('_');

            if (parts.length >= 3) {
                displayName = `${parts[0]}-${parts[2]}`;
            } else if (parts.length >= 1) {
                displayName = parts[0];
            } else {
                displayName = processedName;
            }
        }

        // 🔥 다중 Measure 모드: measure type 라벨 접두사 추가
        if (measureItem) {
            const prefix = measureItem.type === 'failbit' ? '' :
                           measureItem.type === 'bin' ? 'BIN ' :
                           measureItem.type === 'f' ? `F${measureItem.key || ''} ` :
                           measureItem.type === 'q' ? `Q${measureItem.key || ''} ` : '';
            if (prefix) displayName = prefix + displayName;
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

        if (!this.viewer) return;



        // 하이라이트 즉시 업데이트 (반응속도 개선)

        this.updateHighlight(index);



        // viewMode에 따라 적절한 인덱스 업데이트

        if (this.viewer.viewMode === 'gridImage') {

            // 그리드 이미지 모드: gridViewImageIndex 업데이트

            this.viewer.gridViewImageIndex = index;

        } else if (this.viewer.viewMode === 'single') {

            // 파일 탐색기 모드: singleViewImageIndex 업데이트

            this.viewer.singleViewImageIndex = index;

        }



        // 이미지 로드

        if (typeof this.viewer.loadImage === 'function') {

            this.viewer.loadImage(imagePath, false);

            // ✅ Label Explorer 하이라이트 동기화
            if (typeof this.viewer.syncLabelExplorerHighlight === 'function') {
                this.viewer.syncLabelExplorerHighlight(imagePath);
            }
        }

    }



    updateHighlight(index) {

        if (!this.list) return;

        this.currentImageIndex = index;

        // 🔥 Virtual Scroll 모드
        if (this._vsEnabled) {
            // 기존 active 제거
            for (const [, item] of this._vsItemMap) {
                item.classList.remove('active');
            }
            // 스크롤 → 렌더 → 하이라이트
            this._vsScrollToIndex(index);
            this._vsRenderVisible();
            const activeItem = this._vsItemMap.get(index);
            if (activeItem) {
                activeItem.classList.add('active');
            }
            // 주변 썸네일 로드
            this._vsLoadNearbyImages(index, 30);
            return;
        }

        const items = this.list.querySelectorAll('.thumbnail-nav-item');

        const priorityRange = 30;

        items.forEach((item, i) => {

            if (i === index) {

                item.classList.add('active');

            } else {

                item.classList.remove('active');

            }

            const img = item.querySelector('img');

            if (img) {

                const distance = Math.abs(i - index);

                if (distance <= priorityRange) {

                    if (img.dataset.src) {

                        img.style.display = 'none';
                        img.src = img.dataset.src;

                        delete img.dataset.src;

                    }

                }

            }

        });

        this.scrollToIndex(index);

    }



    scrollToCurrentImage() {

        if (this.currentImageIndex >= 0) {

            this.scrollToIndex(this.currentImageIndex);

        }

    }



    scrollToIndex(index) {

        if (!this.list) return;

        // 🔥 Virtual Scroll 모드
        if (this._vsEnabled) {
            this._vsScrollToIndex(index);
            this._vsRenderVisible();
            return;
        }

        const items = this.list.querySelectorAll('.thumbnail-nav-item');

        if (index < 0 || index >= items.length) return;

        const targetItem = items[index];

        // 🔥 즉시 스크롤 (애니메이션 제거로 반응 속도 개선)

        const container = this.list;

        const containerRect = container.getBoundingClientRect();

        const itemRect = targetItem.getBoundingClientRect();

        // 세로 레이아웃인 경우

        if (this.layout === 'vertical') {

            const scrollOffset = (itemRect.top - containerRect.top) - (containerRect.height / 2) + (itemRect.height / 2);

            container.scrollBy({

                top: scrollOffset,

                behavior: 'instant' // 🔥 즉시 스크롤 (smooth → instant)

            });

        } else {

            // 가로 레이아웃인 경우

            const scrollOffset = (itemRect.left - containerRect.left) - (containerRect.width / 2) + (itemRect.width / 2);

            container.scrollBy({

                left: scrollOffset,

                behavior: 'instant' // 🔥 즉시 스크롤 (smooth → instant)

            });

        }

    }



    clearThumbnails() {

        if (this.list) {

            this.list.innerHTML = '';
            // 🔥 VS 모드에서 설정한 인라인 스타일 초기화 (CSS flex 복원)
            this.list.style.display = '';
            this.list.style.position = '';

        }

        // 🔥 Virtual Scroll 상태 초기화
        this._vsEnabled = false;
        this._vsItemMap = new Map();
        this._vsRenderedRange = { start: -1, end: -1 };
        this._vsSpacer = null;
        this._vsContentWidth = 0;
        if (this._vsScrollRAF) {
            cancelAnimationFrame(this._vsScrollRAF);
            this._vsScrollRAF = null;
        }

    }



    /**

     * sessionStorage에 저장

     */

    saveToSession() {
        try {
            const state = {

                position: this.position,

                // size는 저장하지 않음 - 항상 기본값(30%) 사용

                layout: this.layout

            };

            sessionStorage.setItem('thumbnailNavigator', JSON.stringify(state));
        } catch (error) {
            // localStorage/sessionStorage 접근 불가 시 무시 (프라이버시 모드 등)
            console.warn('[ThumbnailNavigator] sessionStorage 접근 실패:', error);
        }

    }



    /**

     * sessionStorage에서 복원

     */

    restoreFromSession() {

        try {

            const saved = sessionStorage.getItem('thumbnailNavigator');

            if (saved) {

                const state = JSON.parse(saved);

                // position은 복원하지 않음 - 항상 CSS 고정 위치 사용

                // size는 복원하지 않음 - 항상 기본값 사용

                this.layout = state.layout || this.layout;



                // 레이아웃 클래스 적용

                this.container.classList.remove('vertical', 'horizontal');

                this.container.classList.add(this.layout);



                // updatePosition 호출 안 함 (CSS 고정 위치 유지)

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

        const normalizedTarget = String(imagePath || '').replace(/\\/g, '/').toLowerCase();
        const index = this.imageList.findIndex(path => {
            const normalized = String(path || '').replace(/\\/g, '/').toLowerCase();
            return normalized === normalizedTarget ||
                normalized.endsWith(`/${normalizedTarget}`) ||
                normalizedTarget.endsWith(`/${normalized}`);
        });

        if (index >= 0) {

            this.currentImageIndex = index;

            this.updateHighlight(index);

        }

    }



    prepareFloatingPosition() {

        if (!this.container || this.isFloating) return;

        const rect = this.container.getBoundingClientRect();

        this.position = { x: rect.left, y: rect.top };

        this.updatePosition();

    }



    keepWithinViewport() {

        if (!this.isFloating || !this.container) return;

        const width = this.container.offsetWidth || this.size.width;

        const height = this.container.offsetHeight || this.size.height;

        const maxX = Math.max(0, window.innerWidth - width);

        const maxY = Math.max(0, window.innerHeight - height);

        const nextX = Math.min(Math.max(0, this.position.x), maxX);

        const nextY = Math.min(Math.max(0, this.position.y), maxY);



        if (nextX !== this.position.x || nextY !== this.position.y) {

            this.position = { x: nextX, y: nextY };

            this.updatePosition();

        }

    }

    /**

     * 🔥 스크롤 핸들러 (디바운스: 0.1초 후 실행)

     */

    handleScroll() {

        // 🔥 Virtual Scroll: rAF로 DOM 즉시 업데이트
        if (this._vsEnabled && !this._vsScrollRAF) {
            this._vsScrollRAF = requestAnimationFrame(() => {
                this._vsScrollRAF = null;
                this._vsRenderVisible();
            });
        }

        this.isScrolling = true;

        if (this.scrollDebounceTimer) {

            clearTimeout(this.scrollDebounceTimer);

        }

        this.scrollDebounceTimer = setTimeout(() => {

            this.isScrolling = false;

            if (this._vsEnabled) {
                this._vsLoadVisibleImages();
            } else {
                this.loadVisibleImages();
            }

        }, 100);

    }

    /**

     * 🔥 현재 뷰포트에 보이는 이미지만 즉시 로드

     */

    loadVisibleImages() {

        if (!this.list) return;

        // 🔥 Virtual Scroll 모드
        if (this._vsEnabled) {
            this._vsLoadVisibleImages();
            return;
        }

        const items = this.list.querySelectorAll('.thumbnail-nav-item');

        const containerRect = this.list.getBoundingClientRect();



        // 🔥 뷰포트 높이 계산 (위아래로 2배 확장)

        const viewportHeight = containerRect.height;

        const expandedTop = containerRect.top - (viewportHeight * 2);

        const expandedBottom = containerRect.bottom + (viewportHeight * 2);



        items.forEach((item) => {

            const img = item.querySelector('img');

            if (!img) return;



            const itemRect = item.getBoundingClientRect();



            // 🔥 뷰포트 위아래로 2배 범위 확인

            const isInExpandedRange = (

                itemRect.top < expandedBottom &&

                itemRect.bottom > expandedTop &&

                itemRect.left < containerRect.right &&

                itemRect.right > containerRect.left

            );



            if (isInExpandedRange && img.dataset.src) {

                // data-src에서 src로 로드 (아직 로드되지 않은 경우만)

                // 🔥 지연 로드: data-src에서 src로 전환
                img.style.display = 'none'; // 로드 전에는 숨김
                img.src = img.dataset.src;

                delete img.dataset.src; // 중복 로드 방지

            }

        });

    }

}
