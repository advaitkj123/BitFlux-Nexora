import { useState, useRef, useCallback, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Chart as ChartJS,
  RadialLinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
  CategoryScale,
  LinearScale,
  BarElement,
} from 'chart.js';
import { Radar, Bar } from 'react-chartjs-2';
import SkillGraph3D from '../components/SkillGraph3D';
import './rank.css';

ChartJS.register(
  RadialLinearScale, PointElement, LineElement, Filler, Tooltip, Legend,
  CategoryScale, LinearScale, BarElement,
);

// ── Types ─────────────────────────────────────────────────────────────
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

// ── Helpers ──────────────────────────────────────────────────────────
function scoreColor(s: number) {
  if (s >= 75) return '#22d3ee';
  if (s >= 50) return '#a78bfa';
  if (s >= 30) return '#fb923c';
  return '#f87171';
}
function rankBadge(r: number) {
  if (r === 1) return { bg: 'linear-gradient(135deg,#f59e0b,#d97706)', text: '🥇 #1' };
  if (r === 2) return { bg: 'linear-gradient(135deg,#94a3b8,#64748b)', text: '🥈 #2' };
  if (r === 3) return { bg: 'linear-gradient(135deg,#c2855e,#a16240)', text: '🥉 #3' };
  return { bg: 'rgba(255,255,255,0.06)', text: `#${r}` };
}

// ── Sub-components ───────────────────────────────────────────────────

function RadarCard({ candidate }: { candidate: Candidate }) {
  const data = {
    labels: ['Keyword', 'Semantic', 'Skill Cover', 'BM25', 'Req. Coverage'],
    datasets: [{
      label: candidate.candidate_name,
      data: [
        candidate.keyword_score,
        candidate.semantic_score,
        candidate.skill_coverage_score,
        candidate.bm25_score,
        candidate.required_coverage * 100,
      ],
      backgroundColor: 'rgba(124,58,237,0.18)',
      borderColor: '#7c3aed',
      borderWidth: 2,
      pointBackgroundColor: '#a78bfa',
      pointRadius: 4,
    }],
  };
  const opts = {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      r: {
        min: 0, max: 100,
        grid: { color: 'rgba(255,255,255,0.07)' },
        angleLines: { color: 'rgba(255,255,255,0.08)' },
        pointLabels: { color: 'rgba(255,255,255,0.5)', font: { size: 10 } },
        ticks: { display: false },
      },
    },
  };
  return <Radar data={data} options={opts as any} />;
}

function ScoreBar({ label, value, color, max = 100 }: { label: string; value: number; color: string; max?: number }) {
  const pct = Math.min(100, (value / max) * 100);
  return (
    <div className="score-bar-row">
      <span className="score-bar-label">{label}</span>
      <div className="score-bar-track">
        <div className="score-bar-fill" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="score-bar-value" style={{ color }}>{value.toFixed(1)}</span>
    </div>
  );
}

function CircleScore({ score, size = 80 }: { score: number; size?: number }) {
  const r = (size / 2) - 8;
  const circ = 2 * Math.PI * r;
  const pct = score / 100;
  const color = scoreColor(score);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="circle-score">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={6} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke={color} strokeWidth={6}
        strokeDasharray={circ}
        strokeDashoffset={circ * (1 - pct)}
        strokeLinecap="round"
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 1s ease', filter: `drop-shadow(0 0 6px ${color})` }}
      />
      <text x="50%" y="50%" dominantBaseline="middle" textAnchor="middle"
        fill={color} fontSize={size * 0.22} fontWeight={800} fontFamily="Inter">
        {score.toFixed(0)}
      </text>
    </svg>
  );
}

