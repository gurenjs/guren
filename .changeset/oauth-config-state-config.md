---
'@guren/server': minor
'@guren/core': minor
---

`defineOAuthConfig()` accepts `stateConfig`, the same state options `createOAuthManager()` takes. An app that allows external post-login redirects can now declare the allowlist in `config/oauth.ts` instead of binding `oauth` in a provider:

```ts
export default defineOAuthConfig((env) => ({
  providers: { github: createGitHubOAuthProviderConfig({ /* ... */ }) },
  stateConfig: { allowedRedirectHosts: ['app.example.com'] },
}))
```
