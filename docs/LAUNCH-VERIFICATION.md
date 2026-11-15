# Free-tier launch verification

Keep the current Render URL. Do not enable unrestricted registration before the gates below pass.

## Mobile and accessibility
Test 320, 375, 390 and 768px widths on iOS Safari and Android Chrome, including keyboard open, long messages, GIF panel, calls, account settings, focus order, and reduced motion.

## Security
With two separate test accounts and no token, verify 401/403 for unauthorized access to messages, uploads, signed URLs, reports, calls, and scheduled messages. Verify direct Supabase RLS separately. Test deleted users, password reset, block restrictions, session expiry, rate limiting and malicious filenames. Audit dependencies using npm audit in web and api; review findings rather than blindly applying force fixes.

## Performance
Use browser devtools and Lighthouse on the deployed site. Record cold and warm startup, message acknowledgement latency, memory and network requests. Test only an authorized staging environment for concurrent load; start small. Free-tier sleep can delay expiry and scheduled delivery. No uptime guarantee. TURN connectivity across networks is not assured.

## Legal publication gate
Confirm operator legal name, business/contact address, support/privacy email, hosting regions and vendor agreements, purpose-specific retention, applicable legal bases and international transfers. Document GIPHY search requests and Google STUN use. Obtain appropriate legal review for GDPR, German legal notice and applicable communications/platform obligations. Publish actual policies before public launch. Do not claim end-to-end encryption or guaranteed deletion of recipient copies.
