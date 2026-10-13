import type { TranslationNodeStyleConfig } from "@/types/config/translate"
import { camelCase } from "case-anything"
import { translationNodeStylePresetSchema } from "@/types/config/translate"
import { CUSTOM_TRANSLATION_NODE_ATTRIBUTE } from "@/utils/constants/translation-node-style"
import { getContainingShadowRoot } from "../../dom/node"
import { ensureCustomCSS, ensurePresetStyles } from "./style-injector"

const customTranslationNodeAttribute = camelCase(CUSTOM_TRANSLATION_NODE_ATTRIBUTE)
let contentTranslationNodeStyle: TranslationNodeStyleConfig | null = null

export function setContentTranslationNodeStyle(style: TranslationNodeStyleConfig | null): void {
  contentTranslationNodeStyle = style
}

export async function decorateTranslationNode(
  translatedNode: HTMLElement,
  requestedStyle: TranslationNodeStyleConfig,
): Promise<void> {
  // Content scripts share a stylesheet: a late paragraph uses the current
  // saved style. The settings preview uses its own supplied style in its realm.
  const styleConfig = contentTranslationNodeStyle ?? requestedStyle
  if (translationNodeStylePresetSchema.safeParse(styleConfig.preset).error)
    return

  const root = getContainingShadowRoot(translatedNode) ?? document

  if (styleConfig.isCustom && styleConfig.customCSS) {
    translatedNode.dataset[customTranslationNodeAttribute] = "custom"
    await ensureCustomCSS(root, styleConfig.customCSS)
    return
  }

  translatedNode.dataset[customTranslationNodeAttribute] = styleConfig.preset
  ensurePresetStyles(root)
}
