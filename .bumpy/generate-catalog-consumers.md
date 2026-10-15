---
'@varlock/bumpy': patch
---

`bumpy generate` now maps commits that change a catalog entry (`pnpm-workspace.yaml`, `.yarnrc.yml`, root `package.json`) to the packages consuming it via `catalog:`, so a catalog bump produces the bump file `bumpy check` asks for.
