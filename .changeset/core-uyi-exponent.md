---
"@payfanout/core": patch
---

`getCurrencyExponent("UYI")` now returns ISO 4217's 0 instead of 2, so `toMinorUnits`, `fromMinorUnits` and `formatMinorUnits` treat UYI, the Uruguay peso in indexed units, as whole units: `toMinorUnits("12", "UYI")` is 12 (it was 1200), and fractional UYI amounts are refused. UYI minor-unit amounts computed by earlier versions are 100 times the ISO value.
