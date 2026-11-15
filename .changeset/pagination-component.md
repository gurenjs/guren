---
"@guren/cli": minor
"create-guren-app": minor
---

`guren add ui` copies a `Pagination` component, and the default starter ships it. It renders a paginator's `links` as previous, page numbers and next with Inertia `<Link>`s: the current page carries `aria-current="page"`, a page with no URL is not a link, a single page renders nothing, and long runs collapse to the first page, the last page and `siblings` (default 1) pages around the current one. `make:feature`'s index page renders `<Pagination links={pagination.links} />` in place of its hand-written loop, which linked a page with no URL to `#` and listed every page. The Dev Center's component catalog shows it.
