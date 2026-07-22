// 프로덕션: nginx 가 /theplayplus/api/ 를 hellcat 백엔드로 프록시.
// 개발: vite.config 의 proxy 가 /theplayplus/api → localhost:3700 로 전달.
const API = import.meta.env.VITE_API_BASE || '/theplayplus/api';

export type Row = {
  text_id: number;
  note: string | null;
  note_kr: string | null;
  kr_teacher: string | null;
  cn: string | null;
  en: string | null;
  jp: string | null;
  cnt: string | null;
  kr: string | null;
  vn: string | null;
  pt: string | null;
  th: string | null;
  my: string | null;
  char_limit: string | null;
};

export type Lang = { code: string; label: string; flag: string };
export type LangStat = Lang & { filled: number; missing: number; pct: number };

export type ListParams = {
  q?: string;
  field?: string;
  teacher?: boolean;
  limit: number;
  offset: number;
};

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<T>;
}

export const getStats = () =>
  fetch(`${API}/stats`).then(j<{ total_strings: number; languages: LangStat[] }>);

export function getTexts(p: ListParams) {
  const u = new URLSearchParams();
  if (p.q) u.set('q', p.q);
  if (p.field) u.set('field', p.field);
  if (p.teacher) u.set('teacher', '1');
  u.set('limit', String(p.limit));
  u.set('offset', String(p.offset));
  return fetch(`${API}/texts?${u}`).then(
    j<{ total: number; limit: number; offset: number; rows: Row[] }>,
  );
}

export function patchCell(id: number, col: string, value: string) {
  return fetch(`${API}/texts/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ col, value }),
  }).then(j<{ text_id: number; col: string; value: string | null; old: string | null }>);
}

export const getPrompt = () =>
  fetch(`${API}/prompt`).then(j<{ prompt: string; default: string }>);

export function putPrompt(prompt: string) {
  return fetch(`${API}/prompt`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt }),
  }).then(j<{ prompt: string }>);
}

// teacher(검수 확정 KR) 저장 — 빈 값이면 삭제
export function putTeacher(id: number, kr: string) {
  return fetch(`${API}/teacher/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kr }),
  }).then(j<{ text_id: number; kr: string | null }>);
}
