import { expect, test } from "@playwright/test";

/**
 * Real-browser Stripe checkout through the demo app: genuine Stripe.js, real
 * Payment Element iframes, real 3DS challenge. Requires the demo to run with
 * sandbox keys (VITE_STRIPE_PUBLISHABLE_KEY for the web app, STRIPE_SECRET_KEY
 * for the API server) — the suite self-skips otherwise.
 *
 * NOTE: iframe selectors follow Stripe's current test-mode Payment Element and
 * may need small adjustments on first real run — that is expected and fine;
 * this file is the harness to adjust.
 */
test.skip(
  !process.env.VITE_STRIPE_PUBLISHABLE_KEY || !process.env.STRIPE_SECRET_KEY,
  "Set VITE_STRIPE_PUBLISHABLE_KEY and STRIPE_SECRET_KEY to run browser E2E",
);

async function fillPaymentElement(page: import("@playwright/test").Page, cardNumber: string): Promise<void> {
  const fields = page.locator("[data-payfanout-fields]");
  await expect(fields.locator("iframe").first()).toBeVisible({ timeout: 30_000 });
  const frame = page.frameLocator("[data-payfanout-fields] iframe").first();
  await frame.getByPlaceholder("1234 1234 1234 1234").fill(cardNumber);
  await frame.getByPlaceholder("MM / YY").fill("12/30");
  await frame.getByPlaceholder("CVC").fill("123");
  const zip = frame.getByPlaceholder("12345");
  if (await zip.isVisible().catch(() => false)) await zip.fill("10001");
}

test("pays with a plain test card, embedded, no navigation", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel(/payment provider/i).selectOption("stripe");
  await fillPaymentElement(page, "4242424242424242");

  const urlBefore = page.url();
  await page.getByRole("button", { name: /pay/i }).click();
  await expect(page.getByRole("status")).toContainText("✅", { timeout: 60_000 });
  expect(page.url()).toBe(urlBefore); // embedded contract: no full-page redirect
});

test("completes a 3DS challenge inline (iframe, not a redirect)", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel(/payment provider/i).selectOption("stripe");
  await fillPaymentElement(page, "4000002500003155"); // Stripe: requires 3DS authentication

  const urlBefore = page.url();
  await page.getByRole("button", { name: /pay/i }).click();

  // Stripe's test 3DS challenge lives in deeply nested, dynamically named
  // iframes — scan every frame for the Complete button instead of guessing.
  await expect(async () => {
    for (const frame of page.frames()) {
      const button = frame.getByRole("button", { name: /complete/i }).first();
      if (await button.isVisible().catch(() => false)) {
        await button.click();
        return;
      }
    }
    throw new Error("3DS challenge button not visible yet");
  }).toPass({ timeout: 60_000, intervals: [1000] });

  await expect(page.getByRole("status")).toContainText("✅", { timeout: 60_000 });
  expect(page.url()).toBe(urlBefore); // 3DS happened inline
});

test("recurring end-to-end: save card -> off-session recharge -> subscribe -> renewal -> cancel", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel(/payment provider/i).selectOption("stripe");
  // Consent first: checking it re-creates the session with customer+save.
  await page.getByLabel(/save my card/i).check();
  await fillPaymentElement(page, "4242424242424242");
  await page.getByRole("button", { name: /pay \$/i }).click();
  await expect(page.getByRole("status")).toContainText("✅", { timeout: 60_000 });

  // The vault panel appears once the host learns the stored token.
  await expect(page.getByTestId("saved-card")).toContainText("visa •••• 4242", { timeout: 30_000 });

  // Off-session recharge: a REAL second payment with no card fields touched.
  await page.getByTestId("charge-saved").click();
  await expect(page.getByTestId("charge-saved-result")).toContainText("✅ charged again — pi_", {
    timeout: 60_000,
  });

  // Full subscription lifecycle, all real charges.
  await page.getByTestId("subscribe").click();
  await expect(page.getByTestId("subscription-state")).toContainText("Subscription active", { timeout: 60_000 });
  const before = await page.getByTestId("subscription-state").textContent();

  await page.getByTestId("simulate-renewal").click();
  await expect(page.getByTestId("subscription-result")).toContainText("✅ renewal charged", { timeout: 60_000 });
  await expect(page.getByTestId("subscription-state")).not.toHaveText(before!); // period advanced, new payment id

  await page.getByTestId("cancel-subscription").click();
  await expect(page.getByTestId("subscription-state")).toContainText("Subscription canceled", { timeout: 30_000 });
});

test("surfaces a declined card as a unified error", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel(/payment provider/i).selectOption("stripe");
  await fillPaymentElement(page, "4000000000009995"); // insufficient funds

  await page.getByRole("button", { name: /pay/i }).click();
  await expect(page.getByRole("status")).toContainText("❌", { timeout: 60_000 });
  await expect(page.getByRole("status")).toContainText("insufficient_funds");
});
