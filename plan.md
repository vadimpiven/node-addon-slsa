# TypeDoc: auto-generated API documentation

## Goal

Generate API reference from TSDoc comments in source, deploy as
a static site to GitHub Pages on each release.

## Tool

[TypeDoc](https://typedoc.org/) (v0.27+). Pure npm dependency,
reads TypeScript source via the compiler API, outputs static HTML
with sidebar navigation, full-text search, and source links.

## What changes

### 1. Add `typedoc` devDependency to `package/package.json`

Pin exact version in `pnpm-workspace.yaml` catalog. Reference as
`"typedoc": "catalog:"` in `package/package.json`.

### 2. Create `package/typedoc.json`

```json
{
  "$schema": "https://typedoc.org/schema.json",
  "entryPoints": ["./src/index.ts"],
  "out": "docs",
  "name": "node-addon-slsa",
  "includeVersion": true,
  "excludeInternal": true,
  "excludePrivate": true,
  "readme": "README.md",
  "sourceLinkTemplate": "https://github.com/vadimpiven/node-addon-slsa/blob/{gitRevision}/{path}#L{line}"
}
```

Key decisions:

- **Single entry point** `src/index.ts` — TypeDoc follows re-exports
  and documents only the public API surface (13 symbols: 4 functions,
  4 types, 2 interfaces, 1 class, 1 type guard, 1 const).
- **`excludeInternal: true`** — anything tagged `@internal` is
  omitted. Currently no symbols use this tag; it is a safety net.
- **`readme: "README.md"`** — uses `package/README.md` as the
  landing page of the generated site.
- **`sourceLinkTemplate`** — "Defined in" links point to GitHub at
  the correct revision.
- **Output to `package/docs/`** — add `docs/` to
  `package/.gitignore` [TBD: or root `.gitignore`].

### 3. Add `docs` script to `package/package.json`

```json
"docs": "typedoc"
```

TypeDoc auto-discovers `typedoc.json` in the working directory and
`tsconfig.json` for compiler options. No flags needed.

### 4. Add `docs` task to `mise.toml`

```toml
[tasks.docs]
description = "Generate API documentation"
alias = "d"
depends = ["setup"]
run = 'pnpm -F "{package}" --if-present run docs'
```

### 5. Add deploy step to `.github/workflows/release.yaml`

After the `build` job succeeds, add a `docs` job:

```yaml
docs:
  name: "Deploy docs"
  needs: "build"
  runs-on: "ubuntu-latest"
  permissions:
    pages: "write"
    id-token: "write"
  environment:
    name: "github-pages"
    url: "${{ steps.deploy.outputs.page_url }}"
  steps:
    - uses: "actions/checkout@..."
      with:
        ref: "${{ github.ref }}"
        fetch-depth: 1
        persist-credentials: false
    - uses: "./.github/actions/setup"
      with: ...
    - name: "Generate docs"
      run: "pnpm -F node-addon-slsa run docs"
    - uses: "actions/upload-pages-artifact@v3"
      with:
        path: "package/docs"
    - id: "deploy"
      uses: "actions/deploy-pages@v4"
```

Requires: repository Settings > Pages > Source set to
"GitHub Actions".

### 6. Review TSDoc coverage in source

The public API already has JSDoc/TSDoc comments on every exported
symbol. TypeDoc will render them as-is. Improvements to consider:

- Add `@example` blocks to `verifyPackageProvenance` and
  `verifyAddonProvenance` (the code from `package/README.md`
  "Programmatic API" section).
- Add `@remarks` to `PackageProvenance` explaining the two-step
  verification flow.
- Add `@throws` tags where missing (e.g., `verifyPackageProvenance`
  throws `ProvenanceError`).

These are optional — the docs site will be functional without them.

### 7. Link the generated docs from README

Add to `package/README.md` API reference section:

```markdown
Full auto-generated API reference: [vadimpiven.github.io/node-addon-slsa](https://vadimpiven.github.io/node-addon-slsa/)
```

Add to root `README.md` documentation line.

## Files touched

| File | Change |
| --- | --- |
| `pnpm-workspace.yaml` | Add `typedoc` to catalog |
| `package/package.json` | Add `typedoc` devDep, add `docs` script |
| `package/typedoc.json` | New file |
| `.gitignore` | Add `docs/` |
| `mise.toml` | Add `docs` task |
| `.github/workflows/release.yaml` | Add `docs` job |
| `package/README.md` | Link to generated docs site |
| `README.md` | Link to generated docs site |
| Source files (optional) | Improve TSDoc comments |
