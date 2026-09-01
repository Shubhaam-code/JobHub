import { describe, expect, it } from 'vitest';

import { parseEnv } from '../src/config/env.js';

describe('parseEnv', () => {
  it('falls back to development defaults', () => {
    const env = parseEnv({});

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(4000);
    expect(env.MONGODB_URI).toBe('mongodb://127.0.0.1:27017/job_aggregator');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.corsOrigins).toEqual([
      'http://localhost:3000',
      'https://job-hub-web-ochre.vercel.app',
    ]);
    expect(env.isDevelopment).toBe(true);
    expect(env.isProduction).toBe(false);
    expect(env.isTest).toBe(false);
  });

  it('coerces PORT into a number', () => {
    expect(parseEnv({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('splits and trims CORS_ORIGINS into a list', () => {
    const env = parseEnv({ CORS_ORIGINS: 'http://a.test, http://b.test ,' });

    expect(env.corsOrigins).toEqual(['http://a.test', 'http://b.test']);
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
