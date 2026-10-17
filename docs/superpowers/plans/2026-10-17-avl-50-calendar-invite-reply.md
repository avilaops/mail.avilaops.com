# AVL-50 Calendar Invite Reply

1. Load and validate a received REQUEST invitation from the mailbox-owned message.
2. Persist the invited event under its organizer UID with the selected attendee PARTSTAT.
3. Keep declined invitations in CalDAV while excluding them from the calendar grid.
4. Build a minimal METHOD:REPLY containing only the mailbox attendee and enqueue it through the signed outbound mail path.
5. Expose the authenticated reply endpoint and wire the three invite-card actions with pending/error/success states.
6. Cover create, repeated reply, declined visibility, MIME reply, mailbox isolation, Google and Outlook fixture variants.
