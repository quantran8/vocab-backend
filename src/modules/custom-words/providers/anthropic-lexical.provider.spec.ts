import { ERROR } from '../../../common/constants/errors';
import { AppConfig } from '../../../config/app-config';
import { AnthropicLexicalProvider } from './anthropic-lexical.provider';

const config = (model: string, anthropicApiKey: string | undefined = 'key') => ({ anthropicApiKey, lexicalAiModel: model }) as AppConfig;
const word = {
  isValidWord: true, lemma: 'run', duplicateOfIndex: null,
  senses: [{ partOfSpeech: 'verb', ipa: '/rʌn/', cefrLevel: 'A1', popularity: 90, meaningText: 'chạy', definitionText: 'di chuyển nhanh', examples: [{ text: 'I run.', translation: 'Tôi chạy.', target: 'run' }] }],
};
const reply = (text: string, stop_reason = 'end_turn') => new Response(JSON.stringify({
  id: 'msg', type: 'message', role: 'assistant', model: 'm', stop_reason, stop_sequence: null,
  content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 },
}), { headers: { 'content-type': 'application/json' } });

describe('AnthropicLexicalProvider', () => {
  const fetchMock = vi.fn();
  const request = () => {
    const [, init] = fetchMock.mock.calls[0];
    return { body: JSON.parse(init.body), beta: new Headers(init.headers).get('anthropic-beta') };
  };
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('asks for structured output and returns the parsed word', async () => {
    fetchMock.mockResolvedValue(reply(JSON.stringify(word)));
    const result = await new AnthropicLexicalProvider(config('claude-opus-5-5')).generate({ text: 'ran', locale: 'vi-VN', maxSenses: 3 });
    expect(result).toEqual(word);
    const { body, beta } = request();
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.fallbacks).toBe('default');
    expect(beta).toContain('server-side-fallback-2026-07-01');
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.properties.senses.type).toBe('array');
    expect(JSON.parse(body.messages[0].content)).toMatchObject({ text: 'ran', locale: 'vi-VN' });
  });

  it('leaves server fallbacks off for Haiku, which has none', async () => {
    fetchMock.mockResolvedValue(reply(JSON.stringify(word)));
    await new AnthropicLexicalProvider(config('claude-haiku-5-5')).generate({ text: 'run', locale: 'vi-VN', maxSenses: 3 });
    expect(request().body.fallbacks).toBeUndefined();
  });

  it('returns translations in order', async () => {
    const meanings = [{ meaningText: 'run', definitionText: 'move fast', exampleTranslations: ['I run.'] }];
    fetchMock.mockResolvedValue(reply(JSON.stringify({ meanings })));
    const source = { lemma: 'run', partOfSpeech: 'verb', meaningText: 'chạy', definitionText: 'di chuyển', examples: ['I run.'] };
    await expect(new AnthropicLexicalProvider(config('m')).translate([source], 'en-US')).resolves.toEqual(meanings);
  });

  it.each([
    ['a refusal', () => reply('', 'refusal')],
    ['output that breaks the schema', () => reply('{"lemma":1}')],
    ['a server error', () => new Response('{}', { status: 400 })],
  ])('fails as unavailable on %s', async (_, response) => {
    fetchMock.mockImplementation(async () => response());
    await expect(new AnthropicLexicalProvider(config('m')).generate({ text: 'run', locale: 'vi-VN', maxSenses: 3 }))
      .rejects.toMatchObject({ status: ERROR.LEXICAL_PROVIDER_UNAVAILABLE.status });
  });

  it('never calls out without a key', async () => {
    const provider = new AnthropicLexicalProvider({ lexicalAiModel: 'm' } as AppConfig);
    await expect(provider.generate({ text: 'run', locale: 'vi-VN', maxSenses: 3 })).rejects.toMatchObject({ status: ERROR.LEXICAL_PROVIDER_UNAVAILABLE.status });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
