"""
Recruiter Chat / RAG QA — bonus feature.

Answers recruiter questions like "Why is X ranked above Y?" using
retrieval-augmented generation over the pre-computed score data.

KEY DESIGN: The LLM only ever sees pre-computed numbers/lists,
so the answer is always consistent with the ranking — it can't
accidentally contradict the system's output.

If no LLM is available, returns a template-based answer.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Optional

import structlog

from app.services.fusion import CandidateScore

logger = structlog.get_logger()


@dataclass
class ChatResponse:
    """Response to a recruiter question."""
    question: str
    answer: str
    source: str  # "llm" or "template"
    referenced_candidates: list[str] = None

    def __post_init__(self):
        if self.referenced_candidates is None:
            self.referenced_candidates = []


def _find_candidate_by_name(
    name_query: str,
    candidates: list[CandidateScore],
) -> CandidateScore | None:
    """Fuzzy-find a candidate by name in the ranked list."""
    query_lower = name_query.strip().lower()
    # Exact match first
    for c in candidates:
        if c.candidate_name.lower() == query_lower:
            return c
    # Partial match
    for c in candidates:
        if query_lower in c.candidate_name.lower() or c.candidate_name.lower() in query_lower:
            return c
    # Try matching by rank
    try:
        rank = int(name_query.strip().replace("#", "").replace("rank ", ""))
        for c in candidates:
            if c.rank == rank:
                return c
    except ValueError:
        pass
    return None


def _build_candidate_summary(c: CandidateScore) -> str:
    """Build a compact text summary of a candidate's scores."""
    matched = c.matched_required + c.matched_preferred
    return (
        f"**{c.candidate_name}** (Rank #{c.rank})\n"
        f"  Final Score: {c.final_score}/100\n"
        f"  Keyword Score: {c.keyword_score}/100 | Semantic Score: {c.semantic_score}/100\n"
        f"  Matched Skills: {', '.join(matched[:8]) if matched else 'None'}\n"
        f"  Missing Required: {', '.join(c.missing_required[:5]) if c.missing_required else 'None'}\n"
        f"  Penalty: -{c.penalty_applied} points\n"
    )


def _generate_comparison_template(
    c1: CandidateScore,
    c2: CandidateScore,
) -> str:
    """Generate a template-based comparison between two candidates."""
    higher = c1 if c1.rank < c2.rank else c2
    lower = c2 if c1.rank < c2.rank else c1

    parts = []
    parts.append(
        f"{higher.candidate_name} (Rank #{higher.rank}, Score: {higher.final_score}) "
        f"outranks {lower.candidate_name} (Rank #{lower.rank}, Score: {lower.final_score})."
    )

    # Keyword difference
    kw_diff = higher.keyword_score - lower.keyword_score
    if abs(kw_diff) > 5:
        if kw_diff > 0:
            parts.append(
                f"{higher.candidate_name} has stronger keyword matching "
                f"({higher.keyword_score:.1f} vs {lower.keyword_score:.1f}), "
                f"covering more of the JD's required skills."
            )
        else:
            parts.append(
                f"While {lower.candidate_name} has slightly better keyword matching "
                f"({lower.keyword_score:.1f} vs {higher.keyword_score:.1f}), "
                f"this is offset by other factors."
            )

    # Semantic difference
    sem_diff = higher.semantic_score - lower.semantic_score
    if abs(sem_diff) > 5:
        if sem_diff > 0:
            parts.append(
                f"{higher.candidate_name}'s experience is more semantically aligned "
                f"with the JD ({higher.semantic_score:.1f} vs {lower.semantic_score:.1f})."
            )

    # Penalty difference
    if higher.penalty_applied != lower.penalty_applied:
        parts.append(
            f"{lower.candidate_name} received a higher penalty "
            f"(-{lower.penalty_applied} vs -{higher.penalty_applied}) "
            f"for missing required skills: {', '.join(lower.missing_required[:3])}."
        )

    return " ".join(parts)


