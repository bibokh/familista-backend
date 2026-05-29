import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '@/contexts/AuthContext';
import { Shell } from '@/components/layout/Shell';
import { PageLoader } from '@/components/ui/Spinner';

// Lazy-load page modules for code splitting
const Login               = lazy(() => import('@/pages/auth/Login').then(m => ({ default: m.Login })));
const Overview            = lazy(() => import('@/pages/overview/Overview').then(m => ({ default: m.Overview })));
const PlayerIntelligence  = lazy(() => import('@/pages/players/PlayerIntelligence').then(m => ({ default: m.PlayerIntelligence })));
const WorkloadDashboard   = lazy(() => import('@/pages/workload/WorkloadDashboard').then(m => ({ default: m.WorkloadDashboard })));
const TransferPipeline    = lazy(() => import('@/pages/transfer/TransferPipeline').then(m => ({ default: m.TransferPipeline })));
const CompetitionCenter   = lazy(() => import('@/pages/competition/CompetitionCenter').then(m => ({ default: m.CompetitionCenter })));
const AnalyticsCenter     = lazy(() => import('@/pages/analytics/AnalyticsCenter').then(m => ({ default: m.AnalyticsCenter })));
const VideoCenter         = lazy(() => import('@/pages/video/VideoCenter').then(m => ({ default: m.VideoCenter })));
const AICenter            = lazy(() => import('@/pages/ai/AICenter').then(m => ({ default: m.AICenter })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        // Don't retry on 401/403/404
        const status = (error as { status?: number })?.status;
        if (status && [401, 403, 404].includes(status)) return false;
        return failureCount < 2;
      },
      refetchOnWindowFocus: false,
    },
  },
});

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) {
    return <Navigate to="/app/login" replace />;
  }
  return <>{children}</>;
}

function AppRoutes() {
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/app/login" element={<Login />} />
        <Route
          path="/app"
          element={
            <ProtectedRoute>
              <Shell />
            </ProtectedRoute>
          }
        >
          <Route index          element={<Overview />} />
          <Route path="players"     element={<PlayerIntelligence />} />
          <Route path="workload"    element={<WorkloadDashboard />} />
          <Route path="transfer"    element={<TransferPipeline />} />
          <Route path="competition" element={<CompetitionCenter />} />
          <Route path="analytics"   element={<AnalyticsCenter />} />
          <Route path="video"       element={<VideoCenter />} />
          <Route path="ai"          element={<AICenter />} />
        </Route>
        {/* Default redirect */}
        <Route path="*" element={<Navigate to="/app" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
