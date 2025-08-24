import React, { useEffect, useState, useRef, useMemo } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import './App.css';

// Excel-like view of sequences: compact tables, search, filters, CSV export and a row detail modal
// Updated: lists are sorted so NEWER rows appear on top.
export default function SequencerRealtime({
  pollInterval = 5000,
  socketUrl = null,
  leftSequenceUrl = 'http://10.40.40.215:3000/api/sequence',
  rightSequenceUrl = 'http://10.40.40.215:3000/api/sequence/right'
}) {
  const [leftRows, setLeftRows] = useState([]);
  const [rightRows, setRightRows] = useState([]);
  const [leftPending, setLeftPending] = useState([]);
  const [rightPending, setRightPending] = useState([]);
  const [buffer, setBuffer] = useState(null);
  const [status, setStatus] = useState('connecting');

  // UI state
  const [query, setQuery] = useState('');
  const [showTentativeOnly, setShowTentativeOnly] = useState(false);
  const [pageSize, setPageSize] = useState(25);
  const [pageLeft, setPageLeft] = useState(0);
  const [pageRight, setPageRight] = useState(0);
  const [detailRow, setDetailRow] = useState(null);

  const socketRef = useRef(null);
  const pollRef = useRef(null);

  // helper: robust timestamp extractor and sorter (newest first)
  function rowTimestamp(r) {
    // prefer wagonRaw.time, then time, then finalizedAt, then createdAt, then id
    const t = r?.wagonRaw?.time ?? r?.time ?? r?.finalizedAt ?? r?.createdAt ?? r?.ts ?? null;
    const parsed = t ? (typeof t === 'number' ? t : Date.parse(t)) : null;
    return Number.isFinite(parsed) && !Number.isNaN(parsed) ? parsed : (r?.id ? Number(r.id) : 0);
  }

  function sortRowsDesc(rows) {
    if (!Array.isArray(rows)) return [];
    // create a shallow copy then sort newest first
    return [...rows].sort((a, b) => {
      return rowTimestamp(b) - rowTimestamp(a);
    });
  }

  // Axios: leave as-is or switch to relative '/api' in production
  // axios.defaults.baseURL = '/api';

  async function fetchLeft() {
    try {
      const r = await axios.get(leftSequenceUrl);
      if (r && r.data && r.data.ok) {
        const rows = sortRowsDesc(r.data.rows || []);
        setLeftRows(rows);
        setLeftPending(r.data.pendingContainers || []);
        setBuffer(r.data.buffer ?? buffer);
      }
    } catch (err) {
      console.error('fetchLeft err', err?.message || err);
    }
  }

  async function fetchRight() {
    try {
      const r = await axios.get(rightSequenceUrl);
      console.log(r)
      if (r && r.data && r.data.ok) {
        const rows = sortRowsDesc(r.data.rows || []);
        setRightRows(rows);
        setRightPending(r.data.pendingContainers || []);
        setBuffer(r.data.buffer ?? buffer);
      }
    } catch (err) {
      console.error('fetchRight err', err?.message || err);
    }
  }

  async function fetchAll() {
    await Promise.all([fetchLeft(), fetchRight()]);
  }

  useEffect(() => {
    let mounted = true;
    fetchAll().then(() => { if (mounted) setStatus('ready'); }).catch(() => {});

    // socket setup
    try {
      const url = socketUrl || (typeof window !== 'undefined' ? window.location.origin : '');
      const socket = io(url, { transports: ['websocket', 'polling'] });
      socketRef.current = socket;

      socket.on('connect', () => {
        setStatus('socket:connected');
        console.info('socket connected', socket.id);
      });

      socket.on('connect_error', (err) => {
        console.warn('socket connect_error', err?.message || err);
        if (!pollRef.current) startPolling();
        setStatus('socket:error');
      });

      const fireLeftRefresh = () => fetchLeft();
      const fireRightRefresh = () => fetchRight();
      const fireFullRefresh = () => fetchAll();

      socket.on('sequence:left:changed', fireLeftRefresh);
      socket.on('sequence:right:changed', fireRightRefresh);
      socket.on('sequence:changed', fireFullRefresh);
      socket.on('sequencing:change', fireFullRefresh);
      socket.on('container:changed', fireFullRefresh);
      socket.on('flush', fireFullRefresh);

      socket.on('update', (payload) => {
        if (!payload) return fireFullRefresh();
        if (payload.side === 'left') fireLeftRefresh();
        else if (payload.side === 'right') fireRightRefresh();
        else fireFullRefresh();
      });

      socket.on('disconnect', (reason) => {
        console.warn('socket disconnected', reason);
        if (!pollRef.current) startPolling();
        setStatus('socket:disconnected');
      });
    } catch (err) {
      console.warn('socket setup failed', err?.message || err);
      startPolling();
      setStatus('polling');
    }

    function startPolling() {
      if (pollRef.current) return;
      pollRef.current = setInterval(() => {
        fetchAll();
      }, pollInterval);
      setStatus('polling');
    }

    return () => {
      mounted = false;
      if (pollRef.current) clearInterval(pollRef.current);
      if (socketRef.current) socketRef.current.disconnect();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // --- Filtering & pagination helpers ---
  const filterFn = (row) => {
    if (!row) return false;
    const text = `${row.wagon_no || ''} ${row.train_no || ''} ${row.container_no_1 || ''} ${row.container_no_2 || ''}`.toLowerCase();
    if (query && !text.includes(query.toLowerCase())) return false;
    if (showTentativeOnly && row.finalizedAt) return false;
    return true;
  };

  const filteredLeft = useMemo(() => leftRows.filter(filterFn), [leftRows, query, showTentativeOnly]);
  const filteredRight = useMemo(() => rightRows.filter(filterFn), [rightRows, query, showTentativeOnly]);

  const pagedLeft = useMemo(() => filteredLeft.slice(pageLeft * pageSize, (pageLeft + 1) * pageSize), [filteredLeft, pageLeft, pageSize]);
  const pagedRight = useMemo(() => filteredRight.slice(pageRight * pageSize, (pageRight + 1) * pageSize), [filteredRight, pageRight, pageSize]);

  function downloadCsv(rows, filename = 'export.csv') {
    if (!rows || rows.length === 0) return;
    const headers = ['id','wagon_no','train_no','side','container_no_1','iso_code_1','container_no_2','iso_code_2','finalizedAt','time'];
    const lines = [headers.join(',')];
    for (const r of rows) {
      const vals = headers.map(h => {
        const v = r[h] ?? '';
        const s = typeof v === 'string' ? v : (v === null || v === undefined ? '' : String(v));
        return '"' + s.replace(/"/g, '""') + '"';
      });
      lines.push(vals.join(','));
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function RowTable({ rows, side }) {
    return (
      <div className="table-responsive table-fixed-head">
        <table className="table table-sm table-striped table-bordered mb-0">
          <thead className="table-light">
            <tr>
              <th style={{width: '60px'}}>#</th>
              <th>Wagon</th>
              <th>Train</th>
              <th>Final</th>
              <th>Cont. 1</th>
              <th>ISO 1</th>
              <th>Cont. 2</th>
              <th>ISO 2</th>
              <th style={{width: '160px'}}>Time</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={(r.id || idx)}
                  onClick={() => setDetailRow(r)}
                  className={r.tentative ? 'table-warning' : ''}
                  style={{ cursor: 'pointer' }}>
                <td>{r.id || idx}</td>
                <td>{r.wagon_no || '—'}</td>
                <td>{r.train_no || '—'}</td>
                <td>{r.finalizedAt ? '✅' : '⏳'}</td>
                <td>{r.container_no_1 || '—'}</td>
                <td>{r.iso_code_1 || ''}</td>
                <td>{r.container_no_2 || '—'}</td>
                <td>{r.iso_code_2 || ''}</td>
                <td>{r.wagonRaw ? new Date(r.wagonRaw.time).toLocaleString() : (r.time ? new Date(r.time).toLocaleString() : '')}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={9} className="text-muted small">No rows</td></tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="container my-3">
      <div className="d-flex justify-content-between align-items-center mb-2">
        <h4 className="mb-0">Sequencer — Excel view</h4>
        <div className="small text-muted">Status: <strong>{status}</strong></div>
      </div>

      <div className="card p-3 mb-3">
        <div className="row g-2 align-items-center">
          <div className="col-md-4">
            <input className="form-control form-control-sm" placeholder="Search wagon/container/train..." value={query} onChange={e => { setQuery(e.target.value); setPageLeft(0); setPageRight(0); }} />
          </div>
          <div className="col-auto">
            <div className="form-check form-switch">
              <input className="form-check-input" type="checkbox" id="tentativeOnly" checked={showTentativeOnly} onChange={e => setShowTentativeOnly(e.target.checked)} />
              <label className="form-check-label small" htmlFor="tentativeOnly">Tentative only</label>
            </div>
          </div>

          <div className="col-auto">
            <select className="form-select form-select-sm" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPageLeft(0); setPageRight(0); }}>
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
              <option value={100}>100</option>
            </select>
          </div>

          <div className="col text-end">
            <button className="btn btn-sm btn-outline-primary me-2" onClick={() => { fetchAll(); }}>Refresh</button>
            <button className="btn btn-sm btn-outline-success me-2" onClick={() => downloadCsv(filteredLeft, 'left-sequences.csv')}>Export Left CSV</button>
            <button className="btn btn-sm btn-outline-success" onClick={() => downloadCsv(filteredRight, 'right-sequences.csv')}>Export Right CSV</button>
          </div>
        </div>
      </div>

      <div className="row g-3">
        <div className="col-lg-6">
          <div className="d-flex justify-content-between align-items-center mb-1">
            <h6 className="mb-0">Left sequences</h6>
            <div className="small text-muted">Buffer: {buffer ?? '—'}</div>
          </div>

          <RowTable rows={pagedLeft} side="left" />

          <div className="d-flex justify-content-between align-items-center mt-2 small">
            <div>Total: {filteredLeft.length}</div>
            <div>
              <button className="btn btn-sm btn-outline-secondary me-1" disabled={pageLeft === 0} onClick={() => setPageLeft(p => Math.max(0, p - 1))}>Prev</button>
              <button className="btn btn-sm btn-outline-secondary" disabled={(pageLeft + 1) * pageSize >= filteredLeft.length} onClick={() => setPageLeft(p => p + 1)}>Next</button>
            </div>
          </div>

        </div>

        <div className="col-lg-6">
          <div className="d-flex justify-content-between align-items-center mb-1">
            <h6 className="mb-0">Right sequences</h6>
            <div className="small text-muted">Buffer: {buffer ?? '—'}</div>
          </div>

          <RowTable rows={pagedRight} side="right" />

          <div className="d-flex justify-content-between align-items-center mt-2 small">
            <div>Total: {filteredRight.length}</div>
            <div>
              <button className="btn btn-sm btn-outline-secondary me-1" disabled={pageRight === 0} onClick={() => setPageRight(p => Math.max(0, p - 1))}>Prev</button>
              <button className="btn btn-sm btn-outline-secondary" disabled={(pageRight + 1) * pageSize >= filteredRight.length} onClick={() => setPageRight(p => p + 1)}>Next</button>
            </div>
          </div>

        </div>

      </div>

      <div className="row mt-3">
        <div className="col-lg-6 mb-3">
          <div className="card p-2">
            <h6 className="mb-2">Pending containers (Left)</h6>
            <div className="small text-muted">{leftPending.length} items</div>
            <div className="small mt-2">
              {leftPending.slice(0, 20).map(p => (<div key={p.id || p.tsRaw} className="d-flex justify-content-between py-1 border-bottom"><div>{p.containerNumber || p.container_no}</div><div className="text-muted">{p.time ? new Date(p.time).toLocaleString() : ''}</div></div>))}
            </div>
          </div>
        </div>

        <div className="col-lg-6 mb-3">
          <div className="card p-2">
            <h6 className="mb-2">Pending containers (Right)</h6>
            <div className="small text-muted">{rightPending.length} items</div>
            <div className="small mt-2">
              {rightPending.slice(0, 20).map(p => (<div key={p.id || p.tsRaw} className="d-flex justify-content-between py-1 border-bottom"><div>{p.containerNumber || p.container_no}</div><div className="text-muted">{p.time ? new Date(p.time).toLocaleString() : ''}</div></div>))}
            </div>
          </div>
        </div>
      </div>

      {/* Detail modal (simple) */}
      {detailRow && (
        <div className="sequencer-modal-backdrop" onClick={() => setDetailRow(null)}>
          <div className="sequencer-modal" onClick={e => e.stopPropagation()}>
            <div className="d-flex justify-content-between align-items-start mb-2">
              <h5 className="mb-0">Details — {detailRow.wagon_no || detailRow.id}</h5>
              <button className="btn btn-sm btn-outline-secondary" onClick={() => setDetailRow(null)}>Close</button>
            </div>
            <div className="small text-muted mb-2">Train: {detailRow.train_no || '—'} · Side: {detailRow.side || '—'}</div>
            <div className="row g-2">
              <div className="col-md-6">
                <div className="small text-muted">Container 1</div>
                <div className="fw-semibold">{detailRow.container_no_1 || '—'}</div>
                {detailRow.container_no_img_1 && <img src={detailRow.container_no_img_1} className="img-fluid mt-2" alt="c1" />}
              </div>
              <div className="col-md-6">
                <div className="small text-muted">Container 2</div>
                <div className="fw-semibold">{detailRow.container_no_2 || '—'}</div>
                {detailRow.container_no_img_2 && <img src={detailRow.container_no_img_2} className="img-fluid mt-2" alt="c2" />}
              </div>
            </div>
            <div className="mt-3 small text-muted">Raw data:</div>
            <pre className="small" style={{maxHeight: '220px', overflow: 'auto'}}>{JSON.stringify(detailRow, null, 2)}</pre>
          </div>
        </div>
      )}

    </div>
  );
}

