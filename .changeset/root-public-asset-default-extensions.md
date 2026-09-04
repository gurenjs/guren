---
'@guren/server': minor
---

Export `DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS` from `@guren/core/runtime`.

`rootPublicAssets.extensions` replaces the default list rather than extending
it, so an app that wanted one more extension had to restate the defaults —
and then silently missed every extension added to the framework afterwards.
Spread the export instead:

```ts
rootPublicAssets: { extensions: [...DEFAULT_ROOT_PUBLIC_ASSET_EXTENSIONS, '.js'] }
```

`RootPublicAssetsConfig` and `RootPublicAssetsOptions` are exported from the
same entry, so the option can be typed without reaching into the package.
