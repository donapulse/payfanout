import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { repeatsSecret } from "@payfanout/core";

/** Secrets are drawn from these; no separator is one of them in any letter case. */
const SECRET_CHARS = [..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_"];
const SEPARATORS = [..." -./:"];

const arbSecrets = (minLength: number) =>
  fc.array(fc.string({ unit: fc.constantFrom(...SECRET_CHARS), minLength, maxLength: 24 }), {
    minLength: 1,
    maxLength: 3,
  });
// Half the runs leave the default span.
const arbSpan = fc.option(fc.integer({ min: 1, max: 12 }), { nil: undefined, freq: 2 });
// Stretches exactly span long, and windows at a secret's very end, are rare draws.
const RUNS = { numRuns: 1000 };

describe("repeatsSecret property invariants", () => {
  it("flags any text holding a stretch of a secret at least span long, or a shorter secret whole, in any case", () => {
    fc.assert(
      fc.property(
        arbSecrets(0),
        arbSpan,
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.string(),
        fc.string(),
        fc.array(fc.boolean(), { minLength: 1 }),
        (secrets, span, pick, offset, extra, before, after, upper) => {
          const width = span ?? 8;
          const secret = secrets[pick % secrets.length]!;
          const length = secret.length < width ? secret.length : width + (extra % (secret.length - width + 1));
          const start = offset % (secret.length - length + 1);
          const stretch = [...secret.slice(start, start + length)]
            .map((char, i) => (upper[i % upper.length] ? char.toUpperCase() : char.toLowerCase()))
            .join("");
          expect(repeatsSecret(`${before}${stretch}${after}`, secrets, span)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("never flags a text that shares no span-long stretch with any secret", () => {
    fc.assert(
      fc.property(
        arbSecrets(1),
        arbSpan,
        fc.array(fc.tuple(fc.nat(), fc.nat(), fc.constantFrom(...SEPARATORS), fc.boolean())),
        (secrets, span, pieces) => {
          // Pieces of the secrets, each shorter than the span and than the shortest secret, split by separators.
          const run = Math.min(span ?? 8, ...secrets.map((secret) => secret.length)) - 1;
          const text = pieces
            .map(([pick, offset, separator, upper]) => {
              const secret = secrets[pick % secrets.length]!;
              const piece = secret.slice(offset % secret.length).slice(0, run);
              return `${upper ? piece.toUpperCase() : piece.toLowerCase()}${separator}`;
            })
            .join("");
          expect(repeatsSecret(text, secrets, span)).toBe(false);
        },
      ),
      RUNS,
    );
  });
});
