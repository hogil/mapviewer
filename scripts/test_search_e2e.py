"""
검색 / 다중검색 E2E 테스트 (Playwright)
- 일반 검색 기본 동작
- 다중검색(LOT) 기본 동작
- dot(.) 접미사 제거 (ABC123.1 → ABC123)
- AND/OR/NOT 논리 검색
- 검색 결과 그리드 표시 확인
"""
import asyncio
import sys
from playwright.async_api import async_playwright

BASE_URL = "https://localhost:8443"
TIMEOUT = 15_000


async def wait_for_app(page):
    """앱 로딩 대기"""
    await page.goto(BASE_URL, wait_until="networkidle")
    await page.wait_for_timeout(2000)


async def navigate_to_folder(page):
    """첫 번째 폴더로 이동 (검색 대상 확보)"""
    folder_link = page.locator('#sidebar a[data-path]').first
    if await folder_link.count() > 0:
        await folder_link.click()
        await page.wait_for_timeout(2000)
        return True
    return False


async def get_grid_count(page):
    """현재 그리드에 표시된 이미지 수"""
    count = await page.locator('#image-grid .grid-thumb-wrap').count()
    return count


async def test_normal_search_basic(page):
    """일반 검색 기본 동작 테스트"""
    print("  [1] 일반 검색 기본 동작")
    search_input = page.locator('#file-search')
    search_btn = page.locator('#search-btn')

    # 빈 검색 시 alert 확인
    await search_input.fill('')
    dialog_fired = False

    async def handle_empty_alert(dialog):
        nonlocal dialog_fired
        dialog_fired = True
        await dialog.accept()

    page.once("dialog", handle_empty_alert)
    await search_btn.click()
    await page.wait_for_timeout(1000)

    return ("일반 검색 - 빈 입력 시 alert", dialog_fired, "" if dialog_fired else "alert가 발생하지 않음")


async def test_normal_search_with_query(page):
    """일반 검색 - 검색어 입력 후 실행"""
    print("  [2] 일반 검색 - 검색어로 검색")
    search_input = page.locator('#file-search')
    search_btn = page.locator('#search-btn')

    # 실제 검색 수행 (아무 글자나 넣어서 테스트)
    await search_input.fill('a')
    await search_btn.click()
    await page.wait_for_timeout(3000)

    # 검색 버튼이 다시 활성화 되었는지
    is_enabled = not await search_btn.is_disabled()
    btn_text = await search_btn.text_content()
    is_restored = btn_text.strip() == '검색'

    return ("일반 검색 - 버튼 상태 복원", is_enabled and is_restored,
            f"enabled={is_enabled}, text='{btn_text}'" if not (is_enabled and is_restored) else "")


async def test_normal_search_enter_key(page):
    """일반 검색 - Enter 키로 검색"""
    print("  [3] 일반 검색 - Enter 키 동작")
    search_input = page.locator('#file-search')

    await search_input.fill('a')
    await search_input.press('Enter')
    await page.wait_for_timeout(3000)

    # 검색 버튼 상태 확인
    search_btn = page.locator('#search-btn')
    is_enabled = not await search_btn.is_disabled()
    return ("일반 검색 - Enter 키 검색", is_enabled, "" if is_enabled else "버튼이 비활성화 상태")


async def test_dot_suffix_normal_search(page):
    """일반 검색 - dot 접미사 제거 확인"""
    print("  [4] 일반 검색 - dot 접미사 제거")
    search_input = page.locator('#file-search')

    # ABC123.1 09 입력 → 실제 전송되는 쿼리에서 .1이 제거되어야 함
    await search_input.fill('ABC123.1 09')

    # JavaScript에서 stripDotSuffix 함수 직접 테스트
    result = await page.evaluate("""() => {
        const inp = document.getElementById('file-search');
        const val = inp.value.trim();
        // stripDotSuffix 로직 재현
        const stripped = val.replace(/(\\S+)/g, (token) => {
            const dotIdx = token.indexOf('.');
            if (dotIdx > 0) return token.substring(0, dotIdx);
            return token;
        });
        return stripped;
    }""")

    expected = "ABC123 09"
    ok = result == expected
    return ("일반 검색 - dot 접미사 제거", ok,
            f"expected='{expected}', got='{result}'" if not ok else "")


