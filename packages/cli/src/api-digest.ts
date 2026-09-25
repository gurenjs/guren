/**
 * Compact digest of the API signatures agents hunt for most, appended to the
 * `guren context` map so they arrive before any work starts — the glob-scoped
 * rule files under `.claude/rules/` only attach once a matching file is edited.
 * Most sections summarize those rules; Health Checks, Redirect Safety, API
 * Tokens and Rate Limiting have no rule file and summarize `docs/en/guides/`
 * instead. Keep each section a strict summary of whichever source backs it.
 */
export const GUREN_API_DIGEST = `## Guren API Signatures (digest)

Verified quick reference — trust this and \`.claude/rules/*.md\` over grepping \`node_modules/@guren/*\`.

### Models (@guren/core)
- Statics: \`find(id)\` → record | null · \`findOrFail(id)\` (throws, renders 404) · \`first(where?)\` ·
  \`all()\` · \`create(data)\` · \`update(where, data)\` · \`delete(where)\` · \`paginate(options?)\` ·
  \`transaction(async (trx) => ...)\` · \`forceCreate/forceUpdate\` (bypass fillable — never pass request input)
- Where: \`where({ a: 1, ids: [1, 2] })\` (object = AND, array value = IN) or \`where(field, op, value)\` —
  operators (exact set): \`=\` \`!=\` \`>\` \`<\` \`>=\` \`<=\` \`like\` \`in\` \`not in\` \`is null\` \`is not null\`.
  NULL: \`whereNull(field)\` / \`whereNotNull(field)\`, or the operator form \`where(field, 'is null', null)\` / \`orWhere(field, 'is null', null)\`;
  two-argument \`where(field, 'is null')\` is \`= 'is null'\` and throws.
  An empty \`in\` array compiles to SQL \`false\` — matches nothing, never throws
- QueryBuilder chain: \`where / orWhere / whereNull / whereNotNull / whereIn / whereNotIn /
  orderBy(field, 'asc' | 'desc') / limit(n) / offset(n) / with(...relations) / scope(name)\` →
  terminate with \`get() / first() / firstOrFail() / count() / paginate(page?, perPage?) / update(data) / delete()\`
- Pagination: \`Model.paginate({ page?, perPage?, where?, orderBy? })\` →
  \`{ data, meta: { total, perPage, currentPage, totalPages, hasMore, from, to } }\` — no \`links\`.
  HTTP/Inertia links: \`paginate(result, { path?, query?, fragment? })\` from \`@guren/core\`
  (those three fields are \`PaginatorOptions\`); it serializes as \`{ data, meta, links }\`.
  In tests assert the shape the route actually returns, e.g. \`assertJsonPath('meta.total', 3)\`
- Relations (declaration): \`hasOne/hasMany(name, related, foreignKey, localKey)\` ·
  \`belongsTo(name, related, foreignKey, ownerKey)\` ·
  \`belongsToMany(name, related, pivotTable, foreignPivotKey, relatedPivotKey, parentKey = 'id', relatedKey = 'id')\`
  (7 args; \`pivotTable\` is the Drizzle table) ·
  \`hasManyThrough(name, related, through, firstKey, secondKey, localKey = 'id', secondLocalKey = 'id')\`
- Eager loading: \`Model.with('tags')\` / \`with(['author', 'tags'], where?)\` / \`with('comments.author')\` ·
  \`findWith(id, rels)\` · \`findWithOrFail(id, rels)\` · \`withCount('tags')\` · \`withPaginate('tags', { page })\`
- No \`attach/detach/sync\` — create/delete rows on a pivot model. No \`firstOrCreate/updateOrCreate\` — hand-roll with \`first()\` + \`create()\`

### Controllers (@guren/core)
- Route contract \`{ params, query, body }\` is validated before the action (422); read the parsed values with
  \`this.validated('posts.store')\` → \`{ params, query, body }\` (typed by \`guren codegen\`, undeclared segments \`undefined\`)
- \`await this.validateBody(schema)\` (throws → 422) · \`this.validateQuery(schema)\` · \`this.validateParams(schema)\` — any Zod-like schema, for routes without a contract
- \`this.inertia(pages.posts.Show, props)\` · \`this.redirect(url)\` (302 GET, 303 non-GET) · \`this.json(data)\`
- \`this.auth\` — every method is async, always \`await\`: \`userOrFail<UserRecord>()\` (throws → 401;
  pass \`<T>\` — the default type has no \`.id\`) · \`user<T>()\` · \`check()\` · \`guest()\` ·
  \`login(user, remember?)\` · \`attempt(credentials, remember?)\` · \`logout()\`
- Route model binding: route option \`bind: { id: Post }\` (primary key) or \`bind: { slug: [Post, 'slug'] }\` (another column)
  + \`this.model(Post)\` (already resolved, 404 on miss). Router-level \`router.bind(param, Post | [Post, 'slug'] | resolverFn)\`
  binds every route with that param; its value arrives as a positional arg after the context (models also via \`this.model()\`) —
  never on \`this.ctx.get()\`
- \`await this.authorize('update', [Post, post])\` (throws → 403)

### Routes (@guren/core)
- Agent tools: \`.agent({ description })\` (or \`agent:\` in the route options) exposes a route as an MCP tool —
  schemas derived from the route's own \`params\`/\`query\`/\`body\`/\`output\`. One declaration per route,
  a route \`.name()\` is required (it *is* the tool name), and anything not read-only needs
  authorization — \`this.auth.userOrFail()\` alone fails \`guren check\`

### Health Checks (@guren/core)
- \`const health = createHealthManager()\` · \`health.register(check, { timeout?, critical? })\` — \`timeout\` in ms, default \`5000\`;
  \`critical\` defaults to \`false\` — an unhealthy critical check fails the whole report \`unhealthy\`, a non-critical one only \`degrades\` it
- \`new DatabaseCheck(db, { name?, query? })\` (defaults \`'database'\`, \`'SELECT 1'\`) — \`db\` is any
  \`{ query(sql): Promise<unknown> }\`, not a raw Drizzle instance (\`.query\` there is the relational-query
  namespace, not a function): wrap it, e.g. \`{ query: (sql) => db.execute(sql) }\` on the Postgres/MySQL
  drivers; bun:sqlite has no \`.execute\`, see \`docs/en/guides/health-checks.md\`
- \`router.get('/health', health.middleware({ checks?, detailed? }))\` — \`checks\` runs only those names,
  \`detailed\` (default \`true\`) includes per-check results; responds 200 for \`healthy\`/\`degraded\`, 503 for \`unhealthy\`

### Redirect Safety (@guren/core)
- \`isSafeRedirectUrl(url, requestUrl, allowedHosts?)\` → boolean — same origin as \`requestUrl\`, or a host in \`allowedHosts\`
- \`sanitizeOAuthRedirect(redirectTo, allowedHosts?)\` → app-relative paths always pass; protocol-relative URLs, backslash
  tricks and non-http schemes never do; an absolute URL passes only with an allowlisted host, else \`undefined\`
- \`createRedirectSafetyMiddleware({ allowedHosts?, fallbackUrl? })\` (opt-in) — rewrites an unsafe 3xx \`Location\` to
  \`fallbackUrl\` (default \`'/'\`); keep its \`allowedHosts\` in sync with \`sanitizeOAuthRedirect\`'s or it rewrites an approved redirect

### API Tokens (@guren/core)
- \`createApiToken(store, { name, userId, abilities?, expiresIn?, tokenLength? })\` → \`{ plainTextToken, token }\` —
  \`plainTextToken\` is shown once; \`abilities\` defaults to \`['*']\`, \`expiresIn\` is ms (default never)
- \`verifyApiToken(plainTextToken, store, { updateLastUsed? })\` → \`{ token, userId, abilities } | null\` (null if invalid or expired) ·
  \`getUserApiTokens(userId, store)\` · \`revokeApiToken(id, store)\` · \`revokeAllApiTokens(userId, store)\` — only \`createApiToken\` takes the store first
- Abilities: \`tokenCan(token, ability)\` · \`tokenCanAll(token, abilities)\` · \`tokenCanAny(token, abilities)\` — \`'*'\` grants every ability
- \`new MemoryApiTokenStore()\` — tests only
- \`new DatabaseApiTokenStore(table, { abilitiesMode? })\` — production; the ORM must be configured; \`abilitiesMode: 'text'\` for a
  plain-text JSON column; \`store.deleteExpired()\` prunes. Table property names are the \`ApiToken\` fields: \`id\` \`name\`
  \`hashedToken\` (unique) \`userId\` \`abilities\` (\`jsonb\` / \`text(..., { mode: 'json' })\`) \`lastUsedAt\` \`expiresAt\` \`createdAt\`;
  timestamps \`timestamp(...)\` on pg, \`integer(..., { mode: 'timestamp_ms' })\` on SQLite
- \`createBearerTokenMiddleware({ store, loadUser?, abilities?, onUnauthorized?, onForbidden?, headerName?, updateLastUsed? })\` —
  401 on a missing or invalid token; \`abilities\` requires ALL of them (403). The token's user becomes the principal
  (\`this.auth.user()\`, policies) through \`loadUser\` or \`app.auth.useTokens(store)\`; a \`loadUser\` returning \`null\` leaves it unauthenticated
- \`getApiToken(ctx)\` → \`{ token, userId, abilities }\`, \`undefined\` when no token (test with \`!\`, not \`=== null\`) ·
  \`getApiTokenOrFail(ctx)\` (throws → 401) — in a controller pass \`this.ctx\`

### Rate Limiting (@guren/core)
- \`createRateLimitMiddleware({ limit?, windowMs?, keyGenerator?, store?, keyPrefix?, skip?, trustProxy? })\` — defaults \`100\` per
  \`60000\` ms; past the limit responds 429 with \`Retry-After\`
- Default key is \`server.requestIP()\`; without it (TestApp, Lambda) every client shares one per-route bucket — pass \`keyGenerator\`
  (or \`trustProxy: true\`, only behind a proxy that sets the IP headers)
- Per token: mount after the bearer middleware, \`.middleware(bearer, limiter)\`, with
  \`keyGenerator: (ctx) => 'token:' + (getApiToken(ctx)?.token.id ?? 'anonymous')\` (\`.userId\` for a per-user quota across tokens);
  it only counts requests that authenticated, so put an IP-keyed limiter before the bearer middleware against token guessing.
  The bearer middleware never sets \`ctx.get('user')\`
- Limiters without a \`store\` share one in-process map under \`keyPrefix\` \`'rl:'\`: give each its own \`keyPrefix\`, or two
  per-token limiters count into one bucket; across instances pass a shared \`store\`

### Testing (@guren/testing)
- \`const app = await TestApp.create()\` · \`app.actingAs(user)\` / \`app.json()\` / \`await app.withCsrf()\` — each returns a NEW TestApp
- HTTP helpers: \`get(path)\` · \`post/put/patch/delete/query(path, body?)\` (\`query\` = HTTP QUERY, RFC 10008)
- \`await app.get('/posts').assertOk()\` · assertions: \`assertStatus / assertCreated / assertRedirect(url?) /
  assertUnprocessable / assertJson / assertJsonPath(path, value) / assertInertia(component, props?)\`

Full reference and gotchas: \`.claude/rules/orm-models.md\`, \`controllers-http.md\`, \`routes-codegen.md\`, \`testing.md\`;
health checks, redirect safety, API tokens, rate limiting: \`docs/en/guides/health-checks.md\`, \`authentication.md\`,
\`api-tokens.md\`, \`rate-limiting.md\` in the Guren framework repo.`
