import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Landing } from './pages/Landing';
import { Dashboard } from './pages/Dashboard';
import { AllFlips } from './pages/AllFlips';
import { FlipDetail } from './pages/FlipDetail';
import { ItemExplorer } from './pages/ItemExplorer';
import { Settings } from './pages/Settings';

export function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/u/:username" element={<Dashboard />} />
        <Route path="/u/:username/flips" element={<AllFlips />} />
        <Route path="/flip/:auctionUuid" element={<FlipDetail />} />
        <Route path="/item/:itemId" element={<ItemExplorer />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
