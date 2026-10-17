# AVL-46 Calendar Reminders

1. Add an idempotent reminder-delivery ledger and migration.
2. Build a clock-injectable scanner over CalDAV items and expanded occurrences.
3. Deliver eligible reminders through the existing push preference gate.
4. Run the scanner every minute in the API process and expose deliveries over SSE.
5. Make notification clicks open the calendar URL.
6. Cover simple, recurring, edited, deleted and duplicate-delivery cases.
7. Run focused and complete verification; request review.
