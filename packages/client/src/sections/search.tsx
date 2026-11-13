/**
 * The Search test panel: run one hybrid query (q + topK capped at 10)
 * against the live index and show the ranked results, so the operator can
 * see what recall actually retrieves before trusting the lifecycle
 * injections. An offline or degraded index answers 503 index_offline: the
 * panel shows that as a quiet note (the index, not the query, is down), any
 * other error renders verbatim.
 * @module dsh-plugin-obsidian-mem/client/sections/search
 */

import type { ReactNode } from 'react'
import {
  ERROR_CODES,
  errorText,
  isApiError,
  probeSearch,
  type SearchPayload,
} from '../api.js'
import { clampTopK, truncate } from '../format.js'
import { renderButton, renderInput, renderTag } from '../primitives.js'
import { react } from '../react.js'
import { RowHint } from '../cardRoot.js'
import {
  ERROR_BANNER_STYLE,
  HINT_STYLE,
  MONO_STYLE,
  ROW_STYLE,
} from '../styles.js'

/** Chunk text shown per row before truncation. */
const RESULT_TEXT_CHARS = 160

export function SearchSection(): ReactNode {
  const [query, setQuery] = react.useState('')
  const [topK, setTopK] = react.useState('10')
  const [busy, setBusy] = react.useState(false)
  const [payload, setPayload] = react.useState<SearchPayload | null>(null)
  const [offline, setOffline] = react.useState<string | null>(null)
  const [error, setError] = react.useState<string | null>(null)

  const run = (): void => {
    const trimmed = query.trim()
    if (trimmed === '') {
      return
    }
    setBusy(true)
    setError(null)
    setOffline(null)
    probeSearch(trimmed, clampTopK(topK)).then(
      (results) => {
        setBusy(false)
        setPayload(results)
      },
      (failure: unknown) => {
        setBusy(false)
        setPayload(null)
        if (isApiError(failure) && failure.code === ERROR_CODES.indexOffline) {
          setOffline(`${failure.message} (the index comes up on its own once Milvus and the embedder are ready)`)
        } else {
          setError(errorText(failure))
        }
      },
    )
  }

  return (
    <>
      <div style={ROW_STYLE}>
        {renderInput({
          value: query,
          placeholder: 'Search the memory index, e.g. milvus compaction',
          wide: true,
          disabled: busy,
          onChange: setQuery,
        })}
        {renderInput({
          value: topK,
          placeholder: 'topK',
          title: 'Results to return (1..10)',
          type: 'number',
          disabled: busy,
          onChange: setTopK,
        })}
        {renderButton({
          label: 'Search',
          variant: 'primary',
          busy,
          disabled: query.trim() === '',
          onClick: run,
        })}
      </div>
      {offline !== null && <RowHint text={offline} />}
      {error !== null && <div style={ERROR_BANNER_STYLE}>{error}</div>}
      {payload !== null && payload.results.length === 0 && (
        <RowHint text={`No memory matched "${payload.query}" (topK ${String(payload.topK)}).`} />
      )}
      {payload !== null && payload.results.map((result, index) => (
        <div key={`${String(result.chunk_id)}-${String(index)}`} style={ROW_STYLE}>
          {renderTag('quiet', `#${String(index + 1)} ${result.score.toFixed(3)}`)}
          <span style={{ flex: 1, minWidth: 240 }}>
            <span style={MONO_STYLE}>{result.source_path}</span>
            {result.section_header === null || result.section_header === ''
              ? null
              : renderTag('neutral', result.section_header)}
            <div style={HINT_STYLE}>{truncate(result.chunk_text, RESULT_TEXT_CHARS)}</div>
          </span>
        </div>
      ))}
    </>
  )
}
