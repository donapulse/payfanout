---
"@payfanout/conformance": minor
---

The server suite now proves the PSP-native subscription surface, gated per declared capability: create round-trips a vaulted instrument into a valid record, retrieve resolves by id, listing honors `limit` and terminates through `nextCursor` without duplicate ids, statuses stay inside the unified union, and cancel is verified-idempotent — a repeated cancel must resolve as success. Adapters declaring any native-subscription operation supply the new `nativeSubscriptions` fixtures (`createInput`, or `seedSubscriptions` for providers without server-only create); all-false adapters skip the cases unchanged.
