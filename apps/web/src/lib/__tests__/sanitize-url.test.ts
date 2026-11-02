import { describe, expect, it } from 'vitest';
import { sanitizeEventUrls, sanitizeUrl } from '../sanitize-url.js';

describe('sanitizeUrl', () => {
  it('tar bort Auth0:s code/state och söktexten q, men behåller övriga parametrar', () => {
    expect(
      sanitizeUrl(
        'https://tikknet.se/?code=abc&state=xyz&category=music&q=sara%40example.com',
      ),
    ).toBe('https://tikknet.se/?category=music');
  });

  it('lämnar en URL utan känsliga parametrar orörd och tål ogiltiga värden', () => {
    expect(sanitizeUrl('https://tikknet.se/events/1')).toBe('https://tikknet.se/events/1');
    expect(sanitizeUrl('$direct')).toBe('$direct');
  });
});

describe('sanitizeEventUrls', () => {
  it('rensar URL-egenskaperna på en händelse', () => {
    const event = sanitizeEventUrls({
      properties: {
        $current_url: 'https://tikknet.se/?code=1',
        $initial_referrer: 'https://x.test/?q=hej',
        other: 'https://x.test/?code=1',
      },
    });
    expect(event.properties).toEqual({
      $current_url: 'https://tikknet.se/',
      $initial_referrer: 'https://x.test/',
      other: 'https://x.test/?code=1',
    });
  });

  it('släpper igenom null', () => {
    expect(sanitizeEventUrls(null)).toBeNull();
  });
});