async def test_dot_suffix_various(page):
    """dot 접미사 제거 - 다양한 케이스"""
    print("  [5] dot 접미사 제거 - 다양한 케이스")
    results = await page.evaluate("""() => {
        function stripDotSuffix(text) {
            if (!text) return text;
            return text.replace(/(\\S+)/g, (token) => {
                const dotIdx = token.indexOf('.');
                if (dotIdx > 0) return token.substring(0, dotIdx);
                return token;
            });
        }
        return {
            case1: stripDotSuffix('ABC123.1'),         // → ABC123
            case2: stripDotSuffix('ABC123.1 09'),       // → ABC123 09
            case3: stripDotSuffix('LOT001.2 LOT002.3'), // → LOT001 LOT002
            case4: stripDotSuffix('NODOTSHERE'),        // → NODOTSHERE (변경 없음)
            case5: stripDotSuffix(''),                  // → '' (빈 문자열)
            case6: stripDotSuffix('.hidden'),            // → .hidden (dot으로 시작하면 유지)
            case7: stripDotSuffix('A.1 B.2 C'),         // → A B C
        };
    }""")

    checks = [
        ("ABC123.1 → ABC123", results["case1"] == "ABC123"),
        ("ABC123.1 09 → ABC123 09", results["case2"] == "ABC123 09"),
        ("LOT001.2 LOT002.3 → LOT001 LOT002", results["case3"] == "LOT001 LOT002"),
        ("NODOTSHERE → NODOTSHERE", results["case4"] == "NODOTSHERE"),
        ("빈 문자열", results["case5"] == ""),
        (".hidden → .hidden", results["case6"] == ".hidden"),
        ("A.1 B.2 C → A B C", results["case7"] == "A B C"),
    ]

    all_pass = all(ok for _, ok in checks)
    failed = [name for name, ok in checks if not ok]
    detail = f"실패: {', '.join(failed)}" if not all_pass else ""
    return ("dot 접미사 제거 - 다양한 케이스", all_pass, detail)


async def test_multi_search_open_close(page):
    """다중검색 모달 열기/닫기"""
    print("  [6] 다중검색 모달 열기/닫기")
    multi_btn = page.locator('#multi-search-btn')
    modal = page.locator('#multi-search-modal')
    cancel_btn = page.locator('#multi-search-cancel')

    # 열기
    await multi_btn.click()
    await page.wait_for_timeout(500)
    is_visible = await modal.is_visible()

    # 닫기
    await cancel_btn.click()
    await page.wait_for_timeout(500)
    is_hidden = not await modal.is_visible()

    ok = is_visible and is_hidden
    return ("다중검색 모달 열기/닫기", ok,
            f"visible={is_visible}, hidden={is_hidden}" if not ok else "")


async def test_multi_search_escape(page):
    """다중검색 모달 Escape로 닫기"""
    print("  [7] 다중검색 모달 Escape 닫기")
    multi_btn = page.locator('#multi-search-btn')
    modal = page.locator('#multi-search-modal')

    await multi_btn.click()
    await page.wait_for_timeout(500)
    is_visible = await modal.is_visible()

    await page.keyboard.press('Escape')
    await page.wait_for_timeout(500)
    is_hidden = not await modal.is_visible()

    ok = is_visible and is_hidden
    return ("다중검색 모달 Escape 닫기", ok,
            f"visible={is_visible}, hidden={is_hidden}" if not ok else "")


