/**
 * SearchPage — simplified JD text search that uses the v2 /rank pipeline.
 *
 * Since v1 endpoints are offline, this page lets users:
 * 1. Paste a JD text
 * 2. Upload resume files
 * 3. Click "Rank Candidates" → calls /api/v2/rank
 * 4. Shows results inline (same as RankPage but accessed from /search)
 *
 * For full-featured upload UI, use the /rank page directly.
 */
import { useNavigate } from 'react-router-dom';
import { useEffect } from 'react';

export default function SearchPage() {
  const navigate = useNavigate();

  // Immediately redirect to /rank which is the full-featured page
  useEffect(() => {
    navigate('/rank', { replace: true });
  }, [navigate]);

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'var(--bg-primary)',
      flexDirection: 'column',
      gap: 16,
    }}>
      <div style={{
        fontSize: 40,
        animation: 'spin 1s linear infinite',
      }}>⬡</div>
      <p style={{ color: 'rgba(240,244,255,0.5)', fontSize: 14 }}>
        Redirecting to Rank Candidates…
      </p>
      <style>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
