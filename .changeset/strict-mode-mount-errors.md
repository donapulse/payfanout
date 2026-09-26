---
"@payfanout/react": patch
---

Report a mount that `<PaymentFields>` rejects before loading the PSP's SDK to its `onError` prop once under React StrictMode. The rejected cases are no PSP to mount, no client adapter registered for the PSP, and another `<PaymentFields>` already mounted. StrictMode's extra development-only effect run reported each of them twice; production builds were not affected.
