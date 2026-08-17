import { describe, expect, it } from 'vitest';

import {
  listSendableTemplatesInputSchema,
  parameterContractForTemplate,
} from './wa-list-sendable-templates-tool';

describe('whatsapp-list-sendable-templates MCP tool', () => {
  it('is a read-only Person-id contract with bounded pagination', () => {
    expect(listSendableTemplatesInputSchema.additionalProperties).toBe(false);
    expect(listSendableTemplatesInputSchema.required).toEqual(['personId']);
    expect(listSendableTemplatesInputSchema.properties?.first).toMatchObject({
      minimum: 1,
      maximum: 50,
    });
    expect(listSendableTemplatesInputSchema.properties).not.toHaveProperty('phone');
  });

  it('derives named body, media header and URL-button requirements without raw components', () => {
    const result = parameterContractForTemplate({
      id: '97fcd762-3433-40a4-b7af-f2aa39cc6526',
      name: 'order_ready',
      variableSpec: {
        namedParameters: true,
        header: {
          format: 'IMAGE',
          variableCount: 0,
          indices: [],
          names: [],
          text: null,
          example: [],
        },
        body: {
          variableCount: 1,
          indices: [],
          names: ['customer'],
          text: 'Olá {{customer}}, a encomenda está pronta.',
          example: ['Ana'],
        },
        footer: null,
        buttons: [
          {
            index: 0,
            type: 'URL',
            hasVariable: true,
            text: 'Acompanhar',
            url: 'https://example.test/{{1}}',
          },
        ],
        totalVariableCount: 3,
      },
    });

    expect(result.preview).toBe('Olá Ana, a encomenda está pronta.');
    expect(result.contract).toEqual({
      body: [{ key: 'customer', example: 'Ana', required: true }],
      header: { kind: 'media', mediaType: 'IMAGE' },
      buttons: [{ index: 0, kind: 'url', required: true }],
    });
  });
});
