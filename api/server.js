import express from 'express';
import cors from 'cors';
import { pool, query } from './db.js';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3700);

// 편집 가능한 언어/메타 컬럼 화이트리스트 (SQL 인젝션 방지: 컬럼명은 이 집합에서만)
const LANG_COLS = ['cn', 'en', 'jp', 'cnt', 'kr', 'vn', 'pt', 'th', 'my'];
const EDITABLE = new Set([...LANG_COLS, 'note', 'char_limit']);
const SEARCHABLE = ['note', ...LANG_COLS];

const LANG_META = [
  { code: 'kr', label: '한국어', flag: '🇰🇷' },
  { code: 'en', label: '영어', flag: '🇬🇧' },
  { code: 'jp', label: '일본어', flag: '🇯🇵' },
  { code: 'cnt', label: '번체중문', flag: '🇹🇼' },
  { code: 'cn', label: '중문(원문)', flag: '🇨🇳' },
  { code: 'vn', label: '베트남어', flag: '🇻🇳' },
  { code: 'pt', label: '포르투갈어', flag: '🇵🇹' },
  { code: 'th', label: '태국어', flag: '🇹🇭' },
  { code: 'my', label: '말레이어', flag: '🇲🇾' },
];

const asyncH = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.error(e);
  res.status(500).json({ error: e.message });
});

app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.get('/api/languages', (_req, res) => res.json({ languages: LANG_META }));

// 언어별 커버리지 통계 (라이브)
app.get('/api/stats', asyncH(async (_req, res) => {
  const cols = LANG_META.map((l) => `count(${l.code}) AS ${l.code}`).join(', ');
  const { rows } = await query(`SELECT count(*) AS total, ${cols} FROM game_texts`);
  const r = rows[0];
  const total = Number(r.total);
  const languages = LANG_META.map((l) => {
    const filled = Number(r[l.code]);
    return { ...l, filled, missing: total - filled, pct: total ? +(filled / total * 100).toFixed(1) : 0 };
  });
  res.json({ total_strings: total, languages });
}));

// 텍스트 목록: 검색/필터/페이지네이션
// q=검색어  field=검색대상컬럼(기본 전체)  missing=<lang>(해당 언어 비어있는 행만)
// limit(기본100,최대500) offset
app.get('/api/texts', asyncH(async (req, res) => {
  const { q, field, missing } = req.query;
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const offset = Math.max(Number(req.query.offset) || 0, 0);

  const where = [];
  const params = [];
  if (q && String(q).trim() !== '') {
    const term = `%${String(q).trim()}%`;
    if (field && SEARCHABLE.includes(String(field))) {
      params.push(term);
      where.push(`${field} ILIKE $${params.length}`);
    } else if (field === 'text_id') {
      params.push(String(q).trim());
      where.push(`text_id::text = $${params.length}`);
    } else {
      params.push(term);
      const p = `$${params.length}`;
      where.push('(' + SEARCHABLE.map((c) => `${c} ILIKE ${p}`).join(' OR ') + ')');
    }
  }
  if (missing && LANG_COLS.includes(String(missing))) {
    where.push(`(${missing} IS NULL OR ${missing} = '')`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countRes = await query(`SELECT count(*) AS n FROM game_texts ${whereSql}`, params);
  const total = Number(countRes.rows[0].n);

  params.push(limit, offset);
  const dataRes = await query(
    `SELECT text_id, note, cn, en, jp, cnt, kr, vn, pt, th, my, char_limit
       FROM game_texts ${whereSql}
       ORDER BY text_id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  res.json({ total, limit, offset, rows: dataRes.rows });
}));

// 단일 셀 수정 + 편집 이력 기록
app.patch('/api/texts/:id', asyncH(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const { col, value } = req.body || {};
  if (!EDITABLE.has(col)) return res.status(400).json({ error: `editable 아님: ${col}` });

  const newVal = value === '' || value == null ? null : String(value);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const cur = await client.query(`SELECT ${col} AS v FROM game_texts WHERE text_id = $1 FOR UPDATE`, [id]);
    if (cur.rowCount === 0) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'not found' }); }
    const oldVal = cur.rows[0].v;
    await client.query(`UPDATE game_texts SET ${col} = $1 WHERE text_id = $2`, [newVal, id]);
    await client.query(
      `INSERT INTO game_texts_edits (text_id, col, old_val, new_val, editor) VALUES ($1,$2,$3,$4,$5)`,
      [id, col, oldVal, newVal, req.get('X-Editor') || 'web'],
    );
    await client.query('COMMIT');
    res.json({ text_id: id, col, value: newVal, old: oldVal });
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}));

// 최근 편집 이력
app.get('/api/edits', asyncH(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { rows } = await query(
    `SELECT id, text_id, col, old_val, new_val, editor, edited_at
       FROM game_texts_edits ORDER BY id DESC LIMIT $1`,
    [limit],
  );
  res.json({ rows });
}));

async function ensureSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS game_texts_edits (
      id        BIGSERIAL PRIMARY KEY,
      text_id   BIGINT NOT NULL,
      col       TEXT NOT NULL,
      old_val   TEXT,
      new_val   TEXT,
      editor    TEXT,
      edited_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // 검색 성능용 인덱스(있으면 무시)
  await query(`CREATE INDEX IF NOT EXISTS idx_edits_text ON game_texts_edits(text_id)`);
}

ensureSchema()
  .then(() => app.listen(PORT, () => console.log(`[theplayplus-api] listening on :${PORT}`)))
  .catch((e) => { console.error('schema init failed:', e); process.exit(1); });
