const { test, expect } = require("@playwright/test");
const fs = require("node:fs/promises");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
let app;
let fixtureNumber = 0;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

async function openReport(browser, mobile = true) {
  const context = await browser.newContext(mobile ? {
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (Android 13; Mobile; rv:147.0) Gecko/147.0 Firefox/147.0"
  } : {});
  const login = await context.request.post(app.baseUrl + "/api/test-login", { data: { userId: "bojan", password: TEST_PASSWORD } });
  expect(login.status()).toBe(200);
  const csrfToken = (await login.json()).csrfToken;
  const client = `Anže PDF QA ${++fixtureNumber}`;
  const date = `2026-09-${String(fixtureNumber).padStart(2, "0")}`;
  const created = await context.request.post(app.baseUrl + "/api/todos", {
    headers: { "X-CSRF-Token": csrfToken },
    data: { title: "Priklop črpalke", client, status: "execution", done: true,
      date, endDate: date, start: "08:00", end: "10:30",
      syncUser: "ibro", assigneeIds: ["ibro"], notes: "Preverjen izvoz PDF – brez potrjevanja obračuna." }
  });
  expect(created.status(), await created.text()).toBe(200);
  const createdTodo = (await created.json()).todos.find((todo) => todo.client === client);
  expect(createdTodo?.id).toBeTruthy();
  const page = await context.newPage();
  // Model a browser that refuses popups: the new flow must not depend on them.
  await page.addInitScript(() => { window.pdfPopupCalls = 0; window.open = () => { window.pdfPopupCalls++; return null; }; });
  const hydrated = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/bootstrap" && !new URL(r.url()).search);
  await page.goto(app.baseUrl);
  await hydrated;
  await expect(page.locator("#app")).toBeVisible();
  if (mobile) {
    await page.locator("#toolsMenu > summary").click();
    await page.locator("#clientBillingMenuBtn").click();
  } else await page.locator("#clientBillingTopViewBtn").click();
  await page.locator("#reportClient").fill(client);
  await expect(page.locator(".open-client-report")).toHaveCount(1);
  await page.locator(".open-client-report").click();
  await expect(page.locator("#exportReportPdf")).toBeEnabled();
  // Compare the same GET representation on both sides, after creation's
  // normalization/background sync (POST intentionally returns a lighter DTO).
  const before = (await (await context.request.get(app.baseUrl + "/api/todos")).json()).todos.find((todo) => todo.id === createdTodo.id);
  return { context, page, client, before, csrfToken };
}

async function checkPdf(download, testInfo, client) {
  expect(download.suggestedFilename()).toMatch(/\.pdf$/i);
  const file = testInfo.outputPath(download.suggestedFilename());
  await download.saveAs(file);
  const bytes = await fs.readFile(file);
  expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  try {
    const content = await (await pdf.getPage(1)).getTextContent();
    const text = content.items.map((item) => item.str || "").join(" ");
    expect(text).toContain(client);
    expect(text).toContain("Priklop črpalke");
  } finally { await pdf.destroy(); }
}

test("mobile: real tap downloads an actual PDF without popup; session protection and report remain intact", async ({ browser }, testInfo) => {
  const { context, page, client, before } = await openReport(browser);
  try {
    let downloadCount = 0;
    page.on("download", () => downloadCount++);
    await page.locator("#exportReportPdf").click();
    const link = page.locator("#clientReportPdfLink");
    await expect(link).toBeVisible();
    expect(downloadCount).toBe(0);
    expect(await page.evaluate(() => window.pdfPopupCalls)).toBe(0);
    await expect(page.locator("#clientReportPdfClient")).toHaveText(client);
    await page.screenshot({ path: testInfo.outputPath("mobile-pdf-ready.png") });
    const download = page.waitForEvent("download");
    await link.tap();
    await checkPdf(await download, testInfo, client);
    await expect(page.locator("#clientReportPdfStatus")).toContainText("Prenos je zahtevan");
    expect(page.url()).toBe(app.baseUrl + "/");
    const href = await link.getAttribute("href");
    const second = await context.request.get(app.baseUrl + href);
    expect(second.status()).toBe(200);
    expect(second.headers()["content-type"]).toContain("application/pdf");
    expect(second.headers()["content-disposition"]).toMatch(/^attachment;/);
    expect(second.headers()["cache-control"]).toContain("no-store");
    const other = await browser.newContext();
    try {
      expect((await other.request.get(app.baseUrl + href)).status()).toBe(401);
      await other.request.post(app.baseUrl + "/api/test-login", { data: { userId: "ibro", password: TEST_PASSWORD } });
      expect((await other.request.get(app.baseUrl + href)).status()).toBe(403);
      await other.request.post(app.baseUrl + "/api/test-login", { data: { userId: "bojan", password: TEST_PASSWORD } });
      expect((await other.request.get(app.baseUrl + href)).status()).toBe(410);
    } finally { await other.close(); }
    await page.locator("#closeClientReportPdf").click();
    await expect(page.locator("#clientReportPdfDialog")).not.toBeVisible();
    const after = (await (await context.request.get(app.baseUrl + "/api/todos")).json()).todos.find((todo) => todo.id === before.id);
    expect(after).toEqual(before);
    await expect(page.locator("#clientDetailTitle")).toContainText(client);
  } finally { await context.close(); }
});

