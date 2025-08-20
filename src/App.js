import React, { useEffect, useState, useRef } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';
import './App.css'; // custom styles for the component
// NOTE: Bootstrap CSS should be imported once globally (see index.js instructions).

export default function SequencerRealtime({
  pollInterval = 5000,
  socketUrl = null,
  leftSequenceUrl = 'http://10.40.40.215:3000/api/sequence',
  rightSequenceUrl = 'http://10.40.40.215:3000/api/sequence/right'
}) {
  const [leftRows, setLeftRows] = useState([]);
  const [leftPending, setLeftPending] = useState([]);
  const [rightRows, setRightRows] = useState([]);
  const [rightPending, setRightPending] = useState([]);
  const [buffer, setBuffer] = useState(null);
  const [status, setStatus] = useState('connecting');

  const socketRef = useRef(null);
  const pollRef = useRef(null);

  async function fetchLeft() {
    try {
      const r = await axios.get(leftSequenceUrl);
      if (r && r.data && r.data.ok) {
        setLeftRows(r.data.rows || []);
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
      if (r && r.data && r.data.ok) {
        setRightRows(r.data.rows || []);
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
        if (!payload) return fetchAll();
        if (payload.side === 'left') fireLeftRefresh();
        else if (payload.side === 'right') fireRightRefresh();
        else fetchAll();
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

  const Img = ({ src, alt }) => {
    if (!src) return <div className="text-muted small fst-italic">no image</div>;
    return <img src={src} alt={alt || ''} className="img-fluid sequencer-img" />;
  };

  function SequenceCard({ s }) {
    return (
      <div className={`card sequencer-card ${s.tentative ? 'sequencer-tentative' : ''}`}>
        <div className="card-body p-3">
          <div className="d-flex justify-content-between align-items-start">
            <div>
              <div className="small">Wagon: <strong>{s.wagon_no || '—'}</strong></div>
              <div className="text-muted small">Train: {s.train_no || '—'} · {s.side}</div>
              <div className="text-muted small">{s.wagonRaw ? new Date(s.wagonRaw.time).toLocaleString() : ''}</div>
            </div>
            <div className="text-end small">
              {s.finalizedAt ? <span className="badge bg-success">Final</span> : <span className="badge bg-warning text-dark">Tentative</span>}
            </div>
          </div>

          <div className="row mt-3">
            <div className="col-6">
              <div className="small text-muted">Container 1</div>
              <div className="fw-semibold">{s.container_no_1 || '—'}</div>
              <div className="mt-2"><Img src={s.container_no_img_1} alt={s.container_no_1} /></div>
              <div className="text-muted small">{s.iso_code_1 || ''}</div>
            </div>
            <div className="col-6">
              <div className="small text-muted">Container 2</div>
              <div className="fw-semibold">{s.container_no_2 || '—'}</div>
              <div className="mt-2"><Img src={s.container_no_img_2} alt={s.container_no_2} /></div>
              <div className="text-muted small">{s.iso_code_2 || ''}</div>
            </div>
          </div>

          <div className="mt-3">
            <div className="small text-muted">Wagon image</div>
            <div className="mt-2"><Img src={s.wagon_no_img} alt={s.wagon_no} /></div>
          </div>
        </div>
      </div>
    );
  }

  function PendingList({ items }) {
    if (!items || items.length === 0) return <div className="text-muted small">No pending containers</div>;
    return (
      <div className="list-group">
        {items.map(it => (
          <div key={it.id || it.tsRaw + it.containerNumber} className="list-group-item d-flex justify-content-between align-items-center">
            <div>
              <div className="fw-medium">{it.containerNumber || it.container_no || '—'}</div>
              <div className="small text-muted">{it.tsRaw} · {it.time ? new Date(it.time).toLocaleString() : ''}</div>
            </div>
            <div className="small text-muted">#{it.id || ''}</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="container my-4">
      <div className="d-flex justify-content-between align-items-center mb-3">
        <h2 className="h5 mb-0">Train Sequencer — Realtime</h2>
        <div className="small text-muted">Status: <strong>{status}</strong></div>
      </div>

      <div className="row g-3">
        <div className="col-lg-8">
          <div className="row">
            <div className="col-md-6 mb-3">
              <div className="d-flex justify-content-between mb-2">
                <h5 className="h6 mb-0">Left sequences</h5>
                <div className="small text-muted">buffer: {buffer ?? '—'}</div>
              </div>
              <div className="d-grid gap-3">
                {leftRows.length === 0 ? <div className="text-muted small">No sequences yet</div> : leftRows.map(s => <SequenceCard key={`L-${s.id}`} s={s} />)}
              </div>
            </div>

            <div className="col-md-6 mb-3">
              <div className="d-flex justify-content-between mb-2">
                <h5 className="h6 mb-0">Right sequences</h5>
                <div className="small text-muted">buffer: {buffer ?? '—'}</div>
              </div>
              <div className="d-grid gap-3">
                {rightRows.length === 0 ? <div className="text-muted small">No sequences yet</div> : rightRows.map(s => <SequenceCard key={`R-${s.id}`} s={s} />)}
              </div>
            </div>
          </div>
        </div>

        <div className="col-lg-4">
          <div className="card p-3 mb-3">
            <h6 className="mb-2">Pending containers (Left)</h6>
            <PendingList items={leftPending} />
            <hr />
            <h6 className="mb-2">Pending containers (Right)</h6>
            <PendingList items={rightPending} />
            <hr />
            <div className="d-flex gap-2">
              <button className="btn btn-sm btn-outline-primary" onClick={() => fetchAll()}>Refresh</button>
              <button className="btn btn-sm btn-outline-danger"
                onClick={async () => {
                  try {
                    await axios.post('/api/flush'); // left
                    await axios.post('/api/flush/right'); // right
                    fetchAll();
                  } catch (e) { console.error(e); }
                }}
              >Flush both</button>
            </div>
            <div className="mt-2 small text-muted"></div>
          </div>
        </div>
      </div>
    </div>
  );
}
