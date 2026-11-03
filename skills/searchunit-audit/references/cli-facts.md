# CLI facts

Read this at sample, before the commands. Copy these fields into the brief. Leave every score as printed. Lighthouse does not change `scores`.

The `--agent` report is the readiness record for this run. Judgment of the prose lives in [`workstreams.md`](workstreams.md).

## Audit level

`discovery.auditScope` declares the level of every run. `level` is `page` and `pagesScored` is 1. `contextFetches` counts the other requests: `robots`, `sitemapFiles`, `llmsTxt`, `crux`, `mobilePage`, and `linksProbed`. `robots`, `llmsTxt`, and `mobilePage` are true when the request was sent, also when it failed. `crux` is true only when the CrUX query completed. Those requests are evidence for the audited page. They do not make the run a site audit. The human report title is `Page Audit`.

## Scores

Copy from the primary `audit`:

- `scores.overall`, `scores.label`, `scores.confidence`, `scores.evidence_quality`
- `scores.breakdown`: `component`, `display_name`, `score`, `weight`, `evidence_type`
- `kindScores.overview`, `kindScores.seo`, `kindScores.geo`: `value` and `label`
- `blockers`: `id`, `component`, `cap`

Evidence labels for `evidence_type` and `evidence_quality` are mapped once, in [`workstreams.md`](workstreams.md) under Shared order.

Display names: AI citability, Content quality (E-E-A-T), Technical foundations, Structured data, Platform optimization.

The SEO kind uses content quality, technical foundations, and structured data. The GEO kind uses AI citability and platform optimization. Overview uses all five.

AI citability is the text score of the audited page (`citability.page_score`). Its evidence is `inferred`, so it stops at 85. Platform optimization reads crawler access, `llms_txt_status`, answer formats (question headings, FAQ, lists or tables, definitions), and entity signals (`sameAs`, author, visible dates). Its evidence is `inferred`. The two components do not add the same signal to the score. Crawler access feeds platform optimization, and blocker `live_retrieval_blocked` reads the same crawler access to cap AI citability. Freshness measures `dates.modified` against `fetchedAt` on the report root, not against the current clock. The same payload gives the same score.

A blocker is a cap the CLI already applied. Report the `id` and the `cap` with the finding. The overall stays the printed number. Without field Core Web Vitals, technical foundations is `N/A`, but its blockers (`noindex_or_error`, `no_https`, `oversized_html`) are still listed and still count for `--fail-on`. Their cap then changes no score. Report such a blocker as a finding, and say the component it caps is `N/A`. Blocker `csr_only_rendering` caps only the `ai_citability_visibility` component, so it lowers the GEO kind. It does not cap technical foundations or the SEO kind.

| id                       | cap |
| ------------------------ | --- |
| `noindex_or_error`       | 20  |
| `no_https`               | 40  |
| `poor_core_web_vitals`   | 50  |
| `csr_only_rendering`     | 40  |
| `oversized_html`         | 60  |
| `thin_content`           | 35  |
| `no_structured_data`     | 25  |
| `live_retrieval_blocked` | 30  |

`live_retrieval_blocked` fires only when every live retrieval bot in `crawlers` is `blocked`. A `restricted` bot does not count. The bots are listed below. The role of each bot is the catalog category on finding `crawlers:<bot>`. The detail of a bot in this set also says `live-retrieval gate`, for example `blocked, live-retrieval gate (training)`. The category stays the last word in parentheses.

`poor_core_web_vitals` needs URL-level CrUX with a `poor` metric. Origin-level CrUX still moves the technical score with evidence `indirect`, but it does not cap the page.

## Live retrieval bots

Name only these bots when you copy `live_retrieval_blocked`. `Claude-SearchBot` is not in this set. `ClaudeBot` is.

- `Googlebot`
- `Bingbot`
- `OAI-SearchBot`
- `ChatGPT-User`
- `ClaudeBot`
- `PerplexityBot`

## Page facts

On the primary `audit`, and on each `seo-check`, copy `discovery.auditedPage`:

