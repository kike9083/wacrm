const { chromium } = require("C:/Users/soporte/AppData/Local/Temp/opencode/pw-qa/node_modules/playwright");

const BASE = "https://varios-wacrm.fjueze.easypanel.host";
const EMAIL = "qa-20260803@example.com";
const PASSWORD = "TestPass123!";

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("response", (res) => {
    if (res.status() >= 400) {
      console.log(`${res.status()} ${res.request().method()} ${res.url()}`);
    }
  });

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await Promise.all([
    page.waitForURL("**/dashboard", { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(5000);
  await browser.close();
})().catch((err) => { console.error("SCRIPT ERROR:", err.message); process.exit(1); });
