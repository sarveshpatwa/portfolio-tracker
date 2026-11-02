import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { registerServiceWorker, requestPersistentStorage } from './app/pwa';
import { priceService } from './application/priceService';
import { contributionService } from './application/contributionService';
import './ui/styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
// Recurring contributions run after each price check (they need that day's closing prices).
priceService.onAfterTick(() => contributionService.runDue());
priceService.start();
void requestPersistentStorage();
