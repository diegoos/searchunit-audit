# SearchUnit CLI

Local CLI: one public URL or a loopback dev server, static HTTP, deterministic SEO/GEO audit plus narrower tool checks.

## Runtime

Published runtime is Node >= 20. `npx @searchunit/cli` runs that bundle; Bun is the dev toolchain (`mise.toml`, `bun.lock`). Source entry is `src/index.ts`. `bun run build` / `prepack` write `dist/cli.js` (Node target, shebang). Leave `dist/` out of git.

Commands: `package.json` `scripts`. After TS edits, `bun run fmt` (vertical spacing in `scripts/apply-vertical-spacing.ts`, then oxfmt).

Tests are `bun:test`, in-process, inline HTML fixtures. Stay on those fixtures; skip live HTTP, nock, and Playwright. `src/` stays Node-compatible: use the `yaml` package for YAML, not `bun` imports.

SSRF host/IP checks: import `src/ip-policy.ts`. Keep `ipaddr.js` as the range parser.

## Fetch and scores

Page, robots, sitemap, and llms.txt go through `fetchPublicUrl` → `pinnedFetch` (SSRF preflight and DNS pin on every hop). `dispatch` wraps the command in `withLocalTarget`: loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) is allowed only on the command target's port. Other private hosts stay refused. A loopback URL omits CrUX. A scheme-less loopback target uses `http://`. Body cap defaults to 2 MiB (`max_body_bytes` / `--max-bytes`, 1 KiB–32 MiB). A body over the cap is a fetch error (`too_large`); do not return a truncated body. HTML larger than 2 MiB (`DEFAULT_MAX_BODY_BYTES`) is the `oversized_html` blocker. That only happens when the cap is raised above 2 MiB. `robots.txt` and `llms.txt` are scored signals, not fetch gates. Sitemap URL: robots `Sitemap:` lines, then HTML `parsed.sitemapUrls`, else origin `/sitemap.xml`. Sitemap: up to 5 declared roots, index children and nested indexes up to 25 files, match on `pageKey`, `coverage` `complete` or `partial`. The sitemap `urls` list keeps one loc per template class, then short and institutional paths, and stops at 200. `audit` alone probes the first 25 same-site and 10 outbound links (`src/engine/linkStatus.ts`, `discovery.linkStatus`). `wordCount` reads the main content root (`src/engine/parsers/mainContent.ts`); `bodyWordCount` is the whole body. Freshness measures age from `fetchedAt`, never the clock. Page-level findings live in `src/engine/pageFindings.ts`. Every run is a page audit: `discovery.auditScope.level` is `page`, `pagesScored` is 1, and `contextFetches` counts the evidence requests. The human report title is `Page Audit`. `audit` stores the full text of the 12 highest-scoring citability blocks and the 12 lowest-scoring blocks outside that list, and every non-empty H2 and H3. `seo-check` and `geo-check` cap citability text at 1500 characters and headings at 40. `internalLinkIndex` lists same-host page keys before the 50-link display cap. `pageKey` is lowercase host, no leading `www`, the port when it is not the scheme default, no trailing slash. It drops `utm_*`, `gclid`, and `fbclid`, and keeps every other query parameter. `internalLinks` and `outboundLinks` store `{ href, text }`. `outboundLinks` stops at 40. `snippetDirectives`, image `width`, `height`, `srcset`, and `loading`, Open Graph title and image strings, schema `missingProps`, and microdata and RDFa type names are on the audited page. Those fields do not change the scores. `metaDescription` is the description meta. `lang` is `<html lang>`. `citability.opening`, `dates.visible`, `headerCanonical`, `headerHreflang`, `robotsNoindexSource`, `videos`, and `structuredData.faqPairs` are on the audited page. A `www` link on the same site stays in `internalLinkIndex`. `llmsTxt.linksToAuditedUrl` is computed before the 100-link cap. `auditedPage.pagination` holds the `next` and `prev` link hrefs. `author.urls` holds up to five author URLs. `social.openGraph.url` and `breadcrumbParent` are on the audited page. `visibleTextSha256` is on the audited page and on the mobile snapshot. Optional CrUX POSTs through `resolvePublicHop` + `pinnedFetch` (`src/engine/crux.ts`); a missing key is skip. Optional Lighthouse runs only for `audit` with `--agent`, `--format json`, or a `.json` `-o` path, after `resolvePublicHop`. Chrome dials through a loopback proxy that connects only to that pinned address and port, so an IP literal on another hop is refused. `lighthouse.renderedText` is the main text from that Chrome run, capped at 8000 characters, or null. A lab miss stays on `lighthouse` and does not fail the audit or change the score. A `.md` file does not start Chrome. Optional Search Console reads go through the `googleapis` client in `src/gsc.ts` on `gsc` only. A missing credential is skip. Calls send `x-goog-user-project` from `GSC_QUOTA_PROJECT`, home `gsc_quota_project`, `GOOGLE_CLOUD_QUOTA_PROJECT`, the service account `project_id`, or ADC `quota_project_id`. A service account JSON key (`GSC_CREDENTIALS`, home `gsc_credentials`, or `GOOGLE_APPLICATION_CREDENTIALS` when `type` is `service_account`) is loaded by that client with scope `webmasters.readonly`. `GSC_ACCESS_TOKEN` or home `gsc_access_token` overrides the file. `audit` does not call Search Console. Audit, kind, and tool check payloads include `cruxApiKeyAvailable` (true when `CRUX_API_KEY` is set). With a key, technical foundations includes CrUX field data and can change between runs. Without a key, that component omits Core Web Vitals. Unidentified page kind and site type are `Undefined`.

