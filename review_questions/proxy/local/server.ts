import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { YoutubeTranscript } from 'youtube-transcript';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

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

function parseQuestions(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(line => line.length > 0);
}

const DEBUG = process.env.DEBUG === '1';

// ---------------------------------------------------------------------------
// YouTube transcript extraction (server-side via youtube-transcript)
// ---------------------------------------------------------------------------

app.post('/transcript', async (req, res) => {
  try {
    const { videoId } = req.body;
    if (!videoId) {
      res.status(400).json({ error: 'Missing "videoId" field' });
      return;
    }

    console.log(`Fetching transcript for video: ${videoId}`);
    const segments = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
    const text = segments.map(s => s.text).join(' ').replace(/\s+/g, ' ').trim();

    if (!text) throw new Error('Transcript returned empty');

    // Get video title from YouTube page
    let title = 'YouTube Video';
    try {
      const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const html = await pageResp.text();
      const titleMatch = html.match(/<title>(.+?)<\/title>/);
      if (titleMatch) title = titleMatch[1].replace(/ - YouTube$/, '');
    } catch {}

    console.log(`Transcript: ${text.length} chars, title: ${title}`);
    if (DEBUG) {
      console.log(`\n--- TRANSCRIPT ${text.length} chars ---`);
      console.log(text.substring(0, 500));
      console.log(`--- END ---\n`);
    }

    res.json({ text, title });
  } catch (err: any) {
    console.error('Transcript error:', err.message);
    res.status(500).json({ error: err.message || 'Transcript extraction failed' });
  }
});

app.post('/generate', async (req, res) => {
  try {
    const { text, maxQuestions = 10, showDifficulty = false } = req.body;

    if (!text) {
      res.status(400).json({ error: 'Missing "text" field' });
      return;
    }

    // Debug mode: echo back the extracted text instead of calling Claude
    if (DEBUG) {
      console.log(`\n--- RECEIVED ${text.length} chars ---`);
      console.log(text.substring(0, 2000));
      console.log(`--- END (${text.length} total) ---\n`);
      res.json({
        questions: [
          `[DEBUG] Received ${text.length} chars of text.`,
          `[DEBUG] First 300 chars: ${text.substring(0, 300)}`,
          `[DEBUG] Last 300 chars: ${text.substring(Math.max(0, text.length - 300))}`,
        ],
      });
      return;
    }

    let prompt = `Generate review questions (no more than ${maxQuestions}) for the following content:\n\n<content>\n${text}\n</content>`;
    if (showDifficulty) {
      prompt += '\n\nAfter each question, add a difficulty hint in parentheses: (Basic), (Intermediate), or (Advanced).';
    }

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const content = message.content[0];
    if (content.type !== 'text') {
      res.status(500).json({ error: 'Unexpected response type from Claude' });
      return;
    }

    const questions = parseQuestions(content.text);
    res.json({ questions });
  } catch (err: any) {
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});

const PORT = parseInt(process.env.PORT || '8787', 10);
app.listen(PORT, () => {
  console.log(`Review Questions proxy running on http://localhost:${PORT}`);
});
