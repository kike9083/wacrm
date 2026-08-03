const { chromium } = require("C:/Users/soporte/AppData/Local/Temp/opencode/pw-qa/node_modules/playwright");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto("https://varios-wacrm.fjueze.easypanel.host/login", { waitUntil: "networkidle" });

  const result = await page.evaluate(async () => {
    const res = await fetch("https://varios-appwrite-techpadah.fjueze.easypanel.host/v1/account/sessions/email", {
      method: "POST",
      headers: {
        "X-Appwrite-Project": "6a65b6900038f0345d67",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ email: "qa-20260803@example.com", password: "TestPass123!" }),
      credentials: "include",
    });
    const headers = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    const body = await res.json();
    return { status: res.status, headers, secretInBody: String(body.secret ?? "MISSING").length, secretField: String(body.secret ?? "MISSING").slice(0, 20) };
  });

  console.log("status:", result.status);
  console.log("secret in body:", result.secretInBody, JSON.stringify(result.secretField));
  const fb = result.headers["x-fallback-cookies"];
  console.log("x-fallback-cookies header:", fb ? fb.slice(0, 120) : "ABSENT");
  console.log("acao:", result.headers["access-control-allow-origin"]);
  console.log("expose:", result.headers["access-control-expose-headers"]);
  console.log("\nALL HEADERS:");
  Object.entries(result.headers).forEach(([k, v]) => console.log(`  ${k}: ${v.slice(0, 200)}`));
  await browser.close();
})();
