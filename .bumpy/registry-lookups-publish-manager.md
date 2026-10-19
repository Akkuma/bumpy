---
'@varlock/bumpy': patch
---

Registry lookups (prerelease counters, already-published checks, snapshot idempotency, and the trusted-publishing new-package check) now run with the configured `publish.publishManager` instead of always using npm, so they read the registry with the same client and auth config that publishes.
