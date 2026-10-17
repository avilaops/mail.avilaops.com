# AVL-51 Outbound Calendar Invitations

1. Build interoperable REQUEST and CANCEL MIME messages from persisted calendar events.
2. Send through the existing compose queue so quota, Sent copy and DKIM remain authoritative.
3. On create, ask before inviting guests and persist the mailbox (or allowed send-as address) as ORGANIZER.
4. On edit, send REQUEST only to added guests or all current guests when time/location changes; cancel removed guests.
5. On deletion, send CANCEL before removing the event, including recurrence scope when applicable.
6. Add integration coverage for MIME structure, recipients, sequence, quota and cancellation behavior.
