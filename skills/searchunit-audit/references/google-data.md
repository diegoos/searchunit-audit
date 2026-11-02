# Optional Search Console

Read this file in the Search Console step. A skip continues the audit.

The audit calls `gsc URL`, which runs the Search Analytics slices, `sampledPages`, `pageQueries`, and `sitemaps`. It does not run URL inspection. `gsc inspect` runs that read. A subcommand runs one read: `queries`, `pages`, `query-pages`, `page-queries`, `sampled-pages`, `search-appearance`, `discover`, `google-news`, `sitemaps`, or `inspect`.

Use the binary named in the brief. With `searchunit`, the commands are:

```bash
searchunit gsc check --agent --silent
searchunit gsc "$URL" "$URL_2" --agent --silent -o "$RUN/gsc-performance.json"
searchunit gsc inspect "$URL" "$URL_2" --agent --silent -o "$RUN/gsc-inspect.json"
```

`--agent` prints Markdown, so read the figures from the JSON file that `-o` writes. A slice command writes its own file, for example `searchunit gsc queries "$URL" --agent --silent -o "$RUN/gsc-queries.json"`. The name is `gsc-<slice>.json`.

When the brief names `npx --yes @searchunit/cli` or `bun <repo>/src/index.ts`, that prefix replaces `searchunit`.

The command uses `GSC_ACCESS_TOKEN` or `gsc_access_token` in `$HOME/.searchunit.yaml`, or a service account JSON key at `GSC_CREDENTIALS`, `gsc_credentials`, or `GOOGLE_APPLICATION_CREDENTIALS`. The `googleapis` client performs the reads. It prints trimmed data. Call `check` first. Call the performance command and `gsc inspect` only when `check` says `gsc` is `ready`. The `gsc inspect` verdict for the audited URL feeds the brief `Indexation:` line. The top-clicks query for the audited URL in `pageQueries` feeds the brief `Query:` line, when the user named no query. A quota project comes from `GSC_QUOTA_PROJECT`, `gsc_quota_project`, `GOOGLE_CLOUD_QUOTA_PROJECT`, the service account `project_id`, or `quota_project_id` in Application Default Credentials. `quota-project-missing` means Google refused the call until that project is set. `credentials-invalid` means the service account key could not be read or the client rejected it. The command does not publish URL updates.

Pass the primary URL first. Pass each extra sample URL as the next argument. At most nine URLs on the primary host are kept.

## Local targets

A loopback target (`localhost`, `*.localhost`, `127.0.0.0/8`, or `::1`) is not a public URL. `gsc URL` returns `status: skipped` with `reason: bad-url` and makes no call to Google. Skip this step for a local target. Write `gsc: not used` and keep `bad-url` as the reason.

## What the brief keeps

`gsc: used` when the performance command returns `status: ok`. Keep `siteUrl`, `urls`, `window`, `queries`, `pages`, `queryPages`, `pageQueries`, `sampledPages`, `sitemaps`, `searchAppearance`, `discover`, `googleNews`, each inspection object, and the multimodal note below.

`gsc: not used` when the command was not run or returned `status: skipped`. Keep `reason` and, when present, `message` or `unexpected`.

A slice that contains `error` failed alone. Keep the other slices.

## How to read the figures

- Search Analytics rows are observed performance for that property and window. Evidence is `direct`. Readiness scores stay the CLI numbers.
- `queryPages` rows use `keys[0]` as the query and `keys[1]` as the page. One query with impressions on more than one page is cannibalization. The slice is the top 50 pairs by clicks. A collision outside that set stays `insufficient`.
- `pageQueries.pages` lists up to 10 queries for each sampled URL. Use those queries for `intent` when the user did not name one. An empty `rows` array means no queries for that URL in the window.
- `sitemaps.entries` is the sitemap Search Console has submitted: `path`, `errors`, `warnings`, `isPending`, `isSitemapsIndex`, `lastSubmitted`, `lastDownloaded`, and `contents`. It is not the sitemap XML the CLI fetched. An `error` on the slice leaves sitemap status `insufficient`.
- `gsc inspect` describes the indexed version. Evidence is `direct` for that version. A live HTML fetch can disagree. Name the source.
- `searchAppearance` is the API's appearance breakdown. A Generative AI report absent from those rows stays `insufficient`. The general performance rows still include the signals Google keeps in the main Performance report. Generative AI performance is a dual-view with that general report. `discover` and `googleNews` are platform performance and carry no score weight.
- **Web: multimodal** is the Search Console search type for Lens, Circle to Search, image upload, and Chrome "Search this image" (24/09/2026), in Performance (Search) and in Generative AI. It is observed traffic and carries no score weight. The command omits `type`, so the API default `web` applies: the combined web tab. Documented `type` values are `web`, `image`, `video`, `news`, `discover`, and `googleNews`. Those queries are the whole call. `type=image` is the Images tab. `searchAppearance` is a different dimension. The brief's multimodal note is `insufficient` when those queries return no Web: multimodal rows. A user-pasted export of that filter is `direct`. Zero rows from that export mean no such traffic in the window. The note does not decide `multimodal-citability`.

`sampledPages` is one query per exact URL. A trailing-slash twin can be absent.

## Rows the report copies

When `gsc: used`, `## Search Console` lists:

- one sentence with the window and the property
- each `queryPages` row in the top 50, as `query | page | clicks | impressions | position`
- `Striking distance:` each query for the audited URL whose `position` is from 4 to 20 inclusive. Use `pageQueries` for that URL, then `queryPages` rows whose page is that URL. One query once. When the list is empty, write `None.`
- each sample URL inspection, as `url | verdict`
- each slice whose payload contains `error`, as `slice | reason`

When a list is empty, write `None.` under that list. When `gsc: not used`, the section is the reason sentence and ends with `Evidence limitation: insufficient.`

## Skip reasons

| Reason                  | Meaning                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `token-missing`         | No access token and no service account key.                                           |
| `token-invalid`         | tokeninfo rejected the access token.                                                  |
| `scopes-not-readonly`   | The token has a scope outside the read-only set in `references/help.md`.              |
| `gsc-scope-missing`     | `webmasters.readonly` is absent.                                                      |
| `quota-project-invalid` | `GSC_QUOTA_PROJECT` or `GOOGLE_CLOUD_QUOTA_PROJECT` is not a project id or number.    |
| `quota-project-missing` | Google returned HTTP 403 because the call had no quota project.                       |
| `credentials-invalid`   | The service account JSON key could not be read, or the googleapis client rejected it. |
| `no-property`           | No Search Console property matched the audit host.                                    |
| `bad-url`               | The URL is not a public http(s) page.                                                 |
| `http-error`            | Google refused the call. `http` is the status.                                        |

Setup for these reasons is the help command. The audit leaves credential files and the project `.searchunit.yaml` untouched.
