---
"@guren/server": minor
"@guren/core": minor
---

Let a Resource declare its payload type, so `toJSON()` reports it

`Resource<T>` now takes an optional second type argument for the payload
`toArray()` builds:

```ts
export class PostResource extends Resource<PostRecord, PostResourceData> {
  toArray(): PostResourceData {
    return { id: this.resource.id, title: this.resource.title }
  }
}
```

`toJSON()` returns `PostResourceData` instead of `Record<string, unknown>`,
which removes the override every scaffolded resource used to carry — a method
whose only body was `return super.toJSON() as PostResourceData`, a cast nothing
checked against the `toArray()` right above it.

The parameter defaults to `ResourceData`, so `Resource<T>` and existing
overrides keep compiling unchanged. `JsonResource<T>` deliberately stays on the
default: narrowing it to `T` would reject a subclass whose `toArray()` returns a
subset, which is a break no minor should carry.

`TData` describes `toArray()`. `additional()` still takes arbitrary
`ResourceData` and is spread after the payload, so a colliding key can still
overwrite a typed field — use it for keys beside the payload, not inside it.
