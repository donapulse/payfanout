/**
 * Example host-app server: Express + PayFanout. Demonstrates everything the
 * host application OWNS because PayFanout is stateless:
 *   - the internal-id -> pspPaymentId mapping (`orders` map below)
 *   - the webhook event dedupe store (`processedEventIds` set below)
 * In production these live in your database/queue — never in PayFanout.
 */
import { randomUUID } from "node:crypto";
import express from "express";
import { rateLimit } from "express-rate-limit";
import {
  InMemorySubscriptionStore,
  PaymentRouter,
  PaymentService,
  SubscriptionManager,
  createAdapterWebhookHandler,
  createUnifiedWebhookHandler,
} from "@payfanout/server";
import { StripeServerAdapter } from "@payfanout/adapter-stripe-server";
import { PaysafeServerAdapter } from "@payfanout/adapter-paysafe-server";
import { PayZenServerAdapter } from "@payfanout/adapter-payzen-server";
import { GoCardlessServerAdapter, parseGoCardlessWebhookEvents } from "@payfanout/adapter-gocardless-server";
import { PayPalServerAdapter } from "@payfanout/adapter-paypal-server";

const stripe = new StripeServerAdapter({
  secretKey: process.env.STRIPE_SECRET_KEY ?? "sk_test_replace_me",
  apiVersion: "2024-06-20", // pinned — never rely on the account default
  webhookSigningSecret: process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_replace_me",
  environment: "sandbox",
});

const paysafe = new PaysafeServerAdapter({
  username: process.env.PAYSAFE_USERNAME ?? "replace_me",
  password: process.env.PAYSAFE_PASSWORD ?? "replace_me",
  environment: "sandbox",
  // Paysafe merchant accounts are per currency/country — resolve, don't hardcode.
  // Returning undefined lets single-account API keys route by key + currency.
  merchantAccountResolver: () => process.env.PAYSAFE_ACCOUNT_ID,
  sessionSigningKey: process.env.PAYSAFE_SESSION_KEY ?? "dev-only-session-signing-key",
  webhookHmacKey: process.env.PAYSAFE_WEBHOOK_HMAC_KEY ?? "dev-only-webhook-key",
});

const payzen = new PayZenServerAdapter({
  shopId: process.env.PAYZEN_SHOP_ID ?? "replace_me",
  password: process.env.PAYZEN_PASSWORD ?? "testpassword_replace_me",
  environment: "sandbox",
  hmacKey: process.env.PAYZEN_HMAC_KEY ?? "dev-only-hmac-key",
});

const gocardless = new GoCardlessServerAdapter({
  accessToken: process.env.GOCARDLESS_ACCESS_TOKEN ?? "replace_me",
  environment: "sandbox",
  webhookSecret: process.env.GOCARDLESS_WEBHOOK_SECRET ?? "dev-only-webhook-secret",
});

const paypal = new PayPalServerAdapter({
  clientId: process.env.PAYPAL_CLIENT_ID ?? "replace_me",
  clientSecret: process.env.PAYPAL_CLIENT_SECRET ?? "replace_me",
  environment: "sandbox",
  // From the dashboard's webhook registration — verification answers false without it.
  webhookId: process.env.PAYPAL_WEBHOOK_ID,
});

const payments = new PaymentService({
  adapters: [stripe, paysafe, gocardless, paypal, payzen],
  // Observability seam: one metadata-only record per adapter call. In
  // production this feeds metrics/tracing; the demo just shows it exists.
  telemetry: (t) =>
    console.log(`[telemetry] ${t.pspName}.${t.operation} ${t.ok ? "ok" : `failed:${t.errorCode}`} in ${t.durationMs}ms`),
});

// Smart routing for psp="auto": currency decides the primary, the other PSP is
// the failover; the circuit breaker (on by default) remembers outages.
const router = new PaymentRouter({
  service: payments,
  rules: [
    { when: { currency: ["CAD"] }, use: ["paysafe", "stripe"] },
    { when: { currency: ["EUR"] }, use: ["payzen", "stripe"] },
    { when: { currency: ["USD", "JPY"] }, use: ["stripe", "paysafe"] },
  ],
  onAttempt: (a) =>
    console.log(`[router] ${a.pspName}: ${a.ok ? "won" : a.skipped ? "skipped" : `failed (${a.error?.code})`}`),
});

// --- Host-owned state (PayFanout persists nothing) -------------------------
const orders = new Map<
  string,
  { psp: string; pspSessionId: string; pspPaymentId?: string; amount: number; currency: string; save?: boolean }
>();
const processedEventIds = new Set<string>();
// The host owns "its user -> PSP customer/token" — one demo user per PSP here.
const vault = new Map<string, { pspCustomerId: string; tokens: string[] }>();

