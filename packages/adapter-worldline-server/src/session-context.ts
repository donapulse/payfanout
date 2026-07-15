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
 * Worldline Direct's Hosted Tokenization is tokenize-first: the browser
 * tokenizes the card into a `hostedTokenizationId`, and the payment object only
 * exists once the server's `completePayment` call creates it — yet that call
 * needs amount/currency/capture-method, none of which are sent at tokenization
 * time. PayFanout is stateless, so `createPaymentSession` encodes that context
 * into the `pspSessionId` itself: `base64url(json) + "." + base64url(hmac)`.
 *
 * The HMAC (sessionSigningKey) makes the context tamper-proof: the token
 * round-trips through the browser, and without the signature a client could
 * inflate/deflate the amount before server completion. The client adapter never
 * needs this token — the tokenization iframe is addressed by the session's
 * `clientSecret` (the hostedTokenizationUrl), and `confirm()` returns the
 * `hostedTokenizationId` produced in the browser.
 *
 * Every context carries an expiry (`expiresAt`, epoch ms): a signed token must
 * not stay completable forever. Enforced at decode time — `completePayment`
 * rejects expired tokens with code "session_expired" (hosts recover by creating
 * a fresh session).
 *
 * Crypto is WebCrypto (async) so this module runs on edge runtimes too.
 */
export interface WorldlineSessionContextV1 {
  v: 1;
  amount: number;
  currency: string;
  captureMethod: "automatic" | "manual";
  /** The Hosted Tokenization id created at session time (POST /hostedtokenizations). */
  hostedTokenizationId: string;
  /** Epoch milliseconds. Tokens without it are rejected. */
  expiresAt: number;
  /** 3-D Secure return URL (sent as both cardPaymentMethodSpecificInput.returnUrl and its threeDSecure.redirectionData form). */
  returnUrl?: string;
  /** Host-app internal id (PaymentSession.id), round-tripped via order.references.merchantReference. */
  id?: string;
  /** AVS data — order.customer.billingAddress on the payment. */
  billingDetails?: CreatePaymentSessionInput["billingDetails"];
  /** Statement text (order.references.descriptor on the payment). */
  statementDescriptor?: string;
  /** Customer email (order.customer.contactDetails.emailAddress on the payment). */
  receiptEmail?: string;
  shippingDetails?: ShippingDetails;
}

export interface DecodeSessionContextOptions {
  /** Clock override (epoch ms) — tests freeze it; production omits it. */
  now?: number;
}

export async function encodeSessionContext(
  context: WorldlineSessionContextV1,
  signingKey: string,
): Promise<string> {
  const payload = utf8ToBase64Url(JSON.stringify(context));
  return `${payload}.${await sign(payload, signingKey)}`;
}

export async function decodeSessionContext(
  token: string,
  signingKey: string,
  options: DecodeSessionContextOptions = {},
): Promise<WorldlineSessionContextV1> {
  const dot = token.indexOf(".");
  if (dot === -1) {
    throw PayFanoutError.invalidRequest("Malformed Worldline session context (expected payload.signature)", {
      token,
    });
  }
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = await sign(payload, signingKey);
  if (!constantTimeEqual(signature, expected)) {
    throw PayFanoutError.invalidRequest(
      "Worldline session context signature mismatch — token was tampered with or signed with a different sessionSigningKey",
      { token },
    );
  }
  let context: WorldlineSessionContextV1;
  try {
    context = JSON.parse(base64UrlToUtf8(payload)) as WorldlineSessionContextV1;
  } catch (err) {
    throw PayFanoutError.invalidRequest("Worldline session context payload is not valid JSON", err);
  }
  if (
    context.v !== 1 ||
    typeof context.amount !== "number" ||
    typeof context.currency !== "string" ||
    typeof context.hostedTokenizationId !== "string"
  ) {
    throw PayFanoutError.invalidRequest("Worldline session context payload has an unsupported shape", context);
  }
  // TTL enforcement. A token without expiresAt is rejected — honoring it would
  // be exactly the unbounded-lifetime hole TTLs close.
  if (typeof context.expiresAt !== "number" || !Number.isFinite(context.expiresAt)) {
    throw PayFanoutError.invalidRequest(
      "Worldline session context has no expiry — create a new payment session",
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
