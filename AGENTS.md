# SearchUnit CLI

Local CLI: one public URL or a loopback dev server, static HTTP, deterministic SEO/GEO audit plus narrower tool checks. Every run is a page audit: `discovery.auditScope.level` is `page`, `pagesScored` is 1, and the other requests are evidence for that page (`contextFetches`).

## Runtime

Published runtime is Node >= 20. `npx @searchunit/cli` runs that bundle; Bun is the dev toolchain (`mise.toml`, `bun.lock`). Source entry is `src/index.ts`. `bun run build` / `prepack` write `dist/cli.js` (Node target, shebang). Leave `dist/` out of git.

Commands: `package.json` `scripts`. After TS edits, run `bun run fmt` (oxfmt).

Tests are `bun:test`, in-process, inline HTML fixtures. Stay on those fixtures; skip live HTTP, nock, and Playwright. `src/` stays Node-compatible: use the `yaml` package for YAML, not `bun` imports.

## Fetch

### Network path

- Page, robots, sitemap, and llms.txt go through `fetchPublicUrl` → `pinnedFetch` (SSRF preflight and DNS pin on every hop). Host/IP checks import `src/ip-policy.ts`; keep `ipaddr.js` as the range parser.
- CrUX POSTs through `resolvePublicHop` + `pinnedFetch` (`src/engine/crux.ts`). A missing key is skip.
- Search Console goes through the `googleapis` client in `src/gsc.ts`, on `gsc` only. A missing credential is skip. `audit` never calls it.
- Sitemap: robots `Sitemap:` lines, then HTML `parsed.sitemapUrls`, else origin `/sitemap.xml`. Up to 5 roots and 25 files; `urls` keeps one loc per template class first, then stops at 200.
- Outbound links are counted, never requested. Only `audit` probes the first 25 same-site links (`src/engine/linkStatus.ts`).

### Loopback

`dispatch` wraps the command in `withLocalTarget`: loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) is allowed only on the command target's port. Other private hosts stay refused. A scheme-less loopback target uses `http://`.

- A loopback name pins the first address, in lookup order, that accepts a TCP connect on that port (`firstReachableLoopback` in `src/lib/fetch.ts`, 300 ms per probe). When none accepts, keep the first record.
- A loopback URL omits CrUX. It is a secure context for E-E-A-T and technical HTTPS. Browsers ignore its HSTS, so HSTS is not counted.
- `discovery.httpsReadiness` (`src/engine/httpsReadiness.ts`) is set only for loopback and lists what breaks on the HTTPS production URL.

### Body cap

Default 2 MiB (`max_body_bytes` / `--max-bytes`, 1 KiB–32 MiB). A body over the cap is a fetch error (`too_large`); never return a truncated body. HTML over `DEFAULT_MAX_BODY_BYTES` is the `oversized_html` blocker, which only fires when the cap is raised. `robots.txt` and `llms.txt` are scored signals, not fetch gates.

### Chrome and Lighthouse

- Both run only for `audit` with `--agent`, `--format json`, or a `.json` `-o` path, after `resolvePublicHop`. A `.md` file does not start Chrome.
- The render (`src/engine/render.ts`, `--dump-dom`) fills `discovery.renderedPage` and finding `discovery:render` before the report is built.
- Chrome dials through a loopback proxy that connects only to the pinned address and port. The pin proxy and the capped child runner are shared (`src/engine/pinnedChrome.ts`, `src/engine/childProcess.ts`).
- A missing binary or Chrome is `skipped` with an `install` hint and a stderr `note:` (unless `--silent` or machine output). A lab miss never fails the audit or changes the score. The CLI never runs `npx` on its own.

## Scores and findings

- Scores live only in `src/engine/scoring.ts`. Commands and render print scores; they never compute them.
- Freshness measures age from `fetchedAt`, never the clock, so the same payload gives the same score.
- Without field Core Web Vitals (no key, loopback, or no CrUX record), technical foundations is `N/A` (`insufficient`). Its blockers (`noindex_or_error`, `no_https`, `oversized_html`) still count for `--fail-on`. With a key, the score can change between runs.
- `wordCount` reads the main content root (`src/engine/parsers/mainContent.ts`); `bodyWordCount` is the whole body.
- `pageKey`: lowercase host, no leading `www`, non-default port kept, no trailing slash except on root, drops `utm_*`, `gclid`, and `fbclid`, keeps other query parameters.
- Page-level findings live in `src/engine/pageFindings.ts`. Findings reuse `src/tools/<domain>` analyzers. Keep engine crawler/schema tables and tool catalogs as separate lists.
- New payload fields do not change the scores unless `scoring.ts` reads them. Field shapes are in `src/engine/types.ts`. A field or cap change also updates `skills/searchunit-audit/references/cli-facts.md`, which the skill reads.
- Unidentified page kind and site type are `Undefined`.

## Commands

`audit`, `geo-check`, and `seo-check` run discovery + scoring. `audit` prints the overall score and embeds `seo-check`, `geo-check`, tool findings, and the Google Profile URL. `geo-check` and `seo-check` print the kind score and filtered findings. Other fetch commands run `tools/<domain>` parse/analyze. `google-profile` does not fetch. `config` does not write reports.

