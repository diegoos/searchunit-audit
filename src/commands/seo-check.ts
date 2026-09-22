import type { CliFlags } from '../lib/args.ts';
import { runKindReportCommand } from './kind-report.ts';

/** SEO kind score plus deterministic on-page, technical, and schema findings. */
export async function runSeoCheck(target: string | undefined, flags: CliFlags): Promise<number> {
  return runKindReportCommand('seo-check', 'seo', target, flags);
}
