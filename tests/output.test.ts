import { describe, expect, test, beforeAll } from 'bun:test';
import chalk from 'chalk';
import {
  failOnExitCode,
  formatCheckTable,
  formatKpiLine,
  formatReportHeader,
  formatToolMarkdown,
  formatToolReport,
  clipDetail,
  stripControls,
  toCheckRow,
} from '../src/lib/output.ts';

import { createProgress, isMachineOutput, withProgress } from '../src/lib/progress.ts';
import { formatTable, tableColumns, visibleWidth } from '../src/lib/table.ts';
import {
  bannerMark,
  humanizeLabel,
  scoreStatus,
  statusLegend,
  statusSymbol,
} from '../src/lib/theme.ts';

import type { CliFlags } from '../src/lib/args.ts';
import { DEFAULT_MAX_BODY_BYTES } from '../src/lib/maxBodyBytes.ts';
import { scoreToCheckStatus } from '../src/tools/types.ts';

beforeAll(() => {
  chalk.level = 0;
});

describe('formatReportHeader', () => {
  test('uses one layout for title, url, label, extra, legend, and KPIs', () => {
    const text = formatReportHeader({
      title: 'Site Audit',
      url: 'https://example.com/',
      score: 80,
      label: 'Strong',
      extra: 'confidence 80  ·  evidence high',
      kpis: [{ status: 'pass', label: 'Title', value: 'present' }],
    });
    expect(text.startsWith('\nSite Audit  ·  80')).toBe(true);
    expect(text).toMatch(/Site Audit[^\n]*\n\nhttps:\/\/example.com\//);
    expect(text).toContain('Strong');
    expect(text).toContain('confidence 80  ·  evidence high');
    expect(text).toContain('ok pass');
    expect(text).toContain('Title');
    expect(text).toContain('present');
  });
});

describe('formatToolReport', () => {
  test('prints a hierarchical colorless report with ASCII marks', () => {
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
          ],
        },
      ],
    });
    expect(text.startsWith('\nok  Schema Markup Check  ·  95')).toBe(true);
    expect(text).toContain('ok pass');
    expect(text).toMatch(/^\nok {2}Schema Markup Check {2}· {2}95\n\nhttps:\/\/example.com\//);
    expect(text.split('ok pass').length).toBe(2);
    expect(text).toContain('3 JSON-LD block(s)');
    expect(text).toContain('WebPage');
    expect(text).toContain('Status');
    expect(text).toContain('Check');
    expect(text).toContain('Detail');
    expect(text).toContain('!');
    expect(text).toContain('recommended props');
    expect(text).not.toContain('\x1b[');
    expect(text).not.toContain('Fetching');
  });
  test('appends a body table after the shared header', () => {
    const text = formatToolReport({
      title: 'Google Profile Finder',
      url: 'https://www.example.com',
      extra: 'www stays www',
      body: formatTable(['Field', 'Value'], [['domain', 'www.example.com']]),
    });
    expect(text.startsWith('\nGoogle Profile Finder')).toBe(true);
    expect(text).toContain('https://www.example.com');
    expect(text).toContain('www stays www');
    expect(text).toContain('ok pass');
    expect(text).toContain('Field');
    expect(text).toContain('www.example.com');
  });
  test('wraps long cells so table lines fit the terminal', () => {
    const text = formatTable(
      ['Status', 'Check', 'Detail'],
      [['ok', 'canonical', `https://example.com/${'a'.repeat(200)}`]],
    );
    const limit = tableColumns();

    for (const line of text.split('\n')) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(limit);
    }
  });
  test('keeps Status on one header line and does not wrap SGR codes', () => {
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
      const headerLine = text
        .split('\n')
        .find((line) => visibleWidth(line) > 0 && line.includes('Status'));
      expect(headerLine).toBeDefined();
      expect(headerLine).toContain('Status');
      expect(headerLine).not.toMatch(/St\s/);
      const withoutSgr = text.replaceAll(
        new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'),
        '',
      );

      expect(withoutSgr).not.toMatch(/22m/);
      expect(withoutSgr).not.toContain('\x1b');
    } finally {
      chalk.level = previous;
    }
  });
  test('uses a double outer box, single inner rules, and centered Status', () => {
    const text = formatTable(
      ['Status', 'Check', 'Detail'],
      [
        ['ok', 'valid JSON', 'valid'],
        ['!', 'recommended props', 'author'],
      ],
    );
    expect(text).toContain('╔');
    expect(text).toContain('╚');
    expect(text).toContain('╟');
    expect(text).toContain('┼');
    const statusRow = text
      .split('\n')
      .find((line) => line.includes('ok') && line.includes('valid JSON'));
    expect(statusRow).toBeDefined();
    expect(statusRow).toMatch(/║\s+ok\s+│/);
  });
  test('summarizes crawlers as a heading without pass rows', () => {
    const text = formatToolReport({
      title: 'robots.txt Validator',
      url: 'https://example.com/robots.txt',
      score: 100,
      status: 'pass',
      sections: [
        { heading: 'File', checks: [{ id: 'syntax', status: 'pass', detail: 'valid' }] },
        { heading: 'Crawlers', checks: [{ id: 'allowed', status: 'pass', detail: '17/17' }] },
      ],
    });
    expect(text).toContain('Crawlers');
    expect(text).toContain('17/17');
    expect(text).toContain('File');
    expect(text).toContain('Status');
  });
  test('lists only blocked crawlers', () => {
    const text = formatToolReport({
      title: 'robots.txt Validator',
      score: 40,
      status: 'fail',
      sections: [
        {
          heading: 'Crawlers  16/17 allowed',
          checks: [{ id: 'GPTBot', status: 'fail', detail: 'blocked' }],
        },
      ],
    });
    expect(text).toContain('GPTBot');
    expect(text).toContain('blocked');
    expect(text).toContain('x');
    expect(text).toContain('Status');
  });
});

