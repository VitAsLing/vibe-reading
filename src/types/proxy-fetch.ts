export interface ProxyResponse {
  status: number
  statusText: string
  headers: [string, string][]
  body: string
  bodyEncoding?: "text" | "base64"
}

export interface ProxyRequest {
  url: string
  method?: string
  headers?: [string, string][]
  body?: string
  credentials?: "omit" | "same-origin" | "include"
  redirect?: RequestRedirect
  responseType?: "text" | "base64"
}
