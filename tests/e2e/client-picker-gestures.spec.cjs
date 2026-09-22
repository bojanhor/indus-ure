const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

async function openPicker(page) {
  await page.goto(app.baseUrl);
  await page.locator("#localTestUser").selectOption("bojan");
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
  // Persist fixtures only in the isolated test app, so background refreshes
  // cannot replace a temporary UI-only client list during a held gesture.
  await page.evaluate(async () => {
    for (let index = 0; index < 12; index += 1) {
      const name = `Gesture client ${index}`;
      if (!state.clients.some(client => client.name === name)) {
        await api("/api/clients", { method: "POST", body: JSON.stringify({ name, search: name }) });
      }
    }
    await loadAll();
  });
  await page.locator("#newTodoButton").click();
  await expect(page.locator("#todoDialog")).toBeFocused();
  await page.locator("#todoFormClient").fill("Gesture client");
  await expect(page.locator("#todoFormClientSuggestions")).toBeVisible();
}

async function checkboxes(page) {
  return page.locator('#todoForm input[type="checkbox"], #todoForm input[type="radio"]').evaluateAll(inputs =>
    inputs.map(input => ({ id: input.id, value: input.value, checked: input.checked })));
}

async function suggestionOverCheckbox(page) {
  const point = await page.evaluate(() => {
    for (const input of document.querySelectorAll('#todoFormAssignees input')) {
      const box = input.getBoundingClientRect();
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      const option = document.elementFromPoint(x, y)?.closest(".client-autocomplete-option");
      if (option) return { x, y, value: option.querySelector("strong").textContent };
    }
    return null;
  });
  expect(point, "test must actually select a suggestion covering an assignee checkbox").not.toBeNull();
  return point;
}

for (const width of [390, 1280]) {
  test(`client picker waits for release and cannot click an underlying checkbox (${width}px)`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: true });
    const page = await context.newPage();
    try {
      await openPicker(page);
      const before = await checkboxes(page);
      const point = await suggestionOverCheckbox(page);
      await page.mouse.move(point.x, point.y);
      await page.mouse.down();
      // A held press must not collapse the overlay (including the former 120ms blur delay).
      await page.waitForTimeout(200);
      await expect(page.locator("#todoFormClientSuggestions")).toBeVisible();
      await expect(page.locator("#todoFormClient")).toHaveValue("Gesture client");
      await page.mouse.up();
      await expect(page.locator("#todoFormClient")).toHaveValue(point.value);
      await expect(page.locator("#todoFormClientSuggestions")).toBeHidden();
      expect(await checkboxes(page)).toEqual(before);

      await page.locator("#todoFormClient").fill("Gesture client");
      const touchPoint = await suggestionOverCheckbox(page);
      await page.touchscreen.tap(touchPoint.x, touchPoint.y);
      await expect(page.locator("#todoFormClient")).toHaveValue(touchPoint.value);
      await expect(page.locator("#todoFormClientSuggestions")).toBeHidden();
      expect(await checkboxes(page)).toEqual(before);
      await page.screenshot({ path: test.info().outputPath("selected-client-no-checkbox-change.png") });

      // No global click blocker: an intentional following click on the worker still works.
      const worker = page.locator('#todoFormAssignees input').first();
      const checked = await worker.isChecked();
      await worker.click();
      expect(await worker.isChecked()).toBe(!checked);
    } finally { await context.close(); }
  });
}

test("client picker supports keyboard focus, cancelled touch and outside dismissal", async ({ page }) => {
  await openPicker(page);
  const before = await checkboxes(page);
  const option = page.locator(".client-autocomplete-option").first();
  // Starting a scroll/cancelled touch must not select a client on pointerdown.
  await option.dispatchEvent("pointerdown", { pointerId: 9, pointerType: "touch", isPrimary: true, button: 0, buttons: 1 });
  await option.dispatchEvent("pointercancel", { pointerId: 9, pointerType: "touch", isPrimary: true });
  await expect(page.locator("#todoFormClient")).toHaveValue("Gesture client");
  await expect(page.locator("#todoFormClientSuggestions")).toBeVisible();
  const list = page.locator("#todoFormClientSuggestions");
  await list.hover();
  await page.mouse.wheel(0, 220);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator("#todoFormClient")).toHaveValue("Gesture client");
  await page.mouse.wheel(0, -1000);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBe(0);
  await option.focus();
  await page.waitForTimeout(200);
  await expect(page.locator("#todoFormClientSuggestions")).toBeVisible();
  await option.press("Enter");
  await expect(page.locator("#todoFormClient")).toHaveValue("Gesture client 0");
  await expect(page.locator("#todoFormClientSuggestions")).toBeHidden();
  expect(await checkboxes(page)).toEqual(before);

  await page.locator("#todoFormClient").fill("Gesture client");
  await page.locator("#todoFormClient").press("ArrowDown");
  await page.locator("#todoFormClient").press("Enter");
  await expect(page.locator("#todoFormClient")).toHaveValue("Gesture client 1");
  await expect(page.locator("#todoFormClientSuggestions")).toBeHidden();
  await page.locator("#todoFormClient").fill("Gesture client");
  await page.locator("#todoFormMaterial").click();
  await expect(page.locator("#todoFormClientSuggestions")).toBeHidden();
});
