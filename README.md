# dsh-lab

DeepSeek Harness plugin laboratory: a meta-repo for authoring, pinning, and
verifying external plugins that ship as installable bundles.

The lab is an agent-first forge: an agent and its harness use it as a bounded
environment for creating and checking plugins. The first-slice commands are:

```text
pnpm lab inspect <name>|--path P [--json]
pnpm lab dev <name>|--path P --target T
pnpm lab verify <name>|--path P --target T [--json]
pnpm lab status <name>|--path P [--json]
pnpm lab ui start <name>|--path P --target T [--json]
pnpm lab ui status <session-id> [--json]
pnpm lab ui finish <session-id> --verdict pass|fail --summary "..." [--json]
pnpm lab ui abort <session-id> [--json]
```

`dev` is live/in-place and read-only with respect to the plugin: it reads the
current source, including uncommitted and untracked files, while profiles and
overlays stay under the forge's `.lab/runtime`. `verify` copies that current
source into a temporary workspace and always removes the temporary workspace;
the forge keeps only minimal evidence as memory of the result. Catalog lookup
is convenient and `init`/initialization is optional; only explicit authoring commands mutate plugin repositories. The portable agent entrypoint is
`.agents/skills/dsh-plugin-development/SKILL.md`; it is hand-authored advisory
methodology for the agent. `pnpm lab sync-context` regenerates the
`.dsh-lab/shared-context.md` snapshots inside each plugin repo from
`context/*.md`, while `pnpm lab doctor` reports missing or stale snapshots
without writing files.

The `lab ui start/status/finish/abort` family is a separate protocol for a
temporary isolated runtime and minimal factual UI verdict. An external browser
or vision agent/harness owns navigation and visual decisions; screenshots and
browser artifacts are transient and not retained by the lab.

- **Author guide & recipes** — [docs/using-the-lab.md](docs/using-the-lab.md)
- **Root context library** — [context/](context/) (plugin shared-context snapshots derive from it)
- **Portable agent skill** — [.agents/skills/dsh-plugin-development/SKILL.md](.agents/skills/dsh-plugin-development/SKILL.md)
- **Compatibility pins** — [workbench/compatibility.yaml](workbench/compatibility.yaml)
- **Plugin index** — [catalog.yaml](catalog.yaml)

## Quick start

```bash
pnpm install
pnpm lab doctor          # toolchain + pins
pnpm lab upstream check  # compare pinned master with the configured remote
pnpm lab new my-plugin   # scaffold a plugin
cd plugins/my-plugin
pnpm install --config.minimumReleaseAge=0 --config.strictDepBuilds=false
pnpm test
```

Adopt a reviewed upstream `master` explicitly with
`pnpm lab upstream update`. Add `--verify` to run the root checks, build the
adopted checkout, and verify every catalogued plugin that declares `master`.
The updater never commits, pushes, merges, resets, or rolls changes back.

See [docs/using-the-lab.md](docs/using-the-lab.md) for the full recipe set and
troubleshooting.
