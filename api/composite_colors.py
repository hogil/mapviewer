"""Helpers for composite sum-map color settings."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Sequence

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
    modified: bool
    last_modified: str | None

    def to_dict(self) -> Dict[str, object]:
        return {
            "keys": self.keys,
            "quantiles": self.quantiles,
            "colors": self.colors,
            "defaultColors": self.default_colors,
            "modified": self.modified,
            "lastModified": self.last_modified,
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


def load_composite_color_settings() -> CompositeColorSettings:
    legends = load_color_legends()
    entry = legends.get("composite", {})
    colors = (
        _normalize_dict(entry)
        if isinstance(entry, dict)
        else _normalize_color_values(entry)
    )

    modified = bool(entry.get("modified")) if isinstance(entry, dict) else False
    last_modified = entry.get("lastModified") if isinstance(entry, dict) else None

    return CompositeColorSettings(
        keys=list(QUANTILE_KEYS),
        quantiles=list(QUANTILE_VALUES),
        colors=colors,
        default_colors=[DEFAULT_COMPOSITE_COLORS[key] for key in QUANTILE_KEYS],
        modified=modified,
        last_modified=last_modified,
    )


def save_composite_color_settings(colors: Sequence[str]) -> CompositeColorSettings:
    normalized = _normalize_color_values(colors)
    legends = load_color_legends()
    is_default = all(
        normalized[idx] == DEFAULT_COMPOSITE_COLORS[key]
        for idx, key in enumerate(QUANTILE_KEYS)
    )
    legends["composite"] = {
        key: normalized[idx] for idx, key in enumerate(QUANTILE_KEYS)
    }
    legends["composite"]["modified"] = not is_default
    save_color_legends(legends, updated_scheme_name="composite")
    return load_composite_color_settings()


__all__ = [
    "CompositeColorSettings",
    "load_composite_color_settings",
    "save_composite_color_settings",
    "QUANTILE_KEYS",
    "QUANTILE_VALUES",
]
