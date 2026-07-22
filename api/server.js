import express from 'express';
import cors from 'cors';
import OpenAI from 'openai';
import { pool, query } from './db.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3700);

// 편집 가능한 언어/메타 컬럼 화이트리스트 (SQL 인젝션 방지: 컬럼명은 이 집합에서만)
const LANG_COLS = ['cn', 'en', 'jp', 'cnt', 'kr', 'vn', 'pt', 'th', 'my'];
const EDITABLE = new Set([...LANG_COLS, 'note', 'note_kr', 'char_limit']);
const SEARCHABLE = ['note', 'note_kr', ...LANG_COLS];

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

const PROMPT_KEY = 'translate_prompt';
const DEFAULT_PROMPT = `너는 모바일 게임 '여신키우기'의 한국어 감수자다.
[기존 한국어]를 최대한 보존하면서, 명백한 오류만 최소한으로 고친다. 새로 번역하거나 표현을 바꾸지 않는다.
입력: [Note한국어](용도 설명), [원문CN], [EN영어], [기존 한국어](대상).

절대 보존(바꾸지 말 것):
- 아이템명·무기명·방어구명·스킬명·지명·고유명사 등 '명칭'은 절대 바꾸지 않는다. 원문CN/영어와 달라 보여도 기존 한국어 명칭을 그대로 둔다.
- 수치·효과·스탯 설명 표현은 그대로 둔다. 예: '피해량이 440%로'를 '입히는 피해가 440%로'처럼 바꾸지 않는다. '피해량', '공격력', '확률', 퍼센트 등 표현·단어를 임의로 교체하지 않는다.
- 의미를 바꾸거나 문장을 다시 쓰지 않는다. 어순·표현·단어 임의 변경 금지.
- 이미 자연스러우면 그대로 둔다. (대부분은 그대로 두는 것이 정답이다.)

수정은 다음 경우에만:
- 명백한 오탈자, 띄어쓰기 오류, 조사·맞춤법 오류.
- 아래 용어 치환은 반드시 적용: '여신계약' → '여신키우기' / 사용자 호칭 '소환사' → '용사'.

형식:
- {0}, {1} 플레이스홀더와 <color=...></color>, <link=...></link> 태그, 줄바꿈(\\n), 공백·기호 서식은 원문 그대로 보존.
- 설명 없이 결과만 출력. 고칠 것이 없으면 [기존 한국어]를 그대로 출력한다.`;

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
  const { q, field, missing, teacher } = req.query;
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
  // teacher(검수 확정 KR) 있는 행만
  if (teacher === '1' || teacher === 'true') {
    where.push(`EXISTS (SELECT 1 FROM kr_teacher t WHERE t.text_id = game_texts.text_id)`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countRes = await query(`SELECT count(*) AS n FROM game_texts ${whereSql}`, params);
  const total = Number(countRes.rows[0].n);

  params.push(limit, offset);
  const dataRes = await query(
    `SELECT text_id, note, note_kr, cn, en, jp, cnt, kr, vn, pt, th, my, char_limit
       FROM game_texts ${whereSql}
       ORDER BY text_id
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const rows = dataRes.rows;
  // teacher(검수 확정 KR) 값 병합
  if (rows.length) {
    const ids = rows.map((r) => String(r.text_id));
    const tRes = await query(
      `SELECT text_id, kr FROM kr_teacher WHERE text_id = ANY($1::bigint[])`,
      [ids],
    );
    const map = new Map(tRes.rows.map((r) => [String(r.text_id), r.kr]));
    for (const r of rows) r.kr_teacher = map.get(String(r.text_id)) ?? null;
  }
  res.json({ total, limit, offset, rows });
}));

// teacher(검수 확정 KR) 업서트 — 빈 값이면 삭제
app.put('/api/teacher/:id', asyncH(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  const kr = req.body?.kr;
  const val = kr == null || String(kr).trim() === '' ? null : String(kr);

  if (val === null) {
    await query('DELETE FROM kr_teacher WHERE text_id = $1', [id]);
    return res.json({ text_id: id, kr: null });
  }
  const base = await query('SELECT kr FROM game_texts WHERE text_id = $1', [id]);
  const baseKr = base.rowCount ? base.rows[0].kr : null;
  await query(
    `INSERT INTO kr_teacher (text_id, kr, base_kr, source) VALUES ($1,$2,$3,'tool')
       ON CONFLICT (text_id) DO UPDATE SET kr = EXCLUDED.kr, source = 'tool', added_at = now()`,
    [id, val, baseKr],
  );
  res.json({ text_id: id, kr: val });
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

async function currentPrompt() {
  const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', [PROMPT_KEY]);
  return rows.length ? rows[0].value : DEFAULT_PROMPT;
}

// 입력(Note한국어/원문CN/EN영어/기존 한국어)을 few-shot 형식으로 포맷
function fmtInput({ note_kr, cn, en, kr }) {
  const p = [];
  if (note_kr) p.push(`[Note한국어] ${note_kr}`);
  if (cn) p.push(`[원문CN] ${cn}`);
  if (en) p.push(`[EN영어] ${en}`);
  p.push(`[기존 한국어] ${kr && String(kr).trim() !== '' ? kr : '(비어 있음)'}`);
  return p.join('\n');
}

// GPT 로 KR 번역 생성 (프롬프트 + teacher 전체를 few-shot 샘플로 사용). DB 저장 안 함.
app.post('/api/translate/:id', asyncH(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid id' });
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY 없음' });

  const r = await query('SELECT kr, note_kr, cn, en FROM game_texts WHERE text_id = $1', [id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'not found' });
  const target = r.rows[0];

  // teacher(검수 확정) 전체를 few-shot 예시로: 입력(note/cn/en + 수정 전 base_kr) → 출력(수정 후 teacher kr)
  const s = await query(
    `SELECT t.kr AS teacher_kr, t.base_kr, g.note_kr, g.cn, g.en
       FROM kr_teacher t JOIN game_texts g ON g.text_id = t.text_id
       ORDER BY t.text_id`,
  );

  const prompt = await currentPrompt();
  const messages = [{ role: 'system', content: prompt }];
  for (const ex of s.rows) {
    messages.push({
      role: 'user',
      content: fmtInput({ note_kr: ex.note_kr, cn: ex.cn, en: ex.en, kr: ex.base_kr }),
    });
    messages.push({ role: 'assistant', content: ex.teacher_kr });
  }
  messages.push({ role: 'user', content: fmtInput(target) });

  const resp = await openai.chat.completions.create({
    model: OPENAI_MODEL,
    temperature: 0.2,
    messages,
  });
  const out = (resp.choices[0].message.content || '').trim();
  // 결과만 반환 (DB 저장 안 함). base = 기존 KR (팝업 비교용).
  res.json({ text_id: id, kr: out, base: target.kr, samples: s.rows.length, model: OPENAI_MODEL });
}));

// 번역 프롬프트 조회/저장
app.get('/api/prompt', asyncH(async (_req, res) => {
  const { rows } = await query('SELECT value FROM app_settings WHERE key = $1', [PROMPT_KEY]);
  res.json({ prompt: rows.length ? rows[0].value : DEFAULT_PROMPT, default: DEFAULT_PROMPT });
}));

app.put('/api/prompt', asyncH(async (req, res) => {
  const prompt = String(req.body?.prompt ?? '');
  await query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [PROMPT_KEY, prompt],
  );
  res.json({ prompt });
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
  await query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

ensureSchema()
  .then(() => app.listen(PORT, () => console.log(`[theplayplus-api] listening on :${PORT}`)))
  .catch((e) => { console.error('schema init failed:', e); process.exit(1); });
