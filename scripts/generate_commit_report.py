#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Ultra speed bench (workers sweep) for PNG(level=3) & JPEG(Q=95) using pyvips on Windows

- 품질 고정:
  * PNG: compression=3, filter=NONE, interlace=False (무손실)
  * JPEG: Q=95, subsample=4:2:0, baseline, FAST DCT
- 가속/안정화:
  * 로더 모드 A/B 비교:
      A) sequential 로드 → 즉시 copy_memory() → 처리
      B) random 로드 → 처리 → 저장 직전 copy_memory()
  * 알파 완전 불투명 제거, 그레이스케일 감지→1채널, 16→8비트
  * 저장 직전 컬러스페이스 확정(sRGB/GRAY), strip=True
  * VIPS_CONCURRENCY + pyvips.concurrency_set 동시 적용
- 동시 처리(worker) 스윕:
  * WORKERS_SWEEP = [1, 2, 4] 등으로 설정하여 파이썬 레벨 동시 작업 수 실험
- TurboJPEG 있으면 JPG_q95_turbo 변형 자동 추가
"""

import os, sys, time
from pathlib import Path
from typing import Tuple, Dict, Any, List, Callable
from concurrent.futures import ThreadPoolExecutor, as_completed

# ===== 사용자 변수 =====
IMAGE_PATH = "input.png"
LEVEL      = 0.7
OUT_DIR    = "bench_speed_ultra_workers"

REPEAT = 1                               # 각 조합당 최소 반복 횟수(워커>1이면 병렬 제출 수가 REPEAT*workers가 됨)
WORKERS_SWEEP = [1, 2, 4, 8]                # 파이썬 동시 작업 수 스윕
VIPS_CONCURRENCY_SWEEP = [1, 2, 4, 8]          # libvips 내부 스레드 수 스윕
PIPELINES = ["cubic", "resize_only"]     # 둘 다 cubic 커널
LOADER_MODES = ["seq_early_copy", "random_late_copy"]  # 둘 다 테스트
USE_ASYNC_WRITE = False                  # TPS 측정시 True로
# ======================

def ensure_dir(p: Path): p.mkdir(parents=True, exist_ok=True)
def human_kb(n: int) -> str: return f"{n/1024:.1f} KB"

def set_vips_concurrency(n: int):
    os.environ["VIPS_CONCURRENCY"] = str(max(1, int(n)))
    try:
        import pyvips
        pyvips.concurrency_set(max(1, int(n)))
    except Exception:
        pass

def read_wh(path: Path) -> Tuple[int,int]:
    import pyvips
    im = pyvips.Image.new_from_file(str(path))
    return im.width, im.height

def target_wh(w: int, h: int, level: float) -> Tuple[int,int]:
    return max(1, int(round(w*level))), max(1, int(round(h*level)))

# -------- 전처: 알파/그레이/비트깊이 --------
def drop_alpha_if_opaque(img):
    if img.hasalpha():
        a = img.extract_band(img.bands - 1)
        opaque = (a.max() == (65535 if img.format in ("ushort","short") else 255))
        if opaque:
            return img.extract_band(0, n=img.bands - 1)
    return img

def is_grayscale_fast(img) -> bool:
    if img.bands < 3: return True
    try:
        s = max(img.width, img.height)
        scale = 128 / s if s > 128 else 1.0
        test = img if scale == 1.0 else img.resize(scale, kernel="nearest")
        r, g, b = test.extract_band(0), test.extract_band(1), test.extract_band(2)
        return (r - g).abs().max() == 0 and (g - b).abs().max() == 0
    except Exception:
        return False

def to_gray_if_possible(img):
    if img.bands >= 3 and is_grayscale_fast(img):
        return img.colourspace("b-w")
    return img

def to_8bit_if_16bit(img):
    if img.format in ("ushort","short"):
        return (img * (1.0/256.0)).cast("uchar")
    return img

# -------- 컬러스페이스 확정 --------
def finalize_colorspace_for_png(img):
    if img.bands == 1:
        return img if img.interpretation == "b-w" else img.colourspace("b-w")
    if img.bands != 3 or img.interpretation != "srgb":
        try: img = img.colourspace("srgb")
        except Exception: pass
        if img.bands > 3: img = img.extract_band(0, n=3)
    return img

def finalize_colorspace_for_jpeg(img):
    if img.hasalpha():
        img = img.extract_band(0, n=img.bands - 1)
    if img.bands == 1:
        return img if img.interpretation == "b-w" else img.colourspace("b-w")
    if img.bands != 3 or img.interpretation != "srgb":
        try: img = img.colourspace("srgb")
        except Exception: pass
        if img.bands > 3: img = img.extract_band(0, n=3)
    return img

# -------- 로더 --------
def load_image(in_path: Path, mode: str):
    import pyvips
    if mode == "seq_early_copy":
        img = pyvips.Image.new_from_file(str(in_path), access="sequential").autorot()
        return img.copy_memory(), True
    elif mode == "random_late_copy":
        img = pyvips.Image.new_from_file(str(in_path), access="random").autorot()
        return img, False
    else:
        raise ValueError("unknown loader mode")

# -------- 리사이즈 --------
def resize_cubic(img, tw:int, th:int):
    w, h = img.width, img.height
    s = min(tw/w, th/h)
    if s < 1.0:
        inv = 1.0/s
        shrink = int(inv)
        if shrink >= 2:
            img = img.shrink(shrink, shrink)
            residual = (1.0/inv)*shrink
        else:
            residual = s
        out = img.resize(residual, kernel="cubic", gap=2.0) if residual != 1.0 else img
    else:
        out = img
    if out.width > tw or out.height > th:
        s2 = min(tw/out.width, th/out.height)
        if s2 < 1.0: out = out.resize(s2, kernel="cubic", gap=2.0)
    return out

def resize_only(img, tw:int, th:int):
    s = min(tw/img.width, th/img.height)
    out = img.resize(s, kernel="cubic", gap=2.0) if s != 1.0 else img
    if out.width > tw or out.height > th:
        s2 = min(tw/out.width, th/out.height)
        if s2 < 1.0: out = out.resize(s2, kernel="cubic", gap=2.0)
    return out

# -------- PNG 저장 --------
def save_png_filternone(img, out_path: Path):
    import pyvips
    img2 = to_8bit_if_16bit(finalize_colorspace_for_png(img))
    img2.write_to_file(str(out_path),
                       compression=3, strip=True, interlace=False,
                       bitdepth=8,
                       filter=pyvips.enums.ForeignPngFilter.NONE)

def save_png_subup(img, out_path: Path):
    import pyvips
    img2 = to_8bit_if_16bit(finalize_colorspace_for_png(img))
    f = pyvips.enums.ForeignPngFilter.SUB | pyvips.enums.ForeignPngFilter.UP
    img2.write_to_file(str(out_path),
                       compression=3, strip=True, interlace=False,
                       bitdepth=8,
                       filter=f)

# -------- JPEG 저장 --------
_TURBO = None
def _get_turbo():
    global _TURBO
    if _TURBO is not None: return _TURBO
    try:
        from turbojpeg import TurboJPEG, TJPF_RGB, TJSAMP_420, TJFLAG_FASTDCT
        _TURBO = {"ok": True, "api": TurboJPEG(),
                  "TJPF_RGB": TJPF_RGB, "TJSAMP_420": TJSAMP_420, "TJFLAG_FASTDCT": TJFLAG_FASTDCT}
    except Exception:
        _TURBO = {"ok": False}
    return _TURBO

def save_jpeg_vips(img, out_path: Path):
    img2 = finalize_colorspace_for_jpeg(img)
    img2.write_to_file(str(out_path),
                       Q=95, strip=True, interlace=False,
                       optimize_coding=False, subsample_mode="on")

def save_jpeg_turbo(img, out_path: Path):
    t = _get_turbo()
    if not t["ok"]: raise RuntimeError("turbojpeg not available")
    img2 = finalize_colorspace_for_jpeg(img)
    rgb = img2.write_to_memory()
    width, height = img2.width, img2.height
    stride = img2.bands * width
    jpeg_bytes = t["api"].encode(
        rgb, width, height, stride,
        t["TJPF_RGB"], quality=95,
        subsamp=t["TJSAMP_420"],
        flags=t["TJFLAG_FASTDCT"]
    )
    with open(out_path, "wb") as f:
        f.write(jpeg_bytes)

# -------- (옵션) 비동기 파일쓰기 --------
_IO_POOL = ThreadPoolExecutor(max_workers=2)
def _write_bytes(path: Path, data: bytes):
    with open(path, "wb") as f: f.write(data); return str(path)

def save_png_filternone_async(img, out_path: Path):
    import pyvips
    img2 = to_8bit_if_16bit(finalize_colorspace_for_png(img))
    data = img2.pngsave_buffer(compression=3, strip=True, interlace=False,
                               bitdepth=8, filter=pyvips.enums.ForeignPngFilter.NONE)
    return _IO_POOL.submit(_write_bytes, out_path, data)

def save_jpeg_vips_async(img, out_path: Path):
    img2 = finalize_colorspace_for_jpeg(img)
    data = img2.jpegsave_buffer(Q=95, strip=True, interlace=False,
                                optimize_coding=False, subsample_mode="on")
    return _IO_POOL.submit(_write_bytes, out_path, data)

# -------- 단일 작업 --------
def run_one(in_path: Path, tw:int, th:int, pipeline:str, variant:str, out_dir: Path, loader_mode: str, run_idx:int=0):
    import pyvips
    t0 = time.perf_counter()
    # 로드
    base, materialized = load_image(in_path, loader_mode)
    # 전처
    base = drop_alpha_if_opaque(base)
    base = to_gray_if_possible(base)
    # 리사이즈
    if pipeline == "cubic":
        img = resize_cubic(base, tw, th)
    elif pipeline == "resize_only":
        img = resize_only(base, tw, th)
    else:
        raise ValueError("unknown pipeline")
    if not materialized:
        img = img.copy_memory()  # 저장 직전 전개
    gen_ms = (time.perf_counter()-t0)*1000

    suffix = ".png" if "PNG" in variant else ".jpg"
    out = out_dir / f"{loader_mode}_{pipeline}_{variant}_{tw}x{th}_{run_idx}{suffix}"

    t1 = time.perf_counter()
    if variant == "PNG_c3_filter_none":
        if USE_ASYNC_WRITE: save_png_filternone_async(img, out).result()
        else:               save_png_filternone(img, out)
    elif variant == "PNG_c3_filter_subup":
        save_png_subup(img, out)
    elif variant == "JPG_q95_vips":
        if USE_ASYNC_WRITE: save_jpeg_vips_async(img, out).result()
        else:               save_jpeg_vips(img, out)
    elif variant == "JPG_q95_turbo":
        save_jpeg_turbo(img, out)
    else:
        raise ValueError("unknown variant")

    save_ms = (time.perf_counter()-t1)*1000
    size = out.stat().st_size
    return {"ok": True, "variant": variant, "gen_ms": gen_ms, "save_ms": save_ms,
            "size": size, "path": str(out), "loader_mode": loader_mode, "pipeline": pipeline}

# -------- 배치 실행(워커 병렬) --------
def run_batch_for_workers(in_path: Path, tw:int, th:int, pipeline:str, variant:str,
                          out_root: Path, loader_mode: str, workers:int, repeat:int):
    results = []
    # 제출 개수: repeat * workers (각 워커가 한 번씩 잡게)
    submit_n = max(1, repeat) * max(1, workers)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = []
        for i in range(submit_n):
            futs.append(ex.submit(run_one, in_path, tw, th, pipeline, variant, out_root, loader_mode, i))
        t0 = time.perf_counter()
        for fu in as_completed(futs):
            try:
                results.append(fu.result())
            except Exception as e:
                results.append({"ok": False, "variant": variant, "gen_ms": None, "save_ms": None,
                                "size": 0, "path": f"error:{type(e).__name__}: {e}",
                                "loader_mode": loader_mode, "pipeline": pipeline})
        total_ms = (time.perf_counter()-t0)*1000.0
    # 집계
    oks = [r for r in results if r["ok"]]
    if oks:
        gen_avg = sum(r["gen_ms"] for r in oks)/len(oks)
        save_avg = sum(r["save_ms"] for r in oks)/len(oks)
        size_avg = sum(r["size"] for r in oks)/len(oks)
    else:
        gen_avg = save_avg = size_avg = None
    return results, {"total_ms": total_ms, "count": len(results),
                     "gen_ms_avg": gen_avg, "save_ms_avg": save_avg, "size_avg": size_avg}

# -------- 메인 --------
def main():
    in_path = Path(IMAGE_PATH).resolve()
    if not in_path.exists():
        print(f"[ERR] not found: {in_path}"); sys.exit(1)
    ensure_dir(Path(OUT_DIR))

    set_vips_concurrency(max(VIPS_CONCURRENCY_SWEEP))
    import pyvips  # ensure
    W,H = read_wh(in_path)
    TW,TH = target_wh(W,H, LEVEL)

    turbo_ok = _get_turbo()["ok"]
    variants = ["PNG_c3_filter_none", "PNG_c3_filter_subup", "JPG_q95_vips"]
    if turbo_ok: variants.append("JPG_q95_turbo")

    print(f"[INFO] src={in_path} {W}x{H} → {TW}x{TH}, LEVEL={LEVEL}")
    print(f"[INFO] pipelines={PIPELINES}, VIPS_CONCURRENCY={VIPS_CONCURRENCY_SWEEP}")
    print(f"[INFO] loader_modes={LOADER_MODES}, variants={variants}, repeat={REPEAT}, async_write={USE_ASYNC_WRITE}")
    print(f"[INFO] workers_sweep={WORKERS_SWEEP}, turbojpeg available? {turbo_ok}")

    rows: List[Dict[str, Any]] = []
    summaries: List[Dict[str, Any]] = []

    for conc in VIPS_CONCURRENCY_SWEEP:
        set_vips_concurrency(conc)
        for workers in WORKERS_SWEEP:
            out_root = Path(OUT_DIR) / f"vips_threads_{conc}" / f"workers_{workers}"
            ensure_dir(out_root)
            for loader_mode in LOADER_MODES:
                for pipeline in PIPELINES:
                    for v in variants:
                        # 병렬 배치 실행
                        try:
                            res_list, agg = run_batch_for_workers(
                                in_path, TW, TH, pipeline, v, out_root, loader_mode, workers, REPEAT
                            )
                            for r in res_list:
                                r.update({"conc": conc, "workers": workers})
                                rows.append(r)
                            summaries.append({
                                "variant": v, "pipeline": pipeline, "loader_mode": loader_mode,
                                "conc": conc, "workers": workers, **agg
                            })
                        except Exception as e:
                            rows.append({"ok": False, "variant": v, "conc": conc, "workers": workers,
                                         "gen_ms": None, "save_ms": None, "size": 0,
                                         "path": f"error:{type(e).__name__}: {e}",
                                         "loader_mode": loader_mode, "pipeline": pipeline})

    # 개별 작업 요약
    def show(tag):
        subset = [r for r in rows if r["variant"].startswith(tag)]
        print(f"\n=== SUMMARY [{tag}] ===")
        print(f"{'conc':>4} | {'workers':>7} | {'loader':14} | {'pipeline':12} | {'gen(ms)':>8} | {'save(ms)':>9} | {'size':>10} | note")
        print("-"*130)
        for r in subset:
            g = f"{r['gen_ms']:.1f}" if r["gen_ms"] is not None else "-"
            s = f"{r['save_ms']:.1f}" if r["save_ms"] is not None else "-"
            z = human_kb(r["size"]) if r["size"] else "-"
            note = "" if r["ok"] else r["path"]
            print(f"{r['conc']:>4} | {r['workers']:>7} | {r['loader_mode']:14} | {r['pipeline']:12} | {g:>8} | {s:>9} | {z:>10} | {note}")
        oks = [r for r in subset if r["ok"]]
        if oks:
            best = min(oks, key=lambda x: x["save_ms"])
            print(f"[BEST(single)] conc={best['conc']}, workers={best['workers']}, loader={best['loader_mode']}, "
                  f"pipeline={best['pipeline']}, save_ms={best['save_ms']:.1f}, out={best['path']}")

    # 배치(워커별) 요약
    def show_batch(tag):
        subset = [s for s in summaries if s["variant"].startswith(tag)]
        print(f"\n=== BATCH SUMMARY [{tag}] (by workers) ===")
        print(f"{'conc':>4} | {'workers':>7} | {'loader':14} | {'pipeline':12} | {'TOTAL(ms)':>10} | {'count':>5} | {'gen_avg':>8} | {'save_avg':>8} | {'img/s':>7}")
        print("-"*120)
        for s in subset:
            imgs_per_sec = (s["count"] * 1000.0 / s["total_ms"]) if s["total_ms"] > 0 else 0.0
            g = f"{s['gen_ms_avg']:.1f}" if s['gen_ms_avg'] is not None else "-"
            sv = f"{s['save_ms_avg']:.1f}" if s['save_ms_avg'] is not None else "-"
            print(f"{s['conc']:>4} | {s['workers']:>7} | {s['loader_mode']:14} | {s['pipeline']:12} | "
                  f"{s['total_ms']:>10.1f} | {s['count']:>5} | {g:>8} | {sv:>8} | {imgs_per_sec:>7.2f}")
        if subset:
            best = max(subset, key=lambda x: (x["count"] * 1000.0 / x["total_ms"]) if x["total_ms"]>0 else 0.0)
            print(f"[BEST(batch)] conc={best['conc']}, workers={best['workers']}, loader={best['loader_mode']}, "
                  f"pipeline={best['pipeline']}, THROUGHPUT={best['count']*1000.0/best['total_ms']:.2f} img/s")

    show("PNG_c3")
    show("JPG_q95")
    show_batch("PNG_c3")
    show_batch("JPG_q95")

    print("\n[DONE] finished.")

if __name__ == "__main__":
    main()