// Recurring payments: the manager supplies billing logic; the HOST supplies
// storage (in-memory here — a real app implements SubscriptionStore over its
// database) and the cron trigger (the demo triggers renewals via an endpoint).
const subscriptions = new SubscriptionManager({
  service: payments,
  store: new InMemorySubscriptionStore(),
  onEvent: (event) => console.log(`[subscription] ${event.type} ${event.subscription.id} (${event.subscription.status})`),
});

const DEMO_BILLING: Record<string, { line1: string; city: string; postalCode: string; country: string }> = {
  USD: { line1: "1 Demo Way", city: "New York", postalCode: "10001", country: "US" },
  CAD: { line1: "1 Demo Way", city: "Toronto", postalCode: "M5V 3L9", country: "CA" },
  EUR: { line1: "1 Demo Way", city: "Berlin", postalCode: "10115", country: "DE" },
};

async function ensureCustomer(psp: string): Promise<string> {
  const existing = vault.get(psp);
  if (existing) return existing.pspCustomerId;
  const customer = await payments.createCustomer(psp, {
    id: `demo-user-${psp}`,
    email: "demo@payfanout.example",
    name: "Demo User",
    idempotencyKey: `demo-customer-${psp}-${randomUUID()}`,
  });
  vault.set(psp, { pspCustomerId: customer.pspCustomerId, tokens: [] });
  return customer.pspCustomerId;
}

function rememberToken(psp: string, token: string | undefined): void {
  if (!token) return;
  const entry = vault.get(psp);
  if (entry && !entry.tokens.includes(token)) entry.tokens.push(token);
}

const app = express();

// Generous per-IP ceiling on the webhook ingress: abuse protection without
// throttling legitimate PSP retry bursts (GoCardless batches up to 250 events).
app.use(
  "/webhooks",
  rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: true, legacyHeaders: false }),
);

// ---------------------------------------------------------------------------
// Webhooks FIRST, with express.raw: signature verification needs the exact raw
// bytes — express.json() would destroy them. This ordering matters.
// ---------------------------------------------------------------------------
const onEvent = async (event: import("@payfanout/core").UnifiedWebhookEvent): Promise<void> => {
  if (processedEventIds.has(event.id)) return; // host-owned dedupe
  processedEventIds.add(event.id);
  // Ack-fast contract: enqueue here (BullMQ, SQS, ...) — never process inline.
  // pspPaymentId is payload-derived — encode it so log lines cannot be forged.
  console.log(`[webhook] ${event.pspName} ${event.type} payment=${encodeURIComponent(event.pspPaymentId ?? "-")}`);
};

const stripeHook = createAdapterWebhookHandler(stripe, { onEvent, log: console.log });
const paysafeHook = createAdapterWebhookHandler(paysafe, { onEvent, log: console.log });
const payzenHook = createAdapterWebhookHandler(payzen, { onEvent, log: console.log });
const paypalHook = createAdapterWebhookHandler(paypal, { onEvent, log: console.log });
// PayZen stays out of the unified route (form-urlencoded IPNs, not JSON);
// gocardless here handles single-event deliveries only — batched deliveries 400; /webhooks/gocardless below is the real ingress.
const unifiedHook = createUnifiedWebhookHandler([stripe, paysafe, gocardless, paypal], { onEvent, log: console.log });

for (const [path, handler] of [
  ["/webhooks/stripe", stripeHook],
  ["/webhooks/paysafe", paysafeHook],
  ["/webhooks/paypal", paypalHook],
  ["/webhooks/unified", unifiedHook], // single shared entry point variant
] as const) {
  app.post(path, express.raw({ type: "application/json" }), async (req, res) => {
    const result = await handler({
      rawBody: req.body.toString("utf8"),
      headers: req.headers as Record<string, string>,
    });
    res.status(result.status).json(result.ok ? { received: true } : { error: result.reason });
  });
}

// PayZen IPNs POST application/x-www-form-urlencoded: parse the form, pass the
// kr-answer STRING as rawBody (the signature covers exactly those bytes) and
// the kr-hash fields as headers — the guide's "recipe A".
app.post("/webhooks/payzen", express.urlencoded({ extended: false }), async (req, res) => {
  const body = req.body as Record<string, string | undefined>;
  const result = await payzenHook({
    rawBody: body["kr-answer"] ?? "",
    headers: {
      "kr-hash": body["kr-hash"] ?? "",
      "kr-hash-algorithm": body["kr-hash-algorithm"] ?? "",
      "kr-hash-key": body["kr-hash-key"] ?? "",
    },
  });
  res.status(result.status).json(result.ok ? { received: true } : { error: result.reason });
});

