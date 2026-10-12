// Chrome storage is always forwarded; acceptance controls reply timing/failure.
export function installStorageBoundary() {
  if (globalThis.__E2E_NATIVE_STORAGE__)
    return
  const state = globalThis.__E2E_NATIVE_STORAGE__ = { plans: [], held: [], calls: [] }
  state.release = (label) => {
    const entries = state.held.filter(entry => entry.label === label)
    if (!entries.length)
      throw new Error(`No held Chrome storage reply: ${label}`)
    for (const entry of entries) {
      state.held.splice(state.held.indexOf(entry), 1)
      entry.release()
    }
  }
  for (const area of ["local", "session"]) {
    for (const method of ["get", "set", "remove"]) {
      const real = globalThis.chrome.storage[area][method].bind(globalThis.chrome.storage[area])
      globalThis.chrome.storage[area][method] = (...args) => {
        if (typeof args.at(-1) === "function")
          throw new Error("Acceptance storage boundary expects this project's Promise API calls")
        const value = args[0]
        const keys = typeof value === "string" ? [value] : Array.isArray(value) ? value : Object.keys(value ?? {})
        const index = state.plans.findIndex(plan => plan.area === area && plan.method === method && (!plan.key || keys.includes(plan.key)) && (plan.enabled === undefined || Object.values(value ?? {}).some(item => item?.enabled === plan.enabled)))
        const plan = index < 0 ? null : state.plans.splice(index, 1)[0]
        const call = { area, method, keys, label: plan?.label, forwarded: true, settled: false }
        state.calls.push(call)
        return real(...args).then((result) => {
          if (plan?.action === "reject") {
            call.settled = true
            throw new Error("E2E storage boundary unavailable")
          }
          if (plan?.action === "hold") {
            return new Promise(resolve => state.held.push({ label: plan.label, release: () => {
              call.settled = true
              resolve(result)
            } }))
          }
          call.settled = true
          return result
        })
      }
    }
  }
}