async def answer_question(
    question: str,
    ranked_candidates: list[CandidateScore],
    api_key: str | None = None,
) -> ChatResponse:
    """
    Answer a recruiter's question using pre-computed scoring data.

    Handles common question types:
    - "Why is X ranked above Y?"
    - "Tell me about candidate X"
    - "Who are the top candidates?"
    - "What skills is candidate X missing?"

    Args:
        question: Natural language question
        ranked_candidates: Full ranked candidate list with score breakdowns
        api_key: Optional LLM API key for natural language answers

    Returns:
        ChatResponse with answer and source attribution
    """
    q_lower = question.lower().strip()

    # ── Detect comparison questions ──────────────────────────────────
    # "Why is X ranked above Y?" / "Compare X and Y"
    comparison_patterns = [
        r"why\s+is\s+(.+?)\s+(?:ranked?\s+)?(?:above|higher|better)\s+(?:than\s+)?(.+)",
        r"compare\s+(.+?)\s+(?:and|vs|with|to)\s+(.+)",
        r"(.+?)\s+vs\.?\s+(.+)",
    ]

    for pattern in comparison_patterns:
        import re
        match = re.search(pattern, q_lower, re.I)
        if match:
            name1, name2 = match.group(1).strip("? "), match.group(2).strip("? ")
            c1 = _find_candidate_by_name(name1, ranked_candidates)
            c2 = _find_candidate_by_name(name2, ranked_candidates)

            if c1 and c2:
                # Try LLM first
                key = api_key or os.environ.get("OPENAI_API_KEY", "")
                if key:
                    llm_answer = await _llm_compare(c1, c2, question, key)
                    if llm_answer:
                        return ChatResponse(
                            question=question,
                            answer=llm_answer,
                            source="llm",
                            referenced_candidates=[c1.candidate_name, c2.candidate_name],
                        )

                # Fallback to template
                return ChatResponse(
                    question=question,
                    answer=_generate_comparison_template(c1, c2),
                    source="template",
                    referenced_candidates=[c1.candidate_name, c2.candidate_name],
                )

    # ── "Tell me about X" / "Details on X" ──────────────────────────
    detail_patterns = [
        r"(?:tell\s+me\s+about|details?\s+(?:on|for|about)|summarize|describe)\s+(.+)",
        r"(?:what\s+about|how\s+(?:is|did))\s+(.+)",
    ]
    for pattern in detail_patterns:
        import re
        match = re.search(pattern, q_lower, re.I)
        if match:
            name = match.group(1).strip("? ")
            candidate = _find_candidate_by_name(name, ranked_candidates)
            if candidate:
                return ChatResponse(
                    question=question,
                    answer=_build_candidate_summary(candidate),
                    source="template",
                    referenced_candidates=[candidate.candidate_name],
                )

    # ── "Top candidates" / "Best matches" ────────────────────────────
    if any(kw in q_lower for kw in ["top", "best", "strongest", "leading"]):
        top3 = ranked_candidates[:3]
        summaries = [_build_candidate_summary(c) for c in top3]
        return ChatResponse(
            question=question,
            answer="**Top 3 Candidates:**\n\n" + "\n".join(summaries),
            source="template",
            referenced_candidates=[c.candidate_name for c in top3],
        )

    # ── "Missing skills" / "Gaps for X" ──────────────────────────────
    if any(kw in q_lower for kw in ["missing", "gap", "lack", "doesn't have"]):
        for candidate in ranked_candidates:
            if candidate.candidate_name.lower() in q_lower:
                missing = candidate.missing_required
                return ChatResponse(
                    question=question,
                    answer=(
                        f"{candidate.candidate_name} is missing the following required skills: "
                        f"{', '.join(missing) if missing else 'None — all required skills matched!'}"
                    ),
                    source="template",
                    referenced_candidates=[candidate.candidate_name],
                )

    # ── Generic fallback: use LLM with full context ──────────────────
    key = api_key or os.environ.get("OPENAI_API_KEY", "")
    if key:
        llm_answer = await _llm_generic(question, ranked_candidates, key)
        if llm_answer:
            return ChatResponse(
                question=question,
                answer=llm_answer,
                source="llm",
            )

    # ── No LLM, generic fallback ─────────────────────────────────────
    return ChatResponse(
        question=question,
        answer=(
            "I can answer questions about the ranked candidates. Try:\n"
            "- 'Why is [Name] ranked above [Name]?'\n"
            "- 'Tell me about [Name]'\n"
            "- 'Who are the top candidates?'\n"
            "- 'What skills is [Name] missing?'"
        ),
        source="template",
    )


async def _llm_compare(
    c1: CandidateScore,
    c2: CandidateScore,
    question: str,
    api_key: str,
) -> str | None:
    """Use LLM to generate a comparison, grounded in pre-computed data."""
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=api_key)

        context = (
            f"Candidate A: {_build_candidate_summary(c1)}\n\n"
            f"Candidate B: {_build_candidate_summary(c2)}"
        )

        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Using ONLY the candidate data provided, answer the recruiter's "
                        "question in 2-3 sentences. Do NOT add information not in the data. "
                        "Be specific about scores, skills, and ranking reasons."
                    ),
                },
                {"role": "user", "content": f"Data:\n{context}\n\nQuestion: {question}"},
            ],
            temperature=0.2,
            max_tokens=200,
        )
        return response.choices[0].message.content
    except Exception as e:
        logger.warning("llm_compare_failed", error=str(e)[:200])
        return None


async def _llm_generic(
    question: str,
    candidates: list[CandidateScore],
    api_key: str,
) -> str | None:
    """Use LLM for generic questions, with all candidate data as context."""
    try:
        from openai import AsyncOpenAI
        client = AsyncOpenAI(api_key=api_key)

        # Include top 5 candidates as context
        context = "\n\n".join(
            _build_candidate_summary(c) for c in candidates[:5]
        )

        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a recruiter assistant. Using ONLY the candidate ranking "
                        "data provided below, answer the recruiter's question. "
                        "Do NOT invent information not in the data."
                    ),
                },
                {"role": "user", "content": f"Ranked Candidates:\n{context}\n\nQuestion: {question}"},
            ],
            temperature=0.2,
            max_tokens=300,
        )
        return response.choices[0].message.content
    except Exception as e:
        logger.warning("llm_generic_failed", error=str(e)[:200])
        return None
