import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';

/**
 * Chrome runs against a loopback proxy and a host resolver rule that pin the
 * audited host to the address the SSRF preflight approved. Shared by the
 * Lighthouse lab and the Chrome render.
 */

/** The pin proxy listens here. Chrome must reach it without the host rule remapping it. */
const PIN_PROXY_HOST = '127.0.0.1';

export interface PinProxy {
  port: number;
  close: () => void;
}

/** The page host and the pinned address and port that proxied requests must reach. */
interface PinnedDestination {
  pageHost: string;
  pinnedAddress: string;
  pinnedPort: string;
}

/** The port the URL names, or the default for its scheme. */
function defaultPort(url: URL): string {
  return url.port || (url.protocol === 'http:' ? '80' : '443');
}

function parseUrl(value: string | undefined): URL | null {
  try {
    return new URL(value ?? '');
  } catch {
    return null;
  }
}

/**
 * First matching rule wins. `EXCLUDE` keeps the proxy address out of the rules:
 * with `MAP * ^NOTFOUND` alone, current Chrome fails the proxy connection
 * (ERR_PROXY_CONNECTION_FAILED). `^NOTFOUND` fails DNS names in the host
 * resolver. IP literals skip that resolver. The loopback proxy refuses them.
 */
export function hostResolverRules(pageUrl: string, pinnedAddress: string): string | null {
  const url = parseUrl(pageUrl);
  const address = pinnedAddress.trim();

  if (!url || !address || !url.hostname || /[\s,]/.test(address) || /[\s,]/.test(url.hostname)) {
    return null;
  }

  const port = defaultPort(url);
  const replacement = address.includes(':') ? `[${address}]` : address;

  return `EXCLUDE ${PIN_PROXY_HOST}, MAP ${url.hostname}:${port} ${replacement}:${port}, MAP * ^NOTFOUND`;
}

/** Chrome flags that send every request through the pin proxy and the resolver rule. */
export function pinnedChromeFlags(rules: string, proxyPort: number): string[] {
  return [
    `--proxy-server=http://${PIN_PROXY_HOST}:${proxyPort}`,
    '--proxy-bypass-list=<-loopback>',
    `--host-resolver-rules=${rules}`,
  ];
}

/** True when Chrome may dial this host. The socket still uses the pinned address. */
export function pinnedDestinationAllowed(
  requestHost: string,
  requestPort: string,
  pageHost: string,
  pinnedAddress: string,
  pinnedPort: string,
): boolean {
  if (requestPort !== pinnedPort) {
    return false;
  }

  const host = requestHost.replace(/^\[|\]$/g, '').toLowerCase();

  return host === pageHost.toLowerCase() || host === pinnedAddress.toLowerCase();
}

function connectAuthority(authority: string): { host: string; port: string } | null {
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']');

    if (end < 0 || authority[end + 1] !== ':') {
      return null;
    }

    return { host: authority.slice(1, end), port: authority.slice(end + 2) };
  }

  const colon = authority.lastIndexOf(':');

  if (colon <= 0) {
    return null;
  }

  return { host: authority.slice(0, colon), port: authority.slice(colon + 1) };
}

function denyProxyRequest(res: http.ServerResponse): void {
  res.writeHead(403);
  res.end();
}

function isPinnedHttpTarget(target: URL, pin: PinnedDestination): boolean {
  return (
    target.protocol === 'http:' &&
    pinnedDestinationAllowed(
      target.hostname,
      defaultPort(target),
      pin.pageHost,
      pin.pinnedAddress,
      pin.pinnedPort,
    )
  );
}

/** Plain-HTTP request through the proxy. Only the pinned destination is forwarded; anything else gets 403. */
function forwardProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pin: PinnedDestination,
): void {
  const target = parseUrl(req.url);

  if (!target || !isPinnedHttpTarget(target, pin)) {
    denyProxyRequest(res);

    return;
  }

  const upstream = http.request(
    {
      host: pin.pinnedAddress,
      port: Number(pin.pinnedPort),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: { ...req.headers, host: target.host },
    },
    (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    },
  );

  upstream.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502);
    }

    res.end();
  });
  req.pipe(upstream);
}

/** CONNECT tunnel to the pinned destination. Sockets are tracked so the proxy close can destroy them. */
function tunnelProxyConnect(
  req: http.IncomingMessage,
  clientSocket: Duplex,
  head: Buffer,
  pin: PinnedDestination,
  sockets: Set<{ destroy: () => void }>,
): void {
  const parsed = connectAuthority(req.url ?? '');
  const allowed =
    parsed !== null &&
    pinnedDestinationAllowed(
      parsed.host,
      parsed.port,
      pin.pageHost,
      pin.pinnedAddress,
      pin.pinnedPort,
    );

  if (!allowed) {
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');

    return;
  }

  const upstream = net.connect(Number(pin.pinnedPort), pin.pinnedAddress);

  sockets.add(upstream);
  sockets.add(clientSocket);
  upstream.on('error', () => {
    clientSocket.destroy();
  });
  clientSocket.on('error', () => {
    upstream.destroy();
  });
  upstream.on('connect', () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');

    if (head.length > 0) {
      upstream.write(head);
    }

    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
}

/** Loopback proxy on a free port. It forwards only to `pageUrl`'s host at `pinnedAddress`. */
export function openPinProxy(pageUrl: string, pinnedAddress: string): Promise<PinProxy> {
  const page = new URL(pageUrl);
  const pin: PinnedDestination = {
    pageHost: page.hostname,
    pinnedAddress,
    pinnedPort: defaultPort(page),
  };
  const sockets = new Set<{ destroy: () => void }>();
  const server = http.createServer((req, res) => forwardProxyRequest(req, res, pin));

  server.on('connect', (req, clientSocket, head) =>
    tunnelProxyConnect(req, clientSocket, head, pin, sockets),
  );

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, PIN_PROXY_HOST, () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('pin proxy did not bind'));

        return;
      }

      resolve({
        port: address.port,
        close() {
          for (const socket of sockets) {
            socket.destroy();
          }

          server.close();
        },
      });
    });
  });
}
