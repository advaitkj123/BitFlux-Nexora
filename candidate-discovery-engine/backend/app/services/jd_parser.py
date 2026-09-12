"""
JD Parser — extracts structured skill requirements from job descriptions.

Parses JD text → classifies each requirement as REQUIRED vs PREFERRED
using keyword triggers, then maps mentioned skills to canonical names
using the skill taxonomy + rapidfuzz fuzzy matching.

Output:
    ParsedJD with required_skills, preferred_skills, all_skills,
    and the raw text for embedding.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from rapidfuzz import fuzz, process

import structlog

logger = structlog.get_logger()

# ── Load skill taxonomy ─────────────────────────────────────────────
_TAXONOMY_PATH = Path(__file__).parent.parent / "data" / "skill_taxonomy.json"
_taxonomy_cache: dict | None = None


def _load_taxonomy() -> dict[str, list[str]]:
    """Load and cache the skill taxonomy."""
    global _taxonomy_cache
    if _taxonomy_cache is not None:
        return _taxonomy_cache
    with open(_TAXONOMY_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    _taxonomy_cache = data["skills"]
    return _taxonomy_cache


def _build_alias_lookup() -> dict[str, str]:
    """
    Build a reverse lookup: every alias (lowercased) → canonical name.
    This lets us match 'ReactJS' → 'React', 'NodeJS' → 'Node.js', etc.
    """
    taxonomy = _load_taxonomy()
    lookup: dict[str, str] = {}
    for canonical, aliases in taxonomy.items():
        lookup[canonical.lower()] = canonical
        for alias in aliases:
            lookup[alias.lower()] = canonical
    return lookup


_alias_lookup_cache: dict[str, str] | None = None


def _get_alias_lookup() -> dict[str, str]:
    global _alias_lookup_cache
    if _alias_lookup_cache is None:
        _alias_lookup_cache = _build_alias_lookup()
    return _alias_lookup_cache


# ── Requirement classification patterns ─────────────────────────────

REQUIRED_PATTERNS = [
    re.compile(r"\b(?:must\s+have|required|essential|mandatory|need(?:ed)?|necessary)\b", re.I),
    re.compile(r"\b\d+\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:experience|exp)\b", re.I),
    re.compile(r"\b(?:proficien(?:t|cy)|strong\s+knowledge|expert(?:ise)?|solid)\b", re.I),
    re.compile(r"\b(?:responsibilities|requirements|qualifications)\b", re.I),
]

PREFERRED_PATTERNS = [
    re.compile(r"\b(?:nice\s+to\s+have|preferred|bonus|plus|desirable|advantageous)\b", re.I),
    re.compile(r"\b(?:familiarity\s+with|exposure\s+to|awareness\s+of|interest\s+in)\b", re.I),
    re.compile(r"\b(?:good\s+to\s+have|would\s+be\s+a\s+plus|ideally|optionally?)\b", re.I),
]


def _classify_line(line: str) -> str:
    """Classify a JD line as 'required', 'preferred', or 'neutral'."""
    for pattern in PREFERRED_PATTERNS:
        if pattern.search(line):
            return "preferred"
    for pattern in REQUIRED_PATTERNS:
        if pattern.search(line):
            return "required"
    return "neutral"


def extract_skills_from_text(
    text: str,
    fuzzy_threshold: int = 85,
) -> list[str]:
    """
    Extract canonical skill names from arbitrary text using the taxonomy.

    Uses two strategies:
    1. Direct substring matching (fast, handles most cases)
    2. Fuzzy matching via rapidfuzz (catches typos like 'Reactt', 'Mongodb')

    Returns deduplicated list of canonical skill names found.
    """
    alias_lookup = _get_alias_lookup()
    found_skills: set[str] = set()
    text_lower = text.lower()

    # Strategy 1: Direct substring matching
    for alias_lower, canonical in alias_lookup.items():
        if len(alias_lower) < 2:
            continue
        # Word boundary check to avoid partial matches
        # e.g., don't match "R" in "React" but do match "R" as standalone
        pattern = r'(?<![a-zA-Z])' + re.escape(alias_lower) + r'(?![a-zA-Z])'
        if re.search(pattern, text_lower):
            found_skills.add(canonical)

    # Strategy 2: Fuzzy matching on individual words/phrases
    words = re.findall(r'[A-Za-z][A-Za-z0-9.#+\-/]{1,30}', text)
    # Also try bigrams for multi-word skills
    bigrams = [f"{words[i]} {words[i+1]}" for i in range(len(words) - 1)]
    candidates = words + bigrams

    all_aliases = list(alias_lookup.keys())

    for candidate in candidates:
        candidate_lower = candidate.lower()
        if len(candidate_lower) < 2:
            continue
        # Quick check: already found via direct match?
        if candidate_lower in alias_lookup:
            found_skills.add(alias_lookup[candidate_lower])
            continue
        # Fuzzy match
        match = process.extractOne(
            candidate_lower,
            all_aliases,
            scorer=fuzz.ratio,
            score_cutoff=fuzzy_threshold,
        )
        if match:
            matched_alias, score, _ = match
            found_skills.add(alias_lookup[matched_alias])

    return sorted(found_skills)


@dataclass
class ParsedJD:
    """Structured representation of a parsed job description."""
    raw_text: str
    required_skills: list[str] = field(default_factory=list)
    preferred_skills: list[str] = field(default_factory=list)
    all_skills: list[str] = field(default_factory=list)
    required_lines: list[str] = field(default_factory=list)
    preferred_lines: list[str] = field(default_factory=list)


def parse_jd(jd_text: str) -> ParsedJD:
    """
    Parse a job description text into structured requirements.

    Steps:
    1. Split into lines
    2. Classify each line as required/preferred/neutral
    3. Extract skills from each category
    4. Deduplicate and return structured result

    The classification uses a "sticky context" approach: once we enter
    a "Requirements" section, subsequent lines default to "required"
    until a "Nice to have" header appears.
    """
    lines = jd_text.split("\n")
    required_lines: list[str] = []
    preferred_lines: list[str] = []
    all_lines: list[str] = []

    # Sticky context: tracks which section we're currently in
    current_context = "neutral"

    # Section header patterns that switch context
    req_section_headers = re.compile(
        r"^(?:#{1,3}\s*)?(?:requirements?|qualifications?|must\s+have|what\s+you.+?need|"
        r"what\s+we.+?looking|key\s+skills?|technical\s+requirements?|essential)\s*:?\s*$",
        re.I,
    )
    pref_section_headers = re.compile(
        r"^(?:#{1,3}\s*)?(?:nice\s+to\s+have|preferred|bonus|good\s+to\s+have|"
        r"additional\s+skills?|desirable|plus\s+points?)\s*:?\s*$",
        re.I,
    )
    responsibility_headers = re.compile(
        r"^(?:#{1,3}\s*)?(?:responsibilities|what\s+you.+?do|role\s+description|"
        r"about\s+the\s+role|job\s+description|overview)\s*:?\s*$",
        re.I,
    )

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        all_lines.append(stripped)

        # Check for section header transitions
        if req_section_headers.match(stripped):
            current_context = "required"
            continue
        elif pref_section_headers.match(stripped):
            current_context = "preferred"
            continue
        elif responsibility_headers.match(stripped):
            current_context = "neutral"
            continue

        # Classify the line
        line_class = _classify_line(stripped)

        # If line has explicit markers, use those; otherwise use sticky context
        if line_class == "required":
            required_lines.append(stripped)
        elif line_class == "preferred":
            preferred_lines.append(stripped)
        elif current_context == "required":
            required_lines.append(stripped)
        elif current_context == "preferred":
            preferred_lines.append(stripped)
        else:
            # Neutral context — default to required (safer assumption)
            required_lines.append(stripped)

    # Extract skills from each category
    required_text = " ".join(required_lines)
    preferred_text = " ".join(preferred_lines)

    required_skills = extract_skills_from_text(required_text)
    preferred_skills = extract_skills_from_text(preferred_text)

    # Remove preferred skills that are already in required
    preferred_skills = [s for s in preferred_skills if s not in required_skills]

    all_skills = sorted(set(required_skills + preferred_skills))

    parsed = ParsedJD(
        raw_text=jd_text,
        required_skills=required_skills,
        preferred_skills=preferred_skills,
        all_skills=all_skills,
        required_lines=required_lines,
        preferred_lines=preferred_lines,
    )

    logger.info(
        "jd_parsed",
        required_skills=len(required_skills),
        preferred_skills=len(preferred_skills),
        total_lines=len(all_lines),
    )

    return parsed
