import { beforeAll, describe, expect, test } from 'bun:test';
import chalk from 'chalk';
import {
  failOnExitCode,
  formatCheckTable,
  formatKpiLine,
  formatReportHeader,
  formatToolMarkdown,
  formatToolReport,
  stripControls,
} from '../src/lib/output.ts';
import { createProgress, isMachineOutput, withProgress } from '../src/lib/progress.ts';
import { formatTable, tableColumns, visibleWidth } from '../src/lib/table.ts';
import { scoreStatus, statusSymbol } from '../src/lib/theme.ts';
import type { CliFlags } from '../src/lib/args.ts';
import { DEFAULT_MAX_BODY_BYTES } from '../src/lib/maxBodyBytes.ts';
import { scoreToCheckStatus } from '../src/tools/types.ts';

beforeAll(() => {
  chalk.level = 0;
});

function flags(over: Partial<CliFlags> = {}): CliFlags {
  return {
    json: false,
    help: false,
    version: false,
    silent: true,
    global: false,
    agent: false,
    outFormat: 'table',
    outputPath: undefined,
    failOn: undefined,
    maxBytes: DEFAULT_MAX_BODY_BYTES,
    rest: [],
    ...over,
  };
}

describe('formatReportHeader', () => {
  test('renders title, url, score, label, extra line, and KPIs', () => {
    const text = formatReportHeader({
      title: 'Page Audit',
      url: 'https://example.com/',
      score: 80,
      label: 'Strong',
      extra: 'confidence 80',
      kpis: [{ status: 'pass', label: 'Title', value: 'present' }],
    });
    for (const part of [
      'Page Audit',
      '80',
      'https://example.com/',
      'Strong',
      'confidence 80',
      'Title',
      'present',
    ]) {
      expect(text).toContain(part);
    }
  });
});

describe('formatToolReport', () => {
  test('renders a colorless report with ASCII status marks', () => {
    const text = formatToolReport({
      title: 'Schema Markup Check',
      url: 'https://example.com/',
      score: 95,
      status: 'pass',
      extra: '3 JSON-LD block(s)',
      sections: [
        {
          heading: 'WebPage',
          checks: [
            { id: 'valid JSON', status: 'pass', detail: 'valid' },
            { id: 'recommended props', status: 'warn', detail: 'author' },
            { id: 'canonical', status: 'fail', detail: 'missing' },
          ],
        },
      ],
    });
    expect(text).toContain('Schema Markup Check');
    expect(text).toContain('recommended props');
    expect(text).toContain('ok');
    expect(text).toContain('!');
    expect(text).toContain('x');
    expect(text).not.toContain('\u001b[');
  });
});

describe('formatTable', () => {
  test('wraps long cells so every line fits the terminal width', () => {
    const text = formatTable(
      ['Status', 'Check', 'Detail'],
      [['ok', 'canonical', `https://example.com/${'a'.repeat(200)}`]],
    );
    const limit = tableColumns();

    for (const line of text.split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(limit);
    }
  });
  test('SGR color codes do not count toward the width and the Status header stays whole', () => {
    const previous = chalk.level;

    chalk.level = 1;

    try {
      const text = formatTable(
        ['Status', 'Check', 'Detail'],
        [
          [statusSymbol('pass'), 'valid JSON', 'valid'],
          [statusSymbol('warn'), 'recommended props', 'breadcrumb, dateModified, author'],
        ],
      );

      expect(text).toContain('Status');

      for (const line of text.split('\n')) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(tableColumns());
      }
    } finally {
      chalk.level = previous;
    }
  });
});

describe('formatCheckTable', () => {
  test('clips a long detail so the table stays readable', () => {
    const text = formatCheckTable([{ id: 'csp', status: 'warn', detail: 'x'.repeat(200) }]);

    expect(text).not.toContain('x'.repeat(141));
    expect(text).toContain('…');
  });
});

describe('stripControls and KPI lines', () => {
  test('stripControls keeps tab and newline and drops other C0 and C1 controls', () => {
    expect(stripControls('ok\tline\n')).toBe('ok\tline\n');
    expect(stripControls('evil\u001b[31mred')).toBe('evil[31mred');
    expect(stripControls('bell\u0007')).toBe('bell');
    expect(stripControls('csi\u009b[2J')).toBe('csi[2J');
  });
  test('a KPI value from remote text carries no escape character', () => {
    expect(formatKpiLine('pass', 'Title', '\u001b[31mhack')).not.toContain('\u001b');
  });
});

