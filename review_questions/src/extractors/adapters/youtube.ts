import type { SiteAdapter, FetchResponse } from '../../shared/types';

const DEBUG_PREFIX = '[YouTube Debug]';

/**
 * Extract the JSON object starting at `startIdx` in `text`,
 * handling nested braces and string literals correctly.
 */
function extractJSONObject(text: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];

    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;

    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.substring(startIdx, i + 1);
    }
  }
  return null;
}

function findPlayerResponse(): any {
  const scripts = document.querySelectorAll('script');
  for (const script of scripts) {
    const text = script.textContent || '';
    const marker = 'ytInitialPlayerResponse';
    const idx = text.indexOf(marker);
    if (idx === -1) continue;

    // Find the opening brace after the marker
    const braceIdx = text.indexOf('{', idx + marker.length);
    if (braceIdx === -1) continue;

    const jsonStr = extractJSONObject(text, braceIdx);
    if (!jsonStr) continue;

    try {
      return JSON.parse(jsonStr);
    } catch {
      continue;
    }
  }
  return null;
}

function decodeHTMLEntities(text: string): string {
  const el = document.createElement('textarea');
  el.innerHTML = text;
  return el.value;
}

function normalizeTranscriptText(text: string): string {
  return decodeHTMLEntities(text)
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeText(text: string, maxLen = 200): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}...`;
}

function isTranscriptActionLabel(label: string): boolean {
  return /\bshow transcript\b/i.test(label) || /\btranscript\b/i.test(label);
}

function isLikelyTimestamp(text: string): boolean {
  return /^\d{1,2}:\d{2}(?::\d{2})?$/.test(text.trim());
}

function dedupeAdjacent(lines: string[]): string[] {
  const deduped: string[] = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1] !== line) {
      deduped.push(line);
    }
  }
  return deduped;
}

function collectTranscriptLinesFromRenderers(renderers: NodeListOf<Element>): string[] {
  return dedupeAdjacent(
    Array.from(renderers)
      .map(renderer => {
        const textCandidate = renderer.querySelector(
          '.segment-text, yt-formatted-string.segment-text, [class*="segment-text"]'
        );
        const text = textCandidate?.textContent || '';
        return normalizeTranscriptText(text);
      })
      .filter(text => text && !isLikelyTimestamp(text))
  );
}

function getVisibleTranscriptSegments(): string[] {
  const renderers = document.querySelectorAll('ytd-transcript-segment-renderer');
  if (renderers.length > 0) {
    const lines = collectTranscriptLinesFromRenderers(renderers);
    if (lines.length > 0) {
      return dedupeAdjacent(lines);
    }
  }

  const panelRenderers = document.querySelectorAll(
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-searchable-transcript"] ytd-transcript-segment-renderer, ' +
    'ytd-transcript-renderer ytd-transcript-segment-renderer'
  );
  if (panelRenderers.length > 0) {
    return collectTranscriptLinesFromRenderers(panelRenderers);
  }

  return [];
}

function getElementLabel(el: Element): string {
  const pieces = [
    el.getAttribute('aria-label'),
    el.getAttribute('title'),
    el.textContent,
  ];
  return pieces.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function isElementVisible(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') {
    return false;
  }

  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function findClickableByLabel(pattern: RegExp): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    'button, [role="button"], tp-yt-paper-item, ytd-menu-service-item-renderer'
  );

  for (const candidate of candidates) {
    if (!isElementVisible(candidate)) continue;
    if (pattern.test(getElementLabel(candidate))) {
      return candidate;
    }
  }

  return null;
}

function findTranscriptAction(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(
    'button, [role="button"], tp-yt-paper-item, ytd-menu-service-item-renderer'
  );

  for (const candidate of candidates) {
    if (!isElementVisible(candidate)) continue;
    if (isTranscriptActionLabel(getElementLabel(candidate))) {
      return candidate;
    }
  }

  return null;
}

function describeElement(el: HTMLElement | null): string {
  if (!el) return 'none';
  const label = summarizeText(getElementLabel(el), 80);
  return `${el.tagName.toLowerCase()}${label ? `(${label})` : ''}`;
}

function clickElement(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center' });
  const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  for (const type of events) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  el.click();
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => window.setTimeout(resolve, ms));
}

async function waitForTranscriptSegments(timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const segments = getVisibleTranscriptSegments();
    if (segments.length > 0) return segments;
    await sleep(200);
  }

  return [];
}

async function tryOpenTranscriptPanel(): Promise<string | null> {
  const existingSegments = getVisibleTranscriptSegments();
  if (existingSegments.length > 0) {
    return existingSegments.join(' ');
  }

  const directButton = findTranscriptAction();
  if (directButton) {
    clickElement(directButton);
    const openedSegments = await waitForTranscriptSegments(6000);
    if (openedSegments.length > 0) return openedSegments.join(' ');
  }

  const moreActionsButton = findClickableByLabel(/\bmore actions\b/i);
  if (moreActionsButton) {
    clickElement(moreActionsButton);
    await sleep(300);

    const menuItem = findTranscriptAction();
    if (menuItem) {
      clickElement(menuItem);
      const openedSegments = await waitForTranscriptSegments(6000);
      if (openedSegments.length > 0) return openedSegments.join(' ');
    }
  }

  return null;
}

function parseXmlTranscript(responseText: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(responseText, 'text/xml');
  const textNodes = doc.querySelectorAll('text');

  return Array.from(textNodes)
    .map(node => normalizeTranscriptText(node.textContent || ''))
    .filter(Boolean)
    .join(' ');
}

function parseJsonTranscript(responseText: string): string {
  try {
    const data = JSON.parse(responseText);
    const events = Array.isArray(data?.events) ? data.events : [];

    const lines = events
      .flatMap((event: any) => Array.isArray(event?.segs) ? event.segs : [])
      .map((seg: any) => normalizeTranscriptText(seg?.utf8 || ''))
      .filter(Boolean);

    return dedupeAdjacent(lines).join(' ');
  } catch {
    return '';
  }
}

function parseVttTranscript(responseText: string): string {
  if (!/^WEBVTT\b/m.test(responseText)) {
    return '';
  }

  const lines = responseText
    .split('\n')
    .map(line => line.trim())
    .filter(line =>
      line &&
      line !== 'WEBVTT' &&
      !/^\d+$/.test(line) &&
      !/^\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(line) &&
      !/^\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}\.\d{3}/.test(line)
    )
    .map(normalizeTranscriptText)
    .filter(Boolean);

  return dedupeAdjacent(lines).join(' ');
}

function parseTranscriptResponse(responseText: string): string {
  const trimmed = responseText.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('{')) {
    return parseJsonTranscript(trimmed);
  }

  if (trimmed.startsWith('WEBVTT')) {
    return parseVttTranscript(trimmed);
  }

  if (trimmed.startsWith('<')) {
    return parseXmlTranscript(trimmed);
  }

  return '';
}

function buildTimedTextVariants(baseUrl: string): string[] {
  const urls: string[] = [];
  const addVariant = (mutate?: (url: URL) => void) => {
    const url = new URL(baseUrl);
    if (mutate) mutate(url);
    const href = url.toString();
    if (!urls.includes(href)) urls.push(href);
  };

  addVariant();
  addVariant(url => {
    url.searchParams.set('fmt', 'json3');
  });
  addVariant(url => {
    url.searchParams.set('fmt', 'vtt');
  });
  addVariant(url => {
    url.searchParams.delete('fmt');
    url.searchParams.set('xorb', '2');
    url.searchParams.set('xobt', '3');
    url.searchParams.set('xovt', '3');
  });

  return urls;
}

async function fetchTranscriptVariant(url: string): Promise<FetchResponse> {
  // Fetch in the page's MAIN world so the request has youtube.com cookies
  // and is same-origin. Extension-origin fetches return empty bodies.
  return chrome.runtime.sendMessage({ type: 'FETCH_IN_PAGE', url }) as Promise<FetchResponse>;
}

async function extractFromCaptions(playerResponse: any): Promise<string> {
  const tracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks?.length) throw new Error('No caption tracks found');

  const track = tracks.find((t: any) => t.languageCode === 'en') || tracks[0];
  const variants = buildTimedTextVariants(track.baseUrl);
  const failures: string[] = [];

  for (const url of variants) {
    const response: FetchResponse = await fetchTranscriptVariant(url);
    if (!response.ok) {
      const details = response.error || (response.status ? `HTTP ${response.status}` : 'unknown error');
      failures.push(`fetch failed for ${summarizeText(url, 100)}: ${details}`);
      continue;
    }

    const transcript = parseTranscriptResponse(response.text);
    if (transcript) {
      return transcript;
    }

    failures.push(
      `empty response for ${summarizeText(url, 100)} status=${response.status || 'unknown'} body=${summarizeText(response.text, 120)}`
    );
  }

  throw new Error(
    `Transcript response contained no text; lang=${track.languageCode || 'unknown'}; ` +
    `kind=${track.kind || 'standard'}; attempts=${failures.join(' || ')}`
  );
}

async function extractFromTranscriptPanel(): Promise<string> {
  const transcript = await tryOpenTranscriptPanel();
  if (transcript) {
    if (transcript.trim().length < 100) {
      throw new Error(
        `${DEBUG_PREFIX} Transcript panel returned too little text (${transcript.trim().length} chars): ` +
        summarizeText(transcript, 160)
      );
    }
    return transcript;
  }

  const renderers = document.querySelectorAll('ytd-transcript-segment-renderer').length;
  const textNodes = document.querySelectorAll(
    'ytd-transcript-renderer .segment-text, ' +
    'ytd-transcript-renderer yt-formatted-string.segment-text, ' +
    'ytd-transcript-segment-renderer .segment-text'
  ).length;
  const showTranscriptButton = describeElement(findTranscriptAction());
  const moreActionsButton = describeElement(findClickableByLabel(/\bmore actions\b/i));

  throw new Error(
    `No transcript available from the captions API or transcript panel; ` +
    `renderers=${renderers}; textNodes=${textNodes}; ` +
    `showTranscript=${showTranscriptButton}; moreActions=${moreActionsButton}`
  );
}

const YouTubeAdapter: SiteAdapter = {
  name: 'YouTube Video',

  matches(url: string) {
    return /youtube\.com\/watch/.test(url);
  },

  async extract(): Promise<string> {
    const playerResponse = findPlayerResponse();
    const errors: string[] = [];

    if (playerResponse) {
      try {
        return await extractFromCaptions(playerResponse);
      } catch (error) {
        errors.push(error instanceof Error ? error.message : 'Caption extraction failed');
      }
    } else {
      errors.push('Could not locate ytInitialPlayerResponse');
    }

    try {
      return await extractFromTranscriptPanel();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Transcript panel extraction failed');
    }

    throw new Error(errors.join(' | '));
  },
};

export default YouTubeAdapter;
