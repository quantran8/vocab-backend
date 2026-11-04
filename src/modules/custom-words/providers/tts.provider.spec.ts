import { ERROR } from '../../../common/constants/errors';
import { AppConfig } from '../../../config/app-config';
import { SupabaseAudioStorage } from './audio-storage';
import { ElevenLabsTtsProvider } from './tts.provider';

const config = {
  elevenLabsApiKey: 'key', elevenLabsVoiceId: 'voice', elevenLabsModelId: 'model',
  supabaseUrl: 'https://ref.supabase.co', supabaseServiceRoleKey: 'secret', supabaseAudioBucket: 'audio',
} as AppConfig;

describe('audio providers', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends the text and model to ElevenLabs', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([1, 2])));
    await expect(new ElevenLabsTtsProvider(config).synthesize('run')).resolves.toEqual(Buffer.from([1, 2]));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/v1/text-to-speech/voice');
    expect(init.headers['xi-api-key']).toBe('key');
    expect(JSON.parse(init.body)).toEqual({ text: 'run', model_id: 'model' });
  });

  it.each([
    ['missing config', { ...config, elevenLabsApiKey: undefined } as AppConfig, undefined],
    ['server failure', config, new Response('', { status: 500 })],
    ['quota failure', config, new Response('', { status: 401 })],
  ])('fails as unavailable on %s', async (_, cfg, response) => {
    if (response) fetchMock.mockResolvedValue(response);
    await expect(new ElevenLabsTtsProvider(cfg).synthesize('run')).rejects.toMatchObject({ status: ERROR.TTS_PROVIDER_UNAVAILABLE.status });
  });

  it('never calls out without config', async () => {
    await new ElevenLabsTtsProvider({ ...config, elevenLabsVoiceId: undefined } as AppConfig).synthesize('run').catch(() => undefined);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uploads with upsert and returns a stable public URL', async () => {
    fetchMock.mockResolvedValue(new Response('{}'));
    const url = await new SupabaseAudioStorage(config).upload('tts/a.mp3', Buffer.from([1]));
    expect(url).toBe('https://ref.supabase.co/storage/v1/object/public/audio/tts/a.mp3');
    expect(fetchMock.mock.calls[0][0]).toBe('https://ref.supabase.co/storage/v1/object/audio/tts/a.mp3');
    expect(fetchMock.mock.calls[0][1].headers['x-upsert']).toBe('true');
  });
});
