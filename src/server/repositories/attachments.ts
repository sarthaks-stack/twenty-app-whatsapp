import { nodesOf, query } from './base';

/**
 * Workspace attachments, read-only, for the chat's file picker (the "already
 * in Twenty" source). Attachment is a standard Twenty object this app does not
 * extend, so this repository is one search and nothing else: the picker needs
 * a name to show and a storage path to send, and everything else about an
 * attachment belongs to the CRM.
 */

const ATTACHMENT_FIELDS = {
  id: true,
  name: true,
  fullPath: true,
  createdAt: true,
} as const;

export type AttachmentRecord = {
  id: string;
  name: string | null;
  fullPath: string | null;
  createdAt: string;
};

/**
 * Newest-first, because the file a rep wants is overwhelmingly the one just
 * uploaded to a record — which is also why an empty term answers with the
 * newest files instead of nothing: the picker opens useful before anyone
 * types.
 */
export const searchAttachments = async (
  term: string,
  limit = 20,
): Promise<AttachmentRecord[]> => {
  const needle = term.trim();

  const result = await query(
    (client) =>
      client.query({
        attachments: {
          __args: {
            ...(needle.length === 0
              ? {}
              : { filter: { name: { ilike: `%${needle}%` } } }),
            orderBy: [{ createdAt: 'DescNullsLast' }],
            first: limit,
          },
          edges: { node: ATTACHMENT_FIELDS },
        },
      }),
    'attachments.search',
  );

  return nodesOf<AttachmentRecord>(result.attachments);
};
