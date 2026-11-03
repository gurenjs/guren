---
'@guren/server': minor
---

A CSRF failure on a browser navigation (a request that accepts `text/html` and is not an Inertia visit, an XHR or a JSON caller) now answers a 419 "Page Expired" page telling the user to go back, reload the page and submit the form again. Since generated forms post natively before React hydrates, such a submit used to show the raw `{"message":"CSRF token mismatch"}` JSON as the page. JSON, XHR and Inertia callers keep the 403 JSON body unchanged, and an `onError` passed to `createCsrfMiddleware()` still answers every failure. A browser test that asserted a 403 for a native form post without a token now sees 419.
