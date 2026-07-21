import 'dotenv/config';

/**
 * 필수 환경변수를 읽고, 없으면 즉시 에러를 던진다.
 * 애플리케이션 시작 시점에 설정 누락을 빠르게 잡기 위함.
 */
function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`환경변수 ${name} 가 설정되지 않았습니다. .env 파일을 확인하세요.`);
  }
  return value;
}

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isNaN(parsed)) {
    throw new Error(`환경변수 ${name} 값이 숫자가 아닙니다: "${raw}"`);
  }
  return parsed;
}

export const env = {
  db: {
    host: required('PGHOST'),
    port: num('PGPORT', 5432),
    database: required('PGDATABASE'),
    user: required('PGUSER'),
    password: required('PGPASSWORD'),
    poolMax: num('PG_POOL_MAX', 10),
    idleTimeoutMs: num('PG_IDLE_TIMEOUT_MS', 30000),
    connectionTimeoutMs: num('PG_CONNECTION_TIMEOUT_MS', 5000),
  },
} as const;
