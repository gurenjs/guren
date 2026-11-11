---
"@guren/plugin-cloudflare": patch
---

Read the consenting user from the session on the `--mcp-oauth` consent screen

The scaffolded `McpOAuthController` read the signed-in user with `this.auth.id()`.
In an app that calls `auth.useTokens()`, that call answers with an API token's user
for any request carrying `Authorization: Bearer`. A leaked token with ordinary
abilities could therefore open the consent screen, approve any tool the app
exposes to MCP, and receive an OAuth grant for the token's user. Revoking the API
token does not end that grant: it lasts until the provider's refresh token expires.

`GET` and `POST /oauth/authorize` now read the user from the session guard by name,
`this.auth.guard(SESSION_GUARD).id()`, where `SESSION_GUARD` is `'web'`, the guard
`auth.useModel()` registers. A request with no signed-in session is sent to the
login path as before, whatever `Authorization` header it carries. Signing in and
approving works as it did. When a request carries both a session and a bearer
token, the grant goes to the session's user. A test that signs a user in with
`TestApp.actingAs()` now gets the redirect to the login path on these two routes,
since `actingAs()` does not reach a guard asked for by name; such a test has to put
the user in the session.

The scaffold never overwrites a controller the app already has, so an app that ran
`--mcp-oauth` before this release keeps the old check until it changes its copy.
After updating this package, make the change by hand in
`app/Http/Controllers/McpOAuthController.ts`:

```ts
// beside LOGIN_PATH, at the top of the file:
const SESSION_GUARD = 'web'

// in show() and in approve(), the line that reads the user:
const userId = await this.auth.guard(SESSION_GUARD).id()
```

Use your session guard's name if it is registered under another one. Or copy the
template over your file and put your own edits back with `git diff`:

```bash
cp node_modules/@guren/plugin-cloudflare/templates/mcp-oauth/app/Http/Controllers/McpOAuthController.ts app/Http/Controllers/
```

If you copy, also compare your `app/View/` pages with the package's
`templates/mcp-oauth/app/View/`, since the controller passes them their props.
Moving your controller aside so a build scaffolds a new one does not work once the
routes are mounted: the app build runs before the scaffold and fails on the missing
controller.

Grants issued before the change stay valid until they expire.
`env.OAUTH_PROVIDER.listUserGrants(userId)` and `revokeGrant(grantId, userId)` end
one sooner.
