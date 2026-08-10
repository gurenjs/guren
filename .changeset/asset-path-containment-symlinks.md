---
'@guren/server': patch
---

Make asset path containment survive symlinks

`resolve()` collapses `..` but does not follow symlinks, while every reader
downstream of these checks does — `Bun.file().text()`, `.arrayBuffer()`, and
`new Response(file)`. So a request for `resources/js/link/secret.txt`, where
`link` points out of the tree, resolved to a path lexically under the root,
passed the containment check, and was served from wherever the link led. The
dev transpiler route, both Inertia client routes, and the root public asset
middleware were all affected.

Containment is now judged on canonicalized paths, once the target is known to
exist — the point at which it can be canonicalized, and, for the dev
transpiler, the point at which extension probing has settled which file is
actually read. Both sides are canonicalized, not just the candidate: a root
reached through a symlink is routine (workspace and pnpm layouts, containers,
macOS `/var`), and canonicalizing only the candidate would reject every asset
such an app serves.

The four call sites now share `isPathWithin` / `isRealPathWithin`, so this
decision lives in one place instead of four copies of a `startsWith`.

The configured entry points are deliberately exempt: they come from
configuration rather than from the request, and a package layout may
legitimately have the resolved module symlinked out of its own directory.

Closing this needs local write access inside the project, so it is defense in
depth rather than a live hole. It is a behavior change all the same: an asset
deliberately symlinked out of `public/` is no longer served through the
root-level public asset route. Serve it through `/public/*` (Hono's
`serveStatic`, unaffected) or copy the file into the tree.
