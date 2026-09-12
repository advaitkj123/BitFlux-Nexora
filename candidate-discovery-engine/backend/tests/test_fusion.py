"""
Tests for the Fusion & Ranking Engine.

Covers:
- Deterministic score computation
- Penalty mechanics
- Ranking stability
- Edge cases
"""

import pytest
from app.services.fusion import (
    compute_final_score,
    rank_candidates,
    CandidateScore,
)
from app.services.semantic_engine import EvidenceChunk


def _make_candidate(
    name: str,
    keyword_score: float = 50.0,
    semantic_score: float = 50.0,
    missing_required: list[str] | None = None,
) -> CandidateScore:
    """Helper to create a test CandidateScore."""
    if missing_required is None:
        missing_required = []

    final, penalty = compute_final_score(
        keyword_score=keyword_score,
        semantic_score=semantic_score,
        missing_required_count=len(missing_required),
    )

    return CandidateScore(
        candidate_id=f"id_{name}",
        candidate_name=name,
        keyword_score=keyword_score,
        semantic_score=semantic_score,
        final_score=final,
        skill_coverage_score=keyword_score,
        bm25_score=0.0,
        matched_required=["Python"],
        matched_preferred=[],
        missing_required=missing_required,
        missing_preferred=[],
        required_coverage=0.5,
        preferred_coverage=0.0,
        top_evidence_chunks=[],
        mean_semantic_similarity=0.5,
        penalty_applied=penalty,
    )


class TestFinalScore:
    """Test the final score computation formula."""

    def test_equal_weights(self):
        """50/50 default weights should average the two scores."""
        score, penalty = compute_final_score(
            keyword_score=80.0,
            semantic_score=60.0,
            missing_required_count=0,
        )
        assert score == 70.0
        assert penalty == 0.0

    def test_penalty_applied(self):
        """Missing required skills should reduce the score."""
        score, penalty = compute_final_score(
            keyword_score=80.0,
            semantic_score=80.0,
            missing_required_count=2,
            penalty_per_missing=8.0,
        )
        # base = 0.5*80 + 0.5*80 = 80.0
        # penalty = 8 * 2 = 16
        # final = 80 - 16 = 64.0
        assert score == 64.0
        assert penalty == 16.0

    def test_penalty_floors_at_zero(self):
        """Score should never go below 0 regardless of penalty."""
        score, _ = compute_final_score(
            keyword_score=10.0,
            semantic_score=10.0,
            missing_required_count=10,
            penalty_per_missing=8.0,
        )
        assert score == 0.0

    def test_custom_weights(self):
        """Custom weights should shift the balance."""
        score, _ = compute_final_score(
            keyword_score=100.0,
            semantic_score=0.0,
            missing_required_count=0,
            w_keyword=0.7,
            w_semantic=0.3,
        )
        assert score == 70.0

    def test_perfect_score(self):
        """Perfect keyword + semantic + no missing → 100."""
        score, _ = compute_final_score(
            keyword_score=100.0,
            semantic_score=100.0,
            missing_required_count=0,
        )
        assert score == 100.0


class TestRanking:
    """Test candidate ranking."""

    def test_rank_by_score(self):
        """Candidates should be ranked by final_score descending."""
        candidates = [
            _make_candidate("Low", keyword_score=30.0, semantic_score=30.0),
            _make_candidate("High", keyword_score=90.0, semantic_score=90.0),
            _make_candidate("Mid", keyword_score=60.0, semantic_score=60.0),
        ]
        ranked = rank_candidates(candidates)
        assert ranked[0].candidate_name == "High"
        assert ranked[1].candidate_name == "Mid"
        assert ranked[2].candidate_name == "Low"

    def test_ranks_are_sequential(self):
        """Ranks should be 1, 2, 3, ..., N."""
        candidates = [
            _make_candidate(f"C{i}", keyword_score=float(100 - i * 10), semantic_score=50.0)
            for i in range(5)
        ]
        ranked = rank_candidates(candidates)
        ranks = [c.rank for c in ranked]
        assert ranks == [1, 2, 3, 4, 5]

    def test_penalty_affects_ranking(self):
        """A candidate with higher raw scores but missing skills should rank lower."""
        # Alice: high scores but missing 3 required skills
        alice = _make_candidate("Alice", keyword_score=85.0, semantic_score=85.0,
                                missing_required=["Docker", "AWS", "K8s"])
        # Bob: lower scores but no missing skills
        bob = _make_candidate("Bob", keyword_score=70.0, semantic_score=70.0)

        ranked = rank_candidates([alice, bob])
        # Alice: 0.5*85 + 0.5*85 - 3*8 = 85 - 24 = 61
        # Bob: 0.5*70 + 0.5*70 - 0 = 70
        assert ranked[0].candidate_name == "Bob", \
            "Bob should rank higher because Alice has penalty for missing skills"

    def test_deterministic_ranking(self):
        """Same inputs should always produce the same ranking."""
        candidates1 = [
            _make_candidate("A", keyword_score=80.0, semantic_score=70.0),
            _make_candidate("B", keyword_score=60.0, semantic_score=90.0),
            _make_candidate("C", keyword_score=75.0, semantic_score=75.0),
        ]
        candidates2 = [
            _make_candidate("A", keyword_score=80.0, semantic_score=70.0),
            _make_candidate("B", keyword_score=60.0, semantic_score=90.0),
            _make_candidate("C", keyword_score=75.0, semantic_score=75.0),
        ]

        ranked1 = rank_candidates(candidates1)
        ranked2 = rank_candidates(candidates2)

        for r1, r2 in zip(ranked1, ranked2):
            assert r1.candidate_name == r2.candidate_name
            assert r1.final_score == r2.final_score
            assert r1.rank == r2.rank

    def test_single_candidate(self):
        """Should work with just one candidate."""
        candidates = [_make_candidate("Solo", keyword_score=75.0, semantic_score=80.0)]
        ranked = rank_candidates(candidates)
        assert len(ranked) == 1
        assert ranked[0].rank == 1

    def test_empty_list(self):
        """Should handle empty candidate list."""
        ranked = rank_candidates([])
        assert ranked == []
