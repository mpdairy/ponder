// --- Site Adapter ---

export interface SiteAdapter {
  name: string;
  matches(url: string): boolean;
  extract(): Promise<string>;
}

// --- Chrome messaging ---

export type ExtMessage =
  | { type: 'DETECT_CONTENT' }
  | { type: 'EXTRACT_CONTENT' }
  | { type: 'GENERATE_QUESTIONS' }
  | { type: 'FETCH_URL'; url: string }
  | { type: 'FETCH_IN_PAGE'; url: string; nonce: string }
  | { type: 'FETCH_YT_TRANSCRIPT'; videoId: string; nonce: string }
  | { type: 'GENERATE_SUMMARY' };

export interface DetectResponse {
  adapterName: string;
}

export interface ExtractResponse {
  text: string;
  adapterName: string;
  title: string;
}

export interface FetchResponse {
  ok: boolean;
  status?: number;
  text: string;
  error?: string;
}

// --- Storage ---

export interface StoredResult {
  status: 'loading' | 'done' | 'error';
  questions?: string[];
  title?: string;
  url?: string;
  adapterName?: string;
  timestamp: number;
  error?: string;
  sourceText?: string;
  summary?: string;
  summaryStatus?: 'loading' | 'done' | 'error';
  summaryError?: string;
}

export interface ExtensionOptions {
  proxyUrl: string;
  proxyToken: string;
  maxQuestions: number;
  showDifficulty: boolean;
}

export const DEFAULT_OPTIONS: ExtensionOptions = {
  proxyUrl: 'http://localhost:8787',
  proxyToken: '',
  maxQuestions: 10,
  showDifficulty: false,
};
