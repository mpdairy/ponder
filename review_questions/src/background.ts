import type { ExtMessage, ExtractResponse, FetchResponse, StoredResult, ExtensionOptions } from './shared/types';

const DEFAULTS: ExtensionOptions = {
  proxyUrl: 'http://localhost:8787',
  questionCount: 6,
  showDifficulty: false,
};

function originPatternFromUrl(rawUrl: string): string {
  const { origin } = new URL(rawUrl);
  return `${origin}/*`;
}

async function ensureProxyPermission(proxyUrl: string): Promise<void> {
  const originPattern = originPatternFromUrl(proxyUrl);
  const hasPermission = await chrome.permissions.contains({ origins: [originPattern] });
  if (!hasPermission) {
    throw new Error(`Missing host permission for proxy origin: ${originPattern}. Re-save the proxy URL and approve access.`);
  }
}

async function getOptions(): Promise<ExtensionOptions> {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return stored as ExtensionOptions;
}

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  return tab;
}

chrome.runtime.onMessage.addListener(
  (message: ExtMessage, sender, sendResponse: (resp: any) => void) => {

    // Content script asks us to fetch a URL (for YouTube transcripts, etc.)
    if (message.type === 'FETCH_URL') {
      fetch(message.url)
        .then(async r => {
          const text = await r.text();
          const resp: FetchResponse = { ok: r.ok, status: r.status, text };
          sendResponse(resp);
        })
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            text: '',
            error: error instanceof Error ? error.message : 'Network error',
          } as FetchResponse);
        });
      return true; // async
    }

    // Fetch a URL in the page's MAIN world (has page cookies & same-origin)
    if (message.type === 'FETCH_IN_PAGE') {
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, text: '', error: 'No tab ID' } as FetchResponse);
        return true;
      }

      chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN' as any,
        func: async (url: string) => {
          const r = await fetch(url);
          return { ok: r.ok, status: r.status, text: await r.text() };
        },
        args: [message.url],
      }).then(results => {
        const result = results?.[0]?.result as FetchResponse | undefined;
        sendResponse(result || { ok: false, text: '', error: 'No result from page context' });
      }).catch(err => {
        sendResponse({ ok: false, text: '', error: err.message || 'executeScript failed' } as FetchResponse);
      });
      return true; // async
    }

    // Popup asks us to generate questions
    if (message.type === 'GENERATE_QUESTIONS') {
      handleGenerate().then(sendResponse).catch(err => {
        sendResponse({ error: err.message });
      });
      return true; // async
    }

    return false;
  }
);

