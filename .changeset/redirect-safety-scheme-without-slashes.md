---
'@guren/server': patch
---

`isSafeRedirectUrl()` and `createRedirectSafetyMiddleware()` now read a redirect target that carries its own scheme without the request URL as a base. Behind a proxy that ends TLS, the request reads `http:` while the browser is on `https:`, and the two read `http:evil.com` differently: resolved against the request it is the path `/evil.com` on the app's own host, while the browser takes `evil.com` as the host and leaves the site. Such a value is now judged by the host it names, so `http:evil.com` and `http:/evil.com` are rewritten to `fallbackUrl`. A value with no scheme (`/dashboard`, `next`, `?page=2`) is resolved against the request URL as before, and no value that was refused is now accepted. A target written as a scheme with no `//` whose first segment is not the request host, such as `http:/dashboard` on an `http:` request, used to pass as a path on the app and is now rewritten too.
