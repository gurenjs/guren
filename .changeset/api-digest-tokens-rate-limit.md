---
'@guren/cli': patch
---

The API digest `guren context` prints (and the harness SessionStart hook injects) gains API Tokens and Rate Limiting sections: `createApiToken`, `verifyApiToken`, `getUserApiTokens`, `revokeApiToken`, the ability helpers, `MemoryApiTokenStore`, `DatabaseApiTokenStore` and the table shape it expects, `createBearerTokenMiddleware`, `getApiToken`, and `createRateLimitMiddleware` with the per-token keying pattern.
