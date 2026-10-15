# Changelog

Versions follow Semantic Versioning. Notes stay under Unreleased until `package.json` `version` changes.

## Unreleased

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
