import * as z from "zod"

const httpErrorResponseBodyCreationOptionsSchema = z.strictObject({
  type: z.string().readonly(),
  title: z.string().readonly(),
  detail: z.string().readonly(),
  status: z.coerce.number().min(400).max(599).readonly(),
  instance: z.string().optional().readonly()
})

type HttpErrorResponseBodyCreationOptions = z.infer<
  typeof httpErrorResponseBodyCreationOptionsSchema
>

export class HttpErrorResponseBody {
  readonly #type: string
  readonly #title: string
  readonly #detail: string
  readonly #status: number
  readonly #instance: string | undefined

  constructor(options: HttpErrorResponseBodyCreationOptions) {
    const verifiedOptions =
      httpErrorResponseBodyCreationOptionsSchema.parse(options)

    this.#type = verifiedOptions.type
    this.#title = verifiedOptions.title
    this.#detail = verifiedOptions.detail
    this.#status = verifiedOptions.status
    this.#instance = verifiedOptions.instance
  }

  public toJson(): HttpErrorResponseBodyCreationOptions {
    return {
      type: this.#type,
      title: this.#title,
      detail: this.#detail,
      status: this.#status,
      instance: this.#instance
    }
  }
}
