const { chromium } = require("C:/Users/soporte/AppData/Local/Temp/opencode/pw-qa/node_modules/playwright");

const BASE = "https://varios-wacrm.fjueze.easypanel.host";
const EMAIL = "qa-20260803@example.com";
const PASSWORD = "TestPass123!";

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  const logs = [];
  page.on("console", (msg) => logs.push(`[console.${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => logs.push(`[pageerror] ${err.message}`));
  page.on("request", (req) => {
    if (req.url().includes("/api/auth/login") || req.url().includes("sessions/email"))
      logs.push(`[request] ${req.method()} ${req.url().split("?")[0]}`);
  });
  page.on("response", async (res) => {
    if (res.url().includes("/api/auth/login") || res.url().includes("sessions/email")) {
      let body = "";
      try { body = (await res.text()).slice(0, 300); } catch {}
      logs.push(`[response] ${res.status()} ${res.url().split("?")[0]} ${body}`);
    }
  });

  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await page.waitForSelector("#email", { timeout: 15000 });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await page.click('button[type="submit"]');

  await page.waitForTimeout(12000);

  const state = await page.evaluate(() => {
    const errDiv = document.querySelector("form div[class*='border-red']");
    return {
      url: location.href,
      errorText: errDiv ? errDiv.textContent : null,
      cookieFallback: localStorage.getItem("cookieFallback")?.slice(0, 80) ?? null,
      bodyText: (document.body?.innerText ?? "").slice(0, 150),
    };
  });

  console.log("URL after submit:", state.url);
  console.log("Visible error:", state.errorText);
  console.log("cookieFallback (first 80):", state.cookieFallback);
  console.log("Body:", JSON.stringify(state.bodyText));
  console.log("\n=== NETWORK/CONSOLE LOG ===");
  logs.forEach((l) => console.log(l));

  await page.screenshot({ path: `${__dirname}/screenshots/02-after-submit.png`, fullPage: true });
  await browser.close();
})();
