export interface RedirectSignals {
  chain_length: number;
  http_to_https: boolean;
  www_normalized: boolean;
  redirect_chain: string[];
}

export function deriveRedirectSignals(
  originalUrl: string,
  finalUrl: string,
  redirectChain: string[],
): RedirectSignals {
  const chain = redirectChain.length > 0 ? redirectChain : [originalUrl, finalUrl];
  let http_to_https = false;
  let www_normalized = false;

  try {
    const orig = new URL(originalUrl);
    const fin = new URL(finalUrl);

    http_to_https = orig.protocol === 'http:' && fin.protocol === 'https:';
    const origHost = orig.hostname.replace(/^www\./i, '');
    const finHost = fin.hostname.replace(/^www\./i, '');

    www_normalized =
      origHost === finHost && orig.hostname.startsWith('www.') !== fin.hostname.startsWith('www.');
  } catch {
    // leave flags false
  }

  for (let i = 0; i < chain.length - 1; i++) {
    try {
      const a = new URL(chain[i]!);
      const b = new URL(chain[i + 1]!);

      if (a.protocol === 'http:' && b.protocol === 'https:') {
        http_to_https = true;
      }
    } catch {
      // skip
    }
  }

  return {
    chain_length: Math.max(0, chain.length - 1),
    http_to_https,
    www_normalized,
    redirect_chain: chain.slice(0, 8),
  };
}
