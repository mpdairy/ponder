import type { DetectResponse, ExtensionOptions } from '../shared/types';
import { DEFAULT_OPTIONS } from '../shared/types';

const detectedEl = document.getElementById('detected')!;
const hintEl = document.getElementById('hint')!;
const generateBtn = document.getElementById('generate') as HTMLButtonElement;
const statusEl = document.getElementById('status')!;
const maxQSlider = document.getElementById('max-q') as HTMLInputElement;
const maxQDisplay = document.getElementById('max-q-display')!;

// Load saved maxQuestions
chrome.storage.sync.get(DEFAULT_OPTIONS).then((opts) => {
  const o = opts as ExtensionOptions;
  maxQSlider.value = String(o.maxQuestions);
  maxQDisplay.textContent = String(o.maxQuestions);
});

maxQSlider.addEventListener('input', () => {
  maxQDisplay.textContent = maxQSlider.value;
  chrome.storage.sync.set({ maxQuestions: parseInt(maxQSlider.value, 10) });
});

// Detect what kind of content is on the active tab
async function detect() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      detectedEl.textContent = 'No active tab';
      return;
    }

    // Check for highlighted text first
    let hasSelection = false;
    try {
      const [selResult] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection()?.toString()?.trim() || '',
      });
      const sel = selResult?.result || '';
      if (sel.length > 50) {
        detectedEl.textContent = `Selected text (${sel.length} chars)`;
        generateBtn.disabled = false;
        hasSelection = true;
        return;
      }
    } catch {}

    // YouTube is handled server-side — detect by URL
    if (/youtube\.com\/watch/.test(tab.url || '')) {
      detectedEl.textContent = 'YouTube Video';
      generateBtn.disabled = false;
      return;
    }

    // Try adapter detection via content script
    try {
      const resp: DetectResponse = await chrome.tabs.sendMessage(tab.id, { type: 'DETECT_CONTENT' });
      detectedEl.textContent = resp.adapterName;
      generateBtn.disabled = false;
      return;
    } catch {}

    // No adapter matched and no selection — show hint
    detectedEl.textContent = 'No extractor for this site';
    hintEl.classList.remove('hidden');
  } catch {
    detectedEl.textContent = 'Could not detect content';
    hintEl.classList.remove('hidden');
  }
}

generateBtn.addEventListener('click', async () => {
  generateBtn.disabled = true;
  statusEl.textContent = 'Generating...';
  statusEl.classList.remove('hidden');
  statusEl.classList.remove('error');

  try {
    const resp = await chrome.runtime.sendMessage({ type: 'GENERATE_QUESTIONS' });
    if (resp?.error) throw new Error(resp.error);
  } catch (err: any) {
    statusEl.textContent = err.message || 'Something went wrong';
    statusEl.classList.add('error');
    generateBtn.disabled = false;
  }
});

detect();
