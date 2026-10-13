import { createFormHookContexts } from "@tanstack/react-form"

export const { fieldContext, formContext, useFieldContext, useFormContext }
  = createFormHookContexts()

export interface PersistenceReceipt {
  persistence?: Promise<void>
}

export function submitWithPersistence(form: { handleSubmit: (meta?: PersistenceReceipt) => void | Promise<void> }): Promise<boolean> {
  const receipt: PersistenceReceipt = {}
  return Promise.resolve(form.handleSubmit(receipt)).then(async () => {
    if (!receipt.persistence)
      return false
    await receipt.persistence
    return true
  })
}
