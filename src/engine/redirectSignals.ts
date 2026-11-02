export interface RedirectSignals {
  chain_length: number;
  http_to_https: boolean;
  www_normalized: boolean;
  redirect_chain: string[];
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isHttpToHttps(from: string, to: string): boolean {
  return parseUrl(from)?.protocol === 'http:' && parseUrl(to)?.protocol === 'https:';
}

/** Same host apart from a leading `www.`, and the `www.` side differs. */
function isWwwNormalized(originalUrl: string, finalUrl: string): boolean {
  const orig = parseUrl(originalUrl);
  const fin = parseUrl(finalUrl);

  if (!orig || !fin) {
    return false;
  }

  const origHost = orig.hostname.replace(/^www\./i, '');
  const finHost = fin.hostname.replace(/^www\./i, '');

  return (
    origHost === finHost && orig.hostname.startsWith('www.') !== fin.hostname.startsWith('www.')
  );
}

export function deriveRedirectSignals(
  originalUrl: string,
  finalUrl: string,
  redirectChain: string[],
): RedirectSignals {
  const chain = redirectChain.length > 0 ? redirectChain : [originalUrl, finalUrl];
  let http_to_https = isHttpToHttps(originalUrl, finalUrl);

  for (let i = 0; i < chain.length - 1; i++) {
    http_to_https ||= isHttpToHttps(chain[i]!, chain[i + 1]!);
  }

  return {
    chain_length: Math.max(0, chain.length - 1),
    http_to_https,
    www_normalized: isWwwNormalized(originalUrl, finalUrl),
    redirect_chain: chain.slice(0, 8),
  };
}
