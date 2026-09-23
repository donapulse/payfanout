import { PayFanoutError } from "@payfanout/core";

/**
 * Browser characteristics sent as `order.customer.device` on CreatePayment,
 * under Worldline's own key names. Worldline's 3-D Secure guide lists them
 * among the mandatory properties of every card payment, and only the browser
 * can read them, so the client adapter's `confirm()` collects them next to the
 * `hostedTokenizationId`. Browser characteristics only, never card data.
 */
export interface WorldlineCustomerDevice {
  /** `navigator.language`, at most 35 characters. */
  locale?: string;
  /**
   * Minutes between UTC and the browser's local time, as
   * `Date.prototype.getTimezoneOffset()` reports them (`"-120"` for UTC+2).
   * A string on Worldline's contract, at most 6 characters.
   */
  timezoneOffsetUtcMinutes?: string;
  /** `navigator.userAgent`, at most 2048 characters. */
  userAgent?: string;
  browserData?: WorldlineBrowserData;
}

/** `order.customer.device.browserData` on CreatePayment. */
export interface WorldlineBrowserData {
  /** `screen.colorDepth` in bits, an integer from 0 to 99. */
  colorDepth?: number;
  /** `navigator.javaEnabled()`. */
  javaEnabled?: boolean;
  /** Whether JavaScript runs in the browser — always `true` from `confirm()`. */
  javaScriptEnabled?: boolean;
  /** `screen.height` in pixels, as a string of at most 6 digits. */
  screenHeight?: string;
  /** `screen.width` in pixels, as a string of at most 6 digits. */
  screenWidth?: string;
}

/** The clientToken the client adapter's `confirm()` produces, decoded. */
export interface WorldlineClientToken {
  /** Sent as the root `hostedTokenizationId` of CreatePayment. */
  hostedTokenizationId: string;
  /** The device data that passed validation; absent when the token carried none or nothing survived. */
  device?: WorldlineCustomerDevice;
}

/** Worldline's limits on the customerDevice and browserData fields (API contract). */
const LOCALE_MAX_LENGTH = 35;
const USER_AGENT_MAX_LENGTH = 2048;
const COLOR_DEPTH_MAX = 99;
/** Signed whole minutes; the pattern keeps the value inside the contract's 6 characters. */
const TIMEZONE_OFFSET_PATTERN = /^-?\d{1,5}$/;
/** Whole pixels, at most 6 characters. */
const SCREEN_DIMENSION_PATTERN = /^\d{1,6}$/;

/**
 * Decodes the clientToken `completePayment` receives. The client adapter sends
 * a JSON envelope, `{"hostedTokenizationId":"…","device":{…}}`. A token that
 * does not start with `{` is a bare hostedTokenizationId — what earlier client
 * adapters and hand-written callers send — and is used as-is.
 *
 * An empty token, an envelope that is not valid JSON, or one without a
 * non-empty string `hostedTokenizationId` rejects with `invalid_request`. The
 * device data is checked field by field against Worldline's API contract: a
 * field of the wrong type or beyond its limit is dropped, as is any key the
 * contract does not define, and a device with nothing left is omitted. None of
 * that is fatal — it is risk data from the browser, not part of the amount.
 */
export function decodeWorldlineClientToken(clientToken: string): WorldlineClientToken {
  if (typeof clientToken !== "string" || clientToken.trim().length === 0) {
    throw PayFanoutError.invalidRequest("completePayment requires the clientToken produced by confirm()", {
      clientToken,
    });
  }
  if (!clientToken.trimStart().startsWith("{")) return { hostedTokenizationId: clientToken };
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(clientToken) as Record<string, unknown>;
  } catch (err) {
    throw PayFanoutError.invalidRequest(
      'Worldline clientToken envelope is not valid JSON (expected {"hostedTokenizationId":"…","device":{…}})',
      err,
    );
  }
  const hostedTokenizationId = envelope["hostedTokenizationId"];
  if (typeof hostedTokenizationId !== "string" || hostedTokenizationId.length === 0) {
    throw PayFanoutError.invalidRequest("Worldline clientToken envelope carries no hostedTokenizationId", {
      hostedTokenizationId,
    });
  }
  const device = sanitizeDevice(envelope["device"]);
  return { hostedTokenizationId, ...(device ? { device } : {}) };
}

function sanitizeDevice(value: unknown): WorldlineCustomerDevice | undefined {
  if (!isPlainObject(value)) return undefined;
  const { locale, timezoneOffsetUtcMinutes, userAgent } = value;
  const browserData = sanitizeBrowserData(value["browserData"]);
  const device: WorldlineCustomerDevice = {
    ...(isBoundedString(locale, LOCALE_MAX_LENGTH) ? { locale } : {}),
    ...(matches(timezoneOffsetUtcMinutes, TIMEZONE_OFFSET_PATTERN) ? { timezoneOffsetUtcMinutes } : {}),
    ...(isBoundedString(userAgent, USER_AGENT_MAX_LENGTH) ? { userAgent } : {}),
    ...(browserData ? { browserData } : {}),
  };
  return Object.keys(device).length > 0 ? device : undefined;
}

function sanitizeBrowserData(value: unknown): WorldlineBrowserData | undefined {
  if (!isPlainObject(value)) return undefined;
  const { colorDepth, javaEnabled, javaScriptEnabled, screenHeight, screenWidth } = value;
  const browserData: WorldlineBrowserData = {
    ...(isIntegerInRange(colorDepth, 0, COLOR_DEPTH_MAX) ? { colorDepth } : {}),
    ...(typeof javaEnabled === "boolean" ? { javaEnabled } : {}),
    ...(typeof javaScriptEnabled === "boolean" ? { javaScriptEnabled } : {}),
    ...(matches(screenHeight, SCREEN_DIMENSION_PATTERN) ? { screenHeight } : {}),
    ...(matches(screenWidth, SCREEN_DIMENSION_PATTERN) ? { screenWidth } : {}),
  };
  return Object.keys(browserData).length > 0 ? browserData : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