// GoCardless BATCHES up to 250 events per delivery, so its ingress differs:
// verify the signature once over the raw bytes, then fan out per event —
// parseWebhookEvent (and thus createAdapterWebhookHandler) refuses multi-event
// deliveries rather than dropping events.
app.post("/webhooks/gocardless", express.raw({ type: "application/json" }), async (req, res) => {
  const rawBody = req.body.toString("utf8");
  if (!(await gocardless.verifyWebhookSignature(rawBody, req.headers as Record<string, string>))) {
    res.status(498).json({ error: "invalid signature" }); // GoCardless's "Invalid Token" convention
    return;
  }
  try {
    for (const event of parseGoCardlessWebhookEvents(rawBody)) await onEvent(event);
    res.status(200).json({ received: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.use(express.json());

// Create a payment session for whichever PSP the client selected.
app.post("/api/session", async (req, res) => {
  const { psp, amount, currency, captureMethod, billing, save } = req.body as {
    psp: string;
    amount: number;
    currency: string;
    captureMethod?: "automatic" | "manual";
    billing?: { country: string; postalCode: string };
    /** "Save my card" consent — vault during checkout. */
    save?: boolean;
  };
  const orderId = `order_${randomUUID()}`;
  try {
    // Stripe vaults during checkout (customer + savePaymentMethod on the
    // session); Paysafe vaults at completion time (see /api/complete).
    const stripeSave = save && psp === "stripe" ? { customer: await ensureCustomer("stripe"), savePaymentMethod: true } : {};
    const input = {
      id: orderId,
      amount,
      currency,
      country: billing?.country ?? "US",
      // AVS data quality — Paysafe requires a zip on card payments (error 3004).
      billingDetails: billing ? { address: billing } : undefined,
      captureMethod,
      // Redirect methods (GoCardless hosted bank authorisation) land back here.
      returnUrl: `${process.env.PUBLIC_URL ?? "http://localhost:4242"}/return`,
      // "auto" doesn't know its PSP yet — the unified endpoint serves any of them.
      webhookUrl: `${process.env.PUBLIC_URL ?? "http://localhost:4242"}/webhooks/${psp === "auto" ? "unified" : psp}`,
      idempotencyKey: orderId,
      ...stripeSave,
    };
    // psp="auto": PaymentRouter picks by rules and cascades transient failures.
    const { session, pspName } =
      psp === "auto" ? await router.createPaymentSession(input) : { session: await payments.createPaymentSession(psp, input), pspName: psp };
    orders.set(orderId, { psp: pspName, pspSessionId: session.pspSessionId, amount, currency, save });
    res.json({ orderId, clientSecret: session.clientSecret, pspSessionId: session.pspSessionId, pspName });
  } catch (err) {
    respondError(res, err);
  }
});

// Server completion for tokenize-first PSPs (Paysafe): <PayButton>'s
// onServerCompletion posts here with the clientToken from confirm().
app.post("/api/complete", async (req, res) => {
  const { orderId, clientToken } = req.body as { orderId: string; clientToken: string };
  const order = orders.get(orderId);
  if (!order) {
    res.status(404).json({ error: "unknown order" });
    return;
  }
  try {
    let info;
    if (order.save) {
      // Tokenize-first save-and-pay: convert the single-use token into a
      // stored MULTI_USE one, then charge the STORED token (credential-on-file
      // "initial" — the customer is present right now).
      const pspCustomerId = await ensureCustomer(order.psp);
      const saved = await payments.savePaymentMethod(order.psp, {
        pspCustomerId,
        clientToken,
        idempotencyKey: `save-${orderId}`,
      });
      rememberToken(order.psp, saved.token);
      info = await payments.chargeSavedPaymentMethod(order.psp, {
        pspCustomerId,
        savedPaymentMethodToken: saved.token,
        amount: order.amount,
        currency: order.currency,
        id: orderId,
        occurrence: "initial",
        billingDetails: { address: DEMO_BILLING[order.currency] ?? DEMO_BILLING["USD"] },
        idempotencyKey: `complete-${orderId}`,
      });
      info = { ...info, savedPaymentMethodToken: saved.token };
    } else {
      info = await payments.completePayment(order.psp, {
        pspSessionId: order.pspSessionId,
        clientToken,
        idempotencyKey: `complete-${orderId}`,
      });
    }
    order.pspPaymentId = info.pspPaymentId; // host-owned id mapping
    res.json(info);
  } catch (err) {
    respondError(res, err);
  }
});

// After a Stripe save-during-checkout, the client fetches the outcome here —
// the saved token rides PaymentInfo.savedPaymentMethodToken.
app.get("/api/orders/:orderId/vault", async (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order) {
    res.status(404).json({ error: "unknown order" });
    return;
  }
  try {
    const info = await payments.retrievePayment(order.psp, order.pspSessionId);
    rememberToken(order.psp, info.savedPaymentMethodToken);
    res.json({
      savedPaymentMethodToken: info.savedPaymentMethodToken ?? null,
      paymentMethodDetails: info.paymentMethodDetails ?? null,
    });
  } catch (err) {
    respondError(res, err);
  }
});

// The recurring primitive, no client involved: charge the latest saved token.
app.post("/api/charge-saved", async (req, res) => {
  const { psp, amount } = req.body as { psp: string; amount: number };
  const entry = vault.get(psp);
  const token = entry?.tokens.at(-1);
  if (!entry || !token) {
    res.status(400).json({ error: "no saved payment method yet — pay once with 'save my card' checked" });
    return;
  }
  try {
    const info = await payments.chargeSavedPaymentMethod(psp, {
      pspCustomerId: entry.pspCustomerId,
      savedPaymentMethodToken: token,
      amount,
      currency: psp === "paysafe" ? (process.env.PAYSAFE_CURRENCY ?? process.env.VITE_PAYSAFE_CURRENCY ?? "USD") : "USD",
      occurrence: "recurring",
      billingDetails: { address: DEMO_BILLING[psp === "paysafe" ? (process.env.PAYSAFE_CURRENCY ?? "USD") : "USD"] ?? DEMO_BILLING["USD"] },
      idempotencyKey: `charge-saved-${randomUUID()}`,
    });
    res.json(info);
  } catch (err) {
    respondError(res, err);
  }
});

// --- Subscriptions (SubscriptionManager over host-owned storage) ----------
app.post("/api/subscriptions", async (req, res) => {
  const { psp, amount } = req.body as { psp: string; amount: number };
  const entry = vault.get(psp);
  const token = entry?.tokens.at(-1);
  if (!entry || !token) {
    res.status(400).json({ error: "no saved payment method yet — pay once with 'save my card' checked" });
    return;
  }
  try {
    const { subscription, payment } = await subscriptions.createSubscription({
      pspName: psp,
      pspCustomerId: entry.pspCustomerId,
      savedPaymentMethodToken: token,
      plan: { amount, currency: psp === "paysafe" ? (process.env.PAYSAFE_CURRENCY ?? process.env.VITE_PAYSAFE_CURRENCY ?? "USD") : "USD", interval: "month" },
      billingDetails: { address: DEMO_BILLING[psp === "paysafe" ? (process.env.PAYSAFE_CURRENCY ?? "USD") : "USD"] ?? DEMO_BILLING["USD"] },
      idempotencyKey: `subscribe-${randomUUID()}`,
    });
    res.json({ subscription, payment });
  } catch (err) {
    respondError(res, err);
  }
});

app.get("/api/subscriptions/:id", async (req, res) => {
  try {
    res.json(await subscriptions.retrieveSubscription(req.params.id));
  } catch (err) {
    respondError(res, err);
  }
});

app.post("/api/subscriptions/:id/cancel", async (req, res) => {
  try {
    res.json(await subscriptions.cancelSubscription(req.params.id, req.body ?? {}));
  } catch (err) {
    respondError(res, err);
  }
});

// Demo stand-in for the production cron: collect renewals as if it were
// just past this subscription's period end (a REAL charge happens).
app.post("/api/subscriptions/:id/simulate-renewal", async (req, res) => {
  try {
    const record = await subscriptions.retrieveSubscription(req.params.id);
    const run = await subscriptions.chargeDueSubscriptions(
      new Date(Date.parse(record.currentPeriodEnd) + 1000),
    );
    res.json({ run, subscription: await subscriptions.retrieveSubscription(req.params.id) });
  } catch (err) {
    respondError(res, err);
  }
});

app.get("/api/orders/:orderId", async (req, res) => {
  const order = orders.get(req.params.orderId);
  if (!order?.pspPaymentId) {
    res.status(404).json({ error: "unknown or incomplete order" });
    return;
  }
  try {
    res.json(await payments.retrievePayment(order.psp, order.pspPaymentId));
  } catch (err) {
    respondError(res, err);
  }
});

app.get("/api/capabilities/:psp", (req, res) => {
  try {
    res.json(payments.getCapabilities(req.params.psp));
  } catch (err) {
    respondError(res, err);
  }
});

function respondError(res: express.Response, err: unknown): void {
  const e = err as { code?: string; message?: string; retryable?: boolean; raw?: unknown };
  console.error("[payfanout]", e.code, e.message, JSON.stringify(e.raw ?? null)?.slice(0, 400));
  res.status(400).json({
    error: e.message ?? "payment error",
    code: e.code ?? "unknown",
    retryable: e.retryable ?? false,
    // Demo-only: raw PSP errors in responses help debugging; never do this in production.
    raw: e.raw,
  });
}

app.listen(4242, () => console.log("PayFanout demo API on http://localhost:4242"));
