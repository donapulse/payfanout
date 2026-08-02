import {
  base64UrlToUtf8,
  bytesToBase64Url,
  constantTimeEqual,
  hmacSha256,
  PayFanoutError,
  utf8ToBase64Url,
} from "@payfanout/core";

/**
 * Adyen is tokenize-first AND creates nothing at session time: the browser
 * encrypts the card inside Adyen's hosted fields, and the payment object only
 * comes into existence when the server's `completePayment` posts `/payments`.
 * That call needs the amount, currency, reference and capture method — none of
 * which exist anywhere at session time, because PayFanout persists nothing. So
 * `createPaymentSession` encodes them into the `pspSessionId` itself:
 * `base64url(json) + "." + base64url(hmac)`.
 *
 * The HMAC (sessionSigningKey) makes the context tamper-proof: the token
 * round-trips through the browser, and without the signature a client could
 * inflate or deflate the amount before server completion. The client adapter
 * reads the payload half (amount/currency drive Adyen Web's own UI copy) without
 * ever holding the key.
 *
 * Every context carries an expiry (`expiresAt`, epoch ms): a signed token must
 * not stay completable forever. Enforced at decode time — `completePayment`
 * rejects expired tokens with code "session_expired" (hosts recover by creating
 * a fresh session).
 *
 * Crypto is WebCrypto (async) so this module runs on edge runtimes too.
 */
export interface AdyenSessionContextV1 {
  v: 1;
  amount: number;
  currency: string;
  captureMethod: "automatic" | "manual";
  /** The `reference` sent on POST /payments — Adyen's merchant reference for the payment. */
  reference: string;
  /** Epoch milliseconds. Tokens without it are rejected. */
  expiresAt: number;
  /** Where Adyen sends the shopper back from a redirect action. */
  returnUrl?: string;
  /** Host-app internal id (PaymentSession.id), also stamped into Adyen metadata. */
  id?: string;
  /** Host metadata, forwarded to Adyen's `metadata` map and echoed on PaymentInfo. */
  metadata?: Record<string, string>;
  /** Shopper email (`shopperEmail` on the payment). */
  receiptEmail?: string;
}

export interface DecodeSessionContextOptions {
  /** Clock override (epoch ms) — tests freeze it; production omits it. */
  now?: number;
}

export async function encodeSessionContext(
  context: AdyenSessionContextV1,
  signingKey: string,
): Promise<string> {
  const payload = utf8ToBase64Url(JSON.stringify(context));
  return `${payload}.${await sign(payload, signingKey)}`;
}

export async function decodeSessionContext(
  token: string,
  signingKey: string,
  options: DecodeSessionContextOptions = {},
): Promise<AdyenSessionContextV1> {
  const dot = token.indexOf(".");
  if (dot === -1) {
    throw PayFanoutError.invalidRequest("Malformed Adyen session context (expected payload.signature)", {
      token,
    });
  }
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = await sign(payload, signingKey);
  if (!constantTimeEqual(signature, expected)) {
    throw PayFanoutError.invalidRequest(
      "Adyen session context signature mismatch — token was tampered with or signed with a different sessionSigningKey",
      { token },
    );
  }
  let context: AdyenSessionContextV1;
  try {
    context = JSON.parse(base64UrlToUtf8(payload)) as AdyenSessionContextV1;
  } catch (err) {
    throw PayFanoutError.invalidRequest("Adyen session context payload is not valid JSON", err);
  }
  if (
    context.v !== 1 ||
    typeof context.amount !== "number" ||
    typeof context.currency !== "string" ||
    typeof context.reference !== "string"
  ) {
    throw PayFanoutError.invalidRequest("Adyen session context payload has an unsupported shape", context);
  }
  // TTL enforcement. A token without expiresAt is rejected — honoring it would
  // be exactly the unbounded-lifetime hole TTLs close.
  if (typeof context.expiresAt !== "number" || !Number.isFinite(context.expiresAt)) {
    throw PayFanoutError.invalidRequest("Adyen session context has no expiry — create a new payment session", context);
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
