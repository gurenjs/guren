---
'@guren/cli': minor
---

`guren audit` gains an advisory authorization rule. A controller action on a non-safe method whose body names a Model the app keeps a policy for (`app/Policies/<Model>Policy.ts`, modules included) now gets an `authorization:<METHOD> <path>` finding: a pass when the action calls `this.authorize()` or `this.can()`, references the policy class, or sits behind `authorize()`/`authorizeResource()` middleware; a warn naming the action, the policy and the fix when nothing the scan can see consults the policy; and a warn, never a pass, when the controller source is not among those the audit reads. An app with no policy contributes nothing. The rule never fails the audit, `// guren-audit-ignore` above the action suppresses it, and `config/audit.ts` ignores it by key like the other route-level findings. Existing finding keys and the `--json` shape are unchanged.
