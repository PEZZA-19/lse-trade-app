# Requirements from competitor reviews

Research compiled 11 November 2026 (Europe/Guernsey, UTC+0) to shape the LSE Trade App. This file is the build-facing list. The companion Page is _LSE Trade App: What Users Love & Hate_.

Do not treat this as a rewrite of the spec. The spec Page was not edited. Items marked **Already in spec** should be kept and tested. Items marked **Partly in spec** should be tightened. Items marked **New** are additions from review evidence.

Quotes are short and copied only where the wording was taken from a source. Elsewhere the findings are paraphrased. Sources, dates and sample sizes are at the end.

## Must-have

### M1. Offline that never loses work

The app must stay usable with no signal: view jobs, log time, add materials, notes, photos, draft quotes and complete forms. Every change is saved on the device first, including if the app is killed, the user switches apps, or the phone is locked. The UI must never show a form, photo or document as saved, uploaded, sent or viewed unless that actually happened. A sync badge shows what is waiting. Photos are compressed before upload.

- **Spec:** Already in spec (offline-first, sync badge, photo compression). **Tighten:** persist drafts across app-kill and app-switch; never display a false saved/sent/viewed state; confirm form and photo uploads.
- **Evidence:** Tradify's own help says it does not work offline (help article, updated 5 August 2024; still cited as current in a 30 October 2026 hands-on review). That review found the Android app would not open with no connection, and a new note would not save. A Google Play review of YourTradebase asked for offline quotes, addresses and diary because "we don't always have signal at every job" and said the app is internet-dependent, can crash, and does not always save quote edits. Fergus Go reviewers (Google Play, 3 September 2026 and 24 March 2026) described timesheets and certificates disappearing when switching apps, no draft saved, and 30–60 second loads even on 5G. A ServiceM8 Android review (15 September 2026) said in-app forms only save or upload about half the time even when the app says they have, causing callbacks.

### M2. Same app on every device, same quality on iPhone and Android

Windows, macOS, Linux, iPhone, Android and the web must share one product. Feature parity between iOS and Android is a requirement, not a nicety. Engineers should be able to finish a real job on their own phone during testing before a store release is called done.

- **Spec:** Already in spec (one codebase, all six platforms). **Tighten:** explicit iOS/Android parity tests; do not ship a cut-down Android app.
- **Evidence:** ServiceM8 Google Play, 13 August 2026: the Android app was described as "completely watered down" versus iOS, with slow sync and jobs not appearing. Joblogic's UK App Store score was 1.8 from 201 ratings on 12 October 2026, while its Trustpilot score was 4.5 from 370 reviews — office reviews can hide a bad engineer app. simPRO's mobile app was the opposite pattern (App Store 4.5 from 176). Powered Now's app-store scores (UK App Store 4.1 from 244; Google Play 4.0 from 286, checked 30 October 2026) trail its 4.7 Trustpilot, so the phone experience needs its own testing.

### M3. Quote to job to invoice in a few taps, with separate numbers

An accepted quote converts to a linked job once only. Quotes have their own numbers and revisions. Invoices can be raised from the quote or the job, including deposits and progress invoices, without retyping. Quoted lines stay visible against actual time and materials.

- **Spec:** Already in spec (separate Q- numbers, revisions, convert once, quote vs actual). **Tighten:** make progress invoices and "invoice selected lines / a percentage / the remainder" easy, because users asked to split a quote into several jobs or a job into several invoices (Jobber Capterra, 21 November 2025).
- **Evidence:** Tradify, Jobber and Powered Now are repeatedly praised for quote-to-invoice and convert-to-job. Tradify's 30 October 2026 hands-on test found invoicing "from a quote" versus "time and materials" at a default £0 labour rate is a trap — defaults must be safe (see M8).

### M4. Itemised, printable job profit and loss

Every job must show and export a line-level breakdown: labour, materials, supplier bills, carriage, sell vs cost, and margin. Graphs and summary tiles are not enough. The report must be printable and exportable (CSV/PDF).

