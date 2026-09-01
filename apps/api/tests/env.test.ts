import { describe, expect, it } from 'vitest';

import { parseEnv } from '../src/config/env.js';

const BUILT_IN_ORIGINS = [
  'http://localhost:3000',
  'https://job-hub-web-ochre.vercel.app',
  'https://jobhub-jubu-web.onrender.com',
];

describe('parseEnv', () => {
  it('falls back to development defaults', () => {
    const env = parseEnv({});

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.MONGODB_URI).toBe('mongodb://127.0.0.1:27017/job_aggregator');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.corsOrigins).toEqual(BUILT_IN_ORIGINS);
    expect(env.isDevelopment).toBe(true);
    expect(env.isProduction).toBe(false);
    expect(env.isTest).toBe(false);
  });

  it('coerces PORT into a number', () => {
    expect(parseEnv({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('splits and trims CORS_ORIGINS, adding them to the built-in origins', () => {
    const env = parseEnv({ CORS_ORIGINS: 'http://a.test, http://b.test ,' });

    expect(env.corsOrigins).toEqual([...BUILT_IN_ORIGINS, 'http://a.test', 'http://b.test']);
  });

  it('strips a trailing slash, which no Origin header ever carries', () => {
    const env = parseEnv({ CORS_ORIGINS: 'https://preview.test/' });

    expect(env.corsOrigins).toContain('https://preview.test');
  });

  /* The regression this guards: CORS_ORIGINS used to replace the built-in list,
     so a deployment whose value omitted the live frontend served every browser a
     response with no `Access-Control-Allow-Origin`. The site emptied out while the
     API logged nothing but successful requests. */
  it.each([
    ['a value that omits the deployed frontend', 'https://somewhere-else.test'],
    ['an empty value', ''],
    ['a value that is nothing but separators', ' , ,'],
  ])('keeps the deployed frontend allowed given %s', (_case, CORS_ORIGINS) => {
    expect(parseEnv({ CORS_ORIGINS }).corsOrigins).toEqual(
      expect.arrayContaining(BUILT_IN_ORIGINS),
    );
  });

  it('never lists an origin twice, even when CORS_ORIGINS repeats a built-in one', () => {
    const origins = parseEnv({
      CORS_ORIGINS: 'https://job-hub-web-ochre.vercel.app/',
    }).corsOrigins;

    expect(origins).toEqual([...new Set(origins)]);
  });

  it('accepts a mongodb+srv connection string', () => {
    const uri = 'mongodb+srv://user:pass@cluster.example.test/jobs';

    expect(parseEnv({ MONGODB_URI: uri }).MONGODB_URI).toBe(uri);
  });

  it('rejects a non-numeric PORT', () => {
    expect(() => parseEnv({ PORT: 'not-a-port' })).toThrow(/PORT/);
  });

  it('rejects a connection string that is not MongoDB', () => {
    expect(() => parseEnv({ MONGODB_URI: 'postgres://localhost:5432/jobs' })).toThrow(/mongodb/);
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => parseEnv({ NODE_ENV: 'staging' })).toThrow(/NODE_ENV/);
  });

  it('leaves Telegram credentials undefined when absent or blank', () => {
    const env = parseEnv({ TELEGRAM_API_ID: '', TELEGRAM_API_HASH: '  ', TELEGRAM_SESSION: '' });

    expect(env.TELEGRAM_API_ID).toBeUndefined();
    expect(env.TELEGRAM_API_HASH).toBeUndefined();
    expect(env.TELEGRAM_SESSION).toBeUndefined();
  });

  it('parses Telegram credentials when present', () => {
    const env = parseEnv({
      TELEGRAM_API_ID: ' 1234567 ',
      TELEGRAM_API_HASH: '0123456789abcdef0123456789ABCDEF',
      TELEGRAM_SESSION: '1BQANOTEuMTA4LjU2LjE3MAG4',
    });

    expect(env.TELEGRAM_API_ID).toBe(1234567);
    expect(env.TELEGRAM_API_HASH).toBe('0123456789abcdef0123456789ABCDEF');
    expect(env.TELEGRAM_SESSION).toBe('1BQANOTEuMTA4LjU2LjE3MAG4');
  });

  it('rejects a non-numeric TELEGRAM_API_ID', () => {
    expect(() => parseEnv({ TELEGRAM_API_ID: 'abc123' })).toThrow(/TELEGRAM_API_ID/);
  });

  it('rejects a TELEGRAM_API_HASH that is not 32 hex characters', () => {
    expect(() => parseEnv({ TELEGRAM_API_HASH: 'too-short' })).toThrow(/TELEGRAM_API_HASH/);
  });
});
