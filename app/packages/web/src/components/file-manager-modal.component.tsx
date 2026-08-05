import { useEffect } from 'react';
import { type FileMgrStatus, type FileMgrCredentials } from '../api.service.js';

interface Props {
  game: string | null;
  status: FileMgrStatus | null;
  message: string;
  /** The one-time login credential from the most recent successful launch, if any — shown inline alongside the connection link, never re-fetched or persisted. */
  credentials?: FileMgrCredentials | null;
  onClose: () => void;
  onStart: () => void;
  onStop: () => void;
}

/**
 * Modal dialog that launches the per-game FileBrowser helper task so the
 * operator can browse/upload/download EFS save files. All ECS lifecycle + the
 * polling loop live in `useFileManager` — this component is purely presentational,
 * driven by the status/message props and invoking the start/stop/close callbacks.
 */
export function FileManagerModal({ game, status, message, credentials, onClose, onStart, onStop }: Props) {
  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  if (!game) return null;

  const state = status?.state ?? 'stopped';
  const isRunning = state === 'running' && !!status?.url;
  const isStarting = state === 'starting';

  return (
    <div style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={modalStyle}>
        <h3 style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
          File Manager — <span style={{ textTransform: 'capitalize' }}>{game}</span>
        </h3>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-dim)', marginBottom: '1.25rem' }}>
          Mounts the game&apos;s EFS save data — browse, upload, and download files.
        </p>

        <div style={{ fontSize: '0.82rem', color: 'var(--text-dim)', minHeight: '1.5rem', marginBottom: '0.75rem' }}>
          {message || statusText(state)}
        </div>

        {isRunning && status.url && (
          <div style={{ marginBottom: '1rem' }}>
            <a href={status.url} target="_blank" rel="noreferrer"
               style={{ color: 'var(--accent)', fontSize: '0.9rem', textDecoration: 'none' }}>
              Open FileBrowser at {status.url} ↗
            </a>
          </div>
        )}

        {credentials && (
          <div style={{
            marginBottom: '1rem',
            padding: '0.6rem 0.75rem',
            borderRadius: '8px',
            border: '1px solid var(--border)',
            fontSize: '0.8rem',
          }}>
            <div style={{ color: 'var(--text-dim)', marginBottom: '0.25rem' }}>
              Login (shown once — copy it now):
            </div>
            <div>Username: <code>{credentials.username}</code></div>
            <div>Password: <code>{credentials.password}</code></div>
          </div>
        )}

        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' as const }}>
          <button className="btn-start btn-sm" onClick={onStart} disabled={isRunning || isStarting}>
            Launch
          </button>
          <button className="btn-stop btn-sm" onClick={onStop} disabled={!isRunning && !isStarting}>
            Stop
          </button>
          <button className="btn-secondary btn-sm" onClick={onClose} style={{ marginLeft: 'auto' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function statusText(state: string): string {
  if (state === 'running') return 'Running — click the link below to open FileBrowser.';
  if (state === 'starting') return 'Starting… checking again in 5 seconds.';
  return 'Not running. Click Launch to start FileBrowser.';
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.6)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 200,
};

const modalStyle: React.CSSProperties = {
  background: 'var(--surface)',
  border: '1px solid var(--border)',
  borderRadius: '14px',
  padding: '1.75rem',
  width: '400px',
  maxWidth: '90vw',
};
