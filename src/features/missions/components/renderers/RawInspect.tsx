/** Collapsible raw-JSON inspector shared by every event renderer. */
export function RawInspect({ event }: { event: unknown }) {
  return (
    <details className="raw-inspect">
      <summary className="raw-inspect-toggle">raw JSON</summary>
      <pre className="event-detail-raw">{JSON.stringify(event, null, 2)}</pre>
    </details>
  )
}