function LatencyBadge({ breakdown }: { breakdown: Record<string, number> }) {
  const steps = [
    { key: 'jd_parsing_ms', label: 'JD Parse' },
    { key: 'resume_parsing_ms', label: 'Resume Parse' },
    { key: 'keyword_scoring_ms', label: 'BM25+Keywords' },
    { key: 'semantic_scoring_ms', label: 'Embeddings' },
    { key: 'fusion_ranking_ms', label: 'RRF Fusion' },
    { key: 'explanation_ms', label: 'Explanations' },
    { key: 'bias_check_ms', label: 'Bias Check' },
  ];
  return (
    <div className="latency-panel glass-dark">
      <div className="latency-title">⚡ Pipeline Latency Breakdown</div>
      <div className="latency-steps">
        {steps.filter(s => breakdown[s.key] !== undefined).map(s => (
          <div key={s.key} className="latency-step">
            <span className="latency-step-label">{s.label}</span>
            <div className="latency-bar-track">
              <div className="latency-bar-fill" style={{
                width: `${Math.min(100, (breakdown[s.key] / Math.max(...Object.values(breakdown))) * 100)}%`
              }} />
            </div>
            <span className="latency-step-ms">{breakdown[s.key]}ms</span>
          </div>
        ))}
      </div>
      <div className="latency-total">Total: {breakdown.total_ms}ms</div>
    </div>
  );
}

function ScoreHistogram({ candidates }: { candidates: Candidate[] }) {
  const buckets = [0, 0, 0, 0, 0]; // 0-20, 20-40, 40-60, 60-80, 80-100
  candidates.forEach(c => {
    const b = Math.min(4, Math.floor(c.final_score / 20));
    buckets[b]++;
  });
  const data = {
    labels: ['0-20', '20-40', '40-60', '60-80', '80-100'],
    datasets: [{
      label: 'Candidates',
      data: buckets,
      backgroundColor: ['#f87171aa','#fb923caa','#fbbf24aa','#a78bfaaa','#22d3eeaa'],
      borderRadius: 6,
    }],
  };
  const opts = {
    responsive: true,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.4)' } },
      y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.4)', stepSize: 1 } },
    },
  };
  return (
    <div className="histogram-card glass-dark">
      <div className="histogram-title">Score Distribution</div>
      <Bar data={data} options={opts as any} />
    </div>
  );
}

