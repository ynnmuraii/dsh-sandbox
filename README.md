# dsh-lab

DeepSeek Harness plugin laboratory: a meta-repo for authoring, pinning, and
verifying external plugins that ship as installable bundles.

- **Author guide & recipes** — [docs/using-the-lab.md](docs/using-the-lab.md)
- **Root context library** — [context/](context/) (shared snapshots derive from it)
- **Compatibility pins** — [workbench/compatibility.yaml](workbench/compatibility.yaml)
- **Plugin index** — [catalog.yaml](catalog.yaml)

## Quick start

```bash
pnpm install
pnpm lab doctor          # toolchain + pins
pnpm lab new my-plugin   # scaffold a plugin
cd plugins/my-plugin
pnpm install --config.minimumReleaseAge=0 --config.strictDepBuilds=false
pnpm test
```

See [docs/using-the-lab.md](docs/using-the-lab.md) for the full recipe set and
troubleshooting.