- `url`, `statusCode`, `byteLength`, `redirectCount`
- `robotsStatus`: `present`, `missing`, or `error`. It is the robots.txt fetch status. `robotsFetchError` is the short code after retries when that status is `error` (`timeout`, `network`, `http_503`, ...), else null.
- `sitemapStatus`: `present`, `missing`, or `error`. It repeats `discovery.sitemap` for the page: `present` when `discovery.sitemap.present` is true, else the `error` or `missing` fetch status.
- `title`, `metaDescription`, `canonicalUrl`
- `robotsDirective`, `effectiveRobotsDirective`, `metaRobotsByBot`. `effectiveRobotsDirective` joins the meta robots and `X-Robots-Tag` tokens. A token that appears twice is kept once, compared without case, and the first order stays.
- `headings` (`h1`, `h1Count`, `h1ElementCount`, `h2`, `h3`, `h2Count`, `h3Count`)
- `viewport`, `hreflang`, `hreflangLinks`, `lang`, `wordCount`, `bodyWordCount`, `charset`
- `dates`, `author` (`hasAuthor`, `names`, `urls`), `images`, `discover`
- `contentSignals`, `citability`, `jsRenderingRisk`
- `structuredData`, `internalLinks`, `internalLinkCount`, `internalLinksTruncated`, `outboundLinks`, `outboundLinksTruncated`, `snippetDirectives`, `bodySha256`, `pageKind`, `siteType`
- `pagination` (`next`, `prev`)
- `headings.outline`, `mixedContent`, `hiddenText`, `trustPages`, `externalResources`
- `hasSpeakable`
- `mainText`, `mainTextTruncated`, `tables`

`pageKind` is `home`, `article`, `product`, `listing`, `profile`, or `Undefined`. It is on `discovery` and on `auditedPage`. `home` means the final URL path is `/` with no query, and no product, article, profile, or listing type matched. `og:type` `website` alone does not make a page `home`. `listing` also matches a page that is not the root and has `contentSignals.listingPattern` true, for example `/noticias/`.

`siteType` is `saas`, `ecommerce`, `local-business`, `publisher`, or `Undefined`. It is on `discovery` and on `auditedPage`.

`headings.h1` is the list of H1 texts, usually one. On `audit`, `headings.h2` and `headings.h3` are every non-empty heading. On `seo-check` and `geo-check` those lists stop at 40. `h2Count` and `h3Count` stay counts. `contentSignals.question_heading_count` is the CLI count. A heading past a `seo-check` cap stays unjudged. Say the payload cut it. Do not fetch the page again.

`hreflang` stays a string array. `hreflangLinks` is `{ lang, href }[]`.

`headings.outline` lists H1 to H6 in document order as `{ level, text }`, at most 60. Finding `content:heading-order` names the first skipped level, for example H1 then H3.

`wordCount` counts words in the main content root: the first `main` or `[role=main]`, else every `article`, else `body` without `header`, `nav`, `footer`, `aside`, `[role=navigation]`, `[role=banner]`, and `[role=contentinfo]`. `bodyWordCount` counts the whole visible body. `thin_content`, the CSR check, citability blocks, and `citability.opening` use the main content root.

`mainText` is the full text of the main content root, with a space between blocks and table cells, cut at 20000 characters. `mainTextTruncated` is true past that cut. `tables` holds up to 5 tables from the same root, each up to 30 rows of up to 10 cell texts (200 characters each). Read `mainText` and `tables` for any judgment of the body. Quote from them when a passage is not in the citability blocks.

`mixedContent` is `{ activeCount, passiveCount, samples }`. Active is an `http:` script, stylesheet, iframe, object, or embed on an `https:` page. Passive is an `http:` image, source, video, audio, or video `poster`. `samples` holds up to 10 URLs.

`hiddenText` is `{ elementCount, samples }`: elements outside nav, header, footer, dialogs, menus, `template`, and `noscript`, hidden by inline `display:none`, `visibility:hidden`, or the `hidden` attribute, that hold 50 or more characters. Class-based CSS is not visible in static HTML, so the count is a lower bound. Tabs and accordions are a common legitimate cause. Quote a sample before you call it spam.

`charset` is `<meta charset>` or the http-equiv charset, lowercase, or null. Finding `meta:charset` also reads the `Content-Type` header.

`trustPages` is `{ about, contact, privacy, terms }`: the first same-site link for each, from every anchor on the page. A link matches when one URL path segment is a label, for example `/sobre-nos`, `/contato`, or `/politica-de-privacidade`. A link also matches when its whole anchor text is a label, ignoring case, accents, and punctuation, for example `Sobre`. A headline that only contains a label word does not match. A null value means no such link on the audited page.

