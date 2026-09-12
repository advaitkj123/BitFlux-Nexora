"""
Hybrid Score Fusion & Ranking Engine — deterministic, inspectable scoring.

Two fusion modes:
1. WEIGHTED AVERAGE:
    final_score = w_keyword * keyword_score + w_semantic * semantic_score
                  - proportional_penalty(missing_required)

2. RRF — Reciprocal Rank Fusion (state-of-the-art IR):
    rrf_score = sum(1/(k + rank(d, Li))) for each signal list
    Merges keyword and semantic RANKINGS rather than raw scores.

KEY FIX (v2.1):
    Penalty is now PROPORTIONAL to the base score (capped at 40%),
    NOT an absolute per-skill subtraction. This prevents the
    "0 score for all candidates" problem when a JD has many required skills.

    Old (broken): final = base - 8 * missing_count  → huge negative for 15+ missing
    New (correct): final = base × (1 - min(0.40, missing_ratio × penalty_strength))

    This keeps rankings discriminative regardless of JD size.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

import structlog

from app.services.keyword_engine import KeywordResult
from app.services.semantic_engine import SemanticResult, EvidenceChunk

logger = structlog.get_logger()


@dataclass
class CandidateScore:
    """Complete scoring breakdown for one candidate."""
    candidate_id: str
    candidate_name: str

    # Sub-scores (0-100)
    keyword_score: float
    semantic_score: float
    final_score: float

    # Keyword breakdown
    skill_coverage_score: float
    bm25_score: float
    matched_required: list[str]
    matched_preferred: list[str]
    missing_required: list[str]
    missing_preferred: list[str]
    required_coverage: float
    preferred_coverage: float

    # Semantic breakdown
    top_evidence_chunks: list[EvidenceChunk]
    mean_semantic_similarity: float

    # Ranking
    rank: int = 0

    # Penalty details
    penalty_applied: float = 0.0

    # Fusion method used
    fusion_mode: str = "rrf"

    # RRF sub-scores (populated when using RRF mode)
    rrf_keyword_rank: int = 0
    rrf_semantic_rank: int = 0
    rrf_score_raw: float = 0.0

    # Raw resume data (for explanations)
    resume_text: str = ""
    resume_sections: dict = field(default_factory=dict)


def _proportional_penalty(
    base_score: float,
    missing_count: int,
    total_required: int,
    penalty_strength: float = 8.0,
) -> float:
    """
    Compute a PROPORTIONAL penalty that degrades relative to base score.

    Formula:
        missing_ratio  = missing_count / max(total_required, 1)
        penalty_factor = min(0.40, missing_ratio × penalty_strength / 25)
        penalty        = base_score × penalty_factor

    With penalty_strength=8 and all skills missing (ratio=1):
        factor = min(0.40, 1.0 × 8/25) = min(0.40, 0.32) = 0.32  → 32% max deduction
    With 50% missing: factor = 0.16 → 16% deduction
    With 0% missing:  factor = 0     → no deduction

    This ensures all candidates always get a non-zero score
    (unless their base_score itself is 0) and remain sortable.
    """
    if total_required <= 0 or missing_count <= 0:
        return 0.0
    missing_ratio = min(1.0, missing_count / total_required)
    factor = min(0.40, missing_ratio * penalty_strength / 25.0)
    return round(base_score * factor, 2)


def compute_final_score(
    keyword_score: float,
    semantic_score: float,
    missing_required_count: int,
    total_required_count: int = 0,
    w_keyword: float = 0.5,
    w_semantic: float = 0.5,
    penalty_per_missing: float = 8.0,
) -> tuple[float, float]:
    """
    Compute the final hybrid score with proportional penalty (weighted mode).

    Returns:
        (final_score, penalty_applied) where final_score is in [0, 100]
    """
    base = w_keyword * keyword_score + w_semantic * semantic_score
    penalty = _proportional_penalty(base, missing_required_count, total_required_count, penalty_per_missing)
    final = max(0.0, round(base - penalty, 2))
    return final, penalty


def rrf_fuse(
    keyword_scores: list[float],
    semantic_scores: list[float],
    missing_counts: list[int],
    total_required_count: int = 0,
    k: int = 60,
    penalty_per_missing: float = 8.0,
) -> list[tuple[float, int, int, float]]:
    """
    Reciprocal Rank Fusion (RRF) with proportional penalty.

    RRF Formula: score(d) = sum(1/(k + rank(d, Li))) for each ranked list Li
    Standard k=60 smoothing constant (Cormack et al., 2009).

    Returns:
        List of (final_score, keyword_rank, semantic_rank, raw_rrf) tuples
    """
    n = len(keyword_scores)
    if n == 0:
        return []

    # Rank each signal (rank 1 = highest score)
    kw_order = sorted(range(n), key=lambda i: keyword_scores[i], reverse=True)
    sem_order = sorted(range(n), key=lambda i: semantic_scores[i], reverse=True)

    kw_ranks = [0] * n
    sem_ranks = [0] * n
    for rank, idx in enumerate(kw_order, start=1):
        kw_ranks[idx] = rank
    for rank, idx in enumerate(sem_order, start=1):
        sem_ranks[idx] = rank

    # RRF raw scores
    rrf_raw = [
        1.0 / (k + kw_ranks[i]) + 1.0 / (k + sem_ranks[i])
        for i in range(n)
    ]

    # Normalize to 0-100
    min_rrf = min(rrf_raw)
    max_rrf = max(rrf_raw)
    rrf_range = max_rrf - min_rrf if max_rrf != min_rrf else 1.0

    # Infer total_required if not provided
    n_req = max(total_required_count, max(missing_counts, default=0), 1)

    results = []
    for i in range(n):
        normalized = round(((rrf_raw[i] - min_rrf) / rrf_range) * 100, 4)
        # Proportional penalty — never kills the score completely
        penalty = _proportional_penalty(normalized, missing_counts[i], n_req, penalty_per_missing)
        final = max(0.0, round(normalized - penalty, 2))
        results.append((final, kw_ranks[i], sem_ranks[i], round(rrf_raw[i], 6)))

    return results


def rank_candidates(candidates: list[CandidateScore]) -> list[CandidateScore]:
    """Sort candidates by final_score descending and assign ranks 1..N."""
    candidates.sort(key=lambda c: c.final_score, reverse=True)
    for i, candidate in enumerate(candidates):
        candidate.rank = i + 1
    return candidates


def fuse_and_rank(
    candidate_ids: list[str],
    candidate_names: list[str],
    keyword_results: list[KeywordResult],
    semantic_results: list[SemanticResult],
    resume_texts: list[str],
    w_keyword: float = 0.5,
    w_semantic: float = 0.5,
    penalty_per_missing: float = 8.0,
    fusion_mode: Literal["weighted", "rrf"] = "rrf",
) -> list[CandidateScore]:
    """
    Fuse keyword and semantic scores for all candidates and produce
    a ranked list with full breakdowns.

    Uses RRF by default (state-of-the-art), weighted average as fallback.
    Penalty is proportional in both modes to keep scores discriminative.
    """
    assert len(candidate_ids) == len(keyword_results) == len(semantic_results), \
        "All input lists must have the same length"

    # Determine total required skills (max across all candidates = JD's count)
    total_required = max(
        (len(kw.matched_required) + len(kw.missing_required) for kw in keyword_results),
        default=0,
    )

    scored: list[CandidateScore] = []

    if fusion_mode == "rrf":
        # ── RRF Fusion ────────────────────────────────────────────────
        keyword_scores_raw = [kw.combined_score for kw in keyword_results]
        semantic_scores_raw = [sem.score for sem in semantic_results]
        missing_counts = [len(kw.missing_required) for kw in keyword_results]

        rrf_results = rrf_fuse(
            keyword_scores=keyword_scores_raw,
            semantic_scores=semantic_scores_raw,
            missing_counts=missing_counts,
            total_required_count=total_required,
            penalty_per_missing=penalty_per_missing,
        )

        for i in range(len(candidate_ids)):
            kw = keyword_results[i]
            sem = semantic_results[i]
            final, kw_rank, sem_rank, rrf_raw_val = rrf_results[i]

            # Compute display penalty (proportional, for UI)
            n_req = max(total_required, len(kw.missing_required), 1)
            missing_ratio = min(1.0, len(kw.missing_required) / n_req)
            display_penalty = round(missing_ratio * (penalty_per_missing / 25.0) * 100, 2)

            scored.append(CandidateScore(
                candidate_id=candidate_ids[i],
                candidate_name=candidate_names[i],
                keyword_score=kw.combined_score,
                semantic_score=sem.score,
                final_score=final,
                skill_coverage_score=kw.skill_coverage_score,
                bm25_score=kw.bm25_score,
                matched_required=kw.matched_required,
                matched_preferred=kw.matched_preferred,
                missing_required=kw.missing_required,
                missing_preferred=kw.missing_preferred,
                required_coverage=kw.required_coverage,
                preferred_coverage=kw.preferred_coverage,
                top_evidence_chunks=sem.top_chunks,
                mean_semantic_similarity=sem.mean_similarity,
                penalty_applied=display_penalty,
                fusion_mode="rrf",
                rrf_keyword_rank=kw_rank,
                rrf_semantic_rank=sem_rank,
                rrf_score_raw=rrf_raw_val,
                resume_text=resume_texts[i] if i < len(resume_texts) else "",
            ))

    else:
        # ── Weighted Average Fusion ───────────────────────────────────
        for i in range(len(candidate_ids)):
            kw = keyword_results[i]
            sem = semantic_results[i]

            final, penalty = compute_final_score(
                keyword_score=kw.combined_score,
                semantic_score=sem.score,
                missing_required_count=len(kw.missing_required),
                total_required_count=total_required,
                w_keyword=w_keyword,
                w_semantic=w_semantic,
                penalty_per_missing=penalty_per_missing,
            )

            scored.append(CandidateScore(
                candidate_id=candidate_ids[i],
                candidate_name=candidate_names[i],
                keyword_score=kw.combined_score,
                semantic_score=sem.score,
                final_score=final,
                skill_coverage_score=kw.skill_coverage_score,
                bm25_score=kw.bm25_score,
                matched_required=kw.matched_required,
                matched_preferred=kw.matched_preferred,
                missing_required=kw.missing_required,
                missing_preferred=kw.missing_preferred,
                required_coverage=kw.required_coverage,
                preferred_coverage=kw.preferred_coverage,
                top_evidence_chunks=sem.top_chunks,
                mean_semantic_similarity=sem.mean_similarity,
                penalty_applied=penalty,
                fusion_mode="weighted",
                resume_text=resume_texts[i] if i < len(resume_texts) else "",
            ))

    ranked = rank_candidates(scored)

    if ranked:
        scores = [c.final_score for c in ranked]
        logger.info(
            "ranking_complete",
            fusion_mode=fusion_mode,
            n_candidates=len(ranked),
            total_required_skills=total_required,
            top_score=scores[0],
            bottom_score=scores[-1],
            median_score=sorted(scores)[len(scores) // 2],
            spread=round(scores[0] - scores[-1], 2),
        )

    return ranked
