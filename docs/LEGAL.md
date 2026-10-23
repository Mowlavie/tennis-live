# Legal & minors: requirements checklist

> **Not legal advice.** This is an engineering checklist to bring to a lawyer who knows
> youth sports, privacy and child-safety law. The Terms, Privacy and Safety pages in
> `public/` are **drafts with [bracketed] placeholders** and must be reviewed before launch.

Legal text version: `LEGAL_VERSION` in `server.rb`. Bump it whenever the Terms or Privacy page
changes materially, and every user will be asked to accept again.

## What the product enforces today

| Requirement | How | Where |
|---|---|---|
| Account holders are 13+ | Age question on first sign-in; "12 or younger" is refused and signed out | `POST /api/consent` |
| 13–17 need parent/guardian permission | Extra required checkbox for teens | `POST /api/consent` |
| Only adults stream/record | Teens can't consent on a broadcaster account | `POST /api/consent` |
| Terms + Privacy accepted | Required checkbox; API blocked until accepted (`authenticated!`) | `server.rb` |
| Streamer has filming permission (incl. minors' parents) and follows venue rules | Dialog before going live; server refuses offers until confirmed | `POST /api/filming-consent`, `/signal` |
| Private, invite-only streams | Google sign-in with email allowlists, or court passwords | `/auth/google`, env lists |
| No private messages with minors | Chat is group-only (SafeSport-aligned) | `/api/chat` |
| Users can delete their videos | Streamer can delete cloud files | `POST /api/recordings/delete` |
| Consent records | **Server logs only** (`consent:` / `filming-consent:` lines) | Needs a database (below) |

## Before charging customers (must do)

- [ ] **Lawyer review** of `terms.html`, `privacy.html`, `safety.html`. Fill in company name, address, state and contact emails.
- [ ] **Form a company** (e.g. an LLC) so the business, not you personally, holds the liability. Get general liability + cyber insurance.
- [ ] **Durable consent records:** store who accepted which `LEGAL_VERSION`, age group, guardian flag and timestamp in a database table instead of logs.
- [ ] **Report & moderation tools:** a report button on chat and videos, the streamer can delete chat messages and remove viewers, and a written process for handling reports within a set time.
- [ ] **Data deletion on request:** an account/data deletion flow, plus a documented manual process meanwhile.
- [ ] **Data processing agreements** with vendors (Render, Cloudflare, Google), listed as subprocessors in the Privacy Policy.
- [ ] **Breach response plan:** who to notify and how fast. US states and GDPR set deadlines.
- [ ] **Trademark check** on "Courtline" before branding spend.

## Laws and rules to review with counsel

**United States**
- **COPPA (FTC).** Covers personal information collected from children under 13, which includes photos, video and voice. We block under-13 accounts. Counsel should confirm how adult-uploaded videos *of* under-13 players are treated. The FTC amended the COPPA Rule in 2025 (compliance date in 2026), so check the current rule.
- **State privacy laws** (California CCPA/CPRA and the growing list of other state laws): notice, access/delete rights, and stricter rules for teens' data in several states. Check thresholds and current status.
- **State minors' online-safety laws** (age-appropriate design codes, teen social-media and age-verification laws). Many are new or being challenged in court, so check current status for the states you launch in.
- **Illinois BIPA and similar.** No face recognition or biometric features on players without legal review. This matters for any future AI features.

**Sport-specific**
- **U.S. Center for SafeSport (MAAPP):** adults under SafeSport jurisdiction (e.g. USTA coaches) must keep electronic communication with minors open and observable. Keep chat group-only; never add DMs between adults and minors.
- **Tournament, league and venue rules:** USTA, high-school, college and ITF events may restrict filming or live streaming, or claim broadcast rights. The streamer confirms they follow them, and the Help pages should point to common policies.

**International (if you launch outside the US)**
- **GDPR / UK GDPR:** lawful basis, a data processing agreement, rights requests, and the age of digital consent (13–16 depending on country).
- **UK Age Appropriate Design Code (Children's Code):** high-privacy defaults for under-18s.

**App stores (native app)**
- **Apple:** apps that offer third-party sign-in like Google must generally also offer Sign in with Apple (or an equivalent privacy-focused option). In-app account deletion is required. Set the age rating correctly.
- **Google Play:** Families policy if under-13s are part of the audience; Data safety form.

## Scaling notes that affect compliance

- Move sessions, chat, consents and court membership into **Postgres** so records survive restarts and can be audited or exported.
- Store videos **per court/account prefix** in R2 so deletion and export are clean.
- Add **retention rules** (R2 lifecycle) that match what the Privacy Policy promises.
- Keep an **audit log** for deletes, moderation actions and consent changes.
