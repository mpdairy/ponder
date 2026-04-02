import { detectAdapter, extractContent } from './extractors/router';
import type { ExtMessage, DetectResponse, ExtractResponse } from './shared/types';

chrome.runtime.onMessage.addListener(
  (message: ExtMessage, _sender, sendResponse: (resp: any) => void) => {
    if (message.type === 'DETECT_CONTENT') {
      const adapter = detectAdapter(window.location.href);
      const resp: DetectResponse = { adapterName: adapter.name };
      sendResponse(resp);
      return false; // synchronous
    }

    if (message.type === 'EXTRACT_CONTENT') {
      extractContent(window.location.href)
        .then(({ text, adapterName }) => {
          const resp: ExtractResponse = {
            text,
            adapterName,
            title: document.title,
          };
          sendResponse(resp);
        })
        .catch(err => {
          sendResponse({ error: err.message || 'Extraction failed' });
        });
      return true; // async response
    }

    return false;
  }
);
