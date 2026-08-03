const { chromium } = require("C:/Users/soporte/AppData/Local/Temp/opencode/pw-qa/node_modules/playwright");

const BASE = "https://varios-wacrm.fjueze.easypanel.host";
const EMAIL = "qa-20260803@example.com";
const PASSWORD = "TestPass123!";

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => { if (msg.type() === "error") errors.push(msg.text()); });
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await Promise.all([
    page.waitForURL("**/dashboard", { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(5000);

  const report = await page.evaluate(() => {
    const all = [...document.querySelectorAll("button, a, [role='menuitem'], [role='button']")];
    const withText = all
      .map((el) => el.textContent?.trim() || "")
      .filter((t) => /logout|sign\s*out|cerrar/i.test(t) && t.length < 60);
    const bodyText = document.body?.innerText || "";
    return {
      matches: withText,
      hasSignOutText: /Cerrar sesi|Sign out/i.test(bodyText),
      bodySample: bodyText.slice(0, 300),
      url: location.href,
    };
  });
  console.log("URL:", report.url);
  console.log("body has logout text:", report.hasSignOutText);
  console.log("elements matching:", JSON.stringify(report.matches));
  console.log("body sample:", JSON.stringify(report.bodySample));
  console.log("console errors:", errors.length ? errors.slice(0, 5) : "(none)");

  await browser.close();
})().catch((err) => { console.error("SCRIPT ERROR:", err.message); process.exit(1); });
