/**
 * ChipAnnotator - Chip-level annotation for wafer maps
 *
 * 핵심 기능:
 * - 항상 활성화 (모드 개념 없음)
 * - 마우스 오버 시 chip 좌표 표시
 * - Ctrl/Shift + 클릭으로 chip 선택
 * - Grid overlay
 * - Chip에 class/label 할당
 */

export class ChipAnnotator {
    constructor(canvas, viewer) {
        this.canvas = canvas;
        this.viewer = viewer;
        this.ctx = canvas.getContext('2d');

        // 🔥 Chip overlay Y 방향 보정 값 (px)
        //    - 이미지 기준으로 chip rect가 전체적으로 얼마나 올라가 있는지 나타내는 상수
        //    - UI 렌더링/선택 로직에서는 이 값을 "위로" 적용하고,
        //      컨텍스트 메뉴 이미지 복사 시에는 같은 값을 "아래로" 적용해서
        //      실제 이미지와 chip overlay가 정확히 겹치도록 사용한다.
        this.Y_OFFSET = -55;

        // Chip position data
        this.positionsData = null;
        this.chips = [];
        this.partId = null;
        this.device = null;
        this.pgm = null;

        // Annotation data
        this.markedChips = []; // {x_abs, y_abs, class, label, ...}
        this.chipIndexMap = new Map(); // (x_abs,y_abs) -> chip index
        this.selectedChips = new Set(); // Set of chip indices
        this.selectedChipsOrder = []; // 🔥 선택 순서 추적 (항상 맨 밑에 추가)
        this.legendFilterClasses = null;
        this.bottomFilterSet = new Set(); // 🔥 Bottom Filter (Chip b-value based mask)
        this.classColors = new Map();
        this.classColorPalette = [
            [239, 83, 80],
            [255, 160, 67],
            [255, 214, 102],
            [102, 187, 106],
            [38, 166, 154],
            [41, 182, 246],
            [126, 87, 194],
            [171, 71, 188],
            [255, 112, 67],
            [158, 158, 158]
        ];
        this.classColorIndex = 0;

        // UI state
        this.showGrid = false;
        this.hoveredChip = null;

        // Selection state
        this.isDragging = false;
        this.dragStartChip = null;
        this.isMultiSelect = false;
        this.isAltDrag = false;
        this.polygonPath = []; // For Alt+Drag free-form selection
        this.shiftClickPos = null; // For Shift+2-click rectangle selection
        this.altDragStartSelection = null; // Store selection state when Alt+Drag starts
        this._tempDragSelection = null; // Temporary selection during drag (preview only)
        this.clickStartPos = null; // 🔥 일반 클릭 시작 위치 (드래그 감지용)
        this.hasDragged = false; // 🔥 드래그 발생 여부
        this.ctrlClickStartPos = null; // Store mouse position for Ctrl+click (to detect drag)
        this.ctrlClickStartTime = null; // Store time for Ctrl+click (to detect drag)
        this.lastChipListClickIndex = null; // 🔥 Chip Selection 패널에서 Shift 클릭 범위 선택을 위한 마지막 클릭 인덱스

        // Colors
        this.gridColor = 'rgba(0, 255, 255, 0.3)';
        this.hoverColor = 'rgba(255, 255, 255, 0.3)';
        this.selectedColor = 'rgba(255, 255, 0, 0.25)'; // 🔥 더 투명하게 (0.5 -> 0.25)
        this.markedColor = 'rgba(255, 0, 0, 0.4)';

        // Coordinate display elements
        this.coordBox = document.getElementById('chip-coordinate-box');
        this.coordChipAbs = document.getElementById('coord-chip-abs');
        this.coordChipRel = document.getElementById('coord-chip-rel');
        this.coordPartId = document.getElementById('coord-partid');
        this.coordDevice = document.getElementById('coord-device');
        this.coordPgm = document.getElementById('coord-pgm');
        this.coordBin = document.getElementById('coord-bin');

        // Current image path
        this.currentImagePath = null;

        // Event handlers (bind once)
        this._onMouseMove = this._handleMouseMove.bind(this);
        this._onMouseDown = this._handleMouseDown.bind(this);
        this._onMouseUp = this._handleMouseUp.bind(this);
        this._onMouseLeave = this._handleMouseLeave.bind(this);
        this._onKeyDown = this._handleKeyDown.bind(this);
        this._onKeyUp = this._handleKeyUp.bind(this);
        this._onDocumentMouseUp = this._handleDocumentMouseUp.bind(this);

        this._setupEventListeners();
    }

    /**
     * Setup event listeners
     */
    _setupEventListeners() {
        this.canvas.addEventListener('mousemove', this._onMouseMove);
        this.canvas.addEventListener('mousedown', this._onMouseDown);
        this.canvas.addEventListener('mouseup', this._onMouseUp);
        this.canvas.addEventListener('mouseleave', this._onMouseLeave);
        document.addEventListener('keydown', this._onKeyDown);
        document.addEventListener('keyup', this._onKeyUp);
        document.addEventListener('mouseup', this._onDocumentMouseUp);
    }

    /** 
     * Load chip positions from backend
     */
    async loadPositions(imagePath) {
        try {
            this.currentImagePath = imagePath;
            this.partId = null;
            this.device = null;
            this.pgm = null;
            const response = await fetch(`/api/chip-positions?path=${encodeURIComponent(imagePath)}`);

            if (!response.ok) {
                console.log('No positions found for:', imagePath);
                this.positionsData = null;
                this.chips = [];
                this.chipIndexMap.clear();
                this._notifyLegendUpdate([]);
                return false;
            }

            this.positionsData = await response.json();
            this.chips = this.positionsData.chips || [];
            this._buildChipIndexMap();

            this.partId = this._extractMetadataValue(['partid', 'part_id', 'partId', 'PartID']);
            this.device = this._extractMetadataValue(['device', 'devcie', 'Device']);
            this.pgm = this._extractMetadataValue(['pgm', 'PGM', 'pgm_name']);

            console.log(`✅ Loaded ${this.chips.length} chip positions`, {
                partId: this.partId,
                device: this.device,
                pgm: this.pgm
            });

            this._updateMetadataDisplay();

            // Load existing annotations
            await this.loadAnnotations(imagePath);

            // 🎨 positions 로드 후 즉시 렌더링 (hover, grid 등 표시)
            this.render();

            return true;
        } catch (error) {
            console.error('Error loading chip positions:', error);
            this.positionsData = null;
            this.chips = [];
            this.chipIndexMap.clear();
            this._notifyLegendUpdate([]);
            this.partId = null;
            this.device = null;
            this.pgm = null;
            this._updateMetadataDisplay();
            return false;
        }
    }

    /**
     * Load existing chip annotations from backend
     */
    async loadAnnotations(imagePath = null) {
        const targetPath = imagePath || this.currentImagePath;
        if (!targetPath) {
            this.markedChips = [];
            this._refreshClassColors();
            this._notifyLegendUpdate([]);
            return;
        }

        try {
            const params = new URLSearchParams();
            params.set('path', targetPath);
            const folderPrefix = this.viewer?.currentFolderPrefix ?? '';
            params.set('folder', folderPrefix);
            const response = await fetch(`/api/chip-annotations?${params.toString()}`);

            if (response.ok) {
                const data = await response.json();
                this.markedChips = Array.isArray(data.marked_chips) ? data.marked_chips : [];
            } else if (response.status === 404) {
                this.markedChips = [];
            } else {
                const errorText = await response.text().catch(() => response.statusText);
                throw new Error(`Failed to load chip annotations: ${response.status} ${errorText}`);
            }

            this._refreshClassColors();
            this._notifyLegendUpdate();
            this.render();
        } catch (error) {
            console.error('Error loading chip labels:', error);
            this.markedChips = [];
            this._refreshClassColors();
            this._notifyLegendUpdate([]);
        }
    }

    setLegendFilterClass(className) {
        if (!className) {
            this.legendFilterClasses = null;
        } else {
            this.legendFilterClasses = new Set([className]);
        }
        this.render();
        this.updateSelectedChipsList();
    }

    setLegendFilterClasses(classSet) {
        if (classSet === null || classSet === undefined) {
            this.legendFilterClasses = null;
        } else if (classSet instanceof Set) {
            this.legendFilterClasses = new Set(classSet);
        } else if (Array.isArray(classSet)) {
            this.legendFilterClasses = new Set(classSet);
        } else {
            this.legendFilterClasses = null;
        }
        this.render();
        this.updateSelectedChipsList();
    }

    /**
     * Set Bottom Filter (Chip b-value based mask)
     * @param {Set|Array} filterSet - Set of b-values to keep visible (others masked white)
     */
    setBottomFilter(filterSet) {
        if (filterSet instanceof Set) {
            // 🔥 Convert to strings for consistent comparison
            this.bottomFilterSet = new Set(Array.from(filterSet).map(v => String(v)));
        } else if (Array.isArray(filterSet)) {
            // 🔥 Convert to strings for consistent comparison
            this.bottomFilterSet = new Set(filterSet.map(v => String(v)));
        } else {
            this.bottomFilterSet.clear();
        }
        this.render();
    }

    _refreshClassColors() {
        this.classColors.clear();
        this.classColorIndex = 0;
        const uniqueClasses = Array.from(new Set(this.markedChips
            .map(chip => chip.class || chip.label)
            .filter(Boolean)))
            .sort((a, b) => a.localeCompare(b));
        uniqueClasses.forEach(cls => this._getOrAssignClassColor(cls));
    }

