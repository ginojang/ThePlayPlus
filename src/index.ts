import { query, closePool } from './db/pool.js';

/**
 * 애플리케이션 진입점 (뼈대).
 * 지금은 DB 연결만 확인한다. 이후 실제 로직을 여기에 채워나가면 된다.
 */
async function main() {
  const { rows } = await query<{ now: string }>('SELECT now() AS now');
  console.log('ThePlayPlus 시작. DB 연결 OK, 서버 시각:', rows[0].now);
}

main()
  .catch((err) => {
    console.error('시작 실패:', err);
    process.exitCode = 1;
  })
  .finally(closePool);
