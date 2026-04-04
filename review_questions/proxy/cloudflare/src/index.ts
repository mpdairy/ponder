interface Env {
  ANTHROPIC_API_KEY: string;
  PONDER_PROXY_TOKEN: string; // wrangler secret put PONDER_PROXY_TOKEN
}

const SYSTEM_PROMPT = `You are a review question generator. Given the text content of an article or video transcript, generate open-ended review questions that test comprehension of the key ideas, arguments, and facts presented.

Decide how many questions to generate based on the depth, density, and richness of the content. A short or shallow piece might warrant 3-4 questions; a dense, idea-rich piece might warrant 8-10. Prefer fewer, better questions over many superficial ones.

Rules:
- Questions should be open-ended, not yes/no
- Cover the major themes and arguments, not trivia
- Questions should be answerable purely from the provided content
- Order questions roughly by where the relevant content appears
- Be specific enough that a vague answer wouldn't suffice
- Bold key terms in each question using <b> tags
- Do not include answers

Respond with only the numbered questions, no preamble.`;

const SUMMARY_PROMPT = `You are a concise summarizer. Given the text content of an article or video transcript, write a clear, well-structured summary that captures the key ideas, arguments, and conclusions.

Rules:
- Write in flowing prose paragraphs, not bullet points
- Cover the main arguments and key facts
- Keep it proportional to the source — a short piece gets a short summary, a long one gets a longer summary, but always stay concise
- Do not editorialize or add your own opinions
- Do not mention that you are summarizing — just present the content`;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function corsResponse(body: string | null, status: number, extra?: Record<string, string>) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...extra },
  });
}

function parseQuestions(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(line => line.length > 0);
}

function checkAuth(request: Request, env: Env): Response | null {
  if (!env.PONDER_PROXY_TOKEN) return null;
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token !== env.PONDER_PROXY_TOKEN) {
    return corsResponse(JSON.stringify({ error: 'Invalid or missing token' }), 401);
  }
  return null;
}

async function handleSummarize(request: Request, env: Env): Promise<Response> {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  const { text } = await request.json<any>();
  if (!text) {
    return corsResponse(JSON.stringify({ error: 'Missing "text" field' }), 400);
  }

  const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SUMMARY_PROMPT,
      messages: [{ role: 'user', content: `<content>\n${text}\n</content>` }],
    }),
  });

  if (!apiResp.ok) {
    return corsResponse(JSON.stringify({ error: `Claude API error: ${apiResp.status}` }), 502);
  }

  const data = await apiResp.json<any>();
  return corsResponse(JSON.stringify({ summary: data.content[0].text }), 200);
}

async function handleGenerate(request: Request, env: Env): Promise<Response> {
  const authErr = checkAuth(request, env);
  if (authErr) return authErr;

  const { text, maxQuestions = 10, showDifficulty = false } = await request.json<any>();
  if (!text) {
    return corsResponse(JSON.stringify({ error: 'Missing "text" field' }), 400);
  }

  let prompt = `Generate review questions (no more than ${maxQuestions}) for the following content:\n\n<content>\n${text}\n</content>`;
  if (showDifficulty) {
    prompt += '\n\nAfter each question, add a difficulty hint in parentheses: (Basic), (Intermediate), or (Advanced).';
  }

  const apiResp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!apiResp.ok) {
    const errText = await apiResp.text();
    return corsResponse(JSON.stringify({ error: `Claude API error: ${apiResp.status}` }), 502);
  }

  const data = await apiResp.json<any>();
  const questions = parseQuestions(data.content[0].text);
  return corsResponse(JSON.stringify({ questions }), 200);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
      return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405);
    }

    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case '/generate':
          return await handleGenerate(request, env);
        case '/summarize':
          return await handleSummarize(request, env);
        default:
          return corsResponse(JSON.stringify({ error: 'Not found' }), 404);
      }
    } catch (err: any) {
      return corsResponse(JSON.stringify({ error: err.message || 'Internal error' }), 500);
    }
  },
};