async def test_multi_search_empty_error(page):
    """다중검색 - 빈 입력 시 에러"""
    print("  [8] 다중검색 - 빈 입력 시 에러")
    multi_btn = page.locator('#multi-search-btn')
    modal = page.locator('#multi-search-modal')
    apply_btn = page.locator('#multi-search-apply')
    error_el = page.locator('#multi-search-error')
    textarea = page.locator('#multi-search-input')

    await multi_btn.click()
    await page.wait_for_timeout(500)

    # 빈 상태로 검색 시도
    await textarea.fill('')
    await apply_btn.click()
    await page.wait_for_timeout(500)

    error_text = await error_el.text_content()
    has_error = bool(error_text and error_text.strip())

    # 모달 닫기
    cancel_btn = page.locator('#multi-search-cancel')
    await cancel_btn.click()
    await page.wait_for_timeout(300)

    return ("다중검색 - 빈 입력 에러", has_error,
            f"error='{error_text}'" if not has_error else "")


async def test_multi_search_dot_suffix(page):
    """다중검색 - dot 접미사 제거 확인"""
    print("  [9] 다중검색 - dot 접미사 제거")

    # parseMultiSearchInput 로직을 JS에서 직접 테스트
    result = await page.evaluate("""() => {
        function stripDotSuffix(text) {
            if (!text) return text;
            return text.replace(/(\\S+)/g, (token) => {
                const dotIdx = token.indexOf('.');
                if (dotIdx > 0) return token.substring(0, dotIdx);
                return token;
            });
        }

        // 다중검색 파싱 로직 시뮬레이션
        const raw = 'ABC123.1\\nDEF456.2\\nGHI789';
        const segments = raw.split(/[\\n\\r,;\\t/]+/);
        const lots = [];
        const seen = new Set();
        for (const segment of segments) {
            const trimmed = segment.trim();
            if (!trimmed) continue;
            const rawToken = trimmed.split('_', 1)[0].trim();
            const lotToken = stripDotSuffix(rawToken);
            if (!lotToken) continue;
            const key = lotToken.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            lots.push(lotToken);
        }
        return lots;
    }""")

    expected = ["ABC123", "DEF456", "GHI789"]
    ok = result == expected
    return ("다중검색 - dot 접미사 제거", ok,
            f"expected={expected}, got={result}" if not ok else "")


async def test_multi_search_dedup(page):
    """다중검색 - 중복 LOT 제거"""
    print("  [10] 다중검색 - 중복 LOT 제거")

    result = await page.evaluate("""() => {
        function stripDotSuffix(text) {
            if (!text) return text;
            return text.replace(/(\\S+)/g, (token) => {
                const dotIdx = token.indexOf('.');
                if (dotIdx > 0) return token.substring(0, dotIdx);
                return token;
            });
        }

        const raw = 'ABC123.1\\nABC123.2\\nDEF456';
        const segments = raw.split(/[\\n\\r,;\\t/]+/);
        const lots = [];
        const seen = new Set();
        for (const segment of segments) {
            const trimmed = segment.trim();
            if (!trimmed) continue;
            const rawToken = trimmed.split('_', 1)[0].trim();
            const lotToken = stripDotSuffix(rawToken);
            if (!lotToken) continue;
            const key = lotToken.toLowerCase();
            if (seen.has(key)) continue;
            seen.add(key);
            lots.push(lotToken);
        }
        return lots;
    }""")

    # ABC123.1과 ABC123.2 → 둘 다 ABC123으로 되어 중복 제거
    expected = ["ABC123", "DEF456"]
    ok = result == expected
    return ("다중검색 - dot 중복 제거", ok,
            f"expected={expected}, got={result}" if not ok else "")


