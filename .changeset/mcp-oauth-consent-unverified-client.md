---
"@guren/plugin-cloudflare": patch
---

Label the client's name as unverified on the `--mcp-oauth` consent screen, and show where the grant goes

The scaffolded consent screen named the client by the name it chose for itself and
never said where the authorization code would be sent. Anyone can register at
`/oauth/register`, so a client registered as `Claude` with a redirect URI on an
attacker's host read as Claude, and a signed-in user who approved it handed that
host a code it could redeem with its own PKCE verifier.

The heading now reads "A client calling itself **name** `unverified` is asking…",
a sentence says the application has not verified the name and that anyone can
register under any name, and a block above the form shows the scheme and host of
the redirect URI this request really uses. The host comes from the same `new URL`
parse `completeAuthorization` redirects with, so userinfo such as
`https://claude.ai@attacker.example` shows `https://attacker.example`. It is
escaped text, never a link.

Registration itself stays open, as it was, so keep the label unless the app creates
its own clients with `createClient()` and has closed registration.

The scaffold never overwrites a file the developer already has, so an app that
already ran `--mcp-oauth` keeps the old screen until it applies this by hand. After
updating this package, copy the two files over yours:

```bash
cp node_modules/@guren/plugin-cloudflare/templates/mcp-oauth/app/Http/Controllers/McpOAuthController.ts app/Http/Controllers/
cp node_modules/@guren/plugin-cloudflare/templates/mcp-oauth/app/View/McpOAuthConsentPage.tsx app/View/
```

Use `git diff` to put back any edits you had made in those files, then rebuild as
usual. Copy both: the page reads a `redirectTarget` prop only the new controller
passes, and with an old controller it renders an empty target and no error. A
normal build cannot scaffold them again if you move your files aside: once the routes
are mounted, the app build runs first and fails on the missing controller.
