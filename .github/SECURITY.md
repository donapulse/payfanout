# Security Policy

PayFanout sits directly on the payment path, so we treat security reports as a priority and ask you to handle them with the same care.

## Reporting a vulnerability

**Do not open a public issue, discussion, or pull request for a security problem.**

Report privately through GitHub's [private vulnerability reporting](https://github.com/donapulse/payfanout/security/advisories/new). This opens a confidential advisory visible only to you and the maintainers.

Please include:

- the affected package and version,
- a description of the issue and its impact,
- a minimal proof of concept or reproduction steps,
- any suggested remediation, if you have one.

Redact live keys, tokens, and cardholder data from your report. A sanitized reproduction is enough.

## What to expect

- We aim to acknowledge a report within 3 business days.
- We will confirm the issue, determine the affected versions, and keep you updated as we work on a fix.
- Once a fix ships, we will credit you in the advisory unless you prefer to remain anonymous.

## Scope

In scope:

- Any code in this repository (the `@payfanout/*` packages).
- Leakage of secrets across the client/server boundary. Client packages must never carry secret-bearing code, and this is enforced by `scripts/check-boundaries.mjs`.
- Incorrect webhook signature verification, idempotency handling, or refund-state transitions.
- Anything that could cause a consuming application to mishandle money or expose cardholder data.

Out of scope:

- Vulnerabilities in the payment providers themselves or their SDKs. Report those to the provider.
- How a consuming application stores its data. PayFanout is stateless and persists nothing; the host application owns id mapping, event dedupe, and audit logs.
- Findings that require a compromised host, a malicious maintainer, or physical access to a machine.

## Supported versions

PayFanout is pre-1.0 and moving quickly. Security fixes land on the latest released version, and we do not backport to older lines until 1.0. Please stay current.

| Version    | Supported |
| ---------- | --------- |
| latest 0.x | Yes       |
| older 0.x  | No        |

## A note on secrets

PayFanout never stores card data, and it enforces mechanically that client packages carry no secrets. If you find a way around that boundary, that is a security bug and we want to hear about it.
