import { IconAlertCircle } from "@tabler/icons-react"
import { useSetAtom } from "jotai"
import { useState } from "react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/base-ui/alert-dialog"
import { Button } from "@/components/ui/base-ui/button"
import { writeConfigAtom } from "@/utils/atoms/config"
import { DEFAULT_CONFIG } from "@/utils/constants/config"
import { i18n } from "@/utils/i18n"
import { Alert, AlertDescription, AlertTitle } from "../ui/base-ui/alert"

interface RecoveryFallbackProps {
  error: Error | null
  onRecovered: () => void
}

export function RecoveryFallback({ error, onRecovered }: RecoveryFallbackProps) {
  const setConfig = useSetAtom(writeConfigAtom)
  const [isResetting, setIsResetting] = useState(false)

  const handleResetConfig = async () => {
    setIsResetting(true)
    try {
      await setConfig(DEFAULT_CONFIG)
      toast.success(i18n.t("errorRecovery.resetSuccess"))
      onRecovered()
    }
    catch {
      toast.error(i18n.t("errorRecovery.resetFailed"))
    }
    finally {
      setIsResetting(false)
    }
  }

  return (
    <div className="w-full min-h-full p-4 md:p-6">
      <div className="mx-auto max-w-xl rounded-xl border bg-card p-4 md:p-6 space-y-4">
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">{i18n.t("errorRecovery.title")}</h2>
          <p className="text-sm text-muted-foreground">{i18n.t("errorRecovery.description")}</p>
        </div>

        {error?.message && (
          <Alert variant="destructive">
            <IconAlertCircle />
            <AlertTitle>{i18n.t("errorRecovery.errorDetails")}</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{i18n.t("errorRecovery.recoveryTitle")}</p>
          <Button onClick={() => window.location.reload()}>
            {i18n.t("errorRecovery.refreshPage")}
          </Button>
          <AlertDialog>
            <AlertDialogTrigger render={<Button variant="destructive" disabled={isResetting} />}>
              {i18n.t("errorRecovery.resetAction")}
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{i18n.t("errorRecovery.resetDialog.title")}</AlertDialogTitle>
                <AlertDialogDescription>
                  {i18n.t("errorRecovery.resetDialog.description")}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{i18n.t("errorRecovery.resetDialog.cancel")}</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={handleResetConfig}
                  disabled={isResetting}
                >
                  {i18n.t("errorRecovery.resetDialog.confirm")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  )
}
