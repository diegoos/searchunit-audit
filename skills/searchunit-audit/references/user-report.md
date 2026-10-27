# Audit report

Read this file at synthesis. Write this file in the run directory:

```txt
docs/searchunit-audit/<YYYY-MM-DD_HH-MM>/audit-report.md
```

This file is the diagnosis and the plan. It records what is wrong, what to improve, the order, the fix for each cause, and how to check the result. Keep the headings below in English. Write the free sentences in the user's language for this session, using [`prose.md`](prose.md). Lines this file tells you to copy stay as written.

A reader must be able to implement every fix from this file alone, without opening the audited page again.

## Structure

```markdown
# GEO + SEO Page Audit: [audited URL]

Audit date: [YYYY-MM-DD]
Target: [URL]
Scope: page. [pagesScored] page scored. Context: [contextFetches as name=value pairs].
Market: [country/language]
Sample: [count, URLs, and template names]
Evidence used: [SearchUnit CLI audit --agent]
CLI readiness: [overview / geo / seo]
This report states no ranking, traffic, revenue, or citation outcome.
Search Console: [used or not used]
Confidence: [high/medium/low]. [how much of the sample was read, how recent the data is, and whether the main evidence is direct]
Previous run: [none. | docs/searchunit-audit/<name>/. Text hash matches. Readiness was <overview> / <geo> / <seo>. Blockers: <ids or none>. Title matches. H1 matches. Words were <n>. Canonical matches.]
Query: [<query> | assumption. <query>]
Indexation: [Search Console inspection. | status, robots, and canonical. This run did not read the indexed version.]

## Sample Coverage

## What Is Wrong

## What To Improve

## Priority

## Plan

## Re-audit

## Checks

## Examples

## Search Console

## Evidence Limits
```

Under the preamble, copy the CLI breakdown as a table with component, score, weight, and evidence. Copy `kindScores` for overview, seo, and geo.

The `Scope:` line copies `discovery.auditScope` from the primary `audit`. `level` is always `page`. Do not call the report a site audit. Context URLs from the sample step are evidence for the audited page and stay out of `pagesScored`.

Confidence names three facts: how much of the sample was read, how recent the data is, and whether the main evidence is direct. Those facts leave the CLI score unchanged. `scores.confidence` stays in the copied table as the `CLI confidence` row. The `Confidence:` line in the preamble is the sample reading, not that value.

Copy the brief `Previous run:` line verbatim. `none` means no earlier `cli-audit.json` for this URL. A directory line says whether `visibleTextSha256` matches, what the earlier readiness numbers were, which blocker ids that file listed, and whether title, H1, word count, and canonical match. That line does not change the current readiness numbers.

Copy the brief `Query:` line and the brief `Indexation:` line verbatim. `assumption` means this run had no query from the user or from `pageQueries` for the audited URL. It is a line value, not an evidence label. When the brief `Query:` line starts with `assumption.`, the Checks rows `intent`, `query-terms`, and `query-answer` have evidence `insufficient`. Their result stays what the check found. The result is `insufficient` only when the check cannot decide it. The indexation line names Search Console inspection when `gsc: used`. Otherwise it names status, robots, and canonical.

`## Sample Coverage` names the audited URL and each context URL. Each row names the role (`primary`, `canonical`, `canonical-2`, `hreflang`, `homepage`, `cannibal`, `sibling`, `author`, `pagination`, `breadcrumb`, `policy`, or `contrast`), the template, the HTTP status, and the SEO score. The primary row uses `kindScores.seo.value`. A context row uses `scores.overall` from that URL's `cli-seo-<n>.json`. A context score does not replace readiness. A role marked `not sampled` gets a row with that status and its note. Include this sentence verbatim:

```txt
URLs outside this sample were not read.
```

## Severity

Every item in `## What Is Wrong`, `## What To Improve`, `## Priority`, and `## Plan` has one severity. Apply the first rule that fits the item:

- CLI blocker (`blockers[]`): `critical`.
- CLI `fail` in discovery, indexing, or rendering. Examples: `discovery:*`, `meta:robots_meta`, `meta:canonical`, `js-rendering`, a robots rule that blocks Googlebot or Bingbot on the audited path: `high`.
- Other CLI `fail` (security headers, schema, content, links): `medium`.
- CLI `warn`: `medium` when the fix changes what search or an AI system reads from the page. Otherwise `low`.
- Search Console finding with no CLI id: `medium`.
- Judgment-only finding: at most `medium`.

