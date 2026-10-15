# Security

## Reporting

Report a vulnerability to [security@searchunit.io](mailto:security@searchunit.io) or through [GitHub private security advisories](https://github.com/diegoos/searchunit-cli/security/advisories/new). Do not open a public issue for an unfixed vulnerability.

## What this CLI does

The CLI fetches the URL you pass, plus same-origin robots, sitemap, and llms.txt, and optional CrUX requests. Every hop goes through the SSRF checks in `src/ip-policy.ts` and the DNS pin in `src/lib/pinnedFetch.ts`. Private and link-local addresses are refused. Loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`) is fetched only when that host is the command target, and only on that port. A public URL cannot redirect the CLI onto loopback. CrUX is not queried for a loopback URL.

`gsc` calls Google through the `googleapis` client. Those calls do not use the DNS pin. The page URL is still refused when it is private, link-local, or has userinfo.

Response bodies are capped. The default is 2 MiB. `--max-bytes` and `max_body_bytes` can raise that up to 32 MiB. A body over the cap fails the fetch. The CLI does not return the truncated bytes.

## Secrets

Keep `crux_api_key` in `$HOME/.searchunit.yaml` or in `CRUX_API_KEY`. Keep `gsc_access_token` in `$HOME/.searchunit.yaml` or in `GSC_ACCESS_TOKEN`. Keep `gsc_credentials` in `$HOME/.searchunit.yaml` or in `GSC_CREDENTIALS`. That value is a path. The JSON key it points at holds a private key. Do not commit `.searchunit.yaml` or the JSON key. A project file cannot set those keys. The CLI does not print the CrUX key, the Search Console token, or the private key. It does print the quota project id and the credentials path.
