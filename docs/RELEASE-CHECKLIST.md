# Relay public beta — release gate

Do not advertise end-to-end encryption. Do not launch until critical checks pass.

- [ ] Build API and web in CI.
- [ ] Verify database RLS using two ordinary accounts and an unauthenticated client.
- [ ] Verify message, attachment, reaction, call and moderation authorization, including direct API requests.
- [ ] Verify blocked-user behavior in DMs and shared groups.
- [ ] Test reconnections, duplicate sends, expired signed URLs and mobile layout.
- [ ] Configure TURN, test calls across unrelated networks.
- [ ] Test rate limits and concurrent connections; document capacity.
- [ ] Configure backups, incident response and abuse review ownership.
- [ ] Verify full data export, account removal and storage cleanup before claiming these capabilities.
- [ ] Publish reviewed privacy notice and terms with actual operator identity, contact details, retention rules and processor arrangements.
- [ ] Review German/EU legal obligations and accessibility before opening registration.
