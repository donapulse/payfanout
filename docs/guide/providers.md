# Payment providers, set up a PSP

PayFanout installs every PSP the same shape: a **server adapter** that holds your secret
credentials, a **client adapter** that holds only a browser-safe key, and (optionally) a
**webhook endpoint**.
Application code never learns which PSP is active, so "install a PSP" is the same job
whether it is one we ship or one you [write yourself](/adapter-authoring).

Pick the PSP you're wiring up:

| PSP | Set-up guide | Server package | Client package | Completion shape |
| --- | --- | --- | --- | --- |
| **Stripe** | [Set up Stripe](/guide/stripe) | `@payfanout/adapter-stripe-server` | `@payfanout/adapter-stripe` | Confirm-on-client |
| **Paysafe** | [Set up Paysafe](/guide/paysafe) | `@payfanout/adapter-paysafe-server` | `@payfanout/adapter-paysafe` | Tokenize-first (needs a server-completion route) |
| **GoCardless** | [Set up GoCardless](/guide/gocardless) | `@payfanout/adapter-gocardless-server` | `@payfanout/adapter-gocardless` | Confirm-on-client (redirect to hosted bank authorisation) |
| **PayPal** | [Set up PayPal](/guide/paypal) | `@payfanout/adapter-paypal-server` | `@payfanout/adapter-paypal` | Tokenize-first (needs a server-completion route) |
| **PayZen (Lyra)** | [Set up PayZen](/guide/payzen) | `@payfanout/adapter-payzen-server` | `@payfanout/adapter-payzen` | Confirm-on-client |
| **Worldline (Direct)** | [Set up Worldline](/guide/worldline) | `@payfanout/adapter-worldline-server` | `@payfanout/adapter-worldline` | Tokenize-first (needs a server-completion route) |

New to the packages themselves? [Installation](/guide/installation) covers prerequisites,
which packages to add, and the env-var mechanics first. This page and the guides below are
about **wiring a specific PSP end to end**.

## The four steps, for every PSP

The guides follow the identical arc, only the credential names and a few quirks differ:

1. **Get credentials.** Every PSP has a sandbox and a live set. PayFanout **never infers**
   which you're using from a key prefix, you pass `environment: "sandbox" | "live"`
   explicitly, and the adapter throws if you don't.
2. **Wire the server adapter.** Construct it from environment variables and register it on
   a `PaymentService`. The constructor validates its config and **throws at startup** on a
   missing required field, a misconfiguration can never reach checkout.
3. **Wire the client adapter.** Construct it with the browser-safe key and hand it to
   `<PayFanoutProvider>`. The PSP's browser SDK loads lazily from the PSP's CDN, there is
   nothing extra to `pnpm add`.
4. **Register the webhook endpoint.** Point the PSP at your `/webhooks/<psp>` route and
   give the adapter the signing secret. Signature verification hashes the **exact raw
   request bytes**, see [Webhooks](/guide/webhooks) for the raw-body requirement that
   every framework fights you on.

::: tip Which side do I need?
Server-only backend? Steps 1, 2, 4. Adding the embedded card fields? Also step 3. You do
not have to install every PSP, add only the one(s) you use.
:::

## Sandbox first, always

Do the whole integration against the PSP's **sandbox**, `environment: "sandbox"`, test
keys, test cards. Nothing about going live changes your PayFanout code except the
credentials and the `environment` string; each set-up guide ends with a **Go live**
checklist that spells out exactly what swaps. Because PayFanout is stateless, there is no
data migration between sandbox and live, the switch is credentials only.

## Installing a PSP we don't ship yet

A third, fourth, or fifth PSP is **a new adapter package, not a fork**. You implement the
`ServerPaymentAdapter` / `ClientPaymentAdapter` contracts from `@payfanout/core`, prove
the adapter against `@payfanout/conformance`, the same suite Stripe and Paysafe pass,
and it drops into the exact four steps above with **zero changes to core, server, React,
or your application code**. The step-by-step build is [Writing an adapter](/adapter-authoring),
and [Conformance](/guide/conformance) is how "extensible" stays a guarantee rather than a
hope.
