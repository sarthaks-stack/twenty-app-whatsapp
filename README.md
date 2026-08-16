# WhatsApp

Two-way WhatsApp messaging inside your CRM: a shared inbox, conversations on the Person record, approved templates, consent tracking and marketing campaigns — powered by the Meta WhatsApp Cloud API.

## Features

- **Conversations where the contact is.** A WhatsApp tab on every Person record, and a side panel from anywhere else. Text, images, audio, video, documents, locations, contacts, reactions and replies all render; anything WhatsApp invents next is stored and shown as an unsupported message rather than dropped.
- **A shared inbox.** Filter by yours, unassigned, everyone's, campaign replies, conversations whose 24-hour window is closing, and closed ones. Assignment, blocking and closing are one click and are recorded on the timeline.
- **The 24-hour rule, enforced server-side.** The composer knows whether you may type — window state, consent, blocking, number quality and template availability are decided by the server and explained in the interface, never merely hidden.
- **Templates you can actually use.** Sync from Meta, see which are approved, publish the ones the CRM may render, and fill their parameters from CRM fields with a live preview before you send.
- **Campaigns with brakes.** Audience from a saved view, per-recipient parameter binding, a cost estimate before launch, a share of the daily tier held back for 1:1 traffic, and a circuit breaker that pauses a campaign whose failure rate climbs.
- **Consent that holds up.** Opt-out and opt-in keywords, one confirmation reply whose wording is a setting rather than a deploy, and an audit event for every change.
- **Operations you can see.** A health panel that names which of six things is wrong and what to do about it, the exact callback URL and required webhook fields to paste into Meta, and diagnostics for failed deliveries and stuck sends.

Both interfaces ship in Portuguese and English, following each user's locale.

## Getting started

Setup instructions live in [SETUP.md](SETUP.md). You will need a Meta app with the WhatsApp product, a System User token scoped to `whatsapp_business_messaging` and `whatsapp_business_management`, and a phone number registered to a WhatsApp Business Account.

The four Meta credentials are set under _Settings → Applications → WhatsApp → Variables_; everything else — throttles, windows, retention, rates, confirmation wording — is an application variable with a working default.

## How it is built

`specs/` holds the specification this app was written from, including [`specs/00-architecture-decisions.md`](specs/00-architecture-decisions.md), which records every decision that could reasonably have gone the other way and why it did not.

## Publishing

The `Publish` workflow (`.github/workflows/publish.yml`) publishes the app to npm with provenance using [npm trusted publishing](https://docs.npmjs.com/trusted-publishers). To publish:

1. On npmjs.com register this repository as a trusted publisher of your package, pointing at the `publish.yml` workflow.
2. Bump the version in `package.json`, then push a version tag (e.g. `git tag v1.0.0 && git push --tags`) or run the workflow manually from the Actions tab.

Publishing with provenance is also how you prove ownership when claiming your app in a Twenty marketplace.

## Changelog

Notable changes are documented in [CHANGELOG.md](CHANGELOG.md).

## Learn more

- [Twenty Apps documentation](https://docs.twenty.com/developers/extend/apps/getting-started/quick-start)
- [twenty-sdk CLI reference](https://www.npmjs.com/package/twenty-sdk)
- [Discord](https://discord.gg/cx5n4Jzs57)
