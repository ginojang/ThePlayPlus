/**
 * 배치 자동 번역: text_id >= START 범위의 기존 KR 을 프롬프트(감수 규칙)+teacher few-shot 으로
 * 수정하여 game_texts.kr(원본)에 저장.
 *
 * 캐시: 같은 문장/단어(cn+en+기존KR 동일) → 동일 출력 재사용. (note 는 키에서 제외)
 *   - DB 영구 캐시 translate_cache(key PK, output) : 실행 간에도 재사용(중단 후 resume 저렴)
 *   - key = sha256(contextHash || cn || en || kr),  contextHash = sha256(model+prompt+fewshot)
 * 동시성: 고유 조합만 CONC 개 병렬로 GPT 호출.
 *
 * 사용:
 *   START=21800101 LIMIT=20 node batch-translate.js     # 스모크
 *   START=21800101 node batch-translate.js              # 전체
 *   FEWSHOT=30 CONC=5 DRY=1 ...                          # 옵션
 */
import 'dotenv/config';
import crypto from 'crypto';
import OpenAI from 'openai';
import { pool, query } from './db.js';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const START = Number(process.env.START || 21800101);
const LIMIT = Number(process.env.LIMIT || 0);
const DRY = process.env.DRY === '1';
const FEWSHOT_N = Number(process.env.FEWSHOT || 30);
const CONC = Number(process.env.CONC || 5);
const PROMPT_KEY = 'translate_prompt';
const SEP = '||';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function fmtInput({ note_kr, cn, en, kr }) {
  const p = [];
  if (note_kr) p.push(`[Note한국어] ${note_kr}`);
  if (cn) p.push(`[원문CN] ${cn}`);
  if (en) p.push(`[EN영어] ${en}`);
  p.push(`[기존 한국어] ${kr && String(kr).trim() !== '' ? kr : '(비어 있음)'}`);
  return p.join('\n');
}

async function callGPT(prompt, fewshot, row, tries = 2) {
  try {
    const resp = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      messages: [{ role: 'system', content: prompt }, ...fewshot, { role: 'user', content: fmtInput(row) }],
    });
    return (resp.choices[0].message.content || '').trim();
  } catch (e) {
    if (tries > 1) {
      await new Promise((r) => setTimeout(r, 1500));
      return callGPT(prompt, fewshot, row, tries - 1);
    }
    throw e;
  }
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 없음');
  await query(`CREATE TABLE IF NOT EXISTS translate_cache (
    key TEXT PRIMARY KEY, output TEXT NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);

  const pr = await query('SELECT value FROM app_settings WHERE key = $1', [PROMPT_KEY]);
  if (!pr.rowCount) throw new Error('app_settings 에 translate_prompt 없음');
  const prompt = pr.rows[0].value;

  const sAll = await query(
    `SELECT t.kr AS teacher_kr, t.base_kr, g.note_kr, g.cn, g.en
       FROM kr_teacher t JOIN game_texts g ON g.text_id = t.text_id`,
  );
  const chosen = [...sAll.rows]
    .sort((a, b) =>
      ((a.base_kr || '').length + (a.teacher_kr || '').length) -
      ((b.base_kr || '').length + (b.teacher_kr || '').length))
    .slice(0, FEWSHOT_N);
  const fewshot = [];
  for (const ex of chosen) {
    fewshot.push({ role: 'user', content: fmtInput({ note_kr: ex.note_kr, cn: ex.cn, en: ex.en, kr: ex.base_kr }) });
    fewshot.push({ role: 'assistant', content: ex.teacher_kr });
  }
  const contextHash = sha(MODEL + SEP + prompt + SEP + JSON.stringify(fewshot));
  const keyOf = (r) => sha(contextHash + SEP + (r.cn ?? '') + SEP + (r.en ?? '') + SEP + (r.kr ?? ''));

  const rowsRes = await query(
    `SELECT text_id, kr, note_kr, cn, en FROM game_texts
       WHERE text_id >= $1 ORDER BY text_id ${LIMIT ? `LIMIT ${LIMIT}` : ''}`,
    [START],
  );
  const rows = rowsRes.rows;

  // 고유 조합
  const combos = new Map(); // key -> {rep, out}
  for (const r of rows) {
    const k = keyOf(r);
    if (!combos.has(k)) combos.set(k, { rep: r, out: undefined });
  }
  console.log(`[batch] 대상 ${rows.length}행, 고유조합 ${combos.size}, few-shot ${chosen.length}/${sAll.rows.length}, model ${MODEL}, conc ${CONC}, DRY ${DRY}`);

  // 영구 캐시 로드 (ANY 청크)
  const allKeys = [...combos.keys()];
  let cacheHit = 0;
  for (let i = 0; i < allKeys.length; i += 1000) {
    const chunk = allKeys.slice(i, i + 1000);
    const c = await query('SELECT key, output FROM translate_cache WHERE key = ANY($1)', [chunk]);
    for (const row of c.rows) {
      const v = combos.get(row.key);
      if (v) { v.out = row.output; cacheHit++; }
    }
  }

  // 미스만 병렬 번역
  const misses = [...combos.values()].filter((v) => v.out === undefined);
  console.log(`[batch] 캐시적중 ${cacheHit}, GPT 호출 예정 ${misses.length}`);
  let done = 0;
  let idx = 0;
  async function worker() {
    while (idx < misses.length) {
      const v = misses[idx++];
      v.out = await callGPT(prompt, fewshot, v.rep);
      await query('INSERT INTO translate_cache (key, output) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [keyOf(v.rep), v.out]);
      done++;
      if (done % 50 === 0) console.log(`  ...GPT ${done}/${misses.length}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, misses.length || 1) }, worker));

  // 적용
  let updated = 0, same = 0;
  for (const r of rows) {
    const out = combos.get(keyOf(r)).out;
    if (out !== (r.kr ?? '')) {
      if (!DRY) await query('UPDATE game_texts SET kr = $1 WHERE text_id = $2', [out, r.text_id]);
      updated++;
    } else same++;
  }
  console.log(`[batch] 완료: 대상 ${rows.length} · GPT ${misses.length} · 캐시 ${cacheHit} · ${DRY ? '변경예정' : '저장'} ${updated} · 동일 ${same}`);
  await pool.end();
}

main().catch((e) => { console.error('실패:', e.message); process.exit(1); });
