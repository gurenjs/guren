---
'@guren/cli': patch
'create-guren-app': patch
---

Every scaffolded page now sets its document title with Inertia's `<Head>`. The dashboard `make:auth` writes and the blog blueprint ships, the admin blueprint's dashboard, the Index, Show, New and Edit pages `make:feature` writes, and the page `make:view` writes rendered none, so after an Inertia visit to one of them the document had no title of its own and axe reported `document-title`. The `make:feature` pages are titled after the resource (`Posts`, `Post`, `New Post`, `Edit Post`), a `make:view` page after its component, and the dashboards `Dashboard` and `Admin dashboard`. Pages already in an app are not rewritten.
