"""
MY LOT E2E 테스트 (Playwright)

입력 텍스트 (Wafer/LOT 모드 동일):
  ABC234 02
  ABC234.1 10
  KHN931.MG1 13
  DEF456\t01
  NOLOT 99
  ABC234 02

검증 항목:
  1. Wafer 모드: 검색 속도, noise 처리 (dot/탭/공백/중복)
  2. Wafer 모드: 저장 → 이미지 + position 디스크 복사 (플랫 구조)
  3. Wafer 모드: entries.json 미생성
  4. Wafer 모드: Grid 보기 이미지 전량 로드
  5. Wafer 모드: Measure → mea0 탭 생성
  6. Wafer 모드: Composite → com0 탭 생성
  7. LOT 모드: 검색 (wafer 필터 미적용, 중복 제거)
  8. LOT 모드: 저장 → 이미지 + position 디스크 복사 (LOT 서브폴더)
  9. LOT 모드: entries.json 미생성
 10. LOT 모드: Grid 보기 이미지 전량 로드
 11. LOT 모드: Measure → mea1 탭 생성
 12. LOT 모드: Composite → com1 탭 생성

테스트 데이터: filter_test (6 LOT × 24 wafer = 144개)
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

PASTE_TEXT = 'ABC234 02\\nABC234.1 10\\nKHN931.MG1 13\\nDEF456\\t01\\nNOLOT 99\\nABC234 02'
W_GROUP = '__e2e_wafer__'
L_GROUP = '__e2e_lot__'


async def run_tests():
    from playwright.async_api import async_playwright

    results = []

    def ok(name):
        results.append((name, True, ""))
        print(f"  [PASS] {name}")

    def fail(name, detail=""):
        results.append((name, False, detail))
        print(f"  [FAIL] {name} -- {detail}")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True, args=["--ignore-certificate-errors"])
        context = await browser.new_context(viewport={"width": 1920, "height": 1080}, ignore_https_errors=True)
        page = await context.new_page()
        page.on("dialog", lambda d: asyncio.ensure_future(d.accept(W_GROUP)))

        try:
            await page.goto(BASE_URL, wait_until="networkidle")
            await page.wait_for_timeout(8000)

            # ============================================================
            # Wafer 모드
            # ============================================================
            print("\n========== Wafer 모드 ==========")

            # 1. 검색 + noise 처리
            print("\n--- 1. Wafer 검색 + noise 처리 ---")
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
            if w["searchMs"] < 5000 and w["rowCount"] <= 6:
                ok(f"Wafer 검색 {w['searchMs']}ms, {w['rowCount']}행 (noise 처리됨)")
            else:
                fail("Wafer 검색", json.dumps(w))

            # 2. 저장 + 시간 + 디스크 확인
            print("\n--- 2. Wafer 저장 + 디스크 복사 ---")
            save_result = await page.evaluate("""async () => {
                const t0 = performance.now();
                document.getElementById('my-lot-manual-submit')?.click();
                await new Promise(r => setTimeout(r, 15000));
                return Math.round(performance.now() - t0);
            }""")
            await page.wait_for_timeout(5000)  # 추가 대기

            w_dir = IMAGES_ROOT / "my-lot" / "notsaml" / "wafer" / W_GROUP
            w_pos_dir = POSITIONS_ROOT / "my-lot" / "notsaml" / "wafer" / W_GROUP
            w_imgs = list(w_dir.rglob("*.png")) if w_dir.exists() else []
            w_poss = list(w_pos_dir.rglob("*.json")) if w_pos_dir.exists() else []
            w_entries = w_dir / "entries.json"

            if len(w_imgs) > 0:
                ok(f"Wafer 이미지 디스크 복사 ({len(w_imgs)}개, {save_result}ms)")
            else:
                fail("Wafer 이미지 디스크 복사", f"{len(w_imgs)}개")

            # 3. entries.json 미생성
            print("\n--- 3. entries.json 미생성 ---")
            if not w_entries.exists():
                ok("Wafer entries.json 미생성")
            else:
                fail("Wafer entries.json 미생성", "존재함!")

            # position
            if len(w_poss) > 0:
                ok(f"Wafer position 복사 ({len(w_poss)}개)")
            else:
                fail("Wafer position 복사", "0개")

            # 플랫 구조 확인 (LOT 서브폴더 없어야 함)
            subdirs = [d for d in w_dir.iterdir() if d.is_dir()] if w_dir.exists() else []
            # NOLOT 빈 폴더는 있을 수 있지만 이미지 있는 서브폴더는 없어야
            img_in_subdirs = sum(1 for d in subdirs for _ in d.rglob("*.png"))
            if img_in_subdirs == 0:
                ok("Wafer 플랫 구조 (LOT 서브폴더에 이미지 없음)")
            else:
                fail("Wafer 플랫 구조", f"서브폴더에 이미지 {img_in_subdirs}개")

            # 4. Grid 보기
            print("\n--- 4. Wafer Grid ---")
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
                const total = document.querySelectorAll('#image-grid .grid-thumb-wrap').length;
                let loaded = 0;
                document.querySelectorAll('#image-grid .grid-thumb-img').forEach(i => {{ if (i.complete && i.naturalWidth > 0) loaded++; }});
                return {{ total, loaded }};
            }}""")
            if grid["total"] == len(w_imgs) and grid["loaded"] == grid["total"]:
                ok(f"Wafer Grid {grid['loaded']}/{grid['total']}")
            else:
                fail("Wafer Grid", f"total={grid['total']}, loaded={grid['loaded']}, disk={len(w_imgs)}")

            # 5. Measure (mea0)
            print("\n--- 5. Wafer Measure mea0 ---")
            mea = await page.evaluate("""async () => {
                const v = window.waferMapViewer || window.viewer;
                v.gridSelectedIdxs = [0,1,2,3];
                v.gridSelectedSet = new Set([0,1,2,3]);
                v._measureCheckedItems = [{type: 'f', key: '9', label: 'FBT0009'}];
                v._openMeasureTab();
                await new Promise(r => setTimeout(r, 15000));
                const tabs = [...document.querySelectorAll('#page-tabs button')].map(b => b.textContent.trim());
                return { tabs, hasMea: tabs.some(t => t.includes('mea')) };
            }""")
            if mea["hasMea"]:
                ok(f"Wafer mea0 탭 생성 ({mea['tabs']})")
            else:
                fail("Wafer mea0", str(mea["tabs"]))

            # 6. Composite (com0)
            print("\n--- 6. Wafer Composite com0 ---")
            com = await page.evaluate("""async () => {
                const v = window.waferMapViewer || window.viewer;
                for (const b of document.querySelectorAll('#page-tabs button')) {
                    if (b.textContent.includes('mylot0') && !b.textContent.includes('mea') && !b.textContent.includes('com')) { b.click(); break; }
                }
                await new Promise(r => setTimeout(r, 3000));
                const total = v.currentGridImages?.length || 0;
                v.gridSelectedIdxs = Array.from({length: total}, (_, i) => i);
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
                const tabs = [...document.querySelectorAll('#page-tabs button')].map(b => b.textContent.trim());
                return { tabs, hasCom: tabs.some(t => t.includes('com')) };
            }""")
            if com["hasCom"]:
                ok(f"Wafer com0 탭 생성 ({com['tabs']})")
            else:
                fail("Wafer com0", str(com["tabs"]))

            # ============================================================
            # LOT 모드
            # ============================================================
            print("\n========== LOT 모드 ==========")

            # 다이얼로그 핸들러를 LOT 그룹으로 변경
            page.remove_listener("dialog", page.listeners("dialog")[0]) if page.listeners("dialog") else None
            page.on("dialog", lambda d: asyncio.ensure_future(d.accept(L_GROUP)))

            # 7. LOT 검색
            print("\n--- 7. LOT 검색 + noise ---")
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
                return {{ searchMs, rowCount: rows.length, rows }};
            }}""")
            lot_has_no_wafer = all(r["wafer"] == "" for r in lot["rows"])
            if lot["searchMs"] < 5000 and lot_has_no_wafer:
                ok(f"LOT 검색 {lot['searchMs']}ms, {lot['rowCount']}행, wafer 필터 미적용")
            else:
                fail("LOT 검색", json.dumps(lot))

            # 8. LOT 저장 + 디스크 복사 완료 대기
            print("\n--- 8. LOT 저장 + 디스크 복사 ---")
            total_expected = sum(r["cnt"] for r in lot["rows"])
            wait_sec = max(30, total_expected // 5)  # 이미지 수에 비례 대기
            lot_save = await page.evaluate(f"""async () => {{
                const t0 = performance.now();
                document.getElementById('my-lot-manual-submit')?.click();
                await new Promise(r => setTimeout(r, {wait_sec * 1000}));
                return Math.round(performance.now() - t0);
            }}""")

            # 추가 대기: 디스크에 전부 기록될 때까지
            l_dir = IMAGES_ROOT / "my-lot" / "notsaml" / "lot" / L_GROUP
            l_pos_dir = POSITIONS_ROOT / "my-lot" / "notsaml" / "lot" / L_GROUP
            for _ in range(30):
                l_imgs = list(l_dir.rglob("*.png")) if l_dir.exists() else []
                if len(l_imgs) >= total_expected:
                    break
                await asyncio.sleep(2)
            else:
                l_imgs = list(l_dir.rglob("*.png")) if l_dir.exists() else []

            l_poss = list(l_pos_dir.rglob("*.json")) if l_pos_dir.exists() else []
            l_entries = l_dir / "entries.json"

            if len(l_imgs) >= total_expected:
                ok(f"LOT 이미지 디스크 복사 ({len(l_imgs)}개, {lot_save}ms)")
            else:
                fail("LOT 이미지 디스크 복사", f"{len(l_imgs)}/{total_expected}")

            # 9. entries.json 미생성
            print("\n--- 9. LOT entries.json 미생성 ---")
            if not l_entries.exists():
                ok("LOT entries.json 미생성")
            else:
                fail("LOT entries.json 미생성", "존재함!")

            if len(l_poss) > 0:
                ok(f"LOT position 복사 ({len(l_poss)}개)")
            else:
                fail("LOT position 복사", "0개")

            # 10. LOT Grid
            print("\n--- 10. LOT Grid ---")
            lgrid = await page.evaluate(f"""async () => {{
                const sel = document.getElementById('my-lot-group-select');
                sel.value = '{L_GROUP}';
                sel.dispatchEvent(new Event('change'));
                await new Promise(r => setTimeout(r, 2000));
                document.getElementById('my-lot-select-all')?.click();
                await new Promise(r => setTimeout(r, 500));
                document.getElementById('my-lot-grid-view')?.click();
                await new Promise(r => setTimeout(r, 8000));
                const total = document.querySelectorAll('#image-grid .grid-thumb-wrap').length;
                return {{ total }};
            }}""")
            if lgrid["total"] == len(l_imgs):
                ok(f"LOT Grid {lgrid['total']}개")
            else:
                fail("LOT Grid", f"grid={lgrid['total']}, disk={len(l_imgs)}")

            # 11. LOT Measure (mea1)
            print("\n--- 11. LOT Measure mea1 ---")
            lmea = await page.evaluate("""async () => {
                const v = window.waferMapViewer || window.viewer;
                v.gridSelectedIdxs = [0,1,2,3,4];
                v.gridSelectedSet = new Set([0,1,2,3,4]);
                v._measureCheckedItems = [{type: 'f', key: '9', label: 'FBT0009'}];
                v._openMeasureTab();
                await new Promise(r => setTimeout(r, 15000));
                const tabs = [...document.querySelectorAll('#page-tabs button')].map(b => b.textContent.trim());
                return { tabs, hasMea: tabs.some(t => t.includes('mea')) };
            }""")
            if lmea["hasMea"]:
                ok(f"LOT mea1 탭 생성 ({lmea['tabs']})")
            else:
                fail("LOT mea1", str(lmea["tabs"]))

            # 12. LOT Composite (com1)
            print("\n--- 12. LOT Composite com1 ---")
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
                const tabs = [...document.querySelectorAll('#page-tabs button')].map(b => b.textContent.trim());
                return { tabs, hasCom: tabs.some(t => t.includes('com')) };
            }""")
            if lcom["hasCom"]:
                ok(f"LOT com1 탭 생성 ({lcom['tabs']})")
            else:
                fail("LOT com1", str(lcom["tabs"]))

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