`externalResources` lists the cross-origin origins of the page, sorted, at most 30 per kind. `scripts` comes from `script[src]`. `stylesheets` comes from `link[rel=stylesheet]`. `frames` comes from `iframe[src]`. `images` comes from `img` `src` and `srcset`, and `source` `srcset`. `fonts` comes from `link[rel=preload][as=font]`. `media` comes from `video` and `audio` sources. `forms` comes from `form[action]`. `inlineScripts` counts `<script>` blocks without `src` that run as JavaScript. `inlineStyles` counts `<style>` blocks. Use these for a CSP review. The finding `security:content-security-policy` repeats them when CSP is missing.

`sameHostResources` lists up to 30 same-site URLs from `script[src]` and `link[rel=stylesheet]`. Finding `robots:blocked-resources` reads that list.

`hasSpeakable` is true when a JSON-LD node has a `Speakable` type, on the page node, in `@graph`, or nested. `contentSignals.listingPattern` is true when the page has four or more `article` or card-like blocks, or 15 or more links inside `main`.

`internalLinks` holds at most 50 same-host links from that page. Each item is `{ href, text, ariaLabel, imgAlt }`. `text` is the anchor, whitespace collapsed, at most 160 characters. `ariaLabel` is the anchor `aria-label`, trimmed, or null. `imgAlt` is the first non-empty `alt` of an `img` inside the anchor, or null. An icon link with an `aria-label` or an image alt has a name, even when `text` is empty. `internalLinkCount` is the count of unique hrefs. `internalLinksTruncated` is true when the page has more same-host links than that list. `outboundLinks` holds at most 40 links whose host is not the page host, with the same shape. `outboundLinksTruncated` is true past that cap. `internalLinkIndex` holds the page key of every same-host link, built before the 50-link cap, up to 2000. `internalLinkIndexTruncated` is true past 2000. A URL missing only from the 50-link list is not an orphan. Membership uses `pageKey`.

`pageKey` is lowercase host, no leading `www`, the port when it is not the scheme default (`localhost:8765` keeps `:8765`), and no trailing slash, except the root path, which keeps `/` (`example.com/`). It drops `utm_*`, `gclid`, and `fbclid`. Every other query parameter stays. The parameters are sorted by name, then by value, and encoded again. `https://www.example.com/a/?utm_source=x` and `https://example.com/a` share the key `example.com/a`. `https://example.com/a?id=1` is `example.com/a?id=1`.

`images` keeps `total`, `withAlt`, `decorative`, and `missingAlt`. `withAlt` counts images with an `alt` attribute, empty or not. `decorative` counts `alt=""`. `missingAlt` counts images with no `alt` attribute. A lazy image with only `data-src` or `data-lazy-src` counts. `images.items` holds up to 40 `{ src, alt, width, height, srcset, loading, fetchPriority }`. `fetchPriority` is the `fetchpriority` attribute as written, or null. `alt: null` means the attribute is missing. `alt: ""` means an empty attribute. `width`, `height`, `srcset`, and `loading` are the attribute strings, or null. `srcset` stops at 240 characters. An image past the cap of 40 stays unjudged. Say the payload cut it. Do not fetch the page again.

`wordCount` bands are under 120, 120–299, 300–799, and 800 or more. Under 120 is the `thin_content` cap. `dates.modified` bands are a future date (`content:date-sanity` allows one day of clock skew; the freshness score does not), 0–90 days, 91–180 days, 181–365 days, and older than 365 days. A missing or unparseable date stays on `freshness-dates`. These bands explain the content score. They do not replace it.

`structuredData.types` lists JSON-LD types. Each `blocks` entry has `type`, `name`, `hasRequiredProps`, `missingProps`, `recommendedMissing`, `sameAs`, `id`, `headline`, `price`, `availability`, and `referencedIds`. `missingProps` lists required property names absent from both the typed node and the script root. `hasRequiredProps` is true when that list is empty. `recommendedMissing` lists the recommended property names for that type that are also absent. It does not change `hasRequiredProps` or any score. `hasGraph` is true when the CLI saw `@graph` or `@id`. `price` and `availability` may come from the node or from `offers` (an object, or the first item of an array). A value the payload cuts stays unjudged. Say the payload cut it. Do not fetch the page again.

`markupFormats.microdata_types` and `markupFormats.rdfa_types` list up to 20 schema.org type names each. `jsonld_blocks_missing_type` counts JSON-LD blocks with no `@type`.

`snippetDirectives` holds `nosnippet`, `maxSnippet`, `noarchive`, `unavailableAfter`, and `dataNosnippet`. It reads the robots meta and `metaRobotsByBot`. `dataNosnippet` is true when any element has `data-nosnippet`. `securityHeaders.x_robots_tag` can carry the same tokens. Read that string too.

