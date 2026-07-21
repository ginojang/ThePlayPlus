import './dashboard.css';
import stats from './data/stats.json';

type Lang = {
  code: string;
  label: string;
  flag: string;
  filled: number;
  missing: number;
  pct: number;
};
type Sheet = { table: string; sheet: string; rows: number; cols: number };

const nf = new Intl.NumberFormat('ko-KR');

function StatTile({ value, label }: { value: string; label: string }) {
  return (
    <div className="tile">
      <div className="v">{value}</div>
      <div className="l">{label}</div>
    </div>
  );
}

export default function Dashboard() {
  const langs = [...(stats.languages as Lang[])].sort((a, b) => b.pct - a.pct);
  const sheets = stats.sheets as Sheet[];
  const maxRows = Math.max(...sheets.map((s) => s.rows));

  return (
    <div className="viz-root">
      <div className="wrap">
        <header className="head">
          <h1>여신키우기 · 번역 현황</h1>
          <p>다국어 텍스트 데이터베이스 대시보드</p>
          <div className="src">source: ThePlayPlus DB · game_texts / gt_sheets</div>
        </header>

        <section className="tiles">
          <StatTile value={nf.format(stats.total_strings)} label="총 텍스트 (문자열)" />
          <StatTile value={String(stats.languages.length)} label="추적 언어" />
          <StatTile value={String(stats.sheet_count)} label="적재 시트" />
          <StatTile value={nf.format(stats.total_sheet_rows)} label="시트 총 행 수" />
        </section>

        <section className="card">
          <h2>언어별 번역 완성도</h2>
          <p className="sub">game_texts 16,006개 문자열 대비 각 언어 채움 비율</p>
          {langs.map((l) => (
            <div
              className="bar-row"
              key={l.code}
              title={`${l.label}: ${nf.format(l.filled)} 완료 / ${nf.format(
                l.missing,
              )} 미번역 (${l.pct}%)`}
            >
              <span className="name">
                {l.flag} {l.label}
              </span>
              <div className="bar-track">
                <div className="bar-fill" style={{ width: `${Math.max(l.pct, 0.4)}%` }} />
              </div>
              <span className="bar-val">
                <span className={`pct${l.pct >= 100 ? ' full' : ''}`}>{l.pct}%</span>{' '}
                <span className="cnt">({nf.format(l.filled)})</span>
              </span>
            </div>
          ))}
        </section>

        <section className="card">
          <h2>시트 적재 현황</h2>
          <p className="sub">엑셀 21개 시트를 gt_* 테이블로 1:1 적재 (행 수 기준 정렬)</p>
          <table className="sheets">
            <thead>
              <tr>
                <th>시트</th>
                <th>테이블</th>
                <th className="minibar-cell"></th>
                <th className="num">행</th>
                <th className="num">열</th>
              </tr>
            </thead>
            <tbody>
              {sheets.map((s) => (
                <tr key={s.table} title={`${s.sheet} → ${s.table}: ${nf.format(s.rows)}행 × ${s.cols}열`}>
                  <td className="sheet-name">{s.sheet}</td>
                  <td className="sheet-table">{s.table}</td>
                  <td className="minibar-cell">
                    <div
                      className="minibar"
                      style={{ width: `${Math.max((s.rows / maxRows) * 100, 1.5)}%` }}
                    />
                  </td>
                  <td className="num">{nf.format(s.rows)}</td>
                  <td className="num">{s.cols}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="foot">단일 계열(막대 길이 = 크기) · 라이트/다크 자동 대응</div>
        </section>
      </div>
    </div>
  );
}