- **Spec:** Partly in spec (reports include "job profit (sell vs cost)"). **New detail:** itemised, printable/exportable breakdown, not only summaries.
- **Evidence:** Tradify Trustpilot, 28 October 2026: a subscriber paying £30 a month who entered supplier bills, job costs and invoices could not get a detailed itemised P&L per job, was told to print screen sections or use outside AI, and was told this was not on the roadmap. This was the clearest "I entered the data and still cannot see profit" complaint in the set.

### M5. Customisable professional PDFs, sent from the business email

Quotes, invoices and receipts must use the business's layout, logo, bank details, terms and contact details. They go out as PDFs from the business's own mailbox, not as editable Word files and not with a forced "powered by" footer (a small optional footer is fine if the user can turn it off). Document themes must not silently keep old bank details after a change.

- **Spec:** Already in spec (LSE layout PDFs, send from LSE Gmail, bank details as settings, old templates with outdated bank details called out as a current pain). **Tighten:** no forced vendor footer; never send DocX; changing bank details updates the template used for new documents immediately.
- **Evidence:** ElectriciansForums (July–August 2022): Fergus was dropped because quote layout could not be changed; YourTradebase was liked for layout but forced a generic email and a "I'm using YTB" logo; Joblogic emailed Word DocX files with a "powered by JobLogic" footer. The current LSE spec already flags outdated bank details on old quote templates.

### M6. Several contacts per customer and site

A job or site must hold more than one contact, each with a role: tenant, landlord, agent, managing factor, site contact, bill payer. Invoices go to the bill payer; job messages can go to the site contact.

- **Spec:** New. The spec has one customer, many sites, and a billing email, but not multiple named roles on a site.
- **Evidence:** ElectriciansForums, July 2022 (baldelectrician): most job apps "fail in not letting you have different contact fields" for a tenanted property (tenants, landlord, agent, managing factor). ServiceM8 App Store, 8 May 2025: swapping first and surname on new clients was "a massive pain" (later marked fixed).

### M7. Approval-first AI, with a human always able to stop it

AI may draft quotes, invoices, chases, bill lines and briefs. It must not send, take payment, delete, convert a quote to a job, or mark anything paid. Extracted supplier-bill data is always shown as a diff with totals checked. AI is not the only support channel.

- **Spec:** Already in spec (golden rule: AI drafts, Joe decides; 2-minute hold). **Tighten:** billed AI (receipt/invoice reading) must flag total mismatches; support must not be chatbot-only.
- **Evidence:** Tradify's own SmartRead guide warns imported data may differ from the original and can include "Totals Discrepancy" lines (cited 6 October 2026). A G2 simPRO review said the vendor's AI upgrade was "worthless" to that technical trade business and that core features still did not fit do-and-charge work. Housecall Pro's Trustpilot (around 2.8–2.9 from about 700 reviews in 2026) is dominated by cancellation and support complaints, including AI or chatbot-only support. ServiceM8 G2, 7 May 2026: AI transcription was "decent" but not a workflow breakthrough, while bugs and disappearing conversations hurt trust.

### M8. Safe defaults before the first quote or invoice can be sent

Labour rate, tax rate, logo, legal name, address, email, phone and bank details must be complete, or the send action is blocked with a plain explanation. Defaults must not be £0 labour or a missing tax rate. Connecting an accounts package must not silently overwrite the business name, tax number or timezone.

- **Spec:** Partly in spec (tax-rate field, tenant settings, billing email required before invoice approval). **New:** a pre-send completeness check; protect business settings from being overwritten by an accounts sync.
- **Evidence:** Tradify hands-on test, 30 October 2026: standard labour rate starts at A$0, so a time-and-materials invoice billed at £0 and was then shown as paid; connecting Xero replaced the business name, ABN and timezone with no warning (Queensland times went an hour out). The same test found a new quote PDF had no ABN, phone, email or address until those were filled in.

### M9. Accounting and bank data that fail visibly, with CSV always available

If a bank feed or accounts sync is used later, a broken or stale feed must be obvious (last-successful time, a badge, a retry). Manual CSV import must always work as a fallback. Sync must not create duplicate customers or duplicate invoice lines. Payments recorded in the accounts package should mark the invoice paid, and part payments should flow both ways.

