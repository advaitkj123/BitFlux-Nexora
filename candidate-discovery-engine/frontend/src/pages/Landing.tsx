import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import '../landing.css';

// ── Frame sequence config ──────────────────────────────────────────
const TOTAL_FRAMES = 100;
const IMG_PATH = (n: number) =>
  `/frames/Cinematic_product_demo_video_f_${String(n).padStart(3, '0')}.jpg`;

// Preload all frames eagerly
const FRAMES: HTMLImageElement[] = [];

function preloadFrames(onProgress: (p: number) => void) {
  let loaded = 0;
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    const img = new Image();
    img.src = IMG_PATH(i);
    img.onload = img.onerror = () => {
      loaded++;
      onProgress(loaded / TOTAL_FRAMES);
    };
    FRAMES[i] = img;
  }
}

// ── Stat counter hook ──────────────────────────────────────────────
function useCountUp(target: number, duration = 1500, triggered: boolean = false) {
  const [count, setCount] = useState(0);
  useEffect(() => {
    if (!triggered) return;
    let start = 0;
    const step = target / (duration / 16);
    const timer = setInterval(() => {
      start += step;
      if (start >= target) { setCount(target); clearInterval(timer); }
      else setCount(Math.floor(start));
    }, 16);
    return () => clearInterval(timer);
  }, [target, duration, triggered]);
  return count;
}

// ── Intersection observer hook ─────────────────────────────────────
function useInView(threshold = 0.2) {
  const ref = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) setInView(true); },
      { threshold }
    );
    if (ref.current) obs.observe(ref.current);
    return () => obs.disconnect();
  }, [threshold]);
  return { ref, inView };
}

// ── Stats data ─────────────────────────────────────────────────────
const STATS = [
  { value: 94, suffix: '%', label: 'Match Accuracy' },
  { value: 10, suffix: 'x', label: 'Faster Shortlisting' },
  { value: 73, suffix: '%', label: 'Bias Reduction' },
  { value: 5, suffix: 's', label: 'Per Resume Analysis' },
];

// ── Features ───────────────────────────────────────────────────────
const FEATURES = [
  {
    icon: '⚡',
    title: 'Dual-Signal Ranking',
    desc: 'BM25 keyword matching fused with sentence-transformer semantic similarity for unprecedented precision.',
    gradient: 'from-violet-500 to-indigo-600',
  },
  {
    icon: '🧠',
    title: 'AI Explanations',
    desc: 'Every score comes with a grounded, human-readable explanation — not a black box decision.',
    gradient: 'from-cyan-500 to-blue-600',
  },
  {
    icon: '🔍',
    title: 'Bias Detection',
    desc: 'Automatically flags JD language that skews toward gender, age, or cultural background.',
    gradient: 'from-emerald-500 to-teal-600',
  },
  {
    icon: '💬',
    title: 'Recruiter Chat',
    desc: 'Ask "Why is this candidate ranked #3?" and get instant RAG-powered answers from your data.',
    gradient: 'from-amber-500 to-orange-600',
  },
  {
    icon: '📊',
    title: 'Skill Taxonomy',
    desc: '150+ skills with alias resolution — React, ReactJS, and React.js all map to the same signal.',
    gradient: 'from-pink-500 to-rose-600',
  },
  {
    icon: '🔒',
    title: 'Offline & Private',
    desc: 'Runs entirely on CPU with local models. No resume data ever leaves your infrastructure.',
    gradient: 'from-purple-500 to-violet-600',
  },
];

// ── How it works steps ─────────────────────────────────────────────
const STEPS = [
  { num: '01', title: 'Upload JD', desc: 'Paste or upload your job description. Our parser extracts required vs preferred skills automatically.' },
  { num: '02', title: 'Bulk Resume Drop', desc: 'Drop PDF/DOCX resumes. The engine parses, chunks, and embeds each one in seconds.' },
  { num: '03', title: 'Instant Ranking', desc: 'Hybrid scoring fuses keyword coverage, BM25 relevance, and semantic similarity into a single ranked list.' },
  { num: '04', title: 'Explain & Act', desc: 'Read grounded explanations, chat with your data, check bias flags, and export decisions.' },
];

