import { describe, expect, it } from 'vitest';

import { redactUri } from '../src/config/database.js';

describe('redactUri', () => {
  it('masks the password in a credentialed URI', () => {
    expect(redactUri('mongodb+srv://admin:s3cret@cluster.example.test/jobs')).toBe(
      'mongodb+srv://admin:***@cluster.example.test/jobs',
    );
  });

  it('leaves a credential-free URI untouched', () => {
    const uri = 'mongodb://127.0.0.1:27017/job_aggregator';

    expect(redactUri(uri)).toBe(uri);
  });
});
