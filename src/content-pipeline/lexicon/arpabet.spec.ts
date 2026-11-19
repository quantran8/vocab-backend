import { describe, expect, it } from 'vitest';
import { arpabetToIpa } from './arpabet';

describe('arpabetToIpa', () => {
  it.each([
    ['D AA1 K T ER0', '/ˈdɑːktər/'],
    ['N ER1 S', '/nɜːrs/'],
    ['HH EH1 L TH IY0', '/ˈhelθi/'],
    ['AH0 P OY1 N T M AH0 N T', '/əˈpɔɪntmənt/'],
    ['P R IH0 S K R IH1 P SH AH0 N', '/prɪˈskrɪpʃən/'],
    ['EH1 K S ER0 S AY2 Z', '/ˈeksərˌsaɪz/'],
    ['R IH0 K AO1 R D', '/rɪˈkɔːrd/'],
  ])('%s → %s', (arpabet, ipa) => {
    expect(arpabetToIpa(arpabet)).toBe(ipa);
  });
});
