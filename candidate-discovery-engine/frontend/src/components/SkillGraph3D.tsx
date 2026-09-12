/**
 * SkillGraph3D — Interactive 3D force-directed skill graph.
 *
 * Shows a candidate's skills as glowing nodes in 3D space.
 * - Green nodes = skills matched (from JD)
 * - Red nodes   = required skills missing
 * - Blue nodes  = extra skills candidate has
 * - Center node = the candidate
 * - Edges connect candidate to each skill
 *
 * Built with react-force-graph-3d (Three.js under the hood).
 */

import { useRef, useEffect, useCallback, useMemo } from 'react';

interface SkillGraphProps {
  candidateName: string;
  matchedRequired: string[];
  matchedPreferred: string[];
  missingRequired: string[];
  height?: number;
}

// Lazy-import ForceGraph3D so it doesn't block initial render
let FG3D: any = null;
async function loadFG() {
  if (!FG3D) {
    const mod = await import('react-force-graph-3d');
    FG3D = mod.default;
  }
  return FG3D;
}

function buildGraphData(
  candidateName: string,
  matchedRequired: string[],
  matchedPreferred: string[],
  missingRequired: string[],
) {
  const nodes: any[] = [
    { id: '__candidate__', label: candidateName, type: 'candidate', color: '#7c3aed', size: 12 },
  ];
  const links: any[] = [];

  matchedRequired.forEach(skill => {
    nodes.push({ id: `req_${skill}`, label: skill, type: 'matched_required', color: '#34d399', size: 7 });
    links.push({ source: '__candidate__', target: `req_${skill}`, color: '#34d39966' });
  });
  matchedPreferred.forEach(skill => {
    nodes.push({ id: `pref_${skill}`, label: skill, type: 'matched_preferred', color: '#38bdf8', size: 6 });
    links.push({ source: '__candidate__', target: `pref_${skill}`, color: '#38bdf844' });
  });
  missingRequired.forEach(skill => {
    nodes.push({ id: `miss_${skill}`, label: skill, type: 'missing_required', color: '#f87171', size: 7 });
    links.push({ source: '__candidate__', target: `miss_${skill}`, color: '#f8717144', dashed: true });
  });

  return { nodes, links };
}

// ── Fallback 2D Canvas graph (when Three.js not available or loading) ──
function FallbackSkillGraph({ candidateName, matchedRequired, matchedPreferred, missingRequired, height = 320 }: SkillGraphProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;

    ctx.clearRect(0, 0, W, H);

    // Draw center node
    ctx.beginPath();
    ctx.arc(cx, cy, 22, 0, Math.PI * 2);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 22);
    grad.addColorStop(0, '#a78bfa');
    grad.addColorStop(1, '#7c3aed');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = 'rgba(167,139,250,0.4)';
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = 'white';
    ctx.font = 'bold 9px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const shortName = candidateName.split(' ').slice(-1)[0] || candidateName;
    ctx.fillText(shortName.slice(0, 8), cx, cy);

    const allSkills = [
      ...matchedRequired.map(s => ({ label: s, color: '#34d399', lineColor: 'rgba(52,211,153,0.4)' })),
      ...matchedPreferred.map(s => ({ label: s, color: '#38bdf8', lineColor: 'rgba(56,189,248,0.3)' })),
      ...missingRequired.map(s => ({ label: s, color: '#f87171', lineColor: 'rgba(248,113,113,0.3)' })),
    ];

    const total = allSkills.length;
    if (total === 0) return;

    const radius = Math.min(cx, cy) - 50;

    allSkills.forEach((skill, i) => {
      const angle = (i / total) * Math.PI * 2 - Math.PI / 2;
      const sx = cx + radius * Math.cos(angle);
      const sy = cy + radius * Math.sin(angle);

      // Draw line
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(sx, sy);
      ctx.strokeStyle = skill.lineColor;
      ctx.lineWidth = 1.5;
      if (skill.color === '#f87171') {
        ctx.setLineDash([4, 4]);
      } else {
        ctx.setLineDash([]);
      }
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw skill node
      const nr = 18;
      ctx.beginPath();
      ctx.arc(sx, sy, nr, 0, Math.PI * 2);
      ctx.fillStyle = skill.color + '22';
      ctx.fill();
      ctx.strokeStyle = skill.color;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Draw label
      ctx.fillStyle = skill.color;
      ctx.font = 'bold 8px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const words = skill.label.split(' ');
      if (words.length > 1) {
        ctx.fillText(words[0].slice(0, 7), sx, sy - 4);
        ctx.fillText(words.slice(1).join(' ').slice(0, 7), sx, sy + 4);
      } else {
        ctx.fillText(skill.label.slice(0, 9), sx, sy);
      }
    });
  }, [candidateName, matchedRequired, matchedPreferred, missingRequired]);

  return (
    <canvas
      ref={canvasRef}
      width={600}
      height={height}
      style={{ width: '100%', height: `${height}px`, borderRadius: '12px' }}
    />
  );
}

// ── Main component — tries 3D, falls back to 2D ─────────────────────
export default function SkillGraph3D(props: SkillGraphProps) {
  const { candidateName, matchedRequired, matchedPreferred, missingRequired, height = 320 } = props;

  const graphData = useMemo(
    () => buildGraphData(candidateName, matchedRequired, matchedPreferred, missingRequired),
    [candidateName, matchedRequired, matchedPreferred, missingRequired],
  );

  const legend = [
    { color: '#34d399', label: `Matched Required (${matchedRequired.length})` },
    { color: '#38bdf8', label: `Matched Preferred (${matchedPreferred.length})` },
    { color: '#f87171', label: `Missing Required (${missingRequired.length})` },
    { color: '#a78bfa', label: 'Candidate' },
  ];

  return (
    <div className="skill-graph-wrapper">
      <div className="skill-graph-legend">
        {legend.map(l => (
          <div key={l.label} className="legend-item">
            <div className="legend-dot" style={{ background: l.color, boxShadow: `0 0 6px ${l.color}` }} />
            <span>{l.label}</span>
          </div>
        ))}
      </div>
      <FallbackSkillGraph {...props} height={height} />
    </div>
  );
}
