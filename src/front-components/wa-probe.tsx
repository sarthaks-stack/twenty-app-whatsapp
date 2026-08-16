import { defineFrontComponent } from 'twenty-sdk/define';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RestApiClient } from 'twenty-client-sdk/rest';
import { useRecordId } from 'twenty-sdk/front-component';
import { Button } from 'twenty-ui/input';
import { useTheme } from 'twenty-ui/theme-constants';

/**
 * **Probe P-6** — is the chat of specs/08 buildable in this sandbox at all?
 *
 * Temporary. This component exists to answer questions, not to ship: it
 * deliberately calls APIs the product must never call (`ResizeObserver`,
 * `matchMedia`) to find out whether they throw, and it renders a 200-row list of
 * nonsense to see whether `column-reverse` anchoring behaves the way D-7
 * assumes. Delete it, its tab and its three identifiers once the answers are
 * recorded in specs/00.
 *
 * The whole design of `<MessageList>` rests on one untested assumption: that a
 * `flex-direction: column-reverse` container in Remote DOM anchors to the
 * visual bottom by itself, because the sandbox documents `.scrollIntoView()` as
 * throwing and `scrollTop` assignment as a no-op. If it does not, there is no
 * scripted fallback available and the chat degrades to UI tier 2 (specs/08 §10).
 *
 * Everything below reports to the screen rather than the console, because a Web
 * Worker at an opaque origin is not somewhere you can put a breakpoint.
 */

export const PROBE_MESSAGE_COUNT = 200;

type Check = { name: string; verdict: string; detail?: string };