- **Spec:** Partly in spec (Phase 2 bank CSV matching; no live bank feed in MVP, which is consistent with this evidence). **New:** visible feed health; two-way payment matching without duplicates or silent overwrites; CSV remains the reliable path.
- **Evidence:** Recurring theme across Xero (Trustpilot 4.1 from 11,518 UK reviews, November 2026; Reddit r/xero bank-feed thread), QuickBooks UK (Atlaso analysis of 200 recent UK App Store reviews, June 2026: dead bank feeds, including one reviewer who had not loaded transactions "since 23rd March"), Sage (Capterra 4.1 from 652; official Sage bank-feed status page lists active bank issues; community posts about feeds down), and FreeAgent (Trustpilot 4.6 from 3,053, with bank-feed reliability still a repeated complaint). Fergus Trustpilot, 23 December 2025: "Xero intergration Broken. Blank emails being sent to invoice." ServiceM8 App Store, 8 May 2025: MYOB invoices failed to transfer after approval. A G2 simPRO review said there was not even two-way Xero communication. Tradify's 30 October 2026 Xero test did send invoices instantly and brought a part payment back in eight minutes — that good path is the bar — but it also imported every Xero customer and overwrote business details.

### M10. Honest pricing, easy cancellation, and a full takeaway of your data

For LSE and for later customers: prices in the open, month-to-month available, a reminder before any yearly renewal, no charge for a plan the user did not start using without a clear written start date, and a complete export of customers, sites, jobs, quotes, invoices, timesheets, photos and documents. After cancel, the user can still get at their data for a stated period. Core features for a sole trader (timesheets, job photos, invoice chasing, certificates when relevant) should not be locked in a much more expensive tier.

- **Spec:** New as a product rule. The separate pricing Page recommends published sole-trader / team prices; this turns the review pattern into a build and billing rule.
- **Evidence:** Powered Now low-star Trustpilot reviews cluster on billing: "Can't believe how the cost has risen!!!!" (10 July 2026); a 22 October 2025 review of a £660 two-year renewal "without my consent"; another of auto-renewal taking £300 up front (5 April 2024); and a 26 June 2026 review of lost contacts and documents after cancelling. Fergus Trustpilot, 6 August 2025: price changes every 6–12 months and features the firm already used were later locked to push an upgrade. simPRO Trustpilot 2026: a firm that never completed rollout was later referred to collections. Housecall Pro and Workiz Trustpilot scores (about 2.8–2.9 from ~700, and 1.8 from 126) are dragged down by cancellation, auto-renewal and billing, not by quoting. ElectriciansForums, 30 July 2022: YourTradebase access was cut immediately after deciding not to continue, despite having paid a month up front. Joblogic typically asks for 24- or 36-month contracts (vendor, checked 12 October 2026). Tradify is per-user, so a three-person crew pays about twice ServiceM8 in an Australian comparison (30 October 2026).

## Should-have

### S1. Working-hours recurring jobs and a clash lock

Recurring jobs should follow the business's working hours, not a 24-hour clock. The schedule should offer a toggle that prevents double-booking a person.

- **Spec:** Partly in spec (calendar clash check, weekly plan, two-way Google Calendar sync). **New:** working-hours recurrence; optional hard lock against double-booking.
- **Evidence:** ServiceM8 Capterra, 6 February 2024: recurring jobs were based on 24 hours rather than work hours, so multi-day bookings appeared wrong in the calendar. Jobber Capterra, 21 November 2025: wish for a toggle so people cannot be double booked, and to schedule equipment as well as people.

### S2. Stock levels and simple reorder alerts

Optional, but if materials are held on a van or in a store, show quantity, deduct on use, and alert when a reorder point is hit. Purchase orders should not require the most expensive plan for a sole trader later.

- **Spec:** Partly in spec (materials, supplier bills, allocation to job/stock/home). **New:** quantities and reorder alerts.
- **Evidence:** Tradify has no stock control; a G2 review (Olga P., 7 September 2024, marked incentivized) said it was "impossible to control stock levels or get alerts". Contractor Software Hub (6 October 2026) lists "skip it if proven offline working or native stock control is essential".

### S3. Certificates completed on site, offline, stored on the job

