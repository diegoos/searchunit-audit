# Report prose

Read this before writing a sentence a person will read in `audit-report.md` or `audit-prose.json`. Headings stay the English headings in [`user-report.md`](user-report.md). Fixed captions in the HTML template stay English. The free sentences of the generated report use the user's language for this session.

The reader has one site in front of them. Each sentence adds a fact from this run: a URL, a number, a CLI id, or a passage from the page.

## Free sentences

What Is Wrong, What To Improve, and Priority each hold one cause per item. Two causes are two items. A content item puts the page passage in the quote, and the sentence says what is wrong with that passage.

Name the URL, the count, or the id the sentence depends on. Priority names the matching title and the id or number that puts it first.

A quote backs the claim next to it. The quoted passage must show that claim. When it does not, drop the quote or change the claim. A date, a time stamp, or a headline does not answer a question about what a page is for.

Plan fields are short. Write the current value and the target value as the page or the CLI states them, with the same nouns the CLI uses. Give a location as a URL plus a selector, element, template, or response header. A fix sentence names the change, not the reason for it.

Use is, has, shows, or blocks. Put a period, a comma, or parentheses between clauses. Use straight quotes around a passage.

A short sentence can sit next to a longer one. Stop when the fact is stated.

The evidence label stays the workstream label (`direct`, `lab`, `insufficient`, and the others in [`workstreams.md`](workstreams.md)). The words after the label are ordinary language.

If the reader could take the readiness number for visits, rank, or a citation count, say in that same sentence that the number comes from the HTML the server returned.

## Lines copied as written

Copy these as written. The rules above apply to the words you add around them, including the short note in brackets:

- `This report states no ranking, traffic, revenue, or citation outcome.`
- `URLs outside this sample were not read.`
- The method sentence in [`user-report.md`](user-report.md)
- The `Cuts:` line from [`cli-facts.md`](cli-facts.md)
- The brief `Previous run:` line
- The brief `Query:` line
- The brief `Indexation:` line
- The evidence-limit lines from the workstream returns
- `No confirmed issues found. Evidence limitation: [short note].`

## Before you save

Read the free sentences once. Remove a sentence that repeats the one before it. Remove a sentence about a tool the reader did not ask for, and keep the CLI id when that id is how they check the finding again.
