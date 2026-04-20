# Security Spec for AI Dialog Platform

## 1. Data Invariants
- A `Workspace` cannot exist unless `ownerId` accurately maps to a real user.
- All `Conversations`, `Attachments`, and `KnowledgeDocuments` must belong to a valid `Workspace` where the current user is the owner.
- A `Message` cannot exist without a valid `Conversation` parent, and its modification must update its parent's timestamp to maintain relational sync.
- `tokenIn` and `tokenOut` must be integers, limiting cost poisoning.
- `attachments.size` must be strongly checked against string length bounding.
- Timestamps must sync with Server Time exactly.

## 2. The "Dirty Dozen" Payloads
1. **User Spoofing:** Create user profile with someone else's email.
2. **Workspace Theft:** Create `workspace` passing a victim's `ownerId`.
3. **Ghost Workspace:** Read `workspace` where user is not `ownerId`.
4. **Denial of Wallet (ID Poisoning):** Create a conversation with a 10KB string as Document ID.
5. **Orphaned Message:** Create a message using a forged `conversationId` that doesn't exist.
6. **Shadow Field Injection:** Send a `Message` payload with `isVerified: true` (a field not in the Schema).
7. **Type Poisoning:** Send an `Attachment` where `size` is a string instead of a number.
8. **Size Overflow:** Send a `Message` where `content` exceeds 1MB limits by generating 100,000 characters.
9. **Role Escalation:** Updating `ownerId` of an existing `Workspace`.
10. **Time-travel Bypass:** Setting `createdAt` to a time in the past instead of `request.time`.
11. **Cost Fraud:** Updating a `Message` to artificially decrease `tokenIn`.
12. **Blanket Read Trap:** Attempting to query `/workspaces` as a guest or without a valid `where` clause.

## 3. The Test Runner
A test file will be generated in `firestore.rules.test.ts` to assert against these.
