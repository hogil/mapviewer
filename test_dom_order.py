import time
from playwright.sync_api import sync_playwright

def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(ignore_https_errors=True)
        page = context.new_page()
        
        page.goto("https://localhost:8443", wait_until="networkidle")
        page.wait_for_selector("summary.folder", timeout=10000)
        
        folders = page.locator('summary.folder').all_inner_texts()
        print("Folder order in DOM:")
        for idx, f in enumerate(folders):
            print(f"{idx}: {f.strip().encode('ascii', 'ignore').decode('ascii')}")
            
        browser.close()

if __name__ == "__main__":
    run()
