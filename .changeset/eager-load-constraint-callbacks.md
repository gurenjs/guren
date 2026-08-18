---
"@guren/orm": minor
---

Apply `with()` constraint callbacks when eager loading

`QueryBuilder.with()` accepts the object form
`with({ posts: (q) => q.where('published', true) })` and stored each callback,
but nothing ever read the stored map. Eager loading iterated only the relation
names, so the callback silently did nothing and the relation loaded fully
unconstrained, while the JSDoc advertised the feature as supported.

Constraint callbacks now reach the query that fetches the relation, for every
relation type (`hasMany`, `hasOne`, `belongsTo`, `belongsToMany`,
`hasManyThrough`, `morphMany`, `morphTo`) on `get()`, `first()` and `paginate()`
alike. The callback runs with the foreign-key filter already on the builder, so
a `where()` narrows it, and on the same query options the relation would have
used anyway — a constrained relation still loads on its parent query's
transaction.

Each object key constrains exactly the level it names, in any order: `posts`
constrains the head, `posts.comments` constrains the leaf and leaves `posts`
unfiltered, and listing both constrains both.

Three behaviours are worth knowing, and are documented in the database guide:

- A top-level `orWhere()` inside a callback *widens* the query rather than
  narrowing it, since it ORs against the foreign-key filter. Group it to keep
  it contained. `morphMany` no longer trusts the query alone for this — it
  groups results on the morph type as well as the id, so a widened constraint
  can no longer attach another model's rows to a parent.
- A `select()` must include the column the relation is keyed on, or the loader
  cannot match rows back to their parent and the relation loads empty.
- Relations load with one batched query for all parent records, so `limit()`
  caps that whole query rather than applying per parent; and for `morphTo` the
  callback runs once per morph target, so it may only reference columns every
  target shares.

Eager loading also no longer walks a relation path whose head another path
already covers. Loading `posts` and `posts.comments` together used to fetch
`posts` twice, and the second fetch replaced the very rows the first pass had
attached children to — so whichever path ran last won. Only the longest path is
walked now, which removes the redundant query and makes the result independent
of the order the relations were named in.

The static `Model.with()` is unchanged — its second argument filters parent
records, not the relation.
