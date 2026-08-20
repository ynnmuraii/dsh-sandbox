# Дизайн лаборатории плагинов DeepSeek Harness

Дата: 2026-08-20

## 1. Назначение

`dsh-lab` — meta-репозиторий и локальная библиотека для создания, изучения и проверки независимых плагинов DeepSeek Harness. Он предоставляет общий контекст для людей и агентов, шаблон плагина, каталог вложенных репозиториев и воспроизводимые стенды совместимости.

Каждый плагин остаётся автономным Git-репозиторием со своими версиями, lockfile, CI, документацией и публикацией. Корень лаборатории не является monorepo плагинов и не включает `plugins/*` в общий pnpm workspace.

## 2. Исходные ограничения

- DeepSeek Harness находится в developer preview и предупреждает о compatibility-breaking changes.
- Официально документированы два разных пути: локальный source overlay для разработки и installable bundle для распространения.
- Cordis строит жизненный цикл вокруг Fiber, декларативных зависимостей и обратимых эффектов. Выгрузка плагина должна убрать принадлежащие ему регистрации и ресурсы.
- npm `latest`, npm `next` и upstream `master` могут представлять разные состояния API.
- Лаборатория работает на Windows, но плагины не должны без необходимости зависеть от Windows-specific tooling.
- Зрелые плагины должны быть воспроизводимо привязаны к meta-repo; ранние эксперименты не должны создавать submodule-трение.

Подробные первичные источники и наблюдения собраны в [`research/deepseek-harness-plugin-lab.md`](../../../research/deepseek-harness-plugin-lab.md).

## 3. Цели

1. Дать агенту общий проверенный контекст по Harness/Cordis и отдельный контекст конкретного плагина.
2. Создавать независимый plugin repo с одинаковой минимальной структурой и контрактами.
3. Обеспечить быстрый source/HMR цикл против npm `next` и pinned upstream `master`.
4. Отдельно доказывать, что собранный plugin bundle устанавливается и запускается как пользовательский пакет.
5. Фиксировать точные версии toolchain, npm-пакетов и upstream commit.
6. Поддерживать смешанный каталог: локальные nested repos для экспериментов и Git submodules для зрелых плагинов.
7. Позволять клонировать и разрабатывать любой plugin repo отдельно от лаборатории.

## 4. Не-цели

- Единое версионирование или единый release train всех плагинов.
- Общий lockfile для plugin repos.
- Импорт исходников из checkout DeepSeek Harness в production-код плагинов.
- Собственный plugin framework поверх Cordis.
- Автоматическая публикация npm-пакетов из meta-repo.
- Обещание rollback внешних сетевых или persistent side effects, которыми Cordis не владеет.
- Преждевременное разделение каждого плагина на definition/provider/consumer packages.

## 5. Границы репозиториев

```text
dsh-lab/
├─ AGENTS.md
├─ catalog.yaml
├─ context/
│  ├─ harness-contracts.md
│  ├─ cordis-model.md
│  ├─ plugin-anatomy.md
│  ├─ testing-policy.md
│  └─ compatibility.md
├─ docs/
│  ├─ decisions/
│  └─ recipes/
├─ templates/
│  └─ plugin/
├─ tooling/
│  ├─ create-plugin.ts
│  ├─ sync-context.ts
│  ├─ run-plugin.ts
│  ├─ verify-plugin.ts
│  └─ check-catalog.ts
├─ workbench/
│  ├─ profiles/
│  │  ├─ next/
│  │  └─ master/
│  └─ fixtures/
├─ upstream/
│  └─ deepseek-harness/
├─ references/
│  └─ cordis-paper.pdf
├─ research/
└─ plugins/
   ├─ stable-plugin/
   └─ scratch-experiment/
```

### 5.1 Meta-repo

Meta-repo владеет:

- общими правилами и справочными материалами;
- шаблоном нового plugin repo;
- каталогом известных плагинов;
- инструментами создания, синхронизации контекста и запуска стендов;
- профилями и временными runtime environments;
- pinned checkout DeepSeek Harness;
- периодической compatibility-матрицей зрелых плагинов.

Meta-repo не владеет source, версиями, changelog или publish workflow плагина.