Severity does not change the CLI score. Priority order does not change severity.

## Item Rules

`## What Is Wrong` lists confirmed failures. A blocker and a CLI `fail` go there. `## What To Improve` lists confirmed improvements. A CLI `warn` goes there. A CLI `fail` or `warn` that a workstream dismisses is a note, not an item. Each item has a title, the severity, the evidence label, at least one sentence, the CLI ids in backticks when they exist, and `Plan: P<n>` for its Plan entry. A content item quotes the page. A quote must support the claim it backs: if the quoted passage does not show the claim, drop the quote or change the claim.

One root cause is one item. A root cause appears once, under `## What Is Wrong` or `## What To Improve`. Its Plan entry carries the fix. Priority, Checks, and Evidence Limits point to that item by title or by Plan id. Do not repeat the cause in another section.

### Item layout

Write each item under `## What Is Wrong` or `## What To Improve` in this form:

```markdown
### [item title]

- Severity: [critical | high | medium | low].
- Evidence: [direct | proxy | lab | mixed | inferred | insufficient].
- Plan: P[n]
- CLI ids: `[id]`, `[id]`. Write `none.` when no CLI id applies.
- Affected: [audited URL, template, or response header].

[One paragraph with at least one sentence. The first sentence states the finding. A content item quotes the page here.]
```

The validator and the fill script (`scripts/fill-audit-html.mjs`) check these parts:

- The item title is the `###` text. It has no final period.
- `Severity:` is one of the four words. The item has one `Plan: P<n>` that names an entry in `## Plan`.
- The paragraph is the item text. The fill script rejects an empty paragraph, and an empty title or evidence.
- Every CLI `fail` or `warn` id, and every blocker as `blocker:<id>`, appears in backticks in `audit-report.md`.

Loopback target. When the audited host is loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), the `Target:` line ends with `(dev server)`, and the `CrUX:` evidence-limit line is `insufficient`. HTTPS is not judged for a local URL: the CLI does not fire `blocker:no_https`, and the report states that HTTPS was not checked (finding `discovery:https`). Technical foundations is `N/A`.

When `## What Is Wrong` or `## What To Improve` has no confirmed item, write:

```txt
No confirmed issues found. Evidence limitation: [short note].
```

`## Priority` orders the items the user should handle first. Write one line per item in this form:

```markdown
1. [item title]. Severity: [critical | high | medium | low]. Plan: P[n]. [One sentence.]
```

- `[item title]` equals the `###` title of one item in `## What Is Wrong` or `## What To Improve`, character for character. The fill script rejects a line whose title matches no item.
- `Severity` and `Plan` match that item.
- The sentence is required. The fill script rejects an empty one.
- The number sets the order. Item titles do not end with a period.

## Plan

`## Plan` holds one entry per root cause, in the order below. Each entry is a level-3 heading with the Plan id and the action title, then these fields as a list:

```markdown
### P1. [action title]

- Severity: [critical | high | medium | low]. Phase: [1 | 2 | 3]. Effort: [S | M | L]. Impact: [high | medium | low] (SEO, GEO, or both). Owner: [dev | content | SEO].
- Source: [CLI id in backticks, or `GSC: <slice>`, or `judgment: <reason>`].
- Fix kind: [markup | header | config | schema | content | gsc | judgment].
- Location: [URL and selector, element, template, or response header].
- Current → target: [current value] → [target value].
- Why: [why this matters for SEO or GEO, in one sentence].
- Fix: [what to change, in one to three sentences].
- Decision: [`none.` | Option A: ... Option B: ... Default: A, because ...].
- Example: [a fenced code block under this field, or `not needed.`].
- Depends on: [P<n>, or `none`].
- Verify: `[exact command with the binary chosen in step 2]`. [The finding id or payload field that must change, and its expected value].
```

Effort is `S` for a change in one file or one template, `M` for a change across templates or a service, `L` for a change that needs a content or product decision first. Impact is `high` when the fix moves a blocker, an indexing signal, or the main answer on the page. It is `medium` for a snippet, trust, or structure signal. It is `low` for hygiene.

Decision is required when the fix depends on a choice, such as which URL is canonical, which hreflang locale to use, or which price is right. Name both options and the default with its reason. Write `none.` when the fix needs no choice.