describe('formatToolMarkdown', () => {
  test('renders title, score, url, label, KPIs, sections, and check lines', () => {
    const text = formatToolMarkdown({
      title: 'Schema Markup Check',
      url: 'https://example.com/',
      score: 95,
      label: 'Good',
      extra: '3 JSON-LD block(s)',
      kpis: [{ status: 'pass', label: 'Title', value: 'present' }],
      sections: [
        { heading: 'WebPage', checks: [{ id: 'valid JSON', status: 'pass', detail: 'valid' }] },
      ],
    });
    expect(text).toContain('# Schema Markup Check');
    expect(text).toContain('Score: 95');
    expect(text).toContain('https://example.com/');
    expect(text).toContain('- **pass** Title: present');
    expect(text).toContain('## WebPage');
    expect(text).toContain('- **pass** valid JSON — valid');
    expect(text.endsWith('\n')).toBe(true);
  });
  test('escapes HTML in remote details', () => {
    const text = formatToolMarkdown({
      title: 'Meta',
      checks: [{ id: 'canonical', status: 'pass', detail: '<img onerror=alert(1)>' }],
    });
    expect(text).not.toContain('<img onerror=alert(1)>');
    expect(text).toContain('&lt;img');
  });
  test('clips a long check detail', () => {
    const text = formatToolMarkdown({
      title: 'Security',
      checks: [{ id: 'csp', status: 'warn', detail: 'x'.repeat(200) }],
    });
    expect(text).not.toContain('x'.repeat(141));
    expect(text).toContain('…');
  });
});

describe('status bands', () => {
  test('scoreStatus uses 70 and 40 as the pass and warn floors', () => {
    expect(scoreStatus(70)).toBe('pass');
    expect(scoreStatus(69)).toBe('warn');
    expect(scoreStatus(40)).toBe('warn');
    expect(scoreStatus(39)).toBe('fail');
  });
  test('scoreToCheckStatus uses 80 and 50 as the pass and warn floors', () => {
    expect(scoreToCheckStatus(80)).toBe('pass');
    expect(scoreToCheckStatus(79)).toBe('warn');
    expect(scoreToCheckStatus(50)).toBe('warn');
    expect(scoreToCheckStatus(49)).toBe('fail');
  });
});

describe('failOnExitCode', () => {
  test('returns 1 only when the status meets the --fail-on threshold', () => {
    expect(failOnExitCode('fail', 'fail')).toBe(1);
    expect(failOnExitCode('warn', 'fail')).toBe(0);
    expect(failOnExitCode('warn', 'warn')).toBe(1);
    expect(failOnExitCode('pass', 'warn')).toBe(0);
    expect(failOnExitCode('fail', undefined)).toBe(0);
    expect(failOnExitCode(undefined, 'fail')).toBe(0);
  });
});

describe('progress', () => {
  test('a silent progress writes nothing to stderr', () => {
    const chunks: string[] = [];
    const original = process.stderr.write.bind(process.stderr);

    process.stderr.write = ((chunk: string | Uint8Array) => {
      chunks.push(String(chunk));

      return true;
    }) as typeof process.stderr.write;

    try {
      const progress = createProgress({ silent: true, machine: false });

      progress.start('Fetching');
      progress.setText('Working');
      progress.stop();
      expect(chunks.join('')).toBe('');
    } finally {
      process.stderr.write = original;
    }
  });
  test('json, html, markdown, and --agent output are machine output; table is not', () => {
    expect(isMachineOutput({ outFormat: 'table' })).toBe(false);
    expect(isMachineOutput({ outFormat: 'json' })).toBe(true);
    expect(isMachineOutput({ outFormat: 'html' })).toBe(true);
    expect(isMachineOutput({ outFormat: 'markdown' })).toBe(true);
    expect(isMachineOutput({ outFormat: 'table', agent: true })).toBe(true);
  });
  test('withProgress returns the work result', async () => {
    const value = await withProgress(flags({ silent: true }), 'Fetching', async (setText) => {
      setText('Working');

      return 42;
    });
    expect(value).toBe(42);
  });
});
