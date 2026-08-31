/**
 * Resume parsing over Groq: the wire request, and every failure mode the upload
 * route depends on.
 *
 * `fetch` is stubbed rather than mocking the client, so these tests also prove
 * the negative the switch was about: the only host this path talks to is Groq.
 * A regression that reintroduced Gemini would show up as a second URL here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { env } from '../src/config/env.js';
import { parseResume } from '../src/resume/resume-parser.js';

const RESUME_TEXT = [
  'Aarav Sharma — Bengaluru, India',
  'SKILLS: Java, Spring Boot, MongoDB, REST APIs, Git',
  'EXPERIENCE: Backend Developer Intern, 6 months',
  'EDUCATION: B.Tech, expected graduation 2026',
  'OBJECTIVE: Seeking a backend developer internship in Bengaluru.',
].join('\n');

/** What the model returns for RESUME_TEXT when everything goes right. */
const MODEL_OUTPUT = {
  skills: ['Java', 'Spring Boot', 'MongoDB', 'Git'],
  preferredRoles: ['Backend Developer'],
  preferredLocations: ['Bengaluru'],
  preferredJobTypes: ['internship'],
  experienceYears: 0.5,
  graduationYear: '2026',
};

/** A Groq chat-completions success carrying `content` as the assistant message. */
function groqOk(content: unknown): Response {
  const body = typeof content === 'string' ? content : JSON.stringify(content);
  return new Response(JSON.stringify({ choices: [{ message: { content: body } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function groqError(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

let fetchMock: ReturnType<typeof vi.fn>;
const originalKey = env.GROQ_API_KEY;
const originalModel = env.GROQ_MODEL;

beforeEach(() => {
  env.GROQ_API_KEY = 'test-groq-key';
  env.GROQ_MODEL = 'openai/gpt-oss-20b';
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  env.GROQ_API_KEY = originalKey;
  env.GROQ_MODEL = originalModel;
});

/** The parsed JSON body of the nth fetch call. */
function requestBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

describe('parseResume — Groq request', () => {
  it('calls Groq, and only Groq', async () => {
    fetchMock.mockResolvedValue(groqOk(MODEL_OUTPUT));

    await parseResume(RESUME_TEXT);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual(['https://api.groq.com/openai/v1/chat/completions']);
    // The provider that used to own this path must not be contacted at all.
    expect(urls.some((url) => /googleapis|generativelanguage|gemini/i.test(url))).toBe(false);
  });

  it('sends the key as a bearer token, in the header and nowhere else', async () => {
    fetchMock.mockResolvedValue(groqOk(MODEL_OUTPUT));

    await parseResume(RESUME_TEXT);

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;

    expect(headers['authorization']).toBe('Bearer test-groq-key');
    // A key in the body would end up in provider logs and error strings.
    expect(String(init.body)).not.toContain('test-groq-key');
  });

  it('asks for schema-constrained JSON so the shape cannot drift', async () => {
    fetchMock.mockResolvedValue(groqOk(MODEL_OUTPUT));

    await parseResume(RESUME_TEXT);

    const body = requestBody();
    const responseFormat = body['response_format'] as {
      type: string;
      json_schema: { strict: boolean; schema: { required: string[]; additionalProperties: boolean } };
    };

    expect(body['model']).toBe('openai/gpt-oss-20b');
    expect(body['temperature']).toBe(0);
    expect(responseFormat.type).toBe('json_schema');
    expect(responseFormat.json_schema.strict).toBe(true);
    expect(responseFormat.json_schema.schema.additionalProperties).toBe(false);
    // Unchanged output contract: the six fields `scoreJob` matches on.
    expect(responseFormat.json_schema.schema.required).toEqual([
      'skills',
      'preferredRoles',
      'preferredLocations',
      'preferredJobTypes',
      'experienceYears',
      'graduationYear',
    ]);
  });

  it('sends the resume text as the user message', async () => {
    fetchMock.mockResolvedValue(groqOk(MODEL_OUTPUT));

    await parseResume(RESUME_TEXT);

    const messages = requestBody()['messages'] as Array<{ role: string; content: string }>;

    expect(messages.map((message) => message.role)).toEqual(['system', 'user']);
    expect(messages[1]?.content).toContain('Spring Boot');
  });

  it('keeps reasoning minimal on gpt-oss, and omits the field on other models', async () => {
    fetchMock.mockResolvedValue(groqOk(MODEL_OUTPUT));
    await parseResume(RESUME_TEXT);
    expect(requestBody()['reasoning_effort']).toBe('low');

    // A model that rejects the field must not be sent it.
    env.GROQ_MODEL = 'llama-3.3-70b-versatile';
    await parseResume(RESUME_TEXT);
    expect(requestBody(1)).not.toHaveProperty('reasoning_effort');
  });
});

describe('parseResume — Groq output', () => {
  it('returns the profile the matcher scores against', async () => {
    fetchMock.mockResolvedValue(groqOk(MODEL_OUTPUT));

    const result = await parseResume(RESUME_TEXT);

    expect(result).toEqual({
      ok: true,
      profile: {
        skills: ['Java', 'Spring Boot', 'MongoDB', 'Git'],
        preferredRoles: ['Backend Developer'],
        preferredLocations: ['Bengaluru'],
        preferredJobTypes: ['internship'],
        experienceYears: 0.5,
        graduationYear: '2026',
      },
    });
  });

  it('still drops a hallucinated skill — grounding is not the provider job', async () => {
    fetchMock.mockResolvedValue(
      groqOk({ ...MODEL_OUTPUT, skills: ['Java', 'Kubernetes', 'Kafka'] }),
    );

    const result = await parseResume(RESUME_TEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.skills).toEqual(['Java']);
  });

  it('tolerates a fenced JSON body', async () => {
    fetchMock.mockResolvedValue(groqOk(`\`\`\`json\n${JSON.stringify(MODEL_OUTPUT)}\n\`\`\``));

    const result = await parseResume(RESUME_TEXT);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.profile.skills).toContain('Java');
  });

  it('fails cleanly on unparseable output rather than storing it', async () => {
    fetchMock.mockResolvedValue(groqOk('not json at all'));

    const result = await parseResume(RESUME_TEXT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/could not be analysed/i);
  });
});

describe('parseResume — Groq failures', () => {
  it('reports a rate limit as retry-later instead of failing outright', async () => {
    fetchMock.mockResolvedValue(
      groqError(429, '{"error":{"message":"rate limit"}}', { 'retry-after': '30' }),
    );

    const result = await parseResume(RESUME_TEXT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.rateLimited).toBe(true);
    expect(result.retryAfterMs).toBe(31_000);
    expect(result.reason).toMatch(/busy right now/i);
    // A 429 is handed back, not slept through: the user is waiting on a response.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not retry a bad request, and never leaks the provider text to the user', async () => {
    fetchMock.mockResolvedValue(groqError(400, '{"error":{"message":"model_decommissioned"}}'));

    const result = await parseResume(RESUME_TEXT);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/could not be analysed/i);
    expect(result.reason).not.toContain('model_decommissioned');
  });

  it('retries once when Groq is briefly down, and succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(groqError(503, 'upstream unavailable'))
      .mockResolvedValueOnce(groqOk(MODEL_OUTPUT));

    const result = await parseResume(RESUME_TEXT);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it('surfaces the error state when the network call throws', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'));

    const result = await parseResume(RESUME_TEXT);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/could not be analysed/i);
  });

  it('says parsing is unavailable when no key is configured, without calling out', async () => {
    env.GROQ_API_KEY = undefined;

    const result = await parseResume(RESUME_TEXT);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/unavailable/i);
  });
});
