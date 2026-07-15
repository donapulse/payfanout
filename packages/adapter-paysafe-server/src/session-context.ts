import {
  base64UrlToUtf8,
  bytesToBase64Url,
  constantTimeEqual,
  hmacSha256,
  PayFanoutError,
  utf8ToBase64Url,
  type CreatePaymentSessionInput,
  type ShippingDetails,
} from "@payfanout/core";

/**
 * Paysafe is tokenize-first (§4a): no PSP object exists until the server's
 * completePayment call, yet that call needs amount/currency/merchant-account.
 * PayFanout is stateless, so createPaymentSession encodes that context into the
 * pspSessionId itself: `base64url(json) + "." + base64url(hmac)`.
 *
 * The HMAC (sessionSigningKey) makes the context tamper-proof: the token
 * round-trips through the browser, and without the signature a client could
 * inflate/deflate the amount before server completion. The client adapter only
 * READS the payload half (for tokenize params) — it never needs the key.
 *
 * Every context carries an expiry (`expiresAt`, epoch ms): a signed token must
 * not stay completable forever. Enforced at decode time — completePayment,
 * verifyPaymentMethod, and updatePaymentSession all reject expired tokens with
 * code "session_expired" (hosts recover by creating a fresh session).
 *
 * Crypto is WebCrypto (async) so this module runs on edge runtimes too.
 */
export interface PaysafeSessionContextV1 {
  v: 1;
  amount: number;
  currency: string;
  country?: string;
  /** Absent = single-account API key; Paysafe routes by key + currency. */
  merchantAccountId?: string;
  captureMethod: "automatic" | "manual";
  /** Epoch milliseconds. Tokens without it are rejected. */
  expiresAt: number;
  webhookUrl?: string;
  returnUrl?: string;
  /** Host-app internal id (PaymentSession.id), round-tripped for completePayment. */
  id?: string;
  /**
   * Paysafe paymentType the handle was minted with, for rails that are not
   * Paysafe.js-tokenizable (Interac e-Transfer). Absent on card sessions, which
   * tokenize in the browser and learn their type only at completion.
   */
  paymentType?: string;
  /**
   * Redirect rails only: the handle minted at session creation. Card sessions
   * have no token until the browser tokenizes, so completePayment takes it from
   * the caller instead.
   */
  paymentHandleToken?: string;
  /** Redirect rails only: the Paysafe-hosted URL the client adapter navigates to. */
  redirectUrl?: string;
  metadata?: Record<string, string>;
  /** AVS data — Paysafe rejects card payments without a zip (error 3004). */
  billingDetails?: CreatePaymentSessionInput["billingDetails"];
  /** Statement text (merchantDescriptor.dynamicDescriptor on the payment). */
  statementDescriptor?: string;
  /** Customer email (profile.email on the payment). */
  receiptEmail?: string;
  shippingDetails?: ShippingDetails;
}

export interface DecodeSessionContextOptions {
  /** Clock override (epoch ms) — tests freeze it; production omits it. */
  now?: number;
}

export async function encodeSessionContext(
  context: PaysafeSessionContextV1,
  signingKey: string,
): Promise<string> {
  const payload = utf8ToBase64Url(JSON.stringify(context));
  return `${payload}.${await sign(payload, signingKey)}`;
}

export async function decodeSessionContext(
  token: string,
  signingKey: string,
  options: DecodeSessionContextOptions = {},
): Promise<PaysafeSessionContextV1> {
  const dot = token.indexOf(".");
  if (dot === -1) {
    throw PayFanoutError.invalidRequest("Malformed Paysafe session context (expected payload.signature)", {
      token,
    });
  }
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = await sign(payload, signingKey);
  if (!constantTimeEqual(signature, expected)) {
    throw PayFanoutError.invalidRequest(
      "Paysafe session context signature mismatch — token was tampered with or signed with a different sessionSigningKey",
      { token },
    );
  }
  let context: PaysafeSessionContextV1;
  try {
    context = JSON.parse(base64UrlToUtf8(payload)) as PaysafeSessionContextV1;
  } catch (err) {
    throw PayFanoutError.invalidRequest("Paysafe session context payload is not valid JSON", err);
  }
  if (context.v !== 1 || typeof context.amount !== "number" || typeof context.currency !== "string") {
    throw PayFanoutError.invalidRequest("Paysafe session context payload has an unsupported shape", context);
  }
  // TTL enforcement. A token without expiresAt is rejected — honoring it would
  // be exactly the unbounded-lifetime hole TTLs close.
  if (typeof context.expiresAt !== "number" || !Number.isFinite(context.expiresAt)) {
    throw PayFanoutError.invalidRequest(
      "Paysafe session context has no expiry — create a new payment session",
      context,
    );
  }
  if ((options.now ?? Date.now()) > context.expiresAt) {
    throw new PayFanoutError({
      code: "session_expired",
      message: "This payment session has expired — create a new payment session",
      retryable: false,
      raw: { expiresAt: new Date(context.expiresAt).toISOString() },
    });
  }
  return context;
}

async function sign(payloadB64: string, key: string): Promise<string> {
  return bytesToBase64Url(await hmacSha256(key, payloadB64));
}
