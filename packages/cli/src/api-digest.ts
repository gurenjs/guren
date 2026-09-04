/**
 * Compact digest of the API signatures agents hunt for most, appended to the
 * `guren context` map so they arrive before any work starts — the glob-scoped
 * rule files under `.claude/rules/` only attach once a matching file is edited.
 * Those rules are the source of truth; keep this a strict summary of them.
 */
export const GUREN_API_DIGEST = `## Guren API Signatures (digest)

Verified quick reference — trust this and \`.claude/rules/*.md\` over grepping \`node_modules/@guren/*\`.

### Models (@guren/orm)
- Statics: \`find(id)\` → record | null · \`findOrFail(id)\` (throws, renders 404) · \`first(where?)\` ·
  \`all()\` · \`create(data)\` · \`update(where, data)\` · \`delete(where)\` · \`paginate(options?)\` ·
  \`transaction(async (trx) => ...)\` · \`forceCreate/forceUpdate\` (bypass fillable — never pass request input)
- Where: \`where({ a: 1, ids: [1, 2] })\` (object = AND, array value = IN) or \`where(field, op, value)\` —
  operators (exact set): \`=\` \`!=\` \`>\` \`<\` \`>=\` \`<=\` \`like\` \`in\` \`not in\` \`is null\` \`is not null\`.
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
- \`await this.validateBody(schema)\` (throws → 422) · \`this.validateQuery(schema)\` · \`this.validateParams(schema)\` — any Zod-like schema
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

### Testing (@guren/testing)
- \`const app = await TestApp.create()\` · \`app.actingAs(user)\` / \`app.json()\` / \`await app.withCsrf()\` — each returns a NEW TestApp
- HTTP helpers: \`get(path)\` · \`post/put/patch/delete/query(path, body?)\` (\`query\` = HTTP QUERY, RFC 10008)
- \`await app.get('/posts').assertOk()\` · assertions: \`assertStatus / assertCreated / assertRedirect(url?) /
  assertUnprocessable / assertJson / assertJsonPath(path, value) / assertInertia(component, props?)\`

Full reference and gotchas: \`.claude/rules/orm-models.md\`, \`controllers-http.md\`, \`routes-codegen.md\`, \`testing.md\`.`
