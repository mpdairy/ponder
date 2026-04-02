# Review Questions Browser Extension

## Overview

A browser extension (Chrome/Chromium) that extracts the main textual content from the current page and sends it to a lightweight proxy backend, which forwards it to the Claude API to generate open-ended review questions. The user can read the questions *before* consuming the content as an advance organizer for learning, or *after* as a comprehension check.

The API key never touches the browser. It lives server-side in the proxy (a Cloudflare Worker or local dev server).

## Architecture

```
┌─────────────────────────────────────┐
│         Browser Extension           │
│                                     │
│  ┌───────────┐   ┌───────────────┐  │
│  │  Popup UI │   │ Content Script│  │
│  │ (display  │   │ (runs in page │  │
│  │ questions)│   │  context)     │  │
│  └─────┬─────┘   └──────┬────────┘  │
│        │                │           │
│        │   ┌────────────┴────────┐  │
│        │   │  Extractor Router   │  │
│        │   │                     │  │
│        │   │  ┌───────────────┐  │  │
│        │   │  │ Site Adapters │  │  │
│        │   │  │ - YouTube     │  │  │
│        │   │  │ - ForeignAff  │  │  │
│        │   │  │ - Generic     │  │  │
│        │   │  └───────────────┘  │  │
│        │   └────────────┬────────┘  │
│        │                │           │
│  ┌─────┴────────────────┴────────┐  │
│  │     Background Service Worker │  │
│  │     - Sends text to proxy     │  │
│  │     - Receives questions back │  │
│  └──────────────┬────────────────┘  │
└─────────────────┼───────────────────┘
                  │ HTTPS
                  ▼
┌─────────────────────────────────────┐
│         Proxy Backend               │
│  (Cloudflare Worker or localhost)   │
│                                     │
│  - Holds ANTHROPIC_API_KEY          │
│  - Receives { text, n } from ext   │
│  - Constructs prompt                │
│  - Calls Claude API                 │
│  - Returns questions to extension   │
└─────────────────────────────────────┘
```

## Core Components

### 1. Extractor Router (`src/extractors/router.ts`)

Matches the current URL against registered site adapters and delegates extraction. Every adapter implements the same interface:

```ts
interface SiteAdapter {
  /** Glob or regex patterns this adapter handles */
  matchPatterns: string[];

  /** 
   * Extract the main textual content from the current page.
   * Runs in the content script context (has DOM access).
   * Returns plain text, stripped of nav/ads/boilerplate.
   */
  extract(): Promise<string>;
}
```

The router tries adapters in registration order. If no specific adapter matches, fall through to the `GenericAdapter`.

### 2. Site Adapters (`src/extractors/adapters/`)

Each adapter is a single file exporting a `SiteAdapter`.

#### `youtube.ts`
- **Match**: `*://www.youtube.com/watch*`
- **Strategy**: 
  1. Extract the video ID from the URL (`v` query param).
  2. Attempt to grab the transcript from YouTube's internal timedtext API. The endpoint is embedded in the page's `ytInitialPlayerResponse` JSON — look for `captions.playerCaptionsTracklistRenderer.captionTracks`. Pick the English track (or first available) and fetch its URL.
  3. The response is XML with `<text start="..." dur="...">` elements. Concatenate all text nodes, stripping timestamps.
  4. **Fallback**: If the caption track approach fails, look for the transcript panel in the DOM (`ytd-transcript-segment-list-renderer`). Click "Show transcript" if needed and scrape the text from `yt-formatted-string` elements inside each segment.
- **Notes**: Auto-generated captions are fine. They're noisy but the LLM handles it well.

#### `foreign-affairs.ts`
- **Match**: `*://www.foreignaffairs.com/*/\*`
- **Strategy**:
  1. The article body lives in `article` or `.article-body` or `[data-body-content]`. Inspect the DOM and grab the most specific container.
  2. Extract all `<p>` tags within that container. Join with newlines.
  3. Strip author bios, related article links, subscription CTAs, and image captions.
- **Notes**: Runs in the authenticated page context so paywall content is accessible. Do NOT attempt to fetch the URL externally.

#### `generic.ts`
- **Match**: `*` (fallback)
- **Strategy**:
  1. Use Mozilla's Readability algorithm (bundle `@mozilla/readability`). Clone the document, run Readability, extract `textContent` from the result.
  2. If Readability fails (returns null), fall back to grabbing the largest `<article>` element, or the element with the most `<p>` children.
  3. Strip to plain text.
