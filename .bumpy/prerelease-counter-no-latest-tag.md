---
'@varlock/bumpy': patch
---

Fixed prerelease counters restarting at `.0` on registries that don't set a `latest` dist-tag (e.g. GCP Artifact Registry). `npm info <name> versions` resolves through `latest` and prints nothing when it's missing, so bumpy now falls back to the channel's dist-tag and warns if the version list still can't be read. Snapshot idempotency now checks the exact version, and the OIDC new-package check no longer misreports packages without `latest` as missing.
