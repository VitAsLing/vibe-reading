import { i18n } from "@/utils/i18n"
import { PageLayout } from "../../components/page-layout"
import { AboutCard } from "./about-card"
import { ResetConfig } from "./reset-config"

export function ConfigPage() {
  return (
    <PageLayout title={i18n.t("options.config.title")} innerClassName="*:border-b [&>*:last-child]:border-b-0">
      <AboutCard />
      <ResetConfig />
    </PageLayout>
  )
}
