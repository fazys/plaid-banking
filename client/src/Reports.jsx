import { useCallback, useEffect, useState } from 'react';
import { getReportTab, getReportTabs } from './api.js';

const KIND_ORDER = { banks: 0, summary: 1, cash_burn: 2, other: 3 };
const KIND_LABEL = { banks: 'Daily totals', summary: 'Summary', cash_burn: 'Cash burn', other: 'Sheet' };

// Sheets font sizes are in points; 10pt is the normal size.
function fontSizePx(points) {
  return `${Math.round(points * 1.3)}px`;
}

// Text with several colors/weights inside one cell (e.g. "Total money in: $5.00").
function RichText({ cell }) {
  const runs = [...cell.runs].sort((left, right) => left.start - right.start);
  return runs.map((run, index) => {
    const end = index + 1 < runs.length ? runs[index + 1].start : cell.t.length;
    const style = {
      fontWeight: run.bold ? 700 : run.bold === false ? 400 : undefined,
      color: run.color && run.color !== '#000000' ? run.color : undefined,
    };
    return (
      <span key={`${run.start}-${index}`} style={style}>
        {cell.t.slice(run.start, end)}
      </span>
    );
  });
}

function SheetCell({ cell }) {
  if (!cell) return <td />;
  const style = {
    background: cell.bg,
    color: cell.color,
    fontWeight: cell.bold ? 700 : undefined,
    fontSize: cell.size ? fontSizePx(cell.size) : undefined,
    textAlign: cell.align,
    whiteSpace: cell.wrap || (cell.t || '').includes('\n') ? 'pre-wrap' : 'nowrap',
    overflowWrap: cell.wrap ? 'anywhere' : undefined,
    borderBottom: cell.borderBottom ? '1px solid #111827' : undefined,
    borderTop: cell.borderTop ? '1px solid #111827' : undefined,
  };
  return <td style={style}>{cell.runs ? <RichText cell={cell} /> : cell.t || ''}</td>;
}

function SheetTable({ data }) {
  const width = data.columns.reduce((sum, column) => sum + column.width, 0);
  return (
    <div className="sheet-scroll">
      <table className="sheet-table" style={{ width }}>
        <colgroup>
          {data.columns.map((column, index) => (
            <col key={index} style={{ width: column.width }} />
          ))}
        </colgroup>
        <tbody>
          {data.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, columnIndex) => (
                <SheetCell key={columnIndex} cell={cell} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Admin-only page showing the Google Sheet's tabs inside the dashboard.
export default function Reports() {
  const [tabs, setTabs] = useState([]);
  const [spreadsheetUrl, setSpreadsheetUrl] = useState(null);
  const [selected, setSelected] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [loadedAt, setLoadedAt] = useState(null);

  const loadTab = useCallback(async (title) => {
    setLoading(true);
    setError(null);
    try {
      const result = await getReportTab(title);
      setData(result);
      setLoadedAt(new Date());
    } catch (loadError) {
      setError(loadError.message);
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await getReportTabs();
        if (cancelled) return;
        const list = result.tabs || [];
        setTabs(list);
        setSpreadsheetUrl(result.spreadsheet_url || null);
        const first = list.find((tab) => tab.kind === 'banks') || list[0];
        if (first) {
          setSelected(first.title);
          await loadTab(first.title);
        } else {
          setLoading(false);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError.message);
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadTab]);

  function choose(title) {
    if (!title || title === selected) return;
    setSelected(title);
    loadTab(title);
  }

  const mainTabs = tabs
    .filter((tab) => tab.kind !== 'statement')
    .sort((left, right) => (KIND_ORDER[left.kind] ?? 9) - (KIND_ORDER[right.kind] ?? 9));
  const statementTabs = tabs.filter((tab) => tab.kind === 'statement');
  const selectedIsStatement = statementTabs.some((tab) => tab.title === selected);

  return (
    <section className="card reports-card">
      <div className="reports-header">
        <div>
          <h1>Reports</h1>
          <p className="reports-subtitle">The same data as your Google Sheet, read live from the sheet.</p>
        </div>
        <div className="reports-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => selected && loadTab(selected)}
            disabled={loading || !selected}
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          {data?.url || spreadsheetUrl ? (
            <a className="sheet-link" href={data?.url || spreadsheetUrl} target="_blank" rel="noreferrer">
              Open in Google Sheets
            </a>
          ) : null}
        </div>
      </div>

      <nav className="report-tabs" aria-label="Sheet tabs">
        {mainTabs.map((tab) => (
          <button
            key={tab.title}
            type="button"
            className={tab.title === selected ? 'report-tab active' : 'report-tab'}
            onClick={() => choose(tab.title)}
            title={KIND_LABEL[tab.kind]}
          >
            {tab.title}
          </button>
        ))}
        {statementTabs.length > 0 ? (
          <label className={selectedIsStatement ? 'statement-picker active' : 'statement-picker'}>
            Statements
            <select value={selectedIsStatement ? selected : ''} onChange={(event) => choose(event.target.value)}>
              <option value="" disabled>
                Choose an account ({statementTabs.length})
              </option>
              {statementTabs.map((tab) => (
                <option key={tab.title} value={tab.title}>
                  {tab.title}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </nav>

      {error ? <p className="message error">{error}</p> : null}
      {loading && !data && !error ? <p className="empty">Loading from Google Sheets...</p> : null}
      {!error && !loading && tabs.length === 0 ? <p className="empty">The Google Sheet has no tabs yet.</p> : null}
      {data && !error ? (
        <div className={loading ? 'sheet-area is-loading' : 'sheet-area'}>
          {data.rows.length === 0 ? <p className="empty">This tab is empty.</p> : <SheetTable data={data} />}
          {loadedAt ? (
            <p className="field-help reports-loaded-at">
              {data.title} · loaded {loadedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