EICR, PAT and other forms are filled and signed on the phone, work offline, and are stored against the job and the site, with a reminder before expiry.

- **Spec:** Already in spec as Phase 2 (compliance, ODPA, EICR/PAT due dates, files linked to jobs). Keep it, and test it offline (M1).
- **Evidence:** Powered Now is praised for nearly 100 trade forms, including EICR, signed on site, with a reminder a month before expiry (vendor pages, 30 October 2026). Fergus stores EICRs with the job and says certificates are free. Joblogic is strong on PPM and gas/F-Gas certificates but its iPhone app rating is very low. simPRO's UK pages (12 October 2026) listed custom digital forms as a paid add-on, with no named EICR or CP12 templates found.

### S4. Customer quote acceptance and invoice view

Customers accept a quote from a link or email button, and can view invoices. Acceptance is recorded (who, when, which revision and options). Viewed/opened tracking must be accurate or omitted.

- **Spec:** Already in spec as Phase 3 customer portal (online quote acceptance, invoice view, card payment if available). **Tighten:** do not mark a quote as viewed if it was not received.
- **Evidence:** Powered Now and Tradify are praised for accept-from-link. Tradify Capterra (Iveta S., 23 January 2023, and a later 2025 comment): a sent quote sometimes showed as opened and viewed when the customer said they had not received it. Tradify's accept flow (30 October 2026 test) was one click with no signature or terms tick — LSE may want a clearer acceptance record.

### S5. Fast pages, even with years of jobs

Opening a job or the diary should take a couple of seconds on a normal phone connection, not 30 seconds. Large histories must be paged or cached, not dumped in one request. Servers should be close to the British Isles (the spec already points at London Postgres and European Cloudflare).

- **Spec:** New as a stated performance budget, though the stack choice already favours Europe.
- **Evidence:** Tradify App Store, January 2026: "Very slow in AU, it takes 30s to open a page or job." A 30 October 2026 review notes Tradify's servers are in the USA per its help centre. Fergus Go, 24 March 2026: 30–60 second loads on 4G/5G. ServiceM8 G2 and Capterra reviews describe lag, slowdowns with many active quotations, and bugs after updates.

### S6. Human support that answers in hours, not months

When the product is sold, support should have a human path, visible status during an outage, and answers measured in hours. Sales follow-up after a trial should stop on request and should not be the only "support" offered during the trial.

- **Spec:** New (selling-later operations rule, not an MVP screen).
- **Evidence:** Powered Now is often praised for quick chat (Trustpilot, 8 January 2026). Fergus is praised by name when a person helps, and condemned when a Trustpilot reply took three months (updated 13 October 2026). simPRO Capterra, 6 August 2025: 30-minute phone waits, tickets taking days, regular outages, app reinstall after updates. ElectriciansForums, July 2022: Tradify "continually badgered me with phone calls" at the end of a trial "whilst offering little in the way of support". Housecall Pro and Workiz Trustpilot complaints centre on unreachable or AI-only support at cancellation time.

### S7. Onboarding import that is checked to the penny

Switching cost is a real barrier. Import from Sheets, CSV and later Xero/QuickBooks, then show a reconciliation list of mismatches for approval. Do not require a week of training to issue the first invoice.

- **Spec:** Already in spec (import, reconcile to the penny, AI-proposed customer merges). Keep it prominent so first-time use does not feel like simPRO or Joblogic.
- **Evidence:** ElectriciansForums: the hardest part is getting customer data in. simPRO and Joblogic are repeatedly described as admin-heavy, expensive to implement, and in need of training. Tradify and Powered Now win praise for being usable in a day.

### S8. Enquiry inbox that does not lose the thread

Emails and messages about a job should stay on that job after it is converted from an enquiry. Customers should be able to send a photo without a special upload link if the business uses SMS.

- **Spec:** Partly in spec (Phase 2 AI inbox triage). **New:** keep the correspondence thread on the job; if SMS is added later, support incoming photos (MMS) or do not port the main mobile number onto a system that cannot receive them.
- **Evidence:** ServiceM8 Capterra, 6 February 2024: replies to a client enquiry kept going to the inbox even after the job was converted, so correspondence had to be copied by hand. ServiceM8 Trustpilot: ServiceM8 Phone did not support incoming MMS photos and did not notify on incoming SMS — a serious gap for trades who are sent photos of boards and faults.

