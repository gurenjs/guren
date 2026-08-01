/**
 * Compact digest of the framework API signatures agents hunt for most.
 *
 * Appended to the `guren context` project map so the signatures arrive
 * *before* any work starts — the map is injected at session start by the
 * agent harness's SessionStart hook and served by the `guren_get_context`
 * MCP tool. The glob-scoped rule files under `.claude/rules/` carry the
 * full, verified reference, but they only attach once a matching file is
 * edited; most API research happens earlier, so the essentials ride along
 * here. Keep this digest a strict summary of those rule files — they are
 * the source of truth, and anything stated here must match them.
 */
export const GUREN_API_DIGEST = `## Guren API Signatures (digest)

Verified quick reference — trust this and \`.claude/rules/*.md\` over grepping \`node_modules/@guren/*\`.

### Models (@guren/orm)
- Statics: \`find(id)\` → record | null · \`findOrFail(id)\` (throws, renders 404) · \`first(where?)\` ·
  \`all()\` · \`create(data)\` · \`update(where, data)\` · \`delete(where)\` · \`paginate(options?)\` ·
  \`transaction(async (trx) => ...)\` · \`forceCreate/forceUpdate\` (bypass fillable — never pass request input)
- Where: \`where({ a: 1, ids: [1, 2] })\` (object = AND, array value = IN) or \`where(field, op, value)\` —
  operators (exact set): \`=\` \`!=\` \`>\` \`<\` \`>=\` \`<=\` \`like\` \`in\` \`not in\` \`is null\` \`is not null\`
- QueryBuilder chain: \`where / orWhere / whereNull / whereNotNull / whereIn / whereNotIn /
  orderBy(field, 'asc' | 'desc') / limit(n) / offset(n) / with(...relations) / scope(name)\` →
  terminate with \`get() / first() / firstOrFail() / count() / paginate(page?, perPage?) / update(data) / delete()\`
- Pagination: \`Model.paginate({ page?, perPage?, where?, orderBy? })\` →
  \`{ data, meta: { total, perPage, currentPage, totalPages, hasMore, from, to } }\`.
  HTTP/Inertia links: \`paginate(result, { path?, query?, fragment? })\` from \`@guren/core\`
  (those three fields are \`PaginatorOptions\`)
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
- Route model binding: route option \`bind: { id: Post }\` + \`this.model(Post)\` (already resolved, 404 on miss)
- \`await this.authorize('update', [Post, post])\` (throws → 403)

### Testing (@guren/testing)
- \`const app = await TestApp.create()\` · \`app.actingAs(user)\` / \`app.json()\` / \`await app.withCsrf()\` — each returns a NEW TestApp
- \`await app.get('/posts').assertOk()\` · assertions: \`assertStatus / assertCreated / assertRedirect(url?) /
  assertUnprocessable / assertJson / assertJsonPath(path, value) / assertInertia(component, props?)\`

Full reference and gotchas: \`.claude/rules/orm-models.md\`, \`controllers-http.md\`, \`routes-codegen.md\`, \`testing.md\`.`
