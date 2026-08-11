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

function productSpec(index) {
  const colsSeq = [2, 3, 4, 5, 6, 7, 8, 9, 4, 6];
  const rowsSeq = [3, 4, 6, 4, 4, 5, 3, 7, 8, 6];
  const rotSeq = [5, 7, 3, 0];
  const waferSeq = ['circle', 'ellipse-x', 'ellipse-y', 'flat-top', 'flat-bottom', 'notch-left', 'notch-right', 'diamond'];
  const cols = colsSeq[index % colsSeq.length];
  const rows = rowsSeq[(index * 3) % rowsSeq.length];
  const width = 28 + (index % 11) + cols * 4;
  const height = 27 + ((index * 7) % 13) + rows * 4;
  const xStart = 26 + (index % 13); // fail-map style abs grid commonly starts near 30
  const yStart = 27 + ((index * 5) % 11);
  return {
    processId: `S${String(index).padStart(3, '0')}`,
    cols,
    rows,
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
  const results = { summaries: [], failures: [] };
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
        const selection = annotator.getSelectedShotGroupSelections()[0];
        if (!selection || selection.selectedChips.length !== chips.length) {
          productFailures.push({
            reason: 'selected-shot-expansion',
            shotId: group.shotId,
            expected: chips.length,
            got: selection?.selectedChips?.length || 0,
          });
          break;
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
    failures: results.failures,
    summaries: results.summaries,
  };
  const reportPath = path.join(OUT_DIR, `shot-100-products-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({
    passed: report.passed,
    productCount: report.productCount,
    failureCount: report.failureCount,
    reportPath,
    firstFailures: report.failures.slice(0, 5),
  }, null, 2));
  await browser.close();
  if (!report.passed) process.exit(1);
})();
