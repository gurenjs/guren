---
"@guren/server": patch
---

Resume failed application boots without repeating completed startup steps or route registrars. Prepare all route handlers before mounting them, so an invalid later route does not leave earlier routes partially mounted. Failed hooks remain retryable and must handle their own partial effects.
