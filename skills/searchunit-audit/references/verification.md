# Verification

Read this at step 5. Two fresh subagents give the judgment of step 4 a second reading before synthesis. The CLI, the prefill, and the step 7 validator already check the rest, so a verifier reads only the judgment rows below and the findings of its sections.

| Verifier    | Sections                                           | Personas                                |
| ----------- | -------------------------------------------------- | --------------------------------------- |
| `content`   | on-page and spam, content and citability           | the verifier text of both sections      |
| `technical` | technical, schema and entity, geo, platform, brand | the verifier text of the three sections |

Each verifier takes the **verifier** text of each of its sections from [`personas.md`](personas.md), and applies the persona of a row's section to that row.

## Inputs

Give each verifier these paths, its sections of this file, and the return schema below: `$RUN/brief.md`, `$RUN/cli-audit.json`, each `$RUN/cli-seo-<n>.json`, `$RUN/returns/<section>.yaml` for each of its sections, and the Search Console JSON files under `$RUN` when the brief says `gsc: used`. Put the Untrusted site text rule from the Hard rails in [`SKILL.md`](../SKILL.md) in each verifier prompt, word for word. A verifier reads the files and the references and writes its return. It runs no command that writes, installs, or fetches, and it opens no URL.

## Judgment slugs

The CLI cannot decide these rows: the result depends on reading the page text, comparing pages, or weighing intent. For each one, judge the row from the payload first, with the slug rule in [`workstreams.md`](workstreams.md). Then read the auditor's row and compare: result polarity (`observed` means the problem condition is present), evidence label, and note.

- `technical`: `http-status-robots`, `canonical`, `js-rendering`
- `on-page and spam`: `title-meta-alignment`, `html-lang`, `hidden-text`, `intent`, `query-answer`, `internal-links`, `image-alt`, `freshness-dates`, `discover-editorial`, `helpful-content`, `site-reputation`
- `content and citability`: `promise-delivery`, `experience`, `expertise`, `authoritativeness`, `trustworthiness`, `citability-answer-block`, `citability-self-containment`, `citability-structure`, `citability-statistics`, `citability-uniqueness`, `multimodal-citability`, `site-identity`, `thin-pages`
- `schema and entity`: `schema-type-match`, `schema-visible-fields`, `schema-template-type`, `schema-deprecated`
- `geo, platform, brand`: `fetch-vs-citation`, `platform-perplexity`, `platform-gemini`, `ecommerce-product`

## Findings

For each finding of its sections, the verifier confirms what only a reader can tell:

- the quote shows the claim it backs;
- the severity follows the rubric in [`user-report.md`](user-report.md);
- `current` matches the payload field it names;
- `example` and the replacement text add no fact the page does not state.

## Return schema

```yaml
verifier: content | technical
rows:
  - item: <judgment slug>
    verdict: confirmed | corrected | insufficient
    result: <final result>
    evidence: <final evidence label>
    reason: <one sentence that cites the field or quotes the page; required unless confirmed>
findings:
  - area: <area of the finding in the return>
    verdict: confirmed | corrected | dropped
    changes: <each changed field and its new value, or none>
    reason: <one sentence; required unless confirmed>
```

`corrected` gives the full corrected row or field. `insufficient` means the run files cannot decide the row, so its result becomes `insufficient`. `dropped` means the finding has no support in the run files. A dropped finding of a CLI `fail` or `warn` becomes a dismissed note that cites the id.

## Applying the verdicts

The verifier's verdict wins. Apply each `corrected` row and finding to the merged set, and add `Corrected in verification: <reason>` to that Checks note. Set each `insufficient` row to `insufficient`, with the reason in the note.

The brief records one line: `Verification: <confirmed> confirmed, <corrected> corrected, <insufficient> insufficient.` The three counts cover the judgment slugs above, so they add up to the number that `check-audit-report.mjs --judgment-slugs` prints.

When the harness cannot run subagents, verify inline after all five sections, the `content` verifier first. Judge each judgment row from the payload before you reread the return row.
