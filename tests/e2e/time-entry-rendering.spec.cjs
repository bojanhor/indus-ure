const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");

let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

// Run this spec with --browser=webkit as well as the normal Chromium suite.
// WebKit on Windows covers layout/interaction, not the physical iOS compositor.
for (const userId of ["ibro", "bojan"]) {
  test(`${userId}: time-entry fields remain reachable through scroll, resize and draft restore`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      deviceScaleFactor: 3
    });
    const page = await context.newPage();
    try {
      await page.goto(app.baseUrl);
      await page.locator("#localTestUser").selectOption(userId);
      await page.locator("#localTestPassword").fill(TEST_PASSWORD);
      await page.locator("#localTestLoginBtn").click();
      await expect(page.locator("#app")).toBeVisible();
      if (userId === "bojan") {
        await page.locator("#activeWorkContext").click();
        await page.locator('[data-work-context="worker:bojan"]').click();
      }
      await page.locator("#writeHoursButton").click();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await page.locator("#todoFormTask").fill(`Preizkus izrisa ${userId}`);
      await page.locator("#todoFormNotes").fill("Podroben opis del na terenu.\n".repeat(30));
      await page.locator("#todoFormMaterial").fill("Kabel, vtičnica, varovalka.");

      const scroller = page.locator("#todoDialogScroll");
      const fieldIds = ["todoFormTask", "todoFormMaterial", "todoFormClientKm", "todoFormBillingKm", "todoFormQuickTimeStart", "todoFormQuickTimeEnd", "todoFooterSave"];
      for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 320, height: 568 }]) {
        await page.setViewportSize(viewport);
        for (const id of fieldIds) {
          const field = page.locator(`#${id}`);
          await field.scrollIntoViewIfNeeded();
          await expect(field).toBeVisible();
          const geometry = await field.evaluate((element) => {
            const box = element.getBoundingClientRect();
            const scroll = document.getElementById("todoDialogScroll");
            const bounds = scroll.getBoundingClientRect();
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
            return {
              fullyVisible: box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1,
              hit: hit === element || element.contains(hit),
              horizontalOverflow: scroll.scrollWidth - scroll.clientWidth,
              dialogScrollTop: document.getElementById("todoDialog").scrollTop,
              headerPosition: getComputedStyle(document.querySelector("#todoForm > .modal-head")).position
            };
          });
          expect(geometry, `${viewport.width}px, ${id}`).toEqual({
            fullyVisible: true, hit: true, horizontalOverflow: 0,
            dialogScrollTop: 0, headerPosition: "relative"
          });
        }
      }

      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator("#todoFormQuickTimeStart").click();
      await page.locator('[data-time-picker-hour="8"]').click();
      await page.locator('[data-time-picker-minute="15"]').click();
      await page.locator('[data-time-picker-hour="10"]').click();
      await page.locator('[data-time-picker-minute="30"]').click();
      await expect(page.locator("#todoFormQuickTimeDuration")).toHaveText("Skupaj 2 h 15 min");
      await expect(page.locator("#todoFormQuickTimePicker")).toHaveClass(/is-closed/);
      await page.locator("#todoFormQuickTimeStart").scrollIntoViewIfNeeded();
      await page.screenshot({ path: test.info().outputPath("time-entry-date-phone.png") });

      // A focus change and a complete scroll round trip must not blank the form.
      await page.locator("#todoFormTask").click();
      await page.locator("#todoFormTask").press("Tab");
      await scroller.evaluate((element) => { element.scrollTop = 0; });
      const before = await page.locator("#todoDialog").screenshot({ caret: "hide", animations: "disabled" });
      await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
      await page.locator("#todoFooterSave").scrollIntoViewIfNeeded();
      await scroller.evaluate((element) => { element.scrollTop = 0; });
      await expect.poll(async () => Buffer.compare(before, await page.locator("#todoDialog").screenshot({ caret: "hide", animations: "disabled" }))).toBe(0);

      // Refresh restores the unfinished form; missing-client validation stays
      // visible and focusable in the new scroller rather than under the header.
      await page.reload();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormTask")).toHaveValue(`Preizkus izrisa ${userId}`);
      await page.locator("#saveTodoDialog").click();
      await expect(page.locator(".form-validation-error")).toContainText("Za vpis ur izberi stranko.");
      await expect(page.locator("#todoFormClient")).toBeFocused();
      await page.locator("#todoFormClient").fill("Testna stranka izrisa");
      await page.locator("#todoFormClientKm").fill("2");
      await page.locator("#todoFormBillingKm").fill("2");
      const saved = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/todos");
      await page.locator("#saveTodoDialog").click();
      await expect(page.locator("#todoDialog")).toBeHidden();
      expect((await saved).ok()).toBe(true);
      await expect(page.locator("#todoForm")).not.toHaveClass(/is-saving/);
      await page.locator("#writeHoursButton").click();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
      await expect(page.locator("#todoFormTask")).toHaveValue("");
      await page.locator("#todoFormTask").fill("Preverba potrditve nič kilometrine");
      await page.locator("#todoFormClient").fill("Testna stranka izrisa");
      await page.locator("#saveTodoDialog").click();
      await expect(page.locator("#appConfirmDialog")).toBeVisible();
      await page.locator("#appConfirmCancel").click();
      await expect(page.locator("#appConfirmDialog")).toBeHidden();
      await expect(page.locator("#saveTodoDialog")).toBeEnabled();
    } finally {
      await context.close();
    }
  });
}
