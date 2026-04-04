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
const summaryBtn = document.getElementById('summary-btn')!;
const summaryLoading = document.getElementById('summary-loading')!;
const summaryError = document.getElementById('summary-error')!;
const summaryContent = document.getElementById('summary-content')!;

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
    // Strip HTML tags except <b>, then convert **markdown bold** to <b>
    const safe = q.replace(/<\/?(?!b\b)[^>]*>/g, '').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    li.innerHTML = safe;
    questionsList.appendChild(li);
  }

  // Hide summary button if no source text available
  if (!result.sourceText) {
    summaryBtn.classList.add('hidden');
  }

  renderSummary(result);
}

function renderSummary(result: StoredResult) {
  if (result.summaryStatus === 'loading') {
    summaryBtn.classList.add('hidden');
    summaryLoading.classList.remove('hidden');
    summaryError.classList.add('hidden');
    summaryContent.classList.add('hidden');
    return;
  }

  if (result.summaryStatus === 'error') {
    summaryBtn.classList.remove('hidden');
    summaryBtn.disabled = false;
    summaryLoading.classList.add('hidden');
    summaryError.classList.remove('hidden');
    summaryError.textContent = result.summaryError || 'Summary generation failed';
    summaryContent.classList.add('hidden');
    return;
  }

  if (result.summaryStatus === 'done' && result.summary) {
    summaryBtn.classList.add('hidden');
    summaryLoading.classList.add('hidden');
    summaryError.classList.add('hidden');
    summaryContent.classList.remove('hidden');
    summaryContent.textContent = result.summary;
    return;
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

  // Watch for updates (loading → done, or summary updates)
  chrome.storage.local.onChanged.addListener((changes) => {
    if (changes.latestResult?.newValue) {
      const updated = changes.latestResult.newValue as StoredResult;
      renderResult(updated);
      if (updated.status === 'done') setupCopy(updated);
    }
  });

  // Summary button
  summaryBtn.addEventListener('click', async () => {
    summaryBtn.disabled = true;
    summaryLoading.classList.remove('hidden');
    summaryBtn.classList.add('hidden');
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'GENERATE_SUMMARY' });
      if (resp?.error) throw new Error(resp.error);
    } catch (err: any) {
      summaryLoading.classList.add('hidden');
      summaryBtn.classList.remove('hidden');
      summaryBtn.disabled = false;
      summaryError.classList.remove('hidden');
      summaryError.textContent = err.message || 'Something went wrong';
    }
  });
}

init();
