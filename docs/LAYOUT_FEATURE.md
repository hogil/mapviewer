# [NEW] Layout Data Foundation

## Scope

Layout data is stored beside the existing image and positions roots:

```text
E:/data/images/
E:/data/positions/
E:/data/layout/
```

Wafer images use three fixed path components before the filename:

```text
E:/data/images/<2-char device>/<4-char process_id>/<YYYYMMDD>/<wafer>.png
```

For example:

```text
E:/data/images/PW/P001/20260501/AAI633_00P_08_20260501_010000_99.6_0_PE_PWQ.png
```

The corresponding positions file mirrors that image-relative path:

```text
E:/data/positions/PW/P001/20260501/AAI633_00P_08_20260501_010000_99.6_0_PE_PWQ.json
```

Layout is shared by process, so it is resolved by the four-character
`process_id`:

```text
E:/data/layout/layout.txt
```

The viewer loads the process rows lazily through `/api/layout` and uses the
positions JSON `x_abs/y_abs` values as the EDS chip key. Matching rows provide
the chip center and shot order in the single-image coordinate panel. `Chip(Rel)`
is the discrete chip-grid index from positions `x_cal/y_cal`; `Chip(Coord)` is
the continuous wafer coordinate from `chip_center_x_pos/y_pos`. In that view,
chips with the same `shot_id` can be enclosed by one thin purple dotted shot
boundary in single-image mode. The `Shot` button above `Border` controls this
overlay and is off by default; grid mode does not draw these boundaries.
Boundary extents come only from the matched chip rectangles, so an edge shot
with 3x4 chips remains 3x4 instead of being padded to the nominal shot size.
The single-image chip context menu provides `Chip 선택` and `Shot 선택` modes.
In Chip mode, hover shows one chip; in Shot mode, hover shows the complete
matched `shot_id` extent. Plain clicks do not create a selection; when a
selection already exists, a plain
left click clears it.
Hover and selected highlights use the same bright silver-white color.
Ctrl-click/drag, Shift-drag, and Alt-drag are the selection interactions; Shot
mode expands those interactions to all matched chips with the same `shot_id`.
The default mode is Chip.
`Chip(Coord)` and `Radious` are calculated in millimetres and formatted to two
decimal places, but the UI omits the unit suffix. `Shot` shows the signed
integer shot order `(x, y)` without a physical-distance unit.

## CSV-format text contract

The file uses ordinary CSV formatting with commas as delimiters. The header is
fixed and must remain in this order:

```text
process_id,shot_id,chip_id,shot_x_pos,shot_y_pos,full_shot_type,eds_chip_x_pos,eds_chip_y_pos,chip_center_x_pos,chip_center_y_pos
```

- `process_id`: four-character process key, such as `P001`
- `shot_id`, `chip_id`: integer dummy identifiers
- `shot_x_pos`, `shot_y_pos`: signed integer shot order positions
- `full_shot_type`: `FULL` or `PARTIAL`
- `eds_chip_x_pos`, `eds_chip_y_pos`: integer EDS chip coordinates matching
  the positions JSON `x_abs`, `y_abs` values used by the viewer
- `chip_center_x_pos`, `chip_center_y_pos`: real micrometre coordinates,
  displayed as millimetre values in the UI

The API reads the 70k-row file lazily and caches the parsed index until the
file modification time or size changes.

The wafer centre is `(0, 0)`. A 300 mm wafer is validated as a radius of
`150000.0 um`; generated chip centres must remain inside that circle.
The dummy generator groups chips into shots of approximately 4 columns by 6
rows; edge shots can be partial because the source wafer mask is not full.

## Dummy generator

Generate the representative process layout directly:

```powershell
python scripts/generate_layout_dummy.py
```

Create three structured wafer images, their positions copies, and the shared
`P001` process layout:

```powershell
python scripts/prepare_layout_dummy_dataset.py
```

The output root is controlled by `LAYOUT_ROOT`; by default it is the sibling
directory of `POSITIONS_ROOT`.