## Avoid

### A1. Per-user pricing that punishes a two- or three-person crew, and feature-gating of basics

Do not make timesheets, job photos, online quote acceptance or invoice chasing premium-only for the first commercial plans. Do not move a feature a customer already uses onto a higher plan without a long notice period and a grandfather option.

- **Evidence:** Tradify Lite lacks photos, online acceptance and timesheets; Plus holds purchase orders and reporting. Fergus and Powered Now reviewers objected when used features were locked or prices rose. Jobber users "don't like that we have to pay for more users than we already do" (Capterra, 21 November 2025).

### A2. Long contracts, quiet auto-renewal, and holding data hostage

No 24–36 month default. No yearly charge without a clear reminder and a way to switch to monthly. No deletion of data the day a user cancels, especially if they prepaid. No collections process that ignores a recorded cancellation of an unused rollout.

- **Evidence:** Joblogic contract lengths; Powered Now, Housecall Pro and Workiz billing reviews; simPRO collections dispute; YourTradebase and nextminute access cut on cancel (ElectriciansForums, 2022).

### A3. An online-only field app

Do not ship a "mobile app" that shows an error and no jobs when signal drops, or that loses a note when the app is closed. This is an official Tradify limitation and a deal-breaker for Sark and for basements.

- **Evidence:** Tradify help; softwarefortradies.com offline test, 30 October 2026; YourTradebase Play review; Fergus Go data loss.

### A4. False status and blank documents

Do not mark quotes viewed if they were not received. Do not send blank invoice emails. Do not show a form as uploaded when it was not. Do not bill time at a £0 default rate and mark it paid.

- **Evidence:** Tradify viewed-but-not-received; Fergus blank invoice emails; ServiceM8 form-save failures; Tradify £0 invoice trap.

### A5. Chatbot-only support and "AI" as a sticker

Do not replace support with a bot. Do not advertise AI that cannot be reviewed or that does not change the actual workflow. Do not auto-send anything an model drafted.

- **Evidence:** Housecall Pro Trustpilot; simPRO G2 AI complaint; Tradify SmartRead discrepancy warning; LSE standing rule already forbids unapproved sends.

### A6. A steep, admin-heavy first week

Avoid setups that need weeks of training, unpaid implementation, or a specialist just to send a quote. Complexity for commercial PPM can come later; the first usable version is for a sole trader on site.

- **Evidence:** simPRO Capterra 3.9, "extremely admin heavy", poor onboarding; Joblogic overkill for domestic teams; ElectriciansForums users overwhelmed by Tradify and impressed by simpler tools.

### A7. iOS-first, Android later (or the reverse)

Do not repeat ServiceM8's Android gap or Joblogic's 1.8 iPhone app. Parity is part of "every operating system".

### A8. Silent accounts sync side-effects

Do not overwrite name, tax number or timezone on connect. Do not invent duplicate customers. Do not leave a one-way Xero link if payments need to come back.

- **Evidence:** Tradify Xero connect behaviour; simPRO one-way Xero complaint; ServiceM8 MYOB failures; Fergus broken Xero integration.

## Mapping to the current spec

