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

    setImages(images, currentImagePath) {

        this.imageList = images || [];



        // ✅ 정규화된 경로로 비교 (백슬래시, 대소문자 등 처리)

        const normalizedCurrent = currentImagePath.replace(/\\/g, '/');

        this.currentImageIndex = this.imageList.findIndex(path => {

            const normalized = path.replace(/\\/g, '/');

            return normalized === normalizedCurrent ||

                   normalized.endsWith(normalizedCurrent) ||

                   normalizedCurrent.endsWith(normalized);

        });



        if (this.currentImageIndex === -1) {

            console.warn('[WAFER_NAV] Current image not found in list:', currentImagePath);

            console.warn('[WAFER_NAV] First 5 items in list:', this.imageList.slice(0, 5));

        }



        console.log(`[WAFER_NAV] setImages called - imageList length: ${this.imageList.length}, currentIndex: ${this.currentImageIndex}`);



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



        // ✅ DOM 렌더링 완료 후 스크롤 (레이아웃 계산 보장)

        requestAnimationFrame(() => {

            // 레이아웃 강제 계산 (reflow)

            this.list.offsetHeight;



            // 현재 이미지로 스크롤

            this.scrollToCurrentImage();

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

        const cacheBuster = this.viewer?._personalizedColorCacheBuster || Date.now();

        const thumbnailUrl = `/api/thumbnail?path=${encodeURIComponent(imagePath)}${personalizedParams}&_t=${cacheBuster}`;

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

        const priorityRange = 30; // 현재 이미지 기준 앞뒤 30개 (next/prev 반응 속도 개선)



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



        // sum_map.png를 composite(median)으로 표시

        if (displayName === 'sum_map.png' || displayName === 'sum_map') {

            displayName = 'composite(median)';

        } else {

            // 확장자 제거

            const nameWithoutExt = displayName.replace(/\.(png|jpg|jpeg|gif|webp)$/i, '');



            // index_로 시작하는 파일명을 grade_로 변경

            let processedName = nameWithoutExt;

            if (nameWithoutExt.startsWith('index_')) {

                processedName = nameWithoutExt.replace(/^index_/, 'grade_');

            }



            // 🔥 _로 split해서 0번째와 2번째 인덱스만 표시 (YMS 방식)
            // 구분자: `-` 사용 (하이픈, 깔끔하고 구분이 명확함)

            const parts = processedName.split('_');

            if (parts.length >= 3) {

                displayName = `${parts[0]}-${parts[2]}`;

            } else if (parts.length >= 1) {

                displayName = parts[0];

            } else {

                displayName = processedName;

            }

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

        }

    }



    updateHighlight(index) {

        if (!this.list) return;



        this.currentImageIndex = index;



        const items = this.list.querySelectorAll('.thumbnail-nav-item');

        const priorityRange = 30; // 현재 이미지 기준 앞뒤 30개 (next/prev 반응 속도 개선)



        items.forEach((item, i) => {

            // 활성화 상태 업데이트

            if (i === index) {

                item.classList.add('active');

            } else {

                item.classList.remove('active');

            }



            // 🔥 현재 위치가 변경되면 주변 썸네일을 즉시 로드

            // 새로운 위치 주변의 썸네일이 즉시 로드되도록 함

            const img = item.querySelector('img');

            if (img) {

                const distance = Math.abs(i - index);

                if (distance <= priorityRange) {

                    // 우선 로드 영역: data-src에서 src로 즉시 로드

                    if (img.dataset.src) {

                        // 🔥 지연 로드: data-src에서 src로 전환
                        img.style.display = 'none'; // 로드 전에는 숨김
                        img.src = img.dataset.src;

                        delete img.dataset.src;

                    }

                }

                // 멀리 있는 영역은 그대로 유지 (data-src 상태로 남겨둠)

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

        }

    }



    /**

     * sessionStorage에 저장

     */

    saveToSession() {

        const state = {

            position: this.position,

            // size는 저장하지 않음 - 항상 기본값(30%) 사용

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

        const index = this.imageList.indexOf(imagePath);

        if (index >= 0) {

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

        // 스크롤 중임을 표시

        this.isScrolling = true;



        // 기존 타이머 클리어

        if (this.scrollDebounceTimer) {

            clearTimeout(this.scrollDebounceTimer);

        }



        // 0.1초 (100ms) 후 실행

        this.scrollDebounceTimer = setTimeout(() => {

            this.isScrolling = false;

            // 🔥 스크롤이 멈춘 후 현재 뷰포트의 이미지만 로드

            this.loadVisibleImages();

        }, 100);

    }

    /**

     * 🔥 현재 뷰포트에 보이는 이미지만 즉시 로드

     */

    loadVisibleImages() {

        if (!this.list) return;



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