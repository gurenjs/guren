---
"@guren/cli": patch
---

`guren audit` flags outbound links built from the request host

The auth scaffold used to build password-reset links from the request:

```js
buildPasswordResetUrl(`${new URL(this.request.url).origin}/reset-password`, token, email)
```

A request URL is reconstructed from the `Host` header, which any client can
forge, so an unauthenticated attacker could `POST /forgot-password` with a
victim's address and `Host: attacker.tld` and have the app mail that victim a
genuine single-use reset token pointing at the attacker's server.

Routing scaffolded links through `app/Auth/AppUrl.ts` fixed the *generated*
output, which does nothing for the two populations that still have the bug:
apps scaffolded before that release — told to hand-patch or re-run
`guren add auth --force` — and anyone who wrote the controller themselves.
`guren audit` ships with the CLI those users already run, so it is the one
mechanism that reaches them. It returned green on the exact code the fix calls
exploitable; it now warns:

```
[warn] [A07] app/Http/Controllers/Auth/ForgotPasswordController.ts:26: Absolute
link built from the request host — the Host header is client-controlled, so a
forged host makes the app send a genuine single-use token pointing at the
attacker's server.
     → Build the base URL from process.env.APP_URL instead of the request
```

The rule fires on a request-derived origin (`new URL(req.url)`), on a
`host`/`x-forwarded-host` header read off the request, and on a request URL
handed straight to a link builder — but only in a file that also names one of
the framework's outbound-link builders (`buildTokenUrl` and its
`buildPasswordResetUrl`, `buildVerificationUrl`, and `buildOAuthRedirectUrl`
aliases). That second half is what keeps the generated `app/Auth/AppUrl.ts`
clean: its non-production fallback returns a request origin on purpose, and it
builds no link. Gating on behaviour rather than exempting the helper by path
means the exemption survives a rename. Middleware that parses the request URL
only to reach its path never matches. Use `// guren-audit-ignore` for a link
that never leaves the app.

Because that gate is a hand-maintained name list, a builder added to
`@guren/core` would otherwise reach users as an affirmative *pass*. An audit
test enumerates `@guren/core`'s `build*Url` exports against the list, with
`buildOAuthAuthorizeUrl` as a documented exclusion — it builds the provider's
authorize URL, a real but different risk this finding's wording would
misdescribe.

The boundary, stated so a green audit doesn't imply more than it checks: a
controller that mails a link assembled by hand, without going through those
builders, is not covered. Widening the gate to guessed-at mail helper names
would trade a real false-positive cost for speculative coverage. The finding is
worded conditionally for the same reason — co-occurrence in one file is not
proof the host reaches the link.

Note the rule also fires on `process.env.APP_URL ?? new URL(req.url).origin`.
That is deliberate rather than a false positive — the fallback is fail-open, so
a forged host still works whenever `APP_URL` is unset, which is exactly the
production misconfiguration the scaffolded helper throws on instead.

Findings are classified A07 / CWE-640, so `--json` consumers and the console
prefix stay consistent with the other rules.
