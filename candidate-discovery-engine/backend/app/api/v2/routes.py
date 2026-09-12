"""
V2 API Routes — Hackathon-optimized endpoints.

These endpoints use the new two-signal matching pipeline
(keyword + semantic) with deterministic scoring.

| Endpoint                          | Method | Purpose                                    |
|-----------------------------------|--------|--------------------------------------------|
| /api/v2/jd/upload                 | POST   | Upload & parse JD, return extracted skills  |
| /api/v2/resumes/upload            | POST   | Upload batch of resume PDFs                 |
| /api/v2/rank                      | POST   | Run full pipeline, return ranked results    |
| /api/v2/candidate/{id}/explanation| GET    | Return explanation for one candidate        |
| /api/v2/bias-check                | POST   | Return flagged JD phrases                   |
| /api/v2/chat                      | POST   | Recruiter Q&A over scored data              |
"""

from __future__ import annotations

import io
import csv
import time
from typing import Any, Optional

import structlog
from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.services.hackathon_pipeline import (
    PipelineResult,
    run_pipeline,
    parse_resumes_from_bytes,
)
from app.services.jd_parser import parse_jd
from app.services.bias_checker import check_bias_rules
from app.services.chat_qa import answer_question
from app.services.extractor import extract_text_from_bytes

logger = structlog.get_logger()
router = APIRouter(tags=["v2-hackathon"])

# ── In-memory state for the demo session ─────────────────────────────
# In a hackathon setting, we keep the latest pipeline result in memory
# so the chat and explanation endpoints can reference it.
_latest_result: PipelineResult | None = None
_latest_jd_text: str | None = None


# ══════════════════════════════════════════════════════════════════════
# REQUEST / RESPONSE SCHEMAS
# ══════════════════════════════════════════════════════════════════════

class JDUploadResponse(BaseModel):
    required_skills: list[str]
    preferred_skills: list[str]
    all_skills: list[str]
    jd_text_length: int
    jd_text_preview: str


class EvidenceChunkResponse(BaseModel):
    text: str
    section_type: str
    similarity: float


class CandidateScoreResponse(BaseModel):
    candidate_id: str
    candidate_name: str
    rank: int
    final_score: float
    keyword_score: float
    semantic_score: float
    skill_coverage_score: float
    bm25_score: float
    matched_required: list[str]
    matched_preferred: list[str]
    missing_required: list[str]
    missing_preferred: list[str]
    required_coverage: float
    preferred_coverage: float
    top_evidence: list[EvidenceChunkResponse]
    penalty_applied: float


class ExplanationResponse(BaseModel):
    candidate_id: str
    candidate_name: str
    rank: int
    final_score: float
    matched_skills: list[str]
    missing_required_skills: list[str]
    supporting_evidence: list[str]
    template_summary: str
    llm_summary: str | None = None


class BiasFlagResponse(BaseModel):
    phrase: str
    reason: str
    severity: str
    category: str
    suggestion: str = ""


class LatencyResponse(BaseModel):
    total_ms: int
    breakdown: dict[str, int]


class RankResponse(BaseModel):
    candidates: list[CandidateScoreResponse]
    explanations: list[ExplanationResponse]
    jd_analysis: JDUploadResponse
    bias_flags: list[BiasFlagResponse]
    total_resumes: int
    latency: LatencyResponse


class ChatRequest(BaseModel):
    question: str = Field(..., min_length=3, max_length=500)


class ChatResponseModel(BaseModel):
    question: str
    answer: str
    source: str
    referenced_candidates: list[str]


class BiasCheckRequest(BaseModel):
    jd_text: str = Field(..., min_length=20, max_length=10000)


# ══════════════════════════════════════════════════════════════════════
# ENDPOINTS
# ══════════════════════════════════════════════════════════════════════

