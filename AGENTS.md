# SearchUnit CLI

Local CLI: one public URL, static HTTP, deterministic SEO/GEO audit plus narrower tool checks.

## Runtime

Published runtime is Node >= 20. `npx @searchunit/cli` runs that bundle; Bun is the dev toolchain (`mise.toml`, `bun.lock`). Source entry is `src/index.ts`. `bun run build` / `prepack` write `dist/cli.js` (Node target, shebang). Leave `dist/` out of git.

Commands: `package.json` `scripts`. After TS edits, `bun run fmt` (vertical spacing in `scripts/apply-vertical-spacing.ts`, then oxfmt).

Tests are `bun:test`, in-process, inline HTML fixtures. Stay on those fixtures; skip live HTTP, nock, and Playwright. `src/` stays Node-compatible: use the `yaml` package for YAML, not `bun` imports.

SSRF host/IP checks: import `src/ip-policy.ts`. Keep `ipaddr.js` as the range parser.

## Fetch and scores

Page, robots, sitemap, and llms.txt go through `fetchPublicUrl` → `pinnedFetch` (SSRF preflight and DNS pin on every hop). Body cap defaults to 2 MiB (`max_body_bytes` / `--max-bytes`, 1 KiB–32 MiB). A body over the cap is a fetch error (`too_large`); do not return a truncated body. HTML larger than 2 MiB (`DEFAULT_MAX_BODY_BYTES`) is the `oversized_html` blocker. That only happens when the cap is raised above 2 MiB. `robots.txt` and `llms.txt` are scored signals, not fetch gates. Sitemap URL: robots `Sitemap:` lines, then HTML `parsed.sitemapUrls`, else origin `/sitemap.xml`. Optional CrUX POSTs through `resolvePublicHop` + `pinnedFetch` (`src/engine/crux.ts`); a missing key is skip. Audit, kind, and tool check payloads include `cruxApiKeyAvailable` (true when `CRUX_API_KEY` is set). With a key, technical foundations includes CrUX field data and can change between runs. Without a key, that component omits Core Web Vitals. Unidentified page kind and site type are `Undefined`.

GEO scores live only in `src/engine/scoring.ts`. Findings reuse `src/tools/<domain>` analyzers. Commands and render print scores; they do not compute them. Keep engine crawler/schema tables and tool catalogs as separate lists. Human audit reports list kind scores overview, geo, and seo. The Crawlers block is only on the `audit` report (table, html, and markdown). `geo-check` shows crawlers as findings, not a second table.

`audit`, `geo-check`, and `seo-check` run discovery + scoring. `audit` prints the overall score and embeds `seo-check`, `geo-check`, tool findings, and the Google Profile URL. `geo-check` and `seo-check` print the kind score and filtered findings. Other fetch commands run `tools/<domain>` parse/analyze. `google-profile` does not fetch. `config` does not write reports.

`audit`, `geo-check`, and `seo-check` `--fail-on` use critical blockers and findings with `source === 'discovery'` (kind commands: only that kind's blockers and discovery ids). Advisory tool checks stay out of that gate. Other fetch commands use the analyzer status. `google-profile` and `config` ignore `--fail-on`.

## Placement

- Command: `src/commands/` + `HANDLERS` in `src/cli.ts` + `CANONICAL_COMMANDS` / aliases in `src/lib/args.ts`
- GEO signal: `src/engine/parsers/` → snapshot types → `scoring.ts`
- Tool check: `src/tools/<domain>/parse*` + `analyze*`; add `src/engine/findings.ts` when `audit` should emit it
- Argv: only `src/lib/args.ts`. `-f` / `--format` is stdout. `-o` / `--output` is a `.json` or `.md` file path. `--agent` prints plain markdown of that command's payload on stdout and overrides `--format` there. `-o` stays a file.
- Help: `formatHelp` in `src/lib/help.ts`. `searchunit config --help` uses `formatConfigHelp` in that same file.

CLI-native modules import with `.ts` suffixes. `src/tools/**` omit the suffix. Use `import type` (`verbatimModuleSyntax`). Relative imports only.

## Config

Skip YAML load for `config`, `--help`, and `--version`. cwd `.searchunit.yaml` overlays `$HOME` except `crux_api_key` (home YAML, flags, or `CRUX_API_KEY`). `max_body_bytes` overlays from cwd like `output`. `searchunit config` for `crux_api_key` needs `-g` / `--global`; without it the command rejects and leaves cwd YAML unchanged. Flags override YAML. `CRUX_API_KEY` overrides `crux_api_key`. `--max-bytes` overrides `max_body_bytes`.

`searchunit config` with no args lists every key (Local, Global, Default, Effective) and prints both file paths. `searchunit config list` reads cwd `.searchunit.yaml` and prints only that path. `config list -g` reads `$HOME/.searchunit.yaml` and prints only that path.

## Boundaries

Secrets stay in the environment or gitignored `.searchunit.yaml`. Leave `.env*` and `.searchunit.yaml` out of git.

Update `bun.lock` with `bun install` / `bun add`.

Bump version in `package.json` (`VERSION` is read from it). Keep `"private"` unset. Scoped publish uses `publishConfig.access: public`. Pack `files`: `dist` only.

Update `CHANGELOG.md` for every user-visible change. Add the note under `## Unreleased`. Rename `## Unreleased` to the new version heading only in the change that bumps `package.json` `version`.

## Done when

1. `bun test` exits 0, or `bun test tests/<area>.test.ts` for a narrow change
2. `bun run check` exits 0
3. `bun run lint` exits 0
4. `bun run fmt:check` exits 0
