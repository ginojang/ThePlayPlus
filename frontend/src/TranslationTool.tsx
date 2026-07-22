import { useCallback, useEffect, useRef, useState } from 'react';
import './tool.css';
import {
  getStats,
  getTexts,
  patchCell,
  putTeacher,
  clearFlag,
  translateRow,
  getPrompt,
  putPrompt,
  type Row,
  type Stats,
  type TranslateResult,
} from './api';

const nf = new Intl.NumberFormat('ko-KR');

// 검수 경계: 여기(초특가)까지 수동 검수, 다음(일일 구매 제한)부터 자동 검수
const MANUAL_END_ID = 11140503; // '초특가'
const AUTO_START_ID = 11140504; // '일일 구매 제한'

// 마지막 검색/필터/페이지 위치를 기억 (새로고침 후 복원)
const VIEW_KEY = 'tpp_view_v1';
type ViewState = { q: string; field: string; teacherOnly: boolean; flaggedOnly: boolean; limit: number; offset: number };
function loadView(): Partial<ViewState> {
  try {
    return JSON.parse(localStorage.getItem(VIEW_KEY) || '{}');
  } catch {
    return {};
  }
}

// KR 한국어 = 주 번역 대상. 원문 CN 바로 오른쪽에 배치 + 배경색 강조.
const KR: { col: keyof Row; label: string } = { col: 'kr', label: 'KR 한국어' };
// 나머지 편집 대상 언어 컬럼 (원문 CN 은 읽기전용 소스)
const TARGETS: { col: keyof Row; label: string }[] = [
  { col: 'en', label: 'EN 영어' },
  { col: 'jp', label: 'JP 일본어' },
  { col: 'cnt', label: 'CNT 번체' },
  { col: 'vn', label: 'VN 베트남' },
  { col: 'pt', label: 'PT 포르투갈' },
  { col: 'th', label: 'TH 태국' },
  { col: 'my', label: 'MY 말레이' },
];
const SEARCH_FIELDS = [
  { v: '', label: '전체' },
  { v: 'text_id', label: 'ID' },
  { v: 'cn', label: '원문(CN)' },
  { v: KR.col as string, label: KR.label },
  ...TARGETS.map((t) => ({ v: t.col as string, label: t.label })),
  { v: 'note', label: 'Note' },
];

function EditableCell({
  row,
  col,
  onSaved,
  onError,
  tdClass = '',
}: {
  row: Row;
  col: keyof Row;
  onSaved: (id: number, col: keyof Row, v: string) => void;
  onError: (msg: string) => void;
  tdClass?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const initial = (row[col] as string | null) ?? '';
  const [status, setStatus] = useState<'' | 'saving' | 'saved' | 'error'>('');

  useEffect(() => {
    if (ref.current && ref.current.textContent !== initial) ref.current.textContent = initial;
  }, [row.text_id, col, initial]);

  const save = async () => {
    const v = ref.current?.textContent ?? '';
    if (v === initial) return;
    setStatus('saving');
    try {
      await patchCell(row.text_id, col as string, v);
      setStatus('saved');
      onSaved(row.text_id, col, v);
      setTimeout(() => setStatus(''), 700);
    } catch (e) {
      setStatus('error');
      onError(`저장 실패 (id=${row.text_id}, ${String(col)}): ${(e as Error).message}`);
    }
  };

  const empty = initial === '';
  return (
    <td className={`editable ${tdClass} ${empty ? 'empty' : ''} ${status}`}>
      <div
        className="cell"
        contentEditable
        suppressContentEditableWarning
        ref={ref}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            ref.current?.blur();
          } else if (e.key === 'Escape') {
            if (ref.current) ref.current.textContent = initial;
            ref.current?.blur();
          }
        }}
      />
    </td>
  );
}

