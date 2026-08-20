# Agent rules for this plugin

1. Read `.dsh-lab/shared-context.md` first — it is the compiled common context.
2. Read this file — it holds plugin-local architecture and commands.
3. All registrations must be fiber-owned (reversible on unload).
4. Production code imports only public npm APIs (`@deepseek-ai/*`, `@deepseek-ai/cordis`).
5. Required services go in `inject`; optional ones via `ctx.get(name)`.
6. Commands: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm pack`.