function CompareModal({ candidates, onClose }: { candidates: Candidate[]; onClose: () => void }) {
  const [idA, setIdA] = useState(candidates[0]?.candidate_id ?? '');
  const [idB, setIdB] = useState(candidates[1]?.candidate_id ?? '');
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  async function compare() {
    setLoading(true);
    try {
      const r = await fetch(`${API}/api/v2/compare?id_a=${idA}&id_b=${idB}`);
      setResult(await r.json());
    } catch { /* ignore */ }
    setLoading(false);
  }

  const ca = candidates.find(c => c.candidate_id === idA);
  const cb = candidates.find(c => c.candidate_id === idB);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="compare-modal glass-dark" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">⚖️ Compare Candidates</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>

        <div className="compare-selects">
          <select value={idA} onChange={e => setIdA(e.target.value)} className="compare-select">
            {candidates.map(c => <option key={c.candidate_id} value={c.candidate_id}>{c.candidate_name} (#{c.rank})</option>)}
          </select>
          <span className="compare-vs">VS</span>
          <select value={idB} onChange={e => setIdB(e.target.value)} className="compare-select">
            {candidates.map(c => <option key={c.candidate_id} value={c.candidate_id}>{c.candidate_name} (#{c.rank})</option>)}
          </select>
          <button className="btn-compare" onClick={compare} disabled={loading || idA === idB}>
            {loading ? '...' : 'Compare'}
          </button>
        </div>

        {result && !result.detail && (
          <div className="compare-result">
            <div className="compare-winner">
              🏆 Winner: <strong>{result.winner}</strong>
              {result.score_diff !== 0 && <span className="compare-diff"> ({result.score_diff > 0 ? '+' : ''}{result.score_diff.toFixed(1)} pts)</span>}
            </div>

            <div className="compare-reasons">
              {(result.why_a_beats_b || []).map((r: string, i: number) => (
                <div key={i} className="compare-reason">✓ {r}</div>
              ))}
            </div>

            <div className="compare-skills-grid">
              <div className="compare-col">
                <div className="compare-col-header" style={{ color: '#22d3ee' }}>
                  {result.candidate_a?.candidate_name} only
                </div>
                {result.skills_only_in_a?.map((s: string) => <span key={s} className="compare-skill green">{s}</span>)}
                {result.skills_only_in_a?.length === 0 && <span className="compare-none">—</span>}
              </div>
              <div className="compare-col">
                <div className="compare-col-header" style={{ color: '#a78bfa' }}>Both have</div>
                {result.skills_in_both?.map((s: string) => <span key={s} className="compare-skill both">{s}</span>)}
                {result.skills_in_both?.length === 0 && <span className="compare-none">—</span>}
              </div>
              <div className="compare-col">
                <div className="compare-col-header" style={{ color: '#f87171' }}>
                  {result.candidate_b?.candidate_name} only
                </div>
                {result.skills_only_in_b?.map((s: string) => <span key={s} className="compare-skill red">{s}</span>)}
                {result.skills_only_in_b?.length === 0 && <span className="compare-none">—</span>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function CandidateCard({
  candidate, explanation, onSelect, selected,
}: {
  candidate: Candidate;
  explanation?: Explanation;
  onSelect: () => void;
  selected: boolean;
}) {
  const badge = rankBadge(candidate.rank);
  const [expanded, setExpanded] = useState(false);
  const [showGraph, setShowGraph] = useState(false);

  // Clean evidence: filter out contact-info evidence (lines with @, phone patterns)
  const cleanEvidence = (explanation?.supporting_evidence ?? []).filter(e => {
    const lower = e.toLowerCase();
    return !(
      lower.includes('@') ||
      /\+?[0-9]{10,}/.test(e) ||
      lower.includes('linkedin') ||
      lower.includes('github.com') ||
      e.length < 40
    );
  });

  // Clean top_evidence chunks from the candidate object — filter header-type content
  const cleanChunks = candidate.top_evidence.filter(chunk => {
    const t = chunk.text.toLowerCase();
    return !(
      t.includes('@') && t.includes('.com') ||
      chunk.section_type === 'header' ||
      /\+?[0-9]{10}/.test(chunk.text) ||
      chunk.text.length < 60
    );
  });

  return (
    <div
      className={`candidate-card glass-dark ${selected ? 'selected' : ''} ${candidate.rank <= 3 ? 'top3' : ''}`}
      onClick={onSelect}
    >
      <div className="card-top">
        <div className="card-left">
          <div className="rank-badge" style={{ background: badge.bg }}>{badge.text}</div>
          <div className="candidate-name">{candidate.candidate_name}</div>
          <div className="coverage-pills">
            <span className="coverage-pill green">
              ✓ {candidate.matched_required.length}/{candidate.matched_required.length + candidate.missing_required.length} required
            </span>
            {candidate.missing_required.length > 0 && (
              <span className="coverage-pill red">
                ✗ {candidate.missing_required.length} missing
              </span>
            )}
          </div>
        </div>
        <div className="card-right">
          <CircleScore score={candidate.final_score} size={68} />
        </div>
      </div>

      <div className="score-bars">
        <ScoreBar label="Keyword" value={candidate.keyword_score} color="#a78bfa" />
        <ScoreBar label="Semantic" value={candidate.semantic_score} color="#22d3ee" />
        <ScoreBar label="Skill Cover" value={candidate.skill_coverage_score} color="#34d399" />
        {candidate.penalty_applied > 0 && (
          <ScoreBar label="Penalty" value={candidate.penalty_applied} color="#f87171" />
        )}
      </div>

      <div className="skill-chips">
        {candidate.matched_required.slice(0, 5).map(s => (
          <span key={s} className="skill-chip green">✓ {s}</span>
        ))}
        {candidate.missing_required.slice(0, 3).map(s => (
          <span key={s} className="skill-chip red">✗ {s}</span>
        ))}
        {candidate.matched_preferred.slice(0, 3).map(s => (
          <span key={s} className="skill-chip blue">~ {s}</span>
        ))}
        {candidate.matched_required.length > 5 && (
          <span className="skill-chip grey">+{candidate.matched_required.length - 5} more</span>
        )}
      </div>

      {/* ── 3D Skill Graph toggle */}
      <div className="card-actions" onClick={e => e.stopPropagation()}>
        <button
          className="expand-btn"
          onClick={() => setShowGraph(!showGraph)}
        >
          {showGraph ? '▲ Hide skill graph' : '▼ Show 3D skill graph'}
        </button>
        {(explanation || cleanChunks.length > 0) && (
          <button
            className="expand-btn"
            style={{ marginLeft: 12 }}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? '▲ Hide evidence' : '▼ Show evidence'}
          </button>
        )}
      </div>

      {showGraph && (
        <div className="skill-graph-section" onClick={e => e.stopPropagation()}>
          <SkillGraph3D
            candidateName={candidate.candidate_name}
            matchedRequired={candidate.matched_required}
            matchedPreferred={candidate.matched_preferred}
            missingRequired={candidate.missing_required}
            height={280}
          />
        </div>
      )}

      {expanded && (
        <div className="explanation-body" onClick={e => e.stopPropagation()}>
          {(explanation?.llm_summary || explanation?.template_summary) && (
            <p className="explanation-summary">
              {explanation.llm_summary || explanation.template_summary}
            </p>
          )}

          {/* Clean evidence from top_evidence chunks */}
          {cleanChunks.length > 0 && (
            <div className="evidence-list">
              <div className="evidence-header">📌 Strongest matching resume sections:</div>
              {cleanChunks.slice(0, 3).map((chunk, i) => (
                <div key={i} className="evidence-item">
                  <div className="evidence-section-tag">{chunk.section_type.replace(/_\d+$/, '')} • {(chunk.similarity * 100).toFixed(0)}% match</div>
                  <div className="evidence-text">"{chunk.text.slice(0, 280)}{chunk.text.length > 280 ? '...' : ''}"</div>
                </div>
              ))}
            </div>
          )}

          {/* Additional evidence from explanation */}
          {cleanEvidence.length > 0 && cleanChunks.length === 0 && (
            <div className="evidence-list">
              <div className="evidence-header">📌 Evidence from resume:</div>
              {cleanEvidence.slice(0, 2).map((e, i) => (
                <div key={i} className="evidence-item">
                  <div className="evidence-text">"{e.slice(0, 280)}{e.length > 280 ? '...' : ''}"</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card-radar" onClick={e => e.stopPropagation()}>
        <RadarCard candidate={candidate} />
      </div>
    </div>
  );
}

function BiasPanel({ flags }: { flags: BiasFlag[] }) {
  if (flags.length === 0) return (
    <div className="bias-clean glass-dark">
      <span className="bias-clean-icon">✅</span>
      <span>No bias detected in job description</span>
    </div>
  );
  return (
    <div className="bias-panel glass-dark">
      <div className="bias-title">⚠️ JD Bias Flags ({flags.length})</div>
      {flags.map((f, i) => (
        <div key={i} className={`bias-flag severity-${f.severity.toLowerCase()}`}>
          <div className="bias-flag-header">
            <span className="bias-severity">{f.severity}</span>
            <span className="bias-category">{f.category}</span>
            <span className="bias-phrase">"{f.phrase}"</span>
          </div>
          <div className="bias-reason">{f.reason}</div>
          {f.suggestion && <div className="bias-suggestion">💡 {f.suggestion}</div>}
        </div>
      ))}
    </div>
  );
}

function RecruiterChat({ candidates }: { candidates: Candidate[] }) {
  const [messages, setMessages] = useState<{ role: 'user' | 'ai'; text: string }[]>([
    { role: 'ai', text: 'Ask me anything about the rankings! e.g. "Why is candidate 1 ranked above candidate 3?" or "Who has the most React experience?"' },
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function send() {
    if (!input.trim() || loading) return;
    const q = input;
    setInput('');
    setMessages(m => [...m, { role: 'user', text: q }]);
    setLoading(true);
    try {
      const res = await fetch(`${API}/api/v2/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = await res.json();
      setMessages(m => [...m, { role: 'ai', text: data.answer || data.detail || 'No answer returned.' }]);
    } catch {
      setMessages(m => [...m, { role: 'ai', text: 'Could not connect to chat API. Check backend is running.' }]);
    }
    setLoading(false);
  }

  return (
    <div className="chat-panel glass-dark">
      <div className="chat-title">💬 Recruiter Chat</div>
      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            <div className="chat-bubble">{m.text}</div>
          </div>
        ))}
        {loading && <div className="chat-msg ai"><div className="chat-bubble typing">Thinking...</div></div>}
        <div ref={bottomRef} />
      </div>
      <div className="chat-input-row">
        <input
          className="chat-input"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && send()}
          placeholder="Ask about the rankings..."
        />
        <button className="chat-send" onClick={send} disabled={loading}>→</button>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────
export default function RankPage() {
  const navigate = useNavigate();
  const [jdText, setJdText] = useState('');
  const [jdFile, setJdFile] = useState<File | null>(null);
  const [resumeFiles, setResumeFiles] = useState<File[]>([]);
  const [result, setResult] = useState<RankResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCompare, setShowCompare] = useState(false);
  const [fusionMode, setFusionMode] = useState<'rrf' | 'weighted'>('rrf');
  const [penalty, setPenalty] = useState(8);
  const [jdDragging, setJdDragging] = useState(false);
  const [resumeDragging, setResumeDragging] = useState(false);
  const resumeInputRef = useRef<HTMLInputElement>(null);
  const jdInputRef = useRef<HTMLInputElement>(null);

  const handleResumesDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setResumeDragging(false);
    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.name.endsWith('.pdf') || f.name.endsWith('.docx') || f.name.endsWith('.txt')
    );
    setResumeFiles(prev => [...prev, ...files]);
  }, []);

  const handleJdDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setJdDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) setJdFile(f);
  }, []);

  async function runRanking() {
    if ((!jdText.trim() && !jdFile) || resumeFiles.length === 0) {
      setError('Please provide a JD and at least one resume.');
      return;
    }
    setError('');
    setLoading(true);
    setResult(null);

    const form = new FormData();
    if (jdFile) form.append('jd_file', jdFile);
    else form.append('jd_text', jdText);
    resumeFiles.forEach(f => form.append('resumes', f));
    form.append('fusion_mode', fusionMode);
    form.append('penalty_per_missing', String(penalty));

    try {
      const res = await fetch(`${API}/api/v2/rank`, { method: 'POST', body: form });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      const data: RankResult = await res.json();
      setResult(data);
      setSelectedId(data.candidates[0]?.candidate_id ?? null);
    } catch (e: any) {
      setError(e.message || 'Pipeline failed.');
    }
    setLoading(false);
  }

  const expMap = Object.fromEntries((result?.explanations ?? []).map(e => [e.candidate_id, e]));

  return (
    <div className="rank-root">
      {/* ── Navigation ─────────────────────────────────────────── */}
      <nav className="rank-nav">
        <button className="nav-back" onClick={() => navigate('/')}>← InternLoom</button>
        <div className="nav-title">
          <span className="nav-icon">⬡</span>
          <span>Smart Shortlisting Engine</span>
        </div>
        <div className="nav-pills">
          <span className="nav-pill active">Rank</span>
          <button className="nav-pill" onClick={() => navigate('/')}>Home</button>
        </div>
      </nav>

      <div className="rank-layout">
        {/* ── Left: Upload Panel ──────────────────────────────── */}
        <aside className="upload-panel glass-dark">
          <h2 className="panel-heading">📄 Job Description</h2>

          {!jdFile ? (
            <div
              className={`drop-zone ${jdDragging ? 'dragging' : ''}`}
              onDragOver={e => { e.preventDefault(); setJdDragging(true); }}
              onDragLeave={() => setJdDragging(false)}
              onDrop={handleJdDrop}
              onClick={() => jdInputRef.current?.click()}
            >
              <input ref={jdInputRef} type="file" accept=".pdf,.docx,.txt" hidden onChange={e => e.target.files?.[0] && setJdFile(e.target.files[0])} />
              <div className="drop-icon">📋</div>
              <div className="drop-text">Drop JD file or click</div>
            </div>
          ) : (
            <div className="file-badge">
              📄 {jdFile.name}
              <button onClick={() => setJdFile(null)} className="file-remove">✕</button>
            </div>
          )}

          {!jdFile && (
            <textarea
              className="jd-textarea"
              placeholder="…or paste job description text here (min 50 chars)"
              value={jdText}
              onChange={e => setJdText(e.target.value)}
              rows={8}
            />
          )}

          <h2 className="panel-heading" style={{ marginTop: 20 }}>📁 Resumes ({resumeFiles.length})</h2>
          <div
            className={`drop-zone ${resumeDragging ? 'dragging' : ''}`}
            onDragOver={e => { e.preventDefault(); setResumeDragging(true); }}
            onDragLeave={() => setResumeDragging(false)}
            onDrop={handleResumesDrop}
            onClick={() => resumeInputRef.current?.click()}
          >
            <input ref={resumeInputRef} type="file" accept=".pdf,.docx,.txt" multiple hidden
              onChange={e => setResumeFiles(prev => [...prev, ...Array.from(e.target.files ?? [])])} />
            <div className="drop-icon">📂</div>
            <div className="drop-text">Drop resumes (PDF/DOCX) or click</div>
            <div className="drop-hint">Multiple files supported</div>
          </div>

          {resumeFiles.length > 0 && (
            <div className="resume-list">
              {resumeFiles.map((f, i) => (
                <div key={i} className="resume-item">
                  <span>📄 {f.name}</span>
                  <button className="file-remove" onClick={() => setResumeFiles(prev => prev.filter((_, j) => j !== i))}>✕</button>
                </div>
              ))}
              <button className="clear-all-btn" onClick={() => setResumeFiles([])}>Clear all</button>
            </div>
          )}

          <div className="settings-section">
            <h2 className="panel-heading" style={{ marginTop: 16 }}>⚙️ Settings</h2>
            <label className="setting-label">Fusion Mode</label>
            <div className="fusion-toggle">
              <button className={`fusion-btn ${fusionMode === 'rrf' ? 'active' : ''}`} onClick={() => setFusionMode('rrf')}>
                RRF ⚡
              </button>
              <button className={`fusion-btn ${fusionMode === 'weighted' ? 'active' : ''}`} onClick={() => setFusionMode('weighted')}>
                Weighted
              </button>
            </div>
            <label className="setting-label">Missing Skill Penalty: {penalty}</label>
            <input type="range" min={0} max={20} value={penalty} onChange={e => setPenalty(Number(e.target.value))} className="penalty-slider" />
          </div>

          {error && <div className="error-box">{error}</div>}

          <button
            className="run-btn"
            onClick={runRanking}
            disabled={loading || (resumeFiles.length === 0) || (!jdText.trim() && !jdFile)}
          >
            {loading ? (
              <><span className="spinner" />Ranking {resumeFiles.length} resumes...</>
            ) : (
              <>🚀 Run Ranking</>
            )}
          </button>

          {result && (
            <div className="meta-stats">
              <div className="meta-stat">
                <span className="meta-val">{result.total_resumes}</span>
                <span className="meta-key">Resumes</span>
              </div>
              <div className="meta-stat">
                <span className="meta-val">{result.latency.total_ms}ms</span>
                <span className="meta-key">Total time</span>
              </div>
              <div className="meta-stat">
                <span className="meta-val">{result.jd_analysis.required_skills.length}</span>
                <span className="meta-key">Required skills</span>
              </div>
            </div>
          )}

          {result && (
            <a
              href={`${API}/api/v2/results/export`}
              className="export-btn"
              download="ranking_results.csv"
            >
              📥 Export CSV
            </a>
          )}
        </aside>

        {/* ── Right: Results ──────────────────────────────────── */}
        <main className="results-area">
          {!result && !loading && (
            <div className="empty-state">
              <div className="empty-icon">🎯</div>
              <h2 className="empty-title">Ready to rank</h2>
              <p className="empty-sub">Upload a JD + resumes on the left and click Run Ranking</p>
              <div className="empty-features">
                {['RRF Fusion', 'BM25 + Semantic', 'Evidence Snippets', 'Bias Detection', 'Recruiter Chat'].map(f => (
                  <div key={f} className="empty-feature">✓ {f}</div>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="loading-state">
              <div className="loading-ring" />
              <div className="loading-text">Running 7-step AI pipeline...</div>
              <div className="loading-steps">
                {['Parsing JD', 'Parsing resumes', 'BM25 keywords', 'Semantic embeddings', 'RRF fusion', 'Generating explanations', 'Bias check'].map((s, i) => (
                  <div key={s} className="loading-step" style={{ animationDelay: `${i * 0.3}s` }}>
                    <span className="loading-step-dot" />
                    {s}
                  </div>
                ))}
              </div>
            </div>
          )}

          {result && (
            <>
              {/* ── Top action bar */}
              <div className="results-header">
                <div className="results-title">
                  Ranked {result.total_resumes} Candidates
                  <span className="fusion-badge">{fusionMode === 'rrf' ? '⚡ RRF' : '⚖️ Weighted'}</span>
                </div>
                <div className="results-actions">
                  <button className="action-btn" onClick={() => setShowCompare(true)}>⚖️ Compare</button>
                </div>
              </div>

              {/* ── JD Skills Summary */}
              <div className="jd-skills-bar glass-dark">
                <span className="jd-skills-label">Required:</span>
                {result.jd_analysis.required_skills.slice(0, 8).map(s => (
                  <span key={s} className="jd-skill req">{s}</span>
                ))}
                <span className="jd-skills-label" style={{ marginLeft: 8 }}>Preferred:</span>
                {result.jd_analysis.preferred_skills.slice(0, 5).map(s => (
                  <span key={s} className="jd-skill pref">{s}</span>
                ))}
              </div>

              {/* ── Candidate grid */}
              <div className="candidates-grid">
                {result.candidates.map(c => (
                  <CandidateCard
                    key={c.candidate_id}
                    candidate={c}
                    explanation={expMap[c.candidate_id]}
                    selected={selectedId === c.candidate_id}
                    onSelect={() => setSelectedId(c.candidate_id)}
                  />
                ))}
              </div>

              {/* ── Analytics row */}
              <div className="analytics-row">
                <ScoreHistogram candidates={result.candidates} />
                <LatencyBadge breakdown={result.latency.breakdown} />
              </div>

              {/* ── Bias panel */}
              <BiasPanel flags={result.bias_flags} />

              {/* ── Chat */}
              <RecruiterChat candidates={result.candidates} />
            </>
          )}
        </main>
      </div>

      {showCompare && result && (
        <CompareModal candidates={result.candidates} onClose={() => setShowCompare(false)} />
      )}
    </div>
  );
}
