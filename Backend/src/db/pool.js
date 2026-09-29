import pg from 'pg';

// int8 (COUNT, BIGINT seq/size) → Number. Ҳамаи қиматҳои мо аз 2^53 хеле хурдтаранд.
pg.types.setTypeParser(20, (value) => (value === null ? null : Number.parseInt(value, 10)));

/** Интерфейси умумӣ барои pool ва клиенти транзаксия. */
class Queryable {
  constructor(runner, inTx) {
    this.runner = runner;
    this.inTx = inTx;
  }

  query(text, params = []) {
    return this.runner.query(text, params);
  }

  async one(text, params = []) {
    const result = await this.runner.query(text, params);
    return result.rows[0] ?? null;
  }

  async many(text, params = []) {
    const result = await this.runner.query(text, params);
    return result.rows;
  }

  async value(text, params = []) {
    const result = await this.runner.query({ text, values: params, rowMode: 'array' });
    return result.rows[0]?.[0] ?? null;
  }

  async column(text, params = []) {
    const result = await this.runner.query({ text, values: params, rowMode: 'array' });
    return result.rows.map((row) => row[0]);
  }

  async exec(text, params = []) {
    const result = await this.runner.query(text, params);
    return result.rowCount ?? 0;
  }

  /** NOTIFY пас аз COMMIT расонида мешавад — ҳодиса барои транзаксияи баргашта намеравад. */
  notify(channel, payload) {
    return this.runner.query('SELECT pg_notify($1, $2)', [channel, JSON.stringify(payload)]);
  }
}

class TxClient extends Queryable {
  constructor(client) {
    super(client, true);
    this.afterCommit = [];
  }

  async tx(fn) {
    return fn(this);
  }

  /** Кори баъди COMMIT (масалан push) — агар транзаксия баргардад, иҷро намешавад. */
  onCommit(fn) {
    this.afterCommit.push(fn);
  }
}

export class Db extends Queryable {
  constructor(pool) {
    super(pool, false);
    this.pool = pool;
  }

  onCommit(fn) {
    // Берун аз транзаксия — фавран.
    Promise.resolve().then(fn).catch(() => {});
  }

  async tx(fn) {
    const client = await this.pool.connect();
    const tx = new TxClient(client);
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      for (const task of tx.afterCommit) {
        Promise.resolve().then(task).catch(() => {});
      }
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

function sslOption(connectionString, mode) {
  if (/[?&]sslmode=/i.test(connectionString)) return undefined;
  if (mode === 'disable' || mode === 'false') return false;
  if (mode === 'no-verify') return { rejectUnauthorized: false };
  if (mode === 'require' || mode === 'true') return { rejectUnauthorized: true };
  let host = '';
  try {
    host = new URL(connectionString).hostname;
  } catch {
    return undefined;
  }
  const local = host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host) || !host.includes('.');
  return local ? false : { rejectUnauthorized: true };
}

export function createDb(config, log) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: sslOption(config.databaseUrl, config.databaseSsl),
    max: config.databasePoolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    application_name: 'jovidxonchat',
    // Параметрҳои сессия дар паёми оғоз (бе дархости иловагӣ ба ҳар пайваст).
    options: '-c statement_timeout=30000 -c TimeZone=UTC',
  });
  pool.on('error', (error) => log?.error({ err: { message: error.message, code: error.code } }, 'db_pool_error'));
  return new Db(pool);
}

export function isUniqueViolation(error, constraint) {
  return error?.code === '23505' && (!constraint || error.constraint === constraint);
}