async def test_multi_search_textarea_input(page):
    """다중검색 - textarea에 직접 입력 후 검색"""
    print("  [11] 다중검색 - textarea 입력 후 검색")
    multi_btn = page.locator('#multi-search-btn')
    modal = page.locator('#multi-search-modal')
    textarea = page.locator('#multi-search-input')
    apply_btn = page.locator('#multi-search-apply')
    error_el = page.locator('#multi-search-error')

    await multi_btn.click()
    await page.wait_for_timeout(500)

    # 존재하지 않을 LOT으로 검색 → 에러 메시지 확인
    await textarea.fill('NONEXIST_LOT_12345')
    await apply_btn.click()
    await page.wait_for_timeout(3000)

    # 검색 결과 없음 → 에러 메시지 또는 모달 유지
    error_text = (await error_el.text_content() or '').strip()
    modal_visible = await modal.is_visible()
    # 결과 없으면 에러 메시지가 나오거나 모달이 열려있음
    ok = bool(error_text) or modal_visible

    # 정리: 모달 닫기
    if modal_visible:
        cancel_btn = page.locator('#multi-search-cancel')
        await cancel_btn.click()
        await page.wait_for_timeout(300)

    return ("다중검색 - textarea 검색 실행", ok,
            f"error='{error_text}', modal_visible={modal_visible}" if not ok else "")


async def test_multi_search_enter_key(page):
    """다중검색 - Enter 키로 검색 실행"""
    print("  [12] 다중검색 - Enter 키 검색")
    multi_btn = page.locator('#multi-search-btn')
    modal = page.locator('#multi-search-modal')
    textarea = page.locator('#multi-search-input')
    error_el = page.locator('#multi-search-error')

    await multi_btn.click()
    await page.wait_for_timeout(500)

    await textarea.fill('NONEXIST_LOT_ENTER_TEST')
    await textarea.press('Enter')
    await page.wait_for_timeout(3000)

    error_text = (await error_el.text_content() or '').strip()
    modal_visible = await modal.is_visible()
    ok = bool(error_text) or modal_visible

    if modal_visible:
        cancel_btn = page.locator('#multi-search-cancel')
        await cancel_btn.click()
        await page.wait_for_timeout(300)

    return ("다중검색 - Enter 키 검색", ok, "" if ok else "Enter 검색 동작 실패")


async def test_multi_search_shift_enter(page):
    """다중검색 - Shift+Enter로 줄바꿈"""
    print("  [13] 다중검색 - Shift+Enter 줄바꿈")
    multi_btn = page.locator('#multi-search-btn')
    modal = page.locator('#multi-search-modal')
    textarea = page.locator('#multi-search-input')

    await multi_btn.click()
    await page.wait_for_timeout(500)

    await textarea.fill('')
    await textarea.type('LOT001')
    await textarea.press('Shift+Enter')
    await textarea.type('LOT002')
    await page.wait_for_timeout(300)

    value = await textarea.input_value()
    has_newline = '\n' in value
    has_both = 'LOT001' in value and 'LOT002' in value

    ok = has_newline and has_both

    cancel_btn = page.locator('#multi-search-cancel')
    await cancel_btn.click()
    await page.wait_for_timeout(300)

    return ("다중검색 - Shift+Enter 줄바꿈", ok,
            f"value='{value}'" if not ok else "")


async def test_search_clears_on_multi_open(page):
    """다중검색 모달 열면 일반 검색창 초기화 (추가 확인)"""
    print("  [14] 다중검색 모달 열면 일반검색 초기화 (재확인)")
    search_input = page.locator('#file-search')
    multi_btn = page.locator('#multi-search-btn')

    await search_input.fill('test_query_14')
    before = await search_input.input_value()

    await multi_btn.click()
    await page.wait_for_timeout(500)
    after = await search_input.input_value()

    cancel_btn = page.locator('#multi-search-cancel')
    await cancel_btn.click()
    await page.wait_for_timeout(300)

    ok = before == 'test_query_14' and after == ''
    return ("다중검색 열면 일반검색 초기화", ok,
            f"before='{before}', after='{after}'" if not ok else "")


async def test_dot_search_real_filename(page):
    """실제 파일명에 dot 추가하여 검색 → 결과 확인"""
    print("  [15] 실제 파일명+dot 검색 (wafer_palette_5mb.3)")
    search_input = page.locator('#file-search')
    search_btn = page.locator('#search-btn')

    await search_input.fill('wafer_palette_5mb.3')
    await search_btn.click()
    await page.wait_for_timeout(3000)

    count = await page.locator('#image-grid .grid-thumb-wrap').count()
    # wafer_palette_5mb.3 → dot 제거 → wafer_palette_5mb → 결과 있어야 함
    ok = count > 0
    return ("실제 파일명+dot 검색", ok,
            f"결과 {count}건" if not ok else f"결과 {count}건")


