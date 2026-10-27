// Values shared by the audit scripts. workstreams.md defines them in the return schema.
// Keep this file the only copy.
export const CHECK_RESULTS = new Set(['observed', 'not observed', 'insufficient']);
export const EVIDENCE = new Set(['direct', 'proxy', 'lab', 'mixed', 'inferred', 'insufficient']);
export const SEVERITIES = new Set(['critical', 'high', 'medium', 'low']);
