/**
 * game_texts.note (중국어 설명) → 한국어 번역 → note_kr 컬럼 채우기.
 * OpenAI mini 사용. 고유 note 만 번역 후 같은 note 를 가진 모든 행을 갱신(비용 절감).
 * 멱등: note_kr 이 이미 있는 note 는 건너뜀.
 *
 * 실행: cd api && node translate-notes.js            (전체)
 *       LIMIT_NOTES=50 node translate-notes.js       (앞 50개만 — 검증용)
 */
import 'dotenv/config';
import OpenAI from 'openai';
import { pool, query } from './db.js';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const BATCH = Number(process.env.NOTE_BATCH || 40);
const LIMIT = Number(process.env.LIMIT_NOTES || 0); // 0 = 전체

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYS = `너는 게임 개발용 내부 설명 태그를 한국어로 번역한다.
입력은 중국어 짧은 라벨 배열이다(하이픈으로 구분된 분류 태그가 많음).
각 항목을 자연스럽고 간결한 한국어로 번역하라. 태그 구조(-)는 유지한다.
고유명사/스킬명은 의미가 드러나게 옮기되 과하게 풀어쓰지 않는다.
반드시 {"t":[...]} JSON 으로, 입력과 같은 순서/개수로만 응답한다.`;

async function translateBatch(items) {
  const resp = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYS },
      { role: 'user', content: JSON.stringify({ items }) },
    ],
  });
  const out = JSON.parse(resp.choices[0].message.content);
  const t = out.t || out.translations || [];
  if (!Array.isArray(t) || t.length !== items.length) {
    throw new Error(`count ${items.length}→${t.length}`);
  }
  return t;
}

// 개수 불일치 시 반으로 쪼개 재귀 (1개 단위는 항상 1:1 보장)
async function robustTranslate(items) {
  try {
    return await translateBatch(items);
  } catch (e) {
    if (items.length <= 1) {
      // 단일 항목도 실패하면 원문 유지(빈값)로 두지 않도록 한번 더, 그래도 실패면 throw
      return await translateBatch(items);
    }
    const mid = Math.floor(items.length / 2);
    const [a, b] = await Promise.all([
      robustTranslate(items.slice(0, mid)),
      robustTranslate(items.slice(mid)),
    ]);
    return [...a, ...b];
  }
}

async function main() {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY 없음');
  const { rows } = await query(
    `SELECT DISTINCT note FROM game_texts
      WHERE note IS NOT NULL AND note <> ''
        AND (note_kr IS NULL OR note_kr = '')
      ORDER BY note ${LIMIT ? `LIMIT ${LIMIT}` : ''}`,
  );
  const notes = rows.map((r) => r.note);
  console.log(`[translate-notes] 대상 고유 note: ${notes.length} (model=${MODEL}, batch=${BATCH})`);

  let done = 0;
  for (let i = 0; i < notes.length; i += BATCH) {
    const chunk = notes.slice(i, i + BATCH);
    const translated = await robustTranslate(chunk);
    // 각 note → 같은 note 를 가진 모든 행 갱신
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let k = 0; k < chunk.length; k++) {
        await client.query(
          `UPDATE game_texts SET note_kr = $1 WHERE note = $2 AND (note_kr IS NULL OR note_kr = '')`,
          [translated[k], chunk[k]],
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    done += chunk.length;
    if (done % 200 === 0 || done === notes.length) {
      console.log(`  진행: ${done}/${notes.length}`);
    }
  }
  console.log('[translate-notes] ✅ 완료');
  await pool.end();
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