`bodySha256` is the hex SHA-256 of the audited HTML string, encoded as UTF-8. It is byte-level: a nonce, a CSRF token, or a timestamp in the HTML changes it on each request. Use `visibleTextSha256` to compare runs. Scoring does not read either hash. The mobile snapshot is not part of this hash.

`author.urls` lists up to five http(s) author URLs from JSON-LD `author.url`, `author.@id`, and `rel="author"`. An off-host URL stays text. The first same-host URL is the `author` context role.

`pagination.next` and `pagination.prev` are the resolved `link rel="next"` and `link rel="prev"` (or `previous`) hrefs. A non-http href is null.

`breadcrumbParent` is the URL of the breadcrumb item before the last `BreadcrumbList` item. No list, or a list of one item, is null.

`social.openGraph.title` is the `og:title` string. `social.openGraph.description` is the `og:description` string. It does not fill `metaDescription`. `social.openGraph.image` is the resolved `og:image` URL. `social.openGraph.type` is the `og:type` string. `social.openGraph.url` is the resolved `og:url`. `social.openGraph.locale` is `og:locale`. It does not fill `lang`. `lang` is the `<html lang>` value. `social.twitter.card` is the `twitter:card` string. A missing tag is null.

`dates.visible` is the first `<time datetime>` inside `main`, `article`, or `[role=main]`, or the first `<time>` text there. Without such a time, it is the first `<time>` on the page, or null. A sidebar date does not win over an article date. `headerCanonical` and `headerHreflang` come from the HTTP `Link` header. `robotsNoindexSource` is `meta`, `header`, `bot`, or null. `videos` lists up to 10 `{ src, poster }` from `<video>` and YouTube or Vimeo iframes. `structuredData.faqPairs` lists up to 12 `{ question, answer }`. `citability.opening` is the first paragraph, capped at 600 characters, including a short opening the score skips. `images.items[].nearby` is the figcaption or the next element's text. `images.items[].hero` is true for the first image in `main`, `article`, or `[role=main]`. A `header` image counts only when the page has none of those regions. An image whose class, id, alt, or src says logo, brand, icon, or avatar, or that sits in `nav` or in a link to `/`, is never the hero. A same-site link keeps its `www` host in `href` and still enters `internalLinkIndex`. `headings.h2NonEmpty` and `h3NonEmpty` count headings that have text.

`visibleTextSha256` is the SHA-256 of the visible text after whitespace collapses. `visibleTextExcerpt` is the first 240 characters of that text. `discovery.mobilePage` carries the same two fields for the mobile GET. Scoring does not read them.

`citability.page_score`, `citation_ready_blocks`, and `ideal_range_blocks` are readiness counts. Those counts use every scored block. `citation_ready` on a block means the CLI marked that block ready. `blocks` holds the highest scoring blocks, at most 12, highest score first. `weakBlocks` holds the lowest scoring blocks that are not already in `blocks`, at most 12, lowest score first. On `audit`, `text` is the full block text. On `seo-check` and `geo-check`, that text is capped at 1500 characters. `text_preview` stays. `blocksTruncated` is true when a scored block is in neither list. When a quote needs text past a cap, or a block neither list kept, say the payload cut it. Do not fetch the page again. Quote the audited page from the `audit` text. A replacement example quotes `weakBlocks` when that list has a block, otherwise the lowest block in `blocks`, which is the last entry.

`contentSignals` holds paragraph, list, table, summary, FAQ, definition, and statistic counts. `hasFaqPattern` is true for FAQPage microdata, or for an FAQ heading that has at least one question heading in the same page. `hasTopSummary` and `citability.opening` skip a leading byline or date line. A byline stays an author signal for E-E-A-T, and it is never the answer. The sentence judgment is separate.

`discover.maxImagePreviewLarge` is true when the robots meta names `max-image-preview:large`. `discover.hasRepresentativeImage` is true when `og:image` has content or a `link rel="image_src"` is present.

`jsRenderingRisk.isLikelyCsr` is true when `wordCount` is under 120, the HTML has an SPA root (`#root`, `#__next`, `[data-reactroot]`, or `#app`), and the page has 5 or more `<script>` elements. `reason` is `low_word_count_with_spa_root_and_many_scripts` in that case, and null otherwise.

## Render and loopback HTTPS

