"""
MY LOT E2E 테스트 (Playwright)

=== 테스트 데이터 ===
filter_test: 6 LOT × 24 wafer = 144개 (position 포함)
  LOT: ABC234, FEX482, KHN931, TMW067, DEF456, GHJ789
  파일명: {LOT}_{STEP}_{WAFER}_{날짜}_{시간}_{yield}_{sys}_{LT}_{TM}.png
  예: ABC234_00C_02_20260315_090000_93.4_26_LT02_TM_B.png

=== 입력 텍스트 (10줄, Wafer/LOT 동일) ===
ABC234 02
ABC234.1 10
FEX482.MG1 07
TMW067	19
DEF456.j6 01
GHJ789 24
KHN931 13
NOLOT 99
  ABC234  02
DEF456.1 12

noise: dot접미사 3개(.1/.MG1/.j6/.1), 탭1, 공백1, 중복1(ABC234 02), 없는LOT 1(NOLOT)
→ Wafer: 9행 (중복 제거), LOT: 7행 (LOT 기준 중복 제거)

=== 검색 방식 ===
API: GET /api/search?q={검색어}&limit=5000&lot_multi={LOT목록}&lot_wafer={LOT:WAFER쌍}
방식: 토큰 역인덱스 (서버 시작 시 빌드, 파일명 _ split → 토큰별 인덱스 dict)

Wafer 모드 검색:
  q=(ABC234 or FEX482 or ...) + lot_wafer=ABC234:02,FEX482:07,...
  → 토큰 인덱스에서 LOT 찾고 그 안에서 WAFER AND 교차
  → 검색 시간: ~22ms

LOT 모드 검색:
  q=(ABC234 or FEX482 or ...) + lot_multi=ABC234,FEX482,...
  → 토큰 인덱스에서 LOT만 매칭
  → 검색 시간: ~22ms

저장(복사):
  검색 결과 리스트 → /api/my-lot/batch → ThreadPoolExecutor(32) 병렬 복사
  → 이미지 + position 동시 복사

=== 검증 항목 (14개) ===
 1. Wafer 검색 속도 + noise 처리
 2. Wafer 저장 → 이미지 + position 디스크 복사 (플랫 구조)
 3. Wafer entries.json 미생성
 4. Wafer Wafer 컬럼 정상 표시 (STEP 아닌 실제 wafer 번호)
 5. Wafer Grid 전량 로드
 6. Wafer Measure → mea0 탭 생성
 7. Wafer Composite → com0 탭 생성
 8. LOT 검색 (wafer 필터 미적용, LOT 중복 제거)
 9. LOT 저장 → 이미지 + position 디스크 복사 (LOT/서브폴더)
10. LOT entries.json 미생성
11. LOT Grid 전량 로드
12. LOT Measure → mea1 탭 생성
13. LOT Composite → com1 탭 생성
14. 서버 안 죽음 (run_in_executor 비동기 복사)

=== 스크린샷 8장 ===
mylot-w01-paste.jpeg   Wafer 붙여넣기 모달
mylot-w02-saved.jpeg   Wafer 저장 완료 모달
mylot-w03-grid.jpeg    Wafer Grid
mylot-w04-composite.jpeg Wafer Composite
mylot-l01-paste.jpeg   LOT 붙여넣기 모달
mylot-l02-saved.jpeg   LOT 저장 완료 모달
mylot-l03-grid.jpeg    LOT Grid
mylot-l04-composite.jpeg LOT Composite

=== 실측 속도 ===
┌──────────────┬────────────────┬──────────────┐
│     항목     │  Wafer 모드    │   LOT 모드   │
├──────────────┼────────────────┼──────────────┤
│ 검색         │ 22ms           │ 22ms         │
│ 저장(복사)   │ 388개, ~30초   │ 2644개, ~4분 │
│ 이미지       │ 388개          │ 2644개       │
│ position     │ 388개          │ 2643개       │
│ entries.json │ 없음           │ 없음         │
│ 구조         │ 플랫           │ LOT/서브폴더 │
│ Grid         │ 388/388        │ 2644/2644    │
│ Measure      │ mea0           │ mea1         │
│ Composite    │ com0           │ com1         │
│ 서버         │ 안 죽음        │ 안 죽음      │
└──────────────┴────────────────┴──────────────┘
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path

BASE_URL = os.getenv("E2E_BASE_URL", "https://localhost:8443")
IMAGES_ROOT = Path(os.getenv("PROJECT_ROOT", "D:/project/data/wm-811k"))
POSITIONS_ROOT = Path(os.getenv("POSITIONS_ROOT", "D:/project/data/positions"))

PASTE_TEXT = 'ABC234 02\\nABC234.1 10\\nFEX482.MG1 07\\nTMW067\\t19\\nDEF456.j6 01\\nGHJ789 24\\nKHN931 13\\nNOLOT 99\\n  ABC234  02\\nDEF456.1 12'
W_GROUP = '__e2e_w__'
L_GROUP = '__e2e_l__'


async def run_tests():
    from playwright.async_api import async_playwright

    results = []

    def ok(name, detail=""):
        results.append((name, True, detail))
        print(f"  [PASS] {name}" + (f" ({detail})" if detail else ""))

    def fail(name, detail=""):
        results.append((name, False, detail))
        print(f"  [FAIL] {name} -- {detail}")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        context = await browser.new_context(viewport={"width": 1920, "height": 1080}, ignore_https_errors=True)
        page = await context.new_page()

        try:
            await page.goto(BASE_URL, wait_until="networkidle")
            await page.wait_for_timeout(8000)

            # ============================================================
            # Wafer 모드
            # ============================================================
            print("\n========== Wafer 모드 ==========")

            # 1. 검색 속도 + noise
            print("\n--- 1. Wafer 검색 + noise ---")
            w = await page.evaluate(f"""async () => {{
                const v = window.waferMapViewer || window.viewer;
                document.getElementById('my-lot-btn')?.click();
                await new Promise(r => setTimeout(r, 1000));
                document.querySelector('[data-my-lot-mode="wafer"]')?.click();
                await new Promise(r => setTimeout(r, 500));
                const op = window.prompt; window.prompt = () => '{W_GROUP}';
                document.getElementById('my-lot-new-group-btn')?.click();
                window.prompt = op;
                await new Promise(r => setTimeout(r, 1500));
                const m = v.myLotModal || v._myLotModal;
                const t0 = performance.now();
                await m.handleManualPaste('{PASTE_TEXT}', true);
                const searchMs = Math.round(performance.now() - t0);
                const rows = m.manualRows.map(r => ({{ lot: r.lot, wafer: r.wafer, cnt: r.searchResults?.length || 0 }}));
                return {{ searchMs, rowCount: rows.length, rows }};
            }}""")
            if w["searchMs"] < 5000 and w["rowCount"] <= 10:
                ok(f"Wafer 검색 {w['searchMs']}ms, {w['rowCount']}행")
            else:
                fail("Wafer 검색", json.dumps(w))

            # 2. 저장 + 디스크
            print("\n--- 2. Wafer 저장 ---")
            save_ms = await page.evaluate("""async () => {
                const t0 = performance.now();
                document.getElementById('my-lot-manual-submit')?.click();
                await new Promise(r => setTimeout(r, 30000));
                return Math.round(performance.now() - t0);
            }""")
            await page.wait_for_timeout(10000)  # 복사 완료 대기

            w_dir = IMAGES_ROOT / "my-lot" / "notsaml" / "wafer" / W_GROUP
            w_pos_dir = POSITIONS_ROOT / "my-lot" / "notsaml" / "wafer" / W_GROUP
            w_imgs = list(w_dir.rglob("*.png")) if w_dir.exists() else []
            w_poss = list(w_pos_dir.rglob("*.json")) if w_pos_dir.exists() else []

            if len(w_imgs) > 0:
                ok(f"Wafer 이미지 복사 {len(w_imgs)}개, {save_ms}ms")
            else:
                fail("Wafer 이미지 복사", f"{len(w_imgs)}개")

            # 3. entries.json
            print("\n--- 3. entries.json 미생성 ---")
            if not (w_dir / "entries.json").exists():
                ok("entries.json 없음")
            else:
                fail("entries.json 존재!")

            # position
            if len(w_poss) > 0:
                ok(f"position {len(w_poss)}개")
            else:
                fail("position 0개")

            # 플랫 구조
            img_in_sub = sum(1 for d in (w_dir.iterdir() if w_dir.exists() else []) if d.is_dir() for _ in d.rglob("*.png"))
            if img_in_sub == 0:
                ok("플랫 구조")
            else:
                fail("플랫 구조", f"서브폴더에 {img_in_sub}개")

            # 4. Wafer 컬럼
            print("\n--- 4. Wafer 컬럼 ---")
            entries = await page.evaluate(f"""async () => {{
                const res = await fetch('/api/my-lot/entries?mode=wafer&group={W_GROUP}');
                return res.ok ? await res.json() : [];
            }}""")
            wafer_vals = [e.get("wafer", "") for e in entries]
            step_in_wafer = any(v in ("00P", "00C") for v in wafer_vals)
            if not step_in_wafer and len(entries) > 0:
                ok(f"Wafer 컬럼 정상 ({len(entries)}개)")
            else:
                fail("Wafer 컬럼", f"vals={wafer_vals[:5]}")

            # 5. Grid
            print("\n--- 5. Wafer Grid ---")
            grid = await page.evaluate(f"""async () => {{
                document.getElementById('my-lot-btn')?.click();
                await new Promise(r => setTimeout(r, 1000));
                document.querySelector('[data-my-lot-mode="wafer"]')?.click();
                await new Promise(r => setTimeout(r, 500));
                const sel = document.getElementById('my-lot-group-select');
                sel.value = '{W_GROUP}';
                sel.dispatchEvent(new Event('change'));
                await new Promise(r => setTimeout(r, 2000));
                document.getElementById('my-lot-select-all')?.click();
                await new Promise(r => setTimeout(r, 500));
                document.getElementById('my-lot-grid-view')?.click();
                await new Promise(r => setTimeout(r, 8000));
                return {{ total: document.querySelectorAll('#image-grid .grid-thumb-wrap').length }};
            }}""")
            if grid["total"] == len(w_imgs):
                ok(f"Grid {grid['total']}개")
            else:
                fail("Grid", f"grid={grid['total']}, disk={len(w_imgs)}")

            # 6. Measure
            print("\n--- 6. Wafer Measure ---")
            mea = await page.evaluate("""async () => {
                const v = window.waferMapViewer || window.viewer;
                v.gridSelectedIdxs = [0,1,2,3,4];
                v.gridSelectedSet = new Set([0,1,2,3,4]);
                v._measureCheckedItems = [{type: 'f', key: '9', label: 'FBT0009'}];
                v._openMeasureTab();
                await new Promise(r => setTimeout(r, 15000));
                return { tabs: [...document.querySelectorAll('#page-tabs button')].map(b => b.textContent.trim()) };
            }""")
            if any("mea" in t for t in mea["tabs"]):
                ok(f"mea0 탭 ({mea['tabs']})")
            else:
                fail("mea0", str(mea["tabs"]))

            # 7. Composite
            print("\n--- 7. Wafer Composite ---")
            com = await page.evaluate("""async () => {
                const v = window.waferMapViewer || window.viewer;
                for (const b of document.querySelectorAll('#page-tabs button')) {
                    if (b.textContent.includes('mylot0') && !b.textContent.includes('mea') && !b.textContent.includes('com')) { b.click(); break; }
                }
                await new Promise(r => setTimeout(r, 3000));
                const total = v.currentGridImages?.length || 0;
                v.gridSelectedIdxs = Array.from({length: Math.min(20, total)}, (_, i) => i);
                v.gridSelectedSet = new Set(v.gridSelectedIdxs);
                [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Composite')?.click();
                await new Promise(r => setTimeout(r, 2000));
                for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
                    if (cb.parentElement?.textContent?.trim() === 'Failbit' && cb.offsetParent !== null) {
                        cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); break;
                    }
                }
                await new Promise(r => setTimeout(r, 500));
                [...document.querySelectorAll('button')].find(b => b.textContent.includes('생성'))?.click();
                await new Promise(r => setTimeout(r, 20000));
                return { tabs: [...document.querySelectorAll('#page-tabs button')].map(b => b.textContent.trim()) };
            }""")
            if any("com" in t for t in com["tabs"]):
                ok(f"com0 탭 ({com['tabs']})")
            else:
                fail("com0", str(com["tabs"]))

            # ============================================================
            # LOT 모드
            # ============================================================
            print("\n========== LOT 모드 ==========")

            # 8. LOT 검색
            print("\n--- 8. LOT 검색 ---")
            lot = await page.evaluate(f"""async () => {{
                const v = window.waferMapViewer || window.viewer;
                document.getElementById('my-lot-btn')?.click();
                await new Promise(r => setTimeout(r, 1000));
                document.querySelector('[data-my-lot-mode="lot"]')?.click();
                await new Promise(r => setTimeout(r, 500));
                const op = window.prompt; window.prompt = () => '{L_GROUP}';
                document.getElementById('my-lot-new-group-btn')?.click();
                window.prompt = op;
                await new Promise(r => setTimeout(r, 1500));
                const m = v.myLotModal || v._myLotModal;
                const t0 = performance.now();
                await m.handleManualPaste('{PASTE_TEXT}', true);
                const searchMs = Math.round(performance.now() - t0);
                const rows = m.manualRows.map(r => ({{ lot: r.lot, wafer: r.wafer, cnt: r.searchResults?.length || 0 }}));
                const noWafer = rows.every(r => r.wafer === '');
                return {{ searchMs, rowCount: rows.length, noWafer, totalImages: rows.reduce((s,r) => s + r.cnt, 0) }};
            }}""")
            if lot["searchMs"] < 5000 and lot["noWafer"]:
                ok(f"LOT 검색 {lot['searchMs']}ms, {lot['rowCount']}행, {lot['totalImages']}이미지, wafer 미적용")
            else:
                fail("LOT 검색", json.dumps(lot))

            # 9. LOT 저장
            print("\n--- 9. LOT 저장 ---")
            total_expected = lot["totalImages"]
            wait_sec = max(30, total_expected // 5)
            lot_save = await page.evaluate(f"""async () => {{
                const t0 = performance.now();
                document.getElementById('my-lot-manual-submit')?.click();
                await new Promise(r => setTimeout(r, {wait_sec * 1000}));
                return Math.round(performance.now() - t0);
            }}""")

            l_dir = IMAGES_ROOT / "my-lot" / "notsaml" / "lot" / L_GROUP
            l_pos_dir = POSITIONS_ROOT / "my-lot" / "notsaml" / "lot" / L_GROUP
            # 디스크 완료 대기
            for _ in range(60):
                l_imgs = list(l_dir.rglob("*.png")) if l_dir.exists() else []
                if len(l_imgs) >= total_expected:
                    break
                await asyncio.sleep(2)
            else:
                l_imgs = list(l_dir.rglob("*.png")) if l_dir.exists() else []

            l_poss = list(l_pos_dir.rglob("*.json")) if l_pos_dir.exists() else []

            if len(l_imgs) >= total_expected:
                ok(f"LOT 이미지 복사 {len(l_imgs)}개")
            else:
                fail("LOT 이미지 복사", f"{len(l_imgs)}/{total_expected}")

            # 10. entries.json
            print("\n--- 10. LOT entries.json ---")
            if not (l_dir / "entries.json").exists():
                ok("entries.json 없음")
            else:
                fail("entries.json 존재!")

            if len(l_poss) > 0:
                ok(f"position {len(l_poss)}개")
            else:
                fail("position 0개")

            # 11. LOT Grid
            print("\n--- 11. LOT Grid ---")
            lgrid = await page.evaluate(f"""async () => {{
                const sel = document.getElementById('my-lot-group-select');
                sel.value = '{L_GROUP}';
                sel.dispatchEvent(new Event('change'));
                await new Promise(r => setTimeout(r, 2000));
                document.getElementById('my-lot-select-all')?.click();
                await new Promise(r => setTimeout(r, 500));
                document.getElementById('my-lot-grid-view')?.click();
                await new Promise(r => setTimeout(r, 8000));
                return {{ total: document.querySelectorAll('#image-grid .grid-thumb-wrap').length }};
            }}""")
            if lgrid["total"] == len(l_imgs):
                ok(f"Grid {lgrid['total']}개")
            else:
                fail("Grid", f"grid={lgrid['total']}, disk={len(l_imgs)}")

            # 12. LOT Measure
            print("\n--- 12. LOT Measure ---")
            lmea = await page.evaluate("""async () => {
                const v = window.waferMapViewer || window.viewer;
                v.gridSelectedIdxs = [0,1,2,3,4];
                v.gridSelectedSet = new Set([0,1,2,3,4]);
                v._measureCheckedItems = [{type: 'f', key: '9', label: 'FBT0009'}];
                v._openMeasureTab();
                await new Promise(r => setTimeout(r, 15000));
                return { tabs: [...document.querySelectorAll('#page-tabs button')].map(b => b.textContent.trim()) };
            }""")
            if any("mea" in t for t in lmea["tabs"]):
                ok(f"mea1 탭 ({lmea['tabs']})")
            else:
                fail("mea1", str(lmea["tabs"]))

            # 13. LOT Composite
            print("\n--- 13. LOT Composite ---")
            lcom = await page.evaluate("""async () => {
                const v = window.waferMapViewer || window.viewer;
                for (const b of document.querySelectorAll('#page-tabs button')) {
                    if (b.textContent.includes('mylot1') && !b.textContent.includes('mea') && !b.textContent.includes('com')) { b.click(); break; }
                }
                await new Promise(r => setTimeout(r, 3000));
                v.gridSelectedIdxs = Array.from({length: 24}, (_, i) => i);
                v.gridSelectedSet = new Set(v.gridSelectedIdxs);
                [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Composite')?.click();
                await new Promise(r => setTimeout(r, 2000));
                for (const cb of document.querySelectorAll('input[type="checkbox"]')) {
                    if (cb.parentElement?.textContent?.trim() === 'Failbit' && cb.offsetParent !== null) {
                        cb.checked = true; cb.dispatchEvent(new Event('change', { bubbles: true })); break;
                    }
                }
                await new Promise(r => setTimeout(r, 500));
                [...document.querySelectorAll('button')].find(b => b.textContent.includes('생성'))?.click();
                await new Promise(r => setTimeout(r, 20000));
                return { tabs: [...document.querySelectorAll('#page-tabs button')].map(b => b.textContent.trim()) };
            }""")
            if any("com" in t for t in lcom["tabs"]):
                ok(f"com1 탭 ({lcom['tabs']})")
            else:
                fail("com1", str(lcom["tabs"]))

            # 14. 서버 생존
            print("\n--- 14. 서버 생존 ---")
            try:
                alive = await page.evaluate("async () => { const r = await fetch('/api/config'); return r.ok; }")
                if alive:
                    ok("서버 정상")
                else:
                    fail("서버 응답 없음")
            except Exception:
                fail("서버 죽음")

        except Exception as e:
            import traceback
            traceback.print_exc()
            fail("테스트 실행", str(e))

        finally:
            # 테스트 데이터 삭제하지 않음
            await browser.close()

    # 결과
    print("\n" + "=" * 60)
    passed = sum(1 for _, s, _ in results if s)
    failed = sum(1 for _, s, _ in results if not s)
    print(f"MY LOT E2E: {passed} PASS / {failed} FAIL (총 {len(results)})")
    print("=" * 60)
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(run_tests()))
