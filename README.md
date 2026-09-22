# SearchUnit CLI

Local CLI for one public URL. It fetches static HTTP and prints a deterministic SEO/GEO audit, or a narrower check. Runtime is Node.js 20 or newer.

```bash
npm install -g @searchunit/cli
searchunit --help
```

```bash
npx @searchunit/cli --help
```

## How it works

You pass a command and a target. The CLI parses flags, loads `.searchunit.yaml` when the command is not `config` (and not `--help` / `--version`), then runs one handler.

`audit`, `geo-check`, and `seo-check` fetch the page and related files, score GEO components, and emit findings. `audit` also embeds the `seo-check` and `geo-check` reports plus the Google Profile URL. `geo-check` and `seo-check` alone print that kind score and the filtered findings. The other fetch commands parse and analyze one domain (schema, robots, meta, llms.txt, or security headers). `google-profile` builds a URL. `config` reads or writes YAML.

Each run covers a single URL. The HTML is parsed as static markup. The CLI does not execute page JavaScript. Progress goes to stderr. The report goes to stdout.

Network (http/https on ports 80 and 443 only):

- The page you pass
- `/robots.txt`
- A sitemap URL from `robots.txt`, then from the HTML (`link rel="sitemap"` or a sitemap-named link), otherwise `/sitemap.xml`
- `llms.txt` and `llms-full.txt`
- Chrome UX Report (CrUX), only if you set a key. A missing key skips CrUX and is not a failure.

