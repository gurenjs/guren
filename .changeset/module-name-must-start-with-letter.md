---
"@guren/cli": patch
---

`make:module` and `--module` refuse a name starting with a digit.

A module name is not only a directory. Codegen PascalCases it to qualify the identifiers it emits for that module, so a Resource in `modules/billing/` is exported as `Data.BillingInvoice`. `modules/2fa/` yields `2faInvoice`, which is not a TypeScript identifier — the Data-type generator has to drop the definition and tell the author to rename the directory. The validator accepted the name, so the scaffolder created a module the generator would later refuse.

The one segment that reaches the front of an identifier is the first, so only its leading character is constrained: `s3` and `billing-2fa` are still accepted, `2fa` and `2FA` are not, and the error names the reason rather than leaving it to be discovered at codegen time.

This is deliberately a break for an app that already has a `modules/<digit…>/` directory: the directory keeps working everywhere it is discovered from disk (`check`, `context`, `codegen`), but `make:controller Invoice --module 2fa` and its siblings now refuse it. The name was never usable end to end — its generated Data types were already being dropped — so the refusal moves an existing failure to the point where it can still be fixed with a rename. The runtime check in the generator stays as a backstop, since a `modules/` directory can be created by hand.
