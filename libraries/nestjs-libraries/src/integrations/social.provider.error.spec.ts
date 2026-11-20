import {
  BadBody,
  buildRunInConcurrentHandleErrorsInput,
  extractHttpErrorBody,
  extractHttpErrorStatus,
  PROVIDER_ERROR_BODY_LOG_LIMIT,
  redactProviderErrorBody,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { TumblrProvider } from '@gitroom/nestjs-libraries/integrations/social/tumblr.provider';

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

  it.each([
    [
      '{"authorization":"Bearer secret-token.example","detail":"credits depleted"}',
      'secret-token.example',
    ],
    ['oauth_token=oauth-value.test&oauth_token_secret=oauth-secret.test', 'oauth-value.test'],
    ['access_token=plain-access.test&foo=bar', 'plain-access.test'],
    ['{"token":"json-token.test","consumer_key":"consumer-key.test"}', 'json-token.test'],
  ])('redacts sensitive values (%#)', (raw, leaked) => {
    const redacted = redactProviderErrorBody(raw);
    expect(redacted).not.toContain(leaked);
    expect(redacted).toContain('[REDACTED]');
  });

  it('caps redacted log size', () => {
    const longBody = 'x'.repeat(PROVIDER_ERROR_BODY_LOG_LIMIT + 50);
    expect(redactProviderErrorBody(longBody)).toContain('… [truncated]');
  });
});

describe('buildRunInConcurrentHandleErrorsInput', () => {
  const twitterErr = {
    code: 402,
    message: 'Request failed',
    data: { detail: 'credits depleted', status: 402 },
  };

  it('keeps safeStringify(err) and status 200 for non-X providers', () => {
    const { body, status } = buildRunInConcurrentHandleErrorsInput(
      twitterErr,
      'youtube'
    );

    expect(status).toBe(200);
    expect(body).toContain('Request failed');
    expect(body).toContain('credits depleted');
  });

  it('passes real HTTP status only for the X provider', () => {
    expect(buildRunInConcurrentHandleErrorsInput(twitterErr, 'x').status).toBe(
      402
    );
    expect(
      buildRunInConcurrentHandleErrorsInput(twitterErr, 'tumblr').status
    ).toBe(200);
  });

  it('appends extracted API payload for X when it is not already in the stringified error', () => {
    const err = {
      code: 402,
      message: 'wrapper',
      data: { detail: 'credits depleted' },
    };
    const { body } = buildRunInConcurrentHandleErrorsInput(err, 'x');
    expect(body).toContain('wrapper');
    expect(body).toContain('credits depleted');
  });
});

class XStatusPassThroughProvider extends SocialAbstract {
  identifier = 'x';
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

class NonXMessageProvider extends SocialAbstract {
  identifier = 'youtube';
  captured: { body: string; status: number }[] = [];

  override handleErrors(body: string, status: number) {
    this.captured.push({ body, status });
    if (body.includes('invalidTags')) {
      return { type: 'bad-body' as const, value: 'tags invalid' };
    }

    return undefined;
  }
}

describe('SocialAbstract.runInConcurrent', () => {
  it('passes real HTTP status into handleErrors for X', async () => {
    const provider = new XStatusPassThroughProvider();

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

  it('keeps stringified errors and status 200 for other providers', async () => {
    const provider = new NonXMessageProvider();

    await expect(
      provider.runInConcurrent(async () => {
        throw {
          code: 429,
          message: 'invalidTags in request',
          data: { detail: 'rate limited' },
        };
      })
    ).rejects.toBeInstanceOf(BadBody);

    expect(provider.captured[0].status).toBe(200);
    expect(provider.captured[0].body).toContain('invalidTags in request');
  });

  it('does not change Tumblr handleErrors outcome for rate-limit errors in runInConcurrent', () => {
    const tumblr = new TumblrProvider();
    const err = {
      code: 429,
      message: 'rate limited',
      data: { errors: [] as string[] },
    };
    const legacy = tumblr.handleErrors(
      JSON.stringify(err),
      200
    )?.type;
    const concurrent = tumblr.handleErrors(
      buildRunInConcurrentHandleErrorsInput(err, 'tumblr').body,
      buildRunInConcurrentHandleErrorsInput(err, 'tumblr').status
    )?.type;

    expect(legacy).toBe(concurrent);
    expect(legacy).toBeUndefined();
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