async function handleGenerate(): Promise<{ ok: boolean }> {
  const tab = await getActiveTab();
  const options = await getOptions();

  const loadingResult: StoredResult = {
    status: 'loading',
    title: tab.title || 'Untitled',
    url: tab.url || '',
    timestamp: Date.now(),
  };
  await chrome.storage.local.set({ latestResult: loadingResult });

  const resultsUrl = chrome.runtime.getURL('results/results.html');
  await chrome.tabs.create({ url: resultsUrl });

  const proxyHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.proxyToken) {
    proxyHeaders['Authorization'] = `Bearer ${options.proxyToken}`;
  }

  try {
    let text: string;
    let adapterName: string;
    let title: string;

    // Check for highlighted text first — works on any site
    let selection = '';
    try {
      const [selResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id! },
        func: () => window.getSelection()?.toString()?.trim() || '',
      });
      selection = selResult?.result || '';
    } catch {}

    if (selection.length > 50) {
      text = selection;
      adapterName = 'Selection';
      title = tab.title || 'Untitled';
    } else if (/youtube\.com\/watch/.test(tab.url || '')) {
      // YouTube: extract transcript server-side via the proxy.
      // Browser-side extraction hits YouTube's service worker and
      // returns empty — server-side fetch works reliably.
      const videoId = new URL(tab.url!).searchParams.get('v');
      if (!videoId) throw new Error('No video ID in YouTube URL');

      await ensureProxyPermission(options.proxyUrl);
      const ytResp = await fetch(`${options.proxyUrl}/transcript`, {
        method: 'POST',
        headers: proxyHeaders,
        body: JSON.stringify({ videoId }),
      });
      if (!ytResp.ok) {
        const errBody = await ytResp.text().catch(() => 'Unknown error');
        throw new Error(`Transcript extraction failed: ${errBody}`);
      }
      const ytData = await ytResp.json();
      text = ytData.text;
      adapterName = 'YouTube Video';
      title = ytData.title || tab.title || 'YouTube Video';
    } else {
      const extraction: ExtractResponse & { error?: string } =
        await chrome.tabs.sendMessage(tab.id!, { type: 'EXTRACT_CONTENT' });
      if (extraction.error) throw new Error(extraction.error);
      text = extraction.text;
      adapterName = extraction.adapterName;
      title = extraction.title || tab.title || 'Untitled';
    }

    await ensureProxyPermission(options.proxyUrl);
    const proxyResp = await fetch(`${options.proxyUrl}/generate`, {
      method: 'POST',
      headers: proxyHeaders,
      body: JSON.stringify({
        text,
        maxQuestions: options.maxQuestions,
        showDifficulty: options.showDifficulty,
      }),
    });

    if (!proxyResp.ok) {
      const errBody = await proxyResp.text().catch(() => 'Unknown error');
      throw new Error(`Proxy returned ${proxyResp.status}: ${errBody}`);
    }

    const { questions } = await proxyResp.json();

    const doneResult: StoredResult = {
      status: 'done',
      questions,
      title,
      url: tab.url || '',
      adapterName,
      timestamp: Date.now(),
    };
    await chrome.storage.local.set({ latestResult: doneResult });

  } catch (err: any) {
    const errorResult: StoredResult = {
      status: 'error',
      title: tab.title || 'Untitled',
      url: tab.url || '',
      timestamp: Date.now(),
      error: err.message || 'Something went wrong',
    };
    await chrome.storage.local.set({ latestResult: errorResult });
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// YouTube MAIN-world extraction
// ---------------------------------------------------------------------------

async function extractYouTubeViaMainWorld(
  tabId: number,
): Promise<{ text?: string; title?: string; error?: string }> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN' as chrome.scripting.ExecutionWorld,
    func: ytMainWorldExtractor,
  });
  return results?.[0]?.result ?? { error: 'executeScript returned no result' };
}

/**
 * Runs inside YouTube's page JS context (MAIN world).
 * MUST be fully self-contained — no closures, no imports.
 */
