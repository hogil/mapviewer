"""Helpers for composite sum-map color settings."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, List, Sequence

from datetime import datetime
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
    scheme: str

    def to_dict(self) -> Dict[str, object]:
        return {
            "keys": self.keys,
            "quantiles": self.quantiles,
            "colors": self.colors,
            "defaultColors": self.default_colors,
            "modified": self.modified,
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


def _ensure_composite_scheme(legends: Dict[str, object], scheme: str) -> Dict[str, str]:
    schemes = legends.setdefault("compositeSchemes", {})
    if scheme in schemes and isinstance(schemes[scheme], dict):
        return schemes[scheme]  # type: ignore[return-value]

    base_entry: Dict[str, str] | None = None
    # 우선 전역 composite 엔트리가 있으면 템플릿으로 사용
    if isinstance(legends.get("composite"), dict):
        base_entry = legends["composite"]  # type: ignore[assignment]

    new_entry: Dict[str, str] = {"modified": False}
    for key in QUANTILE_KEYS:
        if base_entry and key in base_entry:
            new_entry[key] = normalize_hex_color(base_entry[key])
        else:
            new_entry[key] = DEFAULT_COMPOSITE_COLORS[key]

    schemes[scheme] = new_entry
    save_color_legends(legends, updated_scheme_name=f"composite:{scheme}")
    return new_entry


def load_composite_color_settings(scheme: str | None = None) -> CompositeColorSettings:
    legends = load_color_legends()
    scheme_name = scheme or "change"

    if scheme_name not in legends.get("compositeSchemes", {}):
        _ensure_composite_scheme(legends, scheme_name)

    schemes = legends.get("compositeSchemes", {})
    entry = schemes.get(scheme_name) if isinstance(schemes, dict) else None

    # fallback 순서: 요청 스킴 → change → default composite → 기본값
    if not isinstance(entry, dict):
        entry = schemes.get("change") if isinstance(schemes, dict) else None
    if not isinstance(entry, dict):
        entry = legends.get("composite") if isinstance(legends.get("composite"), dict) else None

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
        scheme=scheme_name,
    )


def save_composite_color_settings(colors: Sequence[str], scheme: str | None = None) -> CompositeColorSettings:
    normalized = _normalize_color_values(colors)
    legends = load_color_legends()
    scheme_name = scheme or "change"

    entry = _ensure_composite_scheme(legends, scheme_name)

    is_default = all(
        normalized[idx] == DEFAULT_COMPOSITE_COLORS[key]
        for idx, key in enumerate(QUANTILE_KEYS)
    )

    for idx, key in enumerate(QUANTILE_KEYS):
        entry[key] = normalized[idx]
    entry["modified"] = not is_default
    entry["lastModified"] = datetime.now().strftime("%y%m%d_%H%M%S")

    legends.setdefault("compositeSchemes", {})[scheme_name] = entry
    save_color_legends(legends, updated_scheme_name=f"composite:{scheme_name}")
    return load_composite_color_settings(scheme_name)


__all__ = [
    "CompositeColorSettings",
    "load_composite_color_settings",
    "save_composite_color_settings",
    "QUANTILE_KEYS",
    "QUANTILE_VALUES",
]