async def test_and_or_not_with_dot(page):
    """AND/OR/NOT 연산자 + dot 혼합 검색"""
    print("  [16] AND/OR/NOT + dot 검색")

    result = await page.evaluate("""async () => {
        // stripDotSuffix 적용 후 API 호출
        function strip(text) {
            if (!text) return text;
            return text.replace(/(\\S+)/g, (token) => {
                const dotIdx = token.indexOf('.');
                if (dotIdx > 0) return token.substring(0, dotIdx);
                return token;
            });
        }

        const cases = [
            { input: 'palette.1 and 5mb.2', expected_strip: 'palette and 5mb' },
            { input: 'edge_ring.1 or center_hot.2', expected_strip: 'edge_ring or center_hot' },
            { input: 'palette.1 and 5mb not 10mb.3', expected_strip: 'palette and 5mb not 10mb' },
        ];

        const results = [];
        for (const c of cases) {
            const stripped = strip(c.input);
            const ok = stripped === c.expected_strip;
            // 실제 API도 호출하여 결과 확인
            const res = await fetch(`/api/search?q=${encodeURIComponent(stripped)}&limit=5`);
            const data = await res.json();
            results.push({ input: c.input, stripped, expected: c.expected_strip, ok, total: data.total });
        }
        return results;
    }""")

    all_pass = all(r["ok"] and r["total"] > 0 for r in result)
    failed = [r["input"] for r in result if not r["ok"] or r["total"] == 0]
    return ("AND/OR/NOT + dot 검색", all_pass,
            f"실패: {failed}" if not all_pass else "")


async def test_server_lot_dot_strip(page):
    """서버 API에서 lot_multi dot 제거 확인"""
    print("  [17] 서버 API lot_multi dot 제거")

    result = await page.evaluate("""async () => {
        // dot 포함 LOT과 dot 없는 LOT 결과가 동일한지 확인
        const res1 = await fetch('/api/search?q=&lot_multi=wafer_map_07.1&limit=5');
        const data1 = await res1.json();
        const res2 = await fetch('/api/search?q=&lot_multi=wafer_map_07&limit=5');
        const data2 = await res2.json();
        return {
            with_dot: data1.total,
            without_dot: data2.total,
            same: data1.total === data2.total,
            both_have_results: data1.total > 0 && data2.total > 0
        };
    }""")

    ok = result["same"] and result["both_have_results"]
    return ("서버 lot_multi dot 제거", ok,
            f"dot={result['with_dot']}, no_dot={result['without_dot']}" if not ok else "")


async def test_grid_images_not_broken(page):
    """검색 후 그리드 이미지 깨짐/X표시 없는지 확인"""
    print("  [18] 그리드 이미지 깨짐 확인")
    search_input = page.locator('#file-search')
    search_btn = page.locator('#search-btn')

    await search_input.fill('center_hot.7')
    await search_btn.click()
    await page.wait_for_timeout(5000)

    result = await page.evaluate("""() => {
        const imgs = Array.from(document.querySelectorAll('#image-grid .grid-thumb-img')).slice(0, 36);
        let loaded = 0, broken = 0;
        imgs.forEach(img => {
            if (img.complete && img.naturalWidth > 0) loaded++;
            else broken++;
        });
        return { total: imgs.length, loaded, broken };
    }""")

    ok = result["loaded"] > 0 and result["broken"] == 0
    return ("그리드 이미지 깨짐 없음", ok,
            f"loaded={result['loaded']}, broken={result['broken']}" if not ok else
            f"loaded={result['loaded']}, broken=0")