// KR 한국어 셀: 기본 KR(읽기전용) + teacher 서브셀 + [티쳐수정] 버튼
function KrCell({
  row,
  draft,
  onTeacherSaved,
  onClearDraft,
  onFlagCleared,
  onError,
}: {
  row: Row;
  draft?: string;
  onTeacherSaved: (id: number, kr: string | null) => void;
  onClearDraft?: (id: number) => void;
  onFlagCleared?: (id: number) => void;
  onError: (msg: string) => void;
}) {
  const base = row.kr ?? '';
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<'' | 'saving' | 'saved' | 'error'>('');
  const ref = useRef<HTMLDivElement>(null);
  const teacher = row.kr_teacher;
  const hasTeacher = teacher != null && teacher !== '';
  const hasDraft = draft != null;

  // GPT 초안(draft)이 오면 편집 모드로 진입
  useEffect(() => {
    if (hasDraft) setEditing(true);
  }, [hasDraft]);

  // 편집 시작 시 서브셀 내용 초기화 (초안 있으면 초안, 없으면 teacher, 없으면 기본 KR)
  useEffect(() => {
    if (editing && ref.current)
      ref.current.textContent = hasDraft ? (draft as string) : hasTeacher ? (teacher as string) : base;
  }, [editing, draft, hasDraft, teacher, hasTeacher, base]);

  // 행이 바뀌면 편집상태 해제
  useEffect(() => {
    setEditing(false);
  }, [row.text_id]);

  const cancel = () => {
    setEditing(false);
    if (hasDraft) onClearDraft?.(row.text_id);
  };

  const save = async () => {
    const v = ref.current?.textContent ?? '';
    setStatus('saving');
    try {
      const r = await putTeacher(row.text_id, v);
      onTeacherSaved(row.text_id, r.kr);
      if (hasDraft) onClearDraft?.(row.text_id);
      setEditing(false);
      setStatus('saved');
      setTimeout(() => setStatus(''), 700);
    } catch (e) {
      setStatus('error');
      onError(`teacher 저장 실패 (id=${row.text_id}): ${(e as Error).message}`);
    }
  };

  // 검수 구간: 처음~초특가(11140503) 수동, 일일 구매 제한(11140504)~끝 자동
  const region = row.text_id <= MANUAL_END_ID ? 'region-manual' : 'region-auto';
  const boundaryTitle =
    row.text_id === MANUAL_END_ID
      ? '↑ 여기까지 수동 검수'
      : row.text_id === AUTO_START_ID
        ? '↓ 여기부터 자동 검수'
        : undefined;

  return (
    <td
      className={`kr-col ${region} ${row.flagged ? 'flagged' : ''} ${base === '' ? 'empty' : ''} ${status}`}
      title={boundaryTitle}
    >
      {row.flagged && (
        <div className="flag-bar">
          <span className="flag-tag" title="자동 다듬기로 문구가 바뀐 행 — 검토 필요">⚑ 검토</span>
          {row.flag_before != null && row.flag_before !== base && (
            <span className="flag-before" title="자동 수정 전 원본">전: {row.flag_before}</span>
          )}
          <button
            className="tbtn"
            title="검토 완료 — 마킹 해제"
            onClick={async () => {
              try {
                await clearFlag(row.text_id);
                onFlagCleared?.(row.text_id);
              } catch (e) {
                onError(`마킹 해제 실패 (id=${row.text_id}): ${(e as Error).message}`);
              }
            }}
          >
            검토완료
          </button>
        </div>
      )}
      <div className="kr-base" title="기본 KR (읽기 전용)">
        {base}
      </div>
      {(hasTeacher || editing) && (
        <div className={`kr-teacher ${editing ? 'editing' : ''} ${hasDraft ? 'draft' : ''}`}>
          <span className="kr-teacher-tag">{hasDraft ? 'GPT' : 'T'}</span>
          {editing ? (
            <div
              className="kr-teacher-edit"
              contentEditable
              suppressContentEditableWarning
              ref={ref}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  save();
                } else if (e.key === 'Escape') {
                  setEditing(false);
                }
              }}
            />
          ) : (
            <span className="kr-teacher-val">{teacher}</span>
          )}
        </div>
      )}
      <div className="kr-actions">
        {editing ? (
          <>
            <button className="tbtn primary" onMouseDown={(e) => e.preventDefault()} onClick={save}>
              저장
            </button>
            <button className="tbtn" onClick={cancel}>
              취소
            </button>
          </>
        ) : (
          <button className="tbtn" onClick={() => setEditing(true)}>
            {hasTeacher ? '티쳐수정' : '＋티쳐'}
          </button>
        )}
      </div>
    </td>
  );
}