### 5.2 Plugin repo

Каждый `plugins/<name>` является отдельным Git root:

```text
plugin-repo/
├─ AGENTS.md
├─ .dsh-lab/
│  ├─ plugin.yaml
│  └─ shared-context.md
├─ src/
│  └─ index.ts
├─ tests/
├─ cordis.patch.yml
├─ package.json
├─ pnpm-lock.yaml
├─ tsconfig.json
└─ README.md
```

Plugin repo владеет:

- plugin implementation и публичным API;
- bundle patch и package manifest;
- тестами всех контрактов плагина;
- точными dev dependencies и допустимыми peer ranges;
- CI, versioning, changelog и npm publication;
- локальными agent instructions.

## 6. Двухслойный контекст агентов

### 6.1 Канонический общий контекст

`context/*` — источник истины для общих правил:

- публичные plugin contracts Harness;
- модель Fiber/effect/inject Cordis;
- соглашения о структуре внешнего package;
- обязательные lifecycle и Loader checks;
- текущие compatibility targets;
- границы безопасности и необратимых side effects.

Корневой `AGENTS.md` индексирует эти документы и объясняет операции с catalog, submodules и workbench.

### 6.2 Snapshot внутри plugin repo

Plugin repo не должен зависеть от наличия родительской директории. Поэтому общий контекст переносится не относительной ссылкой и не symlink, а сгенерированным snapshot:

1. `sync-context` читает канонические документы.
2. Выбирает общий обязательный набор и, при необходимости, разделы по типу плагина.
3. Записывает `plugin/.dsh-lab/shared-context.md` с версией и hash входов.
4. Snapshot коммитится в plugin repo.
5. Plugin `AGENTS.md` требует сначала прочитать snapshot, затем применяет локальные правила.
6. `check-catalog` сообщает о stale snapshots, но не меняет plugin repos автоматически.

Обновление общего контекста создаёт отдельное reviewable изменение в каждом затронутом plugin repo. Это намеренная денормализация ради standalone-клонирования и явного контроля изменений.

### 6.3 Локальный контекст плагина

`AGENTS.md` конкретного плагина содержит только локальные сведения:

- назначение и non-goals;
- архитектурные границы;
- предоставляемые и потребляемые service keys;
- команды разработки и проверки;
- известные non-revertible effects;
- acceptance criteria и release checks.

Общие правила Cordis/Harness в локальном файле не копируются вручную.

## 7. Смешанный каталог вложенных репозиториев

`catalog.yaml` хранит лабораторную мета-информацию:

```yaml
plugins:
  my-tool:
    path: plugins/my-tool
    repository: https://github.com/example/dsh-plugin-my-tool
    tracking: submodule
    maturity: stable

  scratch-memory:
    path: plugins/scratch-memory
    tracking: local
    maturity: experiment
```

Корневой catalog не дублирует package name, peer dependencies, service keys или compatibility claims. Эти данные находятся в `.dsh-lab/plugin.yaml` и `package.json` plugin repo.

Политика tracking:

- `local`: независимый nested repo игнорируется meta-repo; предназначен для эксперимента.
- `submodule`: meta-repo фиксирует remote и commit зрелого плагина.
- Переход `local → submodule` означает выпуск из инкубатора: создаётся remote, проходят stable checks, каталог меняет tracking, meta-repo регистрирует submodule.

Удаление plugin repo из локальной директории не должно удалять его remote. Удаление submodule выполняется только явной операцией с catalog и `.gitmodules`.

## 8. Compatibility targets

Meta-repo хранит один machine-readable manifest с точными версиями:

```yaml
targets:
  next:
    dsh: 0.1.0-rc.8
    cordis: 4.0.1
    node: 22.20.0
  master:
    repository: deepseek-ai/deepseek-harness
    commit: <exact commit recorded during setup>
    pnpm: 11.7.0
```

`<exact commit recorded during setup>` — не runtime placeholder: команда первоначальной настройки обязана записать конкретный SHA выбранного checkout до первого compatibility run. Дизайн не фиксирует заранее неизвестный будущий SHA.

Правила:

- npm tag `next` разрешается только командой обновления target.
- Обычные install/test используют записанные точные версии и lockfiles.
- `upstream/deepseek-harness` является pinned submodule и не обновляется автоматически.
- Plugin `.dsh-lab/plugin.yaml` перечисляет поддерживаемые target IDs.
- Plugin production code использует только публичные npm imports.
- Harness/Cordis service packages находятся в `peerDependencies`; точные экземпляры для build/test дублируются в `devDependencies`.
- Несовместимость с новым target оформляется как наблюдаемый compatibility failure, а не скрывается source-import или локальным patch upstream.

## 9. Workbench

### 9.1 Минимальные команды

Meta-repo предоставляет пять операций:

```text
lab new <name>
lab dev <name> --target next|master
lab verify <name> [--target next|master|all]
lab sync-context [name|--all]
lab doctor
```

- `new` создаёт автономный nested Git repo из шаблона и регистрирует его как `local` experiment.
- `dev` поднимает source overlay и HMR против выбранного target.
- `verify` запускает проверки самого plugin repo, затем compatibility checks.
- `sync-context` обновляет snapshot общего контекста.
- `doctor` проверяет toolchain, catalog, target pins, submodules и hashes контекста.

Корневые инструменты не изменяют plugin version и не публикуют package.

### 9.2 Runtime state

Все генерируемые профили, абсолютные overlays, logs, caches, credentials и DSH home data находятся в `.lab/runtime/` и игнорируются Git. Versioned profile templates находятся в `workbench/profiles/`.

Секреты не записываются в profile templates, catalog, plugin manifests или snapshots.

## 10. Два независимых режима проверки

### 10.1 Source mode

Поток:

```text
plugin/src → generated absolute overlay → Cordis Loader → HMR → running Harness
```

Назначение: быстрый authoring loop.

Требования:

- overlay указывает на исходный module plugin repo;
- HMR root явно включает plugin source;
- старый Fiber выгружается до активации новой версии;
- invalid import/config оставляет последнюю рабочую композицию;
- режим запуска и target записываются в диагностике.

Успех source mode не доказывает корректность npm package boundary.

### 10.2 Bundle mode

Поток:

```text
plugin repo → build → pnpm pack → dsh plugin add <tarball> → profile boot
```

Назначение: проверка пользовательской установки.

Требования:

- tarball содержит built entry, declarations, patch и package metadata;
- package устанавливается через реальный profile plugin manager;
- bundle появляется в profile composition;
- `--dump-config` показывает ожидаемый итоговый tree;
- Loader запускает built JS обычным Node;
- проверяется наблюдаемый результат плагина;
- отсутствие HMR внутри `node_modules` не считается дефектом release mode.

Source overlay и packed bundle не подменяют друг друга в acceptance evidence.

## 11. Контракт plugin package

Минимальный внешний плагин:

- ESM package;
- однозначный main/exports и declarations;
- `files` включает только необходимые артефакты;
- `dsh.bundle.patch` указывает на bundle patch;
- function plugin использует named exports `name`, `inject`, `Config`, `apply` и не добавляет default export;
- обязательные сервисы объявлены через `inject`;
- необязательные сервисы получаются через `ctx.get()` в месте использования;
- регистрации выполняются через Cordis/Harness context APIs;
- внешние ресурсы приобретаются внутри `ctx.effect()` и возвращают disposer;
- teardown с обязательным порядком находится в одном async disposer;
- сетевые и persistent emissions документируются как non-revertible и при необходимости имеют application-level compensation;
- package не импортирует файлы из `upstream/deepseek-harness`.

Простой tool plugin остаётся одним package. Разделение capability на Service Definition, Provider и Consumer выполняется только если роли действительно заменяемы или меняются независимо.

## 12. Тестовая стратегия

Каждый plugin repo владеет следующими уровнями:

1. **Behavior tests.** Проверяют внешний контракт, границы, ошибки и конфигурацию.
2. **Lifecycle test.** Выгружает contributing Fiber и доказывает удаление registrations, listeners и ресурсов.
3. **Dependency transition tests.** Проверяют required provider absent/present/disappeared и соответствующие состояния Fiber.
4. **Loader composition smoke.** Загружает test-only composition через реальный Loader/process.
5. **Packed bundle smoke.** Устанавливает tarball и запускает built entry.
6. **Real-API smoke.** Добавляется только когда наблюдаемый контракт зависит от настоящего model/provider API; без ключа тест явно пропускается.