test("desktop keeps one-click PDF download and a visible retry link", async ({ browser }, testInfo) => {
  const { context, page, client } = await openReport(browser, false);
  try {
    const download = page.waitForEvent("download");
    await page.locator("#exportReportPdf").click();
    await checkPdf(await download, testInfo, client);
    await expect(page.locator("#clientReportPdfLink")).toBeVisible();
    expect(await page.evaluate(() => window.pdfPopupCalls)).toBe(0);
  } finally { await context.close(); }
});

test("failed preparation is visible and retry keeps exactly the same selected report", async ({ browser }, testInfo) => {
  const { context, page, client } = await openReport(browser);
  try {
    const payloads = [];
    await page.route("**/api/client-report/pdf-ticket", async (route) => {
      payloads.push(route.request().postDataJSON());
      if (payloads.length === 1) await route.fulfill({ status: 503, json: { error: "Test: strežnik začasno ni dosegljiv." } });
      else await route.continue();
    });
    await page.locator("#exportReportPdf").click();
    await expect(page.locator("#clientReportPdfStatus")).toContainText("Test: strežnik");
    await expect(page.locator("#clientReportPdfLink")).not.toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("mobile-pdf-retry.png") });
    await page.locator("#retryClientReportPdf").click();
    await expect(page.locator("#clientReportPdfLink")).toBeVisible();
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toEqual(payloads[0]);
    const download = page.waitForEvent("download");
    await page.locator("#clientReportPdfLink").tap();
    await checkPdf(await download, testInfo, client);
  } finally { await context.close(); }
});

test("closing a slow request cancels it; a late reply never starts an invisible download", async ({ browser }) => {
  const { context, page } = await openReport(browser);
  let release;
  try {
    const gate = new Promise((resolve) => { release = resolve; });
    let reached;
    const intercepted = new Promise((resolve) => { reached = resolve; });
    await page.route("**/api/client-report/pdf-ticket", async (route) => {
      reached(); await gate;
      await route.fulfill({ status: 201, json: { downloadUrl: "/api/client-report/pdf-download?ticket=late" } }).catch(() => {});
    });
    const downloads = [];
    page.on("download", (download) => downloads.push(download));
    await page.locator("#exportReportPdf").click();
    await intercepted;
    await expect(page.locator("#clientReportPdfStatus")).toContainText("Pripravljam");
    await page.locator("#closeClientReportPdf").click();
    release();
    await page.unrouteAll({ behavior: "wait" });
    await expect(page.locator("#clientReportPdfDialog")).not.toBeVisible();
    await expect(page.locator("#clientReportPdfLink")).not.toHaveAttribute("href");
    expect(downloads).toHaveLength(0);
    await page.locator("#exportReportPdf").click();
    await expect(page.locator("#clientReportPdfLink")).toBeVisible();
    await expect(page.locator("#clientReportPdfLink")).not.toHaveAttribute("href", /ticket=late$/);
  } finally { release?.(); await context.close(); }
});

test("expired visible link is replaced by retry; empty selection cannot export", async ({ browser }) => {
  const { context, page } = await openReport(browser);
  try {
    await page.clock.install();
    await page.locator("#exportReportPdf").click();
    await expect(page.locator("#clientReportPdfLink")).toBeVisible();
    const oldHref = await page.locator("#clientReportPdfLink").getAttribute("href");
    await page.clock.fastForward(4 * 60_000 + 100);
    await expect(page.locator("#clientReportPdfLink")).not.toBeVisible();
    await expect(page.locator("#clientReportPdfStatus")).toContainText("potekla");
    await page.locator("#retryClientReportPdf").click();
    await expect(page.locator("#clientReportPdfLink")).toBeVisible();
    await expect(page.locator("#clientReportPdfLink")).not.toHaveAttribute("href", oldHref);
    await page.locator("#closeClientReportPdf").click();
    await page.locator("#clearClientBillSelection").click();
    await expect(page.locator("#exportReportPdf")).toBeDisabled();
  } finally { await context.close(); }
});

test("stalled preparation times out with retry instead of leaving a blank tab", async ({ browser }) => {
  const { context, page } = await openReport(browser);
  let release;
  try {
    await page.clock.install();
    const gate = new Promise((resolve) => { release = resolve; });
    let reached;
    const intercepted = new Promise((resolve) => { reached = resolve; });
    await page.route("**/api/client-report/pdf-ticket", async (route) => { reached(); await gate; await route.abort().catch(() => {}); });
    await page.locator("#exportReportPdf").click(); await intercepted;
    await page.clock.fastForward(30_001);
    await expect(page.locator("#clientReportPdfStatus")).toContainText("traja predolgo");
    await expect(page.locator("#retryClientReportPdf")).toBeVisible();
    await expect(page.locator("#clientReportPdfLink")).not.toBeVisible();
    expect(await page.evaluate(() => window.pdfPopupCalls)).toBe(0);
  } finally { release?.(); await context.close(); }
});