`discovery.renderedPage` is the Chrome render of the audited page. It comes from the primary `audit` only, and it runs with the Lighthouse trigger (`--agent`, `--format json`, or a `.json` `-o`). `status` is `ok`, `skipped`, or `error`. `reason` is `null` when status is `ok`. Otherwise it is `not-requested`, `chrome-missing`, `timeout`, `too_large`, or `error`. When status is `ok`, it holds `title`, `metaDescription`, `canonicalUrl`, `effectiveRobotsDirective`, `h1`, `wordCount`, `mainText` (cut at 20000 characters, `mainTextTruncated` marks the cut), `structuredDataTypes`, `internalLinkCount`, `hreflang`, and `visibleTextSha256`. Quote `mainText` for rendered text. `install` is `Install Google Chrome, or set CHROME_PATH` when `reason` is `chrome-missing`, and `null` otherwise. `linksOnlyAfterRender` lists up to 20 `pageKey`s of internal links that appear only in the render, and `linksOnlyAfterRenderCount` is their count. Both are `null` when status is not `ok`.

Finding `discovery:render` compares the render with the raw HTML. A `noindex` on one side only, or a canonical with another `pageKey`, is `fail`. A canonical only in the render, a changed title, H1, or meta description, a schema type only in the render, a raw `wordCount` under half the rendered count, or internal links only in the render above 20% are `warn`. The 20% is `linksOnlyAfterRenderCount` over the rendered `internalLinkCount` (unique hrefs), and the share must be above 20%. The detail names up to five of `linksOnlyAfterRender`. One swapped link is a warning only when the render has 4 or fewer internal links. With 5 or more, `discovery:render` can pass while `linksOnlyAfterRenderCount` is above 0, so read that count too. A skipped or error render is `info` with the reason. Finding `robots:blocked-resources` is `warn` when a script or stylesheet on the audited origin (same host and port) is `blocked` or `restricted` for Googlebot. Both map to `js-rendering`.

`discovery.httpsReadiness` is set only on a loopback URL: `{ insecureSubresources: string[], insecureUrls: { field, url }[], devHostUrls: { field, url }[] }`, up to 10 entries per list. It is `null` off loopback. On loopback, finding `discovery:https` is `pass`, `info`, or `warn`. HSTS is not judged on loopback: finding `security:strict-transport-security` is `info`.

## Origin facts

Stay on the primary `audit`:

