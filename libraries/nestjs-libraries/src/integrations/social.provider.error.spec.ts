import {
  BadBody,
  extractHttpErrorBody,
  extractHttpErrorStatus,
  PROVIDER_ERROR_BODY_LOG_LIMIT,
  redactProviderErrorBody,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';

describe('provider HTTP error helpers', () => {
  it('extracts status from twitter-api-v2 style errors', () => {
    expect(extractHttpErrorStatus({ code: 402 })).toBe(402);
    expect(extractHttpErrorStatus({ status: 401 })).toBe(401);
    expect(extractHttpErrorStatus({ response: { status: 429 } })).toBe(429);
  });

  it('returns undefined when no HTTP status is present', () => {
    expect(extractHttpErrorStatus({ message: 'network down' })).toBeUndefined();
  });

  it('extracts JSON error bodies from ApiResponseError-like objects', () => {
    const body = extractHttpErrorBody({
      code: 402,
      data: {
        detail: 'credits depleted',
        status: 402,
        title: 'Payment Required',
        type: 'https://api.x.test/2/problems/credits-depleted',
      },
    });

    expect(body).toContain('credits depleted');
    expect(body).toContain('402');
  });

  it('redacts bearer tokens and caps log size', () => {
    const raw =
      '{"authorization":"Bearer secret-token.example","detail":"credits depleted"}';
    const redacted = redactProviderErrorBody(raw);
    expect(redacted).not.toContain('secret-token.example');
    expect(redacted).toContain('[REDACTED]');

    const longBody = 'x'.repeat(PROVIDER_ERROR_BODY_LOG_LIMIT + 50);
    expect(redactProviderErrorBody(longBody)).toContain('… [truncated]');
  });
});

class StatusPassThroughProvider extends SocialAbstract {
  identifier = 'test';
  captured: { body: string; status: number }[] = [];

  override handleErrors(body: string, status: number) {
    this.captured.push({ body, status });
    if (status === 402) {
      return {
        type: 'bad-body' as const,
        value: 'mapped credits error',
      };
    }

    return undefined;
  }
}

describe('SocialAbstract.runInConcurrent', () => {
  it('passes real HTTP status into handleErrors', async () => {
    const provider = new StatusPassThroughProvider();

    await expect(
      provider.runInConcurrent(async () => {
        throw {
          code: 402,
          data: {
            detail: 'credits depleted',
            status: 402,
            title: 'Payment Required',
          },
        };
      })
    ).rejects.toBeInstanceOf(BadBody);

    expect(provider.captured).toEqual([
      {
        body: expect.stringContaining('credits depleted'),
        status: 402,
      },
    ]);
  });

  it('defaults to status 200 when the thrown error has no status', async () => {
    const provider = new StatusPassThroughProvider();

    await expect(
      provider.runInConcurrent(async () => {
        throw new Error('unexpected');
      })
    ).rejects.toBeInstanceOf(BadBody);

    expect(provider.captured[0].status).toBe(200);
  });
});

class XLogProvider extends SocialAbstract {
  identifier = 'x';

  override handleErrors(): undefined {
    return undefined;
  }
}

describe('X provider error logging', () => {
  it('logs redacted API errors for the X provider', async () => {
    const provider = new XLogProvider();
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      provider.runInConcurrent(async () => {
        throw {
          code: 402,
          data: { authorization: 'Bearer secret-token.example.test' },
        };
      })
    ).rejects.toBeInstanceOf(BadBody);

    const logged = logSpy.mock.calls[0][0] as string;
    expect(logged).toContain('X API error (status 402):');
    expect(logged).not.toContain('secret-token.example.test');

    logSpy.mockRestore();
  });
});