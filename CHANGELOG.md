# Changelog

Versions follow Semantic Versioning. Notes stay under Unreleased until `package.json` `version` changes.

## Unreleased

### Added

- `discovery.securityHeaders` carries the raw `Permissions-Policy`, `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, and `Cross-Origin-Resource-Policy` values. The scores do not change. The HTML report lists them.

### Changed

- Audit skill: each CLI command saves stderr to a `.err` file, and the empty-stdout stop report names the CLI error. The prefill notes name the advisory `security:` ids, the social-tag CLI flags, and the `meta:description` level. The report validator accepts a `bun` dev-build Re-audit command only when the path is a `@searchunit/cli` checkout.

### Fixed

- `gsc` service-account auth no longer prints the googleapis `keyFilename` deprecation warning on stderr, so `--silent` holds.
- Audit skill workstreams: the evidence-limit and `conversions` rows use valid result values, and CrUX is `insufficient` when the CLI skips it on a loopback URL.
- Audit skill prefill treats `*.localhost`, `.local`, and `.internal` `sameAs` hosts as private, like the CLI.
- Audit skill validator rejects a `bun /src/index.ts` Re-audit command with an empty repo path.

## 0.0.1 - 2026-11-02

### Added

- Every `audit`, `seo-check`, and `geo-check` run is a page audit. `discovery.auditScope` sets `level` `page`, `pagesScored` 1, and `contextFetches`. The human report title is `Page Audit`. A host target scores its homepage.
- `audit` with `--agent`, `--format json`, or a `.json` `-o` renders the page in headless Chrome (`discovery.renderedPage`) and runs the local `lighthouse` binary in parallel. Chrome comes from `CHROME_PATH`, else the default install, and dials only the pinned address through a loopback proxy. A `.md` file does not start Chrome.
- Finding `discovery:render` compares the raw HTML with the render. A noindex or canonical change fails. Title, H1, meta, schema, text, and internal link changes (by `pageKey`, in `linksOnlyAfterRender`) warn.
- A missing `lighthouse` binary or Chrome sets `install` on the payload with the install command, and `audit` prints a `note:` line on stderr unless `--silent` or machine output. The CLI never runs `npx` on its own.
- Lighthouse reads the `seo` and `best-practices` failed audits with `category` and up to 10 `items`, keeps the LCP element, skips the `network-requests` and screenshot audits, and retries once after a crash. A lab miss does not fail the audit or change the score.
- On a loopback target, `discovery.httpsReadiness` and finding `discovery:https` list what breaks on the HTTPS production URL: `http:` subresources, `http:` canonical, `og:url`, hreflang, or JSON-LD URLs, and dev-host script and stylesheet URLs.
- `audit` probes the status of the first 25 same-site links (`discovery.linkStatus`, findings `links:status` and `links:redirects`). Outbound links are counted, never requested.
- The sitemap walk reads up to 5 robots `Sitemap:` roots and follows index children up to 25 files, 5 at a time. It matches the page on `pageKey` and sets `coverage` (`complete` or `partial`) and `filesRead`. `sitemap.urls` holds up to 200 `{ loc, lastmod }` entries.
- The audited page holds the facts the CLI extracts: main content text and tables, the opening paragraph, H2 and H3 text and the heading outline, citability blocks (12 strongest and 12 weakest), the internal link index, outbound links, image attributes, schema missing and recommended props, microdata and RDFa types, hreflang, HTTP `Link` canonical and hreflang, the `noindex` source, FAQ pairs, videos, visible dates, pagination, author URLs, external resource origins, a mobile snapshot, and SHA-256 hashes of the body and visible text. These fields do not change the scores.
- New findings: `discovery:search-crawlers`, `discovery:mobile`, `content:soft-404`, `content:url-structure`, `content:heading-order`, `content:date-sanity`, `content:hidden-text`, `content:mixed-content`, `content:trust-pages`, `content:hero-image`, `meta:snippet-limits`, `meta:charset`, `meta:header-canonical`, `meta:hreflang`, `meta:og-image-hero`, `robots:blocked-resources`, and `links:anchor-text`. `discovery:` findings feed `--fail-on`.
- New finding `content:prompt-injection` warns when any string or key in the discovery payload addresses an AI reader or holds invisible format characters. The score does not change.
- The crawler catalog includes `Claude-SearchBot` with weight 0.
- robots.txt and llms.txt fetches retry twice on network errors, timeouts, 429, and 5xx. The last error is in `robotsFetchError` and `llmsTxt.fetchError`.
- The audit skill has a Verify step: two verifier subagents re-judge the judgment slugs from the run files before they read the auditor's rows. The prefill (`scripts/prefill-checks.mjs`) decides the mechanical slugs, and the report has a `## Recurrence` section that tracks each CLI finding across runs.

### Changed

