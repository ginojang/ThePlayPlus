import { pool, closePool } from '../db/pool.js';

/**
 * DB 연결 상태를 점검하는 독립 실행 스크립트.
 * 실행: npm run db:check
 */
async function main() {
  console.log('[db:check] PostgreSQL 연결 시도 중...');
  const started = Date.now();

  const { rows } = await pool.query<{
    db: string;
    usr: string;
    server_version: string;
    now: string;
  }>(
    `SELECT current_database() AS db,
            current_user       AS usr,
            current_setting('server_version') AS server_version,
            now()              AS now`,
  );

  const elapsed = Date.now() - started;
  const info = rows[0];

  console.log('[db:check] ✅ 연결 성공 (%dms)', elapsed);
  console.table({
    database: info.db,
    user: info.usr,
    server_version: info.server_version,
    server_time: info.now,
  });
}

main()
  .catch((err) => {
    console.error('[db:check] ❌ 연결 실패:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