Meta-repo не копирует package tests. `lab verify` оркестрирует стандартные команды plugin repo и добавляет проверку выбранных compatibility targets.

Для registry plugin lifecycle test обязателен. Для product-visible plugin ручной `ctx.plugin()` unit test не заменяет Loader/app/process smoke.

## 13. CI и публикация

### 13.1 Plugin CI

Каждый plugin repo выполняет:

- install с собственным lockfile;
- typecheck;
- behavior/lifecycle/dependency tests;
- build;
- pack inspection;
- packed bundle smoke против pinned `next`;
- для зрелого плагина — compatibility smoke против pinned `master`.

### 13.2 Meta-repo CI

Meta-repo выполняет:

- schema/consistency check `catalog.yaml`;
- проверку submodule state;
- проверку target manifest;
- проверку shared-context hashes;
- проверку root tooling;
- периодическую или ручную compatibility matrix зрелых submodules.

Изменение общего контекста не публикует плагины автоматически.

### 13.3 Release ownership

Plugin repo самостоятельно владеет version bump, changelog, npm credentials, provenance и publish command. Meta-repo после релиза обновляет только maturity/status metadata и submodule pointer.

## 14. Диагностика и отказоустойчивость

- Plugin без удовлетворённого `inject` может законно оставаться `PENDING`; `lab dev` должен показывать Fiber state и missing service names.
- Ошибка HMR import/config должна сохранять последнюю рабочую композицию и давать точную диагностику target/plugin/path.
- Ошибка cleanup является провалом lifecycle test, а не warning.
- Несовпадение package и target versions должно завершать `lab doctor`/`lab verify` с ошибкой до запуска.
- Stale context snapshot блокирует stable verification, но для local experiment может быть явно показан как non-blocking diagnostic.
- Dirty submodule не обновляется и не сбрасывается автоматически.
- Root tooling не выполняет destructive Git operations внутри plugin repos.

## 15. Безопасность

- Plugin code и install scripts считаются исполняемым недоверенным кодом до review.
- Git installation с `prepare` разрешается только для pinned/reviewed source; npm/tarball installation предпочитается для release smoke.
- API capability mediation через Cordis не заменяет OS/process sandbox.
- Credentials хранятся только в ignored runtime environment или внешнем secret store.
- Workbench не обещает откат внешних side effects, которыми Fiber не владеет.

## 16. Критерии готовности первой реализации

Первая реализация лаборатории готова, когда:

1. Meta-repo инициализирован и содержит корневой agent context, catalog schema и compatibility manifest.
2. `paper.pdf` размещён в `references/cordis-paper.pdf`, а исследовательская заметка сохраняет рабочую ссылку.
3. Pinned upstream Harness checkout зарегистрирован как submodule с конкретным commit.
4. `lab new example` создаёт отдельный Git repo, общий context snapshot и local catalog entry.
5. Example plugin проходит behavior и lifecycle tests.
6. `lab dev example --target next` загружает source plugin и подтверждает HMR cleanup/reload.
7. `lab verify example --target next` собирает tarball, устанавливает его в временный profile и проверяет наблюдаемый результат.
8. Тот же example проходит compatibility smoke против pinned `master`.
9. Plugin repo может быть склонирован отдельно и выполнить свои install/test/build/pack-smoke без родительского meta-repo.
10. `lab doctor` обнаруживает stale context, version mismatch и отсутствующий/dirty submodule без автоматического исправления пользовательских репозиториев.

## 17. Принятые решения

- Meta-repo вместо plugin monorepo.
- Автономные nested Git repos для всех плагинов.
- Смешанный tracking: local experiments и submodules для зрелых плагинов.
- Коммитимый snapshot общего agent-context внутри каждого plugin repo.
- Публичные npm API как единственная production dependency boundary.
- npm `next` плюс pinned upstream `master` как ежедневные compatibility targets.
- Раздельные source/HMR и packed-bundle checks.
- Локальная публикация и release ownership в каждом plugin repo.
