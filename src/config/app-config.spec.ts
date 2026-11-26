import { z } from 'zod';
import { parseServiceAccount, parseVoices } from './app-config';

describe('voice options', () => {
  it('puts the default first, takes labels, and drops repeats and blanks', () => {
    expect(parseVoices('def', 'a:Anna, b , def:Main voice,,a:Again')).toEqual([
      { id: 'def', name: 'Main voice' }, { id: 'a', name: 'Anna' }, { id: 'b', name: 'b' },
    ]);
  });

  it('works with only the default or only options', () => {
    expect(parseVoices('def', undefined)).toEqual([{ id: 'def', name: 'def' }]);
    expect(parseVoices(undefined, 'a:Anna')).toEqual([{ id: 'a', name: 'Anna' }]);
    expect(parseVoices(undefined, undefined)).toEqual([]);
  });
});

describe('Play service account', () => {
  const schema = z.string().transform(parseServiceAccount);
  const key = { type: 'service_account', client_email: 'play@p.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\n…', private_key_id: 'k1' };
  const parsed = { clientEmail: key.client_email, privateKey: key.private_key, privateKeyId: 'k1' };

  it('reads the key file as JSON or base64', () => {
    expect(schema.parse(JSON.stringify(key))).toEqual(parsed);
    expect(schema.parse(Buffer.from(JSON.stringify(key)).toString('base64'))).toEqual(parsed);
  });

  it('refuses anything else', () => {
    expect(schema.safeParse('not json').success).toBe(false);
    expect(schema.safeParse(JSON.stringify({ client_email: 'x' })).success).toBe(false);
  });
});