- `discovery.auditedUrl` is the final URL of the audited page after redirects. `discovery.domain` is its hostname without a leading `www`. `discovery.technicalUrls` is a one-entry list with that final URL.
- `discovery.crawlerAccess.crawlers`: `bot`, `status`. The catalog includes `Claude-SearchBot`. `status` is `allowed`, `restricted`, or `blocked`. `blocked` means the longest matching rule for the audited path is a site-wide `Disallow` (`/`). `restricted` means the longest matching rule is a narrower `Disallow`, so only part of the path is closed. An equal-length `Allow` wins. Finding `crawlers:<bot>` is `fail` for `blocked` and `warn` for `restricted`. The crawler score for a bot is 100 when `allowed`, 45 when `restricted`, and 0 when `blocked`. Finding `discovery:search-crawlers` fails only when Googlebot or Bingbot is `blocked`. A `restricted` search bot is `pass` there. `sitemaps` lists sitemap file URLs. `wildcardRules` is `{ allow, disallow }` for `User-agent: *`. Treat `allow` and `disallow` as path lists.
- `discovery.sitemap`: `present`, `fetchStatus`, `url_count`, `audited_url_listed`, `audited_url_lastmod`, `urls`, `urlsTruncated`, `coverage`, `filesRead`. The CLI reads up to 5 declared sitemaps (every robots `Sitemap:` line, then HTML hints, else `/sitemap.xml`). It follows index children and nested indexes, up to 25 files in total. `audited_url_listed` matches on `pageKey`, so `/page?id=1` is not `/page`. `coverage` is `complete` when every file was read, and `partial` when a file failed or the 25-file cap stopped the walk. `filesRead` counts the files read. `urls` holds up to 200 `{ loc, lastmod }`. The first locs are one URL per template class, in order: commercial, article, category, about, contact, then the latest `lastmod`. After those, short paths and institutional paths, then file order. `urlsTruncated` is true when `url_count` is greater than the slice, or when `coverage` is `partial`.
- `discovery.llmsTxt`, `discovery.llms_txt_status`. `links` holds up to 100 `{ title, url }`. `linksTruncated` is true when the file has more links than that slice. `linksToAuditedUrl` is true when any link matches the audited page before that cap. `content` and `full_content` stay null. Use `has_title`, `has_links`, `link_count`, and `fetchStatus`. When `fetchStatus` is `error`, `fetchError` is the short code after retries.
- Template class of a URL, used by the `sibling` role. The first path segment in this list sets the class, in path order. `commercial`: `product`, `products`, `shop`, `store`, `pricing`, `checkout`, `cart`, `produto`, `produtos`, `loja`, `sku`. `article`: `blog`, `news`, `article`, `articles`, `post`, `posts`, `story`, `noticia`, `noticias`, `journal`. `category`: `category`, `categories`, `collection`, `collections`, `tag`, `tags`, `categoria`, `categorias`, `catalog`, `catalogue`. `about`: `about`, `about-us`, `sobre`, `quem-somos`. `contact`: `contact`, `contact-us`, `contato`, `fale-conosco`. A URL with none of these segments has no class.
- `discovery.mobilePage`: null, or `statusCode`, `byteLength`, `wordCount`, `h1`, `jsRenderingRisk`, `canonicalUrl`, `effectiveRobotsDirective`, `viewport`, `structuredDataTypes`, `internalLinkCount`, `visibleTextSha256`, `visibleTextExcerpt`. There is no second raw HTML. A failed second GET is null, and `discovery.mobileFetchError` names the fetch error code. `pagesSampled` stays 1. `mobilePage` is not an extra sample URL. Finding `discovery:mobile` compares it with the desktop page: a mobile `noindex`, a different canonical `pageKey`, or a different status is `fail`; a missing viewport, a different H1, or different visible text is `warn`.
- `discovery.linkStatus` (primary `audit` only): `status` is `completed` or `skipped`. `checked` counts the probes in `results`. `candidates` counts the internal links on the page. `results` holds `{ href, scope, status, finalUrl, redirects, error }` for the first 25 same-site links on the audited page, in page order. Outbound links are never requested. `status` is the final HTTP status, or null with an `error` code. A link to the audited page itself is skipped. `seo-check` and `geo-check` report `skipped`.
- `discovery.securityHeaders`: `hsts`, `csp`, `x_frame`, `x_content_type`, and `referrer_policy` are presence booleans. `x_robots_tag`, `permissions_policy`, `cross_origin_opener_policy`, `cross_origin_embedder_policy`, and `cross_origin_resource_policy` hold the raw header value, or null when the header is absent. The four advisory headers do not move the score. Findings `security:<id>` judge them. Quote the field for `current`.
- `discovery.redirects`
- `discovery.crux`
- `discovery.platform_signals`: `visible_dates` is true when a meta or JSON-LD date exists, or when `dates.visible` exists.
- `googleProfile` on the report root
- `lighthouse` on the primary `audit` report root
- `findings`, `seo.findings`, `geo.findings`

`lighthouse` exists only on the primary `audit`. `seo-check` and `geo-check` omit it. `status` is `ok`, `skipped`, or `error`. When `status` is `skipped`, `reason` is `not-requested`, `binary-missing`, or `chrome-missing`. When `status` is `error`, `reason` is `timeout` or `error`. `install` is `npm install -g lighthouse` when `reason` is `binary-missing`, `Install Google Chrome, or set CHROME_PATH` when it is `chrome-missing`, and `null` otherwise. The CLI never installs anything. The CLI retries the lab once after a crash (non-zero exit with no report). `formFactor` is `mobile`. `metrics` includes `lcpMs`, `cls`, `tbtMs`, `fcpMs`, and `inpMs` only when the lab returned that metric. `failedAudits` holds at most 30 failed audits per category, read from `performance`, `seo`, and `best-practices`. Each entry is `{ id, category, title, score, displayValue, items }`. `items` holds at most 10 rows. A row has `url`, `node` (`selector`, `snippet` capped at 200 characters, `nodeLabel`), `wastedMs`, `wastedBytes`, `totalBytes`, and `totalMs` (the `total` of a bootup-time row). A row with neither a URL nor a node is dropped. `score` is null only for `largest-contentful-paint-element`, which the CLI keeps when Lighthouse names an element. There is no category score. TBT is the lab blocking-time metric. A lab `inpMs` appears only when Lighthouse measured an interaction, which a plain page load rarely does. Field INP comes from CrUX. The lab run returns no rendered text. Rendered text comes from `discovery.renderedPage.mainText`. Lab stays outside CrUX and outside the readiness score.

`seo-check` and `geo-check` return `[]` for `discovery.sitemap.urls` and `discovery.llmsTxt.links`. They keep `urlsTruncated` and `linksTruncated`. The page list and the llms link list stay on the primary `audit`. A `seo-check` `scores.overall` is that page's SEO kind score. It does not replace the primary `audit` scores.