// 각 줄 번역 버튼: GPT 로 KR 번역 생성 → 결과 팝업 (DB 저장 안 함)
function TranslateButton({
  row,
  onResult,
  onError,
}: {
  row: Row;
  onResult: (r: TranslateResult) => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      onResult(await translateRow(row.text_id));
    } catch (e) {
      onError(`번역 실패 (id=${row.text_id}): ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <td className="trans">
      <button className="tbtn" onClick={run} disabled={busy} title="GPT 번역 결과를 팝업으로 표시">
        {busy ? '⏳' : '번역'}
      </button>
    </td>
  );
}

// 번역 결과 팝업 — 확인 후 원본 KR(game_texts.kr) 저장
function ResultModal({
  data,
  onClose,
  onSaved,
  onReload,
}: {
  data: TranslateResult;
  onClose: () => void;
  onSaved: (id: number, col: keyof Row, v: string) => void;
  onReload: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [text, setText] = useState(data.kr);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState('');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };
  const save = async () => {
    setSaving(true);
    setErr('');
    try {
      await patchCell(data.text_id, 'kr', text);
      onSaved(data.text_id, 'kr', text);
      onReload(); // 저장 후 홈페이지(테이블) 자동 리프레시
      setSaved(true);
      setTimeout(onClose, 600);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>GPT 번역 결과 · id {data.text_id}</h2>
          <button className="tbtn" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="modal-sub">
          모델 {data.model} · teacher 샘플 {data.samples}건 사용 · 저장 시 원본 KR(game_texts)이 갱신됩니다
        </p>
        <div className="result-block">
          <div className="result-label">기존 KR</div>
          <div className="result-box base">{data.base || '(없음)'}</div>
        </div>
        <div className="result-block">
          <div className="result-label">GPT 번역 (저장 전 수정 가능)</div>
          <textarea
            className="result-box out edit"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="modal-foot">
          {err && <span style={{ color: '#d03b3b' }}>⚠ {err}</span>}
          {saved && <span style={{ color: 'var(--good)' }}>저장됨 ✓</span>}
          <div style={{ flex: 1 }} />
          <button className="tbtn" onClick={copy}>
            {copied ? '복사됨 ✓' : '복사'}
          </button>
          <button className="tbtn" onClick={onClose}>
            닫기
          </button>
          <button className="tbtn primary" onClick={save} disabled={saving || saved}>
            {saving ? '저장 중…' : '원본 KR 저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

// 번역 프롬프트 편집 모달
function PromptModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [def, setDef] = useState('');
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<'' | 'saving' | 'saved' | 'error'>('');
  const [err, setErr] = useState('');

  useEffect(() => {
    getPrompt()
      .then((d) => {
        setText(d.prompt);
        setDef(d.default);
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setStatus('saving');
    try {
      await putPrompt(text);
      setStatus('saved');
      setTimeout(() => onClose(), 500);
    } catch (e) {
      setStatus('error');
      setErr((e as Error).message);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>번역 프롬프트 편집</h2>
          <button className="tbtn" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="modal-sub">
          GPT 번역에 사용되는 시스템 프롬프트입니다. 원문→한국어 번역 규칙을 정의하세요.
        </p>
        {loading ? (
          <div className="loading">불러오는 중…</div>
        ) : (
          <textarea
            className="prompt-area"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
        )}
        <div className="modal-foot">
          <button className="tbtn" onClick={() => setText(def)} disabled={loading}>
            기본값으로 되돌리기
          </button>
          <div style={{ flex: 1 }} />
          {err && <span className="err" style={{ color: '#d03b3b' }}>⚠ {err}</span>}
          {status === 'saved' && <span style={{ color: 'var(--good)' }}>저장됨</span>}
          <button className="tbtn" onClick={onClose}>
            취소
          </button>
          <button className="tbtn primary" onClick={save} disabled={loading || status === 'saving'}>
            {status === 'saving' ? '저장 중…' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TranslationTool() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [savedCount, setSavedCount] = useState(0);

  const saved0 = useRef(loadView()).current;
  const [q, setQ] = useState(saved0.q ?? '');
  const [field, setField] = useState(saved0.field ?? '');
  const [teacherOnly, setTeacherOnly] = useState(saved0.teacherOnly ?? false);
  const [flaggedOnly, setFlaggedOnly] = useState(saved0.flaggedOnly ?? false);
  const [limit, setLimit] = useState(saved0.limit ?? 100);
  const [offset, setOffset] = useState(saved0.offset ?? 0);
  // EN 이후 7개 언어 중 표시할 하나 (헤더 드롭다운으로 선택)
  const [activeTarget, setActiveTarget] = useState<keyof Row>('en');
  const [promptOpen, setPromptOpen] = useState(false);
  const [result, setResult] = useState<TranslateResult | null>(null);
  // 저장 후 현재 페이지를 DB 에서 다시 불러오기 위한 트리거
  const [reloadKey, setReloadKey] = useState(0);
  const reload = () => setReloadKey((k) => k + 1);

  const refreshStats = useCallback(() => {
    getStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

  // 검색어 디바운스 (복원 시 초기값도 저장된 q)
  const [qDebounced, setQDebounced] = useState(saved0.q ?? '');
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 350);
    return () => clearTimeout(t);
  }, [q]);

  // 검색/필터 변경 시 첫 페이지로 — 단, 최초 마운트(복원)에서는 offset 유지
  const firstReset = useRef(true);
  useEffect(() => {
    if (firstReset.current) {
      firstReset.current = false;
      return;
    }
    setOffset(0);
  }, [qDebounced, field, teacherOnly, flaggedOnly, limit]);

  // 뷰 상태를 localStorage 에 저장 (위치 기억)
  useEffect(() => {
    localStorage.setItem(VIEW_KEY, JSON.stringify({ q, field, teacherOnly, flaggedOnly, limit, offset }));
  }, [q, field, teacherOnly, flaggedOnly, limit, offset]);

  useEffect(() => {
    setLoading(true);
    getTexts({ q: qDebounced, field, teacher: teacherOnly, flagged: flaggedOnly, limit, offset })
      .then((d) => {
        setRows(d.rows);
        setTotal(d.total);
        setErr('');
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [qDebounced, field, teacherOnly, flaggedOnly, limit, offset, reloadKey]);

  const onSaved = (id: number, col: keyof Row, v: string) => {
    setRows((rs) => rs.map((r) => (r.text_id === id ? { ...r, [col]: v === '' ? null : v } : r)));
    setSavedCount((n) => n + 1);
    refreshStats();
  };

  const onTeacherSaved = (id: number, kr: string | null) => {
    setRows((rs) => rs.map((r) => (r.text_id === id ? { ...r, kr_teacher: kr } : r)));
    setSavedCount((n) => n + 1);
  };

  const onFlagCleared = (id: number) => {
    setRows((rs) => rs.map((r) => (r.text_id === id ? { ...r, flagged: false } : r)));
    refreshStats();
  };

  const page = Math.floor(offset / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + rows.length, total);

  return (
    <div className="tool">
      <div className="topbar">
        <div className="row1">
          <h1>여신키우기 · 번역 툴</h1>
          <span className="sub">game_texts · {stats ? nf.format(stats.total_strings) : '…'}개 문자열</span>
          <div className="chips">
            {stats?.flags && stats.flags.baseline > 0 && (
              <span
                className="review-prog"
                title={`검토 필요 ${nf.format(stats.flags.remaining)} · 완료 ${nf.format(stats.flags.reviewed)} / ${nf.format(stats.flags.baseline)}`}
              >
                <span className="rp-label">
                  ⚑ 검토 {nf.format(stats.flags.reviewed)}/{nf.format(stats.flags.baseline)}
                </span>
                <span className="rp-bar">
                  <span
                    className="rp-fill"
                    style={{ width: `${(stats.flags.reviewed / stats.flags.baseline) * 100}%` }}
                  />
                </span>
              </span>
            )}
            {stats?.languages.map((l) => (
              <span
                key={l.code}
                className={`chip ${l.pct >= 100 ? 'full' : l.pct < 50 ? 'low' : ''}`}
                title={`${l.label}: ${nf.format(l.filled)} 완료 / ${nf.format(l.missing)} 미번역`}
              >
                {l.flag} <b>{l.pct}%</b>
              </span>
            ))}
          </div>
        </div>

        <div className="controls">
          <input
            type="text"
            placeholder="검색어…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select value={field} onChange={(e) => setField(e.target.value)} title="검색 대상">
            {SEARCH_FIELDS.map((f) => (
              <option key={f.v} value={f.v}>
                검색: {f.label}
              </option>
            ))}
          </select>
          <button
            className={`toggle-btn ${teacherOnly ? 'on' : ''}`}
            onClick={() => setTeacherOnly((v) => !v)}
            title="검수 확정(teacher)이 있는 행만 보기"
          >
            {teacherOnly ? '✓ ' : ''}티쳐 수정본만
          </button>
          <button
            className={`toggle-btn flag ${flaggedOnly ? 'on' : ''}`}
            onClick={() => setFlaggedOnly((v) => !v)}
            title="검토 필요로 마킹된 행만 보기"
          >
            {flaggedOnly ? '✓ ' : '⚑ '}검토 필요만
          </button>

          <div className="spacer" />
          <span className="pageinfo">
            {nf.format(from)}–{nf.format(to)} / {nf.format(total)} · {page}/{pages}p
          </span>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} title="페이지 크기">
            {[50, 100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {n}행
              </option>
            ))}
          </select>
          <button disabled={offset === 0} onClick={() => setOffset(0)}>
            « 처음
          </button>
          <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>
            ‹ 이전
          </button>
          <button disabled={to >= total} onClick={() => setOffset(offset + limit)}>
            다음 ›
          </button>
        </div>

        <div className="promptbar">
          <button className="tbtn" onClick={() => setPromptOpen(true)}>
            ⚙ 프롬프트 편집
          </button>
        </div>
      </div>

      {promptOpen && <PromptModal onClose={() => setPromptOpen(false)} />}
      {result && (
        <ResultModal
          data={result}
          onClose={() => setResult(null)}
          onSaved={onSaved}
          onReload={reload}
        />
      )}

      <div className="tablewrap">
        {loading && rows.length === 0 ? (
          <div className="loading">불러오는 중…</div>
        ) : (
          <table className="grid">
            <colgroup>
              <col style={{ width: 76 }} />{/* ID */}
              <col style={{ width: 170 }} />{/* Note */}
              <col style={{ width: 170 }} />{/* Note 한국어 */}
              <col style={{ width: 260 }} />{/* 원문 CN */}
              <col style={{ width: 260 }} />{/* KR 한국어 */}
              <col style={{ width: 260 }} />{/* 선택 언어 */}
              <col style={{ width: 84 }} />{/* 번역 */}
            </colgroup>
            <thead>
              <tr>
                <th style={{ position: 'sticky', left: 0, zIndex: 12 }}>ID</th>
                <th>Note</th>
                <th className="tgt">Note 한국어</th>
                <th>원문 CN</th>
                <th className="tgt kr-col">{KR.label}</th>
                <th className="tgt">
                  <select
                    className="col-select"
                    value={activeTarget as string}
                    onChange={(e) => setActiveTarget(e.target.value as keyof Row)}
                    title="표시할 언어 선택"
                  >
                    {TARGETS.map((t) => (
                      <option key={t.col} value={t.col as string}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </th>
                <th>번역</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.text_id}>
                  <td className="id">{r.text_id}</td>
                  <td className="note">{r.note}</td>
                  <EditableCell row={r} col="note_kr" onSaved={onSaved} onError={setErr} />
                  <td className="src">{r.cn}</td>
                  <KrCell
                    row={r}
                    onTeacherSaved={onTeacherSaved}
                    onFlagCleared={onFlagCleared}
                    onError={setErr}
                  />
                  <EditableCell
                    key={activeTarget}
                    row={r}
                    col={activeTarget}
                    onSaved={onSaved}
                    onError={setErr}
                  />
                  <TranslateButton row={r} onResult={setResult} onError={setErr} />
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="statusbar">
        <span>
          <span className="legend-missing" /> 미번역 셀
        </span>
        <span>편집 후 셀 밖 클릭(또는 Ctrl+Enter)으로 저장 · Esc 취소</span>
        <div style={{ flex: 1 }} />
        {savedCount > 0 && <span className="dot">● {nf.format(savedCount)}건 저장됨</span>}
        {err && <span className="err">⚠ {err}</span>}
      </div>
    </div>
  );
}