Owner is `dev` for code, headers, and config, `content` for words on the page, and `SEO` for titles, descriptions, and structure decisions that need a person to choose.

The example rule: a fix whose change is markup, an HTTP header, server config, or schema needs an example, at any severity. Build the snippet from payload values (see the fields named in [`cli-facts.md`](cli-facts.md)). Do not invent a value. When the payload does not carry a value the snippet needs, write the value as a placeholder in angle brackets and name the missing value in the Fix line. A JSON-LD example shows the whole node the payload knows, not a fragment. For a `Product`, that is the full `Product` node with its `offers` object. Each value the payload does not carry is a placeholder in angle brackets, for example `<priceCurrency>`. A content fix uses `not needed.` for Example, except when the finding needs replacement text. A citability answer block is one case. Then Example holds that replacement text in a fenced block, built from facts already on the page. A GSC or judgment fix uses `not needed.` for Example.

Order uses this formula. Phase is `1` when severity is `critical` or `high`, or when impact is `high` and effort is `S`. Otherwise phase is `2` when impact is `high` or `medium`. Otherwise phase is `3`. Plan order is phase, then impact (`high`, `medium`, `low`), then effort (`S`, `M`, `L`). When an entry depends on another, the dependency comes first.

## Re-audit

`## Re-audit` says how to check the result. It has two parts. The first part lists the commands, one line each. Use the binary chosen in step 2 for this run. For a dev build, that is `bun <repo>/src/index.ts`. Otherwise it is `searchunit`, or `npx --yes @searchunit/cli` when step 2 chose the published package:

- `<binary> audit "<URL>" --agent --silent` for the audited page.
- `<binary> seo-check "<URL>" --agent --silent` for a context URL that a Plan entry names.

The second part is the checklist. Write one line per Plan entry in this form:

```markdown
- P1: `[command]`. Check `[finding id or payload field]` is `[expected value]`.
```

Every Plan entry has one checklist line. A check that needs a second run after a deploy says so on its line.

## Checks

`## Checks` has one row for each slug that `node <skill-dir>/scripts/check-audit-report.mjs --slugs` prints. Each printed slug is one row. `Result` is `observed`, `not observed`, or `insufficient`. Their meaning is defined once, in [`workstreams.md`](workstreams.md) under Shared order: `observed` means the problem condition is present. `Evidence` is one of the six labels defined there. The table has these columns:

```markdown
| Slug                   | Result       | Evidence | Note                |
| ---------------------- | ------------ | -------- | ------------------- |
| `title-meta-alignment` | not observed | direct   | Title and H1 agree. |
```

The note is one sentence. For a CLI `fail` or `warn` that a workstream dismissed, the note cites the finding id in backticks, for example `links:status`.

## Examples

`## Examples` names the Plan entries that carry an example, one line each: the Plan id and the file or header that the example applies to. Write `None.` when no Plan entry has an example. The snippet itself stays in the Plan entry. The live site stays unchanged.

## Search Console

`## Search Console` copies the rows in [`google-data.md`](google-data.md). When `gsc: not used`, the section is the reason sentence and ends with `Evidence limitation: insufficient.`

## Evidence Limits

`## Evidence Limits` copies the six evidence-limit lines from the workstream returns. The labels and the result wording live in [`workstreams.md`](workstreams.md). When `lighthouse.status` is not `ok`, add one sentence. It says the rendered-only checks are `insufficient`, and checks on the HTML text still run. It names `lighthouse.reason`, and says the lab needs the `lighthouse` binary on `PATH` and a local Chrome install. It points to the install steps in [`help.md`](help.md). After those six lines, one sentence states the Web: multimodal note from the brief. That note is observed visibility. On-site image and video citability stays on `multimodal-citability`. The next sentence is the method sentence, copied verbatim:

```txt
The sample judgment reads static HTML. When the HTML is a shell and lighthouse.renderedText is set, that text is lab evidence. The internal link list is cut at 50. Outbound links are cut at 40. The audit probed the status of up to 25 same-site links. Outbound links are counted, never requested. Citability keeps the 12 highest scores and the 12 lowest scores outside that list. The second GET is only the mobile snapshot. Lighthouse, when status is ok, is lab evidence from Chrome. Lighthouse failed audits do not change the readiness score.
```

The next line is the `Cuts:` line from [`cli-facts.md`](cli-facts.md), copied with the tokens filled.

Readiness scores stay the CLI numbers.
