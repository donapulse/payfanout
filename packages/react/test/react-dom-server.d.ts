// react-dom is a test-only dependency of this package and the workspace ships
// no @types/react-dom outside the demo app; declare the single server API the
// SSR test uses. Delete this shim if @types/react-dom is ever added here.
declare module "react-dom/server" {
  import type { ReactNode } from "react";
  export function renderToString(children: ReactNode): string;
}
