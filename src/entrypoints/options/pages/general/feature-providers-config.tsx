import type { ProviderConfig } from "@/types/config/provider"
import type { FeatureKey } from "@/utils/constants/feature-providers"
import { useAtomValue, useSetAtom } from "jotai"
import { useMemo } from "react"
import ProviderSelector from "@/components/llm-providers/provider-selector"
import { Field, FieldLabel } from "@/components/ui/base-ui/field"
import { isAPIProviderConfig } from "@/types/config/provider"
import { configAtom, configFieldsAtomMap, writeConfigAtom } from "@/utils/atoms/config"
import { featureProviderConfigAtom } from "@/utils/atoms/provider"
import { filterEnabledProvidersConfig } from "@/utils/config/helpers"
import { buildFeatureProviderPatch, FEATURE_PROVIDER_DEFS, getFeatureLabelI18nKey } from "@/utils/constants/feature-providers"
import { i18n } from "@/utils/i18n"
import { ConfigCard } from "../../components/config-card"
import { SetApiKeyWarning } from "../../components/set-api-key-warning"

function needsApiKeyWarning(providerConfig: ProviderConfig | null): boolean {
  return !!providerConfig
    && isAPIProviderConfig(providerConfig)
    && !providerConfig.apiKey
}

function FeatureProviderField({ featureKey }: {
  featureKey: FeatureKey
}) {
  const config = useAtomValue(configAtom)
  const setConfig = useSetAtom(writeConfigAtom)
  const providersConfig = useAtomValue(configFieldsAtomMap.providersConfig)
  const def = FEATURE_PROVIDER_DEFS[featureKey]
  const providerId = def.getProviderId(config)
  const providerConfig = useAtomValue(featureProviderConfigAtom(featureKey))

  const providers = useMemo(() =>
    filterEnabledProvidersConfig(providersConfig)
      .filter(p => def.isProvider(p.provider)),
  [providersConfig, def])

  return (
    <Field>
      <FieldLabel nativeLabel={false} render={<div className="flex flex-wrap" />}>
        {i18n.t(getFeatureLabelI18nKey(featureKey))}
        {needsApiKeyWarning(providerConfig) && <SetApiKeyWarning />}
      </FieldLabel>
      <ProviderSelector
        providers={providers}
        value={providerId}
        onChange={id => void setConfig(buildFeatureProviderPatch({ [featureKey]: id }))}
        className="w-full"
      />
    </Field>
  )
}

export default function FeatureProvidersConfig() {
  return (
    <ConfigCard
      id="feature-providers"
      title={i18n.t("options.general.featureProviders.title")}
      description={i18n.t("options.general.featureProviders.description")}
    >
      <div className="space-y-4">
        <FeatureProviderField
          featureKey="translate"
        />
      </div>
    </ConfigCard>
  )
}