    _getOrAssignClassColor(className) {
        if (!className) {
            return [255, 77, 77];
        }
        if (!this.classColors.has(className)) {
            const paletteColor = this.classColorPalette[this.classColorIndex % this.classColorPalette.length];
            this.classColors.set(className, paletteColor);
            this.classColorIndex += 1;
        }
        return this.classColors.get(className);
    }

    getClassColor(className, alpha = 0.35) {
        const [r, g, b] = this._getOrAssignClassColor(className);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }

    getClassColorHex(className) {
        const [r, g, b] = this._getOrAssignClassColor(className);
        return `rgb(${r}, ${g}, ${b})`;
    }

    _buildChipIndexMap() {
        this.chipIndexMap.clear();
        if (!Array.isArray(this.chips)) {
            return;
        }
        this.chips.forEach((chip, index) => {
            const key = this._chipKey(chip?.x_abs, chip?.y_abs);
            if (key) {
                this.chipIndexMap.set(key, index);
            }
        });
    }

    _chipKey(x, y) {
        if (typeof x !== 'number' || typeof y !== 'number') {
            return null;
        }
        return `${x},${y}`;
    }

    _getChipIndexFromCoords(x, y) {
        const key = this._chipKey(x, y);
        if (!key) return -1;
        const idx = this.chipIndexMap.get(key);
        return typeof idx === 'number' ? idx : -1;
    }

    _notifyLegendUpdate(chips = null) {
        if (this.viewer && typeof this.viewer.updateChipLabelLegend === 'function') {
            this.viewer.updateChipLabelLegend(Array.isArray(chips) ? chips : this.markedChips || []);
        }
    }

