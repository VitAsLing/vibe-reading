import type { Config } from "@/types/config/config"
import { isLLMProviderConfig } from "@/types/config/provider"
import { resolveProviderConfig } from "@/utils/constants/feature-providers"
import { assertContentScriptActive } from "@/utils/content-script/lifecycle"
import { getLocalConfig } from "../../config/storage"
import { prepareTranslationText } from "./text-preparation"
import { translateTextCore } from "./translate-text"
import { getOrCreateWebPageContext } from "./webpage-context"
import { getOrGenerateWebPageSummary } from "./webpage-summary"

function checkTranslation(checkpoint?: () => void): void {
  assertContentScriptActive()
  checkpoint?.()
}

async function getConfigOrThrow(checkpoint?: () => void): Promise<Config> {
  checkTranslation(checkpoint)
  const config = await getLocalConfig()
  checkTranslation(checkpoint)
  if (!config) {
    throw new Error("No global config when translate text")
  }
  return config
}

async function getWebPagePromptContext(
  providerConfig: ReturnType<typeof resolveProviderConfig>,
  enableAIContentAware: boolean,
  includeSummary: boolean,
  checkpoint?: () => void,
): Promise<{ webTitle: string, webDescription?: string, webContent: string, webSummary?: string } | undefined> {
  if (!isLLMProviderConfig(providerConfig)) {
    return undefined
  }

  checkTranslation(checkpoint)
  const webPageContext = await getOrCreateWebPageContext(checkpoint)
  checkTranslation(checkpoint)
  if (!webPageContext) {
    return undefined
  }

  const webSummary = includeSummary
    ? await getOrGenerateWebPageSummary(webPageContext, providerConfig, enableAIContentAware)
    : undefined
  checkTranslation(checkpoint)

  return {
    webTitle: webPageContext.webTitle,
    webDescription: webPageContext.webDescription,
    webContent: webPageContext.webContent,
    webSummary: webSummary ?? undefined,
  }
}

async function translateTextUsingPageConfig(
  config: Config,
  text: string,
  options: {
    extraHashTags?: string[]
    webPageContext?: { webTitle?: string | null, webDescription?: string | null, webContent?: string | null, webSummary?: string | null }
    checkpoint?: () => void
  } = {},
): Promise<string> {
  checkTranslation(options.checkpoint)
  const preparedText = prepareTranslationText(text)
  if (preparedText === "") {
    return ""
  }

  const providerConfig = resolveProviderConfig(config, "translate")

  return translateTextCore({
    text: preparedText,
    langConfig: config.language,
    providerConfig,
    customPromptsConfig: config.translate.customPromptsConfig,
    enableAIContentAware: config.translate.enableAIContentAware,
    extraHashTags: options.extraHashTags,
    webPageContext: options.webPageContext,
    checkpoint: options.checkpoint,
  })
}

/**
 * Page translation — uses FEATURE_PROVIDER_DEFS['translate'].
 * Includes skip-language logic (page translation only).
 */
export async function translateTextForPage(text: string, checkpoint?: () => void): Promise<string> {
  const config = await getConfigOrThrow(checkpoint)
  const providerConfig = resolveProviderConfig(config, "translate")
  const webPageContext = await getWebPagePromptContext(providerConfig, config.translate.enableAIContentAware, true, checkpoint)

  return translateTextUsingPageConfig(config, text, {
    webPageContext,
    checkpoint,
  })
}

/**
 * Page title translation — uses page translation settings, but always treats the
 * current source title as the webpage title context.
 */
export async function translateTextForPageTitle(text: string, checkpoint?: () => void): Promise<string> {
  const config = await getConfigOrThrow(checkpoint)
  const providerConfig = resolveProviderConfig(config, "translate")
  const webPageContext = config.translate.enableAIContentAware
    ? await getWebPagePromptContext(providerConfig, true, false, checkpoint)
    : undefined

  return translateTextUsingPageConfig(config, text, {
    extraHashTags: ["pageTitleTranslation"],
    checkpoint,
    webPageContext: {
      webTitle: text,
      webDescription: webPageContext?.webDescription,
      webContent: webPageContext?.webContent,
      webSummary: webPageContext?.webSummary,
    },
  })
}
