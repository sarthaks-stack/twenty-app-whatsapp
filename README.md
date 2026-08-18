# pixelinfinito/twenty-app-whatsapp

A production-ready Meta WhatsApp Cloud API integration for Twenty.
Developed by Marcos Lisboa from Pixel Infinito (`pixel.ao`).

## Marketplace showcase

Install this app in your Twenty workspace to add:

- Conversational inbox on every Person with inbound/outbound message threading.
- A shared team inbox with ownership, blocking, 24-hour window handling and campaign replies.
- Template sync, publishing control, and live preview with safe parameter binding.
- Consent-aware messaging and robust campaign pacing with failure guardrails.
- Timeline visibility and a health panel for webhook, sendability, and delivery diagnostics.
- Automatic handling of WhatsApp message/media types and unsupported-message fallback.

The interface follows the user locale and ships with English + Portuguese support.

## Meta setup (required)

This is the most common blocker during installation. Follow these steps in order:

1. Create a Meta Business account

   - Create or sign in to a Meta Business account at Business Manager.
   - Set up your business profile and confirm ownership where Meta requires it.

2. Create and configure a Meta App

- In Meta for Developers, create a new app (Business type).
- Add the WhatsApp product to the app.
- Open App Dashboard → Settings → Basic and copy:
  - App ID → set as `META_APP_ID`
  - App Secret → set as `META_APP_SECRET`

3. Create Meta credentials

- Open Business Manager → System Users.
- Create a system user and assign API access relevant to your WhatsApp Business Account.
- Generate a long-lived system user token with these scopes:
  - `whatsapp_business_management`
  - `whatsapp_business_messaging`
- Save it as `META_ACCESS_TOKEN`.
- Generate a random verify token (example: `openssl rand -hex 32`) and save as `META_VERIFY_TOKEN`.
- Add both values later in Twenty settings.

4. Configure a public webhook endpoint in Meta

- In the app’s WhatsApp product, open Webhooks and set callback to the public endpoint:
  - `<TWENTY_BASE_URL>/s/whatsapp/webhook`
  - this base is your workspace public URL used by the app installation.
- Use the same value from your `META_VERIFY_TOKEN` in Meta’s verify-token field.
- Set the following fields subscribed:
  - `messages`
  - `message_template_status_update`
  - `message_template_quality_update`
  - `message_template_components_update`
  - `account_update`
  - `phone_number_quality_update`
  - `business_capability_update`
- Save and verify in Meta. The response must complete successfully.

5. Register and connect a WhatsApp Business number

- In WhatsApp product API setup, add a verified phone number.
- Ensure the number belongs to your WABA and is in good status.
- In Twenty app admin page, connect the same WABA/phone setup under WhatsApp account setup.
- Run the in-app health check once connected.

6. Add the secrets in Twenty

- Open Twenty → Settings → Applications → WhatsApp → Variables.
- Set:
  - `META_APP_ID`
  - `META_APP_SECRET`
  - `META_ACCESS_TOKEN`
  - `META_VERIFY_TOKEN`
- Keep an eye on the app health card: it exposes the exact callback URL and required webhook fields.

If you are seeing `unverified webhook`, `signature failed`, or `no webhook events`:

- Re-copy callback and verify token in Meta from the latest save.
- Confirm your endpoint is reachable over HTTPS and not behind an IP/VPC block.
- Confirm the above webhook fields are all subscribed.
- Confirm the system user token still has both WhatsApp scopes.

## Local setup

Use the local setup guide in `SETUP.md`.

In short:

1. `yarn install`
2. `yarn twenty docker:start`
3. `yarn twenty dev`
4. Open [http://localhost:2020](http://localhost:2020) with the default dev account.

## How it is built

Design and architecture notes are in `specs/00-architecture-decisions.md`.

## Packaging and publishing

This package publishes with provenance using `.github/workflows/publish.yml`.

1. Register the package as a trusted publisher in npm.
2. Bump `package.json` version and tag a release (for example, `git tag v1.0.0 && git push --tags`).
3. Run the publish workflow manually or via your release pipeline.

Publishing with trusted provenance is the standard way to claim ownership in the Twenty Marketplace.

### Marketplace listing metadata

Before publishing, complete this checklist so the app appears well in the marketplace:

1. Add the marketplace keyword in `package.json`:

   ```json
   {
     "keywords": ["twenty-app"]
   }
   ```

2. Confirm these required `defineApplication()` fields in `src/application-config.ts`:

   - `logo` points to a file under `public/` (for example `public/logo-whatsapp.svg`).
   - `galleryImages` points to one or more images under `public/`.
   - Optional but recommended marketplace metadata fields:
     - `author`
     - `aboutDescription`
     - `websiteUrl`
     - `termsUrl`

3. Prepare marketplace visuals to fit constraints:

   - Use an 8:5 ratio for gallery images (for example, `1600x1000`).
   - Keep each file at or below **10 MB**.

4. Build and publish to npm:

   - `yarn twenty app:publish`
   - Optionally publish a non-default dist tag:
     - `yarn twenty app:publish --tag beta`

5. After publish, optionally sync the catalog right away:

   - `yarn twenty dev:catalog-sync`
   - This is optional because the catalog syncs automatically every hour.

6. Install or test on a workspace:

   - For marketplace apps: use **Settings → Applications** in Twenty.
   - For private/internal testing: publish with `yarn twenty app:publish --private` and share the Distribution link from app settings.

## Changelog

Notable changes are documented in `CHANGELOG.md`.

## Learn more

- [Twenty Apps documentation](https://docs.twenty.com/developers/extend/apps/getting-started/quick-start)
- [twenty-sdk CLI reference](https://www.npmjs.com/package/twenty-sdk)
- [Discord](https://discord.gg/cx5n4Jzs57)
