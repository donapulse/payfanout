---
"@payfanout/react": patch
---

`<PaymentFields>` now calls `onError` once instead of twice under React StrictMode when it rejects a mount before loading the PSP's SDK: no PSP to mount, no client adapter registered for the PSP, or another `<PaymentFields>` already mounted. Production builds were not affected.
