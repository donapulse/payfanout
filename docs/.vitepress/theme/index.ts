// VitePress theme = the default theme + a guard that force-loads the /api/ site.
//
// /api/ is the TypeDoc reference: static HTML copied verbatim from docs/public/api,
// NOT a VitePress page. VitePress is a SPA, so clicking any in-app link to /api/ makes
// the client router try to resolve a page that doesn't exist and it renders its own
// 404. (A hard refresh works because that bypasses the router and hits the static file
// directly — which is exactly the bug: click 404s, refresh loads.)
//
// Intercept every route change into /api/ and hand it to the browser as a full page
// navigation instead. One chokepoint covers all of them: the nav bar, the sidebar, the
// homepage hero button, the auto-generated prev/next pager, and any in-prose link.
import DefaultTheme from 'vitepress/theme'
import type { Theme } from 'vitepress'

export default {
  extends: DefaultTheme,
  enhanceApp({ router }) {
    const previous = router.onBeforeRouteChange
    router.onBeforeRouteChange = (to) => {
      // `to` may be an absolute URL or a root-relative path; read just the pathname.
      const path = new URL(to, 'http://vitepress.local').pathname
      if (/(?:^|\/)api\//.test(path)) {
        window.location.assign(to) // full navigation -> GitHub Pages serves /api/index.html
        return false // cancel the SPA route change
      }
      return previous?.(to)
    }
  },
} satisfies Theme
