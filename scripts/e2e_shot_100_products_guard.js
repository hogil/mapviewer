const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.MAPVIEWER_BASE_URL || 'https://127.0.0.1:8443';
const OUT_DIR = path.resolve('D:/project/mapviewer/output/playwright');
const PRODUCT_COUNT = Number(process.env.SHOT_PRODUCT_COUNT || 100);

fs.mkdirSync(OUT_DIR, { recursive: true });

function mapTileAfterRotation(i0, j0, rotCode, tilesW, tilesH) {
  if (rotCode === 7) return [j0, tilesH - 1 - i0];
  if (rotCode === 3) return [tilesW - 1 - j0, i0];
  if (rotCode === 0) return [tilesW - 1 - i0, tilesH - 1 - j0];
  return [i0, j0];
}

function positiveModulo(value, size) {
  return ((value % size) + size) % size;
}

const SHOT_SHAPES = [
  [1, 2], [2, 1], [2, 3], [3, 2], [3, 3], [3, 4],
  [4, 3], [4, 4], [4, 6], [5, 4], [5, 5], [6, 4],
  [6, 5], [6, 6], [7, 4], [7, 5], [8, 4], [8, 7],
  [9, 4], [9, 6], [10, 4], [10, 5], [12, 4], [12, 6],
];

const SIZE_PROFILES = [
  { name: 'tiny', baseW: 16, baseH: 15, colMul: 3, rowMul: 3 },
  { name: 'small', baseW: 23, baseH: 21, colMul: 4, rowMul: 3 },
  { name: 'mid', baseW: 31, baseH: 30, colMul: 4, rowMul: 4 },
  { name: 'large', baseW: 43, baseH: 35, colMul: 5, rowMul: 4 },
  { name: 'wide', baseW: 54, baseH: 45, colMul: 5, rowMul: 5 },
];

function productSpec(index) {
  const rotSeq = [5, 7, 3, 0];
  const waferSeq = ['circle', 'ellipse-x', 'ellipse-y', 'flat-top', 'flat-bottom', 'notch-left', 'notch-right', 'diamond'];
  const [cols, rows] = SHOT_SHAPES[index % SHOT_SHAPES.length];
  const profile = SIZE_PROFILES[Math.floor(index / SHOT_SHAPES.length) % SIZE_PROFILES.length];
  const width = profile.baseW + (index % 9) + cols * profile.colMul;
  const height = profile.baseH + ((index * 7) % 11) + rows * profile.rowMul;
  const xStart = 26 + (index % 13); // fail-map style abs grid commonly starts near 30
  const yStart = 27 + ((index * 5) % 11);
  return {
    processId: `S${String(index).padStart(3, '0')}`,
    cols,
    rows,
    shapeKey: `${cols}x${rows}`,
    sizeProfile: profile.name,
    originX: xStart + ((index * 2) % cols),
    originY: yStart + ((index * 3) % rows),
    xStart,
    yStart,
    width,
    height,
    rotCode: rotSeq[index % rotSeq.length],
    waferShape: waferSeq[index % waferSeq.length],
    cellW: 17 + (index % 5),
    cellH: 18 + ((index * 2) % 5),
  };
}

function insideWafer(i, j, width, height, waferShape, index) {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const nx = (i - cx) / (width / 2);
  const ny = (j - cy) / (height / 2);
  let inside;
  if (waferShape === 'ellipse-x') inside = (nx * nx) / 0.78 + (ny * ny) / 1.05 <= 1;
  else if (waferShape === 'ellipse-y') inside = (nx * nx) / 1.05 + (ny * ny) / 0.78 <= 1;
  else if (waferShape === 'diamond') inside = Math.abs(nx) + Math.abs(ny) <= 1.18;
  else inside = nx * nx + ny * ny <= 1;
  if (!inside) return false;

  if (waferShape === 'flat-top' && j < Math.floor(height * 0.08)) return false;
  if (waferShape === 'flat-bottom' && j > Math.ceil(height * 0.92)) return false;
  if (waferShape === 'notch-left' && i < Math.floor(width * 0.12) && Math.abs(j - cy) < height * 0.12) return false;
  if (waferShape === 'notch-right' && i > Math.ceil(width * 0.88) && Math.abs(j - cy) < height * 0.12) return false;

  // Sparse harmless holes, but never too many. This creates non-rectangular edge cases.
  if (((i * 17 + j * 31 + index * 13) % 97) === 0) return false;
  return true;
}

