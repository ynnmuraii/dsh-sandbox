# Cordis Model

> **SOURCE OF TRUTH.** This file is compiled by `lab sync-context` into `plugins/*/.dsh-lab/shared-context.md`. Edit here, not in plugin snapshots.

The Fiber/effect/dependency model under DeepSeek Harness. Grounded in upstream Cordis source and the pinned Harness revision.

## Fiber state machine

```
PENDING → LOADING → ACTIVE → UNLOADING → DISPOSED
                         ↘ FAILED
```

- `apply` runs only after mandatory services are ready.
- Disappearance of a required provider unloads the dependent Fiber; its re-appearance re-activates it.

## Effects

Registrations made through `ctx` are effects and MUST be torn down on unload:

- `ctx.on(...)` removes its listener at unload.
- Tool/LLM adapter registry registrations belong to the Fiber.
- External resources: acquire inside `ctx.effect(() => disposer)` and return a disposer.

**Rule.** On unload the Fiber walks disposers in reverse order. Async disposers may run concurrently, so order-dependent teardown MUST live in one async disposer that `await`s sequentially. Cleanup failure is a lifecycle-test failure, not a warning. [РЕКОМЕНДАЦИЯ]: hold ordered teardown in a single disposer.

## Dependency model

- `inject` is the mandatory dependency contract — never hide a required service behind `ctx.get()`.
- Optional dependencies: obtain via `ctx.get(name)` at point of use; do not touch undeclared proxy properties.
- Service = a named capability on `ctx` (`ctx.tools`, `ctx.llm`, …); a Service class registers the name it provides.
- For independently swappable capabilities keep the three roles (Service Definition, Provider, Consumer) and their contracts separate.

## Composability guarantees (paper)

- **Temporal**: unloading a component fully restores side effects.
- **Spatial**: declarative, reactive dependency management.
- Named keys do not by themselves guard against interface drift or key collision; provider replacement is exercised through one key.
- Mutual dependency cycles leave components inactive — resolve by decomposing integration components.