export default function Landing() {
  const navigate = useNavigate();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [loadProgress, setLoadProgress] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [navScrolled, setNavScrolled] = useState(false);
  const statsRef = useInView(0.3);

  // Preload frames
  useEffect(() => {
    preloadFrames((p) => {
      setLoadProgress(p);
      if (p >= 1) setTimeout(() => setLoaded(true), 300);
    });
  }, []);

  // Nav shadow on scroll
  useEffect(() => {
    const onScroll = () => setNavScrolled(window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  // Draw frame to canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !FRAMES[currentFrame]?.complete) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = FRAMES[currentFrame];
    canvas.width = canvas.offsetWidth * window.devicePixelRatio;
    canvas.height = canvas.offsetHeight * window.devicePixelRatio;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  }, [currentFrame]);

  // Scroll → frame mapping (sticky section)
  useEffect(() => {
    if (!loaded) return;
    const onScroll = () => {
      const sticky = document.getElementById('sticky-section');
      if (!sticky) return;
      const rect = sticky.getBoundingClientRect();
      const scrolled = -rect.top;
      const sectionHeight = sticky.offsetHeight - window.innerHeight;
      const progress = Math.max(0, Math.min(1, scrolled / sectionHeight));
      const frame = Math.min(TOTAL_FRAMES - 1, Math.floor(progress * TOTAL_FRAMES));
      setCurrentFrame(frame);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [loaded]);

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="landing-root" ref={scrollContainerRef}>

      {/* ── Loading Screen ───────────────────────────────────────── */}
      {!loaded && (
        <div className="loader-overlay">
          <div className="loader-inner">
            <div className="loader-logo">InternLoom</div>
            <div className="loader-bar-track">
              <div className="loader-bar-fill" style={{ width: `${loadProgress * 100}%` }} />
            </div>
            <div className="loader-pct">{Math.round(loadProgress * 100)}%</div>
          </div>
        </div>
      )}

      {/* ── Navigation ──────────────────────────────────────────── */}
      <nav className={`landing-nav ${navScrolled ? 'scrolled' : ''}`}>
        <div className="nav-inner">
          <div className="nav-logo">
            <span className="logo-icon">⬡</span>
            <span className="logo-text">InternLoom</span>
          </div>
          <div className="nav-links">
            <a href="#features">Features</a>
            <a href="#how-it-works">How It Works</a>
            <a href="#stats">Results</a>
            <a href="/rank" onClick={e => { e.preventDefault(); navigate('/rank'); }}>⚡ Rank Candidates</a>
          </div>
          <button className="nav-cta" onClick={() => navigate('/rank')}>
            Try Demo →
          </button>
        </div>
      </nav>

      {/* ── Hero Section ────────────────────────────────────────── */}
      <section className="hero-section">
        <div className="hero-bg-grid" />
        <div className="hero-glow hero-glow-1" />
        <div className="hero-glow hero-glow-2" />

        <div className="hero-content">
          <div className="hero-badge">
            <span className="badge-dot" />
            AI-Powered Smart Shortlisting
          </div>
          <h1 className="hero-title">
            Find the <span className="hero-gradient-word">Right Talent</span>
            <br />in Seconds, Not Hours
          </h1>
          <p className="hero-subtitle">
            InternLoom's dual-signal AI ranks hundreds of resumes by true job fit —
            with deterministic scoring, grounded explanations, and built-in bias detection.
          </p>
          <div className="hero-actions">
            <button className="btn-hero-primary" onClick={() => navigate('/rank')}>
              <span>Start Ranking Resumes</span>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
            </button>
            <a href="#scroll-demo" className="btn-hero-secondary">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8"/></svg>
              See it in action
            </a>
          </div>

          {/* Floating stats chips */}
          <div className="hero-chips">
            {['94% match accuracy', '10x faster', 'Zero bias', 'CPU-only'].map(c => (
              <div key={c} className="hero-chip">{c}</div>
            ))}
          </div>
        </div>

        {/* Hero scroll hint */}
        <div className="scroll-hint" id="scroll-demo">
          <div className="scroll-mouse">
            <div className="scroll-wheel" />
          </div>
          <span>Scroll to explore</span>
        </div>
      </section>

      {/* ── Scroll-Driven Canvas Section ──────────────────────────── */}
      <section id="sticky-section" className="sticky-scroll-section">
        <div className="sticky-wrapper">
          {/* Canvas playing the demo frames */}
          <div className="canvas-container">
            <canvas ref={canvasRef} className="demo-canvas" />
            <div className="canvas-vignette" />
          </div>

          {/* Text overlays that appear at specific scroll points */}
          <div className="sticky-labels">
            {currentFrame < 25 && (
              <div className="sticky-label fade-in-up" key="label-0">
                <h2>Upload Any Job Description</h2>
                <p>JD parser extracts required vs preferred skills in milliseconds.</p>
              </div>
            )}
            {currentFrame >= 25 && currentFrame < 55 && (
              <div className="sticky-label fade-in-up" key="label-1">
                <h2>Dual-Signal AI Ranking</h2>
                <p>BM25 lexical scoring meets sentence-transformer semantic similarity.</p>
              </div>
            )}
            {currentFrame >= 55 && currentFrame < 80 && (
              <div className="sticky-label fade-in-up" key="label-2">
                <h2>Instant Match Scores</h2>
                <p>Every candidate gets a transparent, explainable score — not a black box.</p>
              </div>
            )}
            {currentFrame >= 80 && (
              <div className="sticky-label fade-in-up" key="label-3">
                <h2>AI Explanation Engine</h2>
                <p>Know exactly why each candidate is ranked — matched skills, gaps, and context.</p>
              </div>
            )}
          </div>

          {/* Frame progress bar */}
          <div className="frame-progress">
            <div className="frame-progress-fill" style={{ width: `${(currentFrame / (TOTAL_FRAMES - 1)) * 100}%` }} />
          </div>
        </div>
      </section>

      {/* ── Stats Section ────────────────────────────────────────── */}
      <section id="stats" className="stats-section">
        <div ref={statsRef.ref} className="stats-grid">
          {STATS.map((s) => (
            <StatCard key={s.label} {...s} triggered={statsRef.inView} />
          ))}
        </div>
      </section>

      {/* ── Features Grid ────────────────────────────────────────── */}
      <section id="features" className="features-section">
        <div className="section-header">
          <div className="section-eyebrow">Why InternLoom</div>
          <h2 className="section-title">Everything recruiters need. Nothing they don't.</h2>
          <p className="section-sub">Built for speed, explainability, and fairness — all running locally on CPU.</p>
        </div>
        <div className="features-grid">
          {FEATURES.map((f) => (
            <FeatureCard key={f.title} {...f} />
          ))}
        </div>
      </section>

      {/* ── How It Works ─────────────────────────────────────────── */}
      <section id="how-it-works" className="how-section">
        <div className="section-header">
          <div className="section-eyebrow">The Process</div>
          <h2 className="section-title">From job post to shortlist in four steps.</h2>
        </div>
        <div className="steps-timeline">
          {STEPS.map((s, i) => (
            <StepCard key={s.num} {...s} isLast={i === STEPS.length - 1} />
          ))}
        </div>
      </section>

      {/* ── Final CTA ────────────────────────────────────────────── */}
      <section className="cta-section">
        <div className="cta-glow" />
        <div className="cta-content">
          <h2 className="cta-title">Ready to find your perfect candidate?</h2>
          <p className="cta-sub">Upload your JD and resumes. Get a ranked shortlist in under 30 seconds.</p>
          <button className="btn-hero-primary cta-btn" onClick={() => navigate('/search')}>
            Launch InternLoom
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────── */}
      <footer className="landing-footer">
        <div className="footer-inner">
          <div className="nav-logo">
            <span className="logo-icon">⬡</span>
            <span className="logo-text">InternLoom</span>
          </div>
          <p className="footer-copy">© 2025 InternLoom · BitFlux · All rights reserved</p>
          <div className="footer-links">
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
            <a href="https://github.com/advaitkj123/BitFlux-Nexora" target="_blank" rel="noopener noreferrer">GitHub</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────

function StatCard({ value, suffix, label, triggered }: { value: number; suffix: string; label: string; triggered: boolean }) {
  const count = useCountUp(value, 1500, triggered);
  return (
    <div className="stat-card glass-card">
      <div className="stat-value">
        {count}<span className="stat-suffix">{suffix}</span>
      </div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function FeatureCard({ icon, title, desc, gradient }: { icon: string; title: string; desc: string; gradient: string }) {
  return (
    <div className="feature-card">
      <div className={`feature-icon-wrap bg-gradient-to-br ${gradient}`}>
        <span className="feature-icon">{icon}</span>
      </div>
      <h3 className="feature-title">{title}</h3>
      <p className="feature-desc">{desc}</p>
    </div>
  );
}

function StepCard({ num, title, desc, isLast }: { num: string; title: string; desc: string; isLast: boolean }) {
  return (
    <div className="step-card">
      <div className="step-num-col">
        <div className="step-num">{num}</div>
        {!isLast && <div className="step-line" />}
      </div>
      <div className="step-body">
        <h3 className="step-title">{title}</h3>
        <p className="step-desc">{desc}</p>
      </div>
    </div>
  );
}
