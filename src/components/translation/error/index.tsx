import type { APICallError } from "ai"
import { ErrorButton } from "./error-button"
import { RetryButton } from "./retry-button"

export function TranslationError({ nodes, error, signal }: { nodes: ChildNode[], error: APICallError, signal?: AbortSignal }) {
  return (
    <div className="notranslate inline-flex items-center justify-center gap-1 px-1.5">
      <RetryButton nodes={nodes} signal={signal} />
      <ErrorButton error={error} />
    </div>
  )
}
