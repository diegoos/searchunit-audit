import type { CruxFetchResult, CruxMetric, CruxParsedRecord, CruxUrlResult } from './types.ts';
import {
  BodyTooLargeError,
  currentMaxBodyBytes,
  readCappedBody,
  resolvePublicHop,
} from '../lib/fetch.ts';
import { pinnedFetch } from '../lib/pinnedFetch.ts';

const CRUX_ENDPOINT = 'https://chromeuxreport.googleapis.com/v1/records:queryRecord';

const METRIC_THRESHOLDS: Record<string, { good: number; poor: number }> = {
  largest_contentful_paint: { good: 2500, poor: 4000 },

  interaction_to_next_paint: { good: 200, poor: 500 },

  cumulative_layout_shift: { good: 0.1, poor: 0.25 },

  first_contentful_paint: { good: 1800, poor: 3000 },

  experimental_time_to_first_byte: { good: 800, poor: 1800 },

  first_input_delay: { good: 100, poor: 300 },
};

const CORE_VITALS = new Set([
  'largest_contentful_paint',
  'interaction_to_next_paint',
  'cumulative_layout_shift',
]);

const FRACTION_METRICS = new Set(['form_factors', 'navigation_types']);

function rateMetric(metricName: string, p75: unknown): string {
  const thresholds = METRIC_THRESHOLDS[metricName];

  if (!thresholds || p75 === null || p75 === undefined) {
    return 'unknown';
  }

  const value = Number(p75);

  if (!Number.isFinite(value)) {
    return 'unknown';
  }

  if (value <= thresholds.good) {
    return 'good';
  }

  if (value <= thresholds.poor) {
    return 'needs_improvement';
  }

  return 'poor';
}

function parseMetric(name: string, value: Record<string, unknown>): CruxMetric {
  if (FRACTION_METRICS.has(name)) {
    return { fractions: (value.fractions as Record<string, unknown>) ?? {} };
  }

  const histogram = (value.histogram as { density?: number }[]) ?? [];
  const p75 = (value.percentiles as { p75?: unknown })?.p75 ?? null;
  const densities = histogram.map((b) => b.density ?? 0);

  return {
    p75: p75 === null || p75 === undefined ? null : Number(p75),
    rating: rateMetric(name, p75),
    good_density: densities[0] ?? null,
    needs_improvement_density: densities[1] ?? null,
    poor_density: densities[2] ?? null,
    histogram,
  };
}

function parseCruxPayload(payload: Record<string, unknown> | null): CruxParsedRecord | null {
  if (!payload || !('record' in payload)) {
    return null;
  }

  const record = payload.record as Record<string, unknown>;
  const metricsRaw = (record.metrics as Record<string, Record<string, unknown>>) ?? {};
  const metrics: Record<string, CruxMetric> = {};

  for (const [name, value] of Object.entries(metricsRaw)) {
    metrics[name] = parseMetric(name, value);
  }

  const cwvRatings = [...CORE_VITALS]
    .filter((name) => name in metrics)
    .map((name) => metrics[name]?.rating);
  return {
    cwv_pass: cwvRatings.length > 0 ? cwvRatings.every((r) => r === 'good') : null,
    metrics,
    collection_period: record.collectionPeriod,
    url_normalization: payload.urlNormalizationDetails,
  };
}

async function queryCrux(
  apiKey: string,
  body: Record<string, string>,
): Promise<{
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const hop = await resolvePublicHop(new URL(CRUX_ENDPOINT), controller.signal);

    if (!hop.ok) {
      return { success: false, error: hop.error };
    }

    const response = await pinnedFetch(CRUX_ENDPOINT, hop.pinnedAddress, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual',
    });
    let payload: Record<string, unknown>;

    try {
      const bytes = await readCappedBody(response, currentMaxBodyBytes());

      payload = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return { success: false, error: err.message };
      }

      if (err instanceof SyntaxError) {
        return { success: false, error: 'Invalid JSON response' };
      }

      throw err;
    }

    if (response.status === 200) {
      return { success: true, data: payload };
    }

    const errObj = payload.error as { message?: string } | undefined;

    return { success: false, error: errObj?.message ?? `HTTP ${response.status}` };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Queries CrUX when `CRUX_API_KEY` is set. Missing data is skipped, not a failure.
 */
export async function fetchCruxResults(urls: string[]): Promise<CruxFetchResult> {
  const deduped = [...new Set(urls.filter(Boolean))];
  const apiKey = process.env.CRUX_API_KEY?.trim();

  if (!apiKey) {
    return {
      status: 'skipped',
      results: [],
      errors: ['CRUX_API_KEY not configured'],
    };
  }

  if (deduped.length === 0) {
    return { status: 'skipped', results: [], errors: [] };
  }

  const responses: Awaited<ReturnType<typeof queryCrux>>[] = [];
  const CONCURRENCY = 5;

  for (let i = 0; i < deduped.length; i += CONCURRENCY) {
    const batch = deduped.slice(i, i + CONCURRENCY);
    const batchResponses = await Promise.all(
      batch.map(async (url) => {
        const parsed = new URL(url);
        const origin = `${parsed.protocol}//${parsed.host}`;

        return Promise.all([queryCrux(apiKey, { url }), queryCrux(apiKey, { origin })]);
      }),
    );
    responses.push(...batchResponses.flat());
  }

  const results: CruxUrlResult[] = [];
  const errors: string[] = [];

  for (let index = 0; index < deduped.length; index++) {
    const url = deduped[index]!;
    const parsed = new URL(url);
    const origin = `${parsed.protocol}//${parsed.host}`;
    const urlResponse = responses[index * 2]!;
    const originResponse = responses[index * 2 + 1]!;

    const urlData = urlResponse.success ? parseCruxPayload(urlResponse.data ?? null) : null;
    const originData = originResponse.success
      ? parseCruxPayload(originResponse.data ?? null)
      : null;

    const itemErrors: string[] = [];

    if (!urlResponse.success) {
      itemErrors.push(`url: ${urlResponse.error ?? 'unknown error'}`);
    }

    if (!originResponse.success) {
      itemErrors.push(`origin: ${originResponse.error ?? 'unknown error'}`);
    }

    errors.push(...itemErrors.map((m) => `${url} -> ${m}`));

    let status: CruxUrlResult['status'] = 'no_data';

    if (urlData && originData) {
      status = 'ok';
    } else if (urlData || originData) {
      status = 'partial';
    } else if (itemErrors.length > 0) {
      status = 'error';
    }

    results.push({
      url,
      origin,
      status,
      url_data: urlData,
      origin_data: originData,
      errors: itemErrors,
    });
  }

  return {
    status: results.length > 0 ? 'completed' : 'skipped',
    results,
    errors,
  };
}
