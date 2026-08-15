import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Architecture guards (AR-11, AR-18, D-14).
 *
 * oxlint has no `no-restricted-syntax`, so the rule the spec asks for is
 * expressed here instead. That is not a downgrade: a lint rule warns, this
 * fails the build, and the failure message names the file that broke the seam.
 *
 * The invariant matters because "which code can talk to Meta?" must stay
 * answerable by reading one directory. A single convenient `fetch` elsewhere
 * would put an unretryable, unclassified, untokened call into production with
 * nothing to notice it.
 */

const SRC = join(process.cwd(), 'src');
const PROVIDER_DIR = join(SRC, 'providers', 'whatsapp');

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });

const files = sourceFiles(SRC);

const outsideProvider = files.filter((file) => !file.startsWith(PROVIDER_DIR));

/**
 * Production modules only. Tests legitimately name Meta's hosts and stub
 * `fetch`; the rule is about what ships, and a guard that flagged its own
 * suite would be turned off within a week.
 */
const productionOutsideProvider = outsideProvider.filter(
  (file) => !file.endsWith('.test.ts') && !file.includes('__tests__'),
);

/**
 * Comments are prose about the rule, not violations of it — this file's own
 * doc comments would otherwise fail it, and `// worker has something to fetch`
 * genuinely did.
 *
 * Only block comments and whole comment lines are removed. Stripping trailing
 * `//` would eat the `//` in a URL literal and hide exactly the violation the
 * first assertion looks for.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');

const contentsOf = (file: string) => stripComments(readFileSync(file, 'utf8'));

const offenders = (pattern: RegExp, candidates: string[]): string[] =>
  candidates.filter((file) => pattern.test(contentsOf(file))).map((file) => relative(SRC, file));

describe('the Meta seam', () => {
  it('confines the Graph API host to src/providers/whatsapp', () => {
    expect(offenders(/graph\.facebook\.com/, productionOutsideProvider)).toEqual([]);
  });

  /**
   * The rule AR-11 actually wants. Confining the hostname is not enough: the
   * media CDN URL arrives *inside* Meta's payload, so a module could download
   * from it without ever naming a host. One HTTP layer means one `fetch`.
   */
  it('keeps every outbound HTTP call inside the provider', () => {
    expect(offenders(/\bfetch\s*\(/, productionOutsideProvider)).toEqual([]);
  });

  /**
   * `application-config.ts` declares the variables and is their only other
   * legitimate mention — declaring a secret is not reading one.
   */
  it('keeps the access token out of every module but the provider', () => {
    const candidates = productionOutsideProvider.filter(
      (file) => !file.endsWith('application-config.ts'),
    );

    expect(offenders(/META_ACCESS_TOKEN/, candidates)).toEqual([]);
  });

  it('keeps the app secret to the provider and the config declaration', () => {
    const candidates = productionOutsideProvider.filter(
      (file) => !file.endsWith('application-config.ts'),
    );

    expect(offenders(/META_APP_SECRET/, candidates)).toEqual([]);
  });
});

describe('provider construction', () => {
  /**
   * Constructing the Cloud API provider directly bypasses `WA_PROVIDER`, so a
   * caller that did it would ignore the seam without any import error.
   */
  it('routes every construction through getProvider()', () => {
    expect(offenders(/createCloudApiProvider/, productionOutsideProvider)).toEqual([]);
  });
});

describe('the source tree itself', () => {
  it('was actually scanned', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(productionOutsideProvider.length).toBeGreaterThan(40);
  });
});