async function ytMainWorldExtractor(): Promise<{
  text?: string;
  title?: string;
  error?: string;
}> {
  const errors: string[] = [];

  /* ---- helpers ---- */

  function decode(s: string): string {
    const el = document.createElement('textarea');
    el.innerHTML = s;
    return el.value;
  }

  function parseTranscript(raw: string): string | null {
    const t = raw.trim();
    if (!t) return null;

    // XML / srv3
    if (t.startsWith('<') || t.includes('<text ')) {
      const doc = new DOMParser().parseFromString(t, 'text/xml');
      const nodes = doc.querySelectorAll('text');
      if (nodes.length > 0) {
        const out = Array.from(nodes)
          .map(n => decode(n.textContent || ''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (out.length > 20) return out;
      }
    }

    // JSON3
    if (t.startsWith('{') || t.startsWith('[')) {
      try {
        const data = JSON.parse(t);
        const events: any[] = data?.events ?? data;
        if (Array.isArray(events)) {
          const out = events
            .flatMap((e: any) => (Array.isArray(e?.segs) ? e.segs : []))
            .map((s: any) => (s?.utf8 || '').trim())
            .filter(Boolean)
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (out.length > 20) return out;
        }
      } catch { /* not JSON */ }
    }

    // WebVTT
    if (t.startsWith('WEBVTT')) {
      const out = t
        .split('\n')
        .map(l => l.trim())
        .filter(
          l =>
            l &&
            l !== 'WEBVTT' &&
            !/^\d+$/.test(l) &&
            !/-->/.test(l),
        )
        .map(decode)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (out.length > 20) return out;
    }

    return null;
  }

  /** Walk an object tree (depth-limited) looking for a key. */
  function deepFind(obj: any, key: string, depth: number = 12): any {
    if (depth <= 0 || !obj || typeof obj !== 'object') return undefined;
    if (key in obj) return obj[key];
    for (const v of Object.values(obj)) {
      const found = deepFind(v, key, depth - 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  /** Extract transcript segments from an innertube get_transcript response. */
  function parseInnertubeTranscript(data: any): string[] {
    const segments: string[] = [];

    // Path 1: actions → updateEngagementPanelAction (standard response)
    for (const action of data?.actions ?? []) {
      const initial =
        action?.updateEngagementPanelAction?.content
          ?.transcriptRenderer?.content
          ?.transcriptSearchPanelRenderer?.body
          ?.transcriptSegmentListRenderer?.initialSegments ?? [];
      for (const seg of initial) {
        const runs =
          seg?.transcriptSegmentRenderer?.snippet?.runs ?? [];
        const line = runs.map((r: any) => r.text ?? '').join('');
        if (line.trim()) segments.push(line.trim());
      }
    }

    // Path 2: direct body (some YouTube versions)
    if (segments.length === 0) {
      const found = deepFind(data, 'transcriptSegmentListRenderer', 10);
      if (found?.initialSegments) {
        for (const seg of found.initialSegments) {
          const runs =
            seg?.transcriptSegmentRenderer?.snippet?.runs ?? [];
          const line = runs.map((r: any) => r.text ?? '').join('');
          if (line.trim()) segments.push(line.trim());
        }
      }
    }

    return segments;
  }

  /* ---- begin extraction ---- */

  try {
    const videoId = new URLSearchParams(location.search).get('v');
    if (!videoId) return { error: 'No video ID in URL' };

    // Find player response (try multiple known locations)
    let pr: any = (window as any).ytInitialPlayerResponse;

    if (!pr || typeof pr !== 'object' || !pr.captions) {
      const alt = (window as any).ytplayer?.config?.args?.raw_player_response;
      if (alt?.captions) pr = alt;
    }

    const videoTitle: string =
      pr?.videoDetails?.title || document.title.replace(/ - YouTube$/, '');

    // ── Attempt 1: caption-track baseUrl ──────────────────────────

    const tracks: any[] | undefined =
      pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (Array.isArray(tracks) && tracks.length > 0) {
      const track =
        tracks.find((t: any) => t.languageCode === 'en') || tracks[0];

      if (track?.baseUrl) {
        // The baseUrl is a signed URL but is missing the track-specific
        // params (lang, kind, name). Without &lang= YouTube returns empty.
        let fullBase = track.baseUrl;
        if (track.languageCode && !fullBase.includes('&lang=')) {
          fullBase += `&lang=${encodeURIComponent(track.languageCode)}`;
        }
        if (track.kind && !fullBase.includes('&kind=')) {
          fullBase += `&kind=${encodeURIComponent(track.kind)}`;
        }
        const trackName = typeof track.name === 'string'
          ? track.name
          : track.name?.simpleText ?? '';
        if (trackName && !fullBase.includes('&name=')) {
          fullBase += `&name=${encodeURIComponent(trackName)}`;
        }

        const fmts = ['', 'srv3', 'json3', 'vtt'];
        for (const fmt of fmts) {
          const url = fmt
            ? `${fullBase}&fmt=${fmt}`
            : fullBase;
          try {
            const r = await fetch(url);
            const body = await r.text();
            const parsed = parseTranscript(body);
            if (parsed) return { text: parsed, title: videoTitle };
            errors.push(
              `fmt=${fmt || 'default'}: ${r.status}, ${body.length}ch`,
            );
          } catch (e: any) {
            errors.push(`fmt=${fmt || 'default'}: ${e.message}`);
          }
        }
        // Diagnostic: show the URL so we can see what went wrong
        errors.push(`baseUrl(${track.baseUrl.substring(0, 300)})`);
        errors.push(
          `track: lang=${track.languageCode} kind=${track.kind} name=${track.name || '(none)'}`,
        );
      } else {
        errors.push('caption track has no baseUrl');
      }
    } else {
      errors.push(
        pr
          ? `playerResponse found (keys: ${Object.keys(pr).slice(0, 8).join(',')}) but no captionTracks`
          : 'ytInitialPlayerResponse not on window',
      );
    }

    // ── Attempt 1b: re-fetch the watch page for fresh caption URLs ─
    //    The signed URLs from ytInitialPlayerResponse may have expired.
    //    Fetching the page again gives us fresh URLs.

    try {
      const pageResp = await fetch(location.href);
      const pageHtml = await pageResp.text();

      // Find ytInitialPlayerResponse JSON in the HTML
      const marker = 'ytInitialPlayerResponse';
      const mIdx = pageHtml.indexOf(marker);
      if (mIdx !== -1) {
        const braceStart = pageHtml.indexOf('{', mIdx + marker.length);
        if (braceStart !== -1) {
          // Brace-match to extract JSON
          let depth = 0;
          let inStr = false;
          let esc = false;
          let endIdx = -1;
          for (let i = braceStart; i < pageHtml.length; i++) {
            const ch = pageHtml[i];
            if (esc) { esc = false; continue; }
            if (ch === '\\' && inStr) { esc = true; continue; }
            if (ch === '"') { inStr = !inStr; continue; }
            if (inStr) continue;
            if (ch === '{') depth++;
            if (ch === '}') {
              depth--;
              if (depth === 0) { endIdx = i; break; }
            }
          }
          if (endIdx !== -1) {
            const freshPR = JSON.parse(pageHtml.substring(braceStart, endIdx + 1));
            const freshTracks = freshPR?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
            if (Array.isArray(freshTracks) && freshTracks.length > 0) {
              const ft = freshTracks.find((t: any) => t.languageCode === 'en') || freshTracks[0];
              if (ft?.baseUrl) {
                for (const fmt of ['', 'srv3', 'json3']) {
                  const url = fmt ? `${ft.baseUrl}&fmt=${fmt}` : ft.baseUrl;
                  const r = await fetch(url);
                  const body = await r.text();
                  const parsed = parseTranscript(body);
                  if (parsed) return { text: parsed, title: videoTitle };
                }
                errors.push(`fresh-fetch: tracks found but all formats empty`);
              }
            } else {
              errors.push('fresh-fetch: no captionTracks in re-fetched page');
            }
          }
        }
      } else {
        errors.push('fresh-fetch: no ytInitialPlayerResponse in re-fetched page');
      }
    } catch (e: any) {
      errors.push(`fresh-fetch: ${e.message}`);
    }

    // ── Attempt 2: innertube get_transcript API ──────────────────
    //    First try to find pre-encoded params from ytInitialData
    //    (the page already has the right protobuf blob).
    //    Fall back to manual encoding if not found.

    try {
      const ytcfg: any = (window as any).ytcfg;
      const apiKey: string | undefined =
        ytcfg?.data_?.INNERTUBE_API_KEY ??
        (typeof ytcfg?.get === 'function'
          ? ytcfg.get('INNERTUBE_API_KEY')
          : undefined);
      const clientVersion: string =
        ytcfg?.data_?.INNERTUBE_CLIENT_VERSION ??
        (typeof ytcfg?.get === 'function'
          ? ytcfg.get('INNERTUBE_CLIENT_VERSION')
          : null) ??
        '2.20250301.00.00';

      if (!apiKey) {
        errors.push('no INNERTUBE_API_KEY');
      } else {
        // --- 2a: find pre-encoded params from ytInitialData ---
        const ytInitialData: any = (window as any).ytInitialData;
        let pageParams: string | undefined;
        if (ytInitialData) {
          // Search engagement panels for the transcript endpoint
          const panels: any[] = ytInitialData?.engagementPanels ?? [];
          for (const panel of panels) {
            const renderer = panel?.engagementPanelSectionListRenderer;
            if (
              renderer?.panelIdentifier ===
              'engagement-panel-searchable-transcript'
            ) {
              // Params can be in continuationEndpoint or header
              const ep = deepFind(renderer, 'getTranscriptEndpoint', 8);
              if (ep?.params) {
                pageParams = ep.params;
                break;
              }
            }
          }
          // Broader fallback: search entire ytInitialData
          if (!pageParams) {
            const ep = deepFind(ytInitialData, 'getTranscriptEndpoint', 10);
            if (ep?.params) pageParams = ep.params;
          }
        }

        // --- 2b: collect candidate params blobs ---
        const paramsCandidates: Array<{ label: string; params: string }> = [];

        if (pageParams) {
          paramsCandidates.push({ label: 'pageData', params: pageParams });
        }

        // Manual protobuf encoding — try two known structures
        const enc = new TextEncoder();
        const vidBytes = enc.encode(videoId);

        // Structure A: { 1: { 2: videoId } }
        const innerA = new Uint8Array([0x12, vidBytes.length, ...vidBytes]);
        const outerA = new Uint8Array([0x0a, innerA.length, ...innerA]);
        paramsCandidates.push({
          label: 'proto-A',
          params: btoa(String.fromCharCode(...outerA)),
        });

        // Structure B: { 1: { 1: { 1: videoId } } }
        const innerB1 = new Uint8Array([0x0a, vidBytes.length, ...vidBytes]);
        const innerB2 = new Uint8Array([0x0a, innerB1.length, ...innerB1]);
        const outerB = new Uint8Array([0x0a, innerB2.length, ...innerB2]);
        paramsCandidates.push({
          label: 'proto-B',
          params: btoa(String.fromCharCode(...outerB)),
        });

        // --- 2c: build auth headers (SAPISIDHASH) ---
        // YouTube's innertube API requires this for authenticated users.
        const authHeaders: Record<string, string> = {};
        const sapisid =
          document.cookie.match(/SAPISID=([^;]+)/)?.[1] ??
          document.cookie.match(/__Secure-3PAPISID=([^;]+)/)?.[1] ??
          document.cookie.match(/__Secure-1PAPISID=([^;]+)/)?.[1];

        if (sapisid) {
          const ts = Math.floor(Date.now() / 1000);
          const msgBuf = new TextEncoder().encode(
            `${ts} ${sapisid} https://www.youtube.com`,
          );
          const hashBuf = await crypto.subtle.digest('SHA-1', msgBuf);
          const hashHex = Array.from(new Uint8Array(hashBuf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');
          authHeaders['Authorization'] = `SAPISIDHASH ${ts}_${hashHex}`;
          authHeaders['X-Goog-AuthUser'] = '0';
          authHeaders['X-Origin'] = 'https://www.youtube.com';
        }

        // visitorData is REQUIRED — without it innertube returns 400
        const visitorData: string | undefined =
          ytcfg?.data_?.VISITOR_DATA ??
          (typeof ytcfg?.get === 'function'
            ? ytcfg.get('VISITOR_DATA')
            : undefined);
        if (!visitorData) {
          errors.push('no VISITOR_DATA in ytcfg');
        }

        // --- 2d: try each params candidate ---
        for (const { label, params } of paramsCandidates) {
          try {
            const resp = await fetch(
              `https://www.youtube.com/youtubei/v1/get_transcript?key=${apiKey}`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  ...authHeaders,
                },
                body: JSON.stringify({
                  context: {
                    client: {
                      hl: 'en',
                      gl: 'US',
                      clientName: 'WEB',
                      clientVersion,
                      ...(visitorData ? { visitorData } : {}),
                      userAgent: navigator.userAgent,
                      originalUrl: location.href,
                    },
                    user: {},
                    request: {
                      useSsl: true,
                      internalExperimentFlags: [],
                    },
                  },
                  params,
                }),
              },
            );

            if (resp.ok) {
              const data = await resp.json();
              const segments = parseInnertubeTranscript(data);
              if (segments.length > 0) {
                return {
                  text: segments.join(' ').replace(/\s+/g, ' ').trim(),
                  title: videoTitle,
                };
              }
              errors.push(
                `innertube[${label}] OK, 0 segments (keys: ${Object.keys(data).join(',')})`,
              );
            } else {
              const body = await resp.text().catch(() => '');
              errors.push(
                `innertube[${label}] HTTP ${resp.status} ${body.substring(0, 120)}`,
              );
            }
          } catch (e: any) {
            errors.push(`innertube[${label}]: ${e.message}`);
          }
        }
      }
    } catch (e: any) {
      errors.push(`innertube: ${e.message}`);
    }

    // ── Attempt 3: intercept YouTube's own transcript fetch ────
    //
    // Monkey-patch BOTH fetch and XMLHttpRequest before opening the
    // transcript panel.  YouTube's code has all the right auth —
    // we just capture its response.

    try {
      // --- Step 1: install fetch + XHR interceptors ---
      let capturedText: string | null = null;
      let capturedUrl: string = '';

      const _origFetch = window.fetch;
      (window as any).fetch = async function (input: any, init?: any) {
        const resp = await _origFetch.call(window, input, init);
        const url = typeof input === 'string' ? input : input?.url || '';
        if (
          !capturedText &&
          (url.includes('get_transcript') || url.includes('timedtext'))
        ) {
          try {
            const clone = resp.clone();
            capturedText = await clone.text();
            capturedUrl = 'fetch:' + url.substring(0, 80);
          } catch {}
        }
        return resp;
      };

      const _origXHROpen = XMLHttpRequest.prototype.open;
      const _origXHRSend = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (
        method: string,
        url: string | URL,
        ...rest: any[]
      ) {
        (this as any).__ponder_url = String(url);
        return _origXHROpen.apply(this, [method, url, ...rest] as any);
      };
      XMLHttpRequest.prototype.send = function (...args: any[]) {
        const xhr = this;
        const url: string = (xhr as any).__ponder_url || '';
        if (url.includes('get_transcript') || url.includes('timedtext')) {
          xhr.addEventListener('load', () => {
            if (!capturedText && xhr.responseText) {
              capturedText = xhr.responseText;
              capturedUrl = 'xhr:' + url.substring(0, 80);
            }
          });
        }
        return _origXHRSend.apply(this, args);
      };

      try {
        // --- Step 2: close transcript panel if already open, then re-open ---
        //     This forces a fresh network request we can intercept.
        const panelSel =
          '[target-id="engagement-panel-searchable-transcript"]';
        const existingPanel = document.querySelector(panelSel);
        if (existingPanel) {
          // Close it by clicking the X button
          const closeBtn = existingPanel.querySelector<HTMLElement>(
            'button[aria-label*="Close"], button[aria-label*="close"], #close-button button',
          );
          if (closeBtn) {
            closeBtn.click();
            await new Promise(r => setTimeout(r, 600));
          }
        }

        // Dismiss any open overlay
        document.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
        await new Promise(r => setTimeout(r, 300));

        // Click "Show transcript"
        const allBtns = document.querySelectorAll<HTMLElement>(
          'button, [role="button"], ytd-menu-service-item-renderer, tp-yt-paper-item',
        );
        let clicked = false;
        for (const btn of allBtns) {
          const lbl = (
            (btn.getAttribute('aria-label') || '') +
            ' ' +
            (btn.textContent || '')
          ).toLowerCase();
          if (/\btranscript\b/.test(lbl) && !/search/.test(lbl)) {
            btn.click();
            clicked = true;
            break;
          }
        }
        if (!clicked) {
          for (const btn of allBtns) {
            const lbl = (
              (btn.getAttribute('aria-label') || '') +
              ' ' +
              (btn.textContent || '')
            ).toLowerCase();
            if (/more actions/.test(lbl)) {
              btn.click();
              await new Promise(r => setTimeout(r, 600));
              for (const item of document.querySelectorAll<HTMLElement>(
                'tp-yt-paper-item, ytd-menu-service-item-renderer',
              )) {
                if (/transcript/i.test(item.textContent || '')) {
                  item.click();
                  clicked = true;
                  break;
                }
              }
              break;
            }
          }
        }

        // Wait for intercepted data or panel segments to appear
        if (clicked) {
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 300));
            if (capturedText) break;
          }
        }
      } finally {
        // Always restore originals
        (window as any).fetch = _origFetch;
        XMLHttpRequest.prototype.open = _origXHROpen;
        XMLHttpRequest.prototype.send = _origXHRSend;
      }

      // --- Step 3a: parse intercepted data ---
      if (capturedText && capturedText.length > 20) {
        errors.push(`intercepted via ${capturedUrl} (${capturedText.length}ch)`);
        try {
          const jsonData = JSON.parse(capturedText);
          const segments = parseInnertubeTranscript(jsonData);
          if (segments.length > 0) {
            return {
              text: segments.join(' ').replace(/\s+/g, ' ').trim(),
              title: videoTitle,
            };
          }
          errors.push(
            `intercepted JSON, 0 segments (keys: ${Object.keys(jsonData).slice(0, 5).join(',')})`,
          );
        } catch {
          const parsed = parseTranscript(capturedText);
          if (parsed) return { text: parsed, title: videoTitle };
          errors.push(`intercepted ${capturedText.length}ch, unparseable`);
        }
      } else {
        errors.push(
          `intercept: ${capturedText === null ? 'nothing captured (no fetch or XHR)' : `${capturedText.length}ch`}`,
        );
      }

      // --- Step 3b: read dom-repeat.items (ALL items, not just rendered) ---
      const panel = document.querySelector(
        '[target-id="engagement-panel-searchable-transcript"]',
      );

      if (panel) {
        // dom-repeat stores the full items array even when virtualizing
        const domRepeats = panel.querySelectorAll('dom-repeat');
        for (const dr of domRepeats) {
          const items = (dr as any).items;
          if (Array.isArray(items) && items.length > 3) {
            const lines: string[] = [];
            for (const item of items) {
              const runs =
                item?.transcriptSegmentRenderer?.snippet?.runs ??
                item?.snippet?.runs;
              if (Array.isArray(runs)) {
                const line = runs.map((r: any) => r.text || '').join('').trim();
                if (line) lines.push(line);
              } else {
                // Try plain text properties
                const txt =
                  item?.transcriptSegmentRenderer?.snippet?.simpleText ??
                  item?.text ??
                  item?.simpleText;
                if (typeof txt === 'string' && txt.trim()) lines.push(txt.trim());
              }
            }
            if (lines.length > 3) {
              return {
                text: lines.join(' ').replace(/\s+/g, ' ').trim(),
                title: videoTitle,
              };
            }
            errors.push(
              `dom-repeat: ${items.length} items, ${lines.length} had text, sample=${JSON.stringify(items[0]).substring(0, 200)}`,
            );
          }
        }
        errors.push(
          `dom-repeat: ${domRepeats.length} found${domRepeats.length > 0 ? `, items=${(domRepeats[0] as any).items?.length ?? 'none'}` : ''}`,
        );

        // Also try every custom element's __data for segment arrays
        const customEls = panel.querySelectorAll('*');
        for (const el of customEls) {
          if (!el.tagName.includes('-')) continue;
          const cmp = el as any;
          const paths = [
            cmp.__data?.initialSegments,
            cmp.__data?.segments,
            cmp.__data?.body?.transcriptSegmentListRenderer?.initialSegments,
            cmp.data?.body?.transcriptSegmentListRenderer?.initialSegments,
            cmp.initialSegments,
            cmp.segments,
            cmp.items,
          ];
          for (const arr of paths) {
            if (Array.isArray(arr) && arr.length > 3) {
              const lines: string[] = [];
              for (const seg of arr) {
                const runs = seg?.transcriptSegmentRenderer?.snippet?.runs;
                if (Array.isArray(runs)) {
                  const line = runs.map((r: any) => r.text || '').join('').trim();
                  if (line) lines.push(line);
                }
              }
              if (lines.length > 3) {
                return {
                  text: lines.join(' ').replace(/\s+/g, ' ').trim(),
                  title: videoTitle,
                };
              }
            }
          }
        }
      }

      // --- Step 3c: scroll + accumulate visible segments ---
      //     Parse timestamp→text pairs at each scroll position and
      //     accumulate them.  This overcomes the virtual-list limitation.
      const tsRe = /^\d{1,2}:\d{2}(:\d{2})?$/;
      const UI_NOISE =
        /^(Sync to video time|Follow along|Auto-scroll|Search in video|All)$/i;

      /** Extract visible transcript segments as timestamp→text map. */
      function parseVisibleSegments(): Map<string, string> {
        const segs = new Map<string, string>();
        const lines = (document.body.innerText || '').split('\n');
        let anchor = -1;
        for (let i = 0; i < lines.length; i++) {
          if (/^Transcript$/i.test(lines[i].trim())) {
            for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
              if (tsRe.test(lines[j].trim())) { anchor = j; break; }
            }
            if (anchor !== -1) break;
          }
        }
        if (anchor === -1) return segs;

        let curTs = '';
        let curText: string[] = [];
        let gap = 0;
        for (let i = anchor; i < lines.length; i++) {
          const l = lines[i].trim();
          if (!l) continue;
          if (tsRe.test(l)) {
            if (curTs && curText.length) segs.set(curTs, curText.join(' '));
            curTs = l;
            curText = [];
            gap = 0;
            continue;
          }
          if (UI_NOISE.test(l)) continue;
          gap++;
          if (gap > 3) break;
          if (l.length > 1) curText.push(l);
        }
        if (curTs && curText.length) segs.set(curTs, curText.join(' '));
        return segs;
      }

      // Find scrollable elements inside/around the transcript panel
      const scrollers: HTMLElement[] = [];
      if (panel) {
        const check = (el: Element) => {
          const h = el as HTMLElement;
          if (h.scrollHeight > h.clientHeight + 30 && h.clientHeight > 30) {
            scrollers.push(h);
          }
        };
        check(panel);
        panel.querySelectorAll('*').forEach(check);
        // Also check ancestors (panel might be inside a scrollable container)
        let anc = panel.parentElement;
        for (let i = 0; i < 5 && anc; i++, anc = anc.parentElement) {
          if (anc.scrollHeight > anc.clientHeight + 30 && anc.clientHeight > 30) {
            scrollers.push(anc);
          }
        }
      }

      errors.push(
        `scrollers: ${scrollers.length}${scrollers.map(s => ` ${s.tagName.toLowerCase()}(sh=${s.scrollHeight},ch=${s.clientHeight})`).join('')}`,
      );

      // Accumulate segments across scroll positions
      const allSegs = new Map<string, string>();
      const initial = parseVisibleSegments();
      for (const [ts, txt] of initial) allSegs.set(ts, txt);

      for (const scroller of scrollers) {
        scroller.scrollTop = 0;
        await new Promise(r => setTimeout(r, 250));

        for (let pass = 0; pass < 120; pass++) {
          const prev = scroller.scrollTop;
          scroller.scrollTop += 200;
          await new Promise(r => setTimeout(r, 120));
          if (Math.abs(scroller.scrollTop - prev) < 2) break;

          const visible = parseVisibleSegments();
          for (const [ts, txt] of visible) {
            if (!allSegs.has(ts)) allSegs.set(ts, txt);
          }
        }
        if (allSegs.size > 20) break;
      }

      // Also try dispatching wheel events on the panel (in case CSS
      // overflow isn't set but a JS scroll handler exists)
      if (allSegs.size < 10 && panel) {
        for (let i = 0; i < 80; i++) {
          panel.dispatchEvent(
            new WheelEvent('wheel', { deltaY: 300, bubbles: true }),
          );
          await new Promise(r => setTimeout(r, 120));
          const visible = parseVisibleSegments();
          for (const [ts, txt] of visible) {
            if (!allSegs.has(ts)) allSegs.set(ts, txt);
          }
        }
      }

      if (allSegs.size > 3) {
        // Sort by timestamp and join
        const parseTs = (s: string) => {
          const p = s.split(':').map(Number);
          return p.length >= 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
        };
        const sorted = [...allSegs.entries()].sort(
          (a, b) => parseTs(a[0]) - parseTs(b[0]),
        );
        const fullText = sorted.map(([, t]) => t).join(' ').replace(/\s+/g, ' ').trim();

        if (fullText.length < 1500) {
          return {
            text: `[PARTIAL ${fullText.length}ch segs=${allSegs.size} | ${errors.join(' | ')}]\n\n${fullText}`,
            title: videoTitle,
          };
        }
        return { text: fullText, title: videoTitle };
      }

      errors.push(`scroll-accum: only ${allSegs.size} segments found`);
    } catch (e: any) {
      errors.push(`attempt3: ${e.message}`);
    }

    return { error: errors.join(' | ') };
  } catch (e: any) {
    return { error: `top-level: ${e.message}` };
  }
}
