import React, { useEffect, useState, useRef } from 'react';
import axios from 'axios';
import { io } from 'socket.io-client';

// SequencerRealtime.jsx
// Default-exported React component that shows LEFT and RIGHT sequences side-by-side
// Realtime approach: tries to connect to socket.io at the same origin. If socket fails, falls
// back to polling every 5s. Uses Axios for REST calls (you said you use Axios).
//
// Usage:
// 1) npm install axios socket.io-client
// 2) import SequencerRealtime from './SequencerRealtime.jsx'
// 3) <SequencerRealtime /> somewhere in your app
//
// Notes for server-side realtime (optional):
// - Server can emit lightweight events to notify clients when to refresh. Examples:
//   socket.emit('sequence:left:changed')
//   socket.emit('sequence:right:changed')
//   socket.emit('sequence:flush')
// - This frontend listens to many common event names; if you emit any of the above, the
//   UI will refresh automatically. If your server uses different event names, adjust
//   the handlers below.

export default function SequencerRealtime({ pollInterval = 5000, socketUrl = null }) {
  const [leftRows, setLeftRows] = useState([]);
  const [leftPending, setLeftPending] = useState([]);
  const [rightRows, setRightRows] = useState([]);
  const [rightPending, setRightPending] = useState([]);
  const [buffer, setBuffer] = useState(null);
  const [status, setStatus] = useState('connecting');

  const socketRef = useRef(null);
  const pollRef = useRef(null);

  // Helper to normalise API response shape into { rows, pendingContainers, buffer }
  async function fetchLeft() {
    try {
      const r = await axios.get('/api/sequence');
      if (r && r.data && r.data.ok) {
        setLeftRows(r.data.rows || []);
        setLeftPending(r.data.pendingContainers || []);
        setBuffer(r.data.buffer ?? buffer);
      }
    } catch (err) {
      console.error('fetchLeft err', err.message || err);
    }
  }
  async function fetchRight() {
    try {
      const r = await axios.get('/api/sequence/right');
      if (r && r.data && r.data.ok) {
        setRightRows(r.data.rows || []);
        setRightPending(r.data.pendingContainers || []);
        setBuffer(r.data.buffer ?? buffer);
      }
    } catch (err) {
      console.error('fetchRight err', err.message || err);
    }
  }

  async function fetchAll() {
    await Promise.all([fetchLeft(), fetchRight()]);
  }

  useEffect(() => {
    let mounted = true;

    // initial fetch
    fetchAll().then(() => { if (mounted) setStatus('ready'); }).catch(() => {});

    // try to connect socket.io
    try {
      const url = socketUrl || (typeof window !== 'undefined' ? window.location.origin : '');
      const socket = io(url, { transports: ['websocket', 'polling'] });
      socketRef.current = socket;

      socket.on('connect', () => {
        setStatus('socket:connected');
        console.info('socket connected', socket.id);
      });

      socket.on('connect_error', (err) => {
        console.warn('socket connect_error', err.message || err);
        // if socket fails to connect, fallback to polling
        if (!pollRef.current) startPolling();
        setStatus('socket:error');
      });

      // Listen to a variety of event names (your server can emit any of these)
      const fireFullRefresh = () => { fetchAll(); };
      const fireLeftRefresh = () => { fetchLeft(); };
      const fireRightRefresh = () => { fetchRight(); };

      socket.on('sequence:left:changed', fireLeftRefresh);
      socket.on('sequence:right:changed', fireRightRefresh);
      socket.on('sequence:changed', fireFullRefresh);
      socket.on('sequencing:change', fireFullRefresh);
      socket.on('container:changed', fireFullRefresh);
      socket.on('flush', fireFullRefresh);

      // generic fallback: some setups emit 'update' and send a side
      socket.on('update', (payload) => {
        if (!payload) return fetchAll();
        if (payload.side === 'left') fireLeftRefresh();
        else if (payload.side === 'right') fireRightRefresh();
        else fetchAll();
      });

      // if socket disconnects, start polling
      socket.on('disconnect', (reason) => {
        console.warn('socket disconnected', reason);
        if (!pollRef.current) startPolling();
        setStatus('socket:disconnected');
      });
    } catch (err) {
      console.warn('socket setup failed', err.message || err);
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

  // small helpers to render images safely
  const Img = ({ src, alt, className }) => {
    if (!src) return <div className={`text-xs italic text-gray-400 ${className || ''}`}>no image</div>;
    return <img src={src} alt={alt || ''} className={`max-w-full max-h-24 object-contain rounded ${className || ''}`} />;
  };

  function SequenceCard({ s }) {
    return (
      <div className={`p-3 border rounded-lg shadow-sm ${s.tentative ? 'bg-yellow-50' : 'bg-white'}`}>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">Wagon: <span className="font-bold">{s.wagon_no || '—'}</span></div>
            <div className="text-xs text-gray-600">Train: {s.train_no || '—'} · {s.side}</div>
            <div className="text-xs text-gray-500">{s.wagonRaw ? new Date(s.wagonRaw.time).toLocaleString() : ''}</div>
          </div>
          <div className="w-20 text-right">
            <div className="text-xs">{s.finalizedAt ? (<span className="text-green-600">Final</span>) : (<span className="text-orange-600">Tentative</span>)}</div>
          </div>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="col-span-1">
            <div className="text-xs text-gray-600">Container 1</div>
            <div className="text-sm font-semibold">{s.container_no_1 || '—'}</div>
            <div className="mt-1"><Img src={s.container_no_img_1} alt={s.container_no_1} /></div>
            <div className="text-xs text-gray-500">{s.iso_code_1 || ''}</div>
          </div>
          <div className="col-span-1">
            <div className="text-xs text-gray-600">Container 2</div>
            <div className="text-sm font-semibold">{s.container_no_2 || '—'}</div>
            <div className="mt-1"><Img src={s.container_no_img_2} alt={s.container_no_2} /></div>
            <div className="text-xs text-gray-500">{s.iso_code_2 || ''}</div>
          </div>
        </div>

        <div className="mt-2">
          <div className="text-xs text-gray-600">Wagon image</div>
          <div className="mt-1"><Img src={s.wagon_no_img} alt={s.wagon_no} /></div>
        </div>
      </div>
    );
  }

  function PendingList({ items }) {
    if (!items || items.length === 0) return <div className="text-sm text-gray-500">No pending containers</div>;
    return (
      <div className="space-y-2">
        {items.map(it => (
          <div key={it.id} className="p-2 border rounded flex items-center justify-between">
            <div>
              <div className="font-medium text-sm">{it.containerNumber}</div>
              <div className="text-xs text-gray-500">{it.tsRaw} · {new Date(it.time).toLocaleString()}</div>
            </div>
            <div className="text-xs text-gray-500">#{it.id}</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">Train Sequencer — Real time</h2>
        <div className="text-sm text-gray-600">Status: <span className="font-medium">{status}</span></div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="md:col-span-2 grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-medium">Left sequences</h3>
              <div className="text-xs text-gray-500">buffer: {buffer ?? '—'}</div>
            </div>
            <div className="space-y-3">
              {leftRows.length === 0 ? <div className="text-sm text-gray-500">No sequences yet</div> : (
                leftRows.map(s => <SequenceCard key={`L-${s.id}`} s={s} />)
              )}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="font-medium">Right sequences</h3>
              <div className="text-xs text-gray-500">buffer: {buffer ?? '—'}</div>
            </div>
            <div className="space-y-3">
              {rightRows.length === 0 ? <div className="text-sm text-gray-500">No sequences yet</div> : (
                rightRows.map(s => <SequenceCard key={`R-${s.id}`} s={s} />)
              )}
            </div>
          </div>
        </div>

        <div className="md:col-span-1">
          <div className="p-3 border rounded">
            <h4 className="font-medium mb-2">Pending containers (Left)</h4>
            <PendingList items={leftPending} />
            <hr className="my-3" />
            <h4 className="font-medium mb-2">Pending containers (Right)</h4>
            <PendingList items={rightPending} />
            <hr className="my-3" />
            <div className="text-xs text-gray-600">Actions</div>
            <div className="mt-2 space-x-2">
              <button onClick={() => fetchAll()} className="px-3 py-1 rounded border text-sm">Refresh</button>
              <button onClick={async () => {
                try {
                  await axios.post('/api/flush');
                  await axios.post('/api/flush/right');
                  fetchAll();
                } catch (e) { console.error(e); }
              }} className="px-3 py-1 rounded border text-sm">Flush both</button>
            </div>
          </div>

          <div className="mt-3 text-xs text-gray-500">
            <div>Tip: for best realtime behaviour, have your server emit socket events when a wagon/container/flush happens.</div>
          </div>
        </div>
      </div>
    </div>
  );
}
