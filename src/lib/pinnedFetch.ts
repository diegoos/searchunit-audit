import type { LookupFunction } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

function addressFamily(ip: string): 4 | 6 {
  return ip.includes(':') ? 6 : 4;
}

const agentPool = new Map<string, Agent>();
const MAX_POOL_SIZE = 50;

function getPooledAgent(hostname: string, pinnedAddress: string): Agent {
  const key = `${pinnedAddress}:${hostname}`;
  const existing = agentPool.get(key);

  if (existing) {
    return existing;
  }

  if (agentPool.size >= MAX_POOL_SIZE) {
    const firstKey = agentPool.keys().next().value;

    if (firstKey !== undefined) {
      const evicted = agentPool.get(firstKey)!;

      agentPool.delete(firstKey);
      evicted.close().catch(() => {});
    }
  }

  const family = addressFamily(pinnedAddress);
  const agent = new Agent({
    connect: {
      servername: hostname,
      lookup: pinLookup(pinnedAddress, family),
    },
  });
  agentPool.set(key, agent);

  return agent;
}

/**
 * undici connect lookup that always returns the pre-validated pin.
 * Honors `options.all` so autoSelectFamily does not receive a scalar address.
 */
export function pinLookup(pinnedAddress: string, family: 4 | 6): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all) {
      callback(null, [{ address: pinnedAddress, family }]);

      return;
    }

    callback(null, pinnedAddress, family);
  };
}

/**
 * HTTP(S) fetch with DNS pinned to a pre-validated address (mitigates DNS rebinding).
 */
export async function pinnedFetch(
  url: string,
  pinnedAddress: string,
  init: RequestInit,
): Promise<Response> {
  const parsed = new URL(url);
  const dispatcher = getPooledAgent(parsed.hostname, pinnedAddress);
  const response = await undiciFetch(url, {
    dispatcher,
    method: init.method,
    headers: init.headers as Record<string, string> | undefined,
    body: init.body as string | Buffer | Uint8Array | undefined,
    signal: init.signal ?? undefined,
    redirect: init.redirect,
  });

  return response as unknown as Response;
}
