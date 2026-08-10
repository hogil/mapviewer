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

// positions 클라이언트 캐시 (화살표 이동 시 재요청 방지)
const _positionsCache = new Map(); // path → positionsData
const _POSITIONS_CACHE_MAX = 50;
const SYSTEMATIC_FILTER_BINS = new Set([
    '285', '286', '287', '288', '290', '291',
    '300', '385', '386', '388', '389', '390',
]);

export class ChipAnnotator {
    constructor(canvas, viewer) {
        this.canvas = canvas;
        this.viewer = viewer;
        this.ctx = canvas.getContext('2d');

        // Chip overlay Y 방향 보정 값 (px)
        // draw()에서 overlayCanvas.style.top='0'으로 설정하지만
        // imageCanvas는 CSS top: var(--filename-bar-height)이므로 위치 차이 보정 필요
        this.Y_OFFSET = 0;

        // Chip position data
        this.positionsData = null;
        this.chips = [];
        this.partId = null;
        this.device = null;
        this.pgm = null;
        this.tm = null;
        this.lt = null;
        this.netd = null;
        this.gd = null;
        this.yield = null;
        this.sys = null;

        // Annotation data
        this.markedChips = []; // {x_abs, y_abs, class, label, ...}
        this.chipIndexMap = new Map(); // (x_abs,y_abs) -> chip index
        this.selectedChips = new Set(); // Set of chip indices
        this.selectedChipsOrder = []; // 🔥 선택 순서 추적 (항상 맨 밑에 추가)
        this.selectionMode = 'chip'; // 'chip' or 'shot'
        this.legendFilterClasses = null;
        this.chipLabelOverlayAlpha = 0.2;
        this.bottomFilterSet = new Set(); // 🔥 Bottom Filter (Chip b-value based mask)
        this.gradeFilterSet = new Set(); // Grade legend filter (palette index 0-7)

        // Overlay mode: null = normal (white mask), 'bin' = bin color fill+text, 'f'/'q' = ratio gradient
        this.overlayMode = null;
        this.overlayItemKey = null;        // selected f/q sub-item key (e.g., "2342")
        this.binOverlayColors = new Map(); // normalized b-value string -> hex color
        this.binOverlayFilterSet = new Set(); // Systematic overlay BIN subset
        this.binOverlayFilterColor = null;
        this.ratioOverlayColors = null;    // Map<chipIndex, rgbaColor> or null
        this.ratioPercentiles = null;      // Map<chipIndex, percentile(0~100)> for gradient range filtering
        this.gradientFilterSet = new Set(); // Selected gradient range indices (0~10): 0=exact 0, 1=0~10%, ..., 10=90~100%
        this.gradientStops = null;         // Array of 11 hex strings
        this.gradientQuantiles = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

        this.classColors = new Map();
        this.classColorPalette = [
            [41, 182, 246],
            [102, 187, 106],
            [255, 160, 67],
            [126, 87, 194],
            [38, 166, 154],
            [255, 214, 102],
            [171, 71, 188],
            [239, 83, 80],
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
        this.hoverColor = 'rgba(238, 238, 238, 0.55)';
        // Keep selection distinct from the silver-white hover on bright wafer cells.
        this.selectedColor = 'rgba(255, 255, 0, 0.25)';
        this.selectionPreviewColor = 'rgba(215, 215, 215, 0.26)';
        this.markedColor = 'rgba(255, 0, 0, 0.4)';

        // Coordinate display elements
        this.coordBox = document.getElementById('chip-coordinate-box');
        this.coordChipCoord = document.getElementById('coord-chip-coord');
        this.coordChipRel = document.getElementById('coord-chip-rel');
        this.coordRadious = document.getElementById('coord-radious');
        this.coordShot = document.getElementById('coord-shot');
        this.coordPartId = document.getElementById('coord-partid');
        this.coordDevice = document.getElementById('coord-device');
        this.coordPgm = document.getElementById('coord-pgm');
        this.coordTm = document.getElementById('coord-tm');
        this.coordLt = document.getElementById('coord-lt');
        this.coordNetd = document.getElementById('coord-netd');
        this.coordGd = document.getElementById('coord-gd');
        this.coordYield = document.getElementById('coord-yield');
        this.coordSys = document.getElementById('coord-sys');
        this.coordBin = document.getElementById('coord-bin');

        // Current image path
        this.currentImagePath = null;
        this.layoutProcessId = null;
        this.layoutByChip = new Map();
        this.shotBoundaryGroups = new Map();
        this._shotGridGeometry = null;
        this._shotBoundaryCache = new Map();
        this._shotMedianCellSize = null;
        this.shotBoundaryVisible = false;
        this.shotBoundaryColor = 'rgba(170, 85, 210, 0.95)';

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

        // document 레벨 mousemove: 투명 캔버스가 이벤트를 놓치는 환경 대응
        // canvas 리스너와 중복 시 5ms 디바운스가 자동 필터링
        document.addEventListener('mousemove', this._onMouseMove);
    }

    _layoutSignatureNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) ? String(number) : '';
    }

    _normalizeFullShotType(value) {
        const normalized = String(value ?? '').trim().toUpperCase();
        if (normalized === 'WHOLE' || normalized === 'FULL') return 'FULL';
        if (normalized === 'FRAGMENT' || normalized === 'PARTIAL') return 'PARTIAL';
        return normalized;
    }

    _isFullShotType(value) {
        return this._normalizeFullShotType(value) === 'FULL';
    }

    _getLayoutGeometrySignature(row) {
        return [
            this._layoutSignatureNumber(row?.shot_x_pos),
            this._layoutSignatureNumber(row?.shot_y_pos),
            this._layoutSignatureNumber(row?.chip_id),
            this._layoutSignatureNumber(row?.chip_center_x_pos),
            this._layoutSignatureNumber(row?.chip_center_y_pos),
            this._normalizeFullShotType(row?.full_shot_type),
        ].join('|');
    }

    _chooseLayoutRepresentative(rows) {
        const candidates = Array.isArray(rows) ? rows.filter(Boolean) : [];
        if (candidates.length <= 1) return candidates[0] || null;

        const signatures = new Map();
        candidates.forEach((row, index) => {
            const signature = this._getLayoutGeometrySignature(row);
            const entry = signatures.get(signature) || { row, count: 0, firstIndex: index };
            entry.count += 1;
            signatures.set(signature, entry);
        });

        return [...signatures.values()].sort((left, right) =>
            right.count - left.count || left.firstIndex - right.firstIndex
        )[0]?.row || candidates[0];
    }

    setLayoutData(processId, rows) {
        const startedAt = performance.now();
        this.layoutProcessId = processId || null;
        this.layoutByChip.clear();
        const buckets = new Map();
        for (const row of Array.isArray(rows) ? rows : []) {
            const x = Number(row?.chip_x_pos);
            const y = Number(row?.chip_y_pos);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            const key = `${x}:${y}`;
            if (!buckets.has(key)) buckets.set(key, []);
            buckets.get(key).push(row);
        }

        let duplicateKeys = 0;
        let conflictingDuplicateKeys = 0;
        buckets.forEach((bucket, key) => {
            if (bucket.length > 1) {
                duplicateKeys += 1;
                const signatures = new Set(bucket.map((row) => this._getLayoutGeometrySignature(row)));
                if (signatures.size > 1) conflictingDuplicateKeys += 1;
            }
            const representative = this._chooseLayoutRepresentative(bucket);
            if (representative) this.layoutByChip.set(key, representative);
        });
        if (duplicateKeys > 0) {
            console.warn('[LAYOUT] duplicate chip rows collapsed', {
                processId: this.layoutProcessId,
                duplicateKeys,
                conflictingDuplicateKeys,
                sourceRows: Array.isArray(rows) ? rows.length : 0,
                uniqueChips: this.layoutByChip.size,
            });
        }
        this._invalidateShotGeometry();
        this._buildShotBoundaryGroups();
        this._logShotBoundary('layout ready', {
            processId: this.layoutProcessId,
            sourceRows: Array.isArray(rows) ? rows.length : 0,
            uniqueChips: this.layoutByChip.size,
            groups: this.shotBoundaryGroups.size,
            duplicateKeys,
            conflictingDuplicateKeys,
            elapsedMs: Math.round(performance.now() - startedAt),
        });
        if (this.hoveredChip) {
            this._updateCoordinateBox(0, 0, this.hoveredChip);
        }
        if (this.shotBoundaryVisible) this._renderShotBoundaries();
    }

    clearLayoutData(options = {}) {
        const resetVisibility = options.resetVisibility !== false;
        this.layoutProcessId = null;
        this.layoutByChip.clear();
        this.shotBoundaryGroups.clear();
        if (resetVisibility) {
            this.shotBoundaryVisible = false;
        }
        this._invalidateShotGeometry();
        this.hoveredChip = null;
        this._resetChipCoordinateDisplay();
        this.viewer?._syncShotBoundaryButtonUI?.();
    }

    _getShotGroupKeyForLayout(layoutRow) {
        if (!layoutRow) return null;
        const shotX = Number(layoutRow.shot_x_pos);
        const shotY = Number(layoutRow.shot_y_pos);
        if (Number.isFinite(shotX) && Number.isFinite(shotY)) {
            return `xy:${shotX}:${shotY}`;
        }
        const shotId = String(layoutRow.shot_id ?? '').trim();
        return shotId ? `id:${shotId}` : null;
    }

    setShotBoundaryVisible(visible) {
        this.shotBoundaryVisible = Boolean(visible);
        this._shotBoundaryLogNextRender = this.shotBoundaryVisible;
        this._logShotBoundary('toggle', {
            visible: this.shotBoundaryVisible,
            processId: this.layoutProcessId,
            chips: Array.isArray(this.chips) ? this.chips.length : 0,
            groups: this.shotBoundaryGroups.size,
            gridMode: this.viewer?.gridMode === true,
        });
        if (this.shotBoundaryVisible) {
            // The existing overlay is already on the canvas; adding boundaries
            // must not redraw every chip and label.
            this._renderShotBoundaries();
        } else {
            this.render();
        }
        this.viewer?._syncShotBoundaryButtonUI?.();
    }

    _logShotBoundary(event, data = {}) {
        try {
            console.info(`[SHOT] ${event}`, data);
        } catch (_) {}
    }

    _invalidateShotGeometry() {
        this._shotGridGeometry = null;
        this._shotBoundaryCache.clear();
        this._shotMedianCellSize = null;
    }

    setSelectionMode(mode) {
        const nextMode = mode === 'shot' ? 'shot' : 'chip';
        if (this.selectionMode === nextMode) {
            this.render();
            return this.selectionMode;
        }
        this.selectionMode = nextMode;
        this.clearSelection();
        return this.selectionMode;
    }

    _buildShotBoundaryGroups() {
        this.shotBoundaryGroups.clear();
        if (!Array.isArray(this.chips) || this.chips.length === 0) return;

        this.chips.forEach((chip, index) => {
            const layoutRow = this.getLayoutRowForChip(chip);
            const groupKey = this._getShotGroupKeyForLayout(layoutRow);
            if (!groupKey || !chip?.rect) return;
            const rawShotId = String(layoutRow?.shot_id ?? '').trim();
            const shotX = Number(layoutRow?.shot_x_pos);
            const shotY = Number(layoutRow?.shot_y_pos);
            const shotId = rawShotId || (
                Number.isFinite(shotX) && Number.isFinite(shotY)
                    ? `${shotX},${shotY}`
                    : groupKey
            );

            let group = this.shotBoundaryGroups.get(groupKey);
            if (!group) {
                group = { shotId, groupKey, shotX, shotY, chips: [], indices: [] };
                this.shotBoundaryGroups.set(groupKey, group);
            }
            group.chips.push(chip);
            group.indices.push(index);
        });
    }

    _getShotGroupForChip(chip) {
        const layoutRow = this.getLayoutRowForChip(chip);
        if (!layoutRow) return null;
        const groupKey = this._getShotGroupKeyForLayout(layoutRow);
        return groupKey ? this.shotBoundaryGroups.get(groupKey) || null : null;
    }

    _getShotChipIndices(chip) {
        const group = this._getShotGroupForChip(chip);
        if (!group) return [];
        if (Array.isArray(group.indices)) return [...group.indices];
        return group.chips
            .map((groupChip) => this.chips.indexOf(groupChip))
            .filter((index) => index >= 0);
    }

    _getSelectedShotGroups() {
        const groups = new Set();
        if (this.selectionMode !== 'shot') return groups;
        this.selectedChips.forEach((chipIndex) => {
            const group = this._getShotGroupForChip(this.chips[chipIndex]);
            if (group) groups.add(group);
        });
        return groups;
    }

    getShotGridShape() {
        return this._getShotGridGeometry()?.shape || null;
    }

    getShotCompositeGridShape() {
        const geometry = this._getShotGridGeometry?.();
        return geometry?.gridShape || geometry?.shape || null;
    }

    _getChipScreenCenter(chip) {
        const rect = chip?.rect;
        if (!rect) return null;
        const x0 = Number(rect.x0);
        const y0 = Number(rect.y0);
        const x1 = Number(rect.x1);
        const y1 = Number(rect.y1);
        if (![x0, y0, x1, y1].every(Number.isFinite)) return null;
        return { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
    }

    _medianVector(vectors) {
        const dx = (Array.isArray(vectors) ? vectors : [])
            .map((vector) => Number(vector?.dx))
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
        const dy = (Array.isArray(vectors) ? vectors : [])
            .map((vector) => Number(vector?.dy))
            .filter(Number.isFinite)
            .sort((a, b) => a - b);
        if (!dx.length || !dy.length) return null;
        const mid = (values) => {
            const index = Math.floor(values.length / 2);
            return values.length % 2 ? values[index] : (values[index - 1] + values[index]) / 2;
        };
        return { dx: mid(dx), dy: mid(dy) };
    }

    _inferGridScreenTransform(entries) {
        const byCoord = new Map();
        (Array.isArray(entries) ? entries : []).forEach((entry) => {
            const center = this._getChipScreenCenter(entry?.chip);
            if (!center) return;
            byCoord.set(`${entry.x}:${entry.y}`, { ...entry, center });
        });
        const xVectors = [];
        const yVectors = [];
        byCoord.forEach((entry) => {
            const nextX = byCoord.get(`${entry.x + 1}:${entry.y}`);
            const nextY = byCoord.get(`${entry.x}:${entry.y + 1}`);
            if (nextX) {
                xVectors.push({
                    dx: nextX.center.x - entry.center.x,
                    dy: nextX.center.y - entry.center.y,
                });
            }
            if (nextY) {
                yVectors.push({
                    dx: nextY.center.x - entry.center.x,
                    dy: nextY.center.y - entry.center.y,
                });
            }
        });
        const xVector = this._medianVector(xVectors);
        const yVector = this._medianVector(yVectors);
        const xAxis = xVector && Math.abs(xVector.dy) > Math.abs(xVector.dx) ? 'y' : 'x';
        const yAxis = yVector && Math.abs(yVector.dx) > Math.abs(yVector.dy) ? 'x' : 'y';
        if (xAxis === yAxis) {
            return {
                xAxis: 'x',
                xSign: xVector && Math.abs(xVector.dx) > 0 ? Math.sign(xVector.dx) || 1 : 1,
                yAxis: 'y',
                ySign: yVector && Math.abs(yVector.dy) > 0 ? Math.sign(yVector.dy) || 1 : 1,
                transposed: false,
            };
        }
        return {
            xAxis,
            xSign: xAxis === 'x'
                ? (Math.sign(xVector?.dx || 1) || 1)
                : (Math.sign(xVector?.dy || 1) || 1),
            yAxis,
            ySign: yAxis === 'x'
                ? (Math.sign(yVector?.dx || 1) || 1)
                : (Math.sign(yVector?.dy || 1) || 1),
            transposed: xAxis === 'y' && yAxis === 'x',
        };
    }

    _getDisplayShotShape(gridShape, screenTransform) {
        const cols = Math.max(1, Number(gridShape?.cols) || 1);
        const rows = Math.max(1, Number(gridShape?.rows) || 1);
        if (screenTransform?.transposed) {
            return { cols: rows, rows: cols };
        }
        return { cols, rows };
    }

    _toDisplayShotSlot(rawSlotX, rawSlotY, geometry) {
        if (!geometry) return null;
        const gridCols = Math.max(1, Number(geometry.gridShape?.cols) || Number(geometry.shape?.cols) || 1);
        const gridRows = Math.max(1, Number(geometry.gridShape?.rows) || Number(geometry.shape?.rows) || 1);
        const transform = geometry.screenTransform || {};
        if (transform.transposed) {
            return {
                slotX: transform.ySign >= 0 ? rawSlotY : gridRows - 1 - rawSlotY,
                slotY: transform.xSign >= 0 ? rawSlotX : gridCols - 1 - rawSlotX,
                cols: geometry.shape.cols,
                rows: geometry.shape.rows,
            };
        }
        return {
            slotX: transform.xSign >= 0 ? rawSlotX : gridCols - 1 - rawSlotX,
            slotY: transform.ySign >= 0 ? rawSlotY : gridRows - 1 - rawSlotY,
            cols: geometry.shape.cols,
            rows: geometry.shape.rows,
        };
    }

    _inferShotAxisDirection(groups, shotKey, gridKey, fallback = 1) {
        let score = 0;
        for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
            const left = groups[leftIndex];
            const leftShot = Number(left?.[shotKey]);
            const leftGrid = Number(left?.[gridKey]);
            if (!Number.isFinite(leftShot) || !Number.isFinite(leftGrid)) continue;
            for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
                const right = groups[rightIndex];
                const rightShot = Number(right?.[shotKey]);
                const rightGrid = Number(right?.[gridKey]);
                if (!Number.isFinite(rightShot) || !Number.isFinite(rightGrid)) continue;
                const shotDelta = rightShot - leftShot;
                const gridDelta = rightGrid - leftGrid;
                if (shotDelta === 0 || gridDelta === 0) continue;
                score += Math.sign(shotDelta * gridDelta);
            }
        }
        if (score > 0) return 1;
        if (score < 0) return -1;
        return fallback;
    }

    _getShotGridOffset(shotValue, minShotValue, maxShotValue, direction) {
        if (![shotValue, minShotValue, maxShotValue].every(Number.isFinite)) return null;
        return direction >= 0
            ? shotValue - minShotValue
            : maxShotValue - shotValue;
    }

    _getShotGridBase(layoutRow, geometry) {
        if (!layoutRow || !geometry) return null;
        const shotX = Number(layoutRow.shot_x_pos);
        const shotY = Number(layoutRow.shot_y_pos);
        const cols = Number(geometry.gridShape?.cols ?? geometry.shape?.cols);
        const rows = Number(geometry.gridShape?.rows ?? geometry.shape?.rows);
        const xOffset = this._getShotGridOffset(shotX, geometry.minShotX, geometry.maxShotX, geometry.xDirection);
        const yOffset = this._getShotGridOffset(shotY, geometry.minShotY, geometry.maxShotY, geometry.yDirection);
        if (![cols, rows, geometry.originX, geometry.originY, xOffset, yOffset].every(Number.isFinite)) {
            return null;
        }
        return {
            x: geometry.originX + xOffset * cols,
            y: geometry.originY + yOffset * rows,
        };
    }

    _getCanonicalShotGridShapeFromLayout() {
        const rows = [...this.layoutByChip.values()];
        if (rows.length === 0) return null;
        const groups = new Map();
        rows.forEach((row) => {
            const key = this._getShotGroupKeyForLayout(row);
            const x = Number(row?.chip_x_pos);
            const y = Number(row?.chip_y_pos);
            if (!key || !Number.isInteger(x) || !Number.isInteger(y)) return;
            let group = groups.get(key);
            if (!group) {
                group = { xs: [], ys: [], isFull: false };
                groups.set(key, group);
            }
            group.xs.push(x);
            group.ys.push(y);
            if (this._isFullShotType(row?.full_shot_type)) {
                group.isFull = true;
            }
        });

        const candidates = [...groups.values()].map((group) => {
            const minX = Math.min(...group.xs);
            const minY = Math.min(...group.ys);
            const cols = Math.max(...group.xs) - minX + 1;
            const rows = Math.max(...group.ys) - minY + 1;
            const count = group.xs.length;
            const area = cols * rows;
            return {
                cols,
                rows,
                count,
                area,
                isFull: group.isFull,
                minX,
                minY,
            };
        }).filter((group) => group.cols > 0 && group.rows > 0 && group.count > 0);
        if (candidates.length === 0) return null;

        const fullCandidates = candidates.filter((group) => group.isFull);
        const pool = fullCandidates.length ? fullCandidates : candidates;
        const best = [...pool].sort((left, right) =>
            right.count - left.count ||
            right.area - left.area ||
            left.cols - right.cols ||
            left.rows - right.rows
        )[0];
        if (!best) return null;
        const positiveModulo = (value, size) => ((value % size) + size) % size;
        return {
            cols: best.cols,
            rows: best.rows,
            slotOriginX: positiveModulo(best.minX, best.cols),
            slotOriginY: positiveModulo(best.minY, best.rows),
        };
    }

    _getShotGridGeometry() {
        if (this._shotGridGeometry) return this._shotGridGeometry;

        const groups = [];
        const entries = [];
        const shotXValues = [];
        const shotYValues = [];
        let maxGridCols = 0;
        let maxGridRows = 0;

        for (const group of this.shotBoundaryGroups.values()) {
            const groupEntries = (group.indices || []).map((index) => {
                const chip = this.chips[index];
                const layout = this.getLayoutRowForChip(chip);
                const x = Number(chip?.x_abs);
                const y = Number(chip?.y_abs);
                const shotX = Number(layout?.shot_x_pos);
                const shotY = Number(layout?.shot_y_pos);
                if (!chip?.rect || !Number.isInteger(x) || !Number.isInteger(y)) return null;
                return {
                    chip,
                    layout,
                    x,
                    y,
                    shotX: Number.isInteger(shotX) ? shotX : null,
                    shotY: Number.isInteger(shotY) ? shotY : null,
                };
            }).filter(Boolean);
            if (groupEntries.length === 0) continue;

            const xs = groupEntries.map((entry) => entry.x);
            const ys = groupEntries.map((entry) => entry.y);
            const groupGridCols = Math.max(...xs) - Math.min(...xs) + 1;
            const groupGridRows = Math.max(...ys) - Math.min(...ys) + 1;
            maxGridCols = Math.max(maxGridCols, groupGridCols);
            maxGridRows = Math.max(maxGridRows, groupGridRows);
            const shotX = groupEntries.find((entry) => entry.shotX !== null)?.shotX;
            const shotY = groupEntries.find((entry) => entry.shotY !== null)?.shotY;
            if (shotX !== undefined && shotX !== null) shotXValues.push(shotX);
            if (shotY !== undefined && shotY !== null) shotYValues.push(shotY);
            groups.push({
                group,
                entries: groupEntries,
                shotX,
                shotY,
                gridCols: groupGridCols,
                gridRows: groupGridRows,
                chipCount: groupEntries.length,
                avgX: xs.reduce((sum, value) => sum + value, 0) / xs.length,
                avgY: ys.reduce((sum, value) => sum + value, 0) / ys.length,
            });
            entries.push(...groupEntries);
        }

        if (maxGridCols <= 0 || maxGridRows <= 0 || entries.length === 0) {
            this._shotGridGeometry = null;
            return null;
        }

        const minShotX = shotXValues.length ? Math.min(...shotXValues) : null;
        const maxShotX = shotXValues.length ? Math.max(...shotXValues) : null;
        const minShotY = shotYValues.length ? Math.min(...shotYValues) : null;
        const maxShotY = shotYValues.length ? Math.max(...shotYValues) : null;
        const xDirection = this._inferShotAxisDirection(groups, 'shotX', 'avgX', 1);
        const yDirection = this._inferShotAxisDirection(groups, 'shotY', 'avgY', -1);
        const canonicalShape = this._getCanonicalShotGridShapeFromLayout();

        const orderByReferencePriority = (left, right) => {
            const leftFull = canonicalShape &&
                left.gridCols >= canonicalShape.cols && left.gridRows >= canonicalShape.rows ? 0 : 1;
            const rightFull = canonicalShape &&
                right.gridCols >= canonicalShape.cols && right.gridRows >= canonicalShape.rows ? 0 : 1;
            const leftOrigin = left.shotX === 0 && left.shotY === 0 ? 0 : 1;
            const rightOrigin = right.shotX === 0 && right.shotY === 0 ? 0 : 1;
            const leftDistance = Math.abs(Number(left.shotX) || 0) + Math.abs(Number(left.shotY) || 0);
            const rightDistance = Math.abs(Number(right.shotX) || 0) + Math.abs(Number(right.shotY) || 0);
            return leftFull - rightFull ||
                right.chipCount - left.chipCount ||
                right.gridCols * right.gridRows - left.gridCols * left.gridRows ||
                leftOrigin - rightOrigin ||
                leftDistance - rightDistance;
        };
        const referenceGroup = [...groups].sort(orderByReferencePriority)[0] || null;
        const gridCols = Math.max(1, Number(canonicalShape?.cols) || Number(referenceGroup?.gridCols) || maxGridCols);
        const gridRows = Math.max(1, Number(canonicalShape?.rows) || Number(referenceGroup?.gridRows) || maxGridRows);
        let originX = null;
        let originY = null;
        if (referenceGroup && minShotX !== null && maxShotX !== null && minShotY !== null && maxShotY !== null) {
            const refXs = referenceGroup.entries.map((entry) => entry.x);
            const refYs = referenceGroup.entries.map((entry) => entry.y);
            const refXOffset = this._getShotGridOffset(referenceGroup.shotX, minShotX, maxShotX, xDirection);
            const refYOffset = this._getShotGridOffset(referenceGroup.shotY, minShotY, maxShotY, yDirection);
            if (Number.isFinite(refXOffset) && refXs.length) {
                originX = Math.min(...refXs) - refXOffset * gridCols;
            }
            if (Number.isFinite(refYOffset) && refYs.length) {
                originY = Math.min(...refYs) - refYOffset * gridRows;
            }
        }
        if ((originX === null || originY === null) &&
            minShotX !== null && maxShotX !== null && minShotY !== null && maxShotY !== null) {
            const xOrigins = entries
                .filter((entry) => entry.shotX !== null)
                .map((entry) => {
                    const offset = this._getShotGridOffset(entry.shotX, minShotX, maxShotX, xDirection);
                    return Number.isFinite(offset) ? entry.x - offset * gridCols : NaN;
                })
                .filter(Number.isFinite);
            const yOrigins = entries
                .filter((entry) => entry.shotY !== null)
                .map((entry) => {
                    const offset = this._getShotGridOffset(entry.shotY, minShotY, maxShotY, yDirection);
                    return Number.isFinite(offset) ? entry.y - offset * gridRows : NaN;
                })
                .filter(Number.isFinite);
            if (xOrigins.length) originX = Math.min(...xOrigins);
            if (yOrigins.length) originY = Math.min(...yOrigins);
        }

        const gridShape = { cols: gridCols, rows: gridRows };
        const referenceEntries = referenceGroup?.entries?.length ? referenceGroup.entries : entries;
        const referenceXs = referenceEntries.map((entry) => Number(entry.x)).filter(Number.isFinite);
        const referenceYs = referenceEntries.map((entry) => Number(entry.y)).filter(Number.isFinite);
        const positiveModulo = (value, size) => ((value % size) + size) % size;
        const slotOriginX = Number.isFinite(Number(canonicalShape?.slotOriginX))
            ? Number(canonicalShape.slotOriginX)
            : referenceXs.length ? positiveModulo(Math.min(...referenceXs), gridCols) : 0;
        const slotOriginY = Number.isFinite(Number(canonicalShape?.slotOriginY))
            ? Number(canonicalShape.slotOriginY)
            : referenceYs.length ? positiveModulo(Math.min(...referenceYs), gridRows) : 0;
        const screenTransform = this._inferGridScreenTransform(referenceEntries);
        const shape = this._getDisplayShotShape(gridShape, screenTransform);
        const referenceCellSize = this._getMedianChipRectSize(
            referenceEntries.map((entry) => entry.chip).filter(Boolean)
        ) || this._getMedianChipRectSize(this.chips);
        this._shotGridGeometry = {
            shape,
            gridShape,
            screenTransform,
            referenceCellSize,
            referenceGroupKey: referenceGroup?.group?.groupKey ?? referenceGroup?.group?.shotId ?? null,
            slotOriginX,
            slotOriginY,
            groups,
            minShotX,
            maxShotX,
            minShotY,
            maxShotY,
            xDirection,
            yDirection,
            originX,
            originY,
        };
        return this._shotGridGeometry;
    }

    _getSelectionIndicesForChip(chip) {
        if (!chip) return [];
        const chipIndex = Number.isInteger(chip.index)
            ? chip.index
            : this._getChipIndexFromCoords(Number(chip.x_abs), Number(chip.y_abs));
        if (chipIndex < 0) return [];
        if (!this.isChipSelectable(this.chips[chipIndex])) return [];
        if (this.selectionMode !== 'shot') return [chipIndex];
        const shotIndices = this._getShotChipIndices(chip);
        return this._filterSelectableIndices(shotIndices.length > 0 ? shotIndices : [chipIndex]);
    }

    _expandSelectionToShots(indices) {
        const expanded = new Set();
        for (const index of Array.isArray(indices) ? indices : []) {
            const chip = this.chips[index];
            this._getSelectionIndicesForChip(chip).forEach((chipIndex) => expanded.add(chipIndex));
        }
        return this._filterSelectableIndices(Array.from(expanded));
    }

    _getShotBoundaryRect(group) {
        if (!group?.chips?.length) return null;
        const cacheKey = String(group.groupKey ?? group.shotId ?? '');
        if (cacheKey && this._shotBoundaryCache.has(cacheKey)) {
            return this._shotBoundaryCache.get(cacheKey);
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        group.chips.forEach((chip) => {
            const rect = chip?.rect;
            if (!rect) return;
            minX = Math.min(minX, Number(rect.x0));
            minY = Math.min(minY, Number(rect.y0));
            maxX = Math.max(maxX, Number(rect.x1));
            maxY = Math.max(maxY, Number(rect.y1));
        });
        if (![minX, minY, maxX, maxY].every(Number.isFinite)) return null;
        const width = maxX - minX;
        const height = maxY - minY;
        if (width <= 0 || height <= 0) return null;
        let boundary = { minX, minY, maxX, maxY, width, height };

        const rawShape = this.getShotCompositeGridShape?.() || this.getShotGridShape?.();
        const displayShape = this.getShotGridShape?.() || rawShape;
        const rawCols = Math.max(1, Number(rawShape?.cols) || 0);
        const rawRows = Math.max(1, Number(rawShape?.rows) || 0);
        const displayCols = Math.max(1, Number(displayShape?.cols) || rawCols || 0);
        const displayRows = Math.max(1, Number(displayShape?.rows) || rawRows || 0);
        const fullSlotCount = rawCols * rawRows;
        if (displayCols > 0 && displayRows > 0 && group.chips.length < fullSlotCount) {
            const geometry = this._getShotGridGeometry?.();
            const cellSize = geometry?.referenceCellSize || this._getMedianChipRectSize(this.chips) || this._getMedianChipRectSize(group.chips);
            const originsX = [];
            const originsY = [];
            if (cellSize) {
                group.chips.forEach((chip) => {
                    const rect = chip?.rect;
                    const center = this._getChipScreenCenter(chip);
                    const slot = this._getShotGridSlotInfo(chip, displayShape || { cols: displayCols, rows: displayRows });
                    if (!rect || !center || !slot) return;
                    originsX.push(center.x - (slot.slotX + 0.5) * cellSize.width);
                    originsY.push(center.y - (slot.slotY + 0.5) * cellSize.height);
                });
            }
            const originX = this._medianNumber(originsX);
            const originY = this._medianNumber(originsY);
            if (cellSize && Number.isFinite(originX) && Number.isFinite(originY)) {
                const nominal = {
                    minX: originX,
                    minY: originY,
                    maxX: originX + displayCols * cellSize.width,
                    maxY: originY + displayRows * cellSize.height,
                    width: displayCols * cellSize.width,
                    height: displayRows * cellSize.height,
                };
                const eps = Math.max(1, Math.min(cellSize.width, cellSize.height) * 0.2);
                if (nominal.minX <= minX + eps && nominal.minY <= minY + eps &&
                    nominal.maxX >= maxX - eps && nominal.maxY >= maxY - eps &&
                    nominal.width > 0 && nominal.height > 0) {
                    boundary = nominal;
                }
            }
        }
        if (cacheKey) this._shotBoundaryCache.set(cacheKey, boundary);
        return boundary;
    }

    _medianNumber(values) {
        const finite = (Array.isArray(values) ? values : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
        if (!finite.length) return null;
        const mid = Math.floor(finite.length / 2);
        return finite.length % 2 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2;
    }

    _getMedianChipRectSize(sourceChips = this.chips) {
        const chips = Array.isArray(sourceChips) ? sourceChips : [];
        if (chips === this.chips && this._shotMedianCellSize) return this._shotMedianCellSize;
        const widths = [];
        const heights = [];
        chips.forEach((chip) => {
            const rect = chip?.rect;
            if (!rect) return;
            const width = Number(rect.x1) - Number(rect.x0);
            const height = Number(rect.y1) - Number(rect.y0);
            if (Number.isFinite(width) && width > 0) widths.push(width);
            if (Number.isFinite(height) && height > 0) heights.push(height);
        });
        const size = widths.length && heights.length
            ? { width: this._medianNumber(widths), height: this._medianNumber(heights) }
            : null;
        if (chips === this.chips) this._shotMedianCellSize = size;
        return size;
    }

    _getLayoutCanvasPhysicalTransform() {
        const samples = (this.chips || []).map((chip) => {
            const layout = this.getLayoutRowForChip(chip);
            const rect = chip?.rect;
            if (!layout || !rect) return null;
            const xMm = Number(layout.chip_center_x_pos);
            const yMm = Number(layout.chip_center_y_pos);
            const xPx = (Number(rect.x0) + Number(rect.x1)) / 2;
            const yPx = (Number(rect.y0) + Number(rect.y1)) / 2;
            return [xMm, yMm, xPx, yPx].every(Number.isFinite) ? { xMm, yMm, xPx, yPx } : null;
        }).filter(Boolean);
        if (samples.length < 2) return null;

        const fit = (valueKey, pixelKey) => {
            const valueMean = samples.reduce((sum, sample) => sum + sample[valueKey], 0) / samples.length;
            const pixelMean = samples.reduce((sum, sample) => sum + sample[pixelKey], 0) / samples.length;
            let variance = 0;
            let covariance = 0;
            samples.forEach((sample) => {
                const valueDelta = sample[valueKey] - valueMean;
                variance += valueDelta * valueDelta;
                covariance += valueDelta * (sample[pixelKey] - pixelMean);
            });
            if (variance <= 0) return null;
            const scale = covariance / variance;
            return { scale, offset: pixelMean - scale * valueMean };
        };
        const x = fit('xMm', 'xPx');
        const y = fit('yMm', 'yPx');
        return x && y ? { x, y } : null;
    }

    _renderShotBoundaries() {
        if (!this.shotBoundaryVisible || this.viewer?.gridMode === true) return;
        const startedAt = performance.now();
        if (this.shotBoundaryGroups.size === 0) {
            if (this._shotBoundaryLogNextRender) {
                this._logShotBoundary('render deferred', {
                    processId: this.layoutProcessId,
                    chips: Array.isArray(this.chips) ? this.chips.length : 0,
                    groups: 0,
                });
                this._shotBoundaryLogNextRender = false;
            }
            return;
        }

        const transform = this.viewer.transform;
        const Y_OFFSET = this.Y_OFFSET || 0;
        const ctx = this.ctx;
        ctx.save();
        ctx.resetTransform();
        ctx.strokeStyle = this.shotBoundaryColor;
        ctx.lineWidth = 0.75;
        ctx.setLineDash([3, 3]);

        let drawn = 0;
        this.shotBoundaryGroups.forEach((group) => {
            const boundary = this._getShotBoundaryRect(group);
            if (!boundary) return;

            const x = boundary.minX * transform.scale + transform.dx;
            const y = boundary.minY * transform.scale + transform.dy + Y_OFFSET;
            const width = boundary.width * transform.scale;
            const height = boundary.height * transform.scale;
            ctx.strokeRect(x, y, width, height);
            drawn += 1;
        });

        ctx.restore();
        const elapsedMs = performance.now() - startedAt;
        if (this._shotBoundaryLogNextRender || elapsedMs > 50) {
            this._logShotBoundary('render boundaries', {
                processId: this.layoutProcessId,
                groups: this.shotBoundaryGroups.size,
                drawn,
                cacheSize: this._shotBoundaryCache.size,
                elapsedMs: Math.round(elapsedMs * 10) / 10,
            });
            this._shotBoundaryLogNextRender = false;
        }
    }

    _renderHoveredShotBoundary() {
        if (this.selectionMode !== 'shot' || !this.hoveredChip || this.viewer?.gridMode === true) return;

        const boundary = this._getShotBoundaryRect(this._getShotGroupForChip(this.hoveredChip));
        if (!boundary) return;

        const transform = this.viewer.transform;
        const Y_OFFSET = this.Y_OFFSET || 0;
        const ctx = this.ctx;
        const x = boundary.minX * transform.scale + transform.dx;
        const y = boundary.minY * transform.scale + transform.dy + Y_OFFSET;
        const width = boundary.width * transform.scale;
        const height = boundary.height * transform.scale;

        ctx.save();
        ctx.resetTransform();
        ctx.strokeStyle = this.hoverColor.replace(/[\d.]+\)$/, '0.95)');
        ctx.lineWidth = Math.max(2.5, 3 * transform.scale);
        ctx.setLineDash([]);
        ctx.strokeRect(x, y, width, height);
        ctx.restore();
    }

    _renderSelectedShotBoundaries() {
        if (this.selectionMode !== 'shot' || this.viewer?.gridMode === true) return;

        const groups = this._getSelectedShotGroups();
        if (groups.size === 0) return;

        const transform = this.viewer.transform;
        const Y_OFFSET = this.Y_OFFSET || 0;
        const ctx = this.ctx;
        ctx.save();
        ctx.resetTransform();
        ctx.strokeStyle = this.selectedColor.replace(/[\d.]+\)$/, '0.95)');
        ctx.lineWidth = Math.max(3, 4 * transform.scale);
        ctx.setLineDash([]);

        groups.forEach((group) => {
            const boundary = this._getShotBoundaryRect(group);
            if (!boundary) return;
            const x = boundary.minX * transform.scale + transform.dx;
            const y = boundary.minY * transform.scale + transform.dy + Y_OFFSET;
            const width = boundary.width * transform.scale;
            const height = boundary.height * transform.scale;
            ctx.strokeRect(x, y, width, height);
        });

        ctx.restore();
    }

    _renderSelectedShotAreas() {
        if (this.selectionMode !== 'shot' || this.viewer?.gridMode === true) return;

        const groups = this._getSelectedShotGroups();
        if (groups.size === 0) return;

        const transform = this.viewer.transform;
        const Y_OFFSET = this.Y_OFFSET || 0;
        const ctx = this.ctx;
        ctx.save();
        ctx.resetTransform();
        ctx.fillStyle = this.selectedColor;

        groups.forEach((group) => {
            const boundary = this._getShotBoundaryRect(group);
            if (!boundary) return;
            const x = boundary.minX * transform.scale + transform.dx;
            const y = boundary.minY * transform.scale + transform.dy + Y_OFFSET;
            const width = boundary.width * transform.scale;
            const height = boundary.height * transform.scale;
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, width, height);
            ctx.clip();

            const selectedIndices = this._filterSelectableIndices(group.indices || []);
            selectedIndices.forEach((index) => {
                const chip = this.chips[index];
                const rect = chip?.rect;
                if (!rect) return;
                ctx.fillRect(
                    rect.x0 * transform.scale + transform.dx,
                    rect.y0 * transform.scale + transform.dy + Y_OFFSET,
                    (rect.x1 - rect.x0) * transform.scale,
                    (rect.y1 - rect.y0) * transform.scale,
                );
            });
            ctx.restore();
        });

        ctx.restore();
    }

    getLayoutRowForChip(chip) {
        const x = Number(chip?.x_abs);
        const y = Number(chip?.y_abs);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        return this.layoutByChip.get(`${x}:${y}`) || null;
    }

    getSelectedShotGroupSelections() {
        if (this.selectionMode !== 'shot') return [];
        return [...this._getSelectedShotGroups()].map((group) => {
            const selectedIndices = this._filterSelectableIndices(group.indices || []);
            return {
                ...group,
                selectedIndices,
                selectedChips: selectedIndices.map((index) => this.chips[index]).filter(Boolean),
            };
        }).filter((group) => group.selectedChips.length > 0);
    }

    _getShotGridSlotInfo(chip, shape = this.getShotGridShape?.()) {
        const rawSlot = this._getShotCanonicalRawSlot(chip, this.getShotCompositeGridShape?.() || shape);
        const geometry = this._getShotGridGeometry?.();
        if (rawSlot && geometry) {
            return this._toDisplayShotSlot(rawSlot.slotX, rawSlot.slotY, geometry);
        }
        return rawSlot;
    }

    _getShotCanonicalRawSlot(chip, shape = this.getShotCompositeGridShape?.()) {
        const layout = this.getLayoutRowForChip(chip);
        const x = Number.isFinite(Number(layout?.chip_x_pos)) ? Number(layout.chip_x_pos) : Number(chip?.x_abs);
        const y = Number.isFinite(Number(layout?.chip_y_pos)) ? Number(layout.chip_y_pos) : Number(chip?.y_abs);
        const cols = Math.max(1, Number(shape?.cols) || 4);
        const rows = Math.max(1, Number(shape?.rows) || 6);
        if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
        const geometry = this._getShotGridGeometry?.();
        const gridCols = Math.max(1, Number(geometry?.gridShape?.cols) || cols);
        const gridRows = Math.max(1, Number(geometry?.gridShape?.rows) || rows);
        const originX = Number.isFinite(Number(geometry?.slotOriginX)) ? Number(geometry.slotOriginX) : 0;
        const originY = Number.isFinite(Number(geometry?.slotOriginY)) ? Number(geometry.slotOriginY) : 0;
        const positiveModulo = (value, size) => ((value % size) + size) % size;
        return {
            slotX: positiveModulo(x - originX, gridCols),
            slotY: positiveModulo(y - originY, gridRows),
            cols: gridCols,
            rows: gridRows,
        };
    }

    _getShotRawGridSlotInfo(chip, shape = this.getShotCompositeGridShape?.()) {
        return this._getShotCanonicalRawSlot(chip, shape);
    }

    _getShotGridSlot(chip, shape = this.getShotGridShape?.()) {
        const slot = this._getShotGridSlotInfo(chip, shape);
        return slot ? `${slot.slotX}:${slot.slotY}` : null;
    }

    getShotPositionForChip(chip, shape = this.getShotGridShape?.()) {
        const cols = Math.max(1, Number(shape?.cols) || 4);
        const rows = Math.max(1, Number(shape?.rows) || 6);
        const slot = String(this._getShotGridSlot(chip, { cols, rows }) || '');
        const [slotX, slotY] = slot.split(':').map(Number);
        if (!Number.isInteger(slotX) || !Number.isInteger(slotY) ||
            slotX < 0 || slotX >= cols || slotY < 0 || slotY >= rows) {
            return null;
        }
        return (rows - slotY - 1) * cols + slotX;
    }

    setShotChipSelections(chipIndices, selected = null) {
        const indices = [...new Set((Array.isArray(chipIndices) ? chipIndices : [chipIndices])
            .map(Number)
            .filter((index) => Number.isInteger(index) && index >= 0 && index < this.chips.length))];
        const index = indices[0];
        if (!Number.isInteger(index)) return null;
        const group = this._getShotGroupForChip(this.chips[index]);
        if (!group) return null;

        this.selectionMode = 'shot';
        const selectedGroups = [...this._getSelectedShotGroups()];
        const groups = selectedGroups.length ? selectedGroups : [...this.shotBoundaryGroups.values()];
        const shape = this.getShotGridShape?.() || { cols: 4, rows: 6 };
        const affectedIndices = new Set();
        indices.forEach((referenceIndex) => {
            const slot = this._getShotGridSlot(this.chips[referenceIndex], shape);
            groups.forEach((candidate) => {
                (candidate.indices || []).forEach((candidateIndex) => {
                    if (slot && this._getShotGridSlot(this.chips[candidateIndex], shape) === slot) {
                        affectedIndices.add(candidateIndex);
                    }
                });
            });
        });
        if (affectedIndices.size === 0) affectedIndices.add(index);
        const selectableAffected = this._filterSelectableIndices(Array.from(affectedIndices));
        affectedIndices.clear();
        selectableAffected.forEach((affectedIndex) => affectedIndices.add(affectedIndex));
        if (affectedIndices.size === 0) return null;

        const currentlySelected = [...affectedIndices].every((affectedIndex) => this.selectedChips.has(affectedIndex));
        const nextSelected = typeof selected === 'boolean' ? selected : !currentlySelected;
        affectedIndices.forEach((affectedIndex) => {
            if (nextSelected) {
                this.selectedChips.add(affectedIndex);
                if (!this.selectedChipsOrder.includes(affectedIndex)) this.selectedChipsOrder.push(affectedIndex);
            } else {
                this.selectedChips.delete(affectedIndex);
                const orderIndex = this.selectedChipsOrder.indexOf(affectedIndex);
                if (orderIndex !== -1) this.selectedChipsOrder.splice(orderIndex, 1);
            }
        });
        this.render();
        this.updateSelectedChipsList();
        return {
            chipIndex: index,
            selected: nextSelected,
            selectedCount: this.selectedChips.size,
            shotId: group.shotId,
            affectedShotIds: groups.map((candidate) => String(candidate.shotId)),
            affectedChipCount: affectedIndices.size,
        };
    }

    toggleShotChipSelection(chipIndex) {
        return this.setShotChipSelections([chipIndex]);
    }

    formatLayoutPair(x, y) {
        const values = [Number(x), Number(y)];
        if (!values.every(Number.isFinite)) return '-';
        return `${values[0].toFixed(1)}, ${values[1].toFixed(1)}`;
    }

    formatGridPair(x, y) {
        const values = [Number(x), Number(y)];
        if (!values.every(Number.isInteger)) return '-';
        return `(${values[0]}, ${values[1]})`;
    }

    formatLayoutRadius(x, y) {
        const values = [Number(x), Number(y)];
        if (!values.every(Number.isFinite)) return '-';
        return Math.hypot(values[0], values[1]).toFixed(1);
    }

    formatShotOrder(x, y) {
        const values = [Number(x), Number(y)];
        if (!values.every(Number.isFinite)) return '-';
        const formatValue = (value) => Number.isInteger(value)
            ? String(value)
            : value.toFixed(2);
        return `(${formatValue(values[0])}, ${formatValue(values[1])})`;
    }

    _getSelectedShotScopeIndices() {
        const scope = new Set();
        if (this.selectionMode !== 'shot' || this.selectedChips.size === 0) return scope;
        this._getSelectedShotGroups().forEach((group) => {
            (group.indices || []).forEach((index) => scope.add(index));
        });
        return scope;
    }

    selectByCoordinateRows(target, rows, options = {}) {
        const operation = ['add', 'remove'].includes(options.operation) ? options.operation : 'replace';
        const inputRows = Array.isArray(rows) ? rows : [];
        const matchedIndices = new Set();
        const matchedRows = [];
        const unmatchedRows = [];
        const shotScope = this._getSelectedShotScopeIndices();
        const restrictToSelectedShots = shotScope.size > 0;
        const normalizeId = (value) => String(value ?? '').trim().toLowerCase();
        const near = (left, right, tolerance = 0.0001) => Number.isFinite(left) &&
            Number.isFinite(right) && Math.abs(left - right) <= tolerance;

        inputRows.forEach((row, rowIndex) => {
            const rowMatches = [];
            this.chips.forEach((chip, chipIndex) => {
                if (!chip) return;
                if (!this.isChipSelectable(chip)) return;
                const layout = this.getLayoutRowForChip(chip);
                const hasCoordinate = row?.x !== undefined && row?.y !== undefined;
                const hasChipId = row?.value !== undefined && String(row.value).trim() !== '';
                let coordinateMatched = !hasCoordinate;
                if (hasCoordinate && target === 'shot-grid') {
                    coordinateMatched = Number(layout?.shot_x_pos) === Number(row.x) &&
                        Number(layout?.shot_y_pos) === Number(row.y);
                } else if (target === 'chip-grid') {
                    coordinateMatched = Number(chip?.x_abs) === Number(row.x) &&
                        Number(chip?.y_abs) === Number(row.y);
                } else if (target === 'chip-pos') {
                    const x = Number(layout?.chip_center_x_pos);
                    const y = Number(layout?.chip_center_y_pos);
                    // Chip(Pos) is displayed at one decimal; accept both that display value
                    // and more precise pasted mm coordinates without crossing chip pitch.
                    coordinateMatched = near(Number(row.x), x, 0.051) && near(Number(row.y), y, 0.051);
                }
                const chipId = layout?.chip_id ?? chip?.chip_id;
                const shotPosition = this.getShotPositionForChip(chip);
                const valueMatched = !hasChipId || (target === 'shot-position'
                    ? Number.isInteger(Number(row.value)) && shotPosition === Number(row.value)
                    : normalizeId(chipId) === normalizeId(row.value));
                const isScopedShotValue = hasChipId && !hasCoordinate && restrictToSelectedShots;
                if (isScopedShotValue && !shotScope.has(chipIndex)) return;
                if (coordinateMatched && valueMatched) rowMatches.push(chipIndex);
            });
            if (rowMatches.length > 0) {
                matchedRows.push(rowIndex);
                rowMatches.forEach((index) => matchedIndices.add(index));
            } else {
                unmatchedRows.push(rowIndex);
            }
        });

        const nextSelection = operation === 'replace'
            ? new Set()
            : new Set(this.selectedChips);
        if (operation === 'remove') {
            matchedIndices.forEach((index) => nextSelection.delete(index));
        } else {
            matchedIndices.forEach((index) => nextSelection.add(index));
        }

        const preserveShotMode = target === 'shot-grid' || (restrictToSelectedShots && inputRows.some((row) => row?.value !== undefined));
        this.selectionMode = preserveShotMode ? 'shot' : 'chip';
        this.selectedChips = nextSelection;
        const previousOrder = Array.isArray(this.selectedChipsOrder) ? this.selectedChipsOrder : [];
        const orderedMatches = Array.from(matchedIndices);
        this.selectedChipsOrder = operation === 'replace'
            ? orderedMatches.filter((index) => nextSelection.has(index))
            : [
                ...previousOrder.filter((index) => nextSelection.has(index)),
                ...orderedMatches.filter((index) => nextSelection.has(index) && !previousOrder.includes(index)),
            ];
        this.render();
        this.updateSelectedChipsList();
        return {
            selectedCount: nextSelection.size,
            selectedShotCount: this.selectionMode === 'shot' ? this._getSelectedShotGroups().size : 0,
            matchedRows: matchedRows.length,
            unmatchedRows,
            matchedIndices: Array.from(matchedIndices),
            restrictedToSelectedShots: restrictToSelectedShots,
        };
    }

    selectByCoordinateRange(target, range, options = {}) {
        const operation = ['add', 'remove'].includes(options.operation) ? options.operation : 'replace';
        const finite = (value) => Number.isFinite(Number(value));
        const xMin = Number(range?.xMin);
        const xMax = Number(range?.xMax);
        const yMin = Number(range?.yMin);
        const yMax = Number(range?.yMax);
        const hasY = target !== 'chip-id' && target !== 'radius' && finite(yMin) && finite(yMax);
        const matchedIndices = new Set();
        this.chips.forEach((chip, chipIndex) => {
            if (!chip) return;
            if (!this.isChipSelectable(chip)) return;
            const layout = this.getLayoutRowForChip(chip);
            let x = NaN;
            let y = NaN;
            if (target === 'shot-grid') {
                x = Number(layout?.shot_x_pos);
                y = Number(layout?.shot_y_pos);
            } else if (target === 'chip-grid') {
                x = Number(chip?.x_abs);
                y = Number(chip?.y_abs);
            } else if (target === 'chip-pos') {
                x = Number(layout?.chip_center_x_pos);
                y = Number(layout?.chip_center_y_pos);
            } else if (target === 'chip-id') {
                x = Number(layout?.chip_id ?? chip?.chip_id);
            } else if (target === 'shot-position') {
                x = Number(this.getShotPositionForChip(chip));
            } else if (target === 'radius') {
                const centerX = Number(layout?.chip_center_x_pos);
                const centerY = Number(layout?.chip_center_y_pos);
                x = Number.isFinite(centerX) && Number.isFinite(centerY)
                    ? Math.hypot(centerX, centerY)
                    : NaN;
            }
            if (!finite(x) || !finite(xMin) || !finite(xMax) || x < xMin || x > xMax) return;
            if (hasY && (!finite(y) || y < yMin || y > yMax)) return;
            matchedIndices.add(chipIndex);
        });

        const nextSelection = operation === 'replace'
            ? new Set()
            : new Set(this.selectedChips);
        if (operation === 'remove') {
            matchedIndices.forEach((index) => nextSelection.delete(index));
        } else {
            matchedIndices.forEach((index) => nextSelection.add(index));
        }
        this.selectionMode = target === 'shot-grid' ? 'shot' : 'chip';
        this.selectedChips = nextSelection;
        const previousOrder = Array.isArray(this.selectedChipsOrder) ? this.selectedChipsOrder : [];
        const orderedMatches = Array.from(matchedIndices);
        this.selectedChipsOrder = operation === 'replace'
            ? orderedMatches.filter((index) => nextSelection.has(index))
            : [
                ...previousOrder.filter((index) => nextSelection.has(index)),
                ...orderedMatches.filter((index) => nextSelection.has(index) && !previousOrder.includes(index)),
            ];
        this.render();
        this.updateSelectedChipsList();
        return {
            selectedCount: nextSelection.size,
            selectedShotCount: this.selectionMode === 'shot' ? this._getSelectedShotGroups().size : 0,
            matchedCount: matchedIndices.size,
        };
    }

    selectByCoordinateConstraints(filters = {}, options = {}) {
        const operation = ['add', 'remove'].includes(options.operation) ? options.operation : 'replace';
        const chipRange = filters?.chipRange?.enabled ? filters.chipRange : null;
        const chipRangeTarget = filters?.chipRangeTarget || chipRange?.target || 'chip-grid';
        const radiusRange = filters?.radiusRange?.enabled ? filters.radiusRange : null;
        const finite = (value) => Number.isFinite(Number(value));
        const inRange = (value, min, max) => finite(value) && finite(min) && finite(max) &&
            Number(value) >= Number(min) && Number(value) <= Number(max);
        const matchedIndices = new Set();

        this.chips.forEach((chip, chipIndex) => {
            if (!chip) return;
            if (!this.isChipSelectable(chip)) return;
            const layout = chipRangeTarget === 'chip-pos' || radiusRange
                ? this.getLayoutRowForChip(chip)
                : null;
            if (chipRange) {
                let chipX = Number(chip.x_abs);
                let chipY = Number(chip.y_abs);
                if (chipRangeTarget === 'chip-pos') {
                    chipX = Number(layout?.chip_center_x_pos);
                    chipY = Number(layout?.chip_center_y_pos);
                }
                if (!inRange(chipX, chipRange.xMin, chipRange.xMax) ||
                    !inRange(chipY, chipRange.yMin, chipRange.yMax)) {
                    return;
                }
            }
            if (radiusRange) {
                const centerX = Number(layout?.chip_center_x_pos);
                const centerY = Number(layout?.chip_center_y_pos);
                if (!inRange(Math.hypot(centerX, centerY), radiusRange.xMin, radiusRange.xMax)) return;
            }
            matchedIndices.add(chipIndex);
        });

        const nextSelection = operation === 'replace'
            ? new Set()
            : new Set(this.selectedChips);
        if (operation === 'remove') {
            matchedIndices.forEach((index) => nextSelection.delete(index));
        } else {
            matchedIndices.forEach((index) => nextSelection.add(index));
        }
        this.selectionMode = 'chip';
        this.selectedChips = nextSelection;
        const previousOrder = Array.isArray(this.selectedChipsOrder) ? this.selectedChipsOrder : [];
        const orderedMatches = Array.from(matchedIndices);
        this.selectedChipsOrder = operation === 'replace'
            ? orderedMatches.filter((index) => nextSelection.has(index))
            : [
                ...previousOrder.filter((index) => nextSelection.has(index)),
                ...orderedMatches.filter((index) => nextSelection.has(index) && !previousOrder.includes(index)),
            ];
        this.render();
        this.updateSelectedChipsList();
        return {
            selectedCount: nextSelection.size,
            selectedShotCount: 0,
            matchedCount: matchedIndices.size,
        };
    }

    _resetLayoutCoordinateDisplay() {
        for (const element of [this.coordRadious, this.coordShot]) {
            if (element) element.textContent = '-';
        }
    }

    _resetChipCoordinateDisplay() {
        if (this.coordChipCoord) this.coordChipCoord.textContent = '-';
        if (this.coordChipRel) this.coordChipRel.textContent = '-';
        this._resetLayoutCoordinateDisplay();
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
            this.tm = null;
            this.lt = null;
            this.netd = null;
            this.gd = null;
            this.yield = null;
            this.sys = null;
            // 캐시 히트 확인
            const cacheKey = imagePath;
            if (_positionsCache.has(cacheKey)) {
                this.positionsData = _positionsCache.get(cacheKey);
            } else {
                const response = await fetch(`/api/chip-positions?path=${encodeURIComponent(imagePath)}&include_fq=0&include_grade=1`);
                if (!response.ok) {
                    console.log('No positions found for:', imagePath);
                    this.positionsData = null;
                    this.chips = [];
                    this.chipIndexMap.clear();
                    this._spatialGrid = null;
                    this.shotBoundaryGroups.clear();
                    this._invalidateShotGeometry();
                    this._notifyLegendUpdate([]);
                    return false;
                }
                this.positionsData = await response.json();
                // LRU 캐시: 최대 50개
                if (_positionsCache.size >= _POSITIONS_CACHE_MAX) {
                    const oldest = _positionsCache.keys().next().value;
                    _positionsCache.delete(oldest);
                }
                _positionsCache.set(cacheKey, this.positionsData);
            }
            this.chips = this._dedupeChipsByGrid(this.positionsData.chips || []);
            if (this.positionsData) this.positionsData.chips = this.chips;
            this._invalidateShotGeometry();
            if (this.layoutByChip.size > 0) this._buildShotBoundaryGroups();
            if (this.shotBoundaryVisible) this._renderShotBoundaries();
            this._buildChipIndexMap();
            this._buildSpatialGrid();

            this.partId = this._extractMetadataValue(['partid', 'part_id', 'partId', 'PartID']);
            this.device = this._extractMetadataValue(['device', 'devcie', 'Device']);
            this.pgm = this._extractMetadataValue(['pgm', 'PGM', 'pgm_name']);
            this.tm = this._extractMetadataValue(['tm', 'TM', 'test_mode']);
            this.lt = this._extractMetadataValue(['lt', 'LT', 'lot_type']);
            this.netd = this._extractMetadataValue(['netd', 'NETD', 'net_die', 'netdie']);
            this.gd = this._extractMetadataValue(['gd', 'GD', 'gross_die', 'grossdie']);
            this.yield = this._extractMetadataValue(['yield', 'YIELD', 'yld']);
            this.sys = this._extractMetadataValue(['sys', 'SYS', 'system']);

            console.log(`✅ Loaded ${this.chips.length} chip positions`, {
                partId: this.partId,
                device: this.device,
                pgm: this.pgm,
                tm: this.tm, lt: this.lt, netd: this.netd,
                gd: this.gd, yield: this.yield, sys: this.sys
            });

            this._updateMetadataDisplay();

            // Load existing annotations
            await this.loadAnnotations(imagePath);

            // 🎨 positions 로드 후 즉시 렌더링 (hover, grid 등 표시)
            // 오버레이 모드 재적용은 main.js의 _reapplyOverlayAfterPositionsLoad()에서 처리
            this.render();

            return true;
        } catch (error) {
            console.error('Error loading chip positions:', error);
            this.positionsData = null;
            this.chips = [];
            this.chipIndexMap.clear();
            this.shotBoundaryGroups.clear();
            this._invalidateShotGeometry();
            this._notifyLegendUpdate([]);
            this.partId = null;
            this.device = null;
            this.pgm = null;
            this.tm = null;
            this.lt = null;
            this.netd = null;
            this.gd = null;
            this.yield = null;
            this.sys = null;
            this._updateMetadataDisplay();
            return false;
        }
    }

    /**
     * Ensure F/Q data is loaded for current positions.
     * Called lazily when Measure overlay is first activated.
     * If already loaded (chips have .f/.q), returns immediately.
     */
    async ensureFqData(imagePath) {
        imagePath = imagePath || this.currentImagePath;
        if (!imagePath || !this.positionsData) return false;
        // Already has F/Q data?
        const firstChip = this.chips?.[0];
        if (firstChip && (firstChip.f !== undefined || firstChip.q !== undefined)) {
            return true;
        }
        try {
            const response = await fetch(
                `/api/chip-positions?path=${encodeURIComponent(imagePath)}&include_fq=1`
            );
            if (!response.ok) return false;
            const fullData = await response.json();
            const fullChips = fullData.chips || [];
            // Merge F/Q arrays into existing chips
            for (let i = 0; i < this.chips.length && i < fullChips.length; i++) {
                if (fullChips[i].f !== undefined) this.chips[i].f = fullChips[i].f;
                if (fullChips[i].q !== undefined) this.chips[i].q = fullChips[i].q;
            }
            // Update cache
            _positionsCache.set(imagePath, this.positionsData);
            console.log(`✅ F/Q data loaded: ${fullChips.length} chips`);
            return true;
        } catch (error) {
            console.error('Error loading F/Q data:', error);
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
        this.updateSelectedChipsList({ notifyViewer: false });
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
        this.updateSelectedChipsList({ notifyViewer: false });
    }

    /**
     * Normalize a chip's b-value to match the canonical bottomFilterSet format.
     * Mirrors Python's _classify_chip_bottom_value logic.
     * - null/undefined/""  → "Normal"
     * - "normal"/"nor"/"border" (case-insensitive) → "Normal"
     * - "invalid"/"inv"   → "Invalid"
     * - "B285"/285        → "285"
     */
    _normalizeBottomValue(b) {
        if (b === null || b === undefined) return 'Normal';
        const str = String(b).trim();
        if (!str) return 'Normal';
        const lower = str.toLowerCase();
        if (lower === 'normal' || lower === 'nor' || lower === 'border') return 'Normal';
        if (lower === 'invalid' || lower === 'inv') return 'Invalid';
        // Known BIN set
        const KNOWN_BINS = new Set([285, 286, 287, 288, 290, 291, 300, 385, 386, 388, 389, 390]);
        let num = NaN;
        if (lower.startsWith('b') && /^\d+$/.test(lower.slice(1))) {
            num = parseInt(lower.slice(1), 10);
        } else if (/^\d+$/.test(str)) {
            num = parseInt(str, 10);
        }
        if (!isNaN(num)) {
            if (num < 200) return 'Normal';
            if (num < 280) return 'Invalid';
            return KNOWN_BINS.has(num) ? String(num) : 'ETC';
        }
        return str;
    }

    _normalizeSystematicBinValue(b) {
        if (b === null || b === undefined) return 'Normal';
        const str = String(b).trim();
        if (!str) return 'Normal';
        const lower = str.toLowerCase();
        if (lower === 'normal' || lower === 'nor' || lower === 'border') return 'Normal';
        if (lower === 'invalid' || lower === 'inv') return 'Invalid';
        const match = lower.match(/^b?(\d+)$/);
        if (match) {
            const num = Number(match[1]);
            if (num < 200) return 'Normal';
            if (num < 280) return 'Invalid';
            return String(num);
        }
        return str;
    }

    _matchesBottomFilter(chip) {
        if (!this.bottomFilterSet || this.bottomFilterSet.size === 0) return true;
        const normalized = this._normalizeBottomValue(chip?.b);
        if (this.bottomFilterSet.has(normalized)) return true;
        return this.bottomFilterSet.has('SYSTEMATIC') && SYSTEMATIC_FILTER_BINS.has(normalized);
    }

    _getChipGradeIndex(chip) {
        const candidates = [
            chip?.palette_index,
            chip?.paletteIndex,
            chip?.grade,
            chip?.grade_index,
            chip?.gradeIndex,
        ];
        for (const value of candidates) {
            const number = Number(value);
            if (Number.isInteger(number) && number >= 0 && number <= 7) return number;
        }
        return null;
    }

    _matchesGradeFilter(chip) {
        if (!this.gradeFilterSet || this.gradeFilterSet.size === 0) return true;
        const gradeIndex = this._getChipGradeIndex(chip);
        return gradeIndex !== null && this.gradeFilterSet.has(gradeIndex);
    }

    isChipSelectable(chip) {
        return !!chip && this._matchesBottomFilter(chip) && this._matchesGradeFilter(chip);
    }

    _filterSelectableIndices(indices) {
        return [...new Set(Array.isArray(indices) ? indices : [])]
            .map(Number)
            .filter((index) => Number.isInteger(index) && index >= 0 && index < this.chips.length)
            .filter((index) => this.isChipSelectable(this.chips[index]));
    }

    _pruneSelectionToSelectable() {
        if (!this.selectedChips || this.selectedChips.size === 0) return false;
        const before = this.selectedChips.size;
        this.selectedChips = new Set(this._filterSelectableIndices(Array.from(this.selectedChips)));
        this.selectedChipsOrder = (this.selectedChipsOrder || []).filter((index) => this.selectedChips.has(index));
        if (this.selectedChipsOrder.length === 0 && this.selectedChips.size > 0) {
            this.selectedChipsOrder = Array.from(this.selectedChips);
        }
        return this.selectedChips.size !== before;
    }

    _getChipYieldNumber(chip) {
        const candidates = [chip?.yld, chip?.yield, chip?.YLD, chip?.YIELD];
        for (const value of candidates) {
            if (value === null || value === undefined || String(value).trim() === '') continue;
            const number = Number(value);
            if (Number.isFinite(number)) return number;
        }
        return null;
    }

    _isGoodChipByBin(chip) {
        const normalized = this._normalizeSystematicBinValue(chip?.b);
        if (normalized === 'Normal') return true;
        if (normalized === 'Invalid') return false;
        const number = Number(normalized);
        if (Number.isFinite(number)) return number < 200;
        return null;
    }

    getSelectionYieldSummary(chips = null) {
        const selectedChips = Array.isArray(chips)
            ? chips.filter(Boolean)
            : Array.from(this.selectedChips || [])
                .map((index) => this.chips?.[index])
                .filter(Boolean);
        const explicitYieldValues = selectedChips
            .map((chip) => this._getChipYieldNumber(chip))
            .filter((value) => value !== null);
        let tested = 0;
        let good = 0;
        selectedChips.forEach((chip) => {
            const isGood = this._isGoodChipByBin(chip);
            if (isGood === null) return;
            tested += 1;
            if (isGood) good += 1;
        });
        const binYield = tested > 0 ? (good / tested) * 100 : null;
        const explicitAvgYield = explicitYieldValues.length > 0
            ? explicitYieldValues.reduce((sum, value) => sum + value, 0) / explicitYieldValues.length
            : null;
        return {
            chipCount: selectedChips.length,
            testedCount: tested,
            goodCount: good,
            badCount: tested > 0 ? tested - good : 0,
            avgYield: explicitAvgYield !== null ? explicitAvgYield : binYield,
            avgYieldSource: explicitAvgYield !== null ? 'chip_yld' : (binYield !== null ? 'bin' : 'none'),
            explicitYieldCount: explicitYieldValues.length,
        };
    }

    formatSelectionYieldSummary(summary = this.getSelectionYieldSummary()) {
        const count = Number(summary?.chipCount) || 0;
        if (count <= 0) return 'Yld - · G 0/B 0';
        const yieldText = Number.isFinite(Number(summary?.avgYield))
            ? `${Number(summary.avgYield).toFixed(3)}%`
            : '-';
        const good = Number.isFinite(Number(summary?.goodCount)) ? Number(summary.goodCount) : 0;
        const bad = Number.isFinite(Number(summary?.badCount)) ? Number(summary.badCount) : 0;
        const source = summary?.avgYieldSource === 'chip_yld' ? 'avg' : 'bin';
        return `Yld ${yieldText} · G ${good}/B ${bad} · ${source}`;
    }

    _getSelectionChipObjects(chips = null) {
        return Array.isArray(chips)
            ? chips.filter(Boolean)
            : Array.from(this.selectedChips || [])
                .map((index) => this.chips?.[index])
                .filter(Boolean);
    }

    _formatYieldSummaryShort(summary) {
        const yieldText = Number.isFinite(Number(summary?.avgYield))
            ? `${Number(summary.avgYield).toFixed(3)}%`
            : '-';
        const good = Number.isFinite(Number(summary?.goodCount)) ? Number(summary.goodCount) : 0;
        const bad = Number.isFinite(Number(summary?.badCount)) ? Number(summary.badCount) : 0;
        return `${yieldText} G${good}/B${bad}`;
    }

    getSelectionYieldBreakdowns(chips = null) {
        const selectedChips = this._getSelectionChipObjects(chips);
        const shotMap = new Map();
        const positionMap = new Map();

        selectedChips.forEach((chip) => {
            const layout = this.getLayoutRowForChip?.(chip);
            const shotX = Number(layout?.shot_x_pos);
            const shotY = Number(layout?.shot_y_pos);
            if (Number.isFinite(shotX) && Number.isFinite(shotY)) {
                const key = `${shotX}:${shotY}`;
                if (!shotMap.has(key)) {
                    shotMap.set(key, {
                        label: `(${shotX}, ${shotY})`,
                        sortX: shotX,
                        sortY: shotY,
                        chips: [],
                    });
                }
                shotMap.get(key).chips.push(chip);
            }

            const shotPosition = this.getShotPositionForChip?.(chip);
            if (Number.isInteger(shotPosition)) {
                const key = String(shotPosition);
                if (!positionMap.has(key)) {
                    positionMap.set(key, {
                        label: `P${shotPosition}`,
                        sortPosition: shotPosition,
                        chips: [],
                    });
                }
                positionMap.get(key).chips.push(chip);
            }
        });

        const withSummary = (group) => ({
            ...group,
            summary: this.getSelectionYieldSummary(group.chips),
        });
        const shotGroups = Array.from(shotMap.values())
            .sort((left, right) => left.sortY - right.sortY || left.sortX - right.sortX)
            .map(withSummary);
        const shotPositionGroups = Array.from(positionMap.values())
            .sort((left, right) => left.sortPosition - right.sortPosition)
            .map(withSummary);
        return { shotGroups, shotPositionGroups };
    }

    formatSelectionYieldBreakdownLine(groups, { label = 'Group', maxItems = 6 } = {}) {
        if (!Array.isArray(groups) || groups.length === 0) return `${label}: -`;
        const visible = groups.slice(0, maxItems).map((group) =>
            `${group.label} ${this._formatYieldSummaryShort(group.summary)}`
        );
        const more = groups.length > maxItems ? ` +${groups.length - maxItems}` : '';
        return `${label}: ${visible.join(' | ')}${more}`;
    }

    formatSelectionYieldBreakdownTitle(groups, label = 'Group') {
        if (!Array.isArray(groups) || groups.length === 0) return `${label}: -`;
        return `${label}:\n${groups.map((group) =>
            `${group.label} ${this._formatYieldSummaryShort(group.summary)} (${group.summary?.chipCount || 0} chips)`
        ).join('\n')}`;
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
        const selectionChanged = this._pruneSelectionToSelectable();
        this.render();
        if (selectionChanged) this.updateSelectedChipsList();
    }

    setGradeFilter(filterSet) {
        if (filterSet instanceof Set) {
            this.gradeFilterSet = new Set(Array.from(filterSet).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 7));
        } else if (Array.isArray(filterSet)) {
            this.gradeFilterSet = new Set(filterSet.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value <= 7));
        } else {
            this.gradeFilterSet.clear();
        }
        const selectionChanged = this._pruneSelectionToSelectable();
        this.render();
        if (selectionChanged) this.updateSelectedChipsList();
    }

    /**
     * Set overlay mode for chip rendering.
     * @param {'bin'|'f'|'q'|null} mode
     * @param {Object} options - { binColors?: Map, binFilter?: string[], binFilterColor?: string, gradientStops?: string[] }
     */
    setOverlayMode(mode, options = {}) {
        this.overlayMode = mode;

        if (mode === 'bin') {
            this.binOverlayColors = options.binColors || new Map();
            this.binOverlayFilterSet = new Set(
                (options.binFilter || []).map((value) => this._normalizeSystematicBinValue(value))
            );
            this.binOverlayFilterColor = options.binFilterColor || null;
            this.ratioOverlayColors = null;
            this.ratioPercentiles = null;
            this.gradientFilterSet.clear();
            this.overlayItemKey = null;
        } else if (mode === 'f' || mode === 'q') {
            this.binOverlayColors.clear();
            this.binOverlayFilterSet.clear();
            this.binOverlayFilterColor = null;
            this.gradientStops = options.gradientStops || null;
            this.overlayItemKey = options.itemKey || null;
            this._computeRatioOverlay(mode, this.overlayItemKey);
        } else {
            this.binOverlayColors.clear();
            this.binOverlayFilterSet.clear();
            this.binOverlayFilterColor = null;
            this.ratioOverlayColors = null;
            this.ratioPercentiles = null;
            this.gradientFilterSet.clear();
            this.gradientStops = null;
            this.overlayItemKey = null;
        }
        this.render();
    }

    /**
     * Compute percentile-based overlay colors for each chip's f or q value.
     */
    /**
     * Compute percentile-based overlay colors for each chip's f or q value.
     * f/q are dicts: { "testItemId": "numericStringValue", ... }
     * When itemKey is provided, use chip[field][itemKey] as the numeric value.
     */
    _computeRatioOverlay(field, itemKey) {
        this.ratioOverlayColors = new Map();
        this.ratioPercentiles = new Map();
        this.gradientFilterSet.clear();
        if (!this.chips || !this.gradientStops) return;

        // Collect all numeric values — dict 및 compact_array(list + ftn_keys) 모두 지원
        const keyName = (field && field !== 'bin') ? `${field}tn_keys` : null;
        const keyIndex = (keyName && this.positionsData?.[keyName])
            ? this.positionsData[keyName].indexOf(String(itemKey))
            : -1;

        const values = [];
        const chipIndices = [];
        this.chips.forEach((chip, idx) => {
            if (!chip) return;
            const data = chip[field];
            let raw = null;
            if (Array.isArray(data)) {
                // compact_array: ftn_keys 인덱스로 접근
                raw = keyIndex >= 0 && keyIndex < data.length ? data[keyIndex] : null;
            } else if (data && typeof data === 'object') {
                // dict: 키로 직접 접근
                raw = itemKey ? data[itemKey] : null;
            }
            if (raw == null) return;
            const val = Number(raw);
            if (!isFinite(val)) return;
            values.push(val);
            chipIndices.push(idx);
        });

        if (values.length === 0) return;

        // Sort for percentile ranking
        const sorted = [...values].sort((a, b) => a - b);
        const n = sorted.length;

        for (let i = 0; i < values.length; i++) {
            // Percentile rank (0~100)
            const val = values[i];
            let rank = 0;
            // Binary search for position in sorted array
            let lo = 0, hi = n - 1;
            while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                if (sorted[mid] < val) lo = mid + 1;
                else hi = mid - 1;
            }
            // lo = first index where sorted[lo] >= val
            // Count values strictly less than val
            let below = lo;
            rank = n > 1 ? (below / (n - 1)) * 100 : 50;
            rank = Math.max(0, Math.min(100, rank));

            const color = this._interpolateGradientColor(rank);
            this.ratioOverlayColors.set(chipIndices[i], color);
            this.ratioPercentiles.set(chipIndices[i], rank);
        }
    }

    /**
     * Set gradient range filter (percentile range selection).
     * @param {Set|null} rangeSet - Set of range indices (0~10): 0=exact 0, 1=(0,10]%, ..., 10=(90,100]%, null to clear
     */
    setGradientFilter(rangeSet) {
        if (rangeSet instanceof Set && rangeSet.size > 0) {
            this.gradientFilterSet = new Set(rangeSet);
        } else {
            this.gradientFilterSet.clear();
        }
        this.render();
    }

    /**
     * Get chip counts per gradient percentile range (11 ranges: [0]=exact 0, [1]=(0,10]%, ..., [10]=(90,100]%).
     * @returns {{ counts: number[], total: number }}
     */
    getGradientRangeCounts() {
        const counts = new Array(11).fill(0);
        let total = 0;
        if (!this.ratioPercentiles) return { counts, total };

        this.ratioPercentiles.forEach((pct) => {
            if (pct === 0) {
                counts[0]++;
            } else {
                counts[Math.min(Math.ceil(pct / 10), 10)]++;
            }
            total++;
        });
        return { counts, total };
    }

    /**
     * Interpolate gradient color for a percentile value (0-100).
     * Uses 11-point gradient stops (quantile 0,10,...,100).
     */
    _interpolateGradientColor(percentile) {
        const stops = this.gradientStops;
        if (!stops || stops.length !== 11) return 'rgba(128,128,128,0.7)';

        const p = Math.max(0, Math.min(100, percentile));
        // Map to index in 0-10 range
        const idx = p / 10;
        const lo = Math.floor(idx);
        const hi = Math.min(lo + 1, 10);
        const t = idx - lo;

        const c1 = this._hexToRgb(stops[lo]);
        const c2 = this._hexToRgb(stops[hi]);
        if (!c1 || !c2) return 'rgba(128,128,128,0.7)';

        const r = Math.round(c1.r + (c2.r - c1.r) * t);
        const g = Math.round(c1.g + (c2.g - c1.g) * t);
        const b = Math.round(c1.b + (c2.b - c1.b) * t);
        return `rgb(${r},${g},${b})`;
    }

    _hexToRgb(hex) {
        if (!hex) return null;
        const h = hex.replace('#', '');
        if (h.length !== 6) return null;
        return {
            r: parseInt(h.slice(0, 2), 16),
            g: parseInt(h.slice(2, 4), 16),
            b: parseInt(h.slice(4, 6), 16),
        };
    }

    /**
     * Draw chip rect filled with color AND centered text.
     */
    _drawChipRectWithText(chip, fillColor, text) {
        const transform = this.viewer.transform;
        const rect = chip.rect;
        const Y_OFFSET = this.Y_OFFSET || 0;

        this.ctx.save();
        this.ctx.resetTransform();

        const x = rect.x0 * transform.scale + transform.dx;
        const y = rect.y0 * transform.scale + transform.dy + Y_OFFSET;
        const w = (rect.x1 - rect.x0) * transform.scale;
        const h = (rect.y1 - rect.y0) * transform.scale;

        // Fill interior
        this.ctx.fillStyle = fillColor;
        this.ctx.fillRect(x, y, w, h);

        // Draw text only when chip is large enough to read
        if (w > 18 && h > 14 && text) {
            let fontSize = Math.max(10, Math.min(w, h) * 0.4);
            this.ctx.font = `bold ${fontSize}px sans-serif`;
            // 텍스트가 칩보다 넓으면 축소
            const tm = this.ctx.measureText(text);
            if (tm.width > w * 0.92) {
                fontSize = Math.max(8, fontSize * (w * 0.88) / tm.width);
                this.ctx.font = `bold ${fontSize}px sans-serif`;
            }
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';

            // Contrast color based on fill luminance
            const rgb = this._hexToRgb(fillColor) || this._parseRgba(fillColor);
            if (rgb) {
                const lum = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
                this.ctx.fillStyle = lum > 128 ? '#000000' : '#FFFFFF';
            } else {
                this.ctx.fillStyle = '#FFFFFF';
            }
            this.ctx.fillText(text, x + w / 2, y + h / 2);
        }

        this.ctx.restore();
    }

    /**
     * Parse rgba(...) string to {r, g, b}.
     */
    _parseRgba(str) {
        if (!str) return null;
        const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (!m) return null;
        return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
    }

    /**
     * 숫자를 K/M 단위로 축약 (≥1000: 유효숫자 2자리)
     */
    _formatCompact(n) {
        if (n == null) return '';
        const v = Number(n);
        if (isNaN(v)) return String(n);
        const abs = Math.abs(v);
        const sign = v < 0 ? '-' : '';
        if (abs < 1000) return String(v);
        if (abs < 10000) return sign + (abs / 1000).toFixed(1) + 'K';
        if (abs < 1000000) return sign + Math.round(abs / 1000) + 'K';
        if (abs < 10000000) return sign + (abs / 1000000).toFixed(1) + 'M';
        return sign + Math.round(abs / 1000000) + 'M';
    }

    /**
     * Get available sub-item keys for f or q field from loaded chips.
     * @param {'f'|'q'} field
     * @returns {string[]} sorted item keys
     */
    getAvailableItemKeys(field) {
        // 1) compact_array format: positionsData에 ftn_keys/qtn_keys 헤더가 있으면 사용
        if (this.positionsData) {
            const keyName = (field && field !== 'bin') ? `${field}tn_keys` : null;
            const headerKeys = keyName ? this.positionsData[keyName] : null;
            if (Array.isArray(headerKeys) && headerKeys.length > 0) {
                return headerKeys.map(String);  // positions 파일 원본 순서 유지
            }
        }
        // 2) dict format: chip[field]가 Object(Array 아님)인 경우 키 추출
        const keySet = new Set();
        if (!this.chips) return [];
        for (const chip of this.chips) {
            if (!chip) continue;
            const dict = chip[field];
            if (dict && typeof dict === 'object' && !Array.isArray(dict)) {
                for (const k of Object.keys(dict)) keySet.add(k);
            }
        }
        return Array.from(keySet);  // 원본 순서 유지
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
        const nx = Number(x);
        const ny = Number(y);
        if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
            return null;
        }
        return `${nx},${ny}`;
    }

    _dedupeChipsByGrid(chips) {
        if (!Array.isArray(chips) || chips.length <= 1) {
            return Array.isArray(chips) ? chips : [];
        }

        const byKey = new Map();
        const result = [];
        let duplicateCount = 0;
        for (const chip of chips) {
            const key = this._chipKey(chip?.x_abs, chip?.y_abs);
            if (!key) {
                result.push(chip);
                continue;
            }

            const existing = byKey.get(key);
            if (!existing) {
                byKey.set(key, chip);
                result.push(chip);
                continue;
            }

            duplicateCount += 1;
            for (const [field, value] of Object.entries(chip || {})) {
                if (existing[field] === undefined || existing[field] === null || existing[field] === '') {
                    existing[field] = value;
                }
            }
        }

        if (duplicateCount > 0) {
            console.warn('[POSITIONS] duplicate chip rows collapsed', {
                duplicateCount,
                sourceRows: chips.length,
                uniqueChips: result.length,
            });
        }
        return result;
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
        // No-op: chip annotations는 classification_chips/ 파일시스템에서 파생
        return true;
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
     * 공간 인덱스 빌드 (loadPositions 후 호출)
     */
    _buildSpatialGrid() {
        this._spatialGrid = new Map();
        if (!this.chips.length) return;
        // 칩 크기 기반 셀 크기 결정
        const first = this.chips[0].rect;
        if (!first) return;  // 🔥 rect가 없는 데이터 형식이면 공간 인덱스 스킵
        this._cellW = (first.x1 - first.x0) || 96;
        this._cellH = (first.y1 - first.y0) || 96;
        for (let i = 0; i < this.chips.length; i++) {
            const r = this.chips[i].rect;
            if (!r) continue;
            const gx = Math.floor(r.x0 / this._cellW);
            const gy = Math.floor(r.y0 / this._cellH);
            const key = (gx << 16) | (gy & 0xffff);
            let arr = this._spatialGrid.get(key);
            if (!arr) { arr = []; this._spatialGrid.set(key, arr); }
            arr.push(i);
        }
    }

    /**
     * Find chip at canvas pixel coordinates (공간 인덱스 사용)
     */
    findChipAtPixel(canvasX, canvasY) {
        if (!this.positionsData || !this.viewer.transform) return null;

        const Y_OFFSET = this.Y_OFFSET || 0;
        const transform = this.viewer.transform;
        const imgX = (canvasX - transform.dx) / transform.scale;
        const imgY = (canvasY - transform.dy - Y_OFFSET) / transform.scale;

        // 공간 인덱스가 있으면 O(1) 탐색
        if (this._spatialGrid && this._cellW) {
            const gx = Math.floor(imgX / this._cellW);
            const gy = Math.floor(imgY / this._cellH);
            // 현재 셀 + 인접 셀 검색 (경계 칩 대응)
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const key = ((gx + dx) << 16) | ((gy + dy) & 0xffff);
                    const indices = this._spatialGrid.get(key);
                    if (!indices) continue;
                    for (const i of indices) {
                        const chip = this.chips[i];
                        const rect = chip.rect;
                        if (imgX >= rect.x0 && imgX <= rect.x1 &&
                            imgY >= rect.y0 && imgY <= rect.y1) {
                            if (!this.isChipSelectable(chip)) {
                                return null;
                            }
                            return { ...chip, index: i };
                        }
                    }
                }
            }
            return null;
        }

        // fallback: 리니어 스캔
        for (let i = 0; i < this.chips.length; i++) {
            const chip = this.chips[i];
            const rect = chip.rect;
            if (imgX >= rect.x0 && imgX <= rect.x1 &&
                imgY >= rect.y0 && imgY <= rect.y1) {
                if (!this.isChipSelectable(chip)) {
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
                if (!this.isChipSelectable(chip)) {
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
    getSelectedChipData(options = {}) {
        const chips = [];
        const selectedIndices = options.expandShots === false
            ? Array.from(this.selectedChips)
            : this.selectionMode === 'shot'
            ? this._expandSelectionToShots(Array.from(this.selectedChips))
            : Array.from(this.selectedChips);
        selectedIndices.forEach(chipIdx => {
            const chip = this.chips[chipIdx];
            if (chip) {
                chips.push({
                    index: chipIdx,
                    x_abs: chip.x_abs,
                    y_abs: chip.y_abs,
                    b: chip.b,  // b 값 추가
                    yld: chip.yld,
                    yield: chip.yield,
                    YLD: chip.YLD,
                    YIELD: chip.YIELD,
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
    updateSelectedChipsList(options = {}) {
        if (!this.viewer || !this.viewer.dom) return;
        const notifyViewer = options?.notifyViewer !== false;

        const viewer = this.viewer;
        if (viewer.isCoordinateSelectionOpen && !viewer.coordinateSelectionSuppressSelectionSync) {
            viewer._syncCoordinateSelectionListsFromSelectedChips?.();
        }

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

            const selectedChipObjects = sortedChips
                .map((chipData) => this.chips[chipData.idx])
                .filter(Boolean);
            const yieldSummary = this.getSelectionYieldSummary(selectedChipObjects);
            const summaryItem = document.createElement('div');
            summaryItem.className = 'selected-chips-yield-summary';
            summaryItem.textContent = this.formatSelectionYieldSummary(yieldSummary);
            summaryItem.title = `Selected chips: ${yieldSummary.chipCount}, Good: ${yieldSummary.goodCount}, Bad: ${yieldSummary.badCount}, Yield source: ${yieldSummary.avgYieldSource}`;
            summaryItem.style.cssText = `
                padding: 3px 4px;
                margin-bottom: 2px;
                background: rgba(20, 20, 20, 0.88);
                border: 1px solid rgba(120, 120, 120, 0.55);
                border-radius: 3px;
                color: #e0e0e0;
                font-size: 10px;
                line-height: 1.25;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            `;
            listItems.appendChild(summaryItem);

            const breakdown = this.getSelectionYieldBreakdowns(selectedChipObjects);
            const shotLine = this.formatSelectionYieldBreakdownLine(breakdown.shotGroups, {
                label: 'Shot Yld',
                maxItems: 2,
            });
            const positionLine = this.formatSelectionYieldBreakdownLine(breakdown.shotPositionGroups, {
                label: 'Shot Pos Yld',
                maxItems: 3,
            });
            const breakdownItem = document.createElement('div');
            breakdownItem.className = 'selected-chips-yield-breakdown';
            breakdownItem.textContent = `${shotLine} · ${positionLine}`;
            breakdownItem.title = [
                this.formatSelectionYieldBreakdownTitle(breakdown.shotGroups, 'Shot Yld'),
                this.formatSelectionYieldBreakdownTitle(breakdown.shotPositionGroups, 'Shot Pos Yld'),
            ].join('\n\n');
            breakdownItem.style.cssText = `
                padding: 3px 4px;
                margin-bottom: 4px;
                background: rgba(20, 20, 20, 0.76);
                border: 1px solid rgba(90, 90, 90, 0.5);
                border-radius: 3px;
                color: #cfcfcf;
                font-size: 9px;
                line-height: 1.25;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            `;
            listItems.appendChild(breakdownItem);

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
            if (notifyViewer && typeof viewer.onManualChipSelection === 'function') {
                viewer.onManualChipSelection();
            }
            
        } else {
            // 선택된 칩이 없으면 숨김
            listContainer.style.display = 'none';
            listItems.innerHTML = '';
            if (notifyViewer && typeof viewer.handleChipSelectionCleared === 'function') {
                viewer.handleChipSelectionCleared();
            }
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

        // === Overlay rendering ===
        if (this.overlayMode === 'bin') {
            // BIN MAP: 색상은 normalized 카테고리, 텍스트는 raw b 값
            this.chips.forEach(chip => {
                if (!chip) return;
                if (!this.isChipSelectable(chip)) return;
                const systematicBin = this._normalizeSystematicBinValue(chip.b);
                if (this.binOverlayFilterSet.size > 0 && !this.binOverlayFilterSet.has(systematicBin)) return;
                const norm = this._normalizeBottomValue(chip.b);
                const hexColor = this.binOverlayFilterColor || this.binOverlayColors.get(norm);
                if (!hexColor) return;
                const rawText = chip.b != null ? String(chip.b) : '';
                this._drawChipRectWithText(chip, hexColor, rawText);
            });
        } else if ((this.viewer?.isMeasureGradientMode(this.overlayMode)) && this.ratioOverlayColors) {
            // Ratio overlay: fill chips with percentile gradient color
            const hasGradFilter = this.gradientFilterSet.size > 0;
            this.ratioOverlayColors.forEach((color, chipIdx) => {
                const chip = this.chips[chipIdx];
                if (!chip) return;
                if (!this.isChipSelectable(chip)) return;
                // Gradient range filter: skip chips outside selected ranges
                if (hasGradFilter) {
                    const pct = this.ratioPercentiles.get(chipIdx);
                    const rangeIdx = pct === 0 ? 0 : Math.min(Math.ceil(pct / 10), 10);
                    if (!this.gradientFilterSet.has(rangeIdx)) return;
                }
                const data = chip[this.overlayMode];
                let raw = null;
                if (Array.isArray(data)) {
                    // compact_array: {mode}tn_keys 인덱스로 접근 (f→ftn_keys, q→qtn_keys, 향후 모드도 동일 패턴)
                    const keyName = this.positionsData?.[`${this.overlayMode}tn_keys`] ? `${this.overlayMode}tn_keys` : null;
                    const keyIdx = (keyName && this.positionsData?.[keyName])
                        ? this.positionsData[keyName].indexOf(String(this.overlayItemKey))
                        : -1;
                    raw = keyIdx >= 0 && keyIdx < data.length ? data[keyIdx] : null;
                } else if (data && typeof data === 'object') {
                    // dict: 키로 직접 접근
                    raw = this.overlayItemKey ? data[this.overlayItemKey] : null;
                }
                const text = raw != null ? this._formatCompact(raw) : '';
                this._drawChipRectWithText(chip, color, text);
            });
        }

        // Bottom filter white mask: overlay 모드와 관계없이 항상 적용
        if (this.bottomFilterSet.size > 0) {
            const transform = this.viewer.transform;
            const Y_OFFSET = this.Y_OFFSET || 0;
            ctx.save();
            ctx.resetTransform();
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            this.chips.forEach(chip => {
                if (chip && !this._matchesBottomFilter(chip)) {
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

        // Gradient range filter white mask: measure overlay 모드에서 비선택 범위 chip 숨김
        if (this.gradientFilterSet.size > 0 && (this.viewer?.isMeasureGradientMode(this.overlayMode)) && this.ratioPercentiles) {
            const transform = this.viewer.transform;
            const Y_OFFSET = this.Y_OFFSET || 0;
            ctx.save();
            ctx.resetTransform();
            ctx.fillStyle = '#ffffff';
            ctx.beginPath();
            this.ratioPercentiles.forEach((pct, chipIdx) => {
                const rangeIdx = pct === 0 ? 0 : Math.min(Math.ceil(pct / 10), 10);
                if (this.gradientFilterSet.has(rangeIdx)) return; // 선택된 범위는 건너뜀
                const chip = this.chips[chipIdx];
                if (!chip) return;
                // bottom filter로 이미 마스킹된 chip은 중복 마스킹 불필요
                if (!this.isChipSelectable(chip)) return;
                const rect = chip.rect;
                const x = rect.x0 * transform.scale + transform.dx;
                const y = rect.y0 * transform.scale + transform.dy + Y_OFFSET;
                const w = (rect.x1 - rect.x0) * transform.scale;
                const h = (rect.y1 - rect.y0) * transform.scale;
                ctx.rect(x, y, w, h);
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
            if (!this.isChipSelectable(chip)) {
                return;
            }
            const isVisible = !activeSet || activeSet.has(chipClass);
            const alpha = isVisible ? this.chipLabelOverlayAlpha : 0;
            if (alpha > 0) {
                const fillColor = this.getClassColor(chipClass, alpha);
                this._drawChipInterior(chip, fillColor);
            }
        });

        // Shot selection fills only existing chips; the canonical extent is
        // represented separately by the selected Shot boundary.
        this._renderSelectedShotAreas();

        // Draw selected chips (manual selections override filters). Shot mode
        // is rendered above as one clipped Shot area so no chip can spill out
        // of its Shot boundary.
        if (this.selectionMode !== 'shot' && this.selectedChips.size > 0) {
            this.selectedChips.forEach(chipIdx => {
                const chip = this.chips[chipIdx];
                if (this.isChipSelectable(chip)) {
                    this._drawSelectionHighlight(chip, this.selectedColor);
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
                    this.isChipSelectable(chip)
                ) {
                    // 이미 선택된 chip은 제외 (중복 표시 방지)
                    this._drawSelectionHighlight(chip, this.selectionPreviewColor);
                }
            });
        }

        // Chip mode hovers one chip; Shot mode hovers the complete shot extent.
        if (this.hoveredChip) {
            if (this.selectionMode === 'shot') {
                this._renderHoveredShotBoundary();
            } else if (this.isChipSelectable(this.hoveredChip)) {
                this._drawChipOutline(this.hoveredChip, this.hoverColor);
            }
        }

        // Draw one boundary around all chips that share the same layout shot_id.
        this._renderShotBoundaries();
        this._renderSelectedShotBoundaries();

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
        const Y_OFFSET = this.Y_OFFSET || 0; // 칩 선택과 동일한 오프셋 (음수 = 위로)
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
     * Draw only the chip interior so the wafer chip boundary remains visible.
     */
    _drawChipInterior(chip, color) {
        const transform = this.viewer.transform;
        const rect = chip.rect;
        const Y_OFFSET = this.Y_OFFSET || 0;

        const chipWidth = rect.x1 - rect.x0;
        const chipHeight = rect.y1 - rect.y0;
        const inset = chipWidth > 2 && chipHeight > 2 ? 1 : 0;
        const x = rect.x0 + inset;
        const y = rect.y0 + inset;
        const w = chipWidth - inset * 2;
        const h = chipHeight - inset * 2;
        if (w <= 0 || h <= 0) return;

        this.ctx.save();
        this.ctx.resetTransform();
        this.ctx.translate(transform.dx, transform.dy + Y_OFFSET);
        this.ctx.scale(transform.scale, transform.scale);
        this.ctx.globalAlpha = 1.0;
        this.ctx.fillStyle = color;
        this.ctx.fillRect(x, y, w, h);
        this.ctx.restore();
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
        const Y_OFFSET = this.Y_OFFSET || 0;

        this.ctx.save();
        this.ctx.resetTransform();
        this.ctx.globalAlpha = 1.0; // 🔥 globalAlpha 리셋 (누적 방지)

        const topLeftX = rect.x0 * transform.scale + transform.dx;
        const topLeftY = rect.y0 * transform.scale + transform.dy + Y_OFFSET;
        const w = (rect.x1 - rect.x0) * transform.scale;
        const h = (rect.y1 - rect.y0) * transform.scale;

        // 🔥 Fill
        this.ctx.fillStyle = color;
        this.ctx.fillRect(topLeftX, topLeftY, w, h);

        // 🔥 밝은 테두리 (줌아웃에서도 칩 마크가 확실히 보이도록)
        this.ctx.strokeStyle = color.replace(/[\d.]+\)$/, '0.9)');
        this.ctx.lineWidth = Math.max(1.5, 2 * transform.scale);
        this.ctx.strokeRect(topLeftX, topLeftY, w, h);

        this.ctx.restore();
    }

    _drawChipOutline(chip, color) {
        const transform = this.viewer.transform;
        const rect = chip.rect;
        const Y_OFFSET = this.Y_OFFSET || 0;

        this.ctx.save();
        this.ctx.resetTransform();
        this.ctx.globalAlpha = 1.0;

        const topLeftX = rect.x0 * transform.scale + transform.dx;
        const topLeftY = rect.y0 * transform.scale + transform.dy + Y_OFFSET;
        const w = (rect.x1 - rect.x0) * transform.scale;
        const h = (rect.y1 - rect.y0) * transform.scale;

        this.ctx.strokeStyle = color.replace(/[\d.]+\)$/, '0.95)');
        this.ctx.lineWidth = Math.max(2.5, 3 * transform.scale);
        this.ctx.strokeRect(topLeftX, topLeftY, w, h);

        this.ctx.restore();
    }

    _drawSelectionHighlight(chip, color) {
        if (this.selectionMode === 'shot') {
            this._drawChipInterior(chip, color);
        } else {
            this._drawChipRect(chip, color);
        }
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
        if (this.coordTm) {
            this.coordTm.textContent = this.tm || '-';
        }
        if (this.coordLt) {
            this.coordLt.textContent = this.lt || '-';
        }
        if (this.coordNetd) {
            this.coordNetd.textContent = this.netd || '-';
        }
        if (this.coordGd) {
            this.coordGd.textContent = this.gd || '-';
        }
        if (this.coordYield) {
            this.coordYield.textContent = this.yield || '-';
        }
        if (this.coordSys) {
            this.coordSys.textContent = this.sys || '-';
        }
    }

    /**
     * Update chip coordinate box
     */
    _updateCoordinateBox(imgX, imgY, chip) {
        if (chip) {
            // Match the current chip (positions x_abs/y_abs) to layout.parquet.
            const layoutRow = this.getLayoutRowForChip(chip);
            if (this.coordChipCoord) {
                this.coordChipCoord.textContent = layoutRow
                    ? this.formatLayoutPair(layoutRow.chip_center_x_pos, layoutRow.chip_center_y_pos)
                    : '-';
            }
            if (this.coordChipRel) {
                this.coordChipRel.textContent = this.formatGridPair(chip.x_abs, chip.y_abs);
            }
            if (this.coordRadious) {
                this.coordRadious.textContent = layoutRow
                    ? this.formatLayoutRadius(layoutRow.chip_center_x_pos, layoutRow.chip_center_y_pos)
                    : '-';
            }
            if (this.coordShot) {
                this.coordShot.textContent = layoutRow
                    ? this.formatShotOrder(layoutRow.shot_x_pos, layoutRow.shot_y_pos)
                    : '-';
            }
            if (this.coordBin) {
                const raw = chip.b != null ? String(chip.b).trim() : '';
                const lower = raw.toLowerCase();
                this.coordBin.textContent = (raw && lower !== 'normal' && lower !== 'nor' && lower !== 'border' && lower !== 'invalid' && lower !== 'inv') ? raw : '-';
            }
        } else {
            // Chip 위에 없으면 "-" 표시
            this._resetChipCoordinateDisplay();
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
        // mousemove + pointermove 중복 호출 방지 (5ms 이내 동일 좌표면 스킵)
        const now = e.timeStamp || performance.now();
        if (this._lastMoveStamp && (now - this._lastMoveStamp) < 5 &&
            this._lastMoveX === e.clientX && this._lastMoveY === e.clientY) return;
        this._lastMoveStamp = now;
        this._lastMoveX = e.clientX;
        this._lastMoveY = e.clientY;

        const rect = this.canvas.getBoundingClientRect();
        // document 레벨 리스너 대응: 뷰어 영역 밖이면 무시
        if (e.clientX < rect.left || e.clientX > rect.right ||
            e.clientY < rect.top || e.clientY > rect.bottom) return;
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
                const selected = this._expandSelectionToShots(this._getChipsInCanvasRect(
                    this.shiftClickPos.x,
                    this.shiftClickPos.y,
                    canvasX,
                    canvasY
                ));
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
                    const selected = this._expandSelectionToShots(this.getChipsInRect(this.dragStartChip, chipAtPos));
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

        const chip = this.findChipAtPixel(canvasX, canvasY);

        // 🔥 Shift/Ctrl+Shift+드래그: 범위 추가 선택
        if (e.shiftKey && !e.altKey) {
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
                // Ctrl+blank click is an additive selection no-op. Plain clicks clear selection.
                this.ctrlClickStartPos = null;
                this.ctrlClickStartTime = null;
                this.dragStartChip = null;
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
                const selected = this._expandSelectionToShots(this._getChipsInPolygon(this.polygonPath));

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
                const selected = this._expandSelectionToShots(this._getChipsInCanvasRect(
                    this.shiftClickPos.x,
                    this.shiftClickPos.y,
                    canvasX,
                    canvasY
                ));
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
                console.log('🖱️ [SHIFT+CLICK] 빈 선택 동작 - 기존 선택 유지');
            }
            this.shiftClickPos = null;
            this._tempDragSelection = null;
            this.render();
            return;
        }

        // 일반 클릭/드래그 (Ctrl/Shift/Alt 없음): 선택 전에는 선택하지 않고, 선택 후에는 해제
        if (!e.ctrlKey && !e.shiftKey && !e.altKey && this.clickStartPos) {
            const dragDistance = Math.sqrt(
                Math.pow(canvasX - this.clickStartPos.x, 2) +
                Math.pow(canvasY - this.clickStartPos.y, 2)
            );

            // 🔥 드래그가 발생했으면 패닝으로 간주 → chip 선택 변경 없음
            if (dragDistance > 5) {
                // 패닝 중이므로 아무것도 하지 않음
            } else {
                if (this.selectedChips.size > 0) {
                    this.selectedChips.clear();
                    this.selectedChipsOrder = [];
                    this.updateSelectedChipsList();
                    console.log('🖱️ [CLICK] 일반 클릭으로 선택 해제');
                } else {
                    console.log('🖱️ [CLICK] 선택 상태 없음 - 유지');
                }
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
                    const selected = this._expandSelectionToShots(this.getChipsInRect(this.dragStartChip, chip));
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
                // 단순 클릭 (5px 이하 이동): chip 또는 shot 단위 토글
                if (this.dragStartChip) {
                    const selectionIndices = this._getSelectionIndicesForChip(this.dragStartChip);
                    const shouldRemove = selectionIndices.length > 0 &&
                        selectionIndices.every((chipIndex) => this.selectedChips.has(chipIndex));
                    if (shouldRemove) {
                        selectionIndices.forEach((chipIndex) => {
                            this.selectedChips.delete(chipIndex);
                            const orderIndex = this.selectedChipsOrder.indexOf(chipIndex);
                            if (orderIndex !== -1) this.selectedChipsOrder.splice(orderIndex, 1);
                        });
                        console.log(`🖱️ [CTRL+CLICK] ${this.selectionMode} 선택 해제:`, selectionIndices.length, '개');
                    } else {
                        selectionIndices.forEach((chipIndex) => {
                            this.selectedChips.add(chipIndex);
                            if (!this.selectedChipsOrder.includes(chipIndex)) {
                                this.selectedChipsOrder.push(chipIndex);
                            }
                        });
                        console.log(`🖱️ [CTRL+CLICK] ${this.selectionMode} 선택 추가:`, selectionIndices.length, '개');
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
        const Y_OFFSET = this.Y_OFFSET || 0;

        for (let i = 0; i < this.chips.length; i++) {
            const chip = this.chips[i];
            const rect = chip.rect;

            if (!this.isChipSelectable(chip)) {
                continue;
            }

            const chipLeft = rect.x0 * transform.scale + transform.dx;
            const chipRight = rect.x1 * transform.scale + transform.dx;
            const chipTop = rect.y0 * transform.scale + transform.dy + Y_OFFSET;
            const chipBottom = rect.y1 * transform.scale + transform.dy + Y_OFFSET;

            // Keep any chip whose rendered rectangle intersects the Shift marquee.
            if (chipLeft < maxX && chipRight > minX &&
                chipTop < maxY && chipBottom > minY) {
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
        const Y_OFFSET = this.Y_OFFSET || 0;

        for (let i = 0; i < this.chips.length; i++) {
            const chip = this.chips[i];
            const rect = chip.rect;

            if (!this.isChipSelectable(chip)) {
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
        this._resetChipCoordinateDisplay();

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
            if (!this.isChipSelectable(chip)) {
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
        this.tm = null;
        this.lt = null;
        this.netd = null;
        this.gd = null;
        this.yield = null;
        this.sys = null;
        this.selectedChips.clear();
        this.selectedChipsOrder = []; // 🔥 선택 순서도 초기화
        this.selectionMode = 'chip';
        if (this.viewer && typeof this.viewer.handleChipSelectionCleared === 'function') {
            this.viewer.handleChipSelectionCleared();
        }
        this.hoveredChip = null;
        this.currentImagePath = null;
        this.layoutProcessId = null;
        this.layoutByChip.clear();
        this.shotBoundaryGroups.clear();

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
        this._resetChipCoordinateDisplay();
        if (this.coordPartId) {
            this.coordPartId.textContent = '-';
        }
        if (this.coordDevice) {
            this.coordDevice.textContent = '-';
        }
        if (this.coordPgm) {
            this.coordPgm.textContent = '-';
        }
        if (this.coordTm) {
            this.coordTm.textContent = '-';
        }
        if (this.coordLt) {
            this.coordLt.textContent = '-';
        }
        if (this.coordNetd) {
            this.coordNetd.textContent = '-';
        }
        if (this.coordGd) {
            this.coordGd.textContent = '-';
        }
        if (this.coordYield) {
            this.coordYield.textContent = '-';
        }
        if (this.coordSys) {
            this.coordSys.textContent = '-';
        }
        if (this.coordBin) {
            this.coordBin.textContent = '-';
        }
    }
}