Finding severity is `fail`, `warn`, `pass`, or `info`. A `fail` or `warn` in a workstream's scope becomes a finding, a merged finding, or a dismissed note that cites the field.

`cruxApiKeyAvailable` false means field speed is `insufficient`. A loopback URL keeps `cruxApiKeyAvailable` true but skips the query, so `discovery.crux.status` is `skipped` and field speed is `insufficient` in both cases. CLI `evidence_type` `indirect` on origin CrUX is the finding label `proxy`. Copy `indirect` in the score table.

`scores.confidence` stays in the copied table. The report `Confidence:` line is the sample reading: how much was read, how recent the data is, and whether the main evidence is direct.

The default body cap is 2 MiB (2097152 bytes). A larger body is a fetch error and stdout is empty. Blocker `oversized_html` appears when the fetched `byteLength` is above 2 MiB and the fetch cap was raised above that. A body the fetch refused does not reach the score.

Length bands and crawler roles are judged in [`workstreams.md`](workstreams.md). Copy the CLI check status beside that judgment.

## Page check findings

These finding ids are deterministic checks of the audited page. Each `fail` or `warn` goes to the slug in the right column. `discovery:` ids feed `--fail-on`.

| finding id                             | slug                                        |
| -------------------------------------- | ------------------------------------------- |
| `discovery:search-crawlers`            | `http-status-robots`                        |
| `discovery:https`                      | `https`                                     |
| `discovery:render`                     | `js-rendering`                              |
| `discovery:robots`                     | `http-status-robots`                        |
| `discovery:mobile`                     | `mobile-parity`                             |
| `discovery:redirects`                  | `redirects`                                 |
| `discovery:sitemap`                    | `sitemap-url`                               |
| `discovery:llms`                       | `llms-txt`                                  |
| `meta:title`                           | `title-length-uniqueness`                   |
| `meta:description`                     | `meta-length-uniqueness`                    |
| `meta:canonical`                       | `canonical`                                 |
| `meta:header-canonical`                | `canonical`                                 |
| `meta:og_url`                          | `canonical`                                 |
| `meta:robots_meta`                     | `http-status-robots`                        |
| `meta:snippet-limits`                  | `http-status-robots`                        |
| `meta:viewport`                        | `viewport`                                  |
| `meta:lang`                            | `html-lang`                                 |
| `meta:charset`                         | `html-bytes`                                |
| `meta:hreflang`                        | `hreflang`                                  |
| `meta:og_*`, `meta:twitter_*`          | `social-tags`                               |
| `meta:og-image-hero`                   | `social-tags`                               |
| `content:soft-404`                     | `http-status-robots`                        |
| `content:url-structure`                | `url-structure`                             |
| `content:h1`                           | `h1-text`                                   |
| `content:heading-order`                | `heading-hierarchy`                         |
| `content:image-alt`                    | `image-alt`                                 |
| `content:hero-image`                   | `image-alt`                                 |
| `content:mixed-content`                | `https`                                     |
| `content:hidden-text`                  | `hidden-text`                               |
| `content:prompt-injection`             | `hidden-text`                               |
| `content:author`                       | `expertise`                                 |
| `content:dates`, `content:date-sanity` | `freshness-dates`                           |
| `content:trust-pages`                  | `site-identity`                             |
| `links:status`                         | `internal-links`                            |
| `links:redirects`                      | `internal-links`                            |
| `links:anchor-text`                    | `internal-links`                            |
| `robots:blocked-resources`             | `js-rendering`                              |
| `robots:*`                             | `http-status-robots`                        |
| `schema:*`                             | `schema-inventory`, `schema-visible-fields` |
| `security:*`                           | `iframe-header`                             |
| `discover:*`                           | `discover-editorial`                        |
| `crawlers:*`                           | `crawler-access`                            |
| `llms:*`, `llms-full:*`                | `llms-txt`                                  |
| `citability:*`                         | `citability-answer-block`                   |
| `platform:*`, `speakable:*`            | `platform-aio`                              |
| `blocker:noindex_or_error`             | `http-status-robots`                        |
| `blocker:no_https`                     | `https`                                     |
| `blocker:poor_core_web_vitals`         | `crux`                                      |
| `blocker:csr_only_rendering`           | `js-rendering`                              |
| `blocker:oversized_html`               | `html-bytes`                                |
| `blocker:thin_content`                 | `thin-pages`                                |
| `blocker:no_structured_data`           | `schema-inventory`                          |
| `blocker:live_retrieval_blocked`       | `crawler-access`                            |

