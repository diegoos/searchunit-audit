# Security

## Reporting

Report a vulnerability to [security@searchunit.io](mailto:security@searchunit.io) or through [GitHub private security advisories](https://github.com/diegoos/searchunit-cli/security/advisories/new). Do not open a public issue for an unfixed vulnerability.

## What this CLI does

The CLI fetches the public URL you pass, plus same-origin robots, sitemap, and llms.txt, and optional CrUX requests. Every hop goes through the SSRF checks in `src/ip-policy.ts` and the DNS pin in `src/lib/pinnedFetch.ts`. Private, loopback, and link-local addresses are refused.

Response bodies are capped. The default is 2 MiB. `--max-bytes` and `max_body_bytes` can raise that up to 32 MiB. A body over the cap fails the fetch. The CLI does not return the truncated bytes.

## Secrets

Keep `crux_api_key` in `$HOME/.searchunit.yaml` or in `CRUX_API_KEY`. Do not commit `.searchunit.yaml`. A project file cannot set that key.
