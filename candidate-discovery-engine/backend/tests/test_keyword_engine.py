"""
Tests for the Keyword Matching Engine.

Covers:
- Skill coverage scoring with known inputs
- BM25 scoring produces reasonable spread
- Combined keyword scoring
- Edge cases (empty skills, no matches)
"""

import pytest
from app.services.keyword_engine import (
    compute_skill_coverage,
    BM25Scorer,
    compute_keyword_score,
    KeywordResult,
)


class TestSkillCoverage:
    """Test the deterministic skill coverage scorer."""

    def test_perfect_match(self):
        """All required and preferred skills present → 100."""
        score, matched_req, matched_pref, missing_req, _ = compute_skill_coverage(
            jd_required=["Python", "FastAPI", "PostgreSQL"],
            jd_preferred=["Docker", "AWS"],
            resume_skills=["Python", "FastAPI", "PostgreSQL", "Docker", "AWS", "Git"],
        )
        assert score == 100.0
        assert matched_req == ["Python", "FastAPI", "PostgreSQL"]
        assert matched_pref == ["Docker", "AWS"]
        assert missing_req == []

    def test_partial_match(self):
        """Some skills missing → proportional score."""
        score, matched_req, _, missing_req, _ = compute_skill_coverage(
            jd_required=["Python", "FastAPI", "PostgreSQL", "Docker"],
            jd_preferred=["AWS", "Kubernetes"],
            resume_skills=["Python", "FastAPI"],
        )
        # required coverage = 2/4 = 0.5, preferred coverage = 0/2 = 0.0
        # score = 100 * (0.75 * 0.5 + 0.25 * 0.0) = 37.5
        assert score == 37.5
        assert len(matched_req) == 2
        assert len(missing_req) == 2

    def test_no_match(self):
        """Zero matching skills → 0."""
        score, _, _, _, _ = compute_skill_coverage(
            jd_required=["Python", "FastAPI"],
            jd_preferred=["Docker"],
            resume_skills=["Java", "Spring Boot"],
        )
        assert score == 0.0

    def test_empty_jd_skills(self):
        """Empty JD skills → should not crash."""
        score, _, _, _, _ = compute_skill_coverage(
            jd_required=[],
            jd_preferred=[],
            resume_skills=["Python", "FastAPI"],
        )
        assert score == 0.0  # 0 out of 0 still computes without error

    def test_case_insensitive_matching(self):
        """Skill matching should be case-insensitive."""
        score, matched_req, _, _, _ = compute_skill_coverage(
            jd_required=["Python", "FastAPI"],
            jd_preferred=[],
            resume_skills=["python", "fastapi"],
        )
        assert len(matched_req) == 2
        assert score > 0

    def test_preferred_only(self):
        """Only preferred skills matched → score = 25% of full."""
        score, _, matched_pref, missing_req, _ = compute_skill_coverage(
            jd_required=["Python"],
            jd_preferred=["Docker", "AWS"],
            resume_skills=["Docker", "AWS"],
        )
        # required = 0/1, preferred = 2/2
        # score = 100 * (0.75 * 0 + 0.25 * 1) = 25.0
        assert score == 25.0
        assert len(matched_pref) == 2
        assert len(missing_req) == 1


class TestBM25Scorer:
    """Test BM25 keyword relevance scoring."""

    def test_basic_scoring(self):
        """BM25 should rank a relevant resume higher than an irrelevant one."""
        resume_texts = [
            "Python developer with FastAPI and PostgreSQL experience. Built REST APIs.",
            "Marketing manager with 10 years in advertising and brand management.",
            "Full-stack developer experienced in Node.js, React, MongoDB and Express.",
        ]
        scorer = BM25Scorer(resume_texts)
        scores = scorer.score_all("Looking for Python FastAPI developer with PostgreSQL")

        # Resume 0 (Python/FastAPI) should score highest
        assert scores[0] > scores[1], "Relevant resume should score higher"
        assert len(scores) == 3

    def test_normalization(self):
        """BM25 scores should be normalized to 0-100."""
        resume_texts = [
            "Python developer with Flask",
            "Java developer with Spring Boot",
        ]
        scorer = BM25Scorer(resume_texts)
        scores = scorer.score_all("Python Flask developer")

        for score in scores:
            assert 0.0 <= score <= 100.0, f"Score {score} out of range"

    def test_identical_resumes(self):
        """Identical resumes should get equal scores (normalized to 50)."""
        resume_texts = ["Python developer"] * 3
        scorer = BM25Scorer(resume_texts)
        scores = scorer.score_all("Python developer")
        # All identical → all normalized to 50
        assert all(s == 50.0 for s in scores)

    def test_single_resume(self):
        """Should work with just one resume."""
        scorer = BM25Scorer(["Python developer with FastAPI"])
        scores = scorer.score_all("Python FastAPI")
        assert len(scores) == 1


class TestCombinedKeywordScore:
    """Test the combined keyword scoring function."""

    def test_combined_score_weights(self):
        """Verify the 70/30 weighting of skill coverage vs BM25."""
        result = compute_keyword_score(
            jd_required=["Python", "FastAPI"],
            jd_preferred=["Docker"],
            resume_skills=["Python", "FastAPI", "Docker"],
            bm25_score=80.0,
        )
        # Skill coverage = 100.0 (all matched)
        # Combined = 0.7 * 100 + 0.3 * 80 = 70 + 24 = 94.0
        assert result.combined_score == 94.0
        assert result.skill_coverage_score == 100.0
        assert result.bm25_score == 80.0

    def test_result_has_all_fields(self):
        """KeywordResult should contain all breakdown fields."""
        result = compute_keyword_score(
            jd_required=["Python"],
            jd_preferred=["Docker"],
            resume_skills=["Python"],
            bm25_score=50.0,
        )
        assert isinstance(result, KeywordResult)
        assert hasattr(result, "matched_required")
        assert hasattr(result, "missing_required")
        assert hasattr(result, "matched_preferred")
        assert hasattr(result, "missing_preferred")
        assert hasattr(result, "required_coverage")
        assert hasattr(result, "preferred_coverage")
