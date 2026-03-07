# Fail-Bit Dual Pipeline

This document captures the fail-bit PNG + positions JSON generation rules behind the `00P` / `00C` dual pipeline and the local synthetic dataset workflow used in this repository.

## Goals

- Match the frontend/backend contract for chip overlays, selection, and metadata display.
- Keep palette indices stable so `api/personal_colors.py` and the UI render the same semantics.
- Always emit a positions JSON file together with each PNG.
- Separate `00P` and `00C` BIN border behavior.

## File Discovery Rules

The production-style pipeline distinguishes files by filename middle tokens:

- `00P`: `-00P_`
- `00C`: `-00C_`

The matched file determines `kind`, and `kind` drives BIN border selection and JSON metadata.

## Palette Contract

Palette indices are fixed and must not be reordered:

| Index | Meaning |
| --- | --- |
| `0..7` | `Grade0..Grade7` chip interior |
| `8` | background |
| `9` | text |
| `10` | normal border |
| `11` | invalid border |
| `12..17` | `00P` BIN borders: `285 286 287 288 290 291` |
| `18..23` | `00C` BIN borders: `300 385 386 388 389 390` |
| `31` | invalid fill / white mask |

This ordering is the compatibility boundary for local PNG generators too.

## BIN Border Rules

Only the allowed BIN set for the detected `kind` receives a colored BIN border.

### `00P`

- `285`
- `286`
- `287`
- `288`
- `290`
- `291`

### `00C`

- `300`
- `385`
- `386`
- `388`
- `389`
- `390`

`Normal` always uses palette index `10`, and `Invalid` always uses palette index `11`.

## Positions JSON Contract

Every PNG must have a matching JSON file. The UI depends on the JSON for click hit-testing, chip selection labels, and the bottom-left metadata block.

Required top-level fields:

- `image_path`
- `kind`
- `partid`
- `device`
- `pgm`
- `coord`
- `chips`

Required `coord` fields:

- `canvas.width`
- `canvas.height`
- `grid_edges.xs`
- `grid_edges.ys`
- `grid_shape.cols`
- `grid_shape.rows`

Required chip fields:

- `x_abs`
- `y_abs`
- `x_cal`
- `y_cal`
- `b`
- `rect.x0`
- `rect.y0`
- `rect.x1`
- `rect.y1`
- `rect.quad`

Minimal example:

```json
{
  "image_path": "palette_5mb/wafer_palette_5mb.png",
  "kind": "00P",
  "partid": "WAFER_PALETTE_5MB-00P",
  "device": "FAILBIT-DEMO-00P",
  "pgm": "FAILBIT-GENERATOR",
  "coord": {
    "canvas": { "width": 2048, "height": 2048 },
    "grid_edges": { "xs": [104, 184, 264], "ys": [104, 184, 264] }
  },
  "chips": [
    {
      "x_abs": 10,
      "y_abs": 20,
      "x_cal": -3,
      "y_cal": 4,
      "b": "285",
      "rect": {
        "x0": 104,
        "y0": 184,
        "x1": 184,
        "y1": 264,
        "quad": [[104, 184], [184, 184], [184, 264], [104, 264]]
      }
    }
  ]
}
```

## Local Synthetic Dataset

For local development, `scripts/create_wafer_images.py` generates deterministic demo datasets under:

- `D:/project/data/wm-811k/palette_5mb`
- `D:/project/data/wm-811k/palette_3k`
- `D:/project/data/positions/palette_5mb`
- `D:/project/data/positions/palette_3k`

Current local behavior:

- `palette_5mb`: regenerate the named demo files with positions JSON.
- `palette_3k`: generate one template image and duplicate it into 3000 PNG/JSON pairs.

This is intentionally synthetic. It preserves the UI contract without requiring the production S3/dataframe pipeline.

## Security Note

The original production pipeline example includes S3 credentials and environment-specific paths. Those values must not be copied into repository docs or skills. Keep credentials in environment variables or a secure external secret store.
