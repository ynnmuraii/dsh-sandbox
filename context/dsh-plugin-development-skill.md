# DSH Plugin Development

This is the agent-owned forge for creating, studying, debugging, and verifying independent DeepSeek Harness plugins. Keep shared rules in the canonical context, keep plugin implementation in its standalone repository, and collect evidence at both integration boundaries so a fast local loop does not masquerade as a packaged release.

## Canonical routing

| Concern | Canonical document |
| --- | --- |
| Public exports, patch layers, and API boundaries | [Harness contracts](harness-contracts.md) |
| Fiber, effects, injection, and disposal | [Cordis model](cordis-model.md) |
| Repository layout and package metadata | [Plugin anatomy](plugin-anatomy.md) |
| Required behavior, lifecycle, and compatibility evidence | [Testing policy](testing-policy.md) |
| Target claims and pinned compatibility | [Compatibility](compatibility.md) |

## Recommended loop

Use the smallest useful loop: `pnpm lab inspect <name> --target <target>`, then `pnpm lab dev <name> --target <target>` while iterating, `pnpm lab verify <name> --target <target>` before handoff, and `pnpm lab status <name>` to summarize evidence and repository state. Use `--path` for an external standalone plugin.

Treat source overlay and installable bundle as separate acceptance boundaries. Source mode proves live source behavior and HMR against a fixed checkout; bundle mode proves the packed package installs and boots. Test both when the change affects either boundary.

Every registry, listener, adapter, and external resource must be HMR-safe: register through the contributing Fiber, acquire resources inside `ctx.effect()` with a disposer, and prove cleanup on unload. Keep order-dependent asynchronous teardown in one disposer that awaits each step. Declare mandatory services with `inject`; resolve optional services only at their point of use.

SDD, TDD, planning, review, and orchestration are advisory workflows: use them to clarify seams, risks, evidence, and ownership, but let the canonical contracts and tests decide behavior. Prefer a narrow red-green cycle and review the resulting diff independently.

Only explicit authoring commands may mutate plugin repositories. Never manufacture plugin state during inspection or synchronization. Keep credentials and secrets in ignored runtime environment only. Release a plugin as its own repository with its own versioning, package, tests, and publication decisions; the meta-repo does not publish it. Production code imports public npm APIs only, never files from an upstream Harness checkout.
