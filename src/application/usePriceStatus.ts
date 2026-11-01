import { useSyncExternalStore } from 'react';
import { priceService, type PriceStatus } from './priceService';

/** Live price-refresh status for the UI. */
export function usePriceStatus(): PriceStatus {
  return useSyncExternalStore(priceService.subscribe, priceService.getStatus, priceService.getStatus);
}
