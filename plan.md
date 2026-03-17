# TypeDoc: auto-generated API documentation

## Goal

Generate API reference from TSDoc comments in source, deploy as
a static site to GitHub Pages on each release.

## Tool

[TypeDoc](https://typedoc.org/) (v0.27+). Pure npm dependency,
reads TypeScript source via the compiler API, outputs static HTML
with sidebar navigation, full-text search, and source links.

## What changes

### 1. Add `typedoc` and theme devDependencies to `package/package.json`

Pin exact versions in `pnpm-workspace.yaml` catalog. Reference as
`"typedoc": "catalog:"` and `"typedoc-theme-oxide": "catalog:"` in
`package/package.json`.

### 2. Create `package/typedoc.json`

```json
{
  "$schema": "https://typedoc.org/schema.json",
  "entryPoints": ["./src/index.ts"],
  "out": "docs",
  "plugin": ["typedoc-theme-oxide"],
  "theme": "oxide",
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
- **Output to `package/docs/`** — add `docs/` to root
  `.gitignore` (matches existing `dist/`, `coverage/` pattern).

### 3. Add `docs` script to `package/package.json`

```json
"docs": "typedoc"
```

TypeDoc auto-discovers `typedoc.json` in the working directory and
`tsconfig.json` for compiler options. No flags needed.

### 4. Add docs generation and deployment to `.github/workflows/release.yaml`

Two changes: generate docs in the existing `build` job, then
deploy in a new lightweight `docs` job.

**4a. Add docs generation to the `build` job** (after the
existing "Build and pack package" step):

```yaml
    - name: "Generate API docs"
      run: 'pnpm -F "{package}" --if-present run docs'
    # upload-pages-artifact uploads with artifact name "github-pages";
    # deploy-pages finds the artifact by that same name within the run.
    - name: "Upload docs artifact"
      uses: "actions/upload-pages-artifact@7b1f4a764d45c48632c6b24a0339c27f5614fb0b" # v4.0.0
      with:
        path: "package/docs"
```

**4b. Add a `docs` job** that only deploys (no checkout or
setup — the artifact was already uploaded by `build`):

```yaml
docs:
  name: "Deploy docs"
  needs: "publish"
  if: "needs.publish.result == 'success'"
  runs-on: "ubuntu-latest"
  timeout-minutes: 5
  permissions:
    pages: "write"
    id-token: "write"
  environment:
    name: "github-pages"
    url: "${{ steps.deploy.outputs.page_url }}"
  steps:
    - name: "Deploy to GitHub Pages"
      id: "deploy"
      uses: "actions/deploy-pages@d6db90164ac5ed86f2b6aed7e0febac5b3c0c03e" # v4.0.5
```

The pipeline is: `build` → `publish` → `docs` + `smoke-test`.
Docs are only deployed after npm publish succeeds, ensuring
the docs site always matches a published version.

Requires: repository Settings > Pages > Source set to
"GitHub Actions".

### 5. Review TSDoc coverage in source

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

### 6. Link the generated docs from README

Add to `package/README.md` API reference section:

```markdown
Full auto-generated API reference: [vadimpiven.github.io/node-addon-slsa](https://vadimpiven.github.io/node-addon-slsa/)
```

Add to root `README.md` documentation line.

## Files touched

| File                             | Change                                                          |
| -------------------------------- | --------------------------------------------------------------- |
| `pnpm-workspace.yaml`            | Add `typedoc`, `typedoc-theme-oxide` to catalog                 |
| `package/package.json`           | Add `typedoc`, `typedoc-theme-oxide` devDeps, add `docs` script |
| `package/typedoc.json`           | New file                                                        |
| `.gitignore`                     | Add `docs/`                                                     |
| `.github/workflows/release.yaml` | Generate docs in `build`, add `docs` deploy job                 |
| `package/README.md`              | Link to generated docs site                                     |
| `README.md`                      | Link to generated docs site                                     |
| Source files (optional)          | Improve TSDoc comments                                          |