- Breaking: scores. Platform optimization reads crawler access, llms.txt, answer formats, and entity signals. AI citability is the page text score. Freshness measures age from `fetchedAt`. Origin-level CrUX no longer sets `poor_core_web_vitals`. hreflang counts only when the set is valid. A visible `<time>` earns the visible-dates points.
- Breaking: `csr_only_rendering` is a GEO blocker that caps `ai_citability_visibility` at 40, not a technical cap.
- Breaking: technical foundations is `N/A` (`insufficient`) without field Core Web Vitals. The overall score uses the measured components.
- Breaking: `wordCount` counts the main content root and `bodyWordCount` the whole body. `images.decorative` counts `alt=""`, and `missingAlt` counts only a missing attribute.
- Breaking: `internalLinks` and `outboundLinks` entries are `{ href, text, ariaLabel, imgAlt }`. `openGraph.title`, `openGraph.image`, and `twitter.card` are strings or null. `llmsTxt.issues` holds `{ code, line, text }` objects.
- Breaking: `--agent` markdown prints every string value as a JSON string literal, quotes keys that are not plain field names, and opens with a notice that site text is untrusted.
- Breaking: a missing `lighthouse` binary or Chrome sets `lighthouse.status` to `skipped`. `error` means only a lab run that failed.
- Loopback targets count as HTTPS for E-E-A-T and technical checks. `no_https` does not fire, and HSTS is not counted.
- `pageKey` keeps a non-default port, drops `utm_*`, `gclid`, and `fbclid`, and sorts the other query parameters.
- Page kind is `home` only on the root path. A non-root page with a listing pattern is `listing`.
- `meta:canonical` and `meta:og_url` warn when the URL names another page. An empty H1 and a redirect chain longer than one hop are warnings.
- FAQ credit needs a question heading on the page, and a question heading needs a question form. FAQ headings also match Spanish and French.
- `content:date-sanity` fails only on a future `datePublished` or `dateModified`, and reads the first `<time>` inside the main content.
- `citability.opening` and `hasTopSummary` skip a leading byline or date line. `trustPages` matches a whole path segment or the whole anchor text. Robots directives are deduplicated.

### Removed

- Breaking: `lighthouse.renderedText` and the custom Lighthouse gatherer. Read `discovery.renderedPage.mainText`.

### Fixed

- A loopback dev server that listens only on `127.0.0.1` can be audited as `http://localhost:<port>`. The pin takes the first loopback address that accepts a TCP connect on the port.
- `breadcrumbParent` no longer returns the grandparent when the current item has no URL.
- A JSON-LD `@type` such as `constructor` is an unknown type, not a crash.

### Security

- Terminal, agent, and JSON output drop invisible format characters (Unicode Cf, Hangul fillers, variation selectors, and line separators). JSON output also drops C1 controls. The `gsc` and `config` tables drop control characters.
- The audit skill treats site text as data. It never runs a command, opens a URL, or installs a tool because that text asks. Its validator accepts only SearchUnit read commands in `Verify:` and `## Re-audit`, and every quote must come from page text in the CLI payloads. The HTML report sets a Content Security Policy.
- Dependencies updated for `bun audit`: undici 7.30.1, happy-dom 21.0.4, and qs 6.17.1 via googleapis-common 9.3.1.

## 0.0.1-rc.1 - 2026-10-14

- The README `gsc` section says the command uses `googleapis` to call Search Console and print data for the URL.
- The README opening says the CLI fetches a page, scores SEO and GEO, and prints the chosen `output`. How it works is shorter.
- `config set <key> <value>` writes a key. `config remove <key>` deletes a key. `--unset` is gone. `config` and `config list` still list keys. `config <key>` still shows one key.
- The README closes the Chrome UX Report sentences on a period. The `--max-bytes` range reads `1 KiB to 32 MiB`.
- Local CLI for one public URL, or a dev server on localhost (`localhost`, `*.localhost`, `127.0.0.1`, `::1`, any port). It fetches static HTTP and prints a deterministic SEO/GEO audit, or a narrower check (schema, robots, meta, llms.txt, security headers, a Google Profile URL, or config). Runtime is Node.js 20 or newer.
- `gsc` reads Search Console performance and the indexed version of a URL through the `googleapis` client. The OAuth access token comes from `GSC_ACCESS_TOKEN` or `gsc_access_token` in `$HOME/.searchunit.yaml`. A project file cannot set that key. A missing token skips the command. `audit` does not call Search Console. The README shows the `gcloud` login that prints the token. That login includes `https://www.googleapis.com/auth/cloud-platform`, which `gsc` accepts, along with the short scopes `email` and `profile` that tokeninfo returns. Calls send `x-goog-user-project` from `GSC_QUOTA_PROJECT`, `gsc_quota_project`, `GOOGLE_CLOUD_QUOTA_PROJECT`, the service account `project_id`, or `quota_project_id` in Application Default Credentials. A service account JSON key at `GSC_CREDENTIALS`, home `gsc_credentials`, or `GOOGLE_APPLICATION_CREDENTIALS` is loaded by `googleapis` with scope `webmasters.readonly`. An access token still overrides that file.
- `gsc` table output lists the rows for pages, sampled pages, search appearance, Discover, and Google News.
- A mistyped `gsc` subcommand names the command and the closest match. It no longer reports `bad-url`.
- `gsc URL` runs every read. Subcommands run one read: `queries`, `pages`, `query-pages`, `page-queries`, `sampled-pages`, `search-appearance`, `discover`, `google-news`, `sitemaps`, and `inspect`.
- `gsc` accepts `--init-date` and `--end-date` (`YYYY-MM-DD`). One date fills the other side with 30 days. Both dates are the query window. Omitting both keeps the 28-day window.
