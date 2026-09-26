---
"@payfanout/adapter-payzen": patch
---

Map PayZen's AUTH_ errors by what each one says instead of reporting every other one as `authentication_required`: AUTH_100 (invalid ACS signature), AUTH_101 (3-D Secure technical error), AUTH_149 (3-D Secure timeout) and any AUTH_ code PayZen adds later are a non-retryable `processing_error`, and AUTH_102 (wrong 3-D Secure parameter) and AUTH_103 (3-D Secure disabled) are `invalid_request`. AUTH_999 stays a retryable `psp_unavailable`.