- **Notes**: This won't be perfect for every site but gives a reasonable baseline. Users can request site-specific adapters for sites they use frequently.

### 3. Background Service Worker (`src/background.ts`)

Bridges the content script and the proxy backend. The content script sends extracted text to the background worker via `chrome.runtime.sendMessage`. The background worker forwards it to the proxy.

#### Proxy Communication

The background worker sends a POST request to the proxy backend:

```ts
POST {PROXY_URL}/generate
Content-Type: application/json

{
  "text": "<extracted content>",
  "n": 6
}
```

Response:

```ts
{
  "questions": [
    "**Question 1** ...",
    "**Question 2** ...",
    ...
  ]
}
```

- `PROXY_URL` is configured in the extension options. Defaults to `http://localhost:8787` for local dev.
- The prompt construction, model selection, and API key all live server-side in the proxy. The extension never sees any of it.

### 3b. Proxy Backend (`proxy/`)

A lightweight server whose only job is: receive text + question count from the extension, construct the prompt, call Claude, return the questions. Two implementations are provided — use whichever fits your deployment.

#### Cloudflare Worker (`proxy/cloudflare/`)

Recommended for deployed/multi-machine use. Deploy with `wrangler`.

- **API key**: Stored as a Cloudflare secret (`wrangler secret put ANTHROPIC_API_KEY`)
- **CORS**: Allow requests from the extension's origin only (chrome-extension://<id>). During dev, also allow localhost.
- **Rate limiting**: Optional — Cloudflare's free tier rate limiting or a simple in-memory counter per IP.

```ts
// proxy/cloudflare/src/index.ts (sketch)
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return handleCORS(request);
    
    const { text, n } = await request.json();
    
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: `Generate ${n} review questions for the following content:\n\n<content>\n${text}\n</content>` }
        ],
      }),
    });
    
    const data = await response.json();
    const questions = parseQuestions(data.content[0].text);
    
    return new Response(JSON.stringify({ questions }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  },
};
```

`wrangler.toml`:

```toml
name = "review-questions-proxy"
main = "src/index.ts"
compatibility_date = "2024-01-01"
```

#### Local Dev Server (`proxy/local/`)

For development or single-machine use. Tiny Node/Express app.

```ts
// proxy/local/server.ts (sketch)
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

app.post('/generate', async (req, res) => {
  const { text, n = 6 } = req.body;
  
  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: `Generate ${n} review questions for the following content:\n\n<content>\n${text}\n</content>` }
    ],
  });
  
  const questions = parseQuestions(message.content[0].text);
  res.json({ questions });
});

app.listen(8787, () => console.log('Proxy running on http://localhost:8787'));
```

Run with: `ANTHROPIC_API_KEY=sk-... npx ts-node proxy/local/server.ts`

#### Shared Prompt (used by both proxy implementations)

```
SYSTEM_PROMPT:
You are a review question generator. Given the text content of an article or video transcript, generate {n} open-ended review questions that test comprehension of the key ideas, arguments, and facts presented.

Rules:
- Questions should be open-ended, not yes/no
- Cover the major themes and arguments, not trivia
- Questions should be answerable purely from the provided content
- Order questions roughly by where the relevant content appears
- Be specific enough that a vague answer wouldn't suffice
- Bold key terms in each question
- Do not include answers

Respond with only the numbered questions, no preamble.
```

- Default `n` = 6, configurable in extension options (range: 3-12).
- Sonnet's context window is 200k tokens. Even very long transcripts or articles fit comfortably — no truncation needed, just send the full text.

### 4. Popup UI (`src/popup/`)

Simple, minimal UI that opens when the user clicks the extension icon.

#### States:
1. **Idle**: Shows a "Generate Questions" button and the detected site adapter name (e.g., "YouTube transcript", "Foreign Affairs article", "Generic extraction").
2. **Loading**: Spinner + "Extracting content..." then "Generating questions..."
3. **Results**: Numbered list of questions displayed as styled HTML. Each question is a block element. Include a "Copy All" button that copies the questions as plain text.
4. **Error**: Friendly error message. Common cases: proxy URL not configured, proxy unreachable, extraction failed (no content found), API error returned from proxy.