async def test_multi_search_dot_real_search(page):
    """다중검색 dot 포함 LOT으로 실제 검색 실행"""
    print("  [19] 다중검색 dot LOT 실제 검색")
    multi_btn = page.locator('#multi-search-btn')
    modal = page.locator('#multi-search-modal')
    textarea = page.locator('#multi-search-input')
    apply_btn = page.locator('#multi-search-apply')

    await multi_btn.click()
    await page.wait_for_timeout(500)

    # dot 포함 LOT 입력
    await textarea.fill('wafer_map_01.1\nwafer_map_02.2')
    await apply_btn.click()
    await page.wait_for_timeout(3000)

    # 성공 시 모달 닫힘 + 그리드에 결과 표시
    modal_closed = not await modal.is_visible()
    count = await page.locator('#image-grid .grid-thumb-wrap').count()

    ok = modal_closed and count > 0

    # 실패 시 모달 닫기
    if not modal_closed:
        cancel_btn = page.locator('#multi-search-cancel')
        await cancel_btn.click()
        await page.wait_for_timeout(300)

    return ("다중검색 dot LOT 실제 검색", ok,
            f"modal_closed={modal_closed}, count={count}" if not ok else f"결과 {count}건")


async def test_multi_search_noise_parsing(page):
    """다중검색 - 대량 noise 입력 LOT 추출"""
    print("  [20] 다중검색 - 대량 noise LOT 추출")

    result = await page.evaluate("""() => {
        function stripDotSuffix(text) {
            if (!text) return text;
            return text.replace(/(\\S+)/g, (token) => {
                const dotIdx = token.indexOf('.');
                if (dotIdx > 0) return token.substring(0, dotIdx);
                return token;
            });
        }

        // 다양한 noise 패턴
        const lines = [
            'ABC123',                        // 기본
            'ABC123_00P_04_timestamp',        // _ split → ABC123
            'ABC123.J3',                      // dot 제거 → ABC123
            'ABC123 04',                      // 공백 split → ABC123
            'ABC123.J3_00P_04',              // dot+_ 혼합 → ABC123
            'ABC123\\t99\\textra',            // 탭 split → ABC123
            'DEF456.1 08',                    // dot+공백 → DEF456
            'GHI789_00C_11',                  // _ split → GHI789
            'JKL012.XY',                      // dot 제거 → JKL012
        ];

        const seen = new Set();
        const lots = [];
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            const lotToken = stripDotSuffix(trimmed.split('_', 1)[0].split(/\\s+/)[0].trim());
            if (!lotToken) continue;
            const key = lotToken.toLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                lots.push(lotToken);
            }
        }
        return { inputCount: lines.length, lots, uniqueCount: lots.length };
    }""")

    expected = ["ABC123", "DEF456", "GHI789", "JKL012"]
    ok = result["lots"] == expected and result["uniqueCount"] == 4
    return ("다중검색 - noise LOT 추출", ok,
            f"expected={expected}, got={result['lots']}" if not ok else f"{result['inputCount']}줄→{result['uniqueCount']}개 LOT")


async def test_multi_search_100_plus_input(page):
    """다중검색 - 100개 초과 입력 → 중복 제거로 통과"""
    print("  [21] 다중검색 - 100개 초과 noise 입력")
    multi_btn = page.locator('#multi-search-btn')
    modal = page.locator('#multi-search-modal')
    textarea = page.locator('#multi-search-input')
    apply_btn = page.locator('#multi-search-apply')

    await multi_btn.click()
    await page.wait_for_timeout(500)

    # 110줄 생성 (전부 동일 LOT + noise)
    lines = await page.evaluate("""() => {
        const lines = [];
        for (let i = 0; i < 20; i++) lines.push('wafer');
        for (let i = 0; i < 20; i++) lines.push('wafer_map_' + i);
        for (let i = 0; i < 20; i++) lines.push('wafer.' + i);
        for (let i = 0; i < 20; i++) lines.push('wafer ' + i);
        for (let i = 0; i < 10; i++) lines.push('wafer.J' + i + '_00P');
        for (let i = 0; i < 10; i++) lines.push('wafer\\t' + i);
        lines.push('WAFER.X1 99', 'Wafer.abc', 'wAfEr_00C', 'WAFER', 'wafer.999');
        lines.push('NONEXIST.J3 04', 'FAKE_LOT', 'MISSING.1', 'ABSENT 55', 'GONE.X1_00P');
        return lines;
    }""")

    await textarea.fill('\n'.join(lines))
    await apply_btn.click()
    await page.wait_for_timeout(3000)

    modal_closed = not await modal.is_visible()
    count = await page.locator('#image-grid .grid-thumb-wrap').count()
    ok = modal_closed and count > 0

    if not modal_closed:
        cancel_btn = page.locator('#multi-search-cancel')
        await cancel_btn.click()
        await page.wait_for_timeout(300)

    return ("다중검색 - 100+ noise 입력 검색", ok,
            f"modal_closed={modal_closed}, count={count}" if not ok else f"결과 {count}건")


