import type { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse as Response } from 'node:http'

type NextFunction = (err?: any) => void

// Extend the request object with body
export type ReqWithBody<T = any> = IncomingMessage & {
  body?: T
} & EventEmitter

export const hasBody = (method: string) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)

const defaultPayloadLimit = 104857600 // 100KB

export type LimitErrorFn = (limit: number) => Error

export type ParserOptions = Partial<{
  payloadLimit: number
  payloadLimitErrorFn: LimitErrorFn
}>

const defaultErrorFn: LimitErrorFn = (payloadLimit) => new Error(`Payload too large. Limit: ${payloadLimit} bytes`)

// Main function
export const p =
  <T = any>(fn: (body: any) => any, payloadLimit = defaultPayloadLimit, payloadLimitErrorFn: LimitErrorFn = defaultErrorFn) =>
    async (req: ReqWithBody<T>, _res: Response, next: (err?: any) => void) => {
      try {
        let body = ''

        for await (const chunk of req) {
          if (body.length > payloadLimit) throw payloadLimitErrorFn(payloadLimit)
          body += chunk
        }

        return fn(body)
      } catch (e) {
        next(e)
      }
    }

const custom =
  <T = any>(fn: (body: any) => any) =>
    async (req: ReqWithBody, _res: Response, next: NextFunction) => {
      if (hasBody(req.method!)) req.body = await p<T>(fn)(req, _res, next)
      next()
    }

const json =
  ({ payloadLimit, payloadLimitErrorFn }: ParserOptions = {}) =>
    async (req: ReqWithBody, res: Response, next: NextFunction) => {
      if (hasBody(req.method!)) {
        req.body = await p((x) => (x ? JSON.parse(x.toString()) : {}), payloadLimit, payloadLimitErrorFn)(req, res, next)
      } else next()
    }

const raw =
  ({ payloadLimit, payloadLimitErrorFn }: ParserOptions = {}) =>
    async (req: ReqWithBody, _res: Response, next: NextFunction) => {
      if (hasBody(req.method!)) {
        req.body = await p((x) => x, payloadLimit, payloadLimitErrorFn)(req, _res, next)
      } else next()
    }

const text =
  ({ payloadLimit, payloadLimitErrorFn }: ParserOptions = {}) =>
    async (req: ReqWithBody, _res: Response, next: NextFunction) => {
      if (hasBody(req.method!)) {
        req.body = await p((x) => x.toString(), payloadLimit, payloadLimitErrorFn)(req, _res, next)
      } else next()
    }

const urlencoded =
  ({ payloadLimit, payloadLimitErrorFn }: ParserOptions = {}) =>
    async (req: ReqWithBody, _res: Response, next: NextFunction) => {
      if (hasBody(req.method!)) {
        req.body = await p(
          (x) => {
            const urlSearchParam = new URLSearchParams(x.toString())
            return Object.fromEntries(urlSearchParam.entries())
          },
          payloadLimit,
          payloadLimitErrorFn
        )(req, _res, next)
      } else next()
    }

const getBoundary = (contentType: string) => {
  // Extract the boundary from the Content-Type header
  const match = /boundary=(.+);?/.exec(contentType)
  return match ? `--${match[1]}` : null
}

const defaultFileSizeLimitErrorFn: LimitErrorFn = (limit) => new Error(`File too large. Limit: ${limit} bytes`)

const parseMultipart = (body: string, boundary: string, { fileCountLimit, fileSizeLimit, fileSizeLimitErrorFn = defaultFileSizeLimitErrorFn }: MultipartOptions) => {
  // Split the body into an array of parts
  const parts = body.split(new RegExp(`${boundary}(--)?`)).filter((part) => !!part && /content-disposition/i.test(part))
  const parsedBody: Record<string, (File | string)[]> = {}

  if (fileCountLimit && parts.length > fileCountLimit) throw new Error(`Too many files. Limit: ${fileCountLimit}`)

  // Parse each part into a form data object
  // biome-ignore lint/complexity/noForEach: <explanation>
  parts.forEach((part) => {
    const [headers, ...lines] = part.split('\r\n').filter((part) => !!part)
    const data = lines.join('\r\n').trim()

    if (fileSizeLimit && data.length > fileSizeLimit) throw fileSizeLimitErrorFn(fileSizeLimit)

    // Extract the name and filename from the headers
    const name = /name="(.+?)"/.exec(headers)![1]
    const filename = /filename="(.+?)"/.exec(headers)
    if (filename) {
      const contentTypeMatch = /Content-Type: (.+)/i.exec(data)!
      const fileContent = data.slice(contentTypeMatch[0].length + 2)

      const file = new File([fileContent], filename[1], { type: contentTypeMatch[1] })

      parsedBody[name] = parsedBody[name] ? [...parsedBody[name], file] : [file]
      return
    }
    // This is a regular field
    parsedBody[name] = parsedBody[name] ? [...parsedBody[name], data] : [data]
    return
  })

  return parsedBody
}
type MultipartOptions = Partial<{
  fileCountLimit: number
  fileSizeLimit: number
  fileSizeLimitErrorFn: LimitErrorFn
}>

const multipart =
  ({ payloadLimit, payloadLimitErrorFn, ...opts }: MultipartOptions & ParserOptions = {}) =>
    async (req: ReqWithBody, res: Response, next: NextFunction) => {
      if (hasBody(req.method!)) {
        req.body = await p((x) => {
          const boundary = getBoundary(req.headers['content-type']!)
          if (boundary) return parseMultipart(x, boundary, opts)
          return {}
        }, payloadLimit, payloadLimitErrorFn)(req, res, next)
        next()
      } else next()
    }

export { custom, json, raw, text, urlencoded, multipart }
