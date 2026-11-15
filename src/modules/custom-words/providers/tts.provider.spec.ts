import { ERROR } from '../../../common/constants/errors';
import { AppConfig } from '../../../config/app-config';
import { Clock } from '../../../common/clock';
import { R2AudioStorage } from './audio-storage';
import { signV4 } from './sigv4';
import { ElevenLabsTtsProvider } from './tts.provider';

const config = {
  elevenLabsApiKey: 'key', elevenLabsVoiceId: 'voice', elevenLabsModelId: 'model',
  r2AccountId: 'acct', r2AccessKeyId: 'AKID', r2SecretAccessKey: 'secret', r2Bucket: 'audio', r2PublicBaseUrl: 'https://cdn.test',
} as AppConfig;

describe('audio providers', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the IPA, in Eleven v4 slash form, and the model to ElevenLabs', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2])));
    await expect(new ElevenLabsTtsProvider(config).synthesizeIpa('rʌn')).resolves.toEqual(Buffer.from([1, 2]));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/text-to-speech/voice');
    expect(init.headers['xi-api-key']).toBe('key');
    expect(JSON.parse(init.body)).toEqual({ text: '"/rʌn/"', model_id: 'model' });
  });

  it.each([
    ['missing config', { ...config, elevenLabsApiKey: undefined } as AppConfig, undefined],
    ['server failure', config, new Response('', { status: 500 })],
    ['quota failure', config, new Response('', { status: 401 })],
  ])('fails as unavailable on %s', async (_, cfg, response) => {
    if (response) fetchMock.mockResolvedValue(response);
    await expect(new ElevenLabsTtsProvider(cfg).synthesizeIpa('rʌn')).rejects.toMatchObject({ status: ERROR.TTS_PROVIDER_UNAVAILABLE.status });
  });

  it('waits and retries when too many requests run at once', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(new Response(new Uint8Array([7])));
    const pending = new ElevenLabsTtsProvider(config).synthesizeIpa('rʌn');
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toEqual(Buffer.from([7]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('passes on the reason ElevenLabs gives', async () => {
    fetchMock.mockResolvedValue(Response.json({ detail: { status: 'payment_required', message: 'Free users cannot use library voices via the API.' } }, { status: 402 }));
    await expect(new ElevenLabsTtsProvider(config).synthesizeIpa('rʌn')).rejects.toThrow('ElevenLabs returned 402: Free users cannot use library voices via the API.');
  });

  it('never calls out without config', async () => {
    await new ElevenLabsTtsProvider({ ...config, elevenLabsVoiceId: undefined } as AppConfig).synthesizeIpa('rʌn').catch(() => undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  const clock = { now: () => new Date('2026-01-02T03:04:05.678Z') } as Clock;

  it('PUTs to R2 with a SigV4 signature and returns the public URL', async () => {
    fetchMock.mockResolvedValue(new Response(''));
    const url = await new R2AudioStorage(config, clock).upload('tts/v/en-US/a b.mp3', Buffer.from([1]));
    expect(url).toBe('https://cdn.test/tts/v/en-US/a%20b.mp3');
    const [target, init] = fetchMock.mock.calls[0];
    expect(String(target)).toBe('https://acct.r2.cloudflarestorage.com/audio/tts/v/en-US/a%20b.mp3');
    expect(init.method).toBe('PUT');
    expect(init.headers['x-amz-date']).toBe('20260102T030405Z');
    expect(init.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKID\/20260102\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
  });

  it.each([
    ['missing config', { ...config, r2SecretAccessKey: undefined } as AppConfig, undefined],
    ['upload failure', config, new Response('', { status: 403 })],
  ])('fails storage as unavailable on %s', async (_, cfg, response) => {
    if (response) fetchMock.mockResolvedValue(response);
    await expect(new R2AudioStorage(cfg, clock).upload('a.mp3', Buffer.from([1]))).rejects.toMatchObject({ status: ERROR.TTS_PROVIDER_UNAVAILABLE.status });
  });

  // AWS SigV4 test suite, case get-vanilla.
  it('matches the AWS reference signature', () => {
    const headers = signV4({
      method: 'GET', url: new URL('https://example.amazonaws.com/'), headers: {},
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1', service: 'service', now: new Date('2015-08-30T12:36:00Z'),
    });
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, '
      + 'Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });
});