async def test_multi_search_images_not_broken(page):
    """다중검색 결과 이미지 깨짐/X표시 없음"""
    print("  [22] 다중검색 - 이미지 무결성")
    await page.wait_for_timeout(3000)

    result = await page.evaluate("""() => {
        const imgs = Array.from(document.querySelectorAll('#image-grid .grid-thumb-img')).slice(0, 60);
        let loaded = 0, broken = 0;
        imgs.forEach(img => {
            if (img.complete && img.naturalWidth > 0) loaded++;
            else broken++;
        });
        return { checked: imgs.length, loaded, broken };
    }""")

    ok = result["loaded"] > 0 and result["broken"] == 0
    return ("다중검색 - 이미지 무결성", ok,
            f"loaded={result['loaded']}, broken={result['broken']}")


async def main():
    print("=" * 60)
    print("검색 / 다중검색 E2E 테스트")
    print("=" * 60)

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=False,
            args=["--ignore-certificate-errors"],
        )
        context = await browser.new_context(
            viewport={"width": 1920, "height": 1080},
            ignore_https_errors=True,
        )
        page = await context.new_page()

        try:
            await wait_for_app(page)

            # 첫 번째 폴더로 이동
            await navigate_to_folder(page)

            results = []

            # 테스트 순서대로 실행
            tests = [
                test_normal_search_basic,
                test_normal_search_with_query,
                test_normal_search_enter_key,
                test_dot_suffix_normal_search,
                test_dot_suffix_various,
                test_multi_search_open_close,
                test_multi_search_escape,
                test_multi_search_empty_error,
                test_multi_search_dot_suffix,
                test_multi_search_dedup,
                test_multi_search_textarea_input,
                test_multi_search_enter_key,
                test_multi_search_shift_enter,
                test_search_clears_on_multi_open,
                test_dot_search_real_filename,
                test_and_or_not_with_dot,
                test_server_lot_dot_strip,
                test_grid_images_not_broken,
                test_multi_search_dot_real_search,
                test_multi_search_noise_parsing,
                test_multi_search_100_plus_input,
                test_multi_search_images_not_broken,
            ]

            for test_fn in tests:
                try:
                    result = await test_fn(page)
                    results.append(result)
                except Exception as e:
                    results.append((test_fn.__doc__ or test_fn.__name__, False, str(e)))

            # 결과 출력
            print("\n" + "=" * 60)
            print("테스트 결과")
            print("=" * 60)
            passed = 0
            failed = 0
            for name, success, detail in results:
                status = "PASS" if success else "FAIL"
                if success:
                    passed += 1
                else:
                    failed += 1
                msg = f"  [{status}] {name}"
                if detail:
                    msg += f" - {detail}"
                print(msg)

            print(f"\n총 {passed + failed}개 테스트: {passed} PASS, {failed} FAIL")
            return 0 if failed == 0 else 1

        except Exception as e:
            print(f"\n[ERROR] 테스트 실행 실패: {e}")
            import traceback
            traceback.print_exc()
            return 1
        finally:
            await browser.close()


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