| ID    | Item                                       | Spec status                                                   |
| ----- | ------------------------------------------ | ------------------------------------------------------------- |
| M1    | Offline that never loses work              | Already in spec; tighten persistence and honest save state    |
| M2    | Cross-platform with iOS/Android parity     | Already in spec; add parity tests                             |
| M3    | Quote → job → invoice, separate numbers    | Already in spec; add easy progress/split invoicing            |
| M4    | Itemised printable job P&L                 | Partly in spec; add line-level export                         |
| M5    | Custom PDFs from own email                 | Already in spec; ban forced footers and DocX                  |
| M6    | Multiple contacts and roles per site       | **New**                                                       |
| M7    | Approval-first AI                          | Already in spec; add bill-total checks and human support      |
| M8    | Safe defaults; protect settings from sync  | **New** (pre-send checklist and sync overwrite guard)         |
| M9    | Visible bank/accounts health; CSV fallback | Partly in spec (CSV in Phase 2); add health and two-way rules |
| M10   | Honest billing and full data export        | **New** as a product rule                                     |
| S1    | Working-hours recurrence and clash lock    | Partly in spec; add work-hours and hard lock                  |
| S2    | Stock quantities and reorder alerts        | **New** detail on top of stock allocation                     |
| S3    | Offline certificates on the job            | Already in spec (Phase 2)                                     |
| S4    | Quote acceptance with honest tracking      | Already in spec (Phase 3); fix viewed-state honesty           |
| S5    | Performance budget and EU/UK hosting       | **New** as a stated budget                                    |
| S6    | Human support standards                    | **New** (sell-later operations)                               |
| S7    | Import reconciled to the penny             | Already in spec                                               |
| S8    | Job-scoped message thread; MMS caution     | **New** detail on inbox                                       |
| A1–A8 | Avoid list                                 | Mix of new commercial rules and tightens to existing design   |

## Sources (checked or published dates)

Primary or closely cited review pages. Trustpilot, Capterra, G2 and Reddit often returned 403 to automated fetches; figures from those sites are taken from live search snippets of the review pages and from independent reviews that state their check date. Official help pages and ElectriciansForums threads were read directly.

