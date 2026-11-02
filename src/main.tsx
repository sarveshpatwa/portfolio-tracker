import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { registerServiceWorker, requestPersistentStorage } from './app/pwa';
import { priceService } from './application/priceService';
import { contributionService } from './application/contributionService';
import { linkPriceService } from './application/linkPriceService';
import './ui/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
// After each price check: fund prices from price links first, then recurring
// contributions (which need that day's prices).
priceService.onAfterTick(() => linkPriceService.runDue());
priceService.onAfterTick(() => contributionService.runDue());
priceService.start();
void requestPersistentStorage();
