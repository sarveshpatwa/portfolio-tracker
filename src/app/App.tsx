import { useEffect, useState } from 'react';
import { TabBar, type Tab } from '../ui/components/TabBar';
import { PortfoliosScreen } from '../ui/screens/PortfoliosScreen';
import { PortfolioScreen } from '../ui/screens/PortfolioScreen';
import { AddAssetScreen } from '../ui/screens/AddAssetScreen';
import { PlaceholderScreen } from '../ui/screens/PlaceholderScreen';
import { SettingsScreen } from '../ui/screens/SettingsScreen';
import { parseRoute, type Route } from './routes';

function tabFor(route: Route): Tab {
  if (route.name === 'compare' || route.name === 'settings') return route.name;
  return 'portfolios';
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.hash));

  useEffect(() => {
    const onHash = () => {
      setRoute(parseRoute(location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  return (
    <div className="app">
      <main className="app-main">
        {route.name === 'portfolios' && <PortfoliosScreen />}
        {route.name === 'portfolio' && <PortfolioScreen key={route.id} portfolioId={route.id} />}
        {route.name === 'add-asset' && <AddAssetScreen key={route.id} portfolioId={route.id} />}
        {route.name === 'compare' && (
          <PlaceholderScreen
            title="Compare"
            body="Ranking portfolios on equal money, and switch checks, arrive once contributions and market prices are in."
          />
        )}
        {route.name === 'settings' && <SettingsScreen />}
      </main>
      <TabBar current={tabFor(route)} />
    </div>
  );
}
