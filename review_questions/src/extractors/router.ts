import type { SiteAdapter } from '../shared/types';
import YouTubeAdapter from './adapters/youtube';
import ForeignAffairsAdapter from './adapters/foreign-affairs';
import GenericAdapter from './adapters/generic';

// Order matters: specific adapters first, generic last
const adapters: SiteAdapter[] = [
  YouTubeAdapter,
  ForeignAffairsAdapter,
  GenericAdapter,
];

export function detectAdapter(url: string): SiteAdapter {
  for (const adapter of adapters) {
    if (adapter.matches(url)) return adapter;
  }
  return GenericAdapter; // should never reach here since generic matches all
}

export async function extractContent(url: string): Promise<{ text: string; adapterName: string }> {
  const adapter = detectAdapter(url);
  const text = await adapter.extract();
  if (!text || text.trim().length < 50) {
    throw new Error(`Extraction returned too little content (${text?.length ?? 0} chars). Try a different page.`);
  }
  return { text: text.trim(), adapterName: adapter.name };
}
