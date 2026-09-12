"""
Skill Extractor — extracts canonical skills from resume text.

Uses the skill taxonomy + rapidfuzz fuzzy matching to find skills
in resume sections. Scans skills, experience, and projects sections
with higher priority.

This is the resume-side counterpart to jd_parser.py's JD skill extraction.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import structlog

from app.services.jd_parser import extract_skills_from_text
from app.services.chunker import ResumeSection

logger = structlog.get_logger()


@dataclass
class ExtractedSkills:
    """Skills extracted from a single resume."""
    matched_skills: list[str] = field(default_factory=list)
    skills_by_section: dict[str, list[str]] = field(default_factory=dict)
    skill_count: int = 0


def extract_resume_skills(
    sections: list[ResumeSection],
    fuzzy_threshold: int = 85,
) -> ExtractedSkills:
    """
    Extract skills from resume sections using the skill taxonomy.

    Priority sections: skills > experience > projects > summary > other
    Each section is scanned independently so we can track where skills
    were mentioned (useful for explanations).

    Args:
        sections: List of ResumeSection objects from the chunker
        fuzzy_threshold: Minimum fuzzy match score (0-100)

    Returns:
        ExtractedSkills with deduplicated skill list and per-section breakdown
    """
    all_skills: set[str] = set()
    skills_by_section: dict[str, list[str]] = {}

    # Priority-ordered section types to scan
    priority_types = ["skills", "experience", "projects", "summary", "certifications"]

    for section in sections:
        section_skills = extract_skills_from_text(
            section.text,
            fuzzy_threshold=fuzzy_threshold,
        )
        skills_by_section[section.section_type] = section_skills
        all_skills.update(section_skills)

    # Also scan any sections not in the priority list
    scanned_types = {s.section_type for s in sections}
    for section in sections:
        base_type = section.section_type.split("_")[0]  # Handle "experience_0", "experience_1"
        if base_type not in priority_types and section.section_type not in skills_by_section:
            section_skills = extract_skills_from_text(
                section.text,
                fuzzy_threshold=fuzzy_threshold,
            )
            skills_by_section[section.section_type] = section_skills
            all_skills.update(section_skills)

    sorted_skills = sorted(all_skills)

    logger.debug(
        "resume_skills_extracted",
        total_skills=len(sorted_skills),
        sections_scanned=len(skills_by_section),
    )

    return ExtractedSkills(
        matched_skills=sorted_skills,
        skills_by_section=skills_by_section,
        skill_count=len(sorted_skills),
    )


def extract_skills_from_raw_text(
    text: str,
    fuzzy_threshold: int = 85,
) -> ExtractedSkills:
    """
    Extract skills from raw resume text (without pre-chunked sections).
    Useful when you have plain text without section segmentation.
    """
    skills = extract_skills_from_text(text, fuzzy_threshold=fuzzy_threshold)
    return ExtractedSkills(
        matched_skills=skills,
        skills_by_section={"full_text": skills},
        skill_count=len(skills),
    )
