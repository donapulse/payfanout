import type { PaysafeFieldsInstanceLike, PaysafeJsLike } from "../src/index.js";

/**
 * In-memory Paysafe.js, modelled on the served SDK
 * (hosted.paysafe.com/js/v1/latest/paysafe.min.js) for what the adapter
 * relies on: setup validates `accounts`, an instance stays locked (9100) until
 * show() has run, show() answers repeat calls from its first result, and
 * tokenize rejects a missing or over-long merchantRefNum before tokenizing
 * anything.
 */

/** The fields of the SDK's HostedErrorEntity the adapter reads. */
export interface FakePaysafeJsError {
  code: string;
  displayMessage: string;
  detailedMessage: string;
  message: string;
  fieldErrors?: Array<{ field: string; message: string }>;
}

export function paysafeJsError(
  code: string,
  detailedMessage: string,
  displayMessage = `There was an error (${code}), please contact our support.`,
): FakePaysafeJsError {
  return { code, detailedMessage, displayMessage, message: displayMessage };
}

type PaymentMethodsReport = Record<string, { error?: unknown }>;

export interface FakePaysafeJsOptions {
  /**
   * The served SDK runs show() inside setup only when a single payment method
   * is configured (card fields alone count as one). `false` models a setup it
   * leaves locked, as with more than one method configured.
   */
  autoShow?: boolean;
  /** What show() reports per payment method. Defaults to a card that initialized. */
  paymentMethods?: PaymentMethodsReport;
  /** Tokenization itself, reached only once the SDK's option validation passes. */
  tokenize?: (options: Record<string, unknown>) => Promise<{ token: string }>;
}

export interface FakePaysafeJs extends PaysafeJsLike {
  setupCalls: Array<{ apiKey: string; options: Record<string, unknown> }>;
  tokenizeCalls: Record<string, unknown>[];
  /** Every show() call, including the one a single-method setup makes itself. */
  showCalls: number;
  /** Fires the valid/invalid handlers the adapter registered on a field. */
  fire(field: string, kind: "valid" | "invalid"): void;
}

const CARD_FIELDS = ["cardNumber", "expiryDate", "cvv"];

export function createFakePaysafeJs(options: FakePaysafeJsOptions = {}): FakePaysafeJs {
  const report: PaymentMethodsReport = options.paymentMethods ?? { card: {} };
  const handlers = new Map<string, Array<{ kind: "valid" | "invalid"; handler: () => void }>>();
  const validity = new Map<string, boolean>();

  const fake: FakePaysafeJs = {
    setupCalls: [],
    tokenizeCalls: [],
    showCalls: 0,
    fire(field, kind) {
      validity.set(field, kind === "valid");
      for (const entry of handlers.get(field) ?? []) if (entry.kind === kind) entry.handler();
    },
    fields: {
      setup: async (apiKey, setupOptions) => {
        fake.setupCalls.push({ apiKey, options: setupOptions });
        const accounts = setupOptions["accounts"];
        if (accounts !== undefined && accounts !== null) {
          if (typeof accounts !== "object" || Array.isArray(accounts)) {
            throw paysafeJsError("9059", "Accounts should be object.");
          }
          if (typeof (accounts as Record<string, unknown>)["default"] !== "number") {
            throw paysafeJsError("9061", "Invalid account ID for default.");
          }
        }

        let shown = false;
        const show = async (): Promise<PaymentMethodsReport> => {
          fake.showCalls += 1;
          if (shown) return report;
          shown = true;
          const methods = Object.values(report);
          // show() rejects only when no method initialized: with one method,
          // with that method's own error.
          if (methods.length > 0 && methods.every((method) => method.error)) {
            throw methods.length === 1
              ? methods[0]!.error
              : { error: paysafeJsError("9084", "Failed to load available payment methods."), paymentMethods: report };
          }
          return report;
        };
        const assertShown = (): void => {
          if (!shown) {
            throw paysafeJsError(
              "9100",
              "Payment methods are not initialized. Please invoke show() before any operation on the instance.",
            );
          }
        };

        const instance: PaysafeFieldsInstanceLike = {
          show,
          // The SDK throws the lock error synchronously, before any promise exists.
          tokenize: (tokenizeOptions) => {
            assertShown();
            fake.tokenizeCalls.push(tokenizeOptions);
            const refNum = tokenizeOptions["merchantRefNum"];
            if (typeof refNum !== "string" || refNum.length > 255) {
              const invalid: FakePaysafeJsError = {
                ...paysafeJsError(
                  "9003",
                  "Invalid fields: options.merchantRefNum.",
                  "Invalid fields: options.merchantRefNum.",
                ),
                fieldErrors: [
                  { field: "options.merchantRefNum", message: "merchantRefNum should be a string with max length 255." },
                ],
              };
              return Promise.reject(invalid);
            }
            return options.tokenize ? options.tokenize(tokenizeOptions) : Promise.resolve({ token: "SPtok_handle_1" });
          },
          areAllFieldsValid: () => {
            assertShown();
            return CARD_FIELDS.every((field) => validity.get(field) === true);
          },
          fields: (selector) => {
            assertShown();
            const on = (kind: "valid" | "invalid") => (handler: (...args: unknown[]) => void) => {
              handlers.set(selector, [...(handlers.get(selector) ?? []), { kind, handler: () => handler() }]);
            };
            return { valid: on("valid"), invalid: on("invalid") };
          },
        };
        if (options.autoShow ?? true) await show();
        return instance;
      },
    },
  };
  return fake;
}
