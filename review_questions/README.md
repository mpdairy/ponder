# Review Questions

A browser extension that generates open-ended review questions from any article or video. Extract the content, send it to Claude, get back questions you can use as an advance organizer before reading or a comprehension check after.

The API key never touches the browser. It lives server-side in a lightweight proxy (Cloudflare Worker or local dev server).

## Setup

There are three things to set up: the extension, the proxy backend, and connecting them.

### 1. Build the Extension

```bash
npm install
npm run build
```

This outputs a ready-to-load extension in `dist/`.

### 2. Load in Chrome

1. Go to `chrome://extensions`
2. Enable **Developer mode** (toggle in top right)
3. Click **Load unpacked** and select the `dist/` folder
4. The extension icon (lightbulb) should appear in your toolbar

### 3. Set Up the Proxy

The proxy sits between the extension and the Claude API. Pick one:

#### Option A: Local Dev Server

Good for trying it out on your own machine.

```bash
cd proxy/local
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```

The server runs on `http://localhost:8787`. No further extension config needed — that's the default proxy URL.

Set `DEBUG=1` to echo back extracted text instead of calling Claude (useful for testing extraction):

```bash
DEBUG=1 ANTHROPIC_API_KEY=sk-ant-... npm start
```

#### Option B: Cloudflare Worker

Good for using across machines or sharing with others.

```bash
cd proxy/cloudflare
npm install
```

Set your secrets:

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put PONDER_PROXY_TOKEN
```

`ANTHROPIC_API_KEY` is your Anthropic API key. `PONDER_PROXY_TOKEN` is a shared secret you make up — the extension sends it as a Bearer token so only you can use your proxy. Generate one with `openssl rand -base64 32` or pick whatever you want.

Deploy:

```bash
npm run deploy
```

Wrangler will print your worker URL (e.g. `https://review-questions-proxy.<you>.workers.dev`).

### 4. Configure the Extension

Right-click the extension icon and choose **Options**, or find it in `chrome://extensions` and click **Details > Extension options**.

- **Proxy URL**: Your worker URL (or leave as `http://localhost:8787` for local dev)
- **Proxy token**: The `PONDER_PROXY_TOKEN` value you set (leave blank for local dev)
- **Max questions**: How many questions to generate (4-30)
- **Difficulty hints**: Optionally tag each question as Basic/Intermediate/Advanced

When you save, the extension will prompt you to grant host permission for the proxy URL.

## Usage

1. Navigate to an article or YouTube video
2. Click the extension icon
3. It detects the content type (YouTube transcript, article, etc.)
4. Optionally highlight specific text on the page to use that instead
5. Click **Generate Questions**
6. Questions open in a new tab

## Supported Sites

| Site | Strategy |
|------|----------|
| YouTube | Server-side transcript extraction via the proxy `/transcript` endpoint |
| Foreign Affairs | Article body extraction with noise stripping |
| Everything else | Mozilla Readability, then fallback heuristics |

You can also highlight text on any page and generate questions from the selection.

## Adding a Site Adapter

Create a new file in `src/extractors/adapters/`:

```ts
import type { SiteAdapter } from '../../shared/types';

const MySiteAdapter: SiteAdapter = {
  name: 'My Site',
  matches(url: string) {
    return /mysite\.com/.test(url);
  },
  async extract(): Promise<string> {
    const el = document.querySelector('.article-content');
    if (!el) throw new Error('Could not find article content');
    return el.textContent?.trim() ?? '';
  },
};

export default MySiteAdapter;
```

Then register it in `src/extractors/router.ts` (add it before `GenericAdapter` in the array) and rebuild.

## Project Structure

```
review-questions/
├── src/
│   ├── background.ts           # Service worker: orchestrates extraction + proxy calls
│   ├── content.ts              # Content script: runs extractors in page context
│   ├── extractors/
│   │   ├── router.ts           # URL matching + adapter dispatch
│   │   └── adapters/
│   │       ├── youtube.ts      # YouTube transcript extraction (browser-side fallback)
│   │       ├── foreign-affairs.ts
│   │       └── generic.ts      # Readability-based fallback
│   ├── popup/                  # Extension popup UI
│   ├── results/                # Results page (opens in new tab)
│   ├── options/                # Extension settings page
│   └── shared/types.ts         # Interfaces + defaults
├── proxy/
│   ├── cloudflare/             # Cloudflare Worker proxy
│   └── local/                  # Express dev proxy
├── manifest.json               # MV3 extension manifest
├── build.mjs                   # esbuild-based build script
└── package.json
```

## Proxy Endpoints

Both proxy implementations expose:

- `POST /generate` — Takes `{ text, maxQuestions?, showDifficulty? }`, returns `{ questions: string[] }`
- `POST /transcript` — Takes `{ videoId }`, returns `{ text, title }`

The Cloudflare Worker requires a `Bearer <token>` in the `Authorization` header.
