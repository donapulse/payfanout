import { defineConfig } from 'vitepress'

// VitePress config for the PayFanout documentation site.
//   pnpm docs:dev      -> local preview with hot reload
//   pnpm docs:build    -> regenerates the TypeDoc API reference, then builds the static site
//   pnpm docs:preview  -> serve the built site locally
export default defineConfig({
  title: 'PayFanout',
  description:
    'Unified multi-PSP payment abstraction for React + TypeScript, one API and one set of ' +
    'embedded UI components adaptable to implement any payment gateway.',
  cleanUrls: true,
  lastUpdated: true,

  // Base path: '/' locally (so docs:dev / docs:preview work), overridden to '/<repo>/' by
  // the GitHub Pages deploy workflow via DOCS_BASE so assets resolve on a project site.
  base: process.env.DOCS_BASE ?? '/',

  // decisions.md and future-designs.md are internal team docs authored as plain Markdown,
  // they contain bare <angle-brackets> in prose that Vue's template compiler rejects, and
  // README.md is a folder-inventory note that would collide with index.md for "/". They stay
  // in the repo, out of the site. (adapter-authoring.md IS included: its angle brackets are
  // all inside backticks, so it renders cleanly.)
  //
  // 'public/**' excludes everything TypeDoc emits into docs/public/api from page
  // compilation. VitePress globs **/*.md under srcDir and by default ignores only
  // node_modules and dist, NOT public, so the .md files TypeDoc copies into
  // public/api/media/ (verbatim copies of the READMEs linked from the API homepage,
  // including decisions.md with its bare angle brackets) would otherwise be compiled as
  // pages and fail the build. They are still served verbatim as static assets under /api/;
  // the top-level exclusions above match only the originals at docs/*.md, not these copies.
  srcExclude: ['README.md', 'decisions.md', 'future-designs.md', 'public/**'],

  // /api/ is the TypeDoc output copied verbatim from docs/public/api, it is static HTML,
  // not a VitePress page, so the dead-link checker must not try to resolve it.
  ignoreDeadLinks: [/^\/api\//],

  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Providers', link: '/guide/providers' },
      { text: 'API reference', link: '/api/' },
    ],

    // GitHub icon in the top nav bar.
    socialLinks: [
      { icon: 'github', link: 'https://github.com/donapulse/payfanout' },
    ],

    sidebar: {
      '/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting started', link: '/guide/getting-started' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Server usage', link: '/guide/server' },
            { text: 'React usage', link: '/guide/react' },
            { text: 'Webhooks', link: '/guide/webhooks' },
            { text: 'Saved cards & subscriptions', link: '/guide/recurring' },
          ],
        },
        {
          text: 'Payment providers',
          items: [
            { text: 'Overview', link: '/guide/providers' },
            { text: 'Set up Stripe', link: '/guide/stripe' },
            { text: 'Set up Paysafe', link: '/guide/paysafe' },
            { text: 'Set up GoCardless', link: '/guide/gocardless' },
            { text: 'Set up PayPal', link: '/guide/paypal' },
            { text: 'Set up PayZen', link: '/guide/payzen' },
          ],
        },
        {
          text: 'Extending',
          items: [
            { text: 'Writing an adapter (add a PSP)', link: '/adapter-authoring' },
            { text: 'Conformance suite', link: '/guide/conformance' },
          ],
        },
        {
          text: 'Reference',
          items: [
            { text: 'API reference (TypeDoc)', link: '/api/' },
          ],
        },
      ],
    },

    search: { provider: 'local' },
    outline: 'deep',
  },
})
