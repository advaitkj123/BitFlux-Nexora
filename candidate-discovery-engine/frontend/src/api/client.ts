import axios from 'axios';
import type {
  SearchRequest,
  SearchResponse,
  CandidateDetailResponse,
  SearchHistoryResponse,
} from '../types';

// V2 API is at http://localhost:8000/api/v2 — all ranking endpoints live here.
// V1 endpoints (search, ingest, candidates) are offline — do NOT use.
const API_BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api/v2`
  : 'http://localhost:8000/api/v2';

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  timeout: 120000, // 2 min — ranking 200 resumes takes ~60s
});

/* ── V1 stubs — gracefully return empty rather than 404 ──────────── */
export async function searchCandidates(
  _request: SearchRequest
): Promise<SearchResponse> {
  // V1 offline — return empty
  return { results: [], total: 0, query_ms: 0, cached: false } as any;
}

export async function uploadAndSearch(
  _file: File,
  _topK: number = 20,
): Promise<SearchResponse> {
  // V1 offline — return empty
  return { results: [], total: 0, query_ms: 0, cached: false } as any;
}

export async function getCandidateDetail(
  _candidateId: string
): Promise<CandidateDetailResponse> {
  // V1 offline — route to v2 explanation endpoint
  throw new Error('Candidate detail not available. Use the /rank page.');
}

export async function getSearchHistory(
  _limit: number = 20
): Promise<SearchHistoryResponse> {
  // V1 history endpoint is offline — return empty gracefully
  return { history: [] } as any;
}

export default api;
