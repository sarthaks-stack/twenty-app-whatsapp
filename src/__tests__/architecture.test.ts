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
   * Two exceptions, both narrow and both necessary:
   *
   *  - `application-config.ts` *declares* the variables. Declaring a secret is
   *    not reading one.
   *  - `logger.ts` reads their values to redact them. To replace a secret in a
   *    log line you must know what it looks like, so the redactor is the one
   *    module that has to see all of them — which is exactly why it is also the
   *    only module allowed to write to the console.
   */
  const SECRET_READERS = ['application-config.ts', 'server/logger.ts'];

  const withoutSecretReaders = productionOutsideProvider.filter(
    (file) => !SECRET_READERS.some((allowed) => file.endsWith(allowed)),
  );

  it('keeps the access token out of every module but the provider', () => {
    expect(offenders(/META_ACCESS_TOKEN/, withoutSecretReaders)).toEqual([]);
  });

  it('keeps the app secret to the provider and the config declaration', () => {
    expect(offenders(/META_APP_SECRET/, withoutSecretReaders)).toEqual([]);
  });

  /**
   * The corollary rule. The redactor's licence to read secrets is only safe
   * while it is the sole writer to the console — anything else logging directly
   * would bypass it entirely.
   */
  it('keeps console output to the logger', () => {
    const candidates = files.filter(
      (file) =>
        !file.endsWith('.test.ts') &&
        !file.includes('__tests__') &&
        !file.endsWith('server/logger.ts'),
    );

    expect(offenders(/\bconsole\.(log|warn|error|info|debug)\s*\(/, candidates)).toEqual([]);
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

describe('build-time versus runtime modules', () => {
  /**
   * The logic-function bundler replaces every value imported from
   * `twenty-sdk/define` with `__anyStub` — it is the module that *builds the
   * manifest*, not one that runs inside a function. A derived constant like
   * `getFieldUniversalIdentifier(...)` therefore evaluates to nothing at
   * runtime, and nothing warns: the type checker still sees a `string`, the
   * bundle builds, the app applies, and the first real call fails with a
   * GraphQL error naming neither the constant nor the cause.
   *
   * That cost an afternoon once. Runtime code asks the server for metadata
   * identifiers instead (`server/metadata-ids.ts`).
   */
  const runtimeDirs = [join(SRC, 'logic-functions'), join(SRC, 'server')];

  const runtimeFiles = files.filter(
    (file) =>
      runtimeDirs.some((dir) => file.startsWith(dir)) &&
      !file.endsWith('.test.ts') &&
      !file.includes('__tests__'),
  );

  it('scanned the runtime tree', () => {
    expect(runtimeFiles.length).toBeGreaterThan(15);
  });

  /**
   * The `define*` factories are the exception, and the only one: their whole
   * purpose is to be read at build time, and their return value is never used
   * at runtime, so a stub is harmless. Everything else from that module —
   * `getFieldUniversalIdentifier`, `STANDARD_OBJECT`, `FieldType` — produces a
   * value some line of running code will read, and there the stub is the bug.
   */
  it('imports only the define* factories from twenty-sdk/define', () => {
    const offending: string[] = [];

    for (const file of runtimeFiles) {
      for (const match of contentsOf(file).matchAll(
        /import\s+\{([^}]*)\}\s+from\s+'twenty-sdk\/define'/g,
      )) {
        const imported = match[1]!
          .split(',')
          .map((name) => name.trim().split(/\s+as\s+/)[0]!.trim())
          .filter((name) => name.length > 0 && !name.startsWith('type '));

        if (imported.some((name) => !/^define[A-Z]/.test(name))) {
          offending.push(`${relative(SRC, file)}: ${imported.join(', ')}`);
        }
      }
    }

    expect(offending).toEqual([]);
  });

  /**
   * The same trap one step removed: a module that derives identifiers is safe
   * to import for its types, but importing its *values* into runtime code
   * re-introduces the stub.
   */
  it('imports no derived field identifiers into runtime code', () => {
    const offending = runtimeFiles.filter((file) =>
      /from\s+'[^']*constants\/field-identifiers'/.test(contentsOf(file)),
    );

    expect(offending.map((file) => relative(SRC, file))).toEqual([]);
  });
});
