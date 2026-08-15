import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { appDevOnce, appUninstall } from 'twenty-sdk/cli';

const APP_PATH = process.cwd();
const CONFIG_DIR = path.join(os.homedir(), '.twenty');

function validateEnv(): { apiUrl: string; apiKey: string } {
  const apiUrl = process.env.TWENTY_API_URL;
  const apiKey = process.env.TWENTY_API_KEY;

  if (!apiUrl || !apiKey) {
    throw new Error(
      'TWENTY_API_URL and TWENTY_API_KEY must be set.\n' +
        'Start a local server: yarn twenty docker:start\n' +
        'Or set them in vitest env config.',
    );
  }

  return { apiUrl, apiKey };
}

async function checkServer(apiUrl: string) {
  let response: Response;

  try {
    response = await fetch(`${apiUrl}/healthz`);
  } catch {
    throw new Error(
      `Twenty server is not reachable at ${apiUrl}. ` +
        'Make sure the server is running before executing integration tests.',
    );
  }

  if (!response.ok) {
    throw new Error(`Server at ${apiUrl} returned ${response.status}`);
  }
}

function writeConfig(apiUrl: string, apiKey: string) {
  const payload = JSON.stringify(
    {
      remotes: {
        local: { apiUrl, apiKey, accessToken: apiKey },
      },
      defaultRemote: 'local',
    },
    null,
    2,
  );

  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(CONFIG_DIR, 'config.test.json'), payload);
}

/**
 * Refuses to run against a workspace that holds real WhatsApp data.
 *
 * This setup **uninstalls the app before and after every run**, which deletes
 * every record its objects own — conversations, messages, media, campaign
 * history, the connected number and its routing claim. That is correct for a
 * scratch workspace and catastrophic for the one an operator has connected a
 * live number to, and nothing about typing `yarn test` suggests the difference.
 *
 * A count of zero means there is nothing to lose. Any other answer stops, and
 * says how to override deliberately.
 */
async function assertWorkspaceIsDisposable(apiUrl: string, apiKey: string) {
  if (process.env.WA_ALLOW_DESTRUCTIVE_TESTS === 'true') return;

  const count = async (collection: string): Promise<number> => {
    try {
      const response = await fetch(`${apiUrl}/graphql`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          query: `query { ${collection}(first: 1) { totalCount } }`,
        }),
      });

      const body = (await response.json()) as {
        data?: Record<string, { totalCount?: number } | null>;
      };

      return body.data?.[collection]?.totalCount ?? 0;
    } catch {
      // The object does not exist, so the app is not installed: nothing to lose.
      return 0;
    }
  };

  const populated: string[] = [];

  for (const collection of ['whatsappAccounts', 'whatsappThreads', 'whatsappMessages']) {
    const total = await count(collection);

    if (total > 0) populated.push(`${collection}: ${total}`);
  }

  if (populated.length === 0) return;

  throw new Error(
    [
      'Refusing to run integration tests: this workspace holds WhatsApp data.',
      `Found ${populated.join(', ')}.`,
      '',
      'These tests uninstall the app before and after the run, which deletes every',
      'one of those records — including a connected number and its routing claim.',
      '',
      'Point TWENTY_API_URL at a scratch workspace, or set',
      'WA_ALLOW_DESTRUCTIVE_TESTS=true if you genuinely mean to erase this one.',
    ].join('\n'),
  );
}

export async function setup() {
  const { apiUrl, apiKey } = validateEnv();

  await checkServer(apiUrl);
  await assertWorkspaceIsDisposable(apiUrl, apiKey);

  writeConfig(apiUrl, apiKey);

  await appUninstall({ appPath: APP_PATH }).catch(() => {});

  const result = await appDevOnce({
    appPath: APP_PATH,
    onProgress: (message: string) => console.log(`[dev] ${message}`),
  });

  if (!result.success) {
    throw new Error(
      `Dev sync failed: ${result.error?.message ?? 'Unknown error'}`,
    );
  }
}

export async function teardown() {
  const uninstallResult = await appUninstall({ appPath: APP_PATH });

  if (!uninstallResult.success) {
    console.warn(
      `App uninstall failed: ${uninstallResult.error?.message ?? 'Unknown error'}`,
    );
  }
}
