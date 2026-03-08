---
name: failbit-map-generator
description: Generate or refresh fail-bit wafer palette PNG datasets and matching positions JSON files for the local Map Viewer. Use when the user asks about 00P or 00C fail-bit maps, palette-indexed PNG generation, chip positions JSON, or refreshing the `palette_5mb` or `palette_3k` demo datasets.
---

# Fail-Bit Map Generator

## Quick Start

When asked to regenerate local fail-bit demo data:

1. Treat `D:/project/data/positions/...` as the authoritative source of chip layout and metadata.
2. Generate PNGs using `python scripts/refresh_failbit_local_maps.py`.
3. In the current local default flow:
   - `palette_5mb` is rendered from positions JSON
   - `palette_3k` is created by copying `palette_5mb/wafer_palette_5mb.png` 3000 times
4. Write PNGs under `D:/project/data/wm-811k/...`.
5. Keep matching JSON files under `D:/project/data/positions/...`.
6. Read `docs/LOCAL_FAILBIT_DATASET_SPEC.md` before generating anything if the task involves creating the datasets from scratch or explaining the exact rules.
7. Verify the JSON contains:
   - `kind`
   - `partid`
   - `device`
   - `pgm`
   - `coord.grid_edges`
   - `chips[].x_abs`
   - `chips[].y_abs`
   - `chips[].x_cal`
   - `chips[].y_cal`
   - `chips[].rect`

## Required Rules

- Keep palette indices stable:
  - `0..7`: Grade0..Grade7
  - `8`: background
  - `9`: text
  - `10`: normal border
  - `11`: invalid border
  - `12..17`: `00P` BIN borders
  - `18..23`: `00C` BIN borders
  - `31`: white invalid fill
- Always emit a positions JSON file for every PNG.
- Do not rely on rectangle-only JSON. The UI expects chip coordinates and metadata.
- `00P` BIN set: `285 286 287 288 290 291`
- `00C` BIN set: `300 385 386 388 389 390`
- For chips whose interior is filled with `Grade1..Grade7`, keep only about 95% of interior pixels as that grade and flip the remaining 5% to `Grade0`.
- Preserve chip borders while applying the 95/5 rule. Only mutate the chip interior.
- Any wafer-shaping dummy area outside chip rectangles must be converted to pure background (`index 8`).
- In current local data, dummy outside-chip indices such as `24`, `28`, and `29` should not remain after refresh.
- Use a deterministic seed so that the same JSON recreates the same sparse `Grade0` pattern on every run.
- Border thickness is exactly `1px`.
- `palette_3k` defaults to copying `palette_5mb/wafer_palette_5mb.png` into `wafer_p3k_0001.png` ... `wafer_p3k_3000.png`.
- Use `--render-all-p3k` only when `palette_3k` must be rendered from each JSON individually.

## Local Dataset Targets

- `palette_5mb`: update the named sample files under `D:/project/data/wm-811k/palette_5mb`.
- `palette_3k`: keep 3000 PNG/JSON pairs under `D:/project/data/wm-811k/palette_3k` and `D:/project/data/positions/palette_3k`.
- Current default `palette_3k` source image: `D:/project/data/wm-811k/palette_5mb/wafer_palette_5mb.png`
- `palette_5mb` file size targets are real requirements:
  - `wafer_palette_5mb.png` -> `5 MiB`
  - `wafer_palette_10mb.png` -> `10 MiB`
  - `wafer_palette_15mb.png` -> `15 MiB`
  - `wafer_palette_20mb.png` -> `20 MiB`
  - `wafer_palette_25mb.png` -> `25 MiB`
  - `wafer_palette_30mb.png` -> `30 MiB`

## Exact Execution

- Full refresh:
  - `python scripts/refresh_failbit_local_maps.py`
- Only `palette_5mb`:
  - `python scripts/refresh_failbit_local_maps.py --targets palette_5mb`
- Only `palette_3k`:
  - `python scripts/refresh_failbit_local_maps.py --targets palette_3k`
- Render every `palette_3k` PNG individually instead of 5MB source copy:
  - `python scripts/refresh_failbit_local_maps.py --targets palette_3k --render-all-p3k`

## Current Local Refresh Rules

- Target folders:
  - `D:/project/data/wm-811k/palette_5mb`
  - `D:/project/data/wm-811k/palette_3k`
- Matching positions:
  - `D:/project/data/positions/palette_5mb`
  - `D:/project/data/positions/palette_3k`
- Canvas/layout facts:
  - `2304 x 2304` canvas
  - `96 x 96` chip rectangles
  - `20 x 20` grid edges
  - `332` actual chips
- Grade sparsening rule:
  - Apply to every generated `Grade1..Grade7` chip interior
  - Interior size is currently `94 x 94 = 8836` px
  - Change `round(8836 * 0.05) = 442` pixels to `Grade0`
  - Keep the remaining `8394` pixels as the original grade
  - Seed key is based on `<json_name>|<x0>|<y0>|<x1>|<y1>|<grade>`
- Dummy-area cleanup rule:
  - Build a chip mask from `chips[].rect`
  - Any pixel outside chip rectangles must end up as background (`index 8`)
  - No circular wafer ring should remain between chip area and background
- Size-padding rule for `palette_5mb`:
  - Rendered PNG alone is too small, so add a deterministic private ancillary padding chunk
  - Final file size must exactly match the `<N>mb` part of the filename in MiB
- `palette_3k` copy rule:
  - Default output PNGs are all binary copies of `wafer_palette_5mb.png`
  - Positions JSON files remain `wafer_p3k_0001.json` ... `wafer_p3k_3000.json`

## Verification

After generation:

1. Open one JSON from `palette_5mb` and confirm `partid` and `device` are present.
2. Open one JSON from `palette_3k` and confirm `image_path` matches the file name.
3. Confirm the selection UI can show coordinates from `x_abs` and `y_abs`.
4. Inspect one `Grade1..Grade7` full chip and confirm the interior is roughly `95% grade / 5% Grade0`.
5. Inspect pixels outside chip rectangles and confirm only background index `8` remains.
6. Confirm border thickness is `1px`.
7. Confirm `palette_3k` has `3000` PNG files.
8. Confirm each `palette_5mb` file size matches its name exactly.
9. Confirm `palette_3k` PNGs are copies of `wafer_palette_5mb.png` unless `--render-all-p3k` was intentionally used.

## Additional Resource

- See `docs/LOCAL_FAILBIT_DATASET_SPEC.md` for the exact generation algorithm.
- See `docs/IMAGE_PIPELINE.md` for the common image/positions contract.
- See `docs/FAILBIT_DUAL_PIPELINE.md` for the external pipeline rationale.
