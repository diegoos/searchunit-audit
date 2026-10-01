# Security

## Reporting

Report a vulnerability to [security@searchunit.io](mailto:security@searchunit.io) or through [GitHub private security advisories](https://github.com/diegoos/searchunit-cli/security/advisories/new). Do not open a public issue for an unfixed vulnerability.

## What this CLI does

The CLI fetches the URL you pass, plus same-origin robots, sitemap, and llms.txt, and optional CrUX requests. Every hop goes through the SSRF checks in `src/ip-policy.ts` and the DNS pin in `src/lib/pinnedFetch.ts`. Private and link-local addresses are refused. Loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) is fetched only when that host is the command target, and only on that port. A public URL cannot redirect the CLI onto loopback. CrUX is not queried for a loopback URL.

Response bodies are capped. The default is 2 MiB. `--max-bytes` and `max_body_bytes` can raise that up to 32 MiB. A body over the cap fails the fetch. The CLI does not return the truncated bytes.

## Secrets

Keep `crux_api_key` in `$HOME/.searchunit.yaml` or in `CRUX_API_KEY`. Do not commit `.searchunit.yaml`. A project file cannot set that key.
