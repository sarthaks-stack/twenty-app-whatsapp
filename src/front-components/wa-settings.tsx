import { defineSettingsFrontComponent } from 'twenty-sdk/define';

import { SettingsView } from '../components/settings/SettingsView';
import { FC_SETTINGS } from '../constants/universal-identifiers';

/**
 * *Settings → Applications → WhatsApp* (FR-ACC-1 … FR-ACC-5, NFR-O3).
 *
 * `defineSettingsFrontComponent` replaces Twenty's default variable editor for
 * this app. The variables are still editable there — this surface adds what a
 * generic key/value form cannot: a connection that is *tested* against Meta,
 * the exact callback URL to paste back, and a health panel that says which of
 * six things is wrong and what to do about it.
 */
const WaSettings = () => <SettingsView />;

export default defineSettingsFrontComponent({
  universalIdentifier: FC_SETTINGS,
  name: 'wa-settings',
  description: 'Connect a number, read the callback details, and see what is healthy.',
  component: WaSettings,
});
