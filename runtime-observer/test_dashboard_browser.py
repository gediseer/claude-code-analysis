from __future__ import annotations

import argparse
import json
from pathlib import Path

from playwright.sync_api import sync_playwright


def run(html_path: Path, output_dir: Path) -> dict:
    output_dir.mkdir(parents=True, exist_ok=True)
    console_errors: list[str] = []
    page_errors: list[str] = []
    requests: list[str] = []
    screenshots: list[str] = []

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(
            executable_path=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
            headless=True,
        )
        page = browser.new_page(viewport={"width": 1440, "height": 1000})
        page.on("console", lambda msg: console_errors.append(msg.text) if msg.type == "error" else None)
        page.on("pageerror", lambda error: page_errors.append(str(error)))
        page.on("request", lambda request: requests.append(request.url) if request.url.startswith(("http://", "https://")) else None)
        page.goto(html_path.resolve().as_uri(), wait_until="load")
        page.wait_for_selector("[data-api-turn]")

        def shot(name: str) -> None:
            destination = output_dir / name
            page.screenshot(path=str(destination), full_page=False)
            screenshots.append(str(destination))

        turns = page.locator('[data-api-turn]')
        assert turns.count() == 4
        assert [turn.get_attribute('data-api-turn-index') for turn in turns.all()] == ['1', '2', '3', '4']
        assert '4 个真实 POST /v1/messages Turn' in page.locator('#turn-count').inner_text()
        shot('api-turns-top-1440x1000.png')

        for index in range(turns.count()):
            turn = turns.nth(index)
            assert turn.locator('[data-section="request"]').count() == 1
            assert turn.locator('[data-section="response"]').count() == 1
            assert turn.locator('[data-section="bridge"]').count() == 1
            assert turn.locator('[data-stop-reason]').count() == 1
            assert turn.locator('[data-usage]').count() == 1
            assert turn.locator('[data-timing]').count() == 1
            assert turn.locator('[data-raw-request]').inner_text().strip()
            assert turn.locator('[data-raw-sse]').inner_text().strip()
            assert turn.locator('[data-sse-event]').count() > 0

        first = turns.first
        assert first.locator('[data-tool-use-id]').count() == 3
        assert first.get_attribute('data-request-id') == 'request-0002'
        assert 'request-0003' in first.locator('[data-section="bridge"]').inner_text()

        for index in range(page.locator('[data-tool-use-id]').count()):
            tool = page.locator('[data-tool-use-id]').nth(index)
            tool_id = tool.get_attribute('data-tool-use-id')
            assert tool.locator(f'[data-tool-result-for="{tool_id}"]').count() >= 1

        assert page.locator('[data-final-result]').count() == 1
        assert turns.last.locator('[data-final-result]').count() == 1
        assert page.locator('[role="tab"]').count() == 0
        assert page.locator('.controls, .kpi, .architecture-panel, #inspector').count() == 0
        assert page.locator('#swimlane-grid, .lane-label, .step-header').count() == 0

        turns.nth(1).scroll_into_view_if_needed()
        shot('api-turns-middle-1440x1000.png')
        turns.last.scroll_into_view_if_needed()
        shot('api-turns-final-1440x1000.png')

        page.set_viewport_size({"width": 390, "height": 844})
        turns.first.scroll_into_view_if_needed()
        page.wait_for_timeout(100)
        shot('api-turns-mobile-390x844.png')
        browser.close()

    result = {
        "html": str(html_path),
        "consoleErrors": console_errors,
        "pageErrors": page_errors,
        "networkRequests": requests,
        "screenshots": screenshots,
    }
    if console_errors or page_errors or requests:
        raise AssertionError(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("html")
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()
    result = run(Path(args.html), Path(args.output_dir))
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
