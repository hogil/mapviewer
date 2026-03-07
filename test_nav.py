import time
from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(ignore_https_errors=True)
        page = context.new_page()
        
        def safe_print(text):
            try:
                print(f"Browser Console: {text.encode('ascii', 'ignore').decode('ascii')}")
            except Exception:
                pass

        page.on("console", lambda msg: safe_print(msg.text))
        
        print("Navigating to localhost:8443...")
        page.goto("https://localhost:8443", wait_until="networkidle")
        
        page.wait_for_selector("summary.folder", timeout=10000)
        
        folder = page.locator('summary[data-path="palette_5mb"]')
        
        if folder.count() > 0:
            print("Found palette_5mb. Expanding...")
            folder.first.click()
            time.sleep(2)
        else:
            print("Could not find palette_5mb.")
            return
            
        details = folder.first.locator('xpath=..')
        files = details.locator('a[data-path^="palette_5mb/"]')
        count = files.count()
        print(f"Found {count} images in palette_5mb")
        
        last_file = files.nth(count - 1)
        last_file_path = last_file.get_attribute("data-path")
        print(f"Selecting last file: {last_file_path}")
        last_file.click()
        
        time.sleep(2)
        print("Pressing ArrowRight...")
        page.keyboard.press("ArrowRight")
        time.sleep(2)
        
        selected = page.locator('a.selected')
        if selected.count() > 0:
            print(f"After ArrowRight, selected file is: {selected.first.get_attribute('data-path')}")
        else:
            print("No file is selected after ArrowRight")
            
        print("Pressing ArrowLeft...")
        page.keyboard.press("ArrowLeft")
        time.sleep(2)
        
        selected = page.locator('a.selected')
        if selected.count() > 0:
            print(f"After ArrowLeft, selected file is: {selected.first.get_attribute('data-path')}")
        
        browser.close()

if __name__ == "__main__":
    run()
