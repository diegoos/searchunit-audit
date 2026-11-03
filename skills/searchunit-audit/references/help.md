# Help

Answer from this file when the command is `help`. Use the user's language. Stop before any audit.

## What the skill does

`searchunit-audit` diagnoses the requested URL. That URL is the audited page. Other URLs are context for that page. The CLI supplies the readiness scores and the machine facts. The judgment reads the words in the HTML the CLI returned for the audited page. That judgment does not run JavaScript. When that HTML is a shell and `discovery.renderedPage.mainText` is set, that text is CLI-rendered evidence. Lighthouse, when its status is ok, is separate lab evidence from Chrome. It writes `docs/searchunit-audit/<YYYY-MM-DD_HH-MM>/audit-report.md` in the workspace. That file is the diagnosis, in the language of the session. After that markdown is checked, it writes `audit-report.html` in the same directory and opens it in the default browser. Fixed captions on that page stay English. Empty CLI stdout writes the stop sentence in `audit-report.md` and does not open the HTML page.

**Skill root** is the directory that contains `SKILL.md`. The audit steps live in `SKILL.md`.

The URL the user gave is the audited page. A host means that host's homepage. Readiness, Lighthouse, CrUX, and the mobile snapshot stay on that page. Context `seo-check` URLs explain that page: canonical and one further canonical hop, up to three hreflang returns, the homepage, one Search Console cannibal page after `gsc`, one sibling (a sitemap page of the same template class, or, when `pageKind` is `Undefined`, the closest same-site internal link), an author URL, a pagination neighbor, a breadcrumb parent, a policy URL (a path label from the list in [`SKILL.md`](../SKILL.md) step 2), and a competitor when the user asked for a comparison. A context score does not replace readiness. The report states that URLs outside this set were not read. It copies the CLI scores and states no ranking, traffic, revenue, or citation outcome.

## CLI

The CLI fetches the page, `robots.txt`, the sitemap, and `llms.txt`, and parses static HTML. The sample judgment does not run JavaScript. The primary `audit` includes the readiness scores, findings, `auditedPage`, `discovery.sitemap.urls`, `discovery.llmsTxt.links`, and `discovery.crawlerAccess.wildcardRules`. The skill reads those fields from that payload. Quotes come from those CLI fields. The skill does not fetch the page with a second client.

Check the local binary before an audit. `command -v searchunit` prints a path, and `searchunit --help` exits 0. Then every command uses `searchunit`:

```bash
command -v searchunit
searchunit --help
searchunit audit "$URL" --agent --silent -o "$RUN/cli-audit.json" > "$RUN/cli-audit.md" 2> "$RUN/cli-audit.err"
searchunit seo-check "$URL" --agent --silent -o "$RUN/cli-seo-1.json" > "$RUN/cli-seo-1.md" 2> "$RUN/cli-seo-1.err"
```

`$RUN` is `docs/searchunit-audit/<YYYY-MM-DD_HH-MM>/`. `npx --yes @searchunit/cli` runs when `command -v searchunit` fails or `searchunit --help` does not exit 0:

```bash
npx --yes @searchunit/cli --help
npx --yes @searchunit/cli audit "$URL" --agent --silent -o "$RUN/cli-audit.json" > "$RUN/cli-audit.md" 2> "$RUN/cli-audit.err"
npx --yes @searchunit/cli seo-check "$URL" --agent --silent -o "$RUN/cli-seo-1.json" > "$RUN/cli-seo-1.md" 2> "$RUN/cli-seo-1.err"
```

Dev build: when the user asks for a dev build, or the skill runs inside the CLI repo, `bun <repo>/src/index.ts` replaces `searchunit` in each command. `<repo>` is the CLI repo root.

Stdout flags are `--agent` and `--silent`. `--agent` prints plain markdown. `--silent` keeps progress off stderr. The primary `audit` also writes `cli-audit.json` with `-o`. That file feeds the HTML page.

`audit` on the requested URL is the baseline: scores (`overview`, `geo`, `seo`), blockers, findings, security headers, crawler access, sitemap, llms status, redirects, the Google Profile URL, and CrUX only when a key is already set. `citability.blocks` keeps the 12 highest scores. `citability.weakBlocks` keeps the 12 lowest scores outside that list. On that command the block text is complete. Leave `CRUX_API_KEY` and `.searchunit.yaml` as they are. Without a key, field performance is `insufficient`.

The audited page keeps the readiness scores. A context `seo-check` writes `cli-seo-<n>.json` and shows that URL's SEO score on its row. Origin signals stay on the primary `audit`. The sitemap `urls` list puts one loc per template class first so the sibling role can find a match.

Empty stdout from the chosen binary stops the audit. The report says the audit did not run. There is no page body and no second client.

