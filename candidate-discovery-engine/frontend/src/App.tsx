import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SearchProvider } from './hooks/useSearchContext';
import Navbar from './components/Navbar';
import Landing from './pages/Landing';
import SearchPage from './pages/Search';
import CandidateDetailPage from './pages/CandidateDetail';
import RankPage from './pages/RankPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Wrapper that applies the navbar to a page (except Landing which has its own design)
function WithNav({ children }: { children: React.ReactNode }) {
  return (
    <>
      <Navbar />
      {children}
    </>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <SearchProvider>
        <BrowserRouter>
          <Routes>
            {/* Landing has its own navbar-like header */}
            <Route path="/" element={<Landing />} />

            {/* Rank page is the main demo — no extra Navbar (has its own nav) */}
            <Route path="/rank" element={<RankPage />} />

            {/* Search page — redirect to /rank since v1 API is offline */}
            {/* Keep /search route but render the SearchPage with Navbar */}
            <Route path="/search" element={
              <WithNav>
                <SearchPage />
              </WithNav>
            } />

            <Route path="/candidates/:id" element={
              <WithNav>
                <CandidateDetailPage />
              </WithNav>
            } />

            {/* Catch-all: go home */}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </SearchProvider>
    </QueryClientProvider>
  );
}
