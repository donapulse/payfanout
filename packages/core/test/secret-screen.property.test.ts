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
/** The stretch length repeatsSecret flags. */
const SPAN = 8;
// Stretches exactly SPAN long, and windows at a secret's very end, are rare draws.
const RUNS = { numRuns: 1000 };

describe("repeatsSecret property invariants", () => {
  it("flags any text holding a stretch of a secret at least eight long, or a shorter secret whole, in any case", () => {
    fc.assert(
      fc.property(
        arbSecrets(0),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.string(),
        fc.string(),
        fc.array(fc.boolean(), { minLength: 1 }),
        (secrets, pick, offset, extra, before, after, upper) => {
          const width = SPAN;
          const secret = secrets[pick % secrets.length]!;
          const length = secret.length < width ? secret.length : width + (extra % (secret.length - width + 1));
          const start = offset % (secret.length - length + 1);
          const stretch = [...secret.slice(start, start + length)]
            .map((char, i) => (upper[i % upper.length] ? char.toUpperCase() : char.toLowerCase()))
            .join("");
          expect(repeatsSecret(`${before}${stretch}${after}`, secrets)).toBe(true);
        },
      ),
      RUNS,
    );
  });

  it("never flags a text that shares no eight-long stretch with any secret", () => {
    fc.assert(
      fc.property(
        arbSecrets(1),
        fc.array(fc.tuple(fc.nat(), fc.nat(), fc.constantFrom(...SEPARATORS), fc.boolean())),
        (secrets, pieces) => {
          // Pieces of the secrets, each shorter than SPAN and than the shortest secret, split by separators.
          const run = Math.min(SPAN, ...secrets.map((secret) => secret.length)) - 1;
          const text = pieces
            .map(([pick, offset, separator, upper]) => {
              const secret = secrets[pick % secrets.length]!;
              const piece = secret.slice(offset % secret.length).slice(0, run);
              return `${upper ? piece.toUpperCase() : piece.toLowerCase()}${separator}`;
            })
            .join("");
          expect(repeatsSecret(text, secrets)).toBe(false);
        },
      ),
      RUNS,
    );
  });
});