@router.post("/jd/upload", response_model=JDUploadResponse)
async def upload_jd(
    file: UploadFile = File(..., description="JD file (PDF, DOCX, or TXT)"),
):
    """
    Upload and parse a Job Description.
    Returns extracted required and preferred skills.
    """
    content = await file.read()
    if len(content) < 10:
        raise HTTPException(status_code=400, detail="File is empty or too small.")
    if len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="File too large (max 10MB).")

    try:
        jd_text = extract_text_from_bytes(content, filename=file.filename or "")
    except ValueError as e:
        raise HTTPException(status_code=415, detail=str(e))

    global _latest_jd_text
    _latest_jd_text = jd_text

    parsed = parse_jd(jd_text)

    return JDUploadResponse(
        required_skills=parsed.required_skills,
        preferred_skills=parsed.preferred_skills,
        all_skills=parsed.all_skills,
        jd_text_length=len(jd_text),
        jd_text_preview=jd_text[:500],
    )


@router.post("/jd/parse", response_model=JDUploadResponse)
async def parse_jd_text(
    jd_text: str = Form(..., min_length=50, max_length=10000),
):
    """Parse JD from plain text (no file upload needed)."""
    global _latest_jd_text
    _latest_jd_text = jd_text

    parsed = parse_jd(jd_text)

    return JDUploadResponse(
        required_skills=parsed.required_skills,
        preferred_skills=parsed.preferred_skills,
        all_skills=parsed.all_skills,
        jd_text_length=len(jd_text),
        jd_text_preview=jd_text[:500],
    )


@router.post("/rank", response_model=RankResponse)
async def rank_candidates(
    jd_file: UploadFile = File(None, description="JD file (optional if jd_text provided)"),
    jd_text: str = Form(None, description="JD as plain text"),
    resumes: list[UploadFile] = File(..., description="Resume files (PDF/DOCX)"),
    w_keyword: float = Form(0.5, ge=0.0, le=1.0),
    w_semantic: float = Form(0.5, ge=0.0, le=1.0),
    penalty_per_missing: float = Form(8.0, ge=0.0, le=20.0),
    fusion_mode: str = Form("rrf", description="rrf or weighted"),
):
    """
    Run the full ranking pipeline.

    Upload a JD (file or text) + batch of resume files.
    Returns ranked candidates with full score breakdowns,
    top-3 explanations, and JD bias flags.
    """
    # ── Get JD text ───────────────────────────────────────────────────
    if jd_file and jd_file.filename:
        jd_content = await jd_file.read()
        if len(jd_content) > 10:
            try:
                jd_text = extract_text_from_bytes(jd_content, filename=jd_file.filename)
            except ValueError as e:
                raise HTTPException(status_code=415, detail=f"JD file error: {e}")

    if not jd_text and _latest_jd_text:
        jd_text = _latest_jd_text

    if not jd_text or len(jd_text) < 50:
        raise HTTPException(
            status_code=400,
            detail="JD text must be at least 50 characters. Provide jd_text or upload a JD file.",
        )

    # ── Read resume files ─────────────────────────────────────────────
    resume_data: list[tuple[str, bytes]] = []
    for resume_file in resumes:
        content = await resume_file.read()
        if len(content) > 10:
            resume_data.append((resume_file.filename or f"resume_{len(resume_data)}.pdf", content))

    if not resume_data:
        raise HTTPException(status_code=400, detail="No valid resume files uploaded.")

    logger.info("rank_request", jd_length=len(jd_text), n_resumes=len(resume_data))

    # ── Run pipeline ──────────────────────────────────────────────────
    try:
        result = await run_pipeline(
            jd_text=jd_text,
            resume_file_data=resume_data,
            w_keyword=w_keyword,
            w_semantic=w_semantic,
            penalty_per_missing=penalty_per_missing,
            fusion_mode=fusion_mode if fusion_mode in ("rrf", "weighted") else "rrf",
        )
    except Exception as e:
        logger.error("pipeline_failed", error=str(e)[:500])
        raise HTTPException(status_code=500, detail=f"Pipeline error: {str(e)[:200]}")

    # Store result for chat endpoint
    global _latest_result
    _latest_result = result

    # ── Build response ────────────────────────────────────────────────
    candidate_responses = []
    for c in result.ranked_candidates:
        evidence = [
            EvidenceChunkResponse(
                text=chunk.text[:300],
                section_type=chunk.section_type,
                similarity=round(chunk.similarity, 4),
            )
            for chunk in c.top_evidence_chunks[:3]
        ]

        candidate_responses.append(CandidateScoreResponse(
            candidate_id=c.candidate_id,
            candidate_name=c.candidate_name,
            rank=c.rank,
            final_score=c.final_score,
            keyword_score=c.keyword_score,
            semantic_score=c.semantic_score,
            skill_coverage_score=c.skill_coverage_score,
            bm25_score=c.bm25_score,
            matched_required=c.matched_required,
            matched_preferred=c.matched_preferred,
            missing_required=c.missing_required,
            missing_preferred=c.missing_preferred,
            required_coverage=round(c.required_coverage, 3),
            preferred_coverage=round(c.preferred_coverage, 3),
            top_evidence=evidence,
            penalty_applied=c.penalty_applied,
        ))

    explanation_responses = [
        ExplanationResponse(
            candidate_id=e.candidate_id,
            candidate_name=e.candidate_name,
            rank=e.rank,
            final_score=e.final_score,
            matched_skills=e.matched_skills,
            missing_required_skills=e.missing_required_skills,
            supporting_evidence=e.supporting_evidence,
            template_summary=e.template_summary,
            llm_summary=e.llm_summary,
        )
        for e in result.explanations
    ]

    bias_responses = [
        BiasFlagResponse(
            phrase=b.phrase,
            reason=b.reason,
            severity=b.severity,
            category=b.category,
            suggestion=b.suggestion,
        )
        for b in result.bias_flags
    ]

    jd_analysis = JDUploadResponse(
        required_skills=result.parsed_jd.required_skills,
        preferred_skills=result.parsed_jd.preferred_skills,
        all_skills=result.parsed_jd.all_skills,
        jd_text_length=len(result.parsed_jd.raw_text),
        jd_text_preview=result.parsed_jd.raw_text[:500],
    )

    return RankResponse(
        candidates=candidate_responses,
        explanations=explanation_responses,
        jd_analysis=jd_analysis,
        bias_flags=bias_responses,
        total_resumes=result.total_resumes,
        latency=LatencyResponse(
            total_ms=result.latency_ms,
            breakdown=result.latency_breakdown,
        ),
    )


