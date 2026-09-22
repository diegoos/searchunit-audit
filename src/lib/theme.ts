import chalk, { chalkStderr } from 'chalk';

/** True when stdout color support is off (CI, pipe, FORCE_COLOR=0). */
export function useAsciiMarks(): boolean {
  return chalk.level === 0;
}

/** Colored pass/warn/fail mark (ora-aligned symbols, ASCII when colorless). */
export function statusSymbol(status: string): string {
  const ascii = useAsciiMarks();

  if (status === 'pass') {
    return chalk.green(ascii ? 'ok' : '✔');
  }

  if (status === 'warn') {
    return chalk.yellow(ascii ? '!' : '⚠');
  }

  if (status === 'fail') {
    return chalk.red(ascii ? 'x' : '✖');
  }

  if (status === 'info') {
    return chalk.dim('i');
  }

  return status;
}

/**
 * Banner marks for audit header/footer (emoji on TTY; ASCII in pipes).
 * Tables keep `statusSymbol` so column width stays stable.
 */
export function bannerMark(status: 'pass' | 'warn' | 'fail'): string {
  const ascii = useAsciiMarks();

  if (status === 'pass') {
    return chalk.green(ascii ? 'ok' : '✅');
  }

  if (status === 'warn') {
    return chalk.yellow(ascii ? '!' : '⚠️');
  }

  return chalk.red(ascii ? 'x' : '❌');
}

const PASS_SCORE = 70;
const WARN_SCORE = 40;

/** Colors a score string: green ≥70, yellow ≥40, red below. */
export function paintScore(score: number, text: string): string {
  if (score >= PASS_SCORE) {
    return chalk.green(text);
  }

  if (score >= WARN_SCORE) {
    return chalk.yellow(text);
  }

  return chalk.red(text);
}

/** One-line legend matching table marks (`ok`/`!`/`x` when colorless). */
export function statusLegend(): string {
  return `${statusSymbol('pass')} pass  ${statusSymbol('warn')} warn  ${statusSymbol('fail')} fail`;
}

/** Maps a 0–100 score onto pass/warn/fail using the same bands as paintScore. */
export function scoreStatus(score: number): 'pass' | 'warn' | 'fail' {
  if (score >= PASS_SCORE) {
    return 'pass';
  }

  if (score >= WARN_SCORE) {
    return 'warn';
  }

  return 'fail';
}

export const theme = {
  title: (text: string) => chalk.bold(text),
  url: (text: string) => chalk.cyan(text),
  dim: (text: string) => chalk.dim(text),
  heading: (text: string) => chalk.bold(text),
  score: (text: string) => chalk.bold(text),
  ok: (text: string) => chalk.green(text),
  warn: (text: string) => chalk.yellow(text),
  fail: (text: string) => chalk.red(text),
  command: (text: string) => chalk.cyan(text),
  option: (text: string) => chalk.magenta(text),
  error: (text: string) => chalkStderr.red(text),
};

/** Colors text with the pass / warn / fail theme. */
export function paintStatus(status: 'pass' | 'warn' | 'fail', text: string): string {
  if (status === 'pass') {
    return theme.ok(text);
  }

  if (status === 'fail') {
    return theme.fail(text);
  }

  return theme.warn(text);
}

const LABELS: Record<string, string> = {
  CrUX: 'CrUX',
  aiCitability: 'AI citability',
  contentQuality: 'Content quality',
  technicalFoundations: 'Technical foundations',
  structuredData: 'Structured data',
  platformOptimization: 'Platform optimization',
  valid_json: 'valid JSON',
  context: '@context',
  required_props: 'required props',
  recommended_props: 'recommended props',
  absolute_urls: 'absolute URLs',
  default_rule: 'default rule',
  crawl_delay: 'crawl-delay',
  robots_meta: 'robots meta',
  og_title: 'og title',
  og_description: 'og description',
  og_image: 'og image',
  og_url: 'og url',
  og_type: 'og type',
  twitter_card: 'twitter card',
  twitter_title: 'twitter title',
  twitter_description: 'twitter description',
  twitter_image: 'twitter image',
  author_object: 'author object',
  content_type: 'content type',
  h1_title: 'h1 title',
  file_lists: 'file lists',
  links_format: 'links format',
  optional_section: 'optional section',
  md_convention: 'md convention',
  full_presence: 'full presence',
  full_content_type: 'full content type',
  full_h1_title: 'full h1 title',
  full_summary: 'full summary',
  full_file_lists: 'full file lists',
  full_links_format: 'full links format',
  full_optional_section: 'full optional section',
  full_md_convention: 'full md convention',
  full_size: 'full size',
  full_syntax: 'full syntax',
  non_list_in_section: 'non list in section',
  full_non_list_in_section: 'full non list in section',
};

/**
 * Turns a check or component id into a short human label.
 * Known ids are mapped; others split camelCase / snake_case.
 */
export function humanizeLabel(id: string): string {
  if (LABELS[id]) {
    return LABELS[id];
  }

  const spaced = id.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2');

  return spaced;
}
