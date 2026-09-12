import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Chart as ChartJS, RadialLinearScale, PointElement, LineElement,
  Filler, Tooltip, Legend, CategoryScale, LinearScale, BarElement,
} from 'chart.js';
import { Radar, Bar } from 'react-chartjs-2';
import './rank.css';

ChartJS.register(RadialLinearScale, PointElement, LineElement, Filler, Tooltip, Legend, CategoryScale, LinearScale, BarElement);

// ── Types ────────────────────────────────────────────────────────────
interface EvidenceChunk { text: string; section_type: string; similarity: number; }
interface Candidate {
  candidate_id: string; candidate_name: string; rank: number;
  final_score: number; keyword_score: number; semantic_score: number;
  skill_coverage_score: number; bm25_score: number;
  matched_required: string[]; matched_preferred: string[];
  missing_required: string[]; missing_preferred: string[];
  required_coverage: number; preferred_coverage: number;
  top_evidence: EvidenceChunk[]; penalty_applied: number;
}
interface Explanation {
  candidate_id: string; candidate_name: string; rank: number;
  final_score: number; matched_skills: string[]; missing_required_skills: string[];
  supporting_evidence: string[]; template_summary: string; llm_summary?: string;
}
interface BiasFlag { phrase: string; reason: string; severity: string; category: string; suggestion: string; }
interface RankResult {
  candidates: Candidate[]; explanations: Explanation[];
  jd_analysis: { required_skills: string[]; preferred_skills: string[]; all_skills: string[]; jd_text_preview: string; };
  bias_flags: BiasFlag[]; total_resumes: number;
  latency: { total_ms: number; breakdown: Record<string, number>; };
}

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

// ── Colour helpers ────────────────────────────────────────────────────
function scoreColor(s: number) {
  if (s >= 80) return '#34d399';
  if (s >= 60) return '#a78bfa';
  if (s >= 40) return '#fb923c';
  return '#f87171';
}
const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' };

// ── Animated floating-particle background ────────────────────────────
function ParticleCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext('2d')!;
    const particles: { x: number; y: number; r: number; dx: number; dy: number; hue: number; alpha: number }[] = [];
    const resize = () => { canvas.width = canvas.offsetWidth; canvas.height = canvas.offsetHeight; };
    resize();
    window.addEventListener('resize', resize);
    for (let i = 0; i < 60; i++) {
      particles.push({ x: Math.random() * canvas.width, y: Math.random() * canvas.height, r: Math.random() * 2 + 0.5, dx: (Math.random() - 0.5) * 0.3, dy: (Math.random() - 0.5) * 0.3, hue: Math.random() * 60 + 240, alpha: Math.random() * 0.4 + 0.1 });
    }
    let raf: number;
    const draw = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      particles.forEach(p => {
        p.x += p.dx; p.y += p.dy;
        if (p.x < 0) p.x = canvas.width; if (p.x > canvas.width) p.x = 0;
        if (p.y < 0) p.y = canvas.height; if (p.y > canvas.height) p.y = 0;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fillStyle = `hsla(${p.hue},70%,65%,${p.alpha})`; ctx.fill();
      });
      for (let i = 0; i < particles.length; i++) {
        for (let j = i + 1; j < particles.length; j++) {
          const dx = particles[i].x - particles[j].x, dy = particles[i].y - particles[j].y;
          const d = Math.sqrt(dx * dx + dy * dy);
          if (d < 100) {
            ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y); ctx.lineTo(particles[j].x, particles[j].y);
            ctx.strokeStyle = `rgba(167,139,250,${0.07 * (1 - d / 100)})`; ctx.lineWidth = 0.5; ctx.stroke();
          }
        }
      }
      raf = requestAnimationFrame(draw);
    };
    draw();
    return () => { cancelAnimationFrame(raf); window.removeEventListener('resize', resize); };
  }, []);
  return <canvas ref={ref} style={{ position: 'fixed', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }} />;
}

// ── Animated ring score ───────────────────────────────────────────────
function RingScore({ score, size = 90 }: { score: number; size?: number }) {
  const [animated, setAnimated] = useState(0);
  const hasAnimated = useRef(false);
  useEffect(() => {
    if (hasAnimated.current) return;
    hasAnimated.current = true;
    let val = 0;
    const step = () => { val = Math.min(score, val + 2.5); setAnimated(val); if (val < score) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  }, [score]);
  const r = size / 2 - 10;
  const circ = 2 * Math.PI * r;
  const col = scoreColor(score);
  return (
    <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={8} />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={col} strokeWidth={8}
          strokeDasharray={circ} strokeDashoffset={circ * (1 - animated / 100)} strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 8px ${col})` }} />
      </svg>
      <div style={{ position: 'absolute', textAlign: 'center' }}>
        <div style={{ fontSize: size * 0.24, fontWeight: 900, color: col, lineHeight: 1 }}>{Math.round(animated)}</div>
      </div>
    </div>
  );
}

// ── Animated bar ──────────────────────────────────────────────────────
function AnimBar({ label, value, color }: { label: string; value: number; color: string }) {
  const [w, setW] = useState(0);
  useEffect(() => { setTimeout(() => setW(Math.min(100, value)), 50); }, [value]);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
      <span style={{ width: 80, fontSize: 10, color: 'rgba(255,255,255,0.45)', textAlign: 'right', flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${w}%`, background: color, borderRadius: 3, transition: 'width 0.8s cubic-bezier(0.34,1.56,0.64,1)', boxShadow: `0 0 8px ${color}55` }} />
      </div>
      <span style={{ width: 36, fontSize: 11, fontWeight: 700, color, textAlign: 'right', flexShrink: 0 }}>{value.toFixed(1)}</span>
    </div>
  );
}

