/**
 * Navbar — shared across all pages.
 * Shows app branding + navigation links.
 */
import { useNavigate, useLocation } from 'react-router-dom';

const NAV_LINKS = [
  { path: '/', label: '🏠 Home' },
  { path: '/rank', label: '⚡ Rank Candidates' },
  { path: '/search', label: '🔍 Search' },
];

export default function Navbar() {
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <>
      <nav style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 1000,
        height: 56,
        background: 'rgba(8,7,22,0.85)',
        backdropFilter: 'blur(20px)',
        borderBottom: '1px solid rgba(124,58,237,0.15)',
        display: 'flex',
        alignItems: 'center',
        padding: '0 24px',
        gap: 0,
      }}>
        {/* Logo */}
        <div
          onClick={() => navigate('/')}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
            marginRight: 32,
          }}
        >
          <div style={{
            width: 32, height: 32, borderRadius: 10,
            background: 'linear-gradient(135deg,#7c3aed,#a21caf)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, boxShadow: '0 0 14px rgba(124,58,237,0.4)',
          }}>⬡</div>
          <span style={{
            fontWeight: 800, fontSize: 16,
            background: 'linear-gradient(90deg,#a78bfa,#38bdf8)',
            WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
          }}>InternLoom</span>
          <span style={{
            fontSize: 10, fontWeight: 700, color: 'rgba(167,139,250,0.6)',
            background: 'rgba(124,58,237,0.12)', border: '1px solid rgba(124,58,237,0.2)',
            borderRadius: 4, padding: '1px 6px',
          }}>PRO</span>
        </div>

        {/* Nav links */}
        <div style={{ display: 'flex', gap: 4, flex: 1 }}>
          {NAV_LINKS.map(link => {
            const active = location.pathname === link.path ||
              (link.path !== '/' && location.pathname.startsWith(link.path));
            return (
              <button
                key={link.path}
                onClick={() => navigate(link.path)}
                style={{
                  background: active ? 'rgba(124,58,237,0.15)' : 'transparent',
                  border: active ? '1px solid rgba(124,58,237,0.3)' : '1px solid transparent',
                  color: active ? '#a78bfa' : 'rgba(240,244,255,0.5)',
                  padding: '5px 14px',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: active ? 700 : 500,
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  fontFamily: 'inherit',
                }}
                onMouseEnter={e => {
                  if (!active) {
                    (e.target as HTMLButtonElement).style.color = '#e0e7ff';
                    (e.target as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
                  }
                }}
                onMouseLeave={e => {
                  if (!active) {
                    (e.target as HTMLButtonElement).style.color = 'rgba(240,244,255,0.5)';
                    (e.target as HTMLButtonElement).style.background = 'transparent';
                  }
                }}
              >
                {link.label}
              </button>
            );
          })}
        </div>

        {/* Right side CTA */}
        <button
          onClick={() => navigate('/rank')}
          style={{
            background: 'linear-gradient(135deg,#7c3aed,#2563eb)',
            border: 'none', color: 'white',
            padding: '7px 18px', borderRadius: 8,
            fontSize: 13, fontWeight: 700, cursor: 'pointer',
            boxShadow: '0 0 16px rgba(124,58,237,0.3)',
            fontFamily: 'inherit',
            transition: 'transform 0.15s, box-shadow 0.15s',
          }}
          onMouseEnter={e => {
            (e.target as HTMLButtonElement).style.transform = 'translateY(-1px)';
            (e.target as HTMLButtonElement).style.boxShadow = '0 0 24px rgba(124,58,237,0.5)';
          }}
          onMouseLeave={e => {
            (e.target as HTMLButtonElement).style.transform = '';
            (e.target as HTMLButtonElement).style.boxShadow = '0 0 16px rgba(124,58,237,0.3)';
          }}
        >
          🚀 Try Demo
        </button>
      </nav>
      {/* Spacer so content doesn't sit under fixed nav */}
      <div style={{ height: 56 }} />
    </>
  );
}
