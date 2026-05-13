import type { Connection, ParsedFlags } from './types';

export async function resolveConnection(flags: ParsedFlags): Promise<Connection> {
  if (flags.env) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'DATABASE_URL is not set. Cannot load config from database. Check .env.local'
      );
    }
    const { createClient } = await import('@libsql/client');
    const client = createClient({ url });
    try {
      const result = await client.execute({
        sql: 'SELECT twxBaseUrl, twxAppKey FROM environment_settings WHERE environment = ?',
        args: [flags.env],
      });
      const row = result.rows[0];
      if (!row) {
        throw new Error(
          `No config found for environment "${flags.env}". Add it in the app Settings page.`
        );
      }
      return { baseUrl: String(row.twxBaseUrl), appKey: String(row.twxAppKey) };
    } finally {
      client.close();
    }
  }

  const baseUrl = process.env.TWX_BASE_URL;
  const appKey = process.env.TWX_APP_KEY;
  if (!baseUrl || !appKey) {
    throw new Error(
      'TWX_BASE_URL or TWX_APP_KEY is not set. ' +
        'Use --env <name> to load from the app database, or set the vars in .env.local'
    );
  }
  return { baseUrl, appKey };
}
