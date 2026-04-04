import type { SiteAdapter } from '../../shared/types';

const DEBUG_PREFIX = '[YouTube Debug]';

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

  // InnerTube format: <p> tags with <s> children
  const pNodes = doc.querySelectorAll('p');
  if (pNodes.length > 0) {
    const lines = Array.from(pNodes)
      .map(p => {
        const segs = p.querySelectorAll('s');
        const text = segs.length > 0
          ? Array.from(segs).map(s => s.textContent || '').join('')
          : p.textContent || '';
        return normalizeTranscriptText(text);
      })
      .filter(Boolean);
    if (lines.length > 0) return dedupeAdjacent(lines).join(' ');
  }

  // Legacy format: <text> tags
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

async function extractViaInnerTube(): Promise<string> {
  const videoId = new URL(window.location.href).searchParams.get('v');
  if (!videoId) throw new Error('No video ID in URL');

  const nonce = `ponder_yt_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  const resp: any = await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ ok: false, text: '', error: 'InnerTube fetch timed out' });
    }, 20000);

    function handler(event: MessageEvent) {
      if (event.source !== window) return;
      if (event.data?.type !== '__ponder_yt_transcript__' || event.data?.nonce !== nonce) return;
      window.removeEventListener('message', handler);
      clearTimeout(timeout);
      resolve(event.data.result);
    }

    window.addEventListener('message', handler);
    chrome.runtime.sendMessage({ type: 'FETCH_YT_TRANSCRIPT', videoId, nonce });
  });

  if (!resp.ok) throw new Error(resp.error || 'InnerTube transcript fetch failed');

  const transcript = parseTranscriptResponse(resp.text);
  if (!transcript) throw new Error('InnerTube returned XML but no text could be parsed');
  return transcript;
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
    const errors: string[] = [];

    try {
      return await extractViaInnerTube();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'InnerTube extraction failed');
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
