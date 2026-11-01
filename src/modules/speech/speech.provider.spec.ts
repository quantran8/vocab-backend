import { VALIDITY } from '../../common/constants/domain';
import { ApiError } from '../../common/http/api-error';
import { AppConfig } from '../../config/app-config';
import { AzureRestSpeechProvider } from './speech.provider';

const REQUEST = { audio: Buffer.from('wav'), contentType: 'audio/wav', referenceText: 'clarify', locale: 'en-US' };
const configured = { azureSpeechKey: 'key', azureSpeechRegion: 'southeastasia' } as AppConfig;
const respond = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status });

describe('AzureRestSpeechProvider', () => {
  const provider = new AzureRestSpeechProvider(configured);
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const expectUnavailable = (run: Promise<unknown>) =>
    expect(run).rejects.toMatchObject({ code: 'SPEECH_PROVIDER_UNAVAILABLE', retryable: true });

  it('sends the reference text in the assessment header and reads the score', async () => {
    fetchMock.mockResolvedValue(respond(200, { RecognitionStatus: 'Success', NBest: [{ PronunciationAssessment: { AccuracyScore: 87.5 } }] }));
    const result = await provider.assess(REQUEST);
    expect(result).toMatchObject({ validity: VALIDITY.VALID, accuracyScore: 87.5 });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('southeastasia.stt.speech.microsoft.com');
    expect(String(url)).toContain('language=en-US');
    const headers = init!.headers as Record<string, string>;
    expect(headers['Ocp-Apim-Subscription-Key']).toBe('key');
    const assessment = JSON.parse(Buffer.from(headers['Pronunciation-Assessment'], 'base64').toString());
    expect(assessment.ReferenceText).toBe('clarify');
  });

  it('accepts the flat NBest score shape', async () => {
    fetchMock.mockResolvedValue(respond(200, { RecognitionStatus: 'Success', NBest: [{ AccuracyScore: 70 }] }));
    expect((await provider.assess(REQUEST)).accuracyScore).toBe(70);
  });

  it.each([
    ['no speech', respond(200, { RecognitionStatus: 'NoMatch' })],
    ['no score', respond(200, { RecognitionStatus: 'Success', NBest: [{}] })],
    ['rejected audio', respond(400)],
  ])('treats %s as invalid, never failed', async (_, response) => {
    fetchMock.mockResolvedValue(response);
    expect(await provider.assess(REQUEST)).toMatchObject({ validity: VALIDITY.INVALID, accuracyScore: null });
  });

  it('C61 maps outages and timeouts to a retryable error', async () => {
    fetchMock.mockResolvedValue(respond(503));
    await expectUnavailable(provider.assess(REQUEST));
    fetchMock.mockRejectedValue(new Error('timeout'));
    await expectUnavailable(provider.assess(REQUEST));
  });

  it('is unavailable without credentials, and never calls out', async () => {
    const unconfigured = new AzureRestSpeechProvider({} as AppConfig);
    await expect(unconfigured.assess(REQUEST)).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