describe('stripControls', () => {
  test('keeps tab and newline and drops other C0 controls', () => {
    expect(stripControls('ok\tline\n')).toBe('ok\tline\n');
    expect(stripControls('evil\u001b[31mred')).toBe('evil[31mred');
    expect(stripControls('bell\u0007')).toBe('bell');
    expect(stripControls('csi\u009b[2J')).toBe('csi[2J');
  });
});

describe('clipDetail', () => {
  test('keeps short details and clips long ones', () => {
    expect(clipDetail('present')).toBe('present');
    expect(clipDetail('a'.repeat(140)).length).toBe(140);
    expect(clipDetail('a'.repeat(141)).endsWith('…')).toBe(true);
    expect(clipDetail('a'.repeat(141)).length).toBe(140);
  });
});

describe('toCheckRow', () => {
  test('humanizes the id and keeps status and detail', () => {
    expect(toCheckRow({ id: 'valid_json', status: 'pass', detail: 'valid' })).toEqual({
      id: 'valid JSON',
      status: 'pass',
      detail: 'valid',
    });
  });
  test('prefers an explicit label over the id', () => {
    expect(toCheckRow({ id: 'valid_json', label: 'custom', status: 'warn' })).toEqual({
      id: 'custom',
      status: 'warn',
      detail: undefined,
    });
  });
});

describe('formatKpiLine', () => {
  test('uses pass warn and fail marks', () => {
    expect(formatKpiLine('pass', 'Title', 'present')).toContain('Title');
    expect(formatKpiLine('pass', 'Title', 'present')).toContain('present');
    expect(formatKpiLine('warn', 'Title', 'short')).toContain('!');
    expect(formatKpiLine('fail', 'Title', 'missing')).toContain('x');
    expect(formatKpiLine('info', 'Title', 'n/a')).toContain('ok');
    expect(formatKpiLine('pass', 'Title', '\u001b[31mhack')).not.toContain('\u001b[31mhack');
  });
});

describe('formatCheckTable', () => {
  test('returns empty when there are no checks', () => {
    expect(formatCheckTable([])).toBe('');
  });
  test('prints missing when detail is blank', () => {
    const text = formatCheckTable([{ id: 'title', status: 'fail', detail: '  ' }]);

    expect(text).toContain('missing');
    expect(text).toContain('title');
  });
  test('clips a long detail so the table stays readable', () => {
    const text = formatCheckTable([{ id: 'csp', status: 'warn', detail: 'x'.repeat(200) }]);

    expect(text).not.toContain('x'.repeat(141));
    expect(text).toContain('…');
  });
});

