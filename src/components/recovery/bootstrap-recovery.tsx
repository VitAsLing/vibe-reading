import { Provider as JotaiProvider } from "jotai"
import AppToast from "@/components/app-toast"
import { TooltipProvider } from "@/components/ui/base-ui/tooltip"
import { renderPersistentReactRoot } from "@/utils/react-root"
import { RecoveryFallback } from "./recovery-fallback"

export function renderBootstrapRecovery(root: HTMLElement, error: unknown): void {
  const failure = error instanceof Error ? error : new Error(String(error))
  renderPersistentReactRoot(root, (
    <JotaiProvider>
      <TooltipProvider>
        <AppToast />
        <RecoveryFallback error={failure} onRecovered={() => window.location.reload()} />
      </TooltipProvider>
    </JotaiProvider>
  ))
}
