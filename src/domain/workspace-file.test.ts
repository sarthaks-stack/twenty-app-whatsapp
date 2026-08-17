import { describe, expect, it } from 'vitest';

import { isWorkspaceFileAddress } from './workspace-file';

/**
 * D-58. Every outbound attachment failed, and the panel that collected the
 * address accepted anything that parsed as a URL — so the first moment anyone
 * learned an address was unusable was a failed bubble in the conversation,
 * carrying a sentence about Meta for a read of Twenty's own storage.
 *
 * These are the shapes the forms have to tell apart. Deliberately host-blind:
 * the address a rep copies is on the front-end host and the server's is the API
 * one, and judging the host is what rejected every correct answer.
 */
describe('recognising a Twenty file address', () => {
  it.each([
    ['an absolute address', 'https://crm.example.test/files/attachment/a.png'],
    ['the front-end host', 'https://app.crm.example.test/files/attachment/a.png'],
    ['a signed address', 'https://crm.example.test/files/attachment/a.png?token=abc.def'],
    ['a path', '/files/attachment/a.png'],
    ['an api mounted under a prefix', 'https://crm.example.test/api/files/attachment/a.png'],
  ])('accepts %s', (_label, value) => {
    expect(isWorkspaceFileAddress(value)).toBe(true);
  });

  it.each([
    ['Meta’s media CDN', 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1'],
    ['a public image', 'https://images.example.test/photo.jpg'],
    ['a share link', 'https://drive.example.test/file/d/abc/view'],
    ['the REST API on the workspace host', 'https://crm.example.test/rest/people'],
    ['a files lookalike', 'https://crm.example.test/files-2/a.png'],
    ['a data url', 'data:image/png;base64,iVBORw0KGgo='],
    ['an empty string', '   '],
    ['nothing at all', null],
  ])('refuses %s', (_label, value) => {
    expect(isWorkspaceFileAddress(value)).toBe(false);
  });
});
