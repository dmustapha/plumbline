// File: packages/ledger/src/index.ts
export { openDb } from './db.ts';
export type { Db } from './db.ts';
export { Ledger } from './spend.ts';
export type { SpendGate, SpendKind, SpendContext, SpendResult, Receipt, DisplaySpend, LedgerLimits } from './spend.ts';
export { recordDecision, recordEvent, listDecisions, getDecision, proofCounts } from './decisions.ts';
export { exportLedger, verifyExport, recordUnknownOutcome, resolveUnknownOutcome, listUnknownOutcomes, GENESIS_HASH } from './export.ts';
export type { LedgerExport, ExportDecision, ExportResource, ExportUnknown, ExportVerdict, VerifyOptions, UnknownOutcome } from './export.ts';
export type { DecisionMeta, DecisionRow, ProofCounts } from './decisions.ts';
export { Bond } from './bond.ts';
