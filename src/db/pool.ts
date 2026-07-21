import pg from 'pg';
import { env } from '../config/env.js';

const { Pool } = pg;

/**
 * 애플리케이션 전역에서 공유하는 PostgreSQL 커넥션 풀.
 * 한 번만 생성해서 재사용한다 (요청마다 새 연결을 만들지 않는다).
 */
export const pool = new Pool({
  host: env.db.host,
  port: env.db.port,
  database: env.db.database,
  user: env.db.user,
  password: env.db.password,
  max: env.db.poolMax,
  idleTimeoutMillis: env.db.idleTimeoutMs,
  connectionTimeoutMillis: env.db.connectionTimeoutMs,
});

// 유휴 클라이언트에서 예기치 못한 에러가 나면 프로세스가 죽지 않도록 로깅만.
pool.on('error', (err) => {
  console.error('[db] 유휴 클라이언트 오류:', err.message);
});

/**
 * 파라미터 바인딩 쿼리 헬퍼.
 * 사용 예: const rows = (await query<User>('SELECT * FROM users WHERE id = $1', [id])).rows;
 */
export function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
) {
  return pool.query<T>(text, params as never[]);
}

/**
 * 트랜잭션 헬퍼. 콜백이 성공하면 COMMIT, 예외가 나면 ROLLBACK.
 */
export async function withTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** 애플리케이션 종료 시 풀을 정리한다. */
export async function closePool(): Promise<void> {
  await pool.end();
}