function buildProduct(spec, index) {
  const raw = [];
  for (let j = 0; j < spec.height; j += 1) {
    for (let i = 0; i < spec.width; i += 1) {
      if (!insideWafer(i, j, spec.width, spec.height, spec.waferShape, index)) continue;
      raw.push({ x: spec.xStart + i, y: spec.yStart + j, i, j });
    }
  }

  // Ensure at least one full shot exists for the canonical contract.
  const anchorShotX = Math.floor((spec.xStart + Math.floor(spec.width / 2) - spec.originX) / spec.cols);
  const anchorShotY = Math.floor((spec.yStart + Math.floor(spec.height / 2) - spec.originY) / spec.rows);
  for (let sy = 0; sy < spec.rows; sy += 1) {
    for (let sx = 0; sx < spec.cols; sx += 1) {
      const x = spec.originX + anchorShotX * spec.cols + sx;
      const y = spec.originY + anchorShotY * spec.rows + sy;
      if (!raw.some((chip) => chip.x === x && chip.y === y)) {
        raw.push({ x, y, i: x - spec.xStart, j: y - spec.yStart });
      }
    }
  }

  const xMin = Math.min(...raw.map((chip) => chip.x));
  const xMax = Math.max(...raw.map((chip) => chip.x));
  const yMin = Math.min(...raw.map((chip) => chip.y));
  const yMax = Math.max(...raw.map((chip) => chip.y));
  const rawTilesW = xMax - xMin + 1;
  const rawTilesH = yMax - yMin + 1;
  const rotated = spec.rotCode === 7 || spec.rotCode === 3;
  const tilesW = rotated ? rawTilesH : rawTilesW;
  const tilesH = rotated ? rawTilesW : rawTilesH;
  const canvasW = tilesW * spec.cellW;
  const canvasH = tilesH * spec.cellH;

  const groupCounts = new Map();
  raw.forEach(({ x, y }) => {
    const shotX = Math.floor((x - spec.originX) / spec.cols);
    const shotY = Math.floor((y - spec.originY) / spec.rows);
    const key = `${shotX}:${shotY}`;
    groupCounts.set(key, (groupCounts.get(key) || 0) + 1);
  });

  const chips = [];
  const rows = [];
  raw.sort((left, right) => left.y - right.y || left.x - right.x).forEach(({ x, y }, chipIndex) => {
    const i0 = x - xMin;
    const j0 = y - yMin;
    const [ii, jj] = mapTileAfterRotation(i0, j0, spec.rotCode, tilesW, tilesH);
    const rect = {
      x0: ii * spec.cellW,
      y0: jj * spec.cellH,
      x1: (ii + 1) * spec.cellW,
      y1: (jj + 1) * spec.cellH,
    };
    const shotX = Math.floor((x - spec.originX) / spec.cols);
    const shotY = Math.floor((y - spec.originY) / spec.rows);
    const groupKey = `${shotX}:${shotY}`;
    const slotX = positiveModulo(x - spec.originX, spec.cols);
    const slotY = positiveModulo(y - spec.originY, spec.rows);
    const chipId = slotY * spec.cols + slotX;
    chips.push({
      index: chipIndex,
      x_abs: x,
      y_abs: y,
      b: chipIndex % 23 === 0 ? '285' : '1',
      yld: chipIndex % 23 === 0 ? 0 : 1,
      rect,
    });
    rows.push({
      process_id: spec.processId,
      shot_id: `${shotX},${shotY}`,
      chip_id: chipId,
      shot_x_pos: shotX,
      shot_y_pos: shotY,
      full_shot_type: groupCounts.get(groupKey) === spec.cols * spec.rows ? 'WHOLE' : 'FRAGMENT',
      chip_x_pos: x,
      chip_y_pos: y,
      chip_center_x_pos: (x - spec.xStart) * 5,
      chip_center_y_pos: (y - spec.yStart) * 5,
      zone_id: 'C80',
      zone_type: 'circle',
    });
  });

  return { chips, rows, canvasW, canvasH, xMin, xMax, yMin, yMax };
}