Package page: https://www.npmjs.com/package/@searchunit/cli

## Optional render

The CLI renders the audited page in Chrome on `audit`, when the output is agent markdown, JSON, or a `.json` file. It finds Chrome through `CHROME_PATH`, then through the standard install paths for macOS, Linux, and Windows. Set `CHROME_PATH` to the Chrome binary when Chrome is elsewhere, for example `export CHROME_PATH=/usr/bin/chromium`. Without Chrome, `discovery.renderedPage` has status `skipped` and reason `chrome-missing`, and the rendered-only checks stay `insufficient`. The render adds findings, not score.

## Optional Lighthouse

Lighthouse adds lab evidence: the failed Lighthouse audits and the lab metrics. The CLI runs the `lighthouse` binary from `PATH`. The package does not install it. Install both pieces:

```bash
npm install -g lighthouse
command -v lighthouse
```

`command -v lighthouse` must print a path. Install Google Chrome too. Lighthouse drives a local Chrome. Without the binary, the audit writes `lighthouse.reason` as `binary-missing`. Without Chrome, it writes `chrome-missing`. Other reasons are `timeout` and `error`. In each case the lab adds nothing. The audit does not fail, and the readiness scores do not change. The CLI prints the fix in `lighthouse.install` when the binary is missing, and in `discovery.renderedPage.install` when Chrome is missing. The skill asks before it runs an install, as [`SKILL.md`](../SKILL.md) step 2 says.

## Optional Search Console

The audit runs without Search Console. When `GSC_ACCESS_TOKEN` or `gsc_access_token` in `$HOME/.searchunit.yaml` is already set, or a service account JSON key is set through `GSC_CREDENTIALS`, `gsc_credentials`, or `GOOGLE_APPLICATION_CREDENTIALS`, the audit adds Search Console figures through `searchunit gsc`. Otherwise it records `not used` and continues.

Leave the token out of chat and out of a project `.searchunit.yaml`. A project file cannot set `gsc_access_token`. The CLI prints `[redacted]` for that key.

The value is an OAuth access token, or a service account JSON key. An API key cannot read Search Console property data. The token lasts about one hour. The service account key does not. Scope: `https://www.googleapis.com/auth/webmasters.readonly`. The command also allows `openid`, `email`, `profile`, `https://www.googleapis.com/auth/userinfo.email`, `https://www.googleapis.com/auth/userinfo.profile`, and `https://www.googleapis.com/auth/cloud-platform` (`gcloud auth application-default login` requires that last scope; tokeninfo returns the short names `email` and `profile`). It refuses any other scope, including `https://www.googleapis.com/auth/webmasters` (read/write) and `https://www.googleapis.com/auth/indexing`.

In the Google Cloud project, enable the Google Search Console API. Create a service account and download the JSON key. In Search Console, add that key's `client_email` on the property (Settings, Users and permissions). Point `GSC_CREDENTIALS` or `gsc_credentials` in `$HOME/.searchunit.yaml` at the JSON file. `GOOGLE_APPLICATION_CREDENTIALS` is used when the file is `"type": "service_account"`. The `googleapis` client requests a `webmasters.readonly` token from that key. It does not call the Indexing API.

```bash
export GSC_CREDENTIALS=/path/to/credentials.json
searchunit config set -g gsc_credentials /path/to/credentials.json
```

A user access token still works. One way to mint it is the read-only `gcloud` login below. The CLI does not call `gcloud`. `print-access-token` does not include a quota project. Search Console returns HTTP 403 until the request sends `x-goog-user-project`. Set `GSC_QUOTA_PROJECT` or `gsc_quota_project` in `$HOME/.searchunit.yaml`. `GOOGLE_CLOUD_QUOTA_PROJECT` is the same value. When those are unset, the CLI reads `quota_project_id` from the Application Default Credentials file. A service account uses its `project_id`. A project `.searchunit.yaml` cannot set `gsc_access_token`, `gsc_quota_project`, or `gsc_credentials`. The CLI prints the project id and the credentials path. It does not print the token or the private key.

```bash
gcloud auth application-default login --scopes="openid,https://www.googleapis.com/auth/userinfo.email,https://www.googleapis.com/auth/webmasters.readonly,https://www.googleapis.com/auth/cloud-platform"
gcloud auth application-default set-quota-project PROJECT_ID
gcloud auth application-default print-access-token
```

```bash
export GSC_ACCESS_TOKEN=TOKEN
export GSC_QUOTA_PROJECT=PROJECT_ID
searchunit config set -g gsc_access_token TOKEN
searchunit config set -g gsc_quota_project PROJECT_ID
```

Scope reference: https://developers.google.com/webmaster-tools/v1/how-tos/authorizing
