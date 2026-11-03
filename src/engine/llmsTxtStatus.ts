import { parseLlmsTxt } from '../tools/llmstxt/parseLlmsTxt.ts';
import type { LlmsTxtResult, LlmsTxtStatus } from './types.ts';

export type { LlmsTxtStatus };

interface LlmsShapeMetrics {
  format_valid: boolean;
  has_title: boolean;
  has_links: boolean;
  section_count: number;
  link_count: number;
  has_full: boolean;
}

function metricsFromCompanion(llms: LlmsTxtResult): LlmsShapeMetrics | null {
  if (!llms.full_version.exists || !llms.full_content) {
    return null;
  }

  const parsed = parseLlmsTxt(llms.full_content);
  const section_count = parsed.sections.length;
  const link_count = parsed.links.length;
  const has_title = Boolean(parsed.h1);
  const has_sections = section_count > 0;
  const has_links = link_count > 0;

  return {
    format_valid: has_title && has_sections && has_links,
    has_title,
    has_links,
    section_count,
    link_count,
    has_full: true,
  };
}

function statusFromMetrics(metrics: LlmsShapeMetrics): LlmsTxtStatus {
  if (!metrics.format_valid) {
    return 'malformed';
  }

  if (metrics.has_full && metrics.link_count >= 5 && metrics.section_count >= 2) {
    return 'comprehensive';
  }

  if (metrics.has_title && metrics.has_links && metrics.section_count >= 1) {
    return 'useful';
  }

  return 'limited';
}

export function deriveLlmsTxtStatus(llms: LlmsTxtResult): LlmsTxtStatus {
  if (llms.fetchStatus === 'error') {
    return 'error';
  }

  if (!llms.exists) {
    const companion = metricsFromCompanion(llms);

    return companion ? statusFromMetrics(companion) : 'absent';
  }

  return statusFromMetrics({
    format_valid: llms.format_valid,
    has_title: llms.has_title,
    has_links: llms.has_links,
    section_count: llms.section_count,
    link_count: llms.link_count,
    has_full: llms.full_version.exists,
  });
}
