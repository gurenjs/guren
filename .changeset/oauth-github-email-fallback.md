---
'@guren/server': minor
---

Add `fetchFallbackEmail` to `OAuthProviderConfig`: an optional async hook consulted when the userinfo response carries no email. `createGitHubOAuthProviderConfig` now supplies a default implementation that fetches the primary verified address from GitHub's `/user/emails` endpoint — GitHub returns `email: null` for accounts with a private email even when the `user:email` scope was granted, which previously made OAuth sign-in fail for those accounts.
