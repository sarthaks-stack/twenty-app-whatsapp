import { defineObject, FieldType } from 'twenty-sdk/define';

import { fieldId, TEMPLATE_NAME } from 'src/constants/field-identifiers';
import { OBJ_TEMPLATE } from 'src/constants/universal-identifiers';

const f = (name: string) => fieldId(OBJ_TEMPLATE, name);

/**
 * A mirror of Meta's template registry (FR-TPL-1).
 *
 * Sync is authoritative: nothing in the CRM may edit category, status,
 * components or qualityScore — Meta owns them, including silent
 * re-categorisation. The only CRM-owned column is `publishedToCrm`.
 */
export default defineObject({
  universalIdentifier: OBJ_TEMPLATE,
  nameSingular: 'whatsappTemplate',
  namePlural: 'whatsappTemplates',
  labelSingular: 'WhatsApp template',
  labelPlural: 'WhatsApp templates',
  description: 'An approved WhatsApp message template, synced from Meta',
  icon: 'IconTemplate',
  isUICreatable: false,
  labelIdentifierFieldMetadataUniversalIdentifier: TEMPLATE_NAME,
  fields: [
    {
      universalIdentifier: TEMPLATE_NAME,
      name: 'name',
      label: 'Name',
      description: 'Send key part 1',
      icon: 'IconTemplate',
      type: FieldType.TEXT,
      defaultValue: "''",
    },
    {
      universalIdentifier: f('metaTemplateId'),
      name: 'metaTemplateId',
      label: 'Meta template ID',
      icon: 'IconHash',
      type: FieldType.TEXT,
      defaultValue: "''",
    },
    {
      universalIdentifier: f('language'),
      name: 'language',
      label: 'Language',
      description: 'Send key part 2, e.g. pt_PT',
      icon: 'IconLanguage',
      type: FieldType.TEXT,
      defaultValue: "''",
    },
    {
      universalIdentifier: f('category'),
      name: 'category',
      label: 'Category',
      description: 'Meta-authoritative and may be reassigned by Meta',
      icon: 'IconCategory',
      type: FieldType.SELECT,
      defaultValue: "'UTILITY'",
      options: [
        { value: 'MARKETING', label: 'Marketing', position: 0, color: 'purple' },
        { value: 'UTILITY', label: 'Utility', position: 1, color: 'blue' },
        { value: 'AUTHENTICATION', label: 'Authentication', position: 2, color: 'orange' },
      ],
    },
    {
      universalIdentifier: f('previousCategory'),
      name: 'previousCategory',
      label: 'Previous category',
      description: 'Set when a sync observes a re-categorisation, so admins can see it',
      icon: 'IconArrowBack',
      type: FieldType.SELECT,
      isNullable: true,
      options: [
        { value: 'MARKETING', label: 'Marketing', position: 0, color: 'purple' },
        { value: 'UTILITY', label: 'Utility', position: 1, color: 'blue' },
        { value: 'AUTHENTICATION', label: 'Authentication', position: 2, color: 'orange' },
      ],
    },
    {
      universalIdentifier: f('status'),
      name: 'status',
      label: 'Status',
      icon: 'IconCircleCheck',
      type: FieldType.SELECT,
      defaultValue: "'PENDING'",
      options: [
        { value: 'PENDING', label: 'Pending review', position: 0, color: 'gray' },
        { value: 'APPROVED', label: 'Approved', position: 1, color: 'green' },
        { value: 'REJECTED', label: 'Rejected', position: 2, color: 'red' },
        { value: 'PAUSED', label: 'Paused', position: 3, color: 'orange' },
        { value: 'DISABLED', label: 'Disabled', position: 4, color: 'gray' },
        { value: 'IN_APPEAL', label: 'In appeal', position: 5, color: 'yellow' },
      ],
    },
    {
      universalIdentifier: f('rejectedReason'),
      name: 'rejectedReason',
      label: 'Rejection reason',
      icon: 'IconAlertTriangle',
      type: FieldType.TEXT,
      isNullable: true,
    },
    {
      universalIdentifier: f('qualityScore'),
      name: 'qualityScore',
      label: 'Quality',
      icon: 'IconHeartRateMonitor',
      type: FieldType.SELECT,
      defaultValue: "'UNKNOWN'",
      options: [
        { value: 'GREEN', label: 'Green', position: 0, color: 'green' },
        { value: 'YELLOW', label: 'Yellow', position: 1, color: 'yellow' },
        { value: 'RED', label: 'Red', position: 2, color: 'red' },
        { value: 'UNKNOWN', label: 'Unknown', position: 3, color: 'gray' },
      ],
    },
    {
      universalIdentifier: f('components'),
      name: 'components',
      label: 'Components',
      description: "Meta's component array, verbatim",
      icon: 'IconBraces',
      type: FieldType.RAW_JSON,
      isNullable: true,
    },
    {
      universalIdentifier: f('variableSpec'),
      name: 'variableSpec',
      label: 'Variable spec',
      description:
        'Derived at sync so the picker does not re-parse components in the browser on every render (specs/06 §2)',
      icon: 'IconVariable',
      type: FieldType.RAW_JSON,
      isNullable: true,
    },
    {
      universalIdentifier: f('publishedToCrm'),
      name: 'publishedToCrm',
      label: 'Published to CRM',
      description:
        'Admin gate (FR-TPL-2). Automatically revoked on rejection, pause, disable or a red quality score',
      icon: 'IconEye',
      type: FieldType.BOOLEAN,
      defaultValue: false,
    },
    {
      universalIdentifier: f('isUsableInCrm'),
      name: 'isUsableInCrm',
      label: 'Usable in CRM',
      description: 'False when components cannot be filled correctly here (FR-TPL-4)',
      icon: 'IconCircleOff',
      type: FieldType.BOOLEAN,
      defaultValue: true,
    },
    {
      universalIdentifier: f('unsupportedReason'),
      name: 'unsupportedReason',
      label: 'Unsupported reason',
      description: 'e.g. FLOW_BUTTON, CAROUSEL, LIMITED_TIME_OFFER, CATALOG, COPY_CODE',
      icon: 'IconInfoCircle',
      type: FieldType.TEXT,
      isNullable: true,
    },
    {
      universalIdentifier: f('lastSyncedAt'),
      name: 'lastSyncedAt',
      label: 'Last synced',
      icon: 'IconRefresh',
      type: FieldType.DATE_TIME,
      isNullable: true,
    },
    {
      universalIdentifier: f('sentCount'),
      name: 'sentCount',
      label: 'Sent',
      icon: 'IconSend',
      type: FieldType.NUMBER,
      defaultValue: 0,
    },
    {
      universalIdentifier: f('deliveredCount'),
      name: 'deliveredCount',
      label: 'Delivered',
      icon: 'IconChecks',
      type: FieldType.NUMBER,
      defaultValue: 0,
    },
    {
      universalIdentifier: f('readCount'),
      name: 'readCount',
      label: 'Read',
      description:
        'Under-reports systematically: contacts may disable read receipts, in which case read never arrives (specs/03 §5.0)',
      icon: 'IconEyeCheck',
      type: FieldType.NUMBER,
      defaultValue: 0,
    },
  ],
});
