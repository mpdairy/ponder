import { Readability } from '@mozilla/readability';
import type { SiteAdapter } from '../../shared/types';

function extractWithReadability(): string | null {
  const clone = document.cloneNode(true) as Document;
  const article = new Readability(clone).parse();
  return article?.textContent?.trim() || null;
}

function extractLargestArticle(): string | null {
  // Try <article> element first
  const articles = document.querySelectorAll('article');
  if (articles.length > 0) {
    let best: Element | null = null;
    let bestLen = 0;
    for (const el of articles) {
      const len = el.textContent?.length ?? 0;
      if (len > bestLen) { best = el; bestLen = len; }
    }
    if (best) return best.textContent?.trim() || null;
  }

  // Fall back to element with most <p> children
  const allElements = document.querySelectorAll('main, [role="main"], .content, .post, .entry');
  let best: Element | null = null;
  let bestCount = 0;
  for (const el of allElements) {
    const count = el.querySelectorAll('p').length;
    if (count > bestCount) { best = el; bestCount = count; }
  }

  return best?.textContent?.trim() || null;
}

const GenericAdapter: SiteAdapter = {
  name: 'Article',

  matches() {
    return true; // fallback — always matches
  },

  async extract(): Promise<string> {
    const readabilityText = extractWithReadability();
    if (readabilityText && readabilityText.length > 100) return readabilityText;

    const articleText = extractLargestArticle();
    if (articleText && articleText.length > 100) return articleText;

    // Last resort: grab body text
    const body = document.body.innerText?.trim();
    if (body && body.length > 100) return body;

    throw new Error('Could not extract meaningful content from this page.');
  },
};

export default GenericAdapter;