@router.get("/candidate/{candidate_id}/explanation", response_model=ExplanationResponse)
async def get_candidate_explanation(candidate_id: str):
    """Get the explanation for a specific candidate from the latest run."""
    if not _latest_result:
        raise HTTPException(
            status_code=404,
            detail="No pipeline results available. Run /api/v2/rank first.",
        )

    for explanation in _latest_result.explanations:
        if explanation.candidate_id == candidate_id:
            return ExplanationResponse(
                candidate_id=explanation.candidate_id,
                candidate_name=explanation.candidate_name,
                rank=explanation.rank,
                final_score=explanation.final_score,
                matched_skills=explanation.matched_skills,
                missing_required_skills=explanation.missing_required_skills,
                supporting_evidence=explanation.supporting_evidence,
                template_summary=explanation.template_summary,
                llm_summary=explanation.llm_summary,
            )

    raise HTTPException(
        status_code=404,
        detail=f"No explanation found for candidate {candidate_id}. "
               f"Explanations are generated for top 3 candidates only.",
    )


@router.post("/bias-check", response_model=list[BiasFlagResponse])
async def check_bias(body: BiasCheckRequest):
    """Check a JD for potential bias or narrow phrasing."""
    flags = check_bias_rules(body.jd_text)

    return [
        BiasFlagResponse(
            phrase=f.phrase,
            reason=f.reason,
            severity=f.severity,
            category=f.category,
            suggestion=f.suggestion,
        )
        for f in flags
    ]


@router.post("/chat", response_model=ChatResponseModel)
async def recruiter_chat(body: ChatRequest):
    """
    Ask a question about the ranked candidates.
    Uses pre-computed scoring data for grounded answers.
    """
    if not _latest_result:
        raise HTTPException(
            status_code=404,
            detail="No pipeline results available. Run /api/v2/rank first.",
        )

    response = await answer_question(
        question=body.question,
        ranked_candidates=_latest_result.ranked_candidates,
    )

    return ChatResponseModel(
        question=response.question,
        answer=response.answer,
        source=response.source,
        referenced_candidates=response.referenced_candidates,
    )


class CompareResponse(BaseModel):
    candidate_a: CandidateScoreResponse
    candidate_b: CandidateScoreResponse
    skills_only_in_a: list[str]
    skills_only_in_b: list[str]
    skills_in_both: list[str]
    score_diff: float
    winner: str
    why_a_beats_b: list[str]


