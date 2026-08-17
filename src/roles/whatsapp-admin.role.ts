import { defineRole } from 'twenty-sdk/define';

import {
  OBJ_ACCOUNT,
  OBJ_CAMPAIGN,
  OBJ_CAMPAIGN_RECIPIENT,
  OBJ_CONSENT_EVENT,
  OBJ_MESSAGE,
  OBJ_TEMPLATE,
  OBJ_THREAD,
  OBJ_WEBHOOK_EVENT,
  ROLE_ADMIN,
} from 'src/constants/universal-identifiers';

const readWrite = (objectUniversalIdentifier: string, universalIdentifier: string) => ({
  universalIdentifier,
  objectUniversalIdentifier,
  canReadObjectRecords: true,
  canUpdateObjectRecords: true,
  canSoftDeleteObjectRecords: true,
  canDestroyObjectRecords: false,
});

const readOnly = (objectUniversalIdentifier: string, universalIdentifier: string) => ({
  universalIdentifier,
  objectUniversalIdentifier,
  canReadObjectRecords: true,
  canUpdateObjectRecords: false,
  canSoftDeleteObjectRecords: false,
  canDestroyObjectRecords: false,
});

/**
 * A WhatsApp administrator (SEC-5, SEC-12).
 *
 * Everything the agent has, plus connecting numbers, publishing templates,
 * importing consent, full campaign control and webhook replay.
 *
 * One thing this role explicitly cannot do: send a business-initiated message to
 * an opted-out contact. That check lives in the policy module and is re-run
 * immediately before the HTTP call, so there is no role, request parameter or UI
 * path that overrides it (SEC-6). "Admin can do anything" is deliberately untrue
 * here.
 */
export default defineRole({
  universalIdentifier: ROLE_ADMIN,
  label: 'WhatsApp Admin',
  description:
    'Configure WhatsApp: connect numbers, publish templates, manage consent and campaigns, replay webhook events.',
  icon: 'IconShieldCog',
  canBeAssignedToUsers: true,
  canBeAssignedToAgents: false,
  canBeAssignedToApiKeys: false,
  canUpdateAllSettings: false,
  canReadAllObjectRecords: false,
  canUpdateAllObjectRecords: false,
  canSoftDeleteAllObjectRecords: false,
  canDestroyAllObjectRecords: false,
  objectPermissions: [
    /**
     * Threads are read-only for the same reason they are for agents: the
     * sender's binding re-check trusts `serviceWindowExpiresAt`, `isBlocked`
     * and `personId`, and every legitimate mutation goes through the routes,
     * which run as the app and audit the actor. An admin editing those columns
     * directly would be policy without validation.
     */
    readOnly(OBJ_THREAD, '3f7d2b8e-1a95-4c60-8e43-9b2f6d1a5c78'),
    readWrite(OBJ_ACCOUNT, '6b1e9c4a-8d27-453f-9017-4a8c2e6b1d95'),
    readWrite(OBJ_TEMPLATE, 'd8a3f6c1-4b79-4e02-8536-1c9b7e4a2f60'),
    /**
     * Campaigns are editable but **not deletable through the Core API**.
     *
     * A record delete is a single gesture with no notion of state, so the
     * platform's own delete on a campaign record would remove a cancelled or
     * completed one — the counters, the exclusion breakdown and the recipient
     * rows the launch audit line refers to — as readily as an untouched draft.
     * That is the one thing a campaign record must never allow: it is the
     * evidence of a bulk send to real people, and evidence that can be deleted
     * by whoever is embarrassed by it is not evidence (SEC-12).
     *
     * Deleting a campaign that never launched is legitimate and remains
     * possible, through the control route's `delete` arm, which checks the
     * status and the counters and audits the result. So the capability is not
     * withheld — it is moved to the only place that can tell one campaign from
     * another.
     *
     * The recipient rows are held the same way, for the same reason and one
     * more: they name people, and a snapshot is the list of who a campaign was
     * about to message.
     */
    {
      universalIdentifier: '1c5a8e2f-7d93-4b46-9f28-6e3d0b7a4c19',
      objectUniversalIdentifier: OBJ_CAMPAIGN,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    {
      universalIdentifier: '7e2b4d9a-3c86-4f15-8b70-5a1d9c3e6f42',
      objectUniversalIdentifier: OBJ_CAMPAIGN_RECIPIENT,
      canReadObjectRecords: true,
      canUpdateObjectRecords: true,
      canSoftDeleteObjectRecords: false,
      canDestroyObjectRecords: false,
    },
    /**
     * Consent events are the **evidence trail** (SEC-11): append-only by
     * design, written only by the app through `setConsent` and the erasure
     * tombstone. A role that could edit or delete them could forge an opt-in
     * or erase the proof of an opt-out, which is exactly what the trail exists
     * to make impossible. Imports and corrections go through the consent
     * route, which writes a *new* event.
     */
    readOnly(OBJ_CONSENT_EVENT, 'a4f8c1d6-9b25-4370-8e64-2f7b5a9d1c38'),
    {
      universalIdentifier: '0b9d5e3a-6c17-4824-9a58-8d4f1b7c2e96',
      objectUniversalIdentifier: OBJ_MESSAGE,
      canReadObjectRecords: true,
      canUpdateObjectRecords: false,
      canSoftDeleteObjectRecords: true,
      canDestroyObjectRecords: false,
    },
    /**
     * Webhook events are forensic evidence too — the raw signed deliveries the
     * app's records were derived from. Replay reads them through a route;
     * retention deletes them through the app's own cron. A role able to edit
     * or destroy them could rewrite history after the fact.
     */
    readOnly(OBJ_WEBHOOK_EVENT, 'c7f1a4b8-2e69-4d03-8517-9b6e3a5c1f74'),
  ],
});
