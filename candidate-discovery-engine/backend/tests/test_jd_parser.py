"""
Tests for the JD Parser and Skill Extractor.

Covers:
- JD skill extraction from real-world JD text
- Required vs preferred classification
- Fuzzy matching for typos
- Edge cases
"""

import pytest
from app.services.jd_parser import (
    parse_jd,
    extract_skills_from_text,
    ParsedJD,
)


class TestSkillExtraction:
    """Test skill extraction from text using the taxonomy."""

    def test_basic_skill_extraction(self):
        """Should find skills mentioned in text."""
        skills = extract_skills_from_text(
            "Looking for a Python developer with FastAPI and PostgreSQL experience."
        )
        assert "Python" in skills
        assert "FastAPI" in skills
        assert "PostgreSQL" in skills

    def test_alias_resolution(self):
        """Should resolve aliases to canonical names."""
        skills = extract_skills_from_text(
            "Must know ReactJS and NodeJS. Experience with Mongo preferred."
        )
        assert "React" in skills
        assert "Node.js" in skills
        assert "MongoDB" in skills

    def test_fuzzy_matching(self):
        """Should catch common typos and variations."""
        skills = extract_skills_from_text(
            "Experienced with Typescript, Kubernetes and PostgresQL."
        )
        assert "TypeScript" in skills
        assert "Kubernetes" in skills
        assert "PostgreSQL" in skills

    def test_no_false_positives_for_short_words(self):
        """Short common words should not trigger false matches."""
        skills = extract_skills_from_text(
            "The candidate should be a great team player."
        )
        # Should not match random short words as skills
        # "R" for example should not match on "great"
        assert "R" not in skills

    def test_multi_word_skills(self):
        """Should handle multi-word skill names."""
        skills = extract_skills_from_text(
            "Experience with React Native, Machine Learning, and CI/CD pipelines."
        )
        assert "React Native" in skills
        assert "Machine Learning" in skills
        assert "CI/CD" in skills


class TestJDParser:
    """Test the full JD parser with section classification."""

    def test_basic_jd_parsing(self):
        """Should parse a simple JD into required/preferred skills."""
        jd_text = """
        Junior Full Stack Developer

        Requirements:
        - Proficient in Python and JavaScript
        - Experience with React and Node.js
        - Strong knowledge of PostgreSQL

        Nice to Have:
        - Experience with Docker and Kubernetes
        - Familiarity with AWS
        """
        parsed = parse_jd(jd_text)

        assert isinstance(parsed, ParsedJD)
        assert len(parsed.required_skills) > 0
        assert len(parsed.preferred_skills) > 0
        # Python and React should be required
        assert "Python" in parsed.required_skills
        assert "React" in parsed.required_skills
        # Docker should be preferred
        assert "Docker" in parsed.preferred_skills

    def test_required_preferred_separation(self):
        """Skills under 'Nice to have' should not appear in required."""
        jd_text = """
        Requirements:
        - Must have Python experience

        Nice to have:
        - Docker knowledge
        """
        parsed = parse_jd(jd_text)
        assert "Python" in parsed.required_skills
        assert "Docker" in parsed.preferred_skills
        assert "Docker" not in parsed.required_skills

    def test_empty_jd(self):
        """Should handle empty or very short JD text."""
        parsed = parse_jd("")
        assert parsed.required_skills == []
        assert parsed.preferred_skills == []

    def test_jd_with_no_clear_sections(self):
        """Should still extract skills from unstructured JD text."""
        jd_text = """
        We are looking for a developer who knows Python, FastAPI,
        and has experience building REST APIs with PostgreSQL.
        Knowledge of Docker is a bonus.
        """
        parsed = parse_jd(jd_text)
        assert len(parsed.all_skills) > 0
        assert "Python" in parsed.all_skills

    def test_all_skills_is_superset(self):
        """all_skills should contain both required and preferred."""
        jd_text = """
        Requirements: Python, React
        Nice to have: Docker
        """
        parsed = parse_jd(jd_text)
        for skill in parsed.required_skills:
            assert skill in parsed.all_skills
        for skill in parsed.preferred_skills:
            assert skill in parsed.all_skills