`content:prompt-injection` warns when page text addresses an AI reader (an instruction override, a role prompt, a chat-template token, a pipe-to-shell command) or holds invisible characters: every Unicode format character (category Cf: soft hyphen, zero-width and joiner characters, bidi controls, the BOM, tags, and others), the combining grapheme joiner, Hangul fillers, variation selectors, and the line and paragraph separators. `INVISIBLE_FORMAT` in `src/lib/invisibleText.ts` is the list. It reads every string, and every key, of the whole discovery bundle — page fields, headers, robots rules, sitemap and redirect URLs, the rendered and mobile snapshots, and `llmsTxt`. That covers page text, the three hidden-text samples, alt and link text, `aria-label`, schema types, FAQ questions and answers, `llms.txt` lines, and any site-controlled string the payload carries. For invisible characters, the detail names the fields that hold them, not a character count. The detail quotes up to three passages as data. The score does not change. In the `--agent` markdown, every string value is a JSON string literal after a data notice, and a key from the page (a `metaRobotsByBot` bot name) is quoted too. The `--agent` markdown, the JSON stdout, and the `.json` file all remove invisible format characters and C1 controls. The finding still counts the invisible characters. Text the finding does not read is still untrusted.

`content:soft-404` reads the title segments (split at `-`, `|`, `–`, and `—`, not at a colon) and each H1. A segment or H1 of at most five words matches when it starts with `404`, `erro 404`, or `error 404`, or holds a not-found phrase (`not found`, `página não encontrada`, `page not found`, `não existe`). That branch also needs `wordCount` under 300. So `404 - Página não encontrada` matches, and `Erro 404: como corrigir no WordPress` does not. The short main text branch (under 50 words) is unchanged.

`links:anchor-text` warns on generic anchor text and on an anchor with no visible text, no `aria-label`, and no non-empty image alt. An unnamed anchor appears as `(no text) → href`. The detail lists up to 20 hrefs, then `(+N more)`.

`content:hero-image` uses the hero image in `images.items`. It warns when that image has `loading="lazy"` or no `fetchpriority="high"`. It passes when the hero is eager and high-priority. It has no finding when the page has no hero image.

`meta:og-image-hero` warns when a segment or file-name part of the `og:image` path is `logo`, `icon`, `icons`, or `favicon` (`site-logo.png`, `/icons/share.png`, not `iconic.jpg`), and the page has a hero image. The detail names both URLs. It has no finding for any other `og:image`.

`security:content-security-policy` detail says `missing` when no CSP header exists. With only `Content-Security-Policy-Report-Only`, the finding is `warn` and the detail is that policy. It then adds `external origins:` with each kind and its origins, `none` when there are none, then `inline scripts` and `inline styles` counts.

`llmsTxt.issues` is a list of `{ code, line, text }`. A structural issue has `code` `missing_title`, `missing_sections`, `missing_links`, `http_status` (with the status in `text`), or a fetch error code, and `line` is null. A syntax issue copies the parser code, for example `invalid_list_link` or `blockquote_outside`. Its `line` is the 1-based line, and `text` is the line snippet, at most 120 characters, or null.

## Payload cuts

Copy this line into the report. A flag on any sampled payload makes that token `truncated`. Otherwise the token is `complete`. `lighthouse` and `render` use the primary `audit` only.

```txt
Cuts: main <truncated|complete>. sitemap <truncated|complete>. links <truncated|complete>. outbound <truncated|complete>. headings <truncated|complete>. images <truncated|complete>. citability <truncated|complete>. llms <truncated|complete>. render <ok|skipped <reason>|error <reason>>. lighthouse <ok|skipped <reason>|error <reason>>.
```

- main: `auditedPage.mainTextTruncated`
- sitemap: `discovery.sitemap.urlsTruncated`
- links: `internalLinksTruncated`
- outbound: `outboundLinksTruncated`
- headings: `headings.h2NonEmpty` greater than `headings.h2.length`, or `headings.h3NonEmpty` greater than `headings.h3.length`. An empty heading is not a cut.
- images: `images.total` greater than `images.items.length`
- citability: `citability.blocksTruncated`
- llms: `llmsTxt.linksTruncated`. `linksToAuditedUrl` stays a separate check.
- render: `discovery.renderedPage.status`. When status is `skipped` or `error`, append `reason`.
- lighthouse: `lighthouse.status`. When status is `skipped` or `error`, append `reason`.