GEO scores live only in `src/engine/scoring.ts`. Findings reuse `src/tools/<domain>` analyzers. Commands and render print scores; they do not compute them. Keep engine crawler/schema tables and tool catalogs as separate lists. Human audit reports list kind scores overview, geo, and seo. The Crawlers block is only on the `audit` report (table, html, and markdown). `geo-check` shows crawlers as findings, not a second table.

`audit`, `geo-check`, and `seo-check` run discovery + scoring. `audit` prints the overall score and embeds `seo-check`, `geo-check`, tool findings, and the Google Profile URL. `geo-check` and `seo-check` print the kind score and filtered findings. Other fetch commands run `tools/<domain>` parse/analyze. `google-profile` does not fetch. `gsc` calls Google when a token is set. `config` does not write reports.

`audit`, `geo-check`, and `seo-check` `--fail-on` use critical blockers and findings with `source === 'discovery'` (kind commands: only that kind's blockers and discovery ids). Advisory tool checks stay out of that gate. Other fetch commands use the analyzer status. `google-profile`, `gsc`, and `config` ignore `--fail-on`.

## Placement

- Command: `src/commands/` + `HANDLERS` in `src/cli.ts` + `CANONICAL_COMMANDS` / aliases in `src/lib/args.ts`. `gsc` lives in `src/gsc.ts` + `src/commands/gsc.ts`
- GEO signal: `src/engine/parsers/` → snapshot types → `scoring.ts`
- Tool check: `src/tools/<domain>/parse*` + `analyze*`; add `src/engine/findings.ts` when `audit` should emit it
- Argv: only `src/lib/args.ts`. `-f` / `--format` is stdout. `-o` / `--output` is a `.json` or `.md` file path. `--agent` prints plain markdown of that command's payload on stdout and overrides `--format` there. `-o` stays a file.
- Help: `formatHelp` in `src/lib/help.ts`. `searchunit config --help` uses `formatConfigHelp` in that same file.

CLI-native modules import with `.ts` suffixes. `src/tools/**` omit the suffix. Use `import type` (`verbatimModuleSyntax`). Relative imports only.

## Config

Skip YAML load for `config`, `--help`, and `--version`. cwd `.searchunit.yaml` overlays `$HOME` except `crux_api_key`, `gsc_access_token`, `gsc_quota_project`, and `gsc_credentials` (home YAML, flags, or env). `max_body_bytes` overlays from cwd like `output`. `searchunit config set <key> <value>` writes a key. `searchunit config remove <key>` deletes a key. Those home-only keys need `-g` / `--global` on `set` and `remove`; without it the command rejects and leaves cwd YAML unchanged. Flags override YAML. `CRUX_API_KEY` overrides `crux_api_key`. `GSC_ACCESS_TOKEN` overrides `gsc_access_token`. `GSC_QUOTA_PROJECT` overrides `gsc_quota_project`. `GSC_CREDENTIALS` overrides `gsc_credentials`. `--max-bytes` overrides `max_body_bytes`.

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