/** Runs a probe and turns a throw into a reportable answer rather than a crash. */
const attempt = (name: string, run: () => string): Check => {
  try {
    return { name, verdict: run() };
  } catch (error) {
    return {
      name,
      verdict: 'THROWS',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
};

type Row = { id: number; text: string; outbound: boolean };

const makeRows = (from: number, count: number): Row[] =>
  Array.from({ length: count }, (_, index) => {
    const id = from - index;

    return {
      id,
      text: `Mensagem ${id} — ${'texto '.repeat((id % 7) + 1)}`.trim(),
      outbound: id % 3 === 0,
    };
  });

const WaProbe = () => {
  const theme = useTheme();
  const recordId = useRecordId();

  /** Newest first, exactly as `<MessageList>` will hold them (specs/08 §3.1). */
  const [rows, setRows] = useState<Row[]>(() => makeRows(PROBE_MESSAGE_COUNT, 50));
  const [, setOldest] = useState(PROBE_MESSAGE_COUNT - 50);
  const [, setNewest] = useState(PROBE_MESSAGE_COUNT);
  const [scroll, setScroll] = useState('(nada ainda)');
  const [feed, setFeed] = useState('a carregar…');
  const [rect, setRect] = useState('—');

  const listRef = useRef<HTMLDivElement | null>(null);

  const readScroll = useCallback((label: string) => {
    const node = listRef.current;

    if (node === null) {
      setScroll(`${label}: sem nó`);

      return;
    }

    /**
     * In a `column-reverse` container `scrollTop` is 0 at the *visual bottom*
     * and grows negative — or grows positive from a bottom origin, depending on
     * the engine. Both are recorded rather than assumed.
     */
    setScroll(
      `${label}: scrollTop=${Math.round(node.scrollTop)} ` +
        `scrollHeight=${Math.round(node.scrollHeight)} ` +
        `clientHeight=${Math.round(node.clientHeight)}`,
    );
  }, []);

  const addNewest = useCallback(() => {
    setNewest((current) => {
      const next = current + 1;

      setRows((existing) => [
        { id: next, text: `NOVA mensagem ${next} — chegou agora`, outbound: false },
        ...existing,
      ]);

      return next;
    });

    // Deliberately after the state update, so the number reflects what the
    // browser did with no scripted scrolling of any kind.
    setTimeout(() => readScroll('depois de nova'), 120);
  }, [readScroll]);

  const loadOlder = useCallback(() => {
    setOldest((current) => {
      const count = Math.min(50, current);

      if (count === 0) return current;

      setRows((existing) => [...existing, ...makeRows(current, count)]);

      return current - count;
    });

    setTimeout(() => readScroll('depois de antigas'), 120);
  }, [readScroll]);

  /**
   * Three calls, not one, because the first answered 403 and one failure does
   * not say *which* thing is broken. `/rest/people` is Twenty's own REST API,
   * so it separates "this sandbox cannot make an authenticated request at all"
   * from "our logic-function route refuses this caller".
   */
  useEffect(() => {
    const client = new RestApiClient();

    const attempt = async (label: string, run: () => Promise<unknown>): Promise<string> => {
      try {
        const body = await run();

        return `${label}=OK ${JSON.stringify(body).slice(0, 120)}`;
      } catch (error) {
        // The status alone does not say who refused. Twenty's own error body
        // names the reason; ours would be `{"error": "..."}` from the route.
        const detail = error as { status?: number; body?: unknown };

        return `${label}=${detail?.status ?? '?'} ${JSON.stringify(detail?.body ?? null).slice(0, 200)}`;
      }
    };

    void Promise.all([
      attempt('feed', () =>
        client.get('/s/whatsapp/feed', { query: { scope: 'bootstrap' } }),
      ),
      attempt('rest', () => client.get('/rest/people', { query: { limit: 1 } })),
      attempt('post', () => client.post('/s/whatsapp/account', { action: 'list' })),
    ]).then((lines) => setFeed(lines.join(' | ')));
  }, []);

  useEffect(() => {
    const node = listRef.current;

    if (node === null) return;

    try {
      const box = node.getBoundingClientRect();

      setRect(`${Math.round(box.width)}×${Math.round(box.height)}`);
    } catch (error) {
      setRect(`THROWS — ${error instanceof Error ? error.message : String(error)}`);
    }
  }, []);

  const checks = useMemo<Check[]>(
    () => [
      attempt('useTheme()', () =>
        typeof theme?.background?.secondary === 'string'
          ? `OK — background.secondary=${theme.background.secondary}`
          : 'sem tokens',
      ),
      attempt('twenty-ui <Button>', () => 'renderizado abaixo'),
      attempt('useRecordId()', () => String(recordId)),
      attempt('ResizeObserver', () => {
        const observer = new ResizeObserver(() => undefined);

        observer.disconnect();

        return 'OK';
      }),
      attempt('IntersectionObserver', () => {
        const observer = new IntersectionObserver(() => undefined);

        observer.disconnect();

        return 'OK';
      }),
      attempt('matchMedia', () => String(matchMedia('(min-width: 100px)').matches)),
      attempt('getComputedStyle', () => {
        const node = listRef.current;

        return node === null ? 'sem nó' : `OK — ${getComputedStyle(node).overflowY}`;
      }),
      attempt('CSS.supports(container-type)', () =>
        String(CSS.supports('container-type: inline-size')),
      ),
      attempt('localStorage', () => {
        localStorage.setItem('wa:probe', 'sim');

        return `OK — leu "${localStorage.getItem('wa:probe')}"`;
      }),
      attempt('canvas 2d', () => {
        const context = document.createElement('canvas').getContext('2d');

        return context === null ? 'null (sem contexto)' : 'OK';
      }),
      attempt('FileReader', () => (typeof FileReader === 'undefined' ? 'ausente' : 'OK')),
      attempt('document.addEventListener', () => {
        document.addEventListener('wa-probe-never', () => undefined);

        return 'não lançou (pode nunca disparar)';
      }),
    ],
    [theme, recordId],
  );

  const label: React.CSSProperties = {
    fontSize: theme.font.size.xs,
    color: theme.font.color.tertiary,
  };

  return (
    <div
      className="wa-probe"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: theme.spacing[2],
        padding: theme.spacing[2],
        background: theme.background.primary,
        color: theme.font.color.primary,
        fontFamily: theme.font.family,
        height: '100%',
        minHeight: 0,
      }}
    >
      <div style={{ fontWeight: theme.font.weight.semiBold }}>Probe P-6 — sondagem</div>

      <div style={{ display: 'flex', gap: theme.spacing[2], flexWrap: 'wrap' }}>
        <Button title="Nova mensagem" onClick={addNewest} accent="blue" size="small" />
        <Button title="Carregar antigas" onClick={loadOlder} size="small" />
        <Button title="Ler scroll" onClick={() => readScroll('manual')} size="small" />
      </div>

      <div style={label}>
        {rows.length} linhas · caixa {rect} · {scroll}
      </div>
      <div style={label}>feed: {feed}</div>

      {/*
        The subject of the probe. No scripted scrolling anywhere: if new rows do
        not appear pinned to the visual bottom, `column-reverse` anchoring is
        not available here and specs/08 §3.1 needs rewriting.
      */}
      <div
        ref={listRef}
        className="wa-probe-list"
        onScroll={() => readScroll('a rolar')}
        style={{
          display: 'flex',
          flexDirection: 'column-reverse',
          overflowY: 'auto',
          gap: theme.spacing[1],
          flex: '1 1 auto',
          minHeight: '240px',
          border: `1px solid ${theme.border.color.medium}`,
          borderRadius: theme.border.radius.md,
          padding: theme.spacing[2],
        }}
      >
        {rows.map((row) => (
          <div
            key={row.id}
            style={{
              alignSelf: row.outbound ? 'flex-end' : 'flex-start',
              maxWidth: '78%',
              padding: `${theme.spacing[1]} ${theme.spacing[2]}`,
              borderRadius: theme.border.radius.md,
              background: row.outbound
                ? theme.background.transparent.blue
                : theme.background.transparent.light,
              fontSize: theme.font.size.sm,
            }}
          >
            {row.text}
          </div>
        ))}
      </div>

      <table style={{ borderCollapse: 'collapse', fontSize: theme.font.size.xs }}>
        <tbody>
          {checks.map((check) => (
            <tr key={check.name}>
              <td
                style={{
                  padding: theme.spacing[1],
                  borderBottom: `1px solid ${theme.border.color.light}`,
                  whiteSpace: 'nowrap',
                }}
              >
                {check.name}
              </td>
              <td
                style={{
                  padding: theme.spacing[1],
                  borderBottom: `1px solid ${theme.border.color.light}`,
                  color:
                    check.verdict === 'THROWS'
                      ? theme.font.color.danger
                      : theme.font.color.secondary,
                }}
              >
                {check.verdict}
                {check.detail === undefined ? '' : ` — ${check.detail}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default defineFrontComponent({
  universalIdentifier: '4a7d29b5-b12b-41ca-b22d-2a0f710f84b4',
  name: 'wa-probe',
  description: 'Temporary feasibility probe for the WhatsApp chat surface (P-6).',
  component: WaProbe,
});