function chipCountBucket(count) {
  if (count < 500) return '<500';
  if (count < 1000) return '500-999';
  if (count < 2000) return '1000-1999';
  if (count < 4000) return '2000-3999';
  return '4000+';
}

function summarizeCoverage(cases) {
  const chipCounts = cases.map(({ product }) => product.chips.length);
  const shotShapes = [...new Set(cases.map(({ spec }) => spec.shapeKey))].sort((left, right) => {
    const [lc, lr] = left.split('x').map(Number);
    const [rc, rr] = right.split('x').map(Number);
    return lc * lr - rc * rr || lc - rc || lr - rr;
  });
  const shotSlotCounts = [...new Set(cases.map(({ spec }) => spec.cols * spec.rows))].sort((a, b) => a - b);
  const chipBuckets = [...new Set(chipCounts.map(chipCountBucket))];
  return {
    productCount: cases.length,
    shotShapes,
    shotShapeCount: shotShapes.length,
    shotSlotCounts,
    shotSlotCountVariants: shotSlotCounts.length,
    sizeProfiles: [...new Set(cases.map(({ spec }) => spec.sizeProfile))].sort(),
    rotations: [...new Set(cases.map(({ spec }) => spec.rotCode))].sort((a, b) => a - b),
    waferShapes: [...new Set(cases.map(({ spec }) => spec.waferShape))].sort(),
    chipCount: {
      min: Math.min(...chipCounts),
      max: Math.max(...chipCounts),
      unique: new Set(chipCounts).size,
      buckets: chipBuckets,
      sample: chipCounts.slice(0, 20),
    },
  };
}

