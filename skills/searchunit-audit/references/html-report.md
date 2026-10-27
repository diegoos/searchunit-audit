# HTML report

Read this file after the markdown read matches [`user-report.md`](user-report.md). The page layout stays in the template. This step writes the data the page already knows how to render.

## Files

**Template** is `template/index.html` in the skill root. `$TEMPLATE` is `$SKILL/template/index.html`. Copy it with the script below. Do not edit the template.

**CLI JSON** is `cli-audit.json` in the run directory, written by the primary `audit -o` in the sample step. Extra `cli-seo-<n>.json` files stay on disk. The fill reads the primary file only. The sample SEO scores travel in the prose.

**Prose** is `audit-prose.json` in the run directory. Write it from the saved `audit-report.md` and the brief. One root cause stays one item. Copy titles, quotes, evidence labels, severities, ids, and Plan entries. Free sentences follow [`prose.md`](prose.md). Leave scores, findings, blockers, page facts, crawlers, headers, sitemap, llms, redirects, CrUX, and the Google Profile on the CLI JSON.

**HTML** is `audit-report.html` in the run directory.

## Prose file

```json
{
  "lang": "pt-BR",
  "context": [
    { "label": "Escopo", "value": "Página: a URL auditada" },
    { "label": "Mercado", "value": "país e idioma" },
    { "label": "Amostra", "value": "contagem e templates" },
    { "label": "Evidência", "value": "SearchUnit CLI audit --agent" },
    { "label": "Search Console", "value": "usado ou não usado" },
    { "label": "Leitura", "value": "a frase de Confidence do markdown" }
  ],
  "wrong": [
    {
      "title": "",
      "text": "",
      "evidence": "direct",
      "severity": "high",
      "ids": [],
      "affected": "",
      "quote": "",
      "plan": "p1"
    }
  ],
  "improve": [
    {
      "title": "",
      "text": "",
      "evidence": "direct",
      "severity": "low",
      "ids": [],
      "affected": "",
      "plan": "p1"
    }
  ],
  "priority": [{ "title": "", "text": "", "severity": "high", "ids": [], "action": "p1" }],
  "actions": [
    {
      "id": "p1",
      "title": "",
      "severity": "high",
      "phase": "1",
      "effort": "S",
      "impact": "high",
      "owner": "dev",
      "source": "",
      "location": "",
      "current": "",
      "target": "",
      "why": "",
      "fix": "",
      "decision": "none",
      "fixKind": "header",
      "example": "",
      "dependsOn": "none",
      "verify": ""
    }
  ],
  "validation": [{ "command": "", "check": "" }],
  "checks": [{ "slug": "", "result": "", "evidence": "direct", "note": "" }],
  "sample": [{ "url": "", "role": "primary", "template": "", "status": "", "seo": "" }],
  "sampleSentence": "URLs outside this sample were not read.",
  "examples": [],
  "gsc": {
    "summary": "",
    "queryPages": [{ "query": "", "page": "", "clicks": "", "impressions": "", "position": "" }],
    "strikingDistance": [{ "query": "", "page": "", "position": "" }],
    "inspections": [{ "url": "", "verdict": "" }],
    "errors": [{ "slice": "", "reason": "" }]
  },
  "limits": [],
  "cuts": "",
  "multimodal": ""
}
```

`lang` is the BCP 47 tag of the language the user is using in this session. It is the language of the report prose. Fixed captions in the template stay English. The script writes `lang` on `<html lang>`. A missing or invalid tag makes the script exit non-zero.

The `Escopo` row (the scope label in the report language) is always the audited page. Its value names the audited URL. It never says site.

When the markdown `Previous run:` line names a directory, add a context row whose label is `Previous run` written in the report language, and whose value is that line without its `Previous run:` prefix. Omit that row when the line is `Previous run: none.`

When the markdown `Query:` or `Indexation:` line is present, add a context row for each. The label is `Query` or `Indexation` written in the report language. The value is that line without its `Query:` or `Indexation:` prefix. The page shows the label and the value, so a value that repeats the label reads twice. The script also removes a leading `<label>:` from a value when that label equals the row's label, ignoring case.

`wrong` and `improve` copy `## What Is Wrong` and `## What To Improve`. Each item copies its severity, its CLI ids (without backticks) into `ids`, and its affected URL or template into `affected`. `plan` copies the item's `Plan: P<n>` id in lowercase form, for example `p1`. The page links the item to that Plan entry. It is optional. `quote` stays on a content item that has one. A section whose text is `No confirmed issues found. Evidence limitation: ...` becomes `[]`.

`priority` copies `## Priority` in the same order. `title` must equal a `wrong` or `improve` title exactly. `action` is the lowercase Plan id of that item, for example `p1` for `P1`. The page links the priority title to that Plan entry.

