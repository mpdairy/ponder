import type { StoredResult } from '../shared/types';

const titleEl = document.getElementById('title')!;
const sourceEl = document.getElementById('source')!;
const loadingEl = document.getElementById('loading')!;
const errorEl = document.getElementById('error')!;
const errorMsg = document.getElementById('error-message')!;
const resultsEl = document.getElementById('results')!;
const questionsList = document.getElementById('questions-list')!;
const adapterBadge = document.getElementById('adapter-badge')!;
const copyBtn = document.getElementById('copy-btn')!;

function renderResult(result: StoredResult) {
  if (result.title) {
    titleEl.textContent = result.title;
    document.title = `Review Questions — ${result.title}`;
  }

  if (result.url) {
    sourceEl.textContent = result.url;
    sourceEl.title = result.url;
  }

  if (result.status === 'loading') {
    loadingEl.classList.remove('hidden');
    errorEl.classList.add('hidden');
    resultsEl.classList.add('hidden');
    return;
  }

  loadingEl.classList.add('hidden');

  if (result.status === 'error') {
    errorEl.classList.remove('hidden');
    resultsEl.classList.add('hidden');
    errorMsg.textContent = result.error || 'Something went wrong.';
    return;
  }

  // status === 'done'
  errorEl.classList.add('hidden');
  resultsEl.classList.remove('hidden');

  if (result.adapterName) {
    adapterBadge.textContent = result.adapterName;
  }

  questionsList.innerHTML = '';
  for (const q of result.questions || []) {
    const li = document.createElement('li');
    li.textContent = q.replace(/<[^>]*>/g, '');
    questionsList.appendChild(li);
  }
}

function setupCopy(result: StoredResult) {
  copyBtn.addEventListener('click', () => {
    const text = (result.questions || [])
      .map((q, i) => `${i + 1}. ${q.replace(/<[^>]*>/g, '')}`)
      .join('\n');
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy All'; }, 1500);
    });
  });
}

// Load result from storage
async function init() {
  const { latestResult } = await chrome.storage.local.get('latestResult');
  if (!latestResult) {
    errorEl.classList.remove('hidden');
    loadingEl.classList.add('hidden');
    errorMsg.textContent = 'No results found. Generate questions from a page first.';
    return;
  }

  renderResult(latestResult);
  if (latestResult.status === 'done') {
    setupCopy(latestResult);
  }

  // If still loading, watch for updates
  if (latestResult.status === 'loading') {
    chrome.storage.local.onChanged.addListener((changes) => {
      if (changes.latestResult?.newValue) {
        const updated = changes.latestResult.newValue as StoredResult;
        renderResult(updated);
        if (updated.status === 'done') setupCopy(updated);
      }
    });
  }
}

init();
