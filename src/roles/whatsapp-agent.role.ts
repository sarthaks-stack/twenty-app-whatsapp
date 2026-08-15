import { defineRole } from 'twenty-sdk/define';

import {
  OBJ_ACCOUNT,
  OBJ_CAMPAIGN,
  OBJ_CAMPAIGN_RECIPIENT,
  OBJ_CONSENT_EVENT,
  OBJ_MESSAGE,
  OBJ_TEMPLATE,
  OBJ_THREAD,
  ROLE_AGENT,
} from 'src/constants/universal-identifiers';

const readOnly = (objectUniversalIdentifier: string, universalIdentifier: string) => ({
  universalIdentifier,
  objectUniversalIdentifier,
  canReadObjectRecords: true,
  canUpdateObjectRecords: false,
  canSoftDeleteObjectRecords: false,
  canDestroyObjectRecords: false,
});

/**
 * A sales rep (SEC-5).
 *
 * Can work conversations and send within policy; cannot publish templates,
 * connect numbers, or touch campaigns. Messages are read-only even for agents —
 * they are written by the app, and a hand-edited record would desynchronise
 * from Meta.
 *
 * Object permissions protect the Core API. They do **not** protect the app's own
 * HTTP routes, which run as the app: every route re-checks the caller's role
 * server-side. A hidden button is a convenience, never a control.
 */
export default defineRole({
  universalIdentifier: ROLE_AGENT,
  label: 'WhatsApp Agent',
  description:
    'Work WhatsApp conversations: read and reply within the service window, send published templates, assign and close threads.',
  icon: 'IconHeadset',
  canBeAssignedToUsers: true,
  canBeAssignedToAgents: false,
  canBeAssignedToApiKeys: false,
  canUpdateAllSettings: false,
  canReadAllObjectRecords: false,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  objectPermissions: [
    {
      universalIdentifier: 'e1b4f0a7-3c62-4d95-8f27-6a3e9c1b5d80',
      objectUniversalIdentifier: OBJ_THREAD,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    readOnly(OBJ_MESSAGE, 'b7c2e5d9-8a14-4f36-9b50-2d7f1a4c6e93'),
    readOnly(OBJ_TEMPLATE, '4f9a1c6b-2e58-4703-8d1f-5b8c3a7e2d46'),
    readOnly(OBJ_ACCOUNT, '8d3e7b2a-5f19-4c84-9a06-1e4b7d9c3f52'),
    readOnly(OBJ_CAMPAIGN, '2c6f9d4e-7b03-4a51-8e39-6f1a5c8b2d74'),
    readOnly(OBJ_CAMPAIGN_RECIPIENT, '5a8b3f1c-9d67-4e20-8c74-3b6e2a9f5d18'),
    readOnly(OBJ_CONSENT_EVENT, '9e4c1a7d-6b38-4f52-8017-7d2c5b9e3a64'),
  ],
});