- Tradify Trustpilot, https://www.trustpilot.com/review/tradifyhq.com — 4.8/5 from 627 reviews (search snippet 11 November 2026); itemised job-cost review 28 October 2026
- Tradify Capterra, https://www.capterra.com/p/152413/Tradify/reviews/ — 4.7/5 from 152 reviews (updated 19 October 2026)
- Tradify help, Does Tradify Work Offline?, https://help.tradifyhq.com/hc/en-us/articles/360026848353-Does-Tradify-Work-Offline — updated 5 August 2024, read 11 November 2026
- Software for Tradies, Tradify review, https://softwarefortradies.com.au/tradify-review/ — updated 30 October 2026 (hands-on, ratings, offline test)
- Contractor Software Hub, Tradify review, https://www.contractorsoftwarehub.com/tradify-review/ — updated 6 October 2026
- Fergus Trustpilot, https://www.trustpilot.com/review/fergus.com — about 3.9/5 from 15 reviews (11 November 2026 snippet); 3.8 from 14 on 12 October 2026
- Fergus Capterra, https://www.capterra.com/p/155571/Fergus/reviews/ — 4.6/5 from 155 (updated 19 October 2026)
- Fergus Go on Google Play, https://play.google.com/store/apps/details?id=com.fergus.app — 4.8/5 from about 845–872 reviews; quotes from 24 March 2026 and 3 September 2026
- Software for Tradespeople, Fergus review, https://softwarefortradespeople.com/reviews/fergus/ — 12 October 2026
- ServiceM8 Capterra, https://www.capterra.com/p/110711/ServiceM8/reviews/ — 4.5/5 from 312 (updated 9 November 2026)
- ServiceM8 G2, https://www.g2.com/products/servicem8/reviews — 3.8/5 from 16
- ServiceM8 Trustpilot, https://www.trustpilot.com/review/www.servicem8.com — 4.1/5 from 120
- ServiceM8 App Store, https://apps.apple.com/au/app/servicem8-job-management-app/id378062736 — review dated 8 May 2025
- ServiceM8 Google Play, https://play.google.com/store/apps/details?id=com.servicem8.skip — 3.8/5 from 744; reviews 13 August and 15 September 2026
- Jobber Capterra, https://www.capterra.com/p/127994/Jobber/reviews/ — 4.6/5 from about 1,490 (2026)
- Jobber G2, https://www.g2.com/products/jobber/reviews — 4.6/5 from 535 (2026 search)
- Plainly Reviewed, Jobber review, https://plainlyreviewed.com/trades/jobber-review/ — 7 September 2026; Trustpilot 4.2 from 227
- simPRO Capterra, https://www.capterra.com/p/10529/Simpro-Enterprise/reviews/ — 3.9/5 from 156 (updated 3 November 2026)
- simPRO G2, https://www.g2.com/products/simpro/reviews — 4.1/5 from 527
- simPRO Trustpilot UK, https://www.trustpilot.com/review/simpro.co.uk — 3.2/5 from 46 (11 November 2026 snippet); 3.9 from 37 on 12 October 2026
- Software for Tradespeople, simPRO review, https://softwarefortradespeople.com/reviews/simpro/ — 12 October 2026
- Powered Now Trustpilot, https://www.trustpilot.com/review/powerednow.com — 4.7/5 from 570–571 (30 October 2026)
- FieldCamp, Powered Now review, https://fieldcamp.ai/uk/reviews/powered-now/ — 2 November 2026 (ratings and quoted Trustpilot/App Store lines)
- YourTradebase Capterra, https://www.capterra.com/p/140632/YourTradeBase/reviews/ — about 4.9/5 from 59
- YourTradebase Trustpilot, https://www.trustpilot.com/review/www.yourtradebase.com — 4.8/5 from 62–63, no reviews in the last 12 months (2026 search)
- YourTradebase Play reviews via https://chrome-stats.com/d/com.yourtradebase.yourtradebase/reviews — includes the offline-feature request
- Commusoft Capterra, https://www.capterra.com/p/149651/Commusoft/reviews/ — 4.7/5 from 212
- Commusoft G2, https://www.g2.com/products/commusoft/reviews — 4.8/5 from 40
- Commusoft Trustpilot, https://www.trustpilot.com/review/commusoft.com — 4.1/5 from 17 (small sample; billing and export complaints)
- Joblogic: Software for Tradespeople, https://softwarefortradespeople.com/reviews/joblogic/ — 12 October 2026; Capterra 4.3 from 102; Trustpilot 4.5 from 370; UK App Store 1.8 from 201
- Xero Capterra, https://www.capterra.com/p/120109/Xero/reviews/ — 4.4/5 from 3,336 (19 October 2026)
- Xero Trustpilot UK, https://www.trustpilot.com/review/www.xero.com — 4.1/5 from 11,518 (November 2026)
- Xero G2, https://www.g2.com/products/xero/reviews — about 1,856 reviews (2026)
- QuickBooks Capterra UK, https://www.capterra.co.uk/software/141374/quickbooks-online — 4.3/5 from 8,555
- QuickBooks Trustpilot UK, https://www.trustpilot.com/review/quickbooks.intuit.com — 3.7/5 from 16,962
- Atlaso, QuickBooks UK app-store analysis, https://www.tryatlaso.com/blog/quickbooks-uk-top-grossing-worst-reviewed — 13 August 2026, based on a June 2026 run
- FreeAgent Trustpilot, https://www.trustpilot.com/review/www.freeagent.com — 4.6/5 from 3,053
- FreeAgent Capterra, https://www.capterra.com/p/122008/FreeAgent/reviews/ — 4.5/5 from 180, ease of use 4.4
- Sage Accounting Capterra, https://www.capterra.com/p/168740/Sage-One-UK/reviews/ — 4.1/5 from 652, customer service 3.8
- Sage Trustpilot, https://www.trustpilot.com/review/sage.com — 4.0/5 from 20,259
- Sage bank-feed status, https://www.sage.com/en-gb/sage-business-cloud/sage-accounting/bank-feed-status/
- Housecall Pro Capterra, https://www.capterra.com/p/140363/HouseCall-Pro/reviews/ — 4.7/5 from 2,748
- Housecall Pro Trustpilot, https://www.trustpilot.com/review/housecallpro.com — about 2.8–2.9 from ~700–707 (2026)
- Workiz Capterra, https://www.capterra.com/p/147525/Workiz/reviews/ — 4.4/5 from 218
- Workiz G2, https://www.g2.com/products/workiz/reviews — 4.5/5 from 247
- Workiz Trustpilot, https://www.trustpilot.com/review/workiz.com — 1.8/5 from 126
- ElectriciansForums, Anybody using Job Management Software?, https://www.electriciansforums.net/threads/anybody-using-job-management-software.202705/ — started 23 July 2022, pages 1–2 read 11 November 2026
- ElectriciansForums, Your Tradebase, https://www.electriciansforums.net/threads/your-tradebase-for-small-electrical-business.141541/ — March 2018
