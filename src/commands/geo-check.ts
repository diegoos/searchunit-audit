import type { CliFlags } from '../lib/args.ts';
import { runKindReportCommand } from './kind-report.ts';

/** GEO kind score plus GEO findings (citability, crawlers, llms.txt). */
export async function runGeoCheck(target: string | undefined, flags: CliFlags): Promise<number> {
  return runKindReportCommand('geo-check', 'geo', target, flags);
}
