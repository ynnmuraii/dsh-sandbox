# Runtime state

Everything under `.lab/runtime/` is machine-generated, git-ignored, and safe to
delete. It holds ephemeral profiles, absolute source overlays, logs, caches,
and DSH home data produced by `lab dev` / `lab verify`. Real credentials
belong in an ignored `.env` or an external store, never here.