@router.get("/compare")
async def compare_candidates(id_a: str, id_b: str):
    """
    Deterministic comparison of two candidates — no LLM.
    Returns skill diff, score breakdown diff, and grounded reasons.
    """
    if not _latest_result:
        raise HTTPException(status_code=404, detail="Run /api/v2/rank first.")

    candidates_map = {c.candidate_id: c for c in _latest_result.ranked_candidates}
    ca = candidates_map.get(id_a)
    cb = candidates_map.get(id_b)

    if not ca or not cb:
        raise HTTPException(status_code=404, detail="One or both candidate IDs not found.")

    set_a = set(ca.matched_required + ca.matched_preferred)
    set_b = set(cb.matched_required + cb.matched_preferred)

    only_a = sorted(set_a - set_b)
    only_b = sorted(set_b - set_a)
    both = sorted(set_a & set_b)

    reasons = []
    if ca.final_score > cb.final_score:
        reasons.append(f"{ca.candidate_name} scores {ca.final_score:.1f} vs {cb.candidate_name}'s {cb.final_score:.1f} (+{ca.final_score - cb.final_score:.1f})")
    if only_a:
        reasons.append(f"Has {len(only_a)} unique required skills: {', '.join(only_a[:4])}")
    if len(ca.missing_required) < len(cb.missing_required):
        reasons.append(f"Missing fewer required skills ({len(ca.missing_required)} vs {len(cb.missing_required)})")
    if ca.semantic_score > cb.semantic_score:
        reasons.append(f"Stronger semantic match ({ca.semantic_score:.1f} vs {cb.semantic_score:.1f})")
    if ca.keyword_score > cb.keyword_score:
        reasons.append(f"Stronger keyword coverage ({ca.keyword_score:.1f} vs {cb.keyword_score:.1f})")

    def to_response(c: any) -> CandidateScoreResponse:
        evidence = [
            EvidenceChunkResponse(text=chunk.text[:300], section_type=chunk.section_type, similarity=round(chunk.similarity, 4))
            for chunk in c.top_evidence_chunks[:3]
        ]
        return CandidateScoreResponse(
            candidate_id=c.candidate_id, candidate_name=c.candidate_name, rank=c.rank,
            final_score=c.final_score, keyword_score=c.keyword_score, semantic_score=c.semantic_score,
            skill_coverage_score=c.skill_coverage_score, bm25_score=c.bm25_score,
            matched_required=c.matched_required, matched_preferred=c.matched_preferred,
            missing_required=c.missing_required, missing_preferred=c.missing_preferred,
            required_coverage=round(c.required_coverage, 3), preferred_coverage=round(c.preferred_coverage, 3),
            top_evidence=evidence, penalty_applied=c.penalty_applied,
        )

    winner = ca.candidate_name if ca.final_score >= cb.final_score else cb.candidate_name
    return CompareResponse(
        candidate_a=to_response(ca), candidate_b=to_response(cb),
        skills_only_in_a=only_a, skills_only_in_b=only_b, skills_in_both=both,
        score_diff=round(ca.final_score - cb.final_score, 2),
        winner=winner, why_a_beats_b=reasons,
    )


@router.get("/results/export")
async def export_results():
    """Export the latest ranking results as CSV."""
    if not _latest_result:
        raise HTTPException(
            status_code=404,
            detail="No pipeline results available. Run /api/v2/rank first.",
        )

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow([
        "Rank", "Name", "Final Score", "Keyword Score", "Semantic Score",
        "Skill Coverage", "BM25 Score", "Matched Required", "Missing Required",
        "Penalty", "Required Coverage %",
    ])

    for c in _latest_result.ranked_candidates:
        writer.writerow([
            c.rank,
            c.candidate_name,
            c.final_score,
            c.keyword_score,
            c.semantic_score,
            c.skill_coverage_score,
            c.bm25_score,
            "; ".join(c.matched_required),
            "; ".join(c.missing_required),
            c.penalty_applied,
            f"{c.required_coverage * 100:.1f}%",
        ])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={
            "Content-Disposition": "attachment; filename=ranking_results.csv",
        },
    )
