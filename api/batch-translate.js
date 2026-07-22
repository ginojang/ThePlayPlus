/**
 * 배치 자동 번역: text_id >= START 범위의 기존 KR 을 프롬프트(감수 규칙)+teacher few-shot 으로
 * 수정하여 game_texts.kr(원본)에 저장. 서버 /api/translate 와 동일한 입력/규칙.
 *
 * 캐시: 같은 문장/단어(cn+en+기존KR 동일) → 동일 출력 재사용. (note 는 키에서 제외)
 *   - DB 영구 캐시 translate_cache(key PK, output) : 실행 간에도 재사용
 *   - 인메모리 Map : 실행 내 중복 즉시 재사용
 *   - key = sha256(contextHash || cn || en || kr),  contextHash = sha256(model+prompt+fewshot)
 *     → 프롬프트/teacher/모델이 바뀌면 캐시 자동 무효화
 *
 * 사용:
 *   START=21800101 LIMIT=20 node batch-translate.js        # 스모크 20개
 *   START=21800101 node batch-translate.js                  # 전체
 *   DRY=1 ... node batch-translate.js                       # 저장 안 하고 미리보기
 */
import 'dotenv/config';
import crypto from 'crypto';
import OpenAI from 'openai';
import { pool, query } from './db.js';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const START = Number(process.env.START || 21800101);
const LIMIT = Number(process.env.LIMIT || 0); // 0 = 전체
const DRY = process.env.DRY === '1';
const PROMPT_KEY = 'translate_prompt';
const SEP = '';

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

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 없음');

  await query(`CREATE TABLE IF NOT EXISTS translate_cache (
    key TEXT PRIMARY KEY, output TEXT NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`);

  const pr = await query('SELECT value FROM app_settings WHERE key = $1', [PROMPT_KEY]);
  if (!pr.rowCount) throw new Error('app_settings 에 translate_prompt 없음 (툴에서 프롬프트 저장 필요)');
  const prompt = pr.rows[0].value;

  // teacher 전체 → few-shot (base_kr → teacher kr)
  const s = await query(
    `SELECT t.kr AS teacher_kr, t.base_kr, g.note_kr, g.cn, g.en
       FROM kr_teacher t JOIN game_texts g ON g.text_id = t.text_id ORDER BY t.text_id`,
  );
  const fewshot = [];
  for (const ex of s.rows) {
    fewshot.push({ role: 'user', content: fmtInput({ note_kr: ex.note_kr, cn: ex.cn, en: ex.en, kr: ex.base_kr }) });
    fewshot.push({ role: 'assistant', content: ex.teacher_kr });
  }
  const contextHash = sha(MODEL + SEP + prompt + SEP + JSON.stringify(fewshot));

  const rowsRes = await query(
    `SELECT text_id, kr, note_kr, cn, en FROM game_texts
       WHERE text_id >= $1 ORDER BY text_id ${LIMIT ? `LIMIT ${LIMIT}` : ''}`,
    [START],
  );
  const rows = rowsRes.rows;
  console.log(
    `[batch] 대상 ${rows.length}행 (start=${START}, model=${MODEL}, few-shot=${s.rows.length}, DRY=${DRY})`,
  );

  const mem = new Map();
  let calls = 0, hits = 0, updated = 0, same = 0;
  const preview = [];

  for (const r of rows) {
    // 캐시 키: note 제외 (cn + en + 기존KR) → 같은 문장/단어 재사용
    const key = sha(contextHash + SEP + (r.cn ?? '') + SEP + (r.en ?? '') + SEP + (r.kr ?? ''));
    let out = mem.get(key);
    if (out === undefined) {
      const c = await query('SELECT output FROM translate_cache WHERE key = $1', [key]);
      if (c.rowCount) { out = c.rows[0].output; hits++; }
    } else {
      hits++;
    }
    if (out === undefined) {
      const resp = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: prompt },
          ...fewshot,
          { role: 'user', content: fmtInput(r) },
        ],
      });
      out = (resp.choices[0].message.content || '').trim();
      calls++;
      await query('INSERT INTO translate_cache (key, output) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING', [key, out]);
    }
    mem.set(key, out);

    const changed = out !== (r.kr ?? '');
    if (!DRY && changed) {
      await query('UPDATE game_texts SET kr = $1 WHERE text_id = $2', [out, r.text_id]);
    }
    if (changed) updated++; else same++;
    if (preview.length < 20) preview.push({ id: r.text_id, before: r.kr, after: out, changed });

    if ((calls + hits) % 50 === 0)
      console.log(`  ...진행 ${calls + hits}/${rows.length}  (GPT ${calls}, 캐시 ${hits})`);
  }

  console.log('\n=== 미리보기 (최대 20건) ===');
  for (const p of preview) {
    console.log(`id=${p.id} ${p.changed ? '✎' : '='}`);
    console.log(`  전: ${p.before}`);
    console.log(`  후: ${p.after}`);
  }
  console.log(
    `\n[batch] 완료: 대상 ${rows.length} · GPT호출 ${calls} · 캐시적중 ${hits} · ${DRY ? '변경예정' : '저장'} ${updated} · 동일 ${same}`,
  );
  await pool.end();
}

main().catch((e) => { console.error('실패:', e.message); process.exit(1); });
