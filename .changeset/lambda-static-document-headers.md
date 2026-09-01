---
"@guren/plugin-lambda": minor
---

Carry the static-document download policy onto AWS Lambda's CloudFront distribution.

The CDK construct stages `public/` into S3 and puts a cache behavior for it in
front of the app, so CloudFront answers for those files before the function
runs and the framework's own guard never sees the request: an `.svg` under
`public/` rendered inline, script and all, on the app's origin. This is the
same gap the Cloudflare and Vercel builds close, on the third target that
serves `public/` off-app.

The construct now attaches a viewer-response CloudFront function to the asset
behaviors, setting `Content-Disposition: attachment` and
`X-Content-Type-Options: nosniff` on the types a browser renders as a
document. Its extensions come from the same `DOCUMENT_ASSET_EXTENSIONS` the
other two plugins read, so the three targets cannot drift apart.

A function rather than one cache behavior per extension: a behavior is chosen
by path, so `*.svg` would also capture a `/feed.svg` the *app* renders and
send it to S3, and CloudFront's default limit of 25 behaviors is already spent
one per staged root entry. The association rides on the asset behaviors alone,
so the default behavior — your app — keeps answering with its own headers.
Reading the extension off the path also covers `logo.SVG`, which the framework
guard catches and a literal pattern cannot.

Deploying `.lambda/assets` by hand, without the construct, still serves those
files inline; the serverless guide says so.
