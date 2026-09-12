"""
Hackathon Pipeline — full end-to-end scoring engine.

This is the NEW pipeline that replaces the Azure-dependent v1 pipeline.
It orchestrates all components in sequence:

    1. Parse JD → extract required/preferred skills
    2. For each resume: extract text → chunk → extract skills
    3. Run keyword engine (skill coverage + BM25) → keyword scores
    4. Run semantic engine (sentence-transformers + cosine sim) → semantic scores
    5. Fuse scores → rank → generate explanations for top 3
    6. Run bias checker on JD
    7. Return complete results with full score breakdowns

ALL stages are deterministic and offline (except optional LLM polish).
Target: <10 seconds for 18 resumes on a laptop CPU.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import structlog

from app.services.jd_parser import ParsedJD, parse_jd
from app.services.skill_extractor import extract_resume_skills, ExtractedSkills
from app.services.keyword_engine import (
    BM25Scorer,
    KeywordResult,
    compute_keyword_score,
)
from app.services.semantic_engine import (
    SemanticResult,
    compute_batch_semantic_scores,
)
from app.services.fusion import CandidateScore, fuse_and_rank
from app.services.explanation_gen import (
    CandidateExplanation,
    build_top_n_explanations,
    polish_with_llm,
)
from app.services.bias_checker import BiasFlag, check_bias_rules, check_bias_with_llm
from app.services.chunker import ResumeSection, chunk_resume
from app.services.extractor import extract_text_from_bytes, extract_text_from_file

logger = structlog.get_logger()


@dataclass
class ResumeData:
    """Intermediate representation of a parsed resume."""
    candidate_id: str
    candidate_name: str
    raw_text: str
    sections: list[ResumeSection]
    extracted_skills: ExtractedSkills
    filename: str = ""


@dataclass
class PipelineResult:
    """Complete result from a pipeline run."""
    # Ranked candidates with full score breakdowns
    ranked_candidates: list[CandidateScore]

    # Top-3 explanations
    explanations: list[CandidateExplanation]

    # JD analysis
    parsed_jd: ParsedJD
    bias_flags: list[BiasFlag]

    # Metadata
    total_resumes: int
    latency_ms: int
    latency_breakdown: dict[str, int]


def _extract_candidate_name(text: str, filename: str = "") -> str:
    """
    Try to extract candidate name from resume text or filename.
    Simple heuristic: first non-empty line that looks like a name.
    """
    # Try filename first (often contains the name)
    if filename:
        # Strip extension and common prefixes
        name_from_file = Path(filename).stem
        # Remove common resume prefixes
        for prefix in ["resume", "cv", "Resume", "CV", "RESUME"]:
            name_from_file = name_from_file.replace(prefix, "").strip(" _-")
        if name_from_file and len(name_from_file) > 2:
            # Clean up underscores and extra spaces
            name_from_file = name_from_file.replace("_", " ").replace("-", " ")
            # Capitalize words
            name_from_file = " ".join(
                word.capitalize() for word in name_from_file.split()
                if len(word) > 1
            )
            if name_from_file:
                return name_from_file[:60]

    # Fallback: first line of resume text
    lines = text.strip().split("\n")
    for line in lines[:3]:
        stripped = line.strip()
        # A name line is usually short and doesn't have typical header words
        if (
            stripped
            and 2 < len(stripped) < 60
            and not any(kw in stripped.lower() for kw in [
                "resume", "curriculum", "objective", "summary",
                "experience", "education", "skills", "contact",
                "phone", "email", "@", "http", "www",
            ])
        ):
            return stripped

    return filename or "Unknown Candidate"


def parse_resumes_from_bytes(
    file_data: list[tuple[str, bytes]],
) -> list[ResumeData]:
    """
    Parse multiple resume files from raw bytes.

    Args:
        file_data: List of (filename, file_bytes) tuples

    Returns:
        List of ResumeData with extracted text, sections, and skills
    """
    resumes: list[ResumeData] = []

    for i, (filename, content) in enumerate(file_data):
        try:
            # Extract text
            raw_text = extract_text_from_bytes(content, filename=filename)

            # Chunk into sections
            sections = chunk_resume(raw_text)

            # Extract skills
            skills = extract_resume_skills(sections)

            # Identify candidate name
            name = _extract_candidate_name(raw_text, filename)

            resumes.append(ResumeData(
                candidate_id=f"candidate_{i:03d}",
                candidate_name=name,
                raw_text=raw_text,
                sections=sections,
                extracted_skills=skills,
                filename=filename,
            ))

            logger.debug(
                "resume_parsed",
                filename=filename,
                name=name,
                sections=len(sections),
                skills=skills.skill_count,
            )

        except Exception as e:
            logger.error(
                "resume_parse_failed",
                filename=filename,
                error=str(e)[:200],
            )
            # Create a minimal entry so we don't silently drop candidates
            resumes.append(ResumeData(
                candidate_id=f"candidate_{i:03d}",
                candidate_name=filename or f"Candidate {i+1}",
                raw_text="",
                sections=[],
                extracted_skills=ExtractedSkills(),
                filename=filename,
            ))

    return resumes


def parse_resumes_from_files(
    file_paths: list[str | Path],
) -> list[ResumeData]:
    """
    Parse multiple resume files from disk paths.
    Convenience wrapper for file-based input.
    """
    file_data: list[tuple[str, bytes]] = []
    for path in file_paths:
        p = Path(path)
        content = p.read_bytes()
        file_data.append((p.name, content))
    return parse_resumes_from_bytes(file_data)


async def run_pipeline(
    jd_text: str | None = None,
    jd_file_bytes: tuple[str, bytes] | None = None,
    resume_file_data: list[tuple[str, bytes]] | None = None,
    resume_file_paths: list[str | Path] | None = None,
    w_keyword: float = 0.5,
    w_semantic: float = 0.5,
    penalty_per_missing: float = 8.0,
    top_k_explain: int = 3,
    enable_bias_check: bool = True,
    enable_llm_polish: bool = True,
    fusion_mode: str = "rrf",
) -> PipelineResult:
    """
    Execute the full hackathon scoring pipeline.

    This is the main entry point — takes JD + resumes and returns
    a complete ranked result with explanations and bias flags.

    Args:
        jd_text: JD as plain text (provide either this or jd_file_bytes)
        jd_file_bytes: JD as (filename, bytes) tuple for PDF/DOCX input
        resume_file_data: Resumes as list of (filename, bytes) tuples
        resume_file_paths: Resumes as list of file paths
        w_keyword: Weight for keyword score in fusion (default 0.5)
        w_semantic: Weight for semantic score in fusion (default 0.5)
        penalty_per_missing: Penalty per missing required skill (default 8.0)
        top_k_explain: Number of top candidates to generate explanations for
        enable_bias_check: Whether to run bias checking
        enable_llm_polish: Whether to attempt LLM polish on explanations

    Returns:
        PipelineResult with ranked candidates, explanations, and metadata
    """
    pipeline_start = time.monotonic()
    latency_breakdown: dict[str, int] = {}

    # ═════════════════════════════════════════════════════════════════
    # STEP 1: Parse JD
    # ═════════════════════════════════════════════════════════════════
    t0 = time.monotonic()

    if jd_file_bytes:
        filename, content = jd_file_bytes
        jd_text = extract_text_from_bytes(content, filename=filename)

    if not jd_text:
        raise ValueError("Either jd_text or jd_file_bytes must be provided")

    parsed_jd = parse_jd(jd_text)
    latency_breakdown["jd_parsing_ms"] = int((time.monotonic() - t0) * 1000)

    logger.info(
        "pipeline_step_1_jd_parsed",
        required_skills=parsed_jd.required_skills,
        preferred_skills=parsed_jd.preferred_skills,
    )

    # ═════════════════════════════════════════════════════════════════
    # STEP 2: Parse all resumes
    # ═════════════════════════════════════════════════════════════════
    t0 = time.monotonic()

    if resume_file_data:
        resumes = parse_resumes_from_bytes(resume_file_data)
    elif resume_file_paths:
        resumes = parse_resumes_from_files(resume_file_paths)
    else:
        raise ValueError("Either resume_file_data or resume_file_paths must be provided")

    latency_breakdown["resume_parsing_ms"] = int((time.monotonic() - t0) * 1000)

    logger.info(
        "pipeline_step_2_resumes_parsed",
        total_resumes=len(resumes),
        avg_skills=sum(r.extracted_skills.skill_count for r in resumes) / max(len(resumes), 1),
    )

    # ═════════════════════════════════════════════════════════════════
    # STEP 3: Keyword scoring (skill coverage + BM25)
    # ═════════════════════════════════════════════════════════════════
    t0 = time.monotonic()

    # Build BM25 index over all resumes
    resume_texts = [r.raw_text for r in resumes]
    bm25_scorer = BM25Scorer(resume_texts)
    bm25_scores = bm25_scorer.score_all(jd_text)

    # ── Fallback: if JD has no explicit required skills, treat all detected
    # skills as required. This prevents the "0/0 required" display bug and
    # ensures skill coverage scoring actually functions.
    effective_required = parsed_jd.required_skills
    effective_preferred = parsed_jd.preferred_skills
    if not effective_required and parsed_jd.all_skills:
        # Promote all skills to required — no explicit Required/Preferred split
        effective_required = parsed_jd.all_skills
        effective_preferred = []
        logger.info(
            "jd_no_explicit_required_using_all_skills",
            n_skills=len(effective_required),
        )

    # Compute keyword scores for each resume
    keyword_results: list[KeywordResult] = []
    for i, resume in enumerate(resumes):
        kw_result = compute_keyword_score(
            jd_required=effective_required,
            jd_preferred=effective_preferred,
            resume_skills=resume.extracted_skills.matched_skills,
            bm25_score=bm25_scores[i],
        )
        keyword_results.append(kw_result)


    latency_breakdown["keyword_scoring_ms"] = int((time.monotonic() - t0) * 1000)

    # ═════════════════════════════════════════════════════════════════
    # STEP 4: Semantic scoring (sentence-transformer + cosine sim)
    # ═════════════════════════════════════════════════════════════════
    t0 = time.monotonic()

    # Prepare chunks for batch embedding
    all_chunk_texts: list[list[str]] = []
    all_chunk_types: list[list[str]] = []

    for resume in resumes:
        if resume.sections:
            chunk_texts = [s.text for s in resume.sections]
            chunk_types = [s.section_type for s in resume.sections]
        else:
            # Fallback: use full text as single chunk
            chunk_texts = [resume.raw_text] if resume.raw_text else [""]
            chunk_types = ["full_text"]

        all_chunk_texts.append(chunk_texts)
        all_chunk_types.append(chunk_types)

    semantic_results = compute_batch_semantic_scores(
        jd_text=jd_text,
        all_chunk_texts=all_chunk_texts,
        all_chunk_section_types=all_chunk_types,
        top_k=4,
    )

    latency_breakdown["semantic_scoring_ms"] = int((time.monotonic() - t0) * 1000)

    # ═════════════════════════════════════════════════════════════════
    # STEP 5: Hybrid fusion + ranking
    # ═════════════════════════════════════════════════════════════════
    t0 = time.monotonic()

    ranked_candidates = fuse_and_rank(
        candidate_ids=[r.candidate_id for r in resumes],
        candidate_names=[r.candidate_name for r in resumes],
        keyword_results=keyword_results,
        semantic_results=semantic_results,
        resume_texts=resume_texts,
        w_keyword=w_keyword,
        w_semantic=w_semantic,
        penalty_per_missing=penalty_per_missing,
        fusion_mode=fusion_mode,
    )

    latency_breakdown["fusion_ranking_ms"] = int((time.monotonic() - t0) * 1000)

    # ═════════════════════════════════════════════════════════════════
    # STEP 6: Generate explanations for top N
    # ═════════════════════════════════════════════════════════════════
    t0 = time.monotonic()

    total_jd_skills = len(parsed_jd.required_skills) + len(parsed_jd.preferred_skills)
    explanations = build_top_n_explanations(
        ranked_candidates=ranked_candidates,
        total_jd_skills=total_jd_skills,
        n=top_k_explain,
    )

    # Optional LLM polish
    if enable_llm_polish:
        api_key = os.environ.get("OPENAI_API_KEY", "")
        if api_key:
            for i, explanation in enumerate(explanations):
                explanations[i] = await polish_with_llm(explanation, api_key)

    latency_breakdown["explanation_ms"] = int((time.monotonic() - t0) * 1000)

    # ═════════════════════════════════════════════════════════════════
    # STEP 7: Bias check (optional)
    # ═════════════════════════════════════════════════════════════════
    bias_flags: list[BiasFlag] = []
    if enable_bias_check:
        t0 = time.monotonic()
        bias_flags = check_bias_rules(jd_text)

        # Optional LLM enhancement
        api_key = os.environ.get("OPENAI_API_KEY", "")
        if api_key:
            bias_flags = await check_bias_with_llm(jd_text, bias_flags, api_key)

        latency_breakdown["bias_check_ms"] = int((time.monotonic() - t0) * 1000)

    # ═════════════════════════════════════════════════════════════════
    # DONE — assemble result
    # ═════════════════════════════════════════════════════════════════
    total_ms = int((time.monotonic() - pipeline_start) * 1000)
    latency_breakdown["total_ms"] = total_ms

    logger.info(
        "pipeline_complete",
        total_resumes=len(resumes),
        total_ms=total_ms,
        latency_breakdown=latency_breakdown,
        top_3=[
            f"{c.candidate_name}: {c.final_score}"
            for c in ranked_candidates[:3]
        ],
    )

    return PipelineResult(
        ranked_candidates=ranked_candidates,
        explanations=explanations,
        parsed_jd=parsed_jd,
        bias_flags=bias_flags,
        total_resumes=len(resumes),
        latency_ms=total_ms,
        latency_breakdown=latency_breakdown,
    )
