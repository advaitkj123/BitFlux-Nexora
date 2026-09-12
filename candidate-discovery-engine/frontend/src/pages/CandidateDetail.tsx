import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { motion } from 'framer-motion';
import {
  ArrowLeft,
  MapPin,
  Briefcase,
  GraduationCap,
  Mail,
  Phone,
  Clock,
  Trophy,
  FileText,
} from 'lucide-react';
import { getCandidateDetail } from '../api/client';
import ScoreGauge from '../components/ScoreGauge';

export default function CandidateDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data, isLoading, error } = useQuery({
    queryKey: ['candidate', id],
    queryFn: () => getCandidateDetail(id!),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: 'var(--bg-primary)',
          padding: 32,
        }}
      >
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <div className="skeleton" style={{ width: 120, height: 32, marginBottom: 24 }} />
          <div className="skeleton" style={{ width: '60%', height: 40, marginBottom: 16 }} />
          <div className="skeleton" style={{ height: 200, marginBottom: 16 }} />
          <div className="skeleton" style={{ height: 150 }} />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div
        style={{
          minHeight: '100vh',
          background: 'var(--bg-primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'column',
          gap: 16,
          padding: 32,
        }}
      >
        <div style={{ fontSize: 48 }}>⬡</div>
        <h2 style={{ color: '#a78bfa', fontSize: 22, fontWeight: 800, margin: 0 }}>
          Candidate Profile Unavailable
        </h2>
        <p style={{ color: 'rgba(240,244,255,0.5)', fontSize: 14, textAlign: 'center', maxWidth: 400 }}>
          Individual candidate profiles require the v1 database which is offline in hackathon mode.
          Use the <strong style={{ color: '#22d3ee' }}>Rank Candidates</strong> page to run a full pipeline and explore candidate scores interactively.
        </p>
        <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
          <button
            onClick={() => navigate('/rank')}
            style={{
              background: 'linear-gradient(135deg,#7c3aed,#2563eb)',
              border: 'none', color: 'white', padding: '10px 24px',
              borderRadius: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            ⚡ Go to Rank Candidates
          </button>
          <button
            onClick={() => navigate('/')}
            style={{
              background: 'rgba(255,255,255,0.05)',
              border: '1px solid rgba(255,255,255,0.1)', color: 'rgba(240,244,255,0.7)',
              padding: '10px 24px', borderRadius: 8, fontSize: 14, fontWeight: 600,
              cursor: 'pointer', fontFamily: 'inherit',
            }}
          >
            🏠 Home
          </button>
        </div>
      </div>
    );
  }

  const { candidate, match_history } = data;

  return (
    <div
      style={{
        minHeight: '100vh',
        background: 'var(--bg-primary)',
        padding: '24px 32px',
      }}
    >
      <div style={{ maxWidth: 900, margin: '0 auto' }}>
        {/* Back button */}
        <motion.button
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          className="btn-secondary"
          onClick={() => navigate('/')}
          style={{ marginBottom: 24 }}
        >
          <ArrowLeft size={16} />
          Back to results
        </motion.button>

        {/* Header card */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="glass-card"
          style={{ padding: 32, marginBottom: 16 }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              gap: 24,
              flexWrap: 'wrap',
            }}
          >
            <div>
              <h1 style={{ fontSize: 28, fontWeight: 800, marginBottom: 4 }}>
                {candidate.full_name}
              </h1>
              {candidate.current_title && (
                <p
                  style={{
                    fontSize: 16,
                    color: 'var(--accent-indigo-light)',
                    fontWeight: 600,
                    marginBottom: 16,
                  }}
                >
                  {candidate.current_title}
                  {candidate.current_company && (
                    <span style={{ color: 'var(--text-muted)' }}>
                      {' '}
                      at {candidate.current_company}
                    </span>
                  )}
                </p>
              )}

              {/* Meta grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                  gap: 12,
                }}
              >
                {(candidate.location_city || candidate.location_country) && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 14,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <MapPin size={16} style={{ color: 'var(--accent-cyan)' }} />
                    {[candidate.location_city, candidate.location_country]
                      .filter(Boolean)
                      .join(', ')}
                  </div>
                )}
                {candidate.years_of_experience != null && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 14,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <Briefcase size={16} style={{ color: 'var(--accent-amber)' }} />
                    {candidate.years_of_experience} years experience
                  </div>
                )}
                {candidate.education_level && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 14,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <GraduationCap size={16} style={{ color: 'var(--accent-emerald)' }} />
                    {candidate.education_level}
                  </div>
                )}
                {candidate.email && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 14,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <Mail size={16} style={{ color: 'var(--text-muted)' }} />
                    {candidate.email}
                  </div>
                )}
                {candidate.phone && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 14,
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <Phone size={16} style={{ color: 'var(--text-muted)' }} />
                    {candidate.phone}
                  </div>
                )}
              </div>
            </div>

            {/* Status badge */}
            <div
              style={{
                padding: '6px 14px',
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 600,
                background: candidate.is_active
                  ? 'rgba(16,185,129,0.1)'
                  : 'rgba(239,68,68,0.1)',
                color: candidate.is_active
                  ? 'var(--accent-emerald)'
                  : 'var(--accent-red)',
                border: `1px solid ${
                  candidate.is_active
                    ? 'rgba(16,185,129,0.2)'
                    : 'rgba(239,68,68,0.2)'
                }`,
              }}
            >
              {candidate.is_active ? 'Active' : 'Inactive'}
            </div>
          </div>
        </motion.div>

        {/* Skills */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.2 }}
          className="glass-card"
          style={{ padding: 24, marginBottom: 16 }}
        >
          <h2
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: 'var(--text-secondary)',
              letterSpacing: '0.05em',
              marginBottom: 14,
            }}
          >
            SKILLS
          </h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {candidate.skills.length > 0 ? (
              candidate.skills.map((skill) => (
                <span key={skill} className="chip">
                  {skill}
                </span>
              ))
            ) : (
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>
                No skills listed
              </span>
            )}
          </div>
        </motion.div>

        {/* Resume text */}
        {candidate.resume_text && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 }}
            className="glass-card"
            style={{ padding: 24, marginBottom: 16 }}
          >
            <h2
              style={{
                fontSize: 14,
                fontWeight: 700,
                color: 'var(--text-secondary)',
                letterSpacing: '0.05em',
                marginBottom: 14,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <FileText size={16} />
              RESUME
            </h2>
            <p
              style={{
                fontSize: 13,
                color: 'var(--text-secondary)',
                lineHeight: 1.7,
                whiteSpace: 'pre-wrap',
                maxHeight: 400,
                overflowY: 'auto',
              }}
            >
              {candidate.resume_text}
            </p>
          </motion.div>
        )}

        {/* Match History */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.4 }}
          className="glass-card"
          style={{ padding: 24 }}
        >
          <h2
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: 'var(--text-secondary)',
              letterSpacing: '0.05em',
              marginBottom: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Trophy size={16} style={{ color: 'var(--accent-amber)' }} />
            MATCH HISTORY
          </h2>

          {match_history.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>
              No match history yet — this candidate hasn't been scored.
            </p>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 13,
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: '1px solid var(--border-color)',
                    }}
                  >
                    <th style={thStyle}>Score</th>
                    <th style={thStyle}>Rank</th>
                    <th style={thStyle}>Strength</th>
                    <th style={thStyle}>Gap</th>
                    <th style={thStyle}>Date</th>
                  </tr>
                </thead>
                <tbody>
                  {match_history.map((item) => (
                    <tr
                      key={item.search_event_id}
                      style={{
                        borderBottom: '1px solid var(--border-color)',
                      }}
                    >
                      <td style={tdStyle}>
                        <ScoreGauge score={item.match_score} size={42} strokeWidth={3} />
                      </td>
                      <td style={tdStyle}>
                        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
                          #{item.rank}
                        </span>
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--text-secondary)', maxWidth: 250 }}>
                        {item.justification_1}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--text-muted)', maxWidth: 250 }}>
                        {item.justification_2}
                      </td>
                      <td style={{ ...tdStyle, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                        <Clock size={12} style={{ marginRight: 4 }} />
                        {item.searched_at
                          ? new Date(item.searched_at).toLocaleDateString()
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </motion.div>
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  fontWeight: 700,
  color: 'var(--text-muted)',
  fontSize: 11,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
};

const tdStyle: React.CSSProperties = {
  padding: '12px',
  verticalAlign: 'middle',
};