`actions` copies `## Plan`, one object per entry, in the same order. `id` is the lowercase Plan id. `title`, `severity`, `phase`, `effort`, `impact`, `owner`, `source`, `location`, `why`, `fix`, and `fixKind` copy the matching field. `current` and `target` copy the two sides of `Current → target`. `decision` (optional) copies `Decision`, and `none` stays `none`. `dependsOn` copies `Depends on`, and `none` stays `none`. `example` is the body of the fenced block, without the fence lines, and an entry with `not needed.` leaves it empty. `verify` copies the `Verify` field.

`validation` copies `## Re-audit`, one object per checklist line. `command` is the command in backticks. `check` is the rest of the line, prefixed with the Plan id in lowercase form, with backticks removed. For example, a checklist line that names the command `searchunit audit ...` and the check `security:csp` is `pass` becomes the object `{ "command": "searchunit audit ...", "check": "p1: Check security:csp is pass." }`.

`checks` copies `## Checks`. One object per slug. `note` is optional and copies the Note cell. `examples` stays `[]`. Snippets sit in `actions[].example`, so the Examples card is omitted. `seo` on a sample row is the SEO score for that URL. `role` is `primary` or a context role.

`gsc.summary` is the window and property when Search Console was used, or the reason sentence ending with `Evidence limitation: insufficient.` when it was not. `queryPages` is the top 50 pairs and includes `position`. `strikingDistance` is the queries for the audited URL whose position is from 4 to 20 inclusive. `inspections` is one row per sample URL. `errors` is one row per slice that failed. An empty list stays `[]`.

`cuts` is the filled `Cuts:` line from [`cli-facts.md`](cli-facts.md).

`sample` lists every URL in `## Sample Coverage`. `status` comes from that URL's brief row. `sampleSentence` is the verbatim sample sentence.

`limits` is the six evidence-limit lines, in that order, as strings. `multimodal` is the Web: multimodal note. Omit `multimodal` when that note is absent. The method sentence in [`user-report.md`](user-report.md) stays in the markdown, after that note. Leave it out of this JSON.

Leave `measurement` and `reputation` unset. The page omits the measurement subheading only when `measurement` and `multimodal` are both empty. Empty here means null, omitted, or a blank string. When `multimodal` is present and `measurement` is null, the page keeps the measurement heading and the multimodal text, and it leaves out the measurement placeholder. An omitted key hides the same way as null. A key that carries content still renders, including the offline demo. The diagnosis stays a diagnosis.

`actions` and `validation` are required when the markdown has a `## Plan` and a `## Re-audit` with entries. Use `[]` when the Plan or the checklist is empty.

Step 2 does not reach this file when the CLI stdout is empty.

## Fill

`$SKILL` is the skill root. `$RUN` is the run directory. `$TEMPLATE` is the template path above.

```bash
node "$SKILL/scripts/fill-audit-html.mjs" \
  --template "$TEMPLATE" \
  --cli "$RUN/cli-audit.json" \
  --prose "$RUN/audit-prose.json" \
  --out "$RUN/audit-report.html"
```

The script exits 0 when `audit-report.html` contains the prose and the template markup. A missing slot, invalid JSON, an unknown prose key, or an incomplete item is a non-zero exit. The `--cli` file is required. A missing `--cli`, or a CLI file with no `command` or `scores` field, is also a non-zero exit.

The script checks these rules:

- Every `wrong`, `improve`, and `priority` item needs a non-empty `title` and `text`. `severity`, when present, is `critical`, `high`, `medium`, or `low`.
- Every `priority` title equals a `wrong` or `improve` title. A `priority.action` names an existing action id. A `plan` on a `wrong` or `improve` item names an existing action id. A `plan` on a `priority` item is rejected, because a priority item uses `action`.
- Every `actions` item needs `id`, `title`, `severity`, `phase`, `effort` (`S`, `M`, or `L`), `impact` (`high`, `medium`, or `low`), `owner` (`dev`, `content`, or `SEO`), `source`, `location`, `current`, `target`, `why`, `fix`, `fixKind`, and `verify`. `id` is lowercase letters, digits, and hyphens, and it is unique. `fixKind` is `markup`, `header`, `config`, `schema`, `content`, `gsc`, or `judgment`.
- An action with `fixKind` `markup`, `header`, `config`, or `schema` needs a non-empty `example`.
- Every `validation` item needs `command` and `check`.
- Every `checks` row needs `slug`, `result`, and `evidence`. Every `sample` row needs `url` and `role`.

Each item in `## What Is Wrong` and `## What To Improve` therefore has a sentence after its evidence label. Fix the prose file and run the script again. Leave the template unchanged.

## Open

After the script exits 0, open the HTML in the default browser. Use the opener that exists on this machine:

```bash
open "$RUN/audit-report.html"
```

When `open` is not a command, run `xdg-open` on the same path. When neither command exists, print the absolute path of `audit-report.html` and close the audit. The audit is closed when the opener exits 0, or when that path was printed.
