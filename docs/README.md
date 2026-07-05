# docs/ — what lives here and why

Four documents with four distinct jobs — they reference each other but do not repeat
each other. If content ever appears in two of them, one of the two is wrong.

| File | Job | Audience |
| --- | --- | --- |
| [adapter-authoring.md](adapter-authoring.md) | **How-to**: write a new PSP adapter that passes the conformance suite. | Engineer adding PSP #3 |
| [decisions.md](decisions.md) | **Decision log**: what was chosen, why, and which sandbox facts were verified (never re-litigate these). | Team reviewing/overriding choices |
| [future-designs.md](future-designs.md) | **Designs for things deliberately NOT built** (vaulting, subscriptions, marketplace…) with their unblock conditions. | Whoever picks up the next big bet |
| `public/api/` *(generated, gitignored)* | **Generated API reference** — typedoc HTML output of every package's public surface, served by VitePress at `/api/`. Rebuild with `pnpm run docs:api`; never edit or commit it. | Anyone browsing the typed API |
| `index.md`, `guide/`, `.vitepress/` | **VitePress documentation site** — the hand-written install + usage guide, including the per-PSP setup pages (`guide/providers.md`, `guide/stripe.md`, `guide/paysafe.md`). `pnpm docs:dev` to preview, `pnpm docs:build` to build (also regenerates `public/api/`). | Anyone learning to use the library |

One more place documentation lives, on purpose:

- **[../README.md](../README.md)** — the product front page: what the library is, quick
  starts, guarantees. Feature behavior is documented there, not here.

> Roadmap status used to live in a root `TODO.md`; that file was removed. What shipped
> and *why* now lives in [decisions.md](decisions.md); what was deliberately deferred and
> its unblock conditions live in [future-designs.md](future-designs.md).

> Versioning note: the packages are at 0.1.0 and unpublished — no "v1"/"v2" exists.
> Where the README or brief says "v1", read "the current release scope".
