import { describe, expect, it } from "vitest"
import { getProviderHeaders } from "../headers"

describe("provider headers", () => {
  it("uses the configured user headers", () => {
    expect(getProviderHeaders({ "X-Test": "1" })).toEqual({
      "X-Test": "1",
    })
  })

  it("omits headers for an explicit empty object", () => {
    expect(getProviderHeaders({})).toBeUndefined()
  })

  it("filters empty and non-string header values", () => {
    expect(getProviderHeaders({
      "X-Empty": "",
      "X-Count": 1,
      "X-Test": "1",
    })).toEqual({
      "X-Test": "1",
    })
  })
})