#### Options page (`src/options/`):
- Proxy URL input (defaults to `http://localhost:8787`, change to Cloudflare Worker URL for deployed use)
- Number of questions slider (3-12, default 6)
- Toggle: "Include question difficulty hints" (appends estimated difficulty to each question)

### 5. Content Script (`src/content.ts`)

Injected into all pages. Listens for messages from the popup or background worker. When triggered:
1. Runs the extractor router to get text.
2. Sends the text back via `chrome.runtime.sendMessage`.

Minimal footprint — doesn't modify the page DOM or inject any visible UI.

## File Structure

```
review-questions-extension/
├── manifest.json            # MV3 manifest
├── src/
│   ├── background.ts        # Service worker: proxy communication
│   ├── content.ts           # Content script: extraction trigger
│   ├── extractors/
│   │   ├── router.ts        # URL matching + adapter dispatch
│   │   └── adapters/
│   │       ├── youtube.ts
│   │       ├── foreign-affairs.ts
│   │       └── generic.ts
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.ts
│   │   └── popup.css
│   ├── options/
│   │   ├── options.html
│   │   ├── options.ts
│   │   └── options.css
│   └── shared/
│       └── types.ts         # SiteAdapter interface, message types
├── proxy/
│   ├── cloudflare/
│   │   ├── src/
│   │   │   └── index.ts     # Cloudflare Worker entry
│   │   ├── wrangler.toml
│   │   └── package.json
│   └── local/
│       ├── server.ts        # Express dev server
│       └── package.json
├── icons/                   # 16, 48, 128px icons
├── package.json
├── tsconfig.json
└── vite.config.ts           # or webpack — bundle for extension
```

## Manifest (MV3)

```json
{
  "manifest_version": 3,
  "name": "Review Questions",
  "version": "0.1.0",
  "description": "Generate review questions from any article or video",
  "permissions": ["activeTab", "storage"],
  "background": {
    "service_worker": "dist/background.js"
  },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["dist/content.js"],
      "run_at": "document_idle"
    }
  ],
  "action": {
    "default_popup": "dist/popup/popup.html",
    "default_icon": {
      "16": "icons/icon-16.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    }
  },
  "options_ui": {
    "page": "dist/options/options.html",
    "open_in_tab": false
  }
}
```

Note: No `host_permissions` for the Claude API needed — the extension only talks to the proxy. If using the Cloudflare Worker, add its domain to `host_permissions` (e.g., `"https://review-questions-proxy.<you>.workers.dev/*"`). For localhost dev, `http://localhost:8787/*`.

## Adding a New Site Adapter

1. Create `src/extractors/adapters/mysite.ts`
2. Export an object implementing `SiteAdapter`
3. Register it in `src/extractors/router.ts` (add to the adapters array, before `generic`)
4. Rebuild

Example skeleton:

```ts
import { SiteAdapter } from '../shared/types';

const MySiteAdapter: SiteAdapter = {
  matchPatterns: ['*://www.mysite.com/articles/*'],
  
  extract: async () => {
    const article = document.querySelector('.article-content');
    if (!article) throw new Error('Could not find article content');
    return article.textContent?.trim() ?? '';
  },
};

export default MySiteAdapter;
```

## Token Budget Estimates

| Content type         | Input tokens (approx) | Output tokens (approx) | Cost (Sonnet) |
|---------------------|-----------------------|------------------------|---------------|
| 10-min YT video     | ~2,000                | ~400                   | ~$0.002       |
| 15-min YT video     | ~3,000                | ~500                   | ~$0.003       |
| Long-form article   | ~3,000-5,000          | ~400-600               | ~$0.003-0.005 |
| Academic paper      | ~8,000-12,000         | ~500-700               | ~$0.008-0.012 |

At typical usage (5-10 items/day), monthly cost should be well under $1.

## Future Enhancements (Not MVP)

- **Socratic mode**: Instead of all questions upfront, drip questions one at a time in a conversational flow (requires more complex UI and multi-turn API calls)
- **Answer checking**: User types answers, LLM evaluates them against the source content
- **Spaced repetition export**: Export questions as Anki cards
- **Highlight extraction**: Also pull out key quotes/claims alongside questions
- **Multi-language support**: Detect content language, generate questions in same language (relevant for Tongues integration?)
- **Keyboard shortcut**: Bind to a hotkey so you don't need to click the popup
