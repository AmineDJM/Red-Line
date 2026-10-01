---
title: Cookies and local storage
description: Cookies and local storage used by Red Line: one strictly necessary session cookie, no advertising trackers.
version: 1
updatedAt: 2026-10-01
---

## In short

Red Line uses **no advertising cookie, no social network tracker and no third-party audience measurement tool**.
That is why no consent banner is shown: the only cookies and data stored are strictly necessary for the service
to work (Article 82 of the French Data Protection Act, CNIL guidelines).

## Cookie used

| Name         | Purpose                                            | Duration                       | Type               |
| ------------ | -------------------------------------------------- | ------------------------------ | ------------------ |
| `rl_session` | Keeps you logged in (registered or guest account). | Until logout, 30 days at most. | Strictly necessary |

This cookie is _HttpOnly_ (inaccessible to scripts), _Secure_ (sent over HTTPS only) and _SameSite=Lax_ (not sent
by third-party sites).

## Browser local storage

The game stores interface preferences in your browser's local storage (_localStorage_, _sessionStorage_):
tutorial already seen, map legend open or closed, sound and display settings. This data stays on your device, is
not sent to the publisher and is not used to track you. You can clear it at any time in your browser settings
(you will then also lose your guest account if it is not linked to a registered account).

## Payment

When you make a purchase, you are redirected to **Stripe**'s payment page, which sets its own cookies, necessary for
payment security and fraud prevention, under its own responsibility: see Stripe's privacy policy
(stripe.com/privacy).

## Audience measurement

No audience measurement is carried out at present. If it were, it would either be configured to be exempt from
consent under the conditions set by the CNIL (strictly limited purpose, anonymised data, no cross-referencing) or
be subject to your prior consent; this page would then be updated.

## Contact

For any question: {{legal.contactEmail}}. See also the [privacy policy](page:legal:privacy).
