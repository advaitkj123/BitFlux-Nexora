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

    Args:
        jd_embedding: Pre-computed JD embedding (normalized, shape (dim,))
        chunk_texts: List of resume chunk texts
        chunk_section_types: Corresponding section types for each chunk
        top_k: Number of top chunks to average for the final score

    Returns:
        SemanticResult with score (0-100), top evidence chunks, and raw similarities
    """
    if not chunk_texts:
        return SemanticResult(
            score=0.0,
            top_chunks=[],
            all_similarities=[],
            mean_similarity=0.0,
        )

    # Batch encode all chunks
    chunk_embeddings = embed_texts_batch(chunk_texts)

    # Cosine similarity = dot product (since vectors are normalized)
    similarities = chunk_embeddings @ jd_embedding  # shape: (n_chunks,)

    # Get top-k indices
    k = min(top_k, len(similarities))
    top_k_indices = np.argsort(similarities)[-k:][::-1]  # Descending order

    # Build evidence chunks
    top_chunks = [
        EvidenceChunk(
            text=chunk_texts[i],
            section_type=chunk_section_types[i],
            similarity=float(similarities[i]),
        )
        for i in top_k_indices
    ]

    # Final score = mean of top-k similarities, scaled to 0-100
    mean_sim = float(np.mean([similarities[i] for i in top_k_indices]))
    # Cosine similarity range for sentence-transformers is typically [0.0, 1.0]
    # for related content. We scale to 0-100.
    score = max(0.0, min(100.0, mean_sim * 100.0))

    return SemanticResult(
        score=round(score, 2),
        top_chunks=top_chunks,
        all_similarities=[float(s) for s in similarities],
        mean_similarity=round(mean_sim, 4),
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

    Args:
        jd_text: The job description text
        all_chunk_texts: List of chunk text lists (one per resume)
        all_chunk_section_types: Corresponding section types (one per resume)
        top_k: Number of top chunks to average per resume

    Returns:
        List of SemanticResult, one per resume
    """
    t0 = time.monotonic()

    # Embed JD once
    jd_embedding = embed_text(jd_text)

    # Flatten all chunks for batch embedding
    flat_texts: list[str] = []
    boundaries: list[tuple[int, int]] = []  # (start_idx, end_idx) per resume
    for chunks in all_chunk_texts:
        start = len(flat_texts)
        flat_texts.extend(chunks)
        boundaries.append((start, len(flat_texts)))

    # Single batch encode for ALL chunks across ALL resumes
    if flat_texts:
        all_embeddings = embed_texts_batch(flat_texts)
    else:
        all_embeddings = np.array([], dtype=np.float32).reshape(0, 384)

    # Compute per-resume results
    results: list[SemanticResult] = []
    for i, (start, end) in enumerate(boundaries):
        if start == end:
            results.append(SemanticResult(
                score=0.0, top_chunks=[], all_similarities=[], mean_similarity=0.0,
            ))
            continue

        chunk_embeddings = all_embeddings[start:end]
        similarities = chunk_embeddings @ jd_embedding

        k = min(top_k, len(similarities))
        top_k_indices = np.argsort(similarities)[-k:][::-1]

        chunk_texts = all_chunk_texts[i]
        section_types = all_chunk_section_types[i]

        top_chunks = [
            EvidenceChunk(
                text=chunk_texts[j],
                section_type=section_types[j],
                similarity=float(similarities[j]),
            )
            for j in top_k_indices
        ]

        mean_sim = float(np.mean([similarities[j] for j in top_k_indices]))
        score = max(0.0, min(100.0, mean_sim * 100.0))

        results.append(SemanticResult(
            score=round(score, 2),
            top_chunks=top_chunks,
            all_similarities=[float(s) for s in similarities],
            mean_similarity=round(mean_sim, 4),
        ))

    embed_ms = int((time.monotonic() - t0) * 1000)
    logger.info(
        "batch_semantic_scores_computed",
        n_resumes=len(results),
        total_chunks=len(flat_texts),
        latency_ms=embed_ms,
    )

    return results
