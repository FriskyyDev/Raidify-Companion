import type { CompanionBridge } from './index';

declare global {
  interface Window {
    companion: CompanionBridge;
  }
}

export {};