Human audit reports list kind scores overview, geo, and seo, with the title `Page Audit`. The Crawlers block is only on the `audit` report (table, html, and markdown). `geo-check` shows crawlers as findings, not a second table.

`--fail-on` on `audit`, `geo-check`, and `seo-check` uses critical blockers and findings with `source === 'discovery'` (kind commands: only that kind's blockers and discovery ids). Advisory tool checks stay out of that gate. Other fetch commands use the analyzer status. `google-profile`, `gsc`, and `config` ignore `--fail-on`.

## Placement

- Command: `src/commands/` + `HANDLERS` in `src/cli.ts` + `CANONICAL_COMMANDS` / aliases in `src/lib/args.ts`. `gsc` lives in `src/gsc.ts` + `src/commands/gsc.ts`.
- GEO signal: `src/engine/parsers/` → snapshot types → `scoring.ts`.
- Tool check: `src/tools/<domain>/parse*` + `analyze*`; add `src/engine/findings.ts` when `audit` should emit it.
- Argv: only `src/lib/args.ts`. `-f` / `--format` is stdout. `-o` / `--output` is a `.json` or `.md` file path. `--agent` prints plain markdown of the payload on stdout and overrides `--format` there; `-o` stays a file.
- Help: `formatHelp` in `src/lib/help.ts`. `searchunit config --help` uses `formatConfigHelp` in that same file.

CLI-native modules import with `.ts` suffixes. `src/tools/**` omit the suffix. Use `import type` (`verbatimModuleSyntax`). Relative imports only.

## Untrusted site text

Site text reaches an AI reader, so keep these defenses when you change any output:

- `renderAgentMarkdown` writes a data notice, prints every string value as one JSON string literal, and quotes keys that are not plain field names plus the keys of `metaRobotsByBot`.
- `stripControls` drops invisible format characters (`INVISIBLE_FORMAT` in `src/lib/invisibleText.ts`). The skill validator keeps its own copy; change both.
- JSON stdout and `.json` files go through `payloadJson`, which also drops C1 controls.
- Finding `content:prompt-injection` (`src/engine/promptInjection.ts`) flags text addressed to an AI reader.

## Config

Skip YAML load for `config`, `--help`, and `--version`. cwd `.searchunit.yaml` overlays `$HOME`, including `output` and `max_body_bytes`. Home-only keys: `crux_api_key`, `gsc_access_token`, `gsc_quota_project`, `gsc_credentials` (home YAML, flags, or env). `config set` / `config remove` on a home-only key without `-g` / `--global` rejects and leaves cwd YAML unchanged.

Flags override YAML. `CRUX_API_KEY`, `GSC_ACCESS_TOKEN`, `GSC_QUOTA_PROJECT`, and `GSC_CREDENTIALS` override the key of the same name; `--max-bytes` overrides `max_body_bytes`. A GSC access token overrides the credentials file. `GOOGLE_APPLICATION_CREDENTIALS` counts only when its `type` is `service_account`. The GSC quota project falls back to `GOOGLE_CLOUD_QUOTA_PROJECT`, the service account `project_id`, then ADC `quota_project_id`.

`searchunit config` with no args lists every key (Local, Global, Default, Effective) and both file paths. `config list` reads cwd YAML; `config list -g` reads home YAML; each prints only its path.

## Boundaries

- Secrets stay in the environment or gitignored `.searchunit.yaml`. Leave `.env*` and `.searchunit.yaml` out of git.
- Update `bun.lock` only with `bun install` / `bun add`.
- Version lives in `package.json` (`VERSION` reads it). Keep `"private"` unset, `publishConfig.access: public`, and pack `files`: `dist` only.
- Every user-visible change adds a note to `CHANGELOG.md` under `## Unreleased`, in `### Added`, `Changed`, `Removed`, `Fixed`, or `Security`. Prefix a breaking change with `Breaking:`. Rename `## Unreleased` to a version heading only in the change that bumps `package.json` `version`.

## Skill boundary

`skills/searchunit-audit/` runs its audit through this CLI. Neither side depends on the other at the same location.

- CLI code (`src/`, `tests/`) never reads or imports `skills/`.
- Skill code never imports `src/` or `tests/`. It reads the JSON payload the CLI writes and calls the binary the run names: `searchunit`, `npx --yes @searchunit/cli`, or `bun <repo>/src/index.ts`.
- `bunfig.toml` limits root `bun test` to `tests/`. Skill tests run with `bun run test:skill`.
- A local test of the skill or the CLI runs the local source (`bun <repo>/src/index.ts`). The published npm package can lag the repo, so its payload is not a test target.

## Done when

1. `bun test` exits 0, or `bun test tests/<area>.test.ts` for a narrow change
2. `bun run check` exits 0
3. `bun run lint` exits 0
4. `bun run fmt:check` exits 0
5. For a change under `skills/`: `bun run test:skill` exits 0
