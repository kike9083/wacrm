const { chromium } = require("C:/Users/soporte/AppData/Local/Temp/opencode/pw-qa/node_modules/playwright");

const BASE = "https://varios-wacrm.fjueze.easypanel.host";
const EMAIL = "qa-20260803@example.com";
const PASSWORD = "TestPass123!";

const screenshots = [
  `${__dirname}/screenshots/01-login-page.png`,
  `${__dirname}/screenshots/02-logged-in.png`,
  `${__dirname}/screenshots/03-after-reload.png`,
  `${__dirname}/screenshots/04-after-logout.png`,
];

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`PAGEERROR: ${err.message}`));

  // 1. Fresh browser -> /login should render, no redirect
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  if (page.url().includes("/dashboard")) {
    console.log("FAIL: fresh visit to /login redirected to /dashboard");
    await browser.close();
    process.exit(1);
  }
  await page.waitForSelector("#email", { timeout: 15000 });
  console.log("1. /login renders (fresh, no session) -> OK");
  await page.screenshot({ path: screenshots[0], fullPage: true });

  // 2. Fill credentials and submit
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await Promise.all([
    page.waitForURL("**/dashboard", { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  console.log("2. Submitted login -> navigated to /dashboard");

  // 3. Dashboard must render actual content (not black screen)
  await page.waitForSelector("body", { timeout: 15000 });
  await page.waitForTimeout(4000); // allow client fetches to settle
  const dashText = await page.evaluate(() =>
    document.body ? document.body.innerText.slice(0, 200) : ""
  );
  if (!dashText.trim()) {
    console.log("FAIL: dashboard rendered EMPTY (black screen)");
    await browser.close();
    process.exit(1);
  }
  const cookies = await context.cookies(BASE);
  const sessionCookie = cookies.find((c) => c.name === "wacrm_session");
  if (!sessionCookie) {
    console.log("FAIL: wacrm_session cookie not set");
    await browser.close();
    process.exit(1);
  }
  const localStorage = await page.evaluate(() => ({ ...localStorage }));
  const hasFallback = !!(
    localStorage["cookieFallback"] &&
    localStorage["cookieFallback"].includes("a_session_6a65b6900038f0345d67")
  );
  console.log(`3. Dashboard rendered (${dashText.trim().split("\n").length} lines)`);
  console.log(`   cookie wacrm_session set (len ${sessionCookie.value.length})`);
  console.log(`   localStorage cookieFallback present: ${hasFallback}`);
  await page.screenshot({ path: screenshots[1], fullPage: true });

  // 4. Reload -> session must persist (cookie + SDK session)
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(3000);
  const afterReload = await page.evaluate(() =>
    document.body ? document.body.innerText.slice(0, 200) : ""
  );
  console.log(
    `4. After reload: url=${page.url()} content=${afterReload.trim() ? "present" : "EMPTY"}`
  );
  if (!page.url().includes("/dashboard") || !afterReload.trim()) {
    console.log("FAIL: session did not persist after reload");
    await browser.close();
    process.exit(1);
  }
  await page.screenshot({ path: screenshots[2], fullPage: true });

  // 5. Logout -> back to /login (open account dropdown first — the
  //    sign-out item is inside the DropdownMenu, not in the DOM until open)
  await page.getByRole("button", { name: "Open account menu" }).first().click();
  const signOut = page.getByText("Cerrar sesión").or(page.getByText("Sign out"));
  await signOut.first().click({ timeout: 10000 });
  await page.waitForURL("**/login", { timeout: 20000 });
  console.log("5. Logout -> redirected to /login");
  await page.screenshot({ path: screenshots[3], fullPage: true });

  // 6. After logout, visiting /dashboard must redirect to /login
  await page.goto(`${BASE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForURL("**/login", { timeout: 10000 }).catch(() => {});
  const protectedOK = page.url().includes("/login");
  console.log(
    `6. /dashboard after logout -> ${protectedOK ? "redirected to /login (OK)" : "NOT protected (FAIL)"}`
  );

  // 7. Re-login in same context works (cookie fallback regenerated)
  await page.waitForSelector("#email", { timeout: 15000 });
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASSWORD);
  await Promise.all([
    page.waitForURL("**/dashboard", { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(3000);
  const reloginOK = page.url().includes("/dashboard");
  console.log(`7. Re-login after logout -> ${reloginOK ? "OK" : "FAIL"}`);

  console.log("\n=== CONSOLE/PAGE ERRORS DURING TEST ===");
  if (errors.length === 0) console.log("(none)");
  else errors.forEach((e) => console.log("- " + e));

  await browser.close();
  process.exit(reloginOK && protectedOK ? 0 : 1);
})().catch((err) => {
  console.error("SCRIPT ERROR:", err.message);
  process.exit(1);
});