function coverageFailures(coverage) {
  const failures = [];
  if (coverage.productCount < 100) failures.push({ reason: 'coverage-product-count', expectedAtLeast: 100, got: coverage.productCount });
  if (coverage.shotShapeCount < 20) failures.push({ reason: 'coverage-shot-shapes', expectedAtLeast: 20, got: coverage.shotShapeCount, shapes: coverage.shotShapes });
  if (coverage.shotSlotCountVariants < 14) failures.push({ reason: 'coverage-shot-slot-counts', expectedAtLeast: 14, got: coverage.shotSlotCountVariants, slotCounts: coverage.shotSlotCounts });
  if (coverage.sizeProfiles.length < 5) failures.push({ reason: 'coverage-size-profiles', expectedAtLeast: 5, got: coverage.sizeProfiles.length, sizeProfiles: coverage.sizeProfiles });
  if (coverage.rotations.length < 4) failures.push({ reason: 'coverage-rotations', expected: [0, 3, 5, 7], got: coverage.rotations });
  if (coverage.waferShapes.length < 8) failures.push({ reason: 'coverage-wafer-shapes', expectedAtLeast: 8, got: coverage.waferShapes.length, waferShapes: coverage.waferShapes });
  if (coverage.chipCount.unique < 60) failures.push({ reason: 'coverage-chip-count-unique', expectedAtLeast: 60, got: coverage.chipCount.unique });
  if (coverage.chipCount.min >= 500 || coverage.chipCount.max < 4000) {
    failures.push({ reason: 'coverage-chip-count-range', expected: 'min<500 and max>=4000', got: coverage.chipCount });
  }
  ['<500', '500-999', '1000-1999', '2000-3999', '4000+'].forEach((bucket) => {
    if (!coverage.chipCount.buckets.includes(bucket)) {
      failures.push({ reason: 'coverage-chip-count-bucket', missing: bucket, buckets: coverage.chipCount.buckets });
    }
  });
  return failures;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1920, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/?_cb=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => window.viewer?.loadImage, null, { timeout: 90000 });
  await page.evaluate(async () => {
    await window.viewer.loadImage('PW/P001/20260501/AAI633_00P_08_20260501_010000_99.6_0_PE_PWQ.png', false, null, true);
    await new Promise((resolve) => setTimeout(resolve, 800));
  });

  const specs = Array.from({ length: PRODUCT_COUNT }, (_, index) => productSpec(index));
  const cases = specs.map((spec, index) => ({ spec, product: buildProduct(spec, index) }));
  const coverage = summarizeCoverage(cases);
  const coverageProblems = coverageFailures(coverage);
  const results = { summaries: [], failures: [] };
  if (coverageProblems.length) {
    results.failures.push({
      processId: 'coverage',
      failureCount: coverageProblems.length,
      coverage,
      failures: coverageProblems,
    });
  }
  for (const testCase of cases) {
    const productResult = await page.evaluate((testCase) => {
    const viewer = window.viewer;
    const annotator = viewer.chipAnnotator;
    const positiveModulo = (value, size) => ((value % size) + size) % size;
    const center = (chip) => ({
      x: (Number(chip.rect.x0) + Number(chip.rect.x1)) / 2,
      y: (Number(chip.rect.y0) + Number(chip.rect.y1)) / 2,
    });

    const { spec, product } = testCase;
    annotator.clearSelection();
    annotator.chips = product.chips;
    annotator.positionsData = {
      coord: { canvas: { width: product.canvasW, height: product.canvasH } },
      chips: product.chips,
    };
    annotator.chipIndexMap.clear();
    product.chips.forEach((chip, index) => {
      chip.index = index;
      annotator.chipIndexMap.set(`${chip.x_abs}:${chip.y_abs}`, index);
    });
    annotator.selectedChips.clear();
    annotator.selectedChipsOrder = [];
    annotator.bottomFilterSet.clear();
    annotator.gradeFilterSet.clear();
    annotator.legendFilterClasses = null;
    annotator.canvas.width = product.canvasW;
    annotator.canvas.height = product.canvasH;
    viewer.transform = { scale: 1, dx: 0, dy: 0 };
    viewer.gridMode = false;
    annotator.setLayoutData(spec.processId, product.rows);
    annotator.setSelectionMode('shot');
    annotator.setShotBoundaryVisible(true);

    const shape = annotator.getShotCompositeGridShape();
    const displayShape = annotator.getShotGridShape();
    const geometry = annotator._getShotGridGeometry();
    const cell = geometry?.referenceCellSize;
    const expectedBoundaryWidth = (displayShape?.cols || 0) * (cell?.width || 0);
    const expectedBoundaryHeight = (displayShape?.rows || 0) * (cell?.height || 0);
    const productFailures = [];

    if (!shape || shape.cols !== spec.cols || shape.rows !== spec.rows) {
      productFailures.push({ reason: 'shape', expected: { cols: spec.cols, rows: spec.rows }, got: shape });
    }
    if (!Number.isFinite(Number(geometry?.slotOriginX)) ||
        geometry.slotOriginX !== positiveModulo(spec.originX, spec.cols) ||
        geometry.slotOriginY !== positiveModulo(spec.originY, spec.rows)) {
      productFailures.push({
        reason: 'slot-origin',
        expected: { x: positiveModulo(spec.originX, spec.cols), y: positiveModulo(spec.originY, spec.rows) },
        got: { x: geometry?.slotOriginX, y: geometry?.slotOriginY },
      });
    }

    let checkedGroups = 0;
    let partialGroups = 0;
    let selectedChecks = 0;
    let compositeChecks = 0;
    let compositeSlotChecks = 0;
    let positionNoScopeChecks = 0;
    let positionScopedChecks = 0;
    let positionNoScopeMultiChecks = 0;
    let positionScopedMultiChecks = 0;
    for (const group of annotator.shotBoundaryGroups.values()) {
      checkedGroups += 1;
      const chips = group.chips || [];
      if (chips.length < spec.cols * spec.rows) partialGroups += 1;
      const boundary = annotator._getShotBoundaryRect(group);
      if (!boundary) {
        productFailures.push({ reason: 'missing-boundary', shotId: group.shotId });
        break;
      }
      if (Math.abs(boundary.width - expectedBoundaryWidth) > 0.01 ||
          Math.abs(boundary.height - expectedBoundaryHeight) > 0.01) {
        productFailures.push({
          reason: 'boundary-size',
          shotId: group.shotId,
          count: chips.length,
          expected: { width: expectedBoundaryWidth, height: expectedBoundaryHeight },
          got: { width: boundary.width, height: boundary.height },
          shape,
          displayShape,
          transform: geometry?.screenTransform,
        });
        break;
      }
      const compositeShape = annotator.getShotGridShape?.() || annotator.getShotCompositeGridShape?.();
      if (!compositeShape || compositeShape.cols !== displayShape.cols || compositeShape.rows !== displayShape.rows) {
        productFailures.push({
          reason: 'composite-shape',
          shotId: group.shotId,
          expected: displayShape,
          got: compositeShape,
        });
        break;
      }
      const compositeSlots = new Set();
      compositeChecks += 1;
      for (const chip of chips) {
        const rawSlot = annotator._getShotRawGridSlotInfo(chip, shape);
        const expectedRaw = {
          slotX: positiveModulo(Number(chip.x_abs) - spec.originX, spec.cols),
          slotY: positiveModulo(Number(chip.y_abs) - spec.originY, spec.rows),
        };
        if (!rawSlot || rawSlot.slotX !== expectedRaw.slotX || rawSlot.slotY !== expectedRaw.slotY) {
          productFailures.push({
            reason: 'raw-slot',
            xy: [chip.x_abs, chip.y_abs],
            expected: expectedRaw,
            got: rawSlot,
          });
          break;
        }
        const compositeSlot = annotator._getShotGridSlotInfo(chip, compositeShape) ||
          annotator._getShotRawGridSlotInfo(chip, compositeShape);
        if (!compositeSlot ||
            !Number.isInteger(compositeSlot.slotX) ||
            !Number.isInteger(compositeSlot.slotY) ||
            compositeSlot.slotX < 0 ||
            compositeSlot.slotY < 0 ||
            compositeSlot.slotX >= compositeShape.cols ||
            compositeSlot.slotY >= compositeShape.rows) {
          productFailures.push({
            reason: 'composite-slot-range',
            shotId: group.shotId,
            xy: [chip.x_abs, chip.y_abs],
            compositeShape,
            got: compositeSlot,
          });
          break;
        }
        const compositeSlotKey = `${compositeSlot.slotX}:${compositeSlot.slotY}`;
        if (compositeSlots.has(compositeSlotKey)) {
          productFailures.push({
            reason: 'composite-slot-duplicate',
            shotId: group.shotId,
            xy: [chip.x_abs, chip.y_abs],
            slot: compositeSlot,
          });
          break;
        }
        compositeSlots.add(compositeSlotKey);
        const chipCenter = center(chip);
        const eps = Math.max(1, Math.min(cell?.width || 1, cell?.height || 1) * 0.25);
        if (chipCenter.x < boundary.minX - eps || chipCenter.x > boundary.maxX + eps ||
            chipCenter.y < boundary.minY - eps || chipCenter.y > boundary.maxY + eps) {
          productFailures.push({
            reason: 'boundary-containment',
            shotId: group.shotId,
            xy: [chip.x_abs, chip.y_abs],
            center: chipCenter,
            boundary,
          });
          break;
        }
        const expectedCompositeCenter = {
          x: boundary.minX + (compositeSlot.slotX + 0.5) * cell.width,
          y: boundary.minY + (compositeSlot.slotY + 0.5) * cell.height,
        };
        if (Math.abs(chipCenter.x - expectedCompositeCenter.x) > eps ||
            Math.abs(chipCenter.y - expectedCompositeCenter.y) > eps) {
          productFailures.push({
            reason: 'composite-display-slot',
            shotId: group.shotId,
            xy: [chip.x_abs, chip.y_abs],
            compositeShape,
            slot: compositeSlot,
            center: chipCenter,
            expectedCenter: expectedCompositeCenter,
            boundary,
            transform: geometry?.screenTransform,
          });
          break;
        }
        compositeSlotChecks += 1;
      }
      if (productFailures.length) break;

      if (selectedChecks < 3 && chips.length > 0) {
        selectedChecks += 1;
        annotator.selectedChips.clear();
        annotator.selectedChipsOrder = [];
        annotator.selectedChips.add(group.indices[0]);
        annotator.selectedChipsOrder.push(group.indices[0]);
        const selection = annotator.getSelectedChipData();
        if (selection.length !== chips.length) {
          productFailures.push({
            reason: 'selected-shot-expansion',
            shotId: group.shotId,
            expected: chips.length,
            got: selection.length,
          });
          break;
        }
      }
    }

    if (!productFailures.length) {
      annotator.selectionMode = 'chip';
      annotator.selectedChips.clear();
      annotator.selectedChipsOrder = [];
      viewer.coordinateSelectionLists = null;
      const referenceIndex = product.chips.findIndex((chip) =>
        Number.isInteger(annotator.getShotPositionForChip(chip))
      );
      const referencePosition = referenceIndex >= 0
        ? annotator.getShotPositionForChip(product.chips[referenceIndex])
        : null;
      if (!Number.isInteger(referencePosition)) {
        productFailures.push({ reason: 'shot-position-reference-missing' });
      } else {
        const expected = product.chips
          .map((chip, index) => ({ chip, index }))
          .filter(({ chip }) => annotator.isChipSelectable(chip) &&
            annotator.getShotPositionForChip(chip) === referencePosition)
          .map(({ index }) => index);
        const result = viewer._applyCoordinateSelectionShotPickerSelection([referenceIndex]);
        const selected = [...annotator.selectedChips];
        const selectedByShot = new Map();
        selected.forEach((index) => {
          const selectedGroup = annotator._getShotGroupForChip(product.chips[index]);
          const key = selectedGroup ? String(selectedGroup.groupKey ?? selectedGroup.shotId) : '';
          selectedByShot.set(key, (selectedByShot.get(key) || 0) + 1);
        });
        positionNoScopeChecks += 1;
        if (!result || annotator.selectionMode !== 'chip' ||
            selected.length !== expected.length ||
            selected.some((index) => annotator.getShotPositionForChip(product.chips[index]) !== referencePosition) ||
            [...selectedByShot.values()].some((count) => count !== 1)) {
          productFailures.push({
            reason: 'shot-position-no-scope',
            expectedPosition: referencePosition,
            expectedCount: expected.length,
            selectedCount: selected.length,
            selectionMode: annotator.selectionMode,
            perShotCounts: [...selectedByShot.values()].slice(0, 10),
            result,
          });
        }
        if (!productFailures.length) {
          const secondReferenceIndex = product.chips.findIndex((chip) => {
            const position = annotator.getShotPositionForChip(chip);
            return Number.isInteger(position) && position !== referencePosition;
          });
          if (secondReferenceIndex < 0) {
            productFailures.push({ reason: 'shot-position-no-scope-second-reference-missing' });
          } else {
            const secondPosition = annotator.getShotPositionForChip(product.chips[secondReferenceIndex]);
            const expectedPositions = new Set([referencePosition, secondPosition]);
            const expectedMulti = product.chips
              .map((chip, index) => ({ chip, index }))
              .filter(({ chip }) => annotator.isChipSelectable(chip) &&
                expectedPositions.has(annotator.getShotPositionForChip(chip)))
              .map(({ index }) => index);
            const addResult = viewer._applyCoordinateSelectionShotPickerSelection([secondReferenceIndex], true);
            const multiSelected = [...annotator.selectedChips];
            const multiPositions = new Set(multiSelected
              .map((index) => annotator.getShotPositionForChip(product.chips[index])));
            const removeResult = viewer._applyCoordinateSelectionShotPickerSelection([secondReferenceIndex], false);
            const removedSelected = [...annotator.selectedChips];
            positionNoScopeMultiChecks += 1;
            if (!addResult || !removeResult ||
                annotator.selectionMode !== 'chip' ||
                multiSelected.length !== expectedMulti.length ||
                multiPositions.size !== 2 ||
                ![...expectedPositions].every((position) => multiPositions.has(position)) ||
                removedSelected.length !== expected.length ||
                removedSelected.some((index) => annotator.getShotPositionForChip(product.chips[index]) !== referencePosition)) {
              productFailures.push({
                reason: 'shot-position-no-scope-ctrl-multi',
                expectedPositions: [...expectedPositions],
                expectedMultiCount: expectedMulti.length,
                multiSelectedCount: multiSelected.length,
                multiPositions: [...multiPositions],
                removedSelectedCount: removedSelected.length,
                addResult,
                removeResult,
              });
            }
          }
        }
      }
    }

    if (!productFailures.length) {
      const fullGroups = [...annotator.shotBoundaryGroups.values()]
        .filter((group) => (group.indices || []).length === spec.cols * spec.rows);
      if (fullGroups.length < 2) {
        productFailures.push({ reason: 'shot-position-scope-needs-two-full-shots', fullGroups: fullGroups.length });
      } else {
        const scopedGroups = fullGroups.slice(0, 2);
        const referenceIndex = scopedGroups[0].indices[0];
        const referencePosition = annotator.getShotPositionForChip(product.chips[referenceIndex]);
        annotator.selectionMode = 'shot';
        annotator.selectedChips = new Set(scopedGroups.flatMap((group) => group.indices || []));
        annotator.selectedChipsOrder = [...annotator.selectedChips];
        viewer.coordinateSelectionLists = null;
        const result = viewer._applyCoordinateSelectionShotPickerSelection([referenceIndex]);
        const selected = [...annotator.selectedChips];
        const selectedByShot = new Map();
        selected.forEach((index) => {
          const selectedGroup = annotator._getShotGroupForChip(product.chips[index]);
          const key = selectedGroup ? String(selectedGroup.groupKey ?? selectedGroup.shotId) : '';
          selectedByShot.set(key, (selectedByShot.get(key) || 0) + 1);
        });
        positionScopedChecks += 1;
        if (!result || annotator.selectionMode !== 'chip' ||
            selected.length !== scopedGroups.length ||
            selectedByShot.size !== scopedGroups.length ||
            selected.some((index) => annotator.getShotPositionForChip(product.chips[index]) !== referencePosition) ||
            [...selectedByShot.values()].some((count) => count !== 1)) {
          productFailures.push({
            reason: 'shot-position-scoped',
            expectedPosition: referencePosition,
            expectedShotCount: scopedGroups.length,
            selectedCount: selected.length,
            selectedShotCount: selectedByShot.size,
            selectionMode: annotator.selectionMode,
            perShotCounts: [...selectedByShot.values()],
            result,
          });
        }
        if (!productFailures.length) {
          const secondReferenceIndex = scopedGroups[0].indices.find((index) => {
            const position = annotator.getShotPositionForChip(product.chips[index]);
            return Number.isInteger(position) && position !== referencePosition;
          });
          if (!Number.isInteger(secondReferenceIndex)) {
            productFailures.push({ reason: 'shot-position-scoped-second-reference-missing' });
          } else {
            const secondPosition = annotator.getShotPositionForChip(product.chips[secondReferenceIndex]);
            const expectedPositions = new Set([referencePosition, secondPosition]);
            const addResult = viewer._applyCoordinateSelectionShotPickerSelection([secondReferenceIndex], true);
            const multiSelected = [...annotator.selectedChips];
            const multiByShot = new Map();
            multiSelected.forEach((index) => {
              const group = annotator._getShotGroupForChip(product.chips[index]);
              const key = group ? String(group.groupKey ?? group.shotId) : '';
              multiByShot.set(key, (multiByShot.get(key) || 0) + 1);
            });
            const multiPositions = new Set(multiSelected
              .map((index) => annotator.getShotPositionForChip(product.chips[index])));
            const removeResult = viewer._applyCoordinateSelectionShotPickerSelection([secondReferenceIndex], false);
            const removedSelected = [...annotator.selectedChips];
            const removedByShot = new Map();
            removedSelected.forEach((index) => {
              const group = annotator._getShotGroupForChip(product.chips[index]);
              const key = group ? String(group.groupKey ?? group.shotId) : '';
              removedByShot.set(key, (removedByShot.get(key) || 0) + 1);
            });
            positionScopedMultiChecks += 1;
            if (!addResult || !removeResult ||
                annotator.selectionMode !== 'chip' ||
                multiSelected.length !== scopedGroups.length * 2 ||
                multiByShot.size !== scopedGroups.length ||
                [...multiByShot.values()].some((count) => count !== 2) ||
                multiPositions.size !== 2 ||
                ![...expectedPositions].every((position) => multiPositions.has(position)) ||
                removedSelected.length !== scopedGroups.length ||
                removedByShot.size !== scopedGroups.length ||
                [...removedByShot.values()].some((count) => count !== 1) ||
                removedSelected.some((index) => annotator.getShotPositionForChip(product.chips[index]) !== referencePosition)) {
              productFailures.push({
                reason: 'shot-position-scoped-ctrl-multi',
                expectedPositions: [...expectedPositions],
                expectedShotCount: scopedGroups.length,
                multiSelectedCount: multiSelected.length,
                multiShotCount: multiByShot.size,
                multiPerShotCounts: [...multiByShot.values()],
                multiPositions: [...multiPositions],
                removedSelectedCount: removedSelected.length,
                removedPerShotCounts: [...removedByShot.values()],
                addResult,
                removeResult,
              });
            }
          }
        }
      }
    }

    const summary = {
      processId: spec.processId,
      cols: spec.cols,
      rows: spec.rows,
      originX: spec.originX,
      originY: spec.originY,
      xStart: spec.xStart,
      yStart: spec.yStart,
      rotCode: spec.rotCode,
      waferShape: spec.waferShape,
      chipCount: product.chips.length,
      groupCount: annotator.shotBoundaryGroups.size,
      partialGroups,
      shape,
      displayShape,
      slotOriginX: geometry?.slotOriginX,
      slotOriginY: geometry?.slotOriginY,
      screenTransform: geometry?.screenTransform,
      expectedBoundaryWidth,
      expectedBoundaryHeight,
      checkedGroups,
      selectedChecks,
      compositeChecks,
      compositeSlotChecks,
      positionNoScopeChecks,
      positionScopedChecks,
      positionNoScopeMultiChecks,
      positionScopedMultiChecks,
      failureCount: productFailures.length,
    };
    return {
      summary,
      failure: productFailures.length ? { ...summary, failures: productFailures.slice(0, 5) } : null,
    };
  }, testCase);
    results.summaries.push(productResult.summary);
    if (productResult.failure) results.failures.push(productResult.failure);
  }

  const report = {
    generatedAt: new Date().toISOString(),
    productCount: PRODUCT_COUNT,
    passed: results.failures.length === 0,
    failureCount: results.failures.length,
    coverage,
    failures: results.failures,
    summaries: results.summaries,
  };
  const reportPath = path.join(OUT_DIR, `shot-100-products-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    passed: report.passed,
    productCount: report.productCount,
    failureCount: report.failureCount,
    coverage: report.coverage,
    reportPath,
    firstFailures: report.failures.slice(0, 5),
  }, null, 2));
  await browser.close();
  if (!report.passed) process.exit(1);
})();