describe('formatToolMarkdown', () => {
  test('includes title score url label extra KPIs and checks', () => {
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
    expect(text).toContain('Good');
    expect(text).toContain('3 JSON-LD block(s)');
    expect(text).toContain('- **pass** Title: present');
    expect(text).toContain('## WebPage');
    expect(text).toContain('- **pass** valid JSON — valid');
    expect(text.endsWith('\n')).toBe(true);
  });
  test('escapes HTML in remote markdown details', () => {
    const text = formatToolMarkdown({
      title: 'Meta',
      checks: [{ id: 'canonical', status: 'pass', detail: '<img onerror=alert(1)>' }],
    });
    expect(text).not.toContain('<img onerror=alert(1)>');
    expect(text).toContain('&lt;img');
  });
  test('uses checks when sections are omitted', () => {
    const text = formatToolMarkdown({
      title: 'Meta',
      checks: [{ id: 'title', status: 'fail' }],
    });
    expect(text).toContain('# Meta');
    expect(text).toContain('- **fail** title');
    expect(text).not.toContain('Score:');
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

describe('humanizeLabel', () => {
  test('maps known component and schema ids', () => {
    expect(humanizeLabel('CrUX')).toBe('CrUX');
    expect(humanizeLabel('aiCitability')).toBe('AI citability');
    expect(humanizeLabel('valid_json')).toBe('valid JSON');
    expect(humanizeLabel('default_rule')).toBe('default rule');
  });
  test('splits unknown camelCase and snake_case ids', () => {
    expect(humanizeLabel('foo_bar')).toBe('foo bar');
    expect(humanizeLabel('camelCase')).toBe('camel Case');
  });
});

describe('scoreStatus and scoreToCheckStatus', () => {
  test('scoreStatus uses 70/40 bands', () => {
    expect(scoreStatus(70)).toBe('pass');
    expect(scoreStatus(69)).toBe('warn');
    expect(scoreStatus(40)).toBe('warn');
    expect(scoreStatus(39)).toBe('fail');
  });
  test('scoreToCheckStatus uses 80/50 bands', () => {
    expect(scoreToCheckStatus(80)).toBe('pass');
    expect(scoreToCheckStatus(79)).toBe('warn');
    expect(scoreToCheckStatus(50)).toBe('warn');
    expect(scoreToCheckStatus(49)).toBe('fail');
  });
});

describe('statusLegend', () => {
  test('lists pass warn fail', () => {
    expect(statusLegend()).toBe('ok pass  ! warn  x fail');
  });
});

describe('statusSymbol', () => {
  test('uses a dim i for info', () => {
    expect(statusSymbol('info')).toBe('i');
  });
  test('returns the status string when it is unknown', () => {
    expect(statusSymbol('other')).toBe('other');
  });
});

describe('createProgress', () => {
  test('writes nothing when silent', () => {
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
});

describe('failOnExitCode', () => {
  test('returns 1 only when the threshold is met', () => {
    expect(failOnExitCode('fail', 'fail')).toBe(1);
    expect(failOnExitCode('warn', 'fail')).toBe(0);
    expect(failOnExitCode('warn', 'warn')).toBe(1);
    expect(failOnExitCode('pass', 'warn')).toBe(0);
    expect(failOnExitCode('fail', undefined)).toBe(0);
    expect(failOnExitCode(undefined, 'fail')).toBe(0);
  });
});

describe('isMachineOutput', () => {
  test('is true for json html and markdown', () => {
    expect(isMachineOutput({ outFormat: 'table' })).toBe(false);
    expect(isMachineOutput({ outFormat: 'json' })).toBe(true);
    expect(isMachineOutput({ outFormat: 'html' })).toBe(true);
    expect(isMachineOutput({ outFormat: 'markdown' })).toBe(true);
  });
});

describe('withProgress', () => {
  test('returns the work result and stays silent', async () => {
    const flags: CliFlags = {
      json: false,
      help: false,
      version: false,
      silent: true,
      global: false,
      unset: false,
      agent: false,
      outFormat: 'table',
      outputPath: undefined,
      failOn: undefined,
      maxBytes: DEFAULT_MAX_BODY_BYTES,
      rest: [],
    };
    const value = await withProgress(flags, 'Fetching', async (setText) => {
      setText('Working');

      return 42;
    });
    expect(value).toBe(42);
  });
});

describe('formatTable', () => {
  test('returns empty when headers are empty', () => {
    expect(formatTable([], [['a']])).toBe('');
  });
});

describe('audit banner marks', () => {
  test('uses ASCII check warn and x when colorless', () => {
    expect(bannerMark('pass')).toBe('ok');
    expect(bannerMark('warn')).toBe('!');
    expect(bannerMark('fail')).toBe('x');
  });
});
