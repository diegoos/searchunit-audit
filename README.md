# SearchUnit CLI

SearchUnit CLI audits one web page for SEO and GEO (how ready the page is for AI search and answer engines). It fetches the page over HTTP, reads the static HTML, and prints deterministic scores and findings in the `output` you choose. The target is one public URL, or a dev server on localhost. You can run the full `audit`, or a narrower check.

This repository also holds the `searchunit-audit` agent skill. The skill runs the CLI, judges the page text, and writes a diagnosis with a fix plan. See [Audit skill](#audit-skill).

It runs on Node.js 20 or newer.

```bash
npm install -g @searchunit/cli
searchunit --help
```

```bash
npx @searchunit/cli --help
```

## Optional tools

Chrome and Lighthouse are not npm dependencies. The CLI looks for them on the machine, only on `audit` with `--agent`, `--format json`, or a `.json` `-o`. Without them the audit still runs, and the scores do not change.

| Tool                   | What it adds                                                                                                                                    | When it is missing                                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Google Chrome          | Renders the page after JavaScript (`discovery.renderedPage`) and compares it with the raw HTML (`discovery:render`). Lighthouse also drives it. | The render is `skipped` with reason `chrome-missing`. Set `CHROME_PATH` when Chrome is outside the default install path.              |
| `lighthouse` on `PATH` | Lab metrics and failed audits in `lighthouse`.                                                                                                  | `lighthouse.reason` is `binary-missing`, `lighthouse.install` holds the install command, and `audit` prints a `note:` line on stderr. |

```bash
npm install -g lighthouse
export CHROME_PATH=/usr/bin/chromium
```

AI crawlers read the raw HTML, so the GEO checks do not need Chrome. The render matters for Google, which runs JavaScript before it indexes a page.

Development tools are listed under [Development](#development).

## How it works

You pass a command and a URL. SearchUnit parses the flags and loads `.searchunit.yaml`, except for `config`, `--help`, and `--version`. It fetches that one page, reads the HTML as static markup, calculates the scores, and prints the report on stdout. Progress goes to stderr. The scores never depend on page JavaScript. JavaScript runs only in the optional Chrome render, which adds findings.

A local target is `localhost`, `*.localhost`, `127.0.0.1`, or `::1`, on any port. `searchunit audit localhost:3000` uses `http://`. Redirects, robots, the sitemap, and llms.txt may stay on that same loopback port. Other private, link-local, and metadata hosts are refused. A public URL that redirects to loopback is refused. CrUX is not called for a loopback URL.

On a public URL, http and https stay on ports 80 and 443. SearchUnit fetches:

- The page you pass
- `/robots.txt`
- Up to 5 sitemaps from `robots.txt`, then from the HTML (`link rel="sitemap"` or a sitemap-named link), otherwise `/sitemap.xml`. Index children and nested indexes are followed, up to 25 sitemap files.
- `llms.txt` and `llms-full.txt`
- The page again with a mobile user agent, to compare the two versions
- On `audit` only: a status-only GET of the first 25 same-site links on the page. Outbound links are counted, never requested
- Chrome UX Report (CrUX), when a key is set

The audit stays on the page you pass. The other URLs are evidence for that page: whether it is in the sitemap, whether robots.txt blocks it, whether its links work.

The body cap is 2 MiB (`--max-bytes` or `max_body_bytes`, from 1 KiB to 32 MiB). A body over that cap is an error. SearchUnit does not return a truncated document. HTML larger than 2 MiB is a report finding when the cap is raised and the full page is fetched, because [Googlebot indexes only the first 2 MiB](https://developers.google.com/search/blog/2026/03/crawler-blog-post#the-2mb-limit:-what-happens-to-your-bytes) of uncompressed HTML. `robots.txt` and `llms.txt` are scored when they are present. A missing file does not stop the page fetch.

Page kind and site type come from schema.org types and `og:type`. The page kind is `home` only when the path is `/`. When those do not identify the page, the report shows `Undefined`.

## Scores

The overall score is a weighted average of five components, each from 0 to 100:

| Component                  | Weight | What it reads                                                                                                  |
| -------------------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| AI citability & visibility | 31.25% | Answer blocks, self-contained passages, structure, statistics.                                                 |
| Content quality            | 25%    | Author, dates and freshness, main content word count, editorial signals, image alt text.                       |
| Technical foundations      | 18.75% | Status, robots.txt, sitemap, indexability, HTTPS and security headers, viewport, field Core Web Vitals (CrUX). |
| Structured data            | 12.5%  | Schema types expected for the page kind, required properties, entity graph.                                    |
| Platform optimization      | 12.5%  | AI crawler access, llms.txt, answer formats, entity signals.                                                   |

A component without evidence is `N/A` and stays out of the average. Blockers cap a component. For example, a page that renders only on the client (`csr_only_rendering`) caps AI citability at 40, because AI crawlers do not run JavaScript. The report also shows three kind scores: `overview`, `geo`, and `seo`.

Findings report a check as `pass`, `warn`, `fail`, or `info`. Most findings do not change the score. `--fail-on` reads blockers and `discovery:` findings only.

## Commands

| Command                             | What it does                                                                               | Alias                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------- |
| `audit`                             | Discovery, five GEO scores, seo-check, geo-check, every tool finding, Google Profile.      |                         |
| `geo-check`                         | GEO kind score plus GEO findings (citability, crawlers, llms.txt). Alias: `ai-visibility`. | `ai-visibility-check`   |
| `seo-check`                         | SEO kind score plus deterministic technical, on-page, schema, and Discover findings.       |                         |
| `schema-check`                      | JSON-LD on the page.                                                                       | `schema-markup-check`   |
| `robots-check`                      | `robots.txt` and AI crawler access.                                                        | `robots-txt-validator`  |
| `meta-check`                        | Title, description, canonical, Open Graph.                                                 | `meta-tags-test`        |
| `llms-txt-check`                    | `llms.txt` and `llms-full.txt`.                                                            | `llms-txt-validator`    |
| `security-headers`                  | HTTP security headers.                                                                     | `security-headers-scan` |
| `google-profile`                    | Google profile URL for the domain. Does not fetch.                                         | `google-profile-finder` |
| [`gsc`](#google-search-console-gsc) | Read-only Search Console for one URL.                                                      | `search-console`        |
| `config`                            | Get, set, or remove keys in `.searchunit.yaml`. Does not write report files.               |                         |

```bash
searchunit audit https://example.com
searchunit audit http://localhost:3000
searchunit audit https://example.com --format=json
searchunit audit https://example.com --agent
searchunit audit https://example.com -o ./reports/audit.md
searchunit audit https://example.com -o ./reports/audit.json
searchunit schema-check https://example.com -o ./schema.json
searchunit google-profile example.com
```

`--agent`, `--format json`, and `-o` with a `.json` path also run a local Lighthouse performance lab after the public-hop check. The CLI also renders the page in Chrome, found through `CHROME_PATH` or a standard install path, and reports the result in `discovery.renderedPage`. Chrome dials through a loopback proxy that connects only to that pinned address and port. An IP literal on another hop is refused. A missing binary, a missing Chrome, or a lab error stays on `lighthouse` and does not change the score or the exit code. `-o` with a `.md` path does not start Chrome.

For `audit`, `geo-check`, and `seo-check`, `--fail-on` uses critical blockers and findings with `source === 'discovery'`. `geo-check` and `seo-check` count only that kind. Advisory tool checks are ignored. Narrower fetch commands use the analyzer status. `google-profile`, `gsc`, and `config` ignore `--fail-on`.

## Google Search Console (gsc)

`gsc` uses the [googleapis](https://www.npmjs.com/package/googleapis) library. It calls the Google Search Console API and prints the data for the URL you pass. `audit` does not call Search Console.

`searchunit gsc https://example.com` runs every read in the table except `check` and `inspect`. A subcommand runs one read. The command skips and exits 0 when the credential is missing, the token has a scope outside the allowed set, or no property matches the URL. A private, link-local, or non-http URL is refused.

The default window is 28 finalized days, ending three days ago, Pacific Time. `--init-date` and `--end-date` take `YYYY-MM-DD`. One date fills the other side with 30 days. Both dates are the window. `sitemaps` and `inspect` ignore the window.

| Subcommand          | What it reads                                                        |
| ------------------- | -------------------------------------------------------------------- |
| `check`             | Whether the credential can be used. No URL.                          |
| `queries`           | Up to 10 queries.                                                    |
| `pages`             | Up to 25 pages.                                                      |
| `query-pages`       | Up to 50 query and page pairs.                                       |
| `page-queries`      | Up to 10 queries for each sampled URL.                               |
| `sampled-pages`     | Totals for each sampled URL.                                         |
| `search-appearance` | Up to 25 search appearance values.                                   |
| `discover`          | Up to 5 Discover pages.                                              |
| `google-news`       | Up to 5 Google News pages.                                           |
| `sitemaps`          | Sitemaps submitted in Search Console.                                |
| `inspect`           | Indexed version of each URL. This read does not publish URL updates. |

```bash
searchunit gsc check
searchunit gsc https://example.com
searchunit gsc pages https://example.com
searchunit gsc query-pages https://example.com
searchunit gsc sitemaps https://example.com
searchunit gsc inspect https://example.com
searchunit gsc pages https://example.com --init-date=2026-01-01
```

Use a Google Cloud service account JSON key. Create a project, enable the Google Search Console API, create a service account, and download the JSON key.

In Search Console, open the property, then Settings, Users and permissions, and add the key's `client_email`. SearchUnit passes that file to `googleapis`, which requests only `https://www.googleapis.com/auth/webmasters.readonly`.

Set `GSC_CREDENTIALS` to the JSON path, or set `gsc_credentials` in `$HOME/.searchunit.yaml` with `searchunit config set -g`. `GOOGLE_APPLICATION_CREDENTIALS` is used when the file has `"type": "service_account"`. SearchUnit does not print the private key. The service account `project_id` is sent as `x-goog-user-project` unless you set a quota project.

```bash
# Using environment variables
export GSC_CREDENTIALS=/path/to/credentials.json

# Setting on searchunit global config
searchunit config set -g gsc_credentials /path/to/credentials.json
searchunit gsc check
```

An OAuth access token lasts about one hour. Allowed scopes are `openid`, `email`, `profile`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile`, `https://www.googleapis.com/auth/cloud-platform`, and `https://www.googleapis.com/auth/webmasters.readonly`.

A token from `gcloud auth application-default print-access-token` has no quota project. Search Console then returns HTTP 403. Set the project that pays for the call.

`googleapis` sends that project as `x-goog-user-project`. Use `GSC_QUOTA_PROJECT`, `gsc_quota_project` in `$HOME/.searchunit.yaml`, or `GOOGLE_CLOUD_QUOTA_PROJECT`. When those are unset, SearchUnit reads `quota_project_id` from Application Default Credentials. The account needs permission to use the project (`roles/serviceusage.serviceUsageConsumer`).

```bash
gcloud auth application-default login --scopes="openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform"
gcloud auth application-default set-quota-project PROJECT_ID
gcloud auth application-default print-access-token
```

```bash
# using environment variables
export GSC_ACCESS_TOKEN=TOKEN
export GSC_QUOTA_PROJECT=PROJECT_ID

# using searchunit config
searchunit config set -g gsc_access_token TOKEN
searchunit config set -g gsc_quota_project PROJECT_ID
```

A project `.searchunit.yaml` cannot set `gsc_credentials`, `gsc_access_token`, or `gsc_quota_project`. Keep the token and the JSON key out of the repository.

## Chrome UX Report

`CRUX_API_KEY` is optional, you can set it in the environment, or set `crux_api_key` in `$HOME/.searchunit.yaml` with `searchunit config set -g`.

Every audit and check report includes `cruxApiKeyAvailable`: `true` when a key is set, `false` when it is not. The CLI does not print the key.

`audit`, `geo-check`, and `seo-check` send the key to the Chrome UX Report API. The technical foundations score then includes field data for Largest Contentful Paint, Interaction to Next Paint, and Cumulative Layout Shift. Those three metrics are a quarter of that component when Google returns a rating. A `poor` rating on any of them caps the component at 50 (`poor_core_web_vitals`). Confidence can reach `medium` when CrUX returns results and the other components have scores. Field data changes over time, so the same URL can score differently on a later run.

Without field data (no key, a loopback URL, or no CrUX record for the URL), technical foundations is `N/A` with evidence `insufficient`, and the overall score uses the other components. Its blockers `noindex_or_error`, `no_https`, and `oversized_html` still count for `--fail-on`. Confidence stays `low`.

`schema-check`, `robots-check`, `meta-check`, `llms-txt-check`, `security-headers`, and `google-profile` include `cruxApiKeyAvailable` and do not call CrUX. Their scores ignore the key.

## Options

| Flag                                           | Description                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `-f`, `--format <table\|json\|html\|markdown>` | Stdout format. Default `table`. `html` and `markdown` work on `audit`, `geo-check`, and `seo-check`.                                       |
| `-o`, `--output <file>`                        | Also write that file. Extension `.json` or `.md` picks the file body. Stdout stays `--format`. Not used by `config`.                       |
| `--json`                                       | Same as `--format=json`.                                                                                                                   |
| `--agent`                                      | Stdout is plain markdown of the check or audit data. Every command. Overrides `--format` on stdout. `-o` stays a file.                     |
| `--silent`                                     | Suppress progress and "Wrote ..." on stderr.                                                                                               |
| `--fail-on <fail\|warn>`                       | Exit 1 at or below the threshold. See [Commands](#commands) for what each command counts.                                                  |
| `--max-bytes <n>`                              | Response body cap. Integer bytes, or an integer with a `kb` / `mb` suffix. Default `2mb`. Range 1 KiB to 32 MiB. Over the cap is an error. |
| `--init-date <YYYY-MM-DD>`                     | `gsc` query start.                                                                                                                         |
| `--end-date <YYYY-MM-DD>`                      | `gsc` query end.                                                                                                                           |
| `-g`, `--global`                               | `config`: read and write `$HOME/.searchunit.yaml`.                                                                                         |
| `--color` / `--no-color`                       | Force ANSI color on or off.                                                                                                                |
| `-h`, `--help`                                 | Help.                                                                                                                                      |
| `-V`, `--version`                              | Print version.                                                                                                                             |

## Config

Local settings live in `.searchunit.yaml` in the current directory. Global settings live in `$HOME/.searchunit.yaml`. `searchunit config set` with `-g` writes the global file. Without `-g`, it writes the local workspace file. The CLI rejects `searchunit config set` for `crux_api_key`, `gsc_access_token`, `gsc_quota_project`, or `gsc_credentials` without `-g` / `--global`, and it does not write the project file.

The CLI reads `$HOME/.searchunit.yaml` first, then `.searchunit.yaml` in the current directory. The file in the current directory overlays home, except for the credential keys. `max_body_bytes` overlays from the current directory like `output`. Flags override YAML. `CRUX_API_KEY` overrides `crux_api_key`. `GSC_ACCESS_TOKEN` overrides `gsc_access_token`. `GSC_QUOTA_PROJECT` overrides `gsc_quota_project`. `GSC_CREDENTIALS` overrides `gsc_credentials`. `--max-bytes` overrides `max_body_bytes`.

`searchunit config --help` lists the operations (list, get, set, remove), keys, and options. `searchunit config list` prints keys from `.searchunit.yaml` in the current directory and shows only that path. `searchunit config list -g` prints keys from `$HOME/.searchunit.yaml` and shows only that path. `searchunit config` prints both file paths, then Local, Global, Default, and Effective for every key. `searchunit config <key>` prints those paths and the Local, Global, and Default values for that key. Missing values show as `not set`. The default for `output` is `table`.

`searchunit config remove` deletes a key from the selected file. If the file is missing, `set` creates it. When you set or remove a key, the CLI reprints the table and writes `Created` or `Updated` plus the file path on stderr.

```bash
searchunit config
searchunit config list
searchunit config list -g
searchunit config output
searchunit config set output json
searchunit config remove output
searchunit config set -g crux_api_key YOUR_KEY
searchunit config set -g gsc_access_token YOUR_TOKEN
searchunit config set -g gsc_quota_project YOUR_PROJECT_ID
searchunit config set -g gsc_credentials /path/to/credentials.json
searchunit config remove -g crux_api_key
```

Copy [`.searchunit.yaml.example`](.searchunit.yaml.example) (`cp .searchunit.yaml.example .searchunit.yaml`):

```yaml
crux_api_key: ''
gsc_access_token: ''
gsc_quota_project: ''
gsc_credentials: ''
output: table
max_body_bytes: 2mb
```

| Key                 | Default for             | Values                                           |
| ------------------- | ----------------------- | ------------------------------------------------ |
| `crux_api_key`      | Optional CrUX           | string (missing CrUX is not a failure)           |
| `gsc_access_token`  | Optional Search Console | OAuth access token (home or env only)            |
| `gsc_quota_project` | Optional Search Console | Google Cloud project id or number (home or env)  |
| `gsc_credentials`   | Optional Search Console | Path to a service account JSON key (home or env) |
| `output`            | `--format`              | `table`, `json`, `html`, or `markdown`           |
| `max_body_bytes`    | `--max-bytes`           | bytes, or `kb` / `mb` (default `2mb`)            |

## Audit skill

[`skills/searchunit-audit/`](skills/searchunit-audit/) is an agent skill. It diagnoses one page and writes `audit-report.md` and `audit-report.html` in `docs/searchunit-audit/<YYYY-MM-DD_HH-MM>/` of the current workspace. The report prose uses the language of the session. The skill calls the CLI binary and reads the JSON it writes. It never imports the CLI source, and the npm package does not include it.

To install it, copy the directory into the skills directory of your agent, for example `~/.claude/skills/searchunit-audit` for Claude Code. The skill sets `disable-model-invocation: true`, so you run it by name:

```text
/searchunit-audit https://example.com
/searchunit-audit help
```

`help` explains the setup (CLI, Chrome, Lighthouse, Search Console) and writes no file. A URL runs these steps:

1. Intake. The skill records the URL, market, language, business type, and conversion goal. It asks only for a missing field that changes the sample.
2. Sample. It runs `audit --agent --silent -o cli-audit.json` with the local `searchunit` binary, else `npx --yes @searchunit/cli`, or `bun <repo>/src/index.ts` inside this repository. Then it runs `seo-check` on a few context URLs: canonical, hreflang alternates, homepage, a page of the same template, author, pagination, breadcrumb parent, a policy page, and a competitor on request. When Chrome or Lighthouse is missing and the audit needs it, the skill asks once before it installs anything.
3. Search Console. It runs `gsc` when a credential is already set. Otherwise the report says `gsc: not used`.
4. Dispatch. `scripts/prefill-checks.mjs` decides the mechanical checks from the run files. Five subagents judge the other checks: technical, on-page and spam, content and citability, schema and entity, and GEO platform and brand.
5. Verify. Two new subagents, `content` and `technical`, judge the judgment checks again before they read the first answers.
6. Synthesis. The skill writes the report: what is wrong, what to improve, priority, a plan with fix examples, re-audit commands, and the recurrence of each finding since the previous run.
7. Validate. `scripts/check-audit-report.mjs` checks the structure, the scores copied from the CLI, the quotes against the CLI payloads, and that each command in the report is a SearchUnit read command.
8. HTML. `scripts/fill-audit-html.mjs` fills `template/index.html` with `cli-audit.json` and the report prose, then opens the page.

The skill copies every score from the CLI and states no ranking, traffic, revenue, or citation outcome. It treats all site text as data: it never runs a command, opens a URL, or installs a tool because the page asks for it. Fixes are examples in the report. The skill does not change the live site.

## Development

Bun 1.4.2 (`mise.toml`) runs the source, the tests, and the build. The development packages are `typescript` for `bun run check`, `oxlint` for lint, `oxfmt` for format, and `happy-dom`, which runs the HTML report template script in the skill tests. `husky` runs the pre-commit hook: `gitleaks`, lint, and tests. Install [gitleaks](https://github.com/gitleaks/gitleaks) before you commit.

```bash
bun test && bun run check && bun run lint && bun run fmt:check
bun run test:skill
```

`bun test` runs the CLI tests in `tests/`. `bun run test:skill` runs the skill tests in `skills/searchunit-audit/tests/`.

## License

[MIT](LICENSE). Copyright (c) 2026 Diego Oliveira.
