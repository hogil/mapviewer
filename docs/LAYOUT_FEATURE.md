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
E:/data/layout/layout.parquet
```

The Linux `start.sh` deployment path is `/appdata/appuser/project/layout.parquet`;
the Windows `start.ps1` path is `E:/data/layout/layout.parquet`.

The viewer loads the process rows lazily through `/api/layout` and uses the
positions JSON `x_abs/y_abs` values as the chip matching key. Matching rows provide
the chip center and shot order in the single-image coordinate panel. `Chip(Grid)`
is the discrete chip-grid index from positions `x_abs/y_abs`; `Chip(Pos)` is
the continuous wafer coordinate from `chip_center_x_pos/y_pos`. In that view,
chips with the same `shot_id` can be enclosed by one thin purple dotted shot
boundary in single-image mode. The `Shot` button above `Border` controls this
overlay and is off by default; grid mode does not draw these boundaries.
Boundary extents use the matched positions `x_abs/y_abs` grid and the canonical
Shot shape (4x6 in the dummy data), so an edge shot is not shrunk when it has
missing chips; only the visible canvas portion is drawn.
The single-image chip context menu provides `Chip 선택` and `Shot 선택` modes.
In Chip mode, hover shows one chip; in Shot mode, hover shows the complete
matched `shot_id` extent. Plain clicks do not create a selection; when a
selection already exists, a plain
left click clears it.
Chip hover and Shot boundary hover use the same bright silver-white color; Shot
hover draws only the boundary and leaves the shot interior unchanged. Selected
chips use that same color; in Shot mode their individual outlines are suppressed
and the selected Shot boundary is emphasized instead.
Ctrl-click/drag, Shift-drag, and Alt-drag are the selection interactions; Shot
mode expands those interactions to all matched chips with the same `shot_id`.
The default mode is Chip.
`Chip(Pos)` and `Radious` use the raw `chip_center_x_pos/y_pos` millimetre
values from layout and are formatted without a unit suffix. `Shot` shows the signed
integer shot order `(x, y)` without a physical-distance unit.

## CSV-format text contract

The file uses ordinary CSV formatting with commas as delimiters. The header is
fixed and must remain in this order:

```text
process_id,shot_id,chip_id,shot_x_pos,shot_y_pos,full_shot_type,chip_x_pos,chip_y_pos,chip_center_x_pos,chip_center_y_pos,zone_id,zone_type
```

- `process_id`: four-character process key, such as `P001`
- `shot_id`, `chip_id`: integer dummy identifiers
- `shot_x_pos`, `shot_y_pos`: signed integer shot order positions
- `full_shot_type`: `WHOLE` or `FRAGMENT`
- `chip_x_pos`, `chip_y_pos`: integer chip coordinates matching
  the positions JSON `x_abs`, `y_abs` values used by the viewer
- `chip_center_x_pos`, `chip_center_y_pos`: real millimetre coordinates used
  directly by the UI; do not divide them by 1000
- `zone_id`: zone label. The current dummy circle fixture uses `C20`, `C80`,
  `E1`, and `E20`.
- `zone_type`: zone family. The current fixture uses `circle`; the supported
  future families are `area` (`TOP_LEFT`, `CENTER`, `RIGHT`, `BOTTOM`) and
  `edge` (`INNER`, `EDGE`).

The API also accepts the pivoted Parquet form in which `zone_type` is represented
by `edge`, `area`, and `circle` columns. The non-empty value in one of those
columns is normalized to the API response pair `zone_type`/`zone_id`, so both
legacy and pivoted files have the same frontend contract.

The API reads the Parquet file lazily and caches the parsed index until the
file modification time or size changes. `pyarrow` is required by the API.

The wafer centre is `(0, 0)`. A 300 mm wafer is validated as a radius of
`150.0 mm`; generated chip centres must remain inside that circle.
The current dummy `circle` labels are deterministic radial bands only and are
not a production zone-boundary definition.
The dummy generator groups chips into shots of approximately 4 columns by 6
rows; edge shots can be partial because the source wafer mask is not full.

## Dummy generator

Generate the representative process layout directly. This writes
`layout.parquet`:

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
