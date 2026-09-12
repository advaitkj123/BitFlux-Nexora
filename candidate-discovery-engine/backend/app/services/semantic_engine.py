"""
Semantic Matching Engine — local sentence-transformer embeddings.

Uses all-MiniLM-L6-v2 (384-dim, ~80MB, fast on CPU) for:
1. Embedding the JD as a single normalized vector
2. Embedding each resume chunk (section-level, not whole-resume)
3. Computing cosine similarity between JD and each chunk
4. Taking the mean of top-k chunk similarities as the resume's semantic score

Why chunk-level instead of whole-resume embedding?
    Embedding an entire resume as one vector dilutes a single highly relevant
    bullet point with ten irrelevant ones. Chunk-level embedding is what
    actually surfaces "built REST APIs with Express and MongoDB" as strongly
    matching a Node.js backend JD.

Why mean-of-top-k instead of max or full mean?
    - Single max: one lucky sentence inflates the score
    - Full mean: dilution from irrelevant sections
    - Top-k mean: robust signal from the k best-matching sections

FULLY OFFLINE — zero API calls, no internet needed during demo.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import structlog

logger = structlog.get_logger()

# ── Lazy-loaded model singleton ──────────────────────────────────────
_model = None
_MODEL_NAME = "all-MiniLM-L6-v2"


def _get_model():
    """Lazy-load the sentence-transformer model (first call takes ~2-3s)."""
    global _model
    if _model is None:
        t0 = time.monotonic()
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(_MODEL_NAME)
        load_ms = int((time.monotonic() - t0) * 1000)
        logger.info("semantic_model_loaded", model=_MODEL_NAME, load_ms=load_ms)
    return _model


def preload_model():
    """Pre-load the model at startup to avoid cold-start latency."""
    _get_model()
    logger.info("semantic_model_preloaded", model=_MODEL_NAME)


@dataclass
class EvidenceChunk:
    """A single chunk with its similarity score — used for explanations."""
    text: str
    section_type: str
    similarity: float


@dataclass
class SemanticResult:
    """Complete semantic matching result for one candidate."""
    score: float                          # 0-100
    top_chunks: list[EvidenceChunk]       # Top-k most similar chunks
    all_similarities: list[float]         # All chunk similarities (for debugging)
    mean_similarity: float                # Raw mean of top-k similarities (0.0-1.0)


# Sections excluded from semantic scoring — they contain contact info/headers
# that accidentally match JD title keywords (e.g. "Founders Office" in name line)
EXCLUDE_FROM_SEMANTIC = {"header", "other"}

# Section weights for scoring — experience and projects are most relevant
SECTION_WEIGHTS: dict[str, float] = {
    "experience": 1.4,
    "projects": 1.3,
    "skills": 1.2,
    "summary": 1.0,
    "certifications": 0.9,
    "education": 0.7,
    "publications": 0.8,
    "header": 0.0,  # never used — excluded above
    "other": 0.6,
}


def _get_section_weight(section_type: str) -> float:
    """Get the relevance weight for a section type."""
    base = section_type.split("_")[0]  # handle 'experience_0', 'experience_1'
    return SECTION_WEIGHTS.get(base, 0.8)


def embed_text(text: str) -> np.ndarray:
    """Embed a single text string, returning a normalized vector."""
    model = _get_model()
    vec = model.encode(text, normalize_embeddings=True, show_progress_bar=False)
    return np.array(vec, dtype=np.float32)


def embed_texts_batch(texts: list[str]) -> np.ndarray:
    """
    Batch-embed multiple texts. MUCH faster than calling embed_text in a loop.
    Returns shape (n_texts, embedding_dim) with normalized vectors.
    """
    model = _get_model()
    vecs = model.encode(
        texts,
        normalize_embeddings=True,
        show_progress_bar=False,
        batch_size=32,
    )
    return np.array(vecs, dtype=np.float32)


def compute_semantic_score(
    jd_embedding: np.ndarray,
    chunk_texts: list[str],
    chunk_section_types: list[str],
    top_k: int = 4,
) -> SemanticResult:
    """
    Compute semantic similarity between a JD and a resume's chunks.

    Fixes applied:
    - Excludes 'header' sections (name/email/phone) which bias similarity
    - Applies section-type weights (experience > skills > summary > education)
    - Uses min-max normalization across candidates for better score spread
    - Falls back to mean of available chunks if fewer than top_k exist
    """
    if not chunk_texts:
        return SemanticResult(
            score=0.0, top_chunks=[], all_similarities=[], mean_similarity=0.0,
        )

    # Filter out header sections before embedding
    filtered_texts: list[str] = []
    filtered_types: list[str] = []
    excluded_indices: set[int] = set()
    for idx, (text, stype) in enumerate(zip(chunk_texts, chunk_section_types)):
        base_type = stype.split("_")[0]
        if base_type in EXCLUDE_FROM_SEMANTIC or not text.strip():
            excluded_indices.add(idx)
        else:
            filtered_texts.append(text)
            filtered_types.append(stype)

    if not filtered_texts:
        return SemanticResult(
            score=0.0, top_chunks=[], all_similarities=[], mean_similarity=0.0,
        )

    chunk_embeddings = embed_texts_batch(filtered_texts)
    raw_sims = chunk_embeddings @ jd_embedding  # cosine similarity

    # Apply section weights
    weighted_sims = np.array([
        float(raw_sims[i]) * _get_section_weight(filtered_types[i])
        for i in range(len(filtered_texts))
    ])

    k = min(top_k, len(weighted_sims))
    top_k_indices = np.argsort(weighted_sims)[-k:][::-1]

    top_chunks = [
        EvidenceChunk(
            text=filtered_texts[i][:500],  # Trim to 500 chars for display
            section_type=filtered_types[i],
            similarity=float(raw_sims[i]),
        )
        for i in top_k_indices
    ]

    # Use RAW (unweighted) similarities for the final score to keep 0-100 scale honest
    raw_top_k_mean = float(np.mean([raw_sims[i] for i in top_k_indices]))
    # Sentence-transformer cosine sim typically ranges 0.2 - 0.85 for related content
    # Rescale from [0.2, 0.85] → [0, 100] for better spread
    LOW, HIGH = 0.20, 0.85
    score = max(0.0, min(100.0, ((raw_top_k_mean - LOW) / (HIGH - LOW)) * 100.0))

    return SemanticResult(
        score=round(score, 2),
        top_chunks=top_chunks,
        all_similarities=[float(s) for s in raw_sims],
        mean_similarity=round(raw_top_k_mean, 4),
    )


def compute_batch_semantic_scores(
    jd_text: str,
    all_chunk_texts: list[list[str]],
    all_chunk_section_types: list[list[str]],
    top_k: int = 4,
) -> list[SemanticResult]:
    """
    Compute semantic scores for multiple resumes at once.
    More efficient because we embed the JD only once.

    Applies section filtering, section weighting, and score rescaling
    with min-max normalization across the candidate pool for maximum spread.
    """
    t0 = time.monotonic()

    # Embed JD once
    jd_embedding = embed_text(jd_text)

    # Filter and flatten all chunks (exclude header/other sections)
    filtered_per_resume: list[tuple[list[str], list[str]]] = []
    flat_texts: list[str] = []
    boundaries: list[tuple[int, int]] = []

    for chunk_texts, chunk_types in zip(all_chunk_texts, all_chunk_section_types):
        f_texts, f_types = [], []
        for text, stype in zip(chunk_texts, chunk_types):
            base_type = stype.split("_")[0]
            if base_type not in EXCLUDE_FROM_SEMANTIC and text.strip():
                f_texts.append(text)
                f_types.append(stype)
        filtered_per_resume.append((f_texts, f_types))
        start = len(flat_texts)
        flat_texts.extend(f_texts)
        boundaries.append((start, len(flat_texts)))

    # Single batch encode for ALL chunks across ALL resumes
    if flat_texts:
        all_embeddings = embed_texts_batch(flat_texts)
    else:
        all_embeddings = np.array([], dtype=np.float32).reshape(0, 384)

    # Compute per-resume raw top-k mean similarities (before normalization)
    raw_means: list[float] = []
    interim: list[dict] = []

    for i, (start, end) in enumerate(boundaries):
        f_texts, f_types = filtered_per_resume[i]
        if start == end or not f_texts:
            raw_means.append(0.0)
            interim.append({"top_chunks": [], "raw_sims": [], "top_k_raw_mean": 0.0})
            continue

        chunk_embeddings = all_embeddings[start:end]
        raw_sims = chunk_embeddings @ jd_embedding

        # Weighted similarities for ranking chunks (but not for final score)
        weighted_sims = np.array([
            float(raw_sims[j]) * _get_section_weight(f_types[j])
            for j in range(len(f_texts))
        ])

        k = min(top_k, len(weighted_sims))
        top_k_indices = np.argsort(weighted_sims)[-k:][::-1]

        top_chunks = [
            EvidenceChunk(
                text=f_texts[j][:500],
                section_type=f_types[j],
                similarity=float(raw_sims[j]),
            )
            for j in top_k_indices
        ]

        top_k_raw_mean = float(np.mean([raw_sims[j] for j in top_k_indices]))
        raw_means.append(top_k_raw_mean)
        interim.append({
            "top_chunks": top_chunks,
            "raw_sims": [float(s) for s in raw_sims],
            "top_k_raw_mean": top_k_raw_mean,
        })

    # Min-max normalize across the candidate pool for MUCH better score spread
    # This ensures the best candidate gets close to 100 and weakest gets close to 0
    if raw_means:
        pool_min = min(raw_means)
        pool_max = max(raw_means)
        pool_range = pool_max - pool_min if pool_max != pool_min else 1.0
    else:
        pool_min, pool_max, pool_range = 0.0, 1.0, 1.0

    results: list[SemanticResult] = []
    for i, data in enumerate(interim):
        if not data["top_chunks"]:
            results.append(SemanticResult(
                score=0.0, top_chunks=[], all_similarities=[], mean_similarity=0.0,
            ))
            continue

        raw_mean = data["top_k_raw_mean"]
        # Pool-normalized score: 0-100 relative to this batch
        normalized_score = ((raw_mean - pool_min) / pool_range) * 100.0
        score = max(0.0, min(100.0, normalized_score))

        results.append(SemanticResult(
            score=round(score, 2),
            top_chunks=data["top_chunks"],
            all_similarities=data["raw_sims"],
            mean_similarity=round(raw_mean, 4),
        ))

    embed_ms = int((time.monotonic() - t0) * 1000)
    logger.info(
        "batch_semantic_scores_computed",
        n_resumes=len(results),
        total_chunks=len(flat_texts),
        latency_ms=embed_ms,
        pool_min=round(pool_min, 3),
        pool_max=round(pool_max, 3),
    )

    return results
