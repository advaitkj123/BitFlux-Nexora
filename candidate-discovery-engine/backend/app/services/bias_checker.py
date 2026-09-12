"""
JD Bias & Narrow-Phrasing Checker — bonus feature.

Two layers:
1. Rule-based (works offline):
   - Gendered language detection ("rockstar", "ninja", "he/him")
   - Unreasonable experience thresholds for junior/intern roles
   - Over-specific tool lock-in where alternatives exist
   - Exclusionary degree requirements
   - Age-biased phrasing ("young", "recent graduate only")

2. Optional LLM layer:
   - Ask LLM to identify exclusionary phrasing
   - Advisory text generation (appropriate LLM use — not scoring)

Returns a list of flagged issues with phrase, reason, and severity.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from typing import Optional

import structlog

logger = structlog.get_logger()


@dataclass
class BiasFlag:
    """A single flagged issue in the JD."""
    phrase: str
    reason: str
    severity: str  # "high", "medium", "low"
    category: str  # "gendered", "experience", "specificity", "exclusionary", "age"
    suggestion: str = ""


# ── Rule patterns ────────────────────────────────────────────────────

GENDERED_TERMS = {
    "rockstar": "Gender-coded 'rockstar' can discourage diverse applicants. Consider 'high-performing' or 'talented'.",
    "ninja": "Gender-coded 'ninja' can discourage diverse applicants. Consider 'skilled' or 'expert'.",
    "guru": "Gender-coded 'guru' can discourage diverse applicants. Consider 'specialist' or 'expert'.",
    "wizard": "Gender-coded 'wizard' can discourage diverse applicants. Consider 'highly skilled' or 'expert'.",
    "hacker": "Gender-coded 'hacker' can discourage diverse applicants. Consider 'developer' or 'engineer'.",
    "manpower": "'Manpower' is gendered. Consider 'workforce' or 'staff'.",
    "man-hours": "'Man-hours' is gendered. Consider 'person-hours' or 'work hours'.",
    "chairman": "'Chairman' is gendered. Consider 'chairperson' or 'chair'.",
    "he/him": "Gendered pronouns in JD. Consider 'they/them' or role-focused language.",
    "his/her": "Binary pronoun pairing. Consider 'their' for inclusivity.",
}

PRONOUN_PATTERNS = [
    (re.compile(r'\bhe\s+(?:will|should|must|is|would)\b', re.I), "Gendered pronoun 'he' in job description. Use 'they' or 'the candidate'."),
    (re.compile(r'\bshe\s+(?:will|should|must|is|would)\b', re.I), "Gendered pronoun 'she' in job description. Use 'they' or 'the candidate'."),
    (re.compile(r'\bhis\s+(?:or\s+her|/her)\b', re.I), "Binary pronoun usage. Consider 'their' for inclusivity."),
]

# Tool-specific requirements where alternatives exist
TOOL_LOCK_IN = {
    "MongoDB": ("NoSQL document store", ["CouchDB", "DynamoDB", "Firestore"]),
    "MySQL": ("relational database", ["PostgreSQL", "MariaDB", "SQL Server"]),
    "React": ("frontend framework", ["Vue.js", "Angular", "Svelte"]),
    "Express": ("Node.js web framework", ["Fastify", "Koa", "NestJS", "Hapi"]),
    "Jenkins": ("CI/CD platform", ["GitHub Actions", "GitLab CI", "CircleCI"]),
    "Jira": ("project management tool", ["Asana", "Trello", "Linear"]),
    "AWS": ("cloud platform", ["Azure", "Google Cloud"]),
}

# Experience threshold patterns
EXP_PATTERN = re.compile(r'(\d+)\+?\s*(?:years?|yrs?)\s+(?:of\s+)?(?:experience|exp)', re.I)

# Degree requirement patterns
DEGREE_EXCLUSION = re.compile(
    r'\b(?:must\s+have|required|only)\s+(?:a\s+)?(?:bachelor|master|phd|degree)\b',
    re.I,
)

# Age-biased patterns
AGE_BIAS_PATTERNS = [
    (re.compile(r'\byoung\s+(?:and\s+)?(?:dynamic|energetic|motivated)\b', re.I),
     "'Young and dynamic' is age-biased. Focus on skills and energy level instead."),
    (re.compile(r'\brecent\s+graduate\s+only\b', re.I),
     "'Recent graduate only' excludes career changers. Consider 'entry-level' instead."),
    (re.compile(r'\bnative\s+(?:english\s+)?speaker\b', re.I),
     "'Native speaker' is exclusionary. Consider 'fluent in English' or 'professional proficiency'."),
    (re.compile(r'\bcultural?\s+fit\b', re.I),
     "'Culture fit' can mask bias. Consider 'culture add' or specify the values you're looking for."),
]


def check_bias_rules(jd_text: str) -> list[BiasFlag]:
    """
    Run rule-based bias checks on a job description.
    Fully offline — no API calls needed.
    """
    flags: list[BiasFlag] = []
    jd_lower = jd_text.lower()

    # 1. Gendered language
    for term, reason in GENDERED_TERMS.items():
        if term.lower() in jd_lower:
            flags.append(BiasFlag(
                phrase=term,
                reason=reason,
                severity="medium",
                category="gendered",
                suggestion=reason.split(". Consider ")[-1].rstrip(".") if ". Consider " in reason else "",
            ))

    # 2. Gendered pronouns
    for pattern, reason in PRONOUN_PATTERNS:
        match = pattern.search(jd_text)
        if match:
            flags.append(BiasFlag(
                phrase=match.group(),
                reason=reason,
                severity="medium",
                category="gendered",
            ))

    # 3. Experience threshold check
    # Detect if JD title suggests junior/intern but experience requirement is high
    is_junior = bool(re.search(
        r'\b(?:junior|jr|intern|entry[- ]level|associate|trainee|fresher|graduate)\b',
        jd_lower,
    ))
    for match in EXP_PATTERN.finditer(jd_text):
        years = int(match.group(1))
        if is_junior and years >= 3:
            flags.append(BiasFlag(
                phrase=match.group(),
                reason=f"Requiring {years}+ years of experience for a junior/intern role "
                       f"may unnecessarily exclude qualified candidates. "
                       f"Consider reducing to 0-1 years or 'some experience with'.",
                severity="high",
                category="experience",
            ))
        elif years >= 8:
            flags.append(BiasFlag(
                phrase=match.group(),
                reason=f"Requiring {years}+ years may significantly narrow the candidate pool. "
                       f"Consider whether the role truly requires this level of experience.",
                severity="low",
                category="experience",
            ))

    # 4. Tool-specific lock-in
    for tool, (category, alternatives) in TOOL_LOCK_IN.items():
        # Check if the JD REQUIRES this specific tool (not just mentions it)
        tool_pattern = re.compile(
            rf'\b(?:must\s+have|required|proficient\s+in|experience\s+(?:with|in))\s+{re.escape(tool)}\b',
            re.I,
        )
        if tool_pattern.search(jd_text):
            alt_str = ", ".join(alternatives[:3])
            flags.append(BiasFlag(
                phrase=f"Required: {tool}",
                reason=f"Requiring specifically '{tool}' when the actual need is "
                       f"'{category}' experience may exclude candidates with "
                       f"equivalent tools ({alt_str}).",
                severity="low",
                category="specificity",
                suggestion=f"Consider '{category} (e.g., {tool}, {alt_str})'",
            ))

    # 5. Exclusionary degree requirements
    for match in DEGREE_EXCLUSION.finditer(jd_text):
        flags.append(BiasFlag(
            phrase=match.group(),
            reason="Strict degree requirements can exclude self-taught developers, "
                   "bootcamp graduates, and career changers with relevant experience.",
            severity="medium",
            category="exclusionary",
            suggestion="Consider 'degree in CS or equivalent practical experience'",
        ))

    # 6. Age bias
    for pattern, reason in AGE_BIAS_PATTERNS:
        match = pattern.search(jd_text)
        if match:
            flags.append(BiasFlag(
                phrase=match.group(),
                reason=reason,
                severity="medium",
                category="age",
            ))

    logger.info(
        "bias_check_complete",
        flags_found=len(flags),
        categories=[f.category for f in flags],
    )

    return flags


async def check_bias_with_llm(
    jd_text: str,
    rule_flags: list[BiasFlag],
    api_key: str | None = None,
) -> list[BiasFlag]:
    """
    Optionally enhance bias checking with an LLM.
    The LLM is asked to identify exclusionary phrasing — this is
    an appropriate LLM use case since it's advisory text generation,
    not candidate scoring.

    Returns combined rule-based + LLM flags.
    """
    key = api_key or os.environ.get("OPENAI_API_KEY", "")
    if not key:
        return rule_flags

    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=key)

        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an expert HR consultant specializing in inclusive hiring. "
                        "Analyze the following job description and list phrases that could "
                        "unnecessarily exclude qualified candidates, and briefly explain why. "
                        "Focus on: gendered language, unreasonable requirements, "
                        "exclusionary phrasing, cultural bias, and over-specificity. "
                        "Return each issue as a single line in format: "
                        "PHRASE: [exact phrase] | REASON: [brief explanation] | SEVERITY: [high/medium/low]"
                    ),
                },
                {"role": "user", "content": jd_text[:3000]},
            ],
            temperature=0.2,
            max_tokens=500,
        )

        llm_text = response.choices[0].message.content or ""
        for line in llm_text.strip().split("\n"):
            line = line.strip()
            if not line or "PHRASE:" not in line:
                continue
            try:
                parts = line.split("|")
                phrase = parts[0].replace("PHRASE:", "").strip()
                reason = parts[1].replace("REASON:", "").strip() if len(parts) > 1 else ""
                severity = parts[2].replace("SEVERITY:", "").strip().lower() if len(parts) > 2 else "low"

                # Avoid duplicating rule-based flags
                if not any(f.phrase.lower() == phrase.lower() for f in rule_flags):
                    rule_flags.append(BiasFlag(
                        phrase=phrase,
                        reason=reason,
                        severity=severity if severity in ("high", "medium", "low") else "low",
                        category="llm_detected",
                    ))
            except (IndexError, ValueError):
                continue

        logger.info("llm_bias_check_complete", additional_flags=len(rule_flags))

    except Exception as e:
        logger.warning("llm_bias_check_failed", error=str(e)[:200])

    return rule_flags
