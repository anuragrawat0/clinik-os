# API tests

`tsconfig.json` here is **not a type-check configuration**: nothing runs `tsc` against it and test
files are not type-checked. It exists only so decorator-using test code (`@Controller`, `@Get`,
`@Res()`, …) is transformed with the same legacy decorator settings as `src`. Vitest (oxc) and
`tsx --tsconfig test/tsconfig.json` look up the nearest tsconfig per file, and `../tsconfig.json`
only includes `src/`. Verified by deleting it: `guards.e2e`, `route-coverage.e2e` and
`dev/tsx-di.e2e` then fail with "Decorators are not valid here".

Two gotchas, both verified: do not add comments to that JSON file, and keep its own `exclude` (the parent excludes `test`). Either mistake makes tsx and oxc silently fall back to standard decorators.

`dev/tsx-di.e2e.spec.ts` boots the real `AppModule` under `tsx` (as `pnpm start:dev` does). tsx emits
no decorator metadata, so every constructor parameter needs an explicit `@Inject(...)`.
