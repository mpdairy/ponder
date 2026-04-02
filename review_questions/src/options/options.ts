import type { ExtensionOptions } from '../shared/types';
import { DEFAULT_OPTIONS } from '../shared/types';

const proxyUrlInput = document.getElementById('proxy-url') as HTMLInputElement;
const proxyTokenInput = document.getElementById('proxy-token') as HTMLInputElement;
const maxQuestionsInput = document.getElementById('question-count') as HTMLInputElement;
const countDisplay = document.getElementById('count-display')!;
const showDifficultyInput = document.getElementById('show-difficulty') as HTMLInputElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const statusEl = document.getElementById('status')!;

function originPatternFromUrl(rawUrl: string): string {
  const { origin } = new URL(rawUrl);
  return `${origin}/*`;
}

async function ensureProxyPermission(proxyUrl: string): Promise<void> {
  const originPattern = originPatternFromUrl(proxyUrl);
  const alreadyGranted = await chrome.permissions.contains({ origins: [originPattern] });
  if (alreadyGranted) return;

  const granted = await chrome.permissions.request({ origins: [originPattern] });
  if (!granted) {
    throw new Error(`Host permission denied for ${originPattern}`);
  }
}

// Load saved options
async function load() {
  const opts = await chrome.storage.sync.get(DEFAULT_OPTIONS) as ExtensionOptions;
  proxyUrlInput.value = opts.proxyUrl;
  proxyTokenInput.value = opts.proxyToken;
  maxQuestionsInput.value = String(opts.maxQuestions);
  countDisplay.textContent = String(opts.maxQuestions);
  showDifficultyInput.checked = opts.showDifficulty;
}

maxQuestionsInput.addEventListener('input', () => {
  countDisplay.textContent = maxQuestionsInput.value;
});

saveBtn.addEventListener('click', async () => {
  try {
    const opts: ExtensionOptions = {
      proxyUrl: proxyUrlInput.value.replace(/\/+$/, ''), // strip trailing slash
      proxyToken: proxyTokenInput.value.trim(),
      maxQuestions: parseInt(maxQuestionsInput.value, 10),
      showDifficulty: showDifficultyInput.checked,
    };

    await ensureProxyPermission(opts.proxyUrl);
    await chrome.storage.sync.set(opts);
    statusEl.textContent = 'Saved';
    statusEl.classList.remove('hidden');
    setTimeout(() => statusEl.classList.add('hidden'), 1500);
  } catch (error) {
    statusEl.textContent = error instanceof Error ? error.message : 'Could not save options';
    statusEl.classList.remove('hidden');
  }
});

load();
