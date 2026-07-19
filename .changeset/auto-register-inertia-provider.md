---
'@guren/server': patch
---

Auto-register `InertiaServiceProvider` after user providers. Validation errors on Inertia requests are now redirected with the error bag as expected instead of returning a raw JSON 422 that triggered the Inertia error modal. Apps that registered the provider explicitly keep working unchanged.
