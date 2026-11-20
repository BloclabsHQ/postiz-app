import { XProvider } from '@gitroom/nestjs-libraries/integrations/social/x.provider';

describe('XProvider.handleErrors', () => {
  const provider = new XProvider();

  it('keeps existing message-based mappings', () => {
    expect(
      provider.handleErrors('{"errors":[{"message":"Too Many Requests"}]}', 429)
        ?.value
    ).toBe('X rate limit reached, please try again later');
  });

  it.each([
    [
      402,
      '{"detail":"credits depleted","status":402}',
      'bad-body',
      'x api credits are depleted',
    ],
    [
      401,
      '{}',
      'refresh-token',
      'reconnect your x channel',
    ],
    [
      403,
      '{"detail":"forbidden"}',
      'bad-body',
      'missing permission',
    ],
    [
      429,
      '{}',
      'retry',
      'rate limit reached',
    ],
    [
      413,
      '{}',
      'bad-body',
      'too large',
    ],
  ] as const)(
    'maps HTTP %i to a user-facing %s message',
    (status, body, type, fragment) => {
      const result = provider.handleErrors(body, status);
      expect(result?.type).toBe(type);
      expect(result?.value.toLowerCase()).toContain(fragment);
    }
  );

  it('maps invalid media type bodies', () => {
    const result = provider.handleErrors(
      '{"errors":[{"message":"InvalidMediaType for upload"}]}',
      400
    );
    expect(result?.type).toBe('bad-body');
    expect(result?.value).toContain('media type');
  });

  it('returns undefined for unmapped errors', () => {
    expect(
      provider.handleErrors('{"detail":"example.test failure"}', 500)
    ).toBeUndefined();
  });
});