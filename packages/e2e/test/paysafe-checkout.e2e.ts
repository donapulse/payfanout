import { expect, test } from "@playwright/test";

/**
 * Real-browser Paysafe checkout: genuine Paysafe.js hosted fields, tokenize on
 * the client, completion on the server behind the SAME <PayButton> — the full
 * §4a tokenize-first path. Requires sandbox keys on both demo processes
 * (VITE_PAYSAFE_PUBLIC_KEY for the web app; PAYSAFE_* for the API server).
 *
 * NOTE: hosted-field selectors follow Paysafe.js v1 and may need adjustment on
 * the first real run — this file is the harness to adjust.
 */
test.skip(
  !process.env.VITE_PAYSAFE_PUBLIC_KEY || !process.env.PAYSAFE_USERNAME,
  "Set VITE_PAYSAFE_PUBLIC_KEY and PAYSAFE_* to run browser E2E",
);

test("auto (routed): the server's PaymentRouter picks the PSP by currency; checkout completes on it", async ({ page }) => {
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  await page.goto("/");
  await page.getByLabel(/payment provider/i).selectOption("auto");

  // With a CAD Paysafe account the routing rules send "auto" to paysafe —
  // asserting the routed PSP proves the router ran server-side.
  await expect(page.getByText(/routed to: paysafe/i)).toBeVisible({ timeout: 15_000 });

  const fields = page.locator("[data-payfanout-fields]");
  await expect(fields.locator("iframe").first()).toBeVisible({ timeout: 30_000 });
  const fillHostedField = async (name: string, value: string): Promise<void> => {
    await expect(async () => {
      const frames = fields.locator("iframe");
      const count = await frames.count();
      for (let i = 0; i < count; i++) {
        const frame = frames.nth(i).contentFrame();
        for (const candidate of [frame.getByPlaceholder(name), frame.getByRole("textbox", { name })]) {
          if ((await candidate.count()) > 0) {
            await candidate.first().fill(value, { timeout: 5_000 });
            return;
          }
        }
      }
      throw new Error(`No hosted field found for "${name}" yet`);
    }).toPass({ timeout: 30_000, intervals: [500] });
  };

  // The Pay button must be DISABLED until the PSP SDK reports complete fields —
  // this exercises the onChange field-state stream against the real SDK.
  const payButton = page.getByRole("button", { name: /pay/i });
  await expect(payButton).toBeDisabled();

  await fillHostedField("Numéro de carte", "4111111111111111");
  await fillHostedField("MM/AA", "12/30");
  await fillHostedField("CVV", "111");

  await expect(payButton).toBeEnabled({ timeout: 15_000 });
  await payButton.click();
  await expect(page.getByRole("status")).toContainText("✅", { timeout: 60_000 });
});

test("save-and-pay on Paysafe: vault the tokenized card, then recharge it off-session", async ({ page }) => {
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  await page.goto("/");
  await page.getByLabel(/payment provider/i).selectOption("paysafe");
  await page.getByLabel(/save my card/i).check();

  const fields = page.locator("[data-payfanout-fields]");
  await expect(fields.locator("iframe").first()).toBeVisible({ timeout: 30_000 });
  const fillHostedField = async (name: string, value: string): Promise<void> => {
    await expect(async () => {
      const frames = fields.locator("iframe");
      const count = await frames.count();
      for (let i = 0; i < count; i++) {
        const frame = frames.nth(i).contentFrame();
        for (const candidate of [frame.getByPlaceholder(name), frame.getByRole("textbox", { name })]) {
          if ((await candidate.count()) > 0) {
            await candidate.first().fill(value, { timeout: 5_000 });
            return;
          }
        }
      }
      throw new Error(`No hosted field found for "${name}" yet`);
    }).toPass({ timeout: 30_000, intervals: [500] });
  };
  // A DIFFERENT Paysafe test card than the plain-payment test: the sandbox
  // enforces card-number uniqueness across vault profiles, and a stale
  // uniqueness record for 4111… (deleted ghost profile) permanently 7503s
  // public-key-origin conversions of that card. Re-runs of THIS card on the
  // same demo customer self-heal via the adapter's 7503 recovery.
  await fillHostedField("Numéro de carte", "4510150000000321");
  await fillHostedField("MM/AA", "12/30");
  await fillHostedField("CVV", "111");

  // Save-and-pay: tokenize -> server converts to MULTI_USE -> charges the stored token.
  await page.getByRole("button", { name: /pay \$/i }).click();
  await expect(page.getByRole("status")).toContainText("✅", { timeout: 60_000 });
  await expect(page.getByTestId("saved-card")).toContainText("visa •••• 0321", { timeout: 30_000 });

  // The recurring proof in a browser: recharge with no fields interaction.
  await page.getByTestId("charge-saved").click();
  await expect(page.getByTestId("charge-saved-result")).toContainText("✅ charged again —", {
    timeout: 60_000,
  });
});

test("tokenizes in hosted fields and completes on the server via the same PayButton", async ({ page }) => {
  // Diagnostics: PSP SDK failures are easy to miss inside iframes — log everything.
  page.on("console", (msg) => console.log(`[browser:${msg.type()}]`, msg.text()));
  page.on("pageerror", (err) => console.log("[pageerror]", err.message));
  page.on("response", async (res) => {
    if (res.url().includes("/api/")) {
      const body = await res.text().catch(() => "<unreadable>");
      console.log("[api]", res.status(), res.url().slice(0, 90), "->", body.slice(0, 160));
    } else if (res.url().includes("paysafe")) {
      console.log("[net]", res.status(), res.url().slice(0, 120));
    }
  });
  await page.goto("/");
  await page.getByLabel(/payment provider/i).selectOption("paysafe");

  const fields = page.locator("[data-payfanout-fields]");
  await expect(fields.locator("iframe").first()).toBeVisible({ timeout: 30_000 });

  // Paysafe.js injects several iframes (real fields + hidden helpers) — locate
  // each hosted input by the placeholder/name we configured, wherever it lives.
  const fillHostedField = async (name: string, value: string): Promise<void> => {
    // The field iframes finish loading asynchronously after mount — poll.
    await expect(async () => {
      const frames = fields.locator("iframe");
      const count = await frames.count();
      for (let i = 0; i < count; i++) {
        const frame = frames.nth(i).contentFrame();
        for (const candidate of [frame.getByPlaceholder(name), frame.getByRole("textbox", { name })]) {
          if ((await candidate.count()) > 0) {
            await candidate.first().fill(value, { timeout: 5_000 });
            return;
          }
        }
      }
      throw new Error(`No hosted field found for "${name}" yet`);
    }).toPass({ timeout: 30_000, intervals: [500] });
  };
  await fillHostedField("Numéro de carte", "4111111111111111");
  await fillHostedField("MM/AA", "12/30");
  await fillHostedField("CVV", "111");

  const urlBefore = page.url();
  await page.getByRole("button", { name: /pay/i }).click();

  // Success proves the whole chain: tokenize -> onServerCompletion -> /api/complete
  // -> PaymentService.completePayment -> signed-context verification -> Paysafe.
  await expect(page.getByRole("status")).toContainText("✅", { timeout: 60_000 });
  expect(page.url()).toBe(urlBefore); // embedded, no redirect
});