Response bodies are capped at 2 MiB by default (`--max-bytes` or `max_body_bytes`, from 1 KiB to 32 MiB). A body over that cap is an error. The CLI does not return a truncated document. HTML larger than 2 MiB is a report problem: [Googlebot indexes only the first 2 MiB](https://www.debugbear.com/blog/googlebot-crawler-file-size-limit) of uncompressed HTML. That finding appears when the cap is raised and the full page is fetched. `robots.txt` and `llms.txt` are scored signals. A missing file does not stop the page fetch. Hosts that fail the SSRF checks are refused.

Page kind and site type come from schema.org types and `og:type`. When those do not identify the page, the report shows `Undefined`.

The audit kind table shows overview, geo, and seo.

## Chrome UX Report

`CRUX_API_KEY` is optional. Set it in the environment, or set `crux_api_key` in `$HOME/.searchunit.yaml` with `searchunit config -g`. A project `.searchunit.yaml` cannot set this key. Every audit and check report includes `cruxApiKeyAvailable`: `true` when a key is set, `false` when it is not. The CLI does not print the key.

`audit`, `geo-check`, and `seo-check` send the key to the Chrome UX Report API. The technical foundations score then includes field data for Largest Contentful Paint, Interaction to Next Paint, and Cumulative Layout Shift. Those three metrics are a quarter of that component when Google returns a rating. A `poor` rating on any of them caps the component at 50 (`poor_core_web_vitals`). Confidence can reach `medium` when CrUX returns results and the other components have scores. Field data changes over time, so the same URL can score differently on a later run.

Without a key, CrUX is skipped. Technical foundations is scored from the other signals only, and those weights are scaled to fill the gap. The poor-vitals cap does not apply. Confidence stays `low`.

`schema-check`, `robots-check`, `meta-check`, `llms-txt-check`, `security-headers`, and `google-profile` include `cruxApiKeyAvailable` and do not call CrUX. Their scores ignore the key.

## Commands

| Command            | What it does                                                                               | Alias                   |
| ------------------ | ------------------------------------------------------------------------------------------ | ----------------------- |
| `audit`            | Discovery, five GEO scores, seo-check, geo-check, every tool finding, Google Profile.      |                         |
| `geo-check`        | GEO kind score plus GEO findings (citability, crawlers, llms.txt). Alias: `ai-visibility`. | `ai-visibility-check`   |
| `seo-check`        | SEO kind score plus deterministic technical, on-page, schema, and Discover findings.       |                         |
| `schema-check`     | JSON-LD on the page.                                                                       | `schema-markup-check`   |
| `robots-check`     | `robots.txt` and AI crawler access.                                                        | `robots-txt-validator`  |
| `meta-check`       | Title, description, canonical, Open Graph.                                                 | `meta-tags-test`        |
| `llms-txt-check`   | `llms.txt` and `llms-full.txt`.                                                            | `llms-txt-validator`    |
| `security-headers` | HTTP security headers.                                                                     | `security-headers-scan` |
| `google-profile`   | Google profile URL for the domain. Does not fetch.                                         | `google-profile-finder` |
| `config`           | Get, set, or unset keys in `.searchunit.yaml`. Does not write report files.                |                         |

```bash
searchunit audit https://example.com
searchunit audit https://example.com --format=json
searchunit audit https://example.com --agent
searchunit audit https://example.com -o ./reports/audit.md
searchunit schema-check https://example.com -o ./schema.json
searchunit google-profile example.com
searchunit config
searchunit config output json
searchunit config -g crux_api_key YOUR_KEY
```

GEO scores live in the engine. `audit`, `geo-check`, and `seo-check` `--fail-on` use critical blockers and findings with `source === 'discovery'` (`geo-check` / `seo-check` only that kind). They ignore advisory tool checks. On the narrower fetch commands, `--fail-on` uses the analyzer status. `google-profile` and `config` ignore `--fail-on`.

## Options

`-f` / `--format` is the stdout format. `-o` / `--output` is a file path (`.json` or `.md`) and still prints stdout.

| Flag                                           | Description                                                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `-f`, `--format <table\|json\|html\|markdown>` | Stdout format (default: table). `html` and `markdown` are for `audit`, `geo-check`, and `seo-check`. Other commands: `json` or table.   |
| `-o`, `--output <file>`                        | Also write that file. Extension `.json` or `.md` picks the file body. Stdout stays `--format`. Not used by `config`.                    |
| `--json`                                       | Same as `--format=json`.                                                                                                                |
| `--agent`                                      | Stdout is plain markdown of the check or audit data. Every command. Overrides `--format` on stdout. `-o` stays a file.                  |
| `--silent`                                     | Suppress progress and “Wrote …” on stderr.                                                                                              |
| `--fail-on <fail\|warn>`                       | Exit 1 at or below the threshold.                                                                                                       |
| `--max-bytes <n>`                              | Response body cap. Integer bytes, or an integer with a `kb` / `mb` suffix. Default `2mb`. Range 1 KiB–32 MiB. Over the cap is an error. |
| `-g`, `--global`                               | `config`: read and write `$HOME/.searchunit.yaml`.                                                                                      |
| `--unset`                                      | `config`: remove a key.                                                                                                                 |
| `--color` / `--no-color`                       | Force ANSI color on or off.                                                                                                             |
| `-h`, `--help`                                 | Help.                                                                                                                                   |
| `-V`, `--version`                              | Print version.                                                                                                                          |

## Config

Merge order: `$HOME/.searchunit.yaml`, then `.searchunit.yaml` in the current directory (cwd overlays home except `crux_api_key`). `crux_api_key` comes from `$HOME` YAML, flags, or `CRUX_API_KEY`, so a project file cannot set the CrUX key. `max_body_bytes` overlays from cwd like `output`. Flags override YAML. `CRUX_API_KEY` overrides `crux_api_key`. `--max-bytes` overrides `max_body_bytes`.

`searchunit config --help` lists the operations (list, get, set, unset), keys, and options. `searchunit config list` prints keys from cwd `.searchunit.yaml` and shows only that path. `searchunit config list -g` prints keys from `$HOME/.searchunit.yaml` and shows only that path. `searchunit config` without `list` still prints Local, Global, Default, and Effective for every key. `searchunit config` updates `.searchunit.yaml` in the current directory. `searchunit config -g` updates `$HOME/.searchunit.yaml`. Setting `crux_api_key` without `-g` / `--global` is rejected and does not write the project file. If the file is missing, the command creates it.

`searchunit config` and `searchunit config <key>` print the Local and Global file paths, then a table of Local, Global, and Default values. Missing values show as `not set`. The CLI default for `output` is `table`. Setting or unsetting a key reprints that table and writes `Created` or `Updated` plus the file path on stderr.

```bash
searchunit config
searchunit config list
searchunit config list -g
searchunit config output
searchunit config output json
searchunit config -g crux_api_key YOUR_KEY
searchunit config -g --unset crux_api_key
```

Copy [`.searchunit.yaml.example`](.searchunit.yaml.example):

```yaml
crux_api_key: ''
output: table
max_body_bytes: 2mb
```

| Key              | Default for   | Values                                 |
| ---------------- | ------------- | -------------------------------------- |
| `crux_api_key`   | Optional CrUX | string (missing CrUX is not a failure) |
| `output`         | `--format`    | `table`, `json`, `html`, or `markdown` |
| `max_body_bytes` | `--max-bytes` | bytes, or `kb` / `mb` (default `2mb`)  |

## Development

```bash
bun test && bun run check && bun run lint && bun run fmt:check
```

## License

[MIT](LICENSE). Copyright (c) 2026 Diego Oliveira.
