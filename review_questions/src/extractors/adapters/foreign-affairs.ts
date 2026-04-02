import type { SiteAdapter } from '../../shared/types';

const SELECTORS = [
  '[data-body-content]',
  '.article-body',
  'article .article-body-text',
  'article',
];

function stripNoise(container: Element): string {
  // Clone so we don't modify the actual page
  const clone = container.cloneNode(true) as Element;

  // Remove known noise elements
  const noiseSelectors = [
    '.author-bio', '.article-author', '.byline',
    '.related-articles', '.article-footer',
    '.subscription-cta', '.paywall-prompt',
    'figure', 'figcaption',
    '[role="complementary"]', 'aside',
    'nav', '.social-share',
  ];
  for (const sel of noiseSelectors) {
    clone.querySelectorAll(sel).forEach(el => el.remove());
  }

  // Extract paragraph text
  const paragraphs = clone.querySelectorAll('p');
  if (paragraphs.length > 0) {
    return Array.from(paragraphs)
      .map(p => p.textContent?.trim() || '')
      .filter(text => text.length > 20) // skip short fragments
      .join('\n\n');
  }

  return clone.textContent?.trim() || '';
}

const ForeignAffairsAdapter: SiteAdapter = {
  name: 'Foreign Affairs Article',

  matches(url: string) {
    return /foreignaffairs\.com/.test(url);
  },

  async extract(): Promise<string> {
    for (const selector of SELECTORS) {
      const el = document.querySelector(selector);
      if (el) {
        const text = stripNoise(el);
        if (text.length > 100) return text;
      }
    }
    throw new Error('Could not find article content on this Foreign Affairs page.');
  },
};

export default ForeignAffairsAdapter;
