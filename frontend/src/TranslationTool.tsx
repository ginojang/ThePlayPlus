import { useCallback, useEffect, useRef, useState } from 'react';
import './tool.css';
import { getStats, getTexts, patchCell, type Row, type LangStat } from './api';

const nf = new Intl.NumberFormat('ko-KR');

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

export default function TranslationTool() {
  const [stats, setStats] = useState<{ total_strings: number; languages: LangStat[] } | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [savedCount, setSavedCount] = useState(0);

  const [q, setQ] = useState('');
  const [field, setField] = useState('');
  const [missing, setMissing] = useState('');
  const [limit, setLimit] = useState(100);
  const [offset, setOffset] = useState(0);
  // EN 이후 7개 언어 중 표시할 하나 (헤더 드롭다운으로 선택)
  const [activeTarget, setActiveTarget] = useState<keyof Row>('en');

  const refreshStats = useCallback(() => {
    getStats().then(setStats).catch(() => {});
  }, []);

  useEffect(() => {
    refreshStats();
  }, [refreshStats]);

  // 검색어 디바운스
  const [qDebounced, setQDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 350);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    setOffset(0);
  }, [qDebounced, field, missing, limit]);

  useEffect(() => {
    setLoading(true);
    getTexts({ q: qDebounced, field, missing, limit, offset })
      .then((d) => {
        setRows(d.rows);
        setTotal(d.total);
        setErr('');
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  }, [qDebounced, field, missing, limit, offset]);

  const onSaved = (id: number, col: keyof Row, v: string) => {
    setRows((rs) => rs.map((r) => (r.text_id === id ? { ...r, [col]: v === '' ? null : v } : r)));
    setSavedCount((n) => n + 1);
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
            {stats?.languages.map((l) => (
              <button
                key={l.code}
                className={`chip ${l.pct >= 100 ? 'full' : l.pct < 50 ? 'low' : ''}`}
                title={`${l.label}: ${nf.format(l.filled)} 완료 / ${nf.format(l.missing)} 미번역 — 클릭 시 미번역만 보기`}
                onClick={() => setMissing((m) => (m === l.code ? '' : l.code))}
                style={missing === l.code ? { outline: '2px solid var(--accent)' } : undefined}
              >
                {l.flag} <b>{l.pct}%</b>
              </button>
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
          <select value={missing} onChange={(e) => setMissing(e.target.value)} title="미번역 필터">
            <option value="">미번역 필터: 없음</option>
            {TARGETS.map((t) => (
              <option key={t.col} value={t.col as string}>
                미번역: {t.label}
              </option>
            ))}
          </select>

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
      </div>

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
              <col style={{ width: 60 }} />{/* 제한 */}
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
                <th>제한</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.text_id}>
                  <td className="id">{r.text_id}</td>
                  <td className="note">{r.note}</td>
                  <EditableCell row={r} col="note_kr" onSaved={onSaved} onError={setErr} />
                  <td className="src">{r.cn}</td>
                  <EditableCell
                    row={r}
                    col={KR.col}
                    onSaved={onSaved}
                    onError={setErr}
                    tdClass="kr-col"
                  />
                  <EditableCell
                    key={activeTarget}
                    row={r}
                    col={activeTarget}
                    onSaved={onSaved}
                    onError={setErr}
                  />
                  <td className="lim">{r.char_limit}</td>
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
