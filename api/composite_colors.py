"""Helpers for composite sum-map color settings."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Dict, List, Sequence, Tuple, Optional

from .personal_colors import load_color_legends, save_color_legends, normalize_hex_color

QUANTILE_KEYS: List[str] = [f"quantile{step}" for step in range(0, 101, 10)]
QUANTILE_VALUES: List[float] = [step / 100 for step in range(0, 101, 10)]


def _default_color_for_step(step: int) -> str:
    ratio = step / 100
    gb = int(round(255 * (1 - ratio)))
    return f"#FF{gb:02X}{gb:02X}"


DEFAULT_COMPOSITE_COLORS: Dict[str, str] = {
    key: _default_color_for_step(idx * 10) for idx, key in enumerate(QUANTILE_KEYS)
}


@dataclass
class CompositeColorSettings:
    keys: List[str]
    quantiles: List[float]
    colors: List[str]
    default_colors: List[str]
    last_modified: str | None
    scheme: str

    def to_dict(self) -> Dict[str, object]:
        return {
            "keys": self.keys,
            "quantiles": self.quantiles,
            "colors": self.colors,
            "defaultColors": self.default_colors,
            "lastModified": self.last_modified,
            "scheme": self.scheme,
        }


def _normalize_color_values(values: Sequence[str] | None) -> List[str]:
    normalized: List[str] = []
    for idx, key in enumerate(QUANTILE_KEYS):
        candidate = None
        if values and idx < len(values):
            candidate = values[idx]
        normalized.append(normalize_hex_color(candidate or DEFAULT_COMPOSITE_COLORS[key]))
    return normalized


def _normalize_dict(entry: Dict[str, str] | None) -> List[str]:
    colors: List[str] = []
    entry = entry or {}
    for key in QUANTILE_KEYS:
        colors.append(normalize_hex_color(entry.get(key, DEFAULT_COMPOSITE_COLORS[key])))
    return colors


def _ensure_composite_storage(legends: Dict[str, object]) -> Tuple[Dict[str, Dict[str, str]], bool]:
    """Ensure legends['composite'] is a dict keyed by scheme name."""
    entry = legends.get("composite")
    mutated = False
    if not isinstance(entry, dict):
        entry = {}
        legends["composite"] = entry
        mutated = True
    # Legacy format: direct quantile list under 'composite'
    if entry and any(key.startswith("quantile") for key in entry.keys()):
        entry = {"change": entry}
        legends["composite"] = entry
        mutated = True
    return entry, mutated


def _ensure_scheme_entry(storage: Dict[str, Dict[str, str]], scheme: str) -> Tuple[Dict[str, str], bool]:
    entry = storage.get(scheme)
    created = False
    if not isinstance(entry, dict):
        entry = {key: DEFAULT_COMPOSITE_COLORS[key] for key in QUANTILE_KEYS}
        storage[scheme] = entry
        created = True
    return entry, created


def load_composite_color_settings(scheme: Optional[str] = None) -> CompositeColorSettings:
    scheme_key = (scheme or "change").strip() or "change"
    legends = load_color_legends()
    storage, mutated = _ensure_composite_storage(legends)

    # 저장하지 않고 읽기만 함 - 없으면 default 값 반환 (JSON 생성 안 함)
    if mutated:
        save_color_legends(legends)

    entry = storage.get(scheme_key)
    if not isinstance(entry, dict):
        # 유저 scheme 없으면 default 값으로 반환 (저장 안 함)
        entry = {key: DEFAULT_COMPOSITE_COLORS[key] for key in QUANTILE_KEYS}

    colors = _normalize_dict(entry)
    last_modified = entry.get("lastModified")

    return CompositeColorSettings(
        keys=list(QUANTILE_KEYS),
        quantiles=list(QUANTILE_VALUES),
        colors=colors,
        default_colors=[DEFAULT_COMPOSITE_COLORS[key] for key in QUANTILE_KEYS],
        last_modified=last_modified,
        scheme=scheme_key,
    )


def save_composite_color_settings(colors: Sequence[str], scheme: Optional[str] = None) -> CompositeColorSettings:
    scheme_key = (scheme or "change").strip() or "change"
    normalized = _normalize_color_values(colors)
    legends = load_color_legends()
    storage, _ = _ensure_composite_storage(legends)
    entry, _ = _ensure_scheme_entry(storage, scheme_key)

    for idx, key in enumerate(QUANTILE_KEYS):
        entry[key] = normalized[idx]

    entry["lastModified"] = datetime.now().strftime("%y%m%d_%H%M%S")
    save_color_legends(legends)
    return load_composite_color_settings(scheme_key)


__all__ = [
    "CompositeColorSettings",
    "load_composite_color_settings",
    "save_composite_color_settings",
    "QUANTILE_KEYS",
    "QUANTILE_VALUES",
    "DEFAULT_COMPOSITE_COLORS",
]