// ── 3D-style GNN Skill Graph (canvas) ────────────────────────────────
function SkillGraph({ matched, preferred, missing, name }: { matched: string[]; preferred: string[]; missing: string[]; name: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const mouseRef = useRef({ x: -999, y: -999 });

  useEffect(() => {
    const c = canvas.current!;
    const ctx = c.getContext('2d')!;
    const W = c.offsetWidth, H = c.offsetHeight;
    c.width = W; c.height = H;
    const cx = W / 2, cy = H / 2;
    const skills = [
      ...matched.map(s => ({ label: s, type: 'matched' })),
      ...preferred.map(s => ({ label: s, type: 'preferred' })),
      ...missing.map(s => ({ label: s, type: 'missing' })),
    ];
    const total = skills.length;
    const R = Math.min(cx, cy) * 0.72;
    const nodes: any[] = [{ label: name.split(' ').slice(-1)[0]?.slice(0, 10) || name, type: 'center', x: cx, y: cy, r: 22 }];
    skills.forEach((s, i) => {
      const angle = (i / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
      nodes.push({ label: s.label, type: s.type, x: cx + R * Math.cos(angle), y: cy + R * Math.sin(angle), r: 18, angle });
    });
    const colorOf = (type: string) => type === 'center' ? '#7c3aed' : type === 'matched' ? '#34d399' : type === 'preferred' ? '#38bdf8' : '#f87171';
    let t = 0;
    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      const mx = mouseRef.current.x, my = mouseRef.current.y;
      nodes.slice(1).forEach(n => {
        ctx.save(); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(n.x, n.y);
        if (n.type === 'missing') ctx.setLineDash([4, 5]);
        ctx.strokeStyle = colorOf(n.type) + '33'; ctx.lineWidth = 1.5; ctx.stroke();
        ctx.setLineDash([]); ctx.restore();
      });
      nodes.forEach(n => {
        const isHov = Math.sqrt((n.x - mx) ** 2 + (n.y - my) ** 2) < n.r + 6;
        const col = colorOf(n.type);
        const grd = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 1.5);
        grd.addColorStop(0, col + 'cc'); grd.addColorStop(1, col + '00');
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r * 1.5, 0, Math.PI * 2); ctx.fillStyle = grd; ctx.fill();
        ctx.beginPath(); ctx.arc(n.x, n.y, n.r + (isHov ? 3 : 0), 0, Math.PI * 2);
        ctx.fillStyle = col + '22'; ctx.fill(); ctx.strokeStyle = col; ctx.lineWidth = isHov ? 2.5 : 1.5; ctx.stroke();
        ctx.fillStyle = isHov ? '#fff' : col;
        ctx.font = `${n.type === 'center' ? 'bold ' : ''}9px Inter,sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(n.label.slice(0, 9), n.x, n.y);
      });
      t++;
      nodes.slice(1).forEach((n, i) => {
        const pulse = Math.sin(t * 0.02 + i * 0.8) * 2;
        n.x = cx + (R + pulse) * Math.cos(n.angle + t * 0.003);
        n.y = cy + (R + pulse) * Math.sin(n.angle + t * 0.003);
      });
      animRef.current = requestAnimationFrame(draw);
    };
    draw();
    const onMove = (e: MouseEvent) => { const rect = c.getBoundingClientRect(); mouseRef.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }; };
    c.addEventListener('mousemove', onMove);
    return () => { cancelAnimationFrame(animRef.current); c.removeEventListener('mousemove', onMove); };
  }, [matched, preferred, missing, name]);

  return (
    <div>
      <div style={{ display: 'flex', gap: 14, marginBottom: 8, flexWrap: 'wrap' }}>
        {[['#34d399', `✓ Matched (${matched.length})`], ['#38bdf8', `~ Preferred (${preferred.length})`], ['#f87171', `✗ Missing (${missing.length})`]].map(([col, lbl]) => (
          <div key={lbl as string} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 10, color: 'rgba(255,255,255,0.5)' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: col as string, boxShadow: `0 0 6px ${col}` }} /><span>{lbl}</span>
          </div>
        ))}
      </div>
      <canvas ref={canvas} style={{ width: '100%', height: 240, borderRadius: 12, cursor: 'crosshair', display: 'block' }} />
    </div>
  );
}

// ── Radar mini ────────────────────────────────────────────────────────
function RadarMini({ c }: { c: Candidate }) {
  const data = {
    labels: ['Keyword', 'Semantic', 'Skill', 'BM25', 'Coverage'],
    datasets: [{ data: [c.keyword_score, c.semantic_score, c.skill_coverage_score, c.bm25_score, c.required_coverage * 100], backgroundColor: 'rgba(124,58,237,0.15)', borderColor: '#7c3aed', borderWidth: 2, pointBackgroundColor: '#a78bfa', pointRadius: 3 }],
  };
  return <Radar data={data} options={{ responsive: true, plugins: { legend: { display: false } }, scales: { r: { min: 0, max: 100, grid: { color: 'rgba(255,255,255,0.06)' }, angleLines: { color: 'rgba(255,255,255,0.06)' }, pointLabels: { color: 'rgba(255,255,255,0.4)', font: { size: 9 } }, ticks: { display: false } } } } as any} />;
}

// ── Score Histogram ───────────────────────────────────────────────────
function ScoreHistogram({ candidates }: { candidates: Candidate[] }) {
  const buckets = [0, 0, 0, 0, 0];
  candidates.forEach(c => { buckets[Math.min(4, Math.floor(c.final_score / 20))]++; });
  const data = { labels: ['0–20', '20–40', '40–60', '60–80', '80–100'], datasets: [{ label: 'Count', data: buckets, backgroundColor: ['#f87171aa', '#fb923caa', '#fbbf24aa', '#a78bfaaa', '#34d399aa'], borderRadius: 6, borderSkipped: false }] };
  return (
    <div className="glass-panel" style={{ padding: 16 }}>
      <div className="panel-label">Score Distribution</div>
      <Bar data={data} options={{ responsive: true, plugins: { legend: { display: false } }, scales: { x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: 'rgba(255,255,255,0.35)', font: { size: 10 } } }, y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: 'rgba(255,255,255,0.35)', stepSize: 1, font: { size: 10 } } } } } as any} />
    </div>
  );
}

// ── Compare Modal ─────────────────────────────────────────────────────
function CompareModal({ candidates, onClose }: { candidates: Candidate[]; onClose: () => void }) {
  const [a, setA] = useState(candidates[0]?.candidate_id ?? '');
  const [b, setB] = useState(candidates[1]?.candidate_id ?? '');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function compare() {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/v2/compare?id_a=${a}&id_b=${b}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setResult(await r.json());
    } catch (e: any) { alert(e.message); }
    setLoading(false);
  }

  const sel = (v: string, set: (s: string) => void) => (
    <select value={v} onChange={e => set(e.target.value)} style={{ background: 'rgba(15,12,40,0.9)', border: '1px solid rgba(124,58,237,0.3)', color: '#e0e7ff', padding: '8px 12px', borderRadius: 8, fontSize: 13, width: '100%', cursor: 'pointer', fontFamily: 'inherit' }}>
      {candidates.map(c => <option key={c.candidate_id} value={c.candidate_id}>{c.rank}. {c.candidate_name}</option>)}
    </select>
  );

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }} onClick={onClose}>
      <div style={{ background: 'rgba(15,12,40,0.97)', border: '1px solid rgba(124,58,237,0.3)', borderRadius: 20, padding: 32, width: '100%', maxWidth: 700, maxHeight: '90vh', overflow: 'auto' }} onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
          <h3 style={{ margin: 0, fontSize: 20, fontWeight: 800, background: 'linear-gradient(90deg,#a78bfa,#38bdf8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>⚖️ Compare Candidates</h3>
          <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: 'none', color: '#fff', width: 32, height: 32, borderRadius: 8, cursor: 'pointer', fontSize: 16, fontFamily: 'inherit' }}>✕</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 20 }}>
          <div><div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>CANDIDATE A</div>{sel(a, setA)}</div>
          <div><div style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)', marginBottom: 6 }}>CANDIDATE B</div>{sel(b, setB)}</div>
        </div>
        <button onClick={compare} disabled={loading || a === b} style={{ width: '100%', padding: '12px', background: a === b ? 'rgba(255,255,255,0.05)' : 'linear-gradient(135deg,#7c3aed,#2563eb)', border: 'none', borderRadius: 10, color: '#fff', fontWeight: 700, fontSize: 14, cursor: a === b ? 'not-allowed' : 'pointer', marginBottom: 20, fontFamily: 'inherit' }}>
          {loading ? '⏳ Comparing...' : '⚡ Run Comparison'}
        </button>
        {result && (
          <div>
            <div style={{ textAlign: 'center', marginBottom: 20 }}>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.5)', marginBottom: 4 }}>WINNER</div>
              <div style={{ fontSize: 22, fontWeight: 900, color: '#34d399' }}>🏆 {result.winner}</div>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginTop: 4 }}>Score diff: {result.score_diff > 0 ? '+' : ''}{result.score_diff?.toFixed(1)}</div>
            </div>
            {result.why_a_beats_b?.length > 0 && (
              <div style={{ background: 'rgba(52,211,153,0.06)', border: '1px solid rgba(52,211,153,0.15)', borderRadius: 12, padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 11, fontWeight: 800, color: '#34d399', marginBottom: 8 }}>WHY {result.candidate_a?.candidate_name?.split(' ')[0]} LEADS</div>
                {result.why_a_beats_b.map((r: string, i: number) => <div key={i} style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)', padding: '4px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>• {r}</div>)}
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
              {[['✓ Only A', result.skills_only_in_a, '#34d399'], ['Both', result.skills_in_both, '#a78bfa'], ['✓ Only B', result.skills_only_in_b, '#38bdf8']].map(([label, skills, col]) => (
                <div key={label as string} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 12 }}>
                  <div style={{ fontSize: 10, fontWeight: 700, color: col as string, marginBottom: 8 }}>{label as string}</div>
                  {(skills as string[]).slice(0, 6).map((s: string) => <div key={s} style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', padding: '2px 0' }}>{s}</div>)}
                  {(skills as string[]).length === 0 && <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.2)', fontStyle: 'italic' }}>none</div>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Candidate Card ────────────────────────────────────────────────────
function CandidateCard({ c, exp, active, onClick, jdSkillCount }: { c: Candidate; exp?: Explanation; active: boolean; onClick: () => void; jdSkillCount: number }) {
  const [tab, setTab] = useState<'scores' | 'graph' | 'evidence'>('scores');
  const col = scoreColor(c.final_score);

  const cleanEvidence = (c.top_evidence ?? []).filter(ch =>
    ch.section_type !== 'header' && ch.text.length > 60 && !ch.text.includes('@') && !/\+?[0-9]{10}/.test(ch.text)
  );

  const totalRequired = c.matched_required.length + c.missing_required.length;
  const coverPct = totalRequired > 0 ? Math.round((c.matched_required.length / totalRequired) * 100) : 0;

  return (
    <div className={`ccard ${active ? 'ccard--active' : ''}`} onClick={onClick} style={{ '--accent': col } as any}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 12 }}>
        <div style={{ position: 'relative' }}>
          <RingScore score={c.final_score} size={76} />
          {MEDAL[c.rank] && <div style={{ position: 'absolute', top: -6, right: -6, fontSize: 18 }}>{MEDAL[c.rank]}</div>}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ fontSize: 10, fontWeight: 800, color: col, background: `${col}18`, border: `1px solid ${col}33`, padding: '1px 8px', borderRadius: 4 }}>#{c.rank}</span>
          </div>
          <div style={{ fontSize: 15, fontWeight: 800, color: '#f0f4ff', marginBottom: 6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.candidate_name}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.06)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${coverPct}%`, background: coverPct >= 80 ? '#34d399' : coverPct >= 50 ? '#a78bfa' : '#f87171', transition: 'width 1s ease', borderRadius: 2 }} />
            </div>
            <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', whiteSpace: 'nowrap' }}>{c.matched_required.length}/{totalRequired} required ({coverPct}%)</span>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 12 }}>
        {c.matched_required.slice(0, 4).map(s => <span key={s} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'rgba(52,211,153,0.1)', color: '#34d399', border: '1px solid rgba(52,211,153,0.2)' }}>✓ {s}</span>)}
        {c.missing_required.slice(0, 2).map(s => <span key={s} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'rgba(248,113,113,0.08)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)' }}>✗ {s}</span>)}
        {c.matched_preferred.slice(0, 2).map(s => <span key={s} style={{ fontSize: 10, padding: '2px 7px', borderRadius: 4, background: 'rgba(56,189,248,0.08)', color: '#38bdf8', border: '1px solid rgba(56,189,248,0.18)' }}>~ {s}</span>)}
      </div>
      <div style={{ display: 'flex', gap: 2, marginBottom: 10, background: 'rgba(255,255,255,0.04)', borderRadius: 8, padding: 3 }}>
        {(['scores', 'graph', 'evidence'] as const).map(t => (
          <button key={t} onClick={e => { e.stopPropagation(); setTab(t); }}
            style={{ flex: 1, padding: '5px 0', background: tab === t ? 'rgba(124,58,237,0.25)' : 'transparent', border: tab === t ? '1px solid rgba(124,58,237,0.3)' : '1px solid transparent', color: tab === t ? '#a78bfa' : 'rgba(255,255,255,0.35)', borderRadius: 6, fontSize: 10, fontWeight: 700, cursor: 'pointer', textTransform: 'capitalize', fontFamily: 'inherit' }}>
            {t === 'graph' ? '⬡ Graph' : t === 'scores' ? '📊 Scores' : '📌 Evidence'}
          </button>
        ))}
      </div>
      {tab === 'scores' && (
        <div onClick={e => e.stopPropagation()}>
          <AnimBar label="Keyword" value={c.keyword_score} color="#a78bfa" />
          <AnimBar label="Semantic" value={c.semantic_score} color="#22d3ee" />
          <AnimBar label="Skill Cover" value={c.skill_coverage_score} color="#34d399" />
          <AnimBar label="BM25" value={c.bm25_score} color="#fb923c" />
          {c.penalty_applied > 0 && <AnimBar label="Penalty" value={c.penalty_applied} color="#f87171" />}
          <div style={{ marginTop: 12, maxHeight: 160, overflow: 'hidden' }}><RadarMini c={c} /></div>
        </div>
      )}
      {tab === 'graph' && (
        <div onClick={e => e.stopPropagation()}>
          <SkillGraph matched={c.matched_required} preferred={c.matched_preferred} missing={c.missing_required} name={c.candidate_name} />
        </div>
      )}
      {tab === 'evidence' && (
        <div onClick={e => e.stopPropagation()}>
          {cleanEvidence.length === 0 && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.25)', textAlign: 'center', padding: '16px 0' }}>No body-text evidence found</div>}
          {cleanEvidence.slice(0, 3).map((ch, i) => (
            <div key={i} style={{ background: 'rgba(34,211,238,0.05)', borderLeft: '2px solid #22d3ee', borderRadius: '0 8px 8px 0', padding: '8px 10px', marginBottom: 8 }}>
              <div style={{ fontSize: 9, fontWeight: 800, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>
                {ch.section_type.replace(/_\d+$/, '')} · {(ch.similarity * 100).toFixed(0)}% match
              </div>
              <div style={{ fontSize: 11, color: '#22d3ee', lineHeight: 1.6 }}>"{ch.text.slice(0, 260)}{ch.text.length > 260 ? '…' : ''}"</div>
            </div>
          ))}
          {exp?.template_summary && (
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 8, lineHeight: 1.6, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
              {exp.template_summary}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Upload Panel ──────────────────────────────────────────────────────
function UploadPanel({ onResult }: { onResult: (r: RankResult) => void }) {
  const [jdFile, setJdFile] = useState<File | null>(null);
  const [jdText, setJdText] = useState('');
  const [resumeFiles, setResumeFiles] = useState<File[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [fusionMode, setFusionMode] = useState('rrf');
  const [penalty, setPenalty] = useState(8);
  const [jdDrag, setJdDrag] = useState(false);
  const [resDrag, setResDrag] = useState(false);
  const jdRef = useRef<HTMLInputElement>(null);
  const resRef = useRef<HTMLInputElement>(null);

  const onJdDrop = useCallback((e: React.DragEvent) => { e.preventDefault(); setJdDrag(false); const f = e.dataTransfer.files[0]; if (f) setJdFile(f); }, []);
  const onResDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setResDrag(false);
    const fs = Array.from(e.dataTransfer.files).filter(f => /\.(pdf|docx)$/i.test(f.name));
    setResumeFiles(p => [...p, ...fs]);
  }, []);

  async function run() {
    if ((!jdText.trim() && !jdFile) || resumeFiles.length === 0) { setError('Provide a JD and at least 1 resume.'); return; }
    setError(''); setLoading(true); setProgress('Uploading…');
    const form = new FormData();
    if (jdFile) form.append('jd_file', jdFile); else form.append('jd_text', jdText);
    resumeFiles.forEach(f => form.append('resumes', f));
    form.append('fusion_mode', fusionMode);
    form.append('penalty_per_missing', String(penalty));
    try {
      setProgress('Running pipeline…');
      const res = await fetch(`${API}/api/v2/rank`, { method: 'POST', body: form });
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail || `HTTP ${res.status}`); }
      onResult(await res.json());
    } catch (e: any) { setError(e.message); }
    setLoading(false); setProgress('');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <div className="field-label">Job Description</div>
        {!jdFile ? (
          <>
            <div className={`dz ${jdDrag ? 'dz--over' : ''}`} onDragOver={e => { e.preventDefault(); setJdDrag(true); }} onDragLeave={() => setJdDrag(false)} onDrop={onJdDrop} onClick={() => jdRef.current?.click()}>
              <div className="dz-icon">📄</div>
              <div className="dz-text">Drop JD file or <span style={{ color: '#a78bfa' }}>browse</span></div>
              <div className="dz-sub">PDF · DOCX · TXT</div>
              <input ref={jdRef} type="file" accept=".pdf,.docx,.txt" hidden onChange={e => e.target.files?.[0] && setJdFile(e.target.files[0])} />
            </div>
            <div className="field-label" style={{ marginTop: 8, marginBottom: 4 }}>Or paste JD text</div>
            <textarea value={jdText} onChange={e => setJdText(e.target.value)} style={{ width: '100%', minHeight: 100, background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 10, color: '#e0e7ff', fontSize: 12, padding: '10px 12px', resize: 'vertical', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' }} placeholder="Paste job description text here…" />
          </>
        ) : (
          <div className="file-chip"><span>📄 {jdFile.name}</span><button onClick={() => setJdFile(null)} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 16 }}>✕</button></div>
        )}
      </div>
      <div>
        <div className="field-label">Resumes ({resumeFiles.length} files)</div>
        <div className={`dz dz--sm ${resDrag ? 'dz--over' : ''}`} onDragOver={e => { e.preventDefault(); setResDrag(true); }} onDragLeave={() => setResDrag(false)} onDrop={onResDrop} onClick={() => resRef.current?.click()}>
          <div className="dz-icon" style={{ fontSize: 24 }}>📁</div>
          <div className="dz-text">Drop resumes or <span style={{ color: '#a78bfa' }}>browse</span></div>
          <div className="dz-sub">PDF · DOCX (multiple)</div>
          <input ref={resRef} type="file" accept=".pdf,.docx" multiple hidden onChange={e => { if (e.target.files) setResumeFiles(p => [...p, ...Array.from(e.target.files!)]); }} />
        </div>
        {resumeFiles.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflow: 'auto' }}>
            {resumeFiles.map((f, i) => (
              <div key={i} className="file-chip">
                <span style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>📄 {f.name}</span>
                <button onClick={() => setResumeFiles(p => p.filter((_, j) => j !== i))} style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 13, flexShrink: 0 }}>✕</button>
              </div>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <div className="field-label">Fusion Mode</div>
          <select value={fusionMode} onChange={e => setFusionMode(e.target.value)} className="sel">
            <option value="rrf">RRF (Reciprocal Rank)</option>
            <option value="weighted">Weighted Avg</option>
          </select>
        </div>
        <div>
          <div className="field-label">Penalty: {penalty}</div>
          <input type="range" min={0} max={20} value={penalty} onChange={e => setPenalty(+e.target.value)} style={{ width: '100%', marginTop: 8, accentColor: '#a78bfa' }} />
        </div>
      </div>
      {error && <div style={{ background: 'rgba(248,113,113,0.1)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 8, padding: '10px 14px', fontSize: 12, color: '#f87171' }}>{error}</div>}
      <button onClick={run} disabled={loading} className="run-btn">
        {loading ? <><span className="spinner" /> {progress}</> : '⚡ Run Ranking Pipeline'}
      </button>
      {resumeFiles.length > 0 && <button onClick={() => setResumeFiles([])} style={{ background: 'none', border: '1px solid rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.35)', borderRadius: 8, padding: '8px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>Clear all resumes</button>}
    </div>
  );
}

// ── JD Analysis panel ─────────────────────────────────────────────────
function JDPanel({ jd, biasFlags }: { jd: RankResult['jd_analysis']; biasFlags: BiasFlag[] }) {
  const [showBias, setShowBias] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="glass-panel" style={{ padding: 14 }}>
        <div className="panel-label" style={{ marginBottom: 10 }}>JD Skills Extracted</div>
        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: '#34d399', fontWeight: 700, marginBottom: 5 }}>REQUIRED ({jd.required_skills.length})</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {jd.required_skills.map(s => <span key={s} style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(52,211,153,0.1)', color: '#34d399', border: '1px solid rgba(52,211,153,0.2)', borderRadius: 4 }}>{s}</span>)}
            {jd.required_skills.length === 0 && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.25)' }}>None detected</span>}
          </div>
        </div>
        {jd.preferred_skills.length > 0 && (
          <div>
            <div style={{ fontSize: 10, color: '#38bdf8', fontWeight: 700, marginBottom: 5 }}>PREFERRED ({jd.preferred_skills.length})</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {jd.preferred_skills.map(s => <span key={s} style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(56,189,248,0.08)', color: '#38bdf8', border: '1px solid rgba(56,189,248,0.18)', borderRadius: 4 }}>{s}</span>)}
            </div>
          </div>
        )}
      </div>
      {biasFlags.length > 0 && (
        <div className="glass-panel" style={{ padding: 14, border: '1px solid rgba(251,146,60,0.2)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div className="panel-label" style={{ color: '#fb923c' }}>⚠️ Bias Flags ({biasFlags.length})</div>
            <button onClick={() => setShowBias(!showBias)} style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: 11, fontFamily: 'inherit' }}>{showBias ? '▲' : '▼'}</button>
          </div>
          {showBias && biasFlags.map((f, i) => (
            <div key={i} style={{ background: 'rgba(251,146,60,0.06)', borderRadius: 8, padding: '8px 10px', marginBottom: 6, borderLeft: `2px solid ${f.severity === 'high' ? '#f87171' : '#fb923c'}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#fbbf24' }}>"{f.phrase}"</div>
              <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>{f.reason}</div>
              {f.suggestion && <div style={{ fontSize: 10, color: '#34d399', marginTop: 2 }}>💡 {f.suggestion}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Latency Panel ─────────────────────────────────────────────────────
function LatencyPanel({ latency }: { latency: RankResult['latency'] }) {
  const steps = [
    { k: 'jd_parsing_ms', l: 'JD Parse' }, { k: 'resume_parsing_ms', l: 'Resume Parse' },
    { k: 'keyword_scoring_ms', l: 'BM25+Keywords' }, { k: 'semantic_scoring_ms', l: 'Embeddings' },
    { k: 'fusion_ranking_ms', l: 'RRF Fusion' }, { k: 'explanation_ms', l: 'Explanations' },
  ];
  const max = Math.max(...Object.values(latency.breakdown), 1);
  return (
    <div className="glass-panel" style={{ padding: 14 }}>
      <div className="panel-label">⚡ Pipeline Latency</div>
      {steps.filter(s => latency.breakdown[s.k] !== undefined).map(s => (
        <div key={s.k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
          <span style={{ width: 90, fontSize: 10, color: 'rgba(255,255,255,0.4)', textAlign: 'right', flexShrink: 0 }}>{s.l}</span>
          <div style={{ flex: 1, height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2 }}>
            <div style={{ height: '100%', width: `${(latency.breakdown[s.k] / max) * 100}%`, background: 'linear-gradient(90deg,#7c3aed,#2563eb)', borderRadius: 2 }} />
          </div>
          <span style={{ fontSize: 10, color: '#a78bfa', width: 45, textAlign: 'right' }}>{latency.breakdown[s.k]}ms</span>
        </div>
      ))}
      <div style={{ fontSize: 12, fontWeight: 700, color: '#22d3ee', marginTop: 8, textAlign: 'right' }}>Total: {latency.total_ms}ms</div>
    </div>
  );
}

// ── Candidate Detail Drawer ───────────────────────────────────────────
function CandidateDrawer({ candidates, expMap, onClose, jdSkills }: {
  candidates: Candidate[];
  expMap: Record<string, Explanation>;
  onClose: () => void;
  jdSkills: string[];
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const [drawerTab, setDrawerTab] = useState<'overview' | 'skills' | 'graph' | 'evidence'>('overview');
  const c = candidates[activeIdx];
  const exp = expMap[c?.candidate_id];
  if (!c) return null;

  const col = scoreColor(c.final_score);
  const totalRequired = c.matched_required.length + c.missing_required.length;
  const coverPct = totalRequired > 0 ? Math.round((c.matched_required.length / totalRequired) * 100) : 0;
  const cleanEvidence = (c.top_evidence ?? []).filter(ch =>
    ch.section_type !== 'header' && ch.text.length > 60 && !ch.text.includes('@') && !/\+?[0-9]{10}/.test(ch.text)
  );

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 300, display: 'flex' }} onClick={onClose}>
      <div style={{ flex: 1, background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(6px)' }} />
      <div style={{ width: 640, height: '100vh', background: 'rgba(10,8,30,0.98)', borderLeft: '1px solid rgba(124,58,237,0.25)', overflowY: 'auto', display: 'flex', flexDirection: 'column', animation: 'drawerIn 0.25s ease' }} onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: 'rgba(255,255,255,0.3)', letterSpacing: '0.08em', textTransform: 'uppercase' }}>{candidates.length} Candidate{candidates.length > 1 ? 's' : ''} Selected</div>
            <button onClick={onClose} style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)', color: '#fff', width: 32, height: 32, borderRadius: 8, cursor: 'pointer', fontSize: 16, fontFamily: 'inherit' }}>✕</button>
          </div>
          {candidates.length > 1 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
              {candidates.map((cd, i) => (
                <button key={cd.candidate_id} onClick={() => { setActiveIdx(i); setDrawerTab('overview'); }}
                  style={{ padding: '5px 12px', borderRadius: 20, fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', background: activeIdx === i ? `${scoreColor(cd.final_score)}22` : 'rgba(255,255,255,0.04)', border: activeIdx === i ? `1px solid ${scoreColor(cd.final_score)}55` : '1px solid rgba(255,255,255,0.08)', color: activeIdx === i ? scoreColor(cd.final_score) : 'rgba(255,255,255,0.4)' }}>
                  #{cd.rank} {cd.candidate_name.split(' ')[0]}
                </button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <div style={{ position: 'relative' }}>
              <RingScore score={c.final_score} size={88} />
              {MEDAL[c.rank] && <div style={{ position: 'absolute', top: -6, right: -6, fontSize: 20 }}>{MEDAL[c.rank]}</div>}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 22, fontWeight: 900, color: '#f0f4ff', marginBottom: 4 }}>{c.candidate_name}</div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, color: col, background: `${col}18`, border: `1px solid ${col}33`, padding: '2px 10px', borderRadius: 4, fontWeight: 700 }}>Rank #{c.rank}</span>
                <span style={{ fontSize: 11, color: '#22d3ee', background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.2)', padding: '2px 10px', borderRadius: 4 }}>{c.matched_required.length}/{totalRequired} required ({coverPct}%)</span>
                <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)', padding: '2px 6px' }}>Score: {c.final_score.toFixed(1)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Tab strip */}
        <div style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          {(['overview', 'skills', 'graph', 'evidence'] as const).map(t => (
            <button key={t} onClick={() => setDrawerTab(t)}
              style={{ flex: 1, padding: '12px 0', background: 'transparent', border: 'none', borderBottom: drawerTab === t ? `2px solid ${col}` : '2px solid transparent', color: drawerTab === t ? col : 'rgba(255,255,255,0.35)', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
              {t === 'overview' ? '📊 Overview' : t === 'skills' ? '🎯 Skills' : t === 'graph' ? '⬡ Graph' : '📌 Evidence'}
            </button>
          ))}
        </div>

        {/* Content */}
        <div style={{ flex: 1, padding: 24, overflowY: 'auto' }}>
          {drawerTab === 'overview' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, textAlign: 'center' }}>
                {([['Final', c.final_score, col], ['Keyword', c.keyword_score, '#a78bfa'], ['Semantic', c.semantic_score, '#22d3ee'], ['Skill Cov', c.skill_coverage_score, '#34d399']] as [string, number, string][]).map(([l, v, clr]) => (
                  <div key={l} style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 12, padding: 14, border: `1px solid ${clr}22` }}>
                    <RingScore score={v} size={68} />
                    <div style={{ fontSize: 9, color: 'rgba(255,255,255,0.35)', marginTop: 6, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em' }}>{l}</div>
                  </div>
                ))}
              </div>
              <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 14, padding: 16 }}>
                <div className="panel-label" style={{ marginBottom: 12 }}>Score Breakdown</div>
                <AnimBar label="Keyword" value={c.keyword_score} color="#a78bfa" />
                <AnimBar label="Semantic" value={c.semantic_score} color="#22d3ee" />
                <AnimBar label="Skill Cover" value={c.skill_coverage_score} color="#34d399" />
                <AnimBar label="BM25" value={c.bm25_score} color="#fb923c" />
                {c.penalty_applied > 0 && <AnimBar label="Penalty" value={c.penalty_applied} color="#f87171" />}
              </div>
              <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 14, padding: 16 }}>
                <div className="panel-label" style={{ marginBottom: 8 }}>Score Radar</div>
                <div style={{ maxHeight: 220 }}><RadarMini c={c} /></div>
              </div>
              {exp?.template_summary && (
                <div style={{ background: 'rgba(124,58,237,0.05)', border: '1px solid rgba(124,58,237,0.15)', borderRadius: 12, padding: 16 }}>
                  <div className="panel-label" style={{ marginBottom: 8, color: '#a78bfa' }}>AI Summary</div>
                  <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)', lineHeight: 1.7 }}>{exp.template_summary}</div>
                </div>
              )}
            </div>
          )}

          {drawerTab === 'skills' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {c.matched_required.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: '#34d399', marginBottom: 10 }}>✓ MATCHED REQUIRED ({c.matched_required.length})</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {c.matched_required.map(s => <span key={s} style={{ fontSize: 12, padding: '4px 12px', background: 'rgba(52,211,153,0.1)', color: '#34d399', border: '1px solid rgba(52,211,153,0.25)', borderRadius: 6 }}>✓ {s}</span>)}
                  </div>
                </div>
              )}
              {c.matched_preferred.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: '#38bdf8', marginBottom: 10 }}>~ PREFERRED / BONUS ({c.matched_preferred.length})</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {c.matched_preferred.map(s => <span key={s} style={{ fontSize: 12, padding: '4px 12px', background: 'rgba(56,189,248,0.08)', color: '#38bdf8', border: '1px solid rgba(56,189,248,0.2)', borderRadius: 6 }}>~ {s}</span>)}
                  </div>
                </div>
              )}
              {c.missing_required.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: '#f87171', marginBottom: 10 }}>✗ MISSING REQUIRED ({c.missing_required.length})</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                    {c.missing_required.map(s => <span key={s} style={{ fontSize: 12, padding: '4px 12px', background: 'rgba(248,113,113,0.08)', color: '#f87171', border: '1px solid rgba(248,113,113,0.2)', borderRadius: 6 }}>✗ {s}</span>)}
                  </div>
                </div>
              )}
              {jdSkills.length > 0 && (
                <div style={{ background: 'rgba(255,255,255,0.02)', borderRadius: 12, padding: 16 }}>
                  <div className="panel-label" style={{ marginBottom: 10 }}>Coverage vs Full JD</div>
                  {jdSkills.map(skill => {
                    const matched = c.matched_required.includes(skill) || c.matched_preferred.includes(skill);
                    const clr = matched ? '#34d399' : '#f87171';
                    return (
                      <div key={skill} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                        <div style={{ width: 7, height: 7, borderRadius: '50%', background: clr, boxShadow: `0 0 5px ${clr}`, flexShrink: 0 }} />
                        <span style={{ fontSize: 11, color: matched ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.25)', flex: 1 }}>{skill}</span>
                        <span style={{ fontSize: 10, color: clr, fontWeight: 700 }}>{matched ? '✓' : '✗'}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {drawerTab === 'graph' && (
            <div>
              <div className="panel-label" style={{ marginBottom: 12 }}>Skill Relationship Graph</div>
              <SkillGraph matched={c.matched_required} preferred={c.matched_preferred} missing={c.missing_required} name={c.candidate_name} />
            </div>
          )}

          {drawerTab === 'evidence' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="panel-label">Top Evidence Chunks</div>
              {cleanEvidence.length === 0 && <div style={{ color: 'rgba(255,255,255,0.25)', textAlign: 'center', padding: 40 }}>No substantial evidence found</div>}
              {cleanEvidence.map((ch, i) => (
                <div key={i} style={{ background: 'rgba(34,211,238,0.04)', borderLeft: '2px solid #22d3ee', borderRadius: '0 12px 12px 0', padding: '12px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 10, fontWeight: 800, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.06em' }}>{ch.section_type.replace(/_\d+$/, '')}</span>
                    <span style={{ fontSize: 10, color: '#22d3ee' }}>{(ch.similarity * 100).toFixed(0)}% match</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#22d3ee', lineHeight: 1.7 }}>"{ch.text}"</div>
                </div>
              ))}
              {exp?.template_summary && (
                <div style={{ background: 'rgba(124,58,237,0.05)', border: '1px solid rgba(124,58,237,0.15)', borderRadius: 12, padding: 16, marginTop: 8 }}>
                  <div className="panel-label" style={{ color: '#a78bfa', marginBottom: 6 }}>Template Summary</div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', lineHeight: 1.7 }}>{exp.template_summary}</div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────
export default function RankPage() {
  const navigate = useNavigate();
  const [result, setResult] = useState<RankResult | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDrawer, setShowDrawer] = useState(false);
  const [showCompare, setShowCompare] = useState(false);
  const [activeView, setActiveView] = useState<'list' | 'analytics'>('list');
  const [search, setSearch] = useState('');

  const expMap = useMemo(() => Object.fromEntries((result?.explanations ?? []).map(e => [e.candidate_id, e])), [result]);

  const filtered = useMemo(() => {
    if (!result) return [];
    const q = search.toLowerCase();
    return result.candidates.filter(c =>
      !q || c.candidate_name.toLowerCase().includes(q) ||
      c.matched_required.some(s => s.toLowerCase().includes(q)) ||
      c.matched_preferred.some(s => s.toLowerCase().includes(q))
    );
  }, [result, search]);

  function handleResult(r: RankResult) { setResult(r); setSelectedIds(new Set()); }

  function toggleSelect(id: string, e: React.MouseEvent) {
    e.stopPropagation();
    setSelectedIds(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }

  const selectedCandidates = useMemo(() => result?.candidates.filter(c => selectedIds.has(c.candidate_id)) ?? [], [result, selectedIds]);
  const jdSkills = result?.jd_analysis.required_skills ?? [];

  return (
    <div className="rp-root">
      <ParticleCanvas />

      <nav className="rp-nav">
        <button className="rp-nav-back" onClick={() => navigate('/')}>← Home</button>
        <div className="rp-nav-brand">
          <span style={{ fontSize: 22, lineHeight: 1 }}>⬡</span>
          <span>Smart Shortlisting Engine</span>
          <span className="rp-nav-badge">v2</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {result && <button className="rp-nav-pill" onClick={() => setShowCompare(true)}>⚖️ Compare</button>}
          <a href={`${API}/docs`} target="_blank" rel="noopener noreferrer" className="rp-nav-pill">📋 API Docs</a>
          <a href={`${API}/api/v2/results/export`} target="_blank" rel="noopener noreferrer" className="rp-nav-pill" style={{ color: '#34d399' }}>⬇️ Export CSV</a>
        </div>
      </nav>

      <div className="rp-body">
        <aside className="rp-sidebar glass-panel">
          <div className="panel-label" style={{ marginBottom: 14, fontSize: 13 }}>📄 Configure & Upload</div>
          <UploadPanel onResult={handleResult} />
        </aside>

        <main className="rp-main">
          {!result ? (
            <div className="rp-empty">
              <div style={{ fontSize: 64, marginBottom: 16 }}>⬡</div>
              <h2 style={{ fontSize: 24, fontWeight: 900, color: '#a78bfa', margin: '0 0 8px' }}>Ready to Rank</h2>
              <p style={{ color: 'rgba(255,255,255,0.35)', fontSize: 14 }}>Upload a JD + resumes and click <strong style={{ color: '#a78bfa' }}>Run Ranking Pipeline</strong></p>
            </div>
          ) : (
            <>
              <div className="rp-results-header">
                <div>
                  <div style={{ fontSize: 22, fontWeight: 900, color: '#f0f4ff' }}>{result.total_resumes} Candidates Ranked</div>
                  <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.4)', marginTop: 2 }}>{result.jd_analysis.required_skills.length} required skills · {result.latency.total_ms}ms · click cards to select</div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Filter…" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: '#e0e7ff', padding: '8px 12px', borderRadius: 8, fontSize: 12, outline: 'none', width: 150 }} />
                  <button className={`view-tab ${activeView === 'list' ? 'view-tab--active' : ''}`} onClick={() => setActiveView('list')}>📋 List</button>
                  <button className={`view-tab ${activeView === 'analytics' ? 'view-tab--active' : ''}`} onClick={() => setActiveView('analytics')}>📊 Analytics</button>
                </div>
              </div>

              {activeView === 'analytics' && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 20 }}>
                  <ScoreHistogram candidates={result.candidates} />
                  <JDPanel jd={result.jd_analysis} biasFlags={result.bias_flags} />
                  <LatencyPanel latency={result.latency} />
                  <div className="glass-panel" style={{ padding: 14 }}>
                    <div className="panel-label">🏆 Top Candidate Radar</div>
                    {result.candidates.slice(0, 1).map(c => <RadarMini key={c.candidate_id} c={c} />)}
                  </div>
                </div>
              )}

              {activeView === 'list' && (
                <div className="rp-cards-grid">
                  {filtered.map(c => {
                    const isSel = selectedIds.has(c.candidate_id);
                    return (
                      <div key={c.candidate_id} style={{ position: 'relative' }}>
                        <button className={`select-btn ${isSel ? 'select-btn--on' : ''}`} onClick={e => toggleSelect(c.candidate_id, e)} title={isSel ? 'Deselect' : 'Select'}>{isSel ? '✓' : '+'}</button>
                        <button className="detail-btn" onClick={e => { e.stopPropagation(); setSelectedIds(new Set([c.candidate_id])); setShowDrawer(true); }} title="View full details">⬡</button>
                        <CandidateCard c={c} exp={expMap[c.candidate_id]} active={isSel}
                          onClick={() => { setSelectedIds(new Set([c.candidate_id])); setShowDrawer(true); }}
                          jdSkillCount={result.jd_analysis.required_skills.length} />
                      </div>
                    );
                  })}
                  {filtered.length === 0 && <div style={{ color: 'rgba(255,255,255,0.25)', textAlign: 'center', gridColumn: '1/-1', padding: 40 }}>No candidates match your filter</div>}
                </div>
              )}
            </>
          )}
        </main>

        {result && (
          <aside className="rp-right glass-panel">
            <JDPanel jd={result.jd_analysis} biasFlags={result.bias_flags} />
            <div style={{ marginTop: 16 }}><LatencyPanel latency={result.latency} /></div>
            <div style={{ marginTop: 16 }}><ScoreHistogram candidates={result.candidates} /></div>
          </aside>
        )}
      </div>

      {/* Floating selection tray */}
      {selectedIds.size > 0 && (
        <div className="selection-tray">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div className="selection-tray-count">{selectedIds.size}</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>{selectedIds.size === 1 ? 'candidate selected' : 'candidates selected'}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="tray-btn tray-btn--primary" onClick={() => setShowDrawer(true)}>👁 View Details</button>
            {selectedIds.size >= 2 && <button className="tray-btn" onClick={() => setShowCompare(true)}>⚖️ Compare</button>}
            <button className="tray-btn tray-btn--clear" onClick={() => setSelectedIds(new Set())}>✕ Clear</button>
          </div>
        </div>
      )}

      {showDrawer && selectedCandidates.length > 0 && (
        <CandidateDrawer candidates={selectedCandidates} expMap={expMap} onClose={() => setShowDrawer(false)} jdSkills={jdSkills} />
      )}

      {showCompare && result && <CompareModal candidates={result.candidates} onClose={() => setShowCompare(false)} />}
    </div>
  );
}