    /**
     * Save chip annotations to backend
     */
    async saveAnnotations() {
        if (!this.currentImagePath) {
            console.warn('No image path set');
            return false;
        }

        try {
            const folderPrefix = this.viewer?.currentFolderPrefix ?? '';
            const response = await fetch('/api/chip-annotations', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image_path: this.currentImagePath,
                    marked_chips: this.markedChips,
                    folder_prefix: folderPrefix
                })
            });

            if (!response.ok) {
                throw new Error(`Failed to save annotations: ${response.statusText}`);
            }

            console.log('✅ Annotations saved successfully');
            return true;
        } catch (error) {
            console.error('Error saving annotations:', error);
            return false;
        }
    }

    /**
     * Toggle die grid overlay
     */
    toggleGrid() {
        this.showGrid = !this.showGrid;
        this.render();
        this.updateSelectedChipsList();
    }

    /**
     * Find chip at canvas pixel coordinates
     */
    findChipAtPixel(canvasX, canvasY) {
        if (!this.positionsData || !this.viewer.transform) return null;

        // 🔥 Y_OFFSET 적용: chip이 그려진 위치와 동일하게 계산
        const Y_OFFSET = -50; // _drawChipRect와 동일한 값
        const transform = this.viewer.transform;

        // Convert canvas coordinates to image coordinates
        // chip 위치: rect.y0 * scale + dy + Y_OFFSET
        // 역변환: imgY = (canvasY - dy - Y_OFFSET) / scale
        const imgX = (canvasX - transform.dx) / transform.scale;
        const imgY = (canvasY - transform.dy - Y_OFFSET) / transform.scale;

        // Find chip containing this point
        for (let i = 0; i < this.chips.length; i++) {
            const chip = this.chips[i];
            const rect = chip.rect;

            if (imgX >= rect.x0 && imgX <= rect.x1 &&
                imgY >= rect.y0 && imgY <= rect.y1) {
                // 🔥 Bottom Filter가 활성화된 경우, 가려진 칩은 선택 불가
                if (this.bottomFilterSet.size > 0 && !this.bottomFilterSet.has(String(chip.b))) {
                    return null;
                }
                return { ...chip, index: i };
            }
        }

        return null;
    }

    /**
     * Get chips in rectangle selection (for drag)
     */
    getChipsInRect(chip1, chip2) {
        const minX = Math.min(chip1.x_abs, chip2.x_abs);
        const maxX = Math.max(chip1.x_abs, chip2.x_abs);
        const minY = Math.min(chip1.y_abs, chip2.y_abs);
        const maxY = Math.max(chip1.y_abs, chip2.y_abs);

        const selected = [];

        for (let i = 0; i < this.chips.length; i++) {
            const chip = this.chips[i];
            if (chip.x_abs >= minX && chip.x_abs <= maxX &&
                chip.y_abs >= minY && chip.y_abs <= maxY) {
                // 🔥 Bottom Filter가 활성화된 경우, 가려진 칩은 선택 불가
                if (this.bottomFilterSet.size > 0 && !this.bottomFilterSet.has(String(chip.b))) {
                    continue;
                }
                selected.push(i);
            }
        }

        return selected;
    }

    /**
     * Get selected chip coordinates (for label assignment)
     */
    getSelectedChipCoords() {
        const coords = [];
        this.selectedChips.forEach(chipIdx => {
            const chip = this.chips[chipIdx];
            if (chip) {
                coords.push({ x_abs: chip.x_abs, y_abs: chip.y_abs });
            }
        });
        return coords;
    }

    /**
     * Get selected chip data (for context menu and modal)
     */
    getSelectedChipData() {
        const chips = [];
        this.selectedChips.forEach(chipIdx => {
            const chip = this.chips[chipIdx];
            if (chip) {
                chips.push({
                    index: chipIdx,
                    x_abs: chip.x_abs,
                    y_abs: chip.y_abs,
                    b: chip.b,  // b 값 추가
                    rect: chip.rect
                });
            }
        });
        return chips;
    }

    /**
     * Get chip image region (for modal display)
     */
    async getChipImageRegion(chipIndex, personalized = false, scheme = null) {
        if (!this.currentImagePath || chipIndex < 0 || chipIndex >= this.chips.length) {
            return null;
        }

        const chip = this.chips[chipIndex];
        if (!chip || !chip.rect) {
            return null;
        }

        const rect = chip.rect;
        const x = Math.floor(rect.x0);
        const y = Math.floor(rect.y0);
        const width = Math.ceil(rect.x1 - rect.x0);
        const height = Math.ceil(rect.y1 - rect.y0);

        // API에서 chip 영역 이미지 가져오기 (개인색 설정 지원)
        try {
            const params = new URLSearchParams();
            params.set('path', this.currentImagePath);
            params.set('x', x);
            params.set('y', y);
            params.set('width', width);
            params.set('height', height);

            // 🎨 개인색 설정 파라미터 추가
            if (personalized && scheme) {
                params.set('personalized', 'true');
                params.set('scheme', scheme);
            }

            const response = await fetch(`/api/image/crop?${params.toString()}`);
            if (!response.ok) {
                throw new Error(`Failed to get chip image: ${response.status}`);
            }

            const blob = await response.blob();
            return URL.createObjectURL(blob);
        } catch (error) {
            console.error('Error getting chip image region:', error);
            return null;
        }
    }

    /**
     * Select all chips that match the given class/label
     */
    selectChipsByClass(className) {
        if (!className) {
            this.clearSelection();
            return 0;
        }

        if (!Array.isArray(this.markedChips) || this.markedChips.length === 0) {
            this.clearSelection();
            return 0;
        }

        const nextSelection = [];
        this.markedChips.forEach(marked => {
            const chipClass = marked.class || marked.label;
            if (chipClass === className) {
                const idx = this._getChipIndexFromCoords(marked.x_abs, marked.y_abs);
                if (idx !== -1) {
                    nextSelection.push(idx);
                }
            }
        });

        this.selectedChips = new Set(nextSelection);
        // 🔥 선택 순서 배열 업데이트 (맨 밑에 추가된 순서)
        this.selectedChipsOrder = nextSelection.filter(idx => this.selectedChips.has(idx));
        this.render();
        this.updateSelectedChipsList();
        return nextSelection.length;
    }

    /**
     * Clear chip selection
     */
    clearSelection(notifyViewer = true) {
        this.selectedChips.clear();
        this.selectedChipsOrder = []; // 🔥 선택 순서도 초기화
        this.render();
        this.updateSelectedChipsList(); // 🔥 선택 칩 리스트 업데이트
        if (notifyViewer && this.viewer && typeof this.viewer.handleChipSelectionCleared === 'function') {
            this.viewer.handleChipSelectionCleared();
        }
    }

    /**
     * 선택된 칩 리스트 업데이트
     */
    updateSelectedChipsList() {
        if (!this.viewer || !this.viewer.dom) return;

        const viewer = this.viewer;

        // 1. gridMode이면 모든 칩 관련 UI 숨김
        if (viewer.gridMode) {
            const listContainer = document.getElementById('selected-chips-list');
            if (listContainer) {
                listContainer.style.display = 'none';
                listContainer.style.visibility = 'hidden';
                listContainer.style.pointerEvents = 'none';
            }
            return;
        }

        // 2. 현재 이미지가 없으면 숨김 (viewMode가 없더라도 currentImage를 우선 신뢰)
        if (!viewer.currentImage) {
            const listContainer = document.getElementById('selected-chips-list');
            if (listContainer) {
                listContainer.style.display = 'none';
            }
            return;
        }

        // 3. listContainer 찾거나 생성
        let listContainer = document.getElementById('selected-chips-list');
        
        if (!listContainer) {
            const viewerContainer = this.viewer.dom.viewerContainer;
            if (!viewerContainer) {
                console.warn('[updateSelectedChipsList] viewerContainer not found');
                return;
            }

            // listContainer 생성 - color-legend-bottom과 동일한 스타일
            listContainer = document.createElement('div');
            listContainer.id = 'selected-chips-list';
            
            // color-legend-bottom의 높이를 계산하여 그 위에 배치
            const colorLegendBottom = document.getElementById('color-legend-bottom');
            let bottomPosition = 10; // 기본값
            
            if (colorLegendBottom && colorLegendBottom.offsetHeight > 0) {
                // color-legend-bottom의 높이 + 간격(10px)
                bottomPosition = colorLegendBottom.offsetHeight + 10;
            } else {
                // color-legend-bottom이 아직 렌더링되지 않은 경우 예상 높이 사용
                bottomPosition = 180; // 대략적인 높이 + 간격
            }
            
            listContainer.style.cssText = `
                position: absolute;
                right: 10px;    /* color-legend-bottom과 동일 */
                width: 115px;   /* color-legend-bottom과 동일 */
                bottom: ${bottomPosition}px;  /* color-legend-bottom의 위 */
                
                background-color: rgba(37, 37, 38, 0.9);  /* color-legend와 동일 */
                border: 1px solid var(--border-color);  /* color-legend와 동일 */
                border-radius: 4px;  /* color-legend와 동일 */
                padding: 8px 10px;  /* color-legend와 동일 */
                z-index: 21;
                
                display: none;
                flex-direction: column;
                gap: 0;
                font-size: 11px;  /* color-legend와 유사 */
                color: #ccc;
            `;

            // Header 생성
            const header = document.createElement('div');
            header.style.cssText = `
                font-weight: bold;
                padding: 3px 0;
                border-bottom: 1px solid rgba(255, 255, 255, 0.2);
                margin-bottom: 3px;
                font-size: 11px;
                color: #fff;
                display: flex;
                justify-content: space-between;
                align-items: center;
                white-space: nowrap;
                line-height: 1.2;
            `;

            const titleSpan = document.createElement('span');
            titleSpan.textContent = 'Selection';
            header.appendChild(titleSpan);

            const closeBtn = document.createElement('span');
            closeBtn.textContent = '✕';
            closeBtn.style.cssText = `
                cursor: pointer;
                font-size: 14px;
                color: #999;
                padding: 0 2px;
                line-height: 1;
            `;
            closeBtn.onclick = () => {
                listContainer.style.display = 'none';
            };
            header.appendChild(closeBtn);
            
            listContainer.appendChild(header);

            // 칩 목록 컨테이너 생성 (스크롤 가능)
            const list = document.createElement('div');
            list.id = 'selected-chips-list-items';
            list.style.cssText = `
                display: flex;
                flex-direction: column;
                gap: 2px;
                overflow-y: auto;
                max-height: 200px;  /* 10개 row가 보이도록 조정 (헤더 높이 제외) */
                flex: 1;
                min-height: 0;  /* flex에서 스크롤 가능하도록 */
            `;
            
            // wheel 이벤트로 스크롤 가능하도록 (이미지 캔버스 스크롤과 분리)
            list.addEventListener('wheel', (e) => {
                // chip selection 위에서 wheel 이벤트 발생 시 이벤트 전파 차단
                // 스크롤은 기본 동작으로 허용
                e.stopPropagation();
            }, { passive: false });
            
            listContainer.appendChild(list);

            // DOM에 추가
            viewerContainer.appendChild(listContainer);
            
        } else {
            // 이미 생성된 경우에도 listItems에 wheel 이벤트가 없으면 추가
            const existingList = document.getElementById('selected-chips-list-items');
            if (existingList && !existingList.hasAttribute('data-wheel-attached')) {
                existingList.addEventListener('wheel', (e) => {
                    // chip selection 위에서 wheel 이벤트 발생 시 이벤트 전파 차단
                    // 스크롤은 기본 동작으로 허용
                    e.stopPropagation();
                }, { passive: false });
                existingList.setAttribute('data-wheel-attached', 'true');
            }
        }

        // 4. listItems 요소 찾기
        const listItems = document.getElementById('selected-chips-list-items');
        if (!listItems) {
            console.error('[updateSelectedChipsList] Could not find selected-chips-list-items');
            return;
        }
        
        // listItems에 스크롤 스타일 적용 (이미 생성된 경우에도)
        if (listItems) {
            listItems.style.display = 'flex';
            listItems.style.flexDirection = 'column';
            listItems.style.overflowY = 'auto';
            listItems.style.maxHeight = '200px';
            listItems.style.flex = '1';
            listItems.style.minHeight = '0';
            listItems.style.visibility = 'visible';
            listItems.style.pointerEvents = 'auto';
        }
        
        // 헤더가 항상 유지되도록 확인 (listItems만 초기화, 헤더는 유지)
        // 헤더는 listItems의 이전 형제 요소로 찾기
        let header = listItems.previousElementSibling;
        if (!header || !header.textContent || !header.textContent.includes('Selection')) {
            // 헤더가 없거나 잘못된 경우 다시 생성
            if (header && header.id !== 'selected-chips-list-items') {
                header.remove();
            }
            
            const newHeader = document.createElement('div');
            newHeader.style.cssText = `
                font-weight: bold;
                padding: 3px 0;
                border-bottom: 1px solid rgba(255, 255, 255, 0.2);
                margin-bottom: 3px;
                font-size: 11px;
                color: #fff;
                display: flex;
                justify-content: space-between;
                align-items: center;
                white-space: nowrap;
                line-height: 1.2;
            `;
            
            const titleSpan = document.createElement('span');
            titleSpan.textContent = 'Selection';
            newHeader.appendChild(titleSpan);
            
            const closeBtn = document.createElement('span');
            closeBtn.textContent = '✕';
            closeBtn.style.cssText = `
                cursor: pointer;
                font-size: 14px;
                color: #999;
                padding: 0 2px;
                line-height: 1;
            `;
            closeBtn.onclick = () => {
                listContainer.style.display = 'none';
            };
            newHeader.appendChild(closeBtn);
            
            listContainer.insertBefore(newHeader, listItems);
        }

        // 4-1. color-legend-bottom의 높이를 계산하여 위치 업데이트 (이미 생성된 경우에도)
        const colorLegendBottom = document.getElementById('color-legend-bottom');
        if (colorLegendBottom && listContainer) {
            let bottomPosition = 10; // 기본값
            
            if (colorLegendBottom.offsetHeight > 0) {
                // color-legend-bottom의 높이 + 간격(10px)
                bottomPosition = colorLegendBottom.offsetHeight + 10;
            } else {
                // color-legend-bottom이 아직 렌더링되지 않은 경우 예상 높이 사용
                bottomPosition = 180; // 대략적인 높이 + 간격
            }
            
            // 위치 업데이트
            listContainer.style.right = '10px';
            listContainer.style.width = '115px';
            listContainer.style.bottom = `${bottomPosition}px`;
        }

        // 5. 선택된 칩이 있으면 렌더링
        if (this.selectedChips.size > 0) {
            
            // 목록 초기화
            listItems.innerHTML = '';

            // 🔥 선택 순서대로 렌더링 (맨 밑에 추가된 순서)
            let sortedChips = this.selectedChipsOrder
                .filter(idx => this.selectedChips.has(idx))
                .map(idx => {
                    const chip = this.chips[idx];
                    return chip ? { idx, x: chip.x_abs, y: chip.y_abs } : null;
                })
                .filter(Boolean);

            // 순서 배열이 비어있거나 chips lookup 실패 시 Set 기반으로 백업
            if (sortedChips.length === 0 && this.selectedChips.size > 0) {
                sortedChips = Array.from(this.selectedChips)
                    .map(idx => {
                        const chip = this.chips[idx];
                        return chip ? { idx, x: chip.x_abs, y: chip.y_abs } : null;
                    })
                    .filter(Boolean);

                // 백업으로부터 순서 배열도 재구성
                this.selectedChipsOrder = sortedChips.map(c => c.idx);
            }

            sortedChips.forEach((chipData, listIndex) => {
                const { idx, x, y } = chipData;
                
                const item = document.createElement('div');
                item.style.cssText = `
                    padding: 2px 4px;
                    background: rgba(42, 42, 42, 0.8);
                    border: 1px solid rgba(68, 68, 68, 0.8);
                    border-radius: 3px;
                    cursor: pointer;
                    font-size: 11px;
                    color: #ccc;
                    transition: background 0.2s;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                    min-height: 18px;
                    line-height: 1.2;
                `;
                
                item.textContent = `(${x}, ${y})`;
                item.title = `X: ${x}, Y: ${y}`;

                item.onmouseenter = () => {
                    item.style.background = 'rgba(51, 51, 51, 0.9)';
                };
                item.onmouseleave = () => {
                    item.style.background = 'rgba(42, 42, 42, 0.8)';
                };

                item.onclick = (e) => {
                    e.stopPropagation();
                    
                    if (e.shiftKey && this.lastChipListClickIndex !== null) {
                        // Shift-click: 범위 선택/해제
                        const startIndex = Math.min(this.lastChipListClickIndex, listIndex);
                        const endIndex = Math.max(this.lastChipListClickIndex, listIndex);
                        
                        for (let i = startIndex; i <= endIndex; i++) {
                            const chipToRemove = sortedChips[i];
                            if (chipToRemove && this.selectedChips.has(chipToRemove.idx)) {
                                this.selectedChips.delete(chipToRemove.idx);
                                // 🔥 선택 순서 배열에서도 제거
                                const orderIndex = this.selectedChipsOrder.indexOf(chipToRemove.idx);
                                if (orderIndex !== -1) {
                                    this.selectedChipsOrder.splice(orderIndex, 1);
                                }
                            }
                        }
                        console.log('[Chip List] Shift-click deselect range');
                    } else {
                        // 일반 클릭: 단일 선택/해제
                        if (this.selectedChips.has(idx)) {
                            this.selectedChips.delete(idx);
                            // 🔥 선택 순서 배열에서도 제거
                            const orderIndex = this.selectedChipsOrder.indexOf(idx);
                            if (orderIndex !== -1) {
                                this.selectedChipsOrder.splice(orderIndex, 1);
                            }
                            console.log('[Chip List] Click deselect:', x, y);
                        } else {
                            this.selectedChips.add(idx);
                            // 🔥 선택 순서 배열에 추가 (맨 밑에 추가)
                            if (!this.selectedChipsOrder.includes(idx)) {
                                this.selectedChipsOrder.push(idx);
                            }
                            console.log('[Chip List] Click select:', x, y);
                        }
                    }
                    
                    this.lastChipListClickIndex = listIndex;
                    this.render();
                    this.updateSelectedChipsList();
                };

                listItems.appendChild(item);
            });

            // Container 표시
            listContainer.style.display = 'flex';
            listContainer.style.visibility = 'visible';
            listContainer.style.pointerEvents = 'auto';
            
            // 🔥 스크롤을 항상 맨 아래로 이동 (새로 추가된 칩이 보이도록)
            setTimeout(() => {
                if (listItems) {
                    listItems.scrollTop = listItems.scrollHeight;
                }
            }, 0);
            
        } else {
            // 선택된 칩이 없으면 숨김
            listContainer.style.display = 'none';
            listItems.innerHTML = '';
        }
    }
    
    /**
     * 좌표 문자열로 칩 선택 (검색 및 다중 입력 지원)
     */
    selectChipsByCoordinates(coordString) {
        if (!coordString || !coordString.trim()) return;
        
        // 🔥 space, tab, 세미콜론, 줄바꿈으로 구분하여 다중 입력 처리
        const coordPairs = coordString.split(/[\s\t;\n]+/).map(s => s.trim()).filter(Boolean);
        
        let selectedCount = 0;
        
        coordPairs.forEach(pair => {
            // 🔥 범위 표기법 확인 (콜론 포함)
            if (pair.includes(':')) {
                // 범위 표기법 처리
                const colonIdx = pair.indexOf(':');
                const beforeColon = pair.substring(0, colonIdx).trim();
                const afterColon = pair.substring(colonIdx + 1).trim();
                
                // 패턴 1: "x,y1:y2" (x는 고정, y 범위)
                const pattern1 = /^(-?\d+),(-?\d+):(-?\d+)$/;
                const match1 = pair.match(pattern1);
                if (match1) {
                    const x = parseInt(match1[1], 10);
                    const yStart = parseInt(match1[2], 10);
                    const yEnd = parseInt(match1[3], 10);
                    const yMin = Math.min(yStart, yEnd);
                    const yMax = Math.max(yStart, yEnd);
                    
                    for (let y = yMin; y <= yMax; y++) {
                        const chipIdx = this.chips.findIndex(c => c && c.x_abs === x && c.y_abs === y);
                        if (chipIdx >= 0 && !this.selectedChips.has(chipIdx)) {
                            this.selectedChips.add(chipIdx);
                            // 🔥 선택 순서 배열에 추가 (맨 밑에 추가)
                            if (!this.selectedChipsOrder.includes(chipIdx)) {
                                this.selectedChipsOrder.push(chipIdx);
                            }
                            selectedCount++;
                        }
                    }
                    return;
                }
                
                // 패턴 2: "x1:x2,y" (y는 고정, x 범위)
                const pattern2 = /^(-?\d+):(-?\d+),(-?\d+)$/;
                const match2 = pair.match(pattern2);
                if (match2) {
                    const xStart = parseInt(match2[1], 10);
                    const xEnd = parseInt(match2[2], 10);
                    const y = parseInt(match2[3], 10);
                    const xMin = Math.min(xStart, xEnd);
                    const xMax = Math.max(xStart, xEnd);
                    
                    for (let x = xMin; x <= xMax; x++) {
                        const chipIdx = this.chips.findIndex(c => c && c.x_abs === x && c.y_abs === y);
                        if (chipIdx >= 0 && !this.selectedChips.has(chipIdx)) {
                            this.selectedChips.add(chipIdx);
                            // 🔥 선택 순서 배열에 추가 (맨 밑에 추가)
                            if (!this.selectedChipsOrder.includes(chipIdx)) {
                                this.selectedChipsOrder.push(chipIdx);
                            }
                            selectedCount++;
                        }
                    }
                    return;
                }
                
                // 패턴 3: "x1,y1:x2,y2" (사각형 범위)
                const pattern3 = /^(-?\d+),(-?\d+):(-?\d+),(-?\d+)$/;
                const match3 = pair.match(pattern3);
                if (match3) {
                    const xStart = parseInt(match3[1], 10);
                    const yStart = parseInt(match3[2], 10);
                    const xEnd = parseInt(match3[3], 10);
                    const yEnd = parseInt(match3[4], 10);
                    const xMin = Math.min(xStart, xEnd);
                    const xMax = Math.max(xStart, xEnd);
                    const yMin = Math.min(yStart, yEnd);
                    const yMax = Math.max(yStart, yEnd);
                    
                    for (let x = xMin; x <= xMax; x++) {
                        for (let y = yMin; y <= yMax; y++) {
                            const chipIdx = this.chips.findIndex(c => c && c.x_abs === x && c.y_abs === y);
                            if (chipIdx >= 0 && !this.selectedChips.has(chipIdx)) {
                                this.selectedChips.add(chipIdx);
                                // 🔥 선택 순서 배열에 추가 (맨 밑에 추가)
                                if (!this.selectedChipsOrder.includes(chipIdx)) {
                                    this.selectedChipsOrder.push(chipIdx);
                                }
                                selectedCount++;
                            }
                        }
                    }
                    return;
                }
            } else {
                // 일반 좌표 쌍 처리
                const parts = pair.split(',').map(s => s.trim()).filter(Boolean);
                if (parts.length >= 2) {
                    const x = parseInt(parts[0], 10);
                    const y = parseInt(parts[1], 10);
                    
                    if (!isNaN(x) && !isNaN(y)) {
                        const chipIdx = this.chips.findIndex(c => c && c.x_abs === x && c.y_abs === y);
                        if (chipIdx >= 0 && !this.selectedChips.has(chipIdx)) {
                            this.selectedChips.add(chipIdx);
                            // 🔥 선택 순서 배열에 추가 (맨 밑에 추가)
                            if (!this.selectedChipsOrder.includes(chipIdx)) {
                                this.selectedChipsOrder.push(chipIdx);
                            }
                            selectedCount++;
                        }
                    }
                }
            }
        });
        
        this.render();
        this.updateSelectedChipsList();
        
        if (selectedCount > 0) {
            console.log(`✅ ${selectedCount}개 칩 선택됨`);
        } else {
            console.warn('⚠️ 선택된 칩이 없습니다. 좌표를 확인해주세요.');
        }
    }

    /**
     * Render chip annotations overlay
     */
    render() {
        if (!this.positionsData) {
            return;
        }

        if (!this.viewer.transform) {
            console.warn('⚠️ ChipAnnotator: viewer.transform is not available yet');
            return;
        }

        const ctx = this.ctx;
        
        // ✅ transform 초기화 (누적 방지)
        ctx.resetTransform();
        
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // 🔥 Bottom Filter Mask: 허용되지 않은 칩 영역만 흰색으로 덮기 (배경은 그대로 유지)
        if (this.bottomFilterSet.size > 0) {
            const transform = this.viewer.transform;
            const Y_OFFSET = -55; // _drawChipRect와 동일한 오프셋
            ctx.save();
            ctx.resetTransform();
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            this.chips.forEach(chip => {
                if (chip && !this.bottomFilterSet.has(String(chip.b))) {
                    const rect = chip.rect;
                    const x = rect.x0 * transform.scale + transform.dx;
                    const y = rect.y0 * transform.scale + transform.dy + Y_OFFSET;
                    const w = (rect.x1 - rect.x0) * transform.scale;
                    const h = (rect.y1 - rect.y0) * transform.scale;
                    ctx.rect(x, y, w, h);
                }
            });
            ctx.fill();
            ctx.restore();
        }

        // Draw grid if enabled
        if (this.showGrid) {
            this._renderGrid();
        }

        const activeSet = this.legendFilterClasses;
        this.markedChips.forEach(markedChip => {
            const chipClass = markedChip.class || markedChip.label;
            const chip = this.chips.find(
                c => c.x_abs === markedChip.x_abs && c.y_abs === markedChip.y_abs
            );
            if (!chip) return;
            // Bottom 필터 활성 시 허용된 b 값만 렌더링
            if (this.bottomFilterSet.size > 0 && !this.bottomFilterSet.has(String(chip.b))) {
                return;
            }
            const isVisible = !activeSet || activeSet.has(chipClass);
            const alpha = isVisible ? 0.45 : 0;
            if (alpha > 0) {
                const fillColor = this.getClassColor(chipClass, alpha);
                this._drawChipRect(chip, fillColor);
            }
        });

        // Draw selected chips (manual selections override filters)
        if (this.selectedChips.size > 0) {
            this.selectedChips.forEach(chipIdx => {
                const chip = this.chips[chipIdx];
                if (chip && (this.bottomFilterSet.size === 0 || this.bottomFilterSet.has(String(chip.b)))) {
                    this._drawChipRect(chip, this.selectedColor);
                }
            });
        }

        // 🔥 Draw temporary drag selection (preview during drag)
        if (this._tempDragSelection && this._tempDragSelection.length > 0) {
            this._tempDragSelection.forEach(chipIdx => {
                const chip = this.chips[chipIdx];
                if (
                    chip &&
                    !this.selectedChips.has(chipIdx) &&
                    (this.bottomFilterSet.size === 0 || this.bottomFilterSet.has(String(chip.b)))
                ) {
                    // 🔥 이미 선택된 chip은 제외 (중복 표시 방지)
                    this._drawChipRect(chip, 'rgba(255, 255, 0, 0.2)'); // 🔥 더 투명하게 미리보기 (0.3 -> 0.2)
                }
            });
        }

        // Draw hovered chip
        if (this.hoveredChip) {
            if (this.bottomFilterSet.size === 0 || this.bottomFilterSet.has(String(this.hoveredChip.b))) {
                this._drawChipRect(this.hoveredChip, this.hoverColor);
            }
        }

        // Draw Alt+Drag free-form selection polygon
        if (this.isAltDrag && this.polygonPath.length > 0) {
            ctx.save(); // ✅ transform 누적 방지
            ctx.resetTransform(); // ✅ 추가
            
            ctx.strokeStyle = 'rgba(0, 255, 0, 0.8)';
            ctx.fillStyle = 'rgba(0, 255, 0, 0.15)';
            ctx.lineWidth = 2;

            ctx.beginPath();
            ctx.moveTo(this.polygonPath[0].x, this.polygonPath[0].y);
            for (let i = 1; i < this.polygonPath.length; i++) {
                ctx.lineTo(this.polygonPath[i].x, this.polygonPath[i].y);
            }
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            
            ctx.restore(); // ✅ 추가
        }

        // Draw Shift+Click rectangle preview
        if (this.shiftClickPos) {
            ctx.save(); // ✅ transform 누적 방지
            ctx.resetTransform(); // ✅ 추가
            
            const mousePos = this.lastMousePos;
            if (mousePos) {
                const x1 = Math.min(this.shiftClickPos.x, mousePos.x);
                const y1 = Math.min(this.shiftClickPos.y, mousePos.y);
                const x2 = Math.max(this.shiftClickPos.x, mousePos.x);
                const y2 = Math.max(this.shiftClickPos.y, mousePos.y);

                ctx.strokeStyle = 'rgba(0, 153, 255, 0.8)';
                ctx.fillStyle = 'rgba(0, 153, 255, 0.15)';
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 5]);
                ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
                ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
                ctx.setLineDash([]);
            }
            
            ctx.restore(); // ✅ 추가
        }
    }

    /**
     * Render die grid
     */
    _renderGrid() {
        if (!this.positionsData || !this.viewer.transform) return;

        const ctx = this.ctx;
        
        // ✅ transform 초기화 (누적 방지)
        ctx.save();
        ctx.resetTransform();
        
        const transform = this.viewer.transform;
        const coord = this.positionsData.coord;

        if (!coord || !coord.grid_edges) {
            ctx.restore();
            return;
        }

        ctx.strokeStyle = this.gridColor;
        ctx.lineWidth = 1;

        // Helper to convert image coords to canvas coords
        // 🔥 이미지 렌더링 방식과 동일: translate(dx, dy) 후 scale(scale, scale)
        // 이미지 픽셀 (imgX, imgY)는 캔버스 좌표 (imgX * scale + dx, imgY * scale + dy)에 그려짐
        // Y 오프셋을 추가하여 그리드도 칩 선택과 동일한 위치에 그리기
        const Y_OFFSET = -55; // 칩 선택과 동일한 오프셋 (음수 = 위로)
        const toCanvas = (imgX, imgY) => ({
            x: imgX * transform.scale + transform.dx,
            y: imgY * transform.scale + transform.dy + Y_OFFSET
        });

        // Draw vertical lines
        coord.grid_edges.xs.forEach(x => {
            const start = toCanvas(x, 0);
            const end = toCanvas(x, coord.canvas.height);

            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            ctx.stroke();
        });

        // Draw horizontal lines
        coord.grid_edges.ys.forEach(y => {
            const start = toCanvas(0, y);
            const end = toCanvas(coord.canvas.width, y);

            ctx.beginPath();
            ctx.moveTo(start.x, start.y);
            ctx.lineTo(end.x, end.y);
            ctx.stroke();
        });
        
        // ✅ transform 복원
        ctx.restore();
    }

    /**
     * Draw chip rectangle
     * 🔥 이미지 렌더링 방식과 동일하게: translate(dx, dy) 후 scale(scale, scale)
     * 이미지의 (x, y) 픽셀은 캔버스의 (dx + x * scale, dy + y * scale)에 그려짐
     * Y 오프셋을 추가하여 칩 선택을 이미지와 정확히 맞춤
     */
    _drawChipRect(chip, color) {
        const transform = this.viewer.transform;
        const rect = chip.rect;

        // 🔥 Y 오프셋: 칩 선택을 이미지 위치에 맞추기 위해 위로 올림
        const Y_OFFSET = -55; // 픽셀 단위 오프셋 (음수 = 위로, 값이 클수록 더 위로)
        
        // ✅ save/restore로 transform 누적 방지
        this.ctx.save();
        this.ctx.resetTransform(); // ⭐ 추가 (누적 방지)
        
        // 🔥 이미지와 동일한 변환: translate 후 scale
        // 이미지: ctx.translate(dx, dy); ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
        // 따라서 이미지 픽셀 (x, y)는 캔버스 좌표 (dx + x * scale, dy + y * scale)에 그려짐
        const topLeftX = rect.x0 * transform.scale + transform.dx;
        const topLeftY = rect.y0 * transform.scale + transform.dy + Y_OFFSET;
        const bottomRightX = rect.x1 * transform.scale + transform.dx;
        const bottomRightY = rect.y1 * transform.scale + transform.dy + Y_OFFSET;

        this.ctx.fillStyle = color;
        this.ctx.fillRect(
            topLeftX,
            topLeftY,
            bottomRightX - topLeftX,
            bottomRightY - topLeftY
        );
        
        this.ctx.restore(); // ⭐ 추가
    }

    _extractMetadataValue(keys = []) {
        if (!this.positionsData) return null;

        const normalize = (key) => key.toLowerCase().replace(/[^a-z0-9]/g, '');
        const targetKeys = keys.map(normalize);

        const sources = [
            this.positionsData,
            this.positionsData.meta,
            this.positionsData.metadata,
            this.positionsData.header,
            this.positionsData.info
        ].filter(src => src && typeof src === 'object');

        for (const source of sources) {
            const value = this._findMetadataValue(source, targetKeys, normalize);
            if (value !== undefined && value !== null && `${value}`.trim() !== '') {
                return value;
            }
        }

        // 중첩된 위치를 대비해 얕은 탐색 수행
        const visited = new Set();
        const queue = [...sources];
        while (queue.length) {
            const obj = queue.shift();
            if (!obj || typeof obj !== 'object' || visited.has(obj)) continue;
            visited.add(obj);

            const value = this._findMetadataValue(obj, targetKeys, normalize);
            if (value !== undefined && value !== null && `${value}`.trim() !== '') {
                return value;
            }

            for (const val of Object.values(obj)) {
                if (val && typeof val === 'object') {
                    queue.push(val);
                }
            }
        }

        return null;
    }

    _findMetadataValue(source, targetKeys, normalize) {
        if (!source || typeof source !== 'object') return null;

        for (const [k, v] of Object.entries(source)) {
            const nk = normalize(k);
            if (targetKeys.includes(nk)) {
                return v;
            }
        }

        return null;
    }

    _updateMetadataDisplay() {
        if (this.coordPartId) {
            this.coordPartId.textContent = this.partId || '-';
        }
        if (this.coordDevice) {
            this.coordDevice.textContent = this.device || '-';
        }
        if (this.coordPgm) {
            this.coordPgm.textContent = this.pgm || '-';
        }
    }

    /**
     * Update chip coordinate box
     */
    _updateCoordinateBox(imgX, imgY, chip) {
        if (chip) {
            // 절대 좌표: JSON 파일의 x_abs, y_abs 값 사용 (cal 값 사용 안 함)
            if (this.coordChipAbs) {
                const x_abs = chip.x_abs;
                const y_abs = chip.y_abs;
                
                if (x_abs !== undefined && y_abs !== undefined && x_abs !== null && y_abs !== null) {
                    this.coordChipAbs.textContent = `(${x_abs}, ${y_abs})`;
                } else {
                    this.coordChipAbs.textContent = '-';
                }
            }

            // 상대 좌표: JSON 파일의 x_cal, y_cal 값 사용
            // 🔥 중심 기준 좌표: 오른쪽 +x, 위쪽 +y (짝수일 때 좌측 아래 기준)
            if (this.coordChipRel) {
                const x_cal = chip.x_cal;
                const y_cal = chip.y_cal;

                if (x_cal !== undefined && y_cal !== undefined && x_cal !== null && y_cal !== null) {
                    this.coordChipRel.textContent = `(${x_cal}, ${y_cal})`;
                } else {
                    this.coordChipRel.textContent = '-';
                }
            }
            if (this.coordBin) {
                const bval = chip.b != null ? String(chip.b) : '';
                this.coordBin.textContent = (bval && bval !== 'Normal' && bval !== 'Invalid') ? bval : '-';
            }
        } else {
            // Chip 위에 없으면 "-" 표시
            if (this.coordChipAbs) {
                this.coordChipAbs.textContent = '-';
            }
            if (this.coordChipRel) {
                this.coordChipRel.textContent = '-';
            }
            if (this.coordBin) {
                this.coordBin.textContent = '-';
            }
        }
        this._updateMetadataDisplay();
    }

    /**
     * Mouse move handler
     */
    _handleMouseMove(e) {
        const rect = this.canvas.getBoundingClientRect();
        // 🔥 CSS 스케일링 고려: 실제 캔버스 픽셀 좌표로 변환
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const canvasX = (e.clientX - rect.left) * scaleX;
        const canvasY = (e.clientY - rect.top) * scaleY;

        // Store last mouse position for previews
        this.lastMousePos = { x: canvasX, y: canvasY };

        // Convert to image coordinates
        const imgX = (canvasX - this.viewer.transform.dx) / this.viewer.transform.scale;
        const imgY = (canvasY - this.viewer.transform.dy) / this.viewer.transform.scale;

        // Find chip under cursor
        const chip = this.findChipAtPixel(canvasX, canvasY);

        // Update coordinate box
        this._updateCoordinateBox(imgX, imgY, chip);

        // Handle Alt+Drag free-form polygon selection
        // 🔥 Alt 키가 떼어져도 isAltDrag가 true이면 계속 polygon path 추가
        if (this.isAltDrag) {
            // Add points to polygon path as mouse moves
            const lastPoint = this.polygonPath[this.polygonPath.length - 1];
            if (!lastPoint ||
                Math.abs(canvasX - lastPoint.x) > 3 ||
                Math.abs(canvasY - lastPoint.y) > 3) {
                this.polygonPath.push({ x: canvasX, y: canvasY });
                // 🔥 Alt+Drag 중에는 즉시 렌더링 (안정성 향상)
                this.render();
            }
            return;
        }

        // Update hover highlight (Alt+Drag 중이 아닐 때만)
        if (chip !== this.hoveredChip) {
            this.hoveredChip = chip;
            this.render();
        }

        // Handle Shift+Drag rectangle preview
        if (this.shiftClickPos) {
            const dragDistance = Math.sqrt(
                Math.pow(canvasX - this.shiftClickPos.x, 2) +
                Math.pow(canvasY - this.shiftClickPos.y, 2)
            );
            // 드래그가 발생했으면 미리보기 표시
            if (dragDistance > 5) {
                const selected = this._getChipsInCanvasRect(
                    this.shiftClickPos.x,
                    this.shiftClickPos.y,
                    canvasX,
                    canvasY
                );
                this._tempDragSelection = selected;
                this.render();
                return;
            }
            // 드래그가 발생하지 않았으면 아무것도 하지 않음
            this.render();
            return;
        }

        // 🔥 Ctrl+드래그 미리보기
        if (this.ctrlClickStartPos && this.dragStartChip) {
            const dragDistance = Math.sqrt(
                Math.pow(canvasX - this.ctrlClickStartPos.x, 2) +
                Math.pow(canvasY - this.ctrlClickStartPos.y, 2)
            );
            // 🔥 드래그가 발생하면 범위 미리보기
            if (dragDistance > 5) {
                const chipAtPos = this.findChipAtPixel(canvasX, canvasY);
                if (chipAtPos && chipAtPos !== this.dragStartChip) {
                    const selected = this.getChipsInRect(this.dragStartChip, chipAtPos);
                    this._tempDragSelection = selected;
                    this.render();
                    return;
                }
            }
        }

        // 🔥 일반 드래그는 선택하지 않음 (Ctrl/Shift/Alt+드래그만 선택)
        // 일반 드래그 중에는 아무것도 하지 않음
        // 🔥 드래그 발생 여부 확인 (5px 이상 이동 시 드래그로 간주)
        if (this.clickStartPos && !e.ctrlKey && !e.shiftKey && !e.altKey) {
            const dx = canvasX - this.clickStartPos.x;
            const dy = canvasY - this.clickStartPos.y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance > 5) {
                this.hasDragged = true;
            }
        }
    }

    /**
     * Mouse down handler
     */
    _handleMouseDown(e) {
        if (e.button !== 0) return; // Left click only

        const rect = this.canvas.getBoundingClientRect();
        // 🔥 CSS 스케일링 고려: 실제 캔버스 픽셀 좌표로 변환
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const canvasX = (e.clientX - rect.left) * scaleX;
        const canvasY = (e.clientY - rect.top) * scaleY;

        // 🔥 이전 Alt+Drag 상태가 남아있으면 초기화
        if (this.isAltDrag && !e.altKey) {
            this.isAltDrag = false;
            this.polygonPath = [];
            this.altDragStartSelection = null;
        }

        // 🔥 Alt 키가 눌려있으면 다른 선택 로직 실행하지 않음
        if (e.altKey) {
            // 🔥 기존 Alt+Drag 상태가 있으면 먼저 초기화
            if (this.isAltDrag) {
                this.isAltDrag = false;
                this.polygonPath = [];
                this.altDragStartSelection = null;
            }
            this.isAltDrag = true;
            this.polygonPath = [{ x: canvasX, y: canvasY }];
            // 🔥 Alt+Drag 시작 시 기존 선택 상태 저장 (Shift/Ctrl과 함께 사용할 때)
            this.altDragStartSelection = new Set(this.selectedChips);
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if ((!this.legendFilterClasses || this.legendFilterClasses.size === 0) && this.viewer && typeof this.viewer.onManualChipSelection === 'function') {
            this.viewer.onManualChipSelection();
        }

        const chip = this.findChipAtPixel(canvasX, canvasY);

        // 🔥 Shift+드래그: 범위 선택
        if (e.shiftKey && !e.ctrlKey && !e.altKey) {
            this.shiftClickPos = { x: canvasX, y: canvasY };
            this.isDragging = false; // 드래그 시작 전
            this.render();
            return;
        }

        // 🔥 Ctrl+클릭: 드래그 감지용 위치 저장
        if (e.ctrlKey && !e.shiftKey && !e.altKey) {
            if (chip) {
                this.ctrlClickStartPos = { x: canvasX, y: canvasY };
                this.ctrlClickStartTime = Date.now();
                this.isDragging = false; // 드래그 시작 전
                this.dragStartChip = chip;
                this.render();
            } else {
                // 🔥 칩이 없는 곳 Ctrl+클릭: 선택 해제
                this.selectedChips.clear();
                this.selectedChipsOrder = []; // 🔥 선택 순서도 초기화
                this.updateSelectedChipsList(); // 🔥 Selection 패널 즉시 업데이트
                this.render();
            }
            return;
        }

        // 🔥 일반 클릭 (Ctrl/Shift/Alt 없음): 드래그 감지용 위치 저장
        if (!e.ctrlKey && !e.shiftKey && !e.altKey) {
            // 🔥 클릭 시작 위치 저장 (드래그 감지용)
            this.clickStartPos = { x: canvasX, y: canvasY };
            this.hasDragged = false;
            this.isDragging = false;
            this.dragStartChip = null;
            this.ctrlClickStartPos = null;
            this.ctrlClickStartTime = null;
            this._tempDragSelection = null;
            // 🔥 드래그가 발생하지 않으면 mouseup에서 선택 해제
            return;
        }
    }

    /**
     * Mouse up handler
     */
    _handleMouseUp(e) {
        const rect = this.canvas.getBoundingClientRect();
        // 🔥 CSS 스케일링 고려: 실제 캔버스 픽셀 좌표로 변환
        const scaleX = this.canvas.width / rect.width;
        const scaleY = this.canvas.height / rect.height;
        const canvasX = (e.clientX - rect.left) * scaleX;
        const canvasY = (e.clientY - rect.top) * scaleY;

        // 🔥 Alt+Drag polygon selection 처리 (Alt 키가 떼어져도 isAltDrag가 true이면 처리)
        if (this.isAltDrag) {
            // 🔥 polygon path가 최소 3개 이상일 때만 선택 처리 (원 그리기가 충분히 진행된 경우)
            if (this.polygonPath.length >= 3) {
                const selected = this._getChipsInPolygon(this.polygonPath);

                // 🔥 Alt+Drag 시작 시 저장된 선택 상태를 기반으로 처리
                // mouseup 시점의 키 상태를 우선 체크
                if (e.shiftKey) {
                    // Shift: add to selection (기존 선택에 추가, 배치 처리로 성능 향상)
                    const newSelections = selected.filter(idx => !this.selectedChips.has(idx));
                    newSelections.forEach(idx => {
                        this.selectedChips.add(idx);
                        // 🔥 선택 순서 배열에 추가 (맨 밑에 추가)
                        if (!this.selectedChipsOrder.includes(idx)) {
                            this.selectedChipsOrder.push(idx);
                        }
                    });
                    this.updateSelectedChipsList();
                    console.log('🖱️ [ALT+SHIFT+DRAG] 범위 선택 추가:', selected.length, '개 (신규:', newSelections.length, ')');
                } else if (e.ctrlKey) {
                    // Ctrl: toggle (기존 선택과 토글, 배치 처리로 성능 향상)
                    const toRemove = new Set();
                    const toAdd = new Set();
                    selected.forEach(idx => {
                        if (this.selectedChips.has(idx)) {
                            toRemove.add(idx);
                        } else {
                            toAdd.add(idx);
                        }
                    });
                    // 배치 처리
                    toRemove.forEach(idx => {
                        this.selectedChips.delete(idx);
                        // 🔥 선택 순서 배열에서도 제거
                        const orderIndex = this.selectedChipsOrder.indexOf(idx);
                        if (orderIndex !== -1) {
                            this.selectedChipsOrder.splice(orderIndex, 1);
                        }
                    });
                    toAdd.forEach(idx => {
                        this.selectedChips.add(idx);
                        // 🔥 선택 순서 배열에 추가 (맨 밑에 추가)
                        if (!this.selectedChipsOrder.includes(idx)) {
                            this.selectedChipsOrder.push(idx);
                        }
                    });
                    this.updateSelectedChipsList();
                    console.log('🖱️ [ALT+CTRL+DRAG] 범위 선택 토글:', selected.length, '개 (제거:', toRemove.size, ', 추가:', toAdd.size, ')');
                } else {
                    // Normal: add to selection (기존 선택에 추가, Shift처럼 동작)
                    const newSelections = selected.filter(idx => !this.selectedChips.has(idx));
                    newSelections.forEach(idx => {
                        this.selectedChips.add(idx);
                        // 🔥 선택 순서 배열에 추가 (맨 밑에 추가)
                        if (!this.selectedChipsOrder.includes(idx)) {
                            this.selectedChipsOrder.push(idx);
                        }
                    });
                    this.updateSelectedChipsList();
                    console.log('🖱️ [ALT+DRAG] 범위 선택 추가:', selected.length, '개 (신규:', newSelections.length, ')');
                }
            } else {
                // 🔥 polygon path가 너무 짧으면 선택하지 않음 (원 그리기 취소)
                console.log('⚠️ Alt+Drag 취소: polygon path가 너무 짧음');
            }

            // 🔥 Alt+Drag 상태 초기화
            this.isAltDrag = false;
            this.polygonPath = [];
            this.altDragStartSelection = null;
            this.render();
            return;
        }

        // 🔥 Shift+드래그 처리: 범위 내 chip 추가 선택
        if (this.shiftClickPos) {
            const dragDistance = Math.sqrt(
                Math.pow(canvasX - this.shiftClickPos.x, 2) +
                Math.pow(canvasY - this.shiftClickPos.y, 2)
            );
            // 드래그가 발생했으면 범위 선택
            if (dragDistance > 5) {
                const selected = this._getChipsInCanvasRect(
                    this.shiftClickPos.x,
                    this.shiftClickPos.y,
                    canvasX,
                    canvasY
                );
                // 🔥 Shift+드래그: 범위 내 chip 추가 선택 (배치 처리로 성능 향상)
                const toAdd = selected.filter(idx => !this.selectedChips.has(idx));
                toAdd.forEach(idx => {
                    this.selectedChips.add(idx);
                    // 🔥 선택 순서 배열에 추가 (맨 밑에 추가)
                    if (!this.selectedChipsOrder.includes(idx)) {
                        this.selectedChipsOrder.push(idx);
                    }
                });
                this.updateSelectedChipsList();
                console.log('🖱️ [SHIFT+DRAG] 범위 선택 추가:', selected.length, '개 (신규:', toAdd.length, ')');
            } else {
                // 드래그 없음: 선택 해제
                this.selectedChips.clear();
                this.selectedChipsOrder = []; // 🔥 선택 순서도 초기화
                console.log('🖱️ [SHIFT+CLICK] 선택 해제 (드래그 없음)');
            }
            this.shiftClickPos = null;
            this._tempDragSelection = null;
            this.render();
            return;
        }

        // 🔥 일반 클릭/드래그 (Ctrl/Shift/Alt 없음): 클릭은 선택 해제, 드래그는 범위 내 chip 제거
        if (!e.ctrlKey && !e.shiftKey && !e.altKey && this.clickStartPos) {
            const dragDistance = Math.sqrt(
                Math.pow(canvasX - this.clickStartPos.x, 2) +
                Math.pow(canvasY - this.clickStartPos.y, 2)
            );
            
            // 🔥 드래그가 발생했으면 범위 내 chip 제거
            if (dragDistance > 5) {
                const chipAtStart = this.findChipAtPixel(this.clickStartPos.x, this.clickStartPos.y);
                const chipAtEnd = this.findChipAtPixel(canvasX, canvasY);
                
                if (chipAtStart && chipAtEnd && chipAtStart !== chipAtEnd) {
                    const selected = this.getChipsInRect(chipAtStart, chipAtEnd);
                    // 🔥 일반 드래그: 범위 내 chip 제거 (배치 처리로 성능 향상)
                    const toRemove = selected.filter(idx => this.selectedChips.has(idx));
                    toRemove.forEach(idx => {
                        this.selectedChips.delete(idx);
                        // 🔥 선택 순서 배열에서도 제거
                        const orderIndex = this.selectedChipsOrder.indexOf(idx);
                        if (orderIndex !== -1) {
                            this.selectedChipsOrder.splice(orderIndex, 1);
                        }
                    });
                    this.updateSelectedChipsList();
                    console.log('🖱️ [DRAG] 범위 내 chip 제거:', selected.length, '개 (제거:', toRemove.length, ')');
                }
            } else {
                // 🔥 드래그가 없는 일반 클릭: 클릭한 chip 하나를 선택
                const clickedChip = this.findChipAtPixel(canvasX, canvasY);
                if (clickedChip) {
                    this.selectedChips.clear();
                    this.selectedChips.add(clickedChip.index);
                    this.selectedChipsOrder = [clickedChip.index];
                    console.log('🖱️ [CLICK] plain 클릭으로 단일 선택:', clickedChip.index);
                } else {
                    const hadSelection = this.selectedChips.size > 0;
                    this.selectedChips.clear();
                    this.selectedChipsOrder = [];
                    if (hadSelection) {
                        console.log('🖱️ [CLICK] 빈 영역 클릭으로 선택 해제');
                    } else {
                        console.log('🖱️ [CLICK] 선택 상태 없음 - 유지');
                    }
                }
                this.updateSelectedChipsList(); // 🔥 Selection 패널 즉시 업데이트
            }

            // 상태 초기화
            this.clickStartPos = null;
            this.hasDragged = false;
            this.render();
            return;
        }

        // 🔥 Ctrl+드래그 처리 (드래그 여부 확인)
        if (this.ctrlClickStartPos && this.dragStartChip) {
            const dragDistance = Math.sqrt(
                Math.pow(canvasX - this.ctrlClickStartPos.x, 2) +
                Math.pow(canvasY - this.ctrlClickStartPos.y, 2)
            );
            
            // 🔥 드래그가 발생했는지 확인 (5px 이상 이동)
            if (dragDistance > 5) {
                // 드래그 발생: 범위 선택 토글
                const chip = this.findChipAtPixel(canvasX, canvasY);
                if (chip && chip !== this.dragStartChip) {
                    const selected = this.getChipsInRect(this.dragStartChip, chip);
                    // 🔥 Ctrl+드래그: 범위 내 chip 토글 (배치 처리로 성능 향상)
                    // 대량 선택 시 Set 연산 최적화
                    const toRemove = new Set();
                    const toAdd = new Set();
                    selected.forEach(idx => {
                        if (this.selectedChips.has(idx)) {
                            toRemove.add(idx);
                        } else {
                            toAdd.add(idx);
                        }
                    });
                    // 배치 처리
                    toRemove.forEach(idx => {
                        this.selectedChips.delete(idx);
                        // 🔥 선택 순서 배열에서도 제거
                        const orderIndex = this.selectedChipsOrder.indexOf(idx);
                        if (orderIndex !== -1) {
                            this.selectedChipsOrder.splice(orderIndex, 1);
                        }
                    });
                    toAdd.forEach(idx => {
                        this.selectedChips.add(idx);
                        // 🔥 선택 순서 배열에 추가 (맨 밑에 추가)
                        if (!this.selectedChipsOrder.includes(idx)) {
                            this.selectedChipsOrder.push(idx);
                        }
                    });
                    this.updateSelectedChipsList();
                    console.log('🖱️ [CTRL+DRAG] 범위 선택 토글:', selected.length, '개 (제거:', toRemove.size, ', 추가:', toAdd.size, ')');
                }
            } else {
                // 단순 클릭 (5px 이하 이동): 단일 chip 토글
                if (this.dragStartChip) {
                    if (this.selectedChips.has(this.dragStartChip.index)) {
                        this.selectedChips.delete(this.dragStartChip.index);
                        // 🔥 선택 순서 배열에서도 제거
                        const orderIndex = this.selectedChipsOrder.indexOf(this.dragStartChip.index);
                        if (orderIndex !== -1) {
                            this.selectedChipsOrder.splice(orderIndex, 1);
                        }
                        console.log('🖱️ [CTRL+CLICK] chip 선택 해제:', this.dragStartChip.index);
                    } else {
                        this.selectedChips.add(this.dragStartChip.index);
                        // 🔥 선택 순서 배열에 추가 (맨 밑에 추가)
                        if (!this.selectedChipsOrder.includes(this.dragStartChip.index)) {
                            this.selectedChipsOrder.push(this.dragStartChip.index);
                        }
                        console.log('🖱️ [CTRL+CLICK] chip 선택 추가:', this.dragStartChip.index);
                    }
                    this.updateSelectedChipsList();
                }
            }
            
            // Ctrl+클릭 상태 초기화
            this.ctrlClickStartPos = null;
            this.ctrlClickStartTime = null;
            this.dragStartChip = null;
            this._tempDragSelection = null;
            this.render();
            return;
        }

        // 🔥 일반 클릭/드래그는 mousedown에서 이미 처리됨 (선택 해제만, 절대 선택하지 않음)
        // 여기서는 아무것도 하지 않음

        // 🔥 상태 초기화
        this.isDragging = false;
        this.dragStartChip = null;
        this.isMultiSelect = false;
        this._tempDragSelection = null;
        this.ctrlClickStartPos = null;
        this.ctrlClickStartTime = null;
        this.render();
    }

    /**
     * Get chips in canvas rectangle (for Shift+2-click)
     */
    _getChipsInCanvasRect(x1, y1, x2, y2) {
        const minX = Math.min(x1, x2);
        const maxX = Math.max(x1, x2);
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);

        const selected = [];
        const transform = this.viewer.transform;
        // 🔥 Y_OFFSET 적용: chip이 그려진 위치와 동일하게 계산
        const Y_OFFSET = -50; // _drawChipRect와 동일한 값

        for (let i = 0; i < this.chips.length; i++) {
            const chip = this.chips[i];
            const rect = chip.rect;

            // 🔥 Bottom Filter가 활성화된 경우, 가려진 칩은 선택 불가
            if (this.bottomFilterSet.size > 0 && !this.bottomFilterSet.has(String(chip.b))) {
                continue;
            }

            // Convert chip center to canvas coordinates (Y_OFFSET 적용)
            const chipCenterX = ((rect.x0 + rect.x1) / 2) * transform.scale + transform.dx;
            const chipCenterY = ((rect.y0 + rect.y1) / 2) * transform.scale + transform.dy + Y_OFFSET;

            // Check if chip center is in rectangle
            if (chipCenterX >= minX && chipCenterX <= maxX &&
                chipCenterY >= minY && chipCenterY <= maxY) {
                selected.push(i);
            }
        }

        return selected;
    }

    /**
     * Get chips in polygon (for Alt+Drag free-form selection)
     */
    _getChipsInPolygon(polygon) {
        if (polygon.length < 3) return [];

        const selected = [];
        const transform = this.viewer.transform;
        // 🔥 Y_OFFSET 적용: chip이 그려진 위치와 동일하게 계산
        const Y_OFFSET = -50; // _drawChipRect와 동일한 값

        for (let i = 0; i < this.chips.length; i++) {
            const chip = this.chips[i];
            const rect = chip.rect;

            // 🔥 Bottom Filter가 활성화된 경우, 가려진 칩은 선택 불가
            if (this.bottomFilterSet.size > 0 && !this.bottomFilterSet.has(String(chip.b))) {
                continue;
            }

            // Convert chip center to canvas coordinates (Y_OFFSET 적용)
            const chipCenterX = ((rect.x0 + rect.x1) / 2) * transform.scale + transform.dx;
            const chipCenterY = ((rect.y0 + rect.y1) / 2) * transform.scale + transform.dy + Y_OFFSET;

            // Check if chip center is inside polygon
            if (this._isPointInPolygon(chipCenterX, chipCenterY, polygon)) {
                selected.push(i);
            }
        }

        return selected;
    }

    /**
     * Point-in-polygon algorithm (ray casting)
     */
    _isPointInPolygon(x, y, polygon) {
        let inside = false;
        for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
            const xi = polygon[i].x, yi = polygon[i].y;
            const xj = polygon[j].x, yj = polygon[j].y;

            const intersect = ((yi > y) !== (yj > y)) &&
                (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }
        return inside;
    }

    /**
     * Mouse leave handler
     */
    _handleMouseLeave(e) {
        // Reset coordinate box
        if (this.coordChipAbs) {
            this.coordChipAbs.textContent = '-';
        }
        if (this.coordChipRel) {
            this.coordChipRel.textContent = '-';
        }

        // Clear hover
        this.hoveredChip = null;
        
        // 🔥 Alt+Drag 중이면 상태 유지 (마우스가 다시 돌아올 수 있음)
        // 🔥 Shift+드래그나 Ctrl+드래그 중에도 상태 유지
        if (!this.isAltDrag && !this.shiftClickPos && !this.ctrlClickStartPos) {
            this.isDragging = false;
            this.dragStartChip = null;
            this.isMultiSelect = false;
            this._tempDragSelection = null;
        }
        // 🔥 Alt+Drag 중이거나 드래그 중이면 hover만 제거하고 상태는 유지
        this.render();
    }

    /**
     * Keyboard handler
     */
    _handleKeyDown(e) {
        // ESC: Cancel ongoing selection
        if (e.key === 'Escape') {
            if (this.isAltDrag || this.shiftClickPos || this.ctrlClickStartPos) {
                this.isAltDrag = false;
                this.polygonPath = [];
                this.altDragStartSelection = null;
                this.shiftClickPos = null;
                this.ctrlClickStartPos = null;
                this.ctrlClickStartTime = null;
                this.dragStartChip = null;
                this._tempDragSelection = null;
                this.render();
                e.preventDefault();
            }
        }

        // Ctrl+A: Select all visible chips (excluding bottom-filtered chips)
        if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
            // Only handle in single image mode (not in grid mode)
            if (this.viewer && !this.viewer.gridMode && this.chips.length > 0) {
                e.preventDefault();
                this.selectAllVisibleChips();
            }
        }
    }

    /**
     * Select all visible chips (excluding bottom-filtered chips)
     */
    selectAllVisibleChips() {
        if (!this.chips || this.chips.length === 0) {
            console.warn('⚠️ No chips available to select');
            return;
        }

        const newSelections = [];

        this.chips.forEach((chip, index) => {
            // Skip chips filtered out by Bottom Legend
            if (this.bottomFilterSet.size > 0 && !this.bottomFilterSet.has(String(chip.b))) {
                return;
            }
            newSelections.push(index);
        });

        // Clear existing selection and add all visible chips
        this.selectedChips.clear();
        this.selectedChipsOrder = [];

        newSelections.forEach(idx => {
            this.selectedChips.add(idx);
            this.selectedChipsOrder.push(idx);
        });

        this.render();
        this.updateSelectedChipsList();

        console.log(`✅ [CTRL+A] Selected ${newSelections.length} visible chips (Total: ${this.chips.length}, Filtered: ${this.chips.length - newSelections.length})`);
    }

    /**
     * Keyboard up handler - Alt 키가 떼어졌을 때 Alt+Drag 상태 초기화
     */
    _handleKeyUp(e) {
        // 🔥 Alt 키가 떼어지면 Alt+Drag 상태 초기화
        if (e.key === 'Alt' && this.isAltDrag) {
            this.isAltDrag = false;
            this.polygonPath = [];
            this.altDragStartSelection = null;
            this.render();
        }
    }

    /**
     * Document-level mouse up handler - 캔버스 밖에서 마우스를 떼는 경우 처리
     */
    _handleDocumentMouseUp(e) {
        // 🔥 Alt+Drag 상태가 있고 마우스가 캔버스 밖에서 떼어진 경우 처리
        if (this.isAltDrag) {
            const rect = this.canvas.getBoundingClientRect();
            const isInsideCanvas = 
                e.clientX >= rect.left && e.clientX <= rect.right &&
                e.clientY >= rect.top && e.clientY <= rect.bottom;
            
            // 캔버스 밖에서 마우스를 떼면 Alt+Drag 상태 초기화
            if (!isInsideCanvas) {
                this.isAltDrag = false;
                this.polygonPath = [];
                this.altDragStartSelection = null;
                this.render();
            }
        }
    }

    /**
     * Clear all data (on image unload)
     */
    clear() {
        this.positionsData = null;
        this.chips = [];
        this.chipIndexMap.clear();
        this.markedChips = [];
        this.classColors.clear();
        this.classColorIndex = 0;
        this.legendFilterClasses = null;
        this._notifyLegendUpdate([]);
        this.partId = null;
        this.device = null;
        this.pgm = null;
        this.selectedChips.clear();
        this.selectedChipsOrder = []; // 🔥 선택 순서도 초기화
        if (this.viewer && typeof this.viewer.handleChipSelectionCleared === 'function') {
            this.viewer.handleChipSelectionCleared();
        }
        this.hoveredChip = null;
        this.currentImagePath = null;

        // Clear selection state
        this.isDragging = false;
        this.dragStartChip = null;
        this.isMultiSelect = false;
        this.isAltDrag = false;
        this.polygonPath = [];
        this.shiftClickPos = null;
        this.altDragStartSelection = null;
        this._tempDragSelection = null;
        this.ctrlClickStartPos = null;
        this.ctrlClickStartTime = null;
        this.lastMousePos = null;

        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Reset coordinate box
        if (this.coordChipAbs) {
            this.coordChipAbs.textContent = '-';
        }
        if (this.coordChipRel) {
            this.coordChipRel.textContent = '-';
        }
        if (this.coordPartId) {
            this.coordPartId.textContent = '-';
        }
        if (this.coordDevice) {
            this.coordDevice.textContent = '-';
        }
        if (this.coordPgm) {
            this.coordPgm.textContent = '-';
        }
        if (this.coordBin) {
            this.coordBin.textContent = '-';
        }
    }
}
