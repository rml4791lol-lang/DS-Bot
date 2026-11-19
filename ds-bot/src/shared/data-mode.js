// The read-model mode contract shared by the host projection and its client.
// A missing, unknown, or internally inconsistent mode is never treated as live.
export const DATA_MODES = Object.freeze(['live', 'preview', 'demo'])
const VALID = new Set(DATA_MODES)

export function resolveDataMode(record) {
  if (record === null || typeof record !== 'object') return 'unknown'
  const dataMode = record.dataMode
  if (!VALID.has(dataMode)) return 'unknown'
  if (record.mode !== undefined && record.mode !== dataMode) return 'unknown'
  return dataMode
}

export const isLiveDataMode = mode => mode === 'live'
