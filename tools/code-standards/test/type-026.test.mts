import { inlineObjectTypeRule } from "../rules/type-026.mts"
import { expectedCountReport, ruleTester } from "./rule-tester.mts"

ruleTester.run("type-026", inlineObjectTypeRule, {
  valid: [
    {
      name: "allows the chapter's two-field local shape",
      code: `function formatPoint(point: { x: number; y: number }): string {
        return \`\${point.x},\${point.y}\`
      }`
    },
    {
      name: "does not count method signatures as fields",
      code: "function draw(shape: { x: number; y: number; render(): void }) {}"
    },
    {
      name: "leaves object types inside a named type to other rules",
      code: "type Shape = { origin: { x: number; y: number; z: number } }"
    },
    {
      name: "skips an external augmentation",
      code: "declare global { var store: { a: A; b: B; c: C } }"
    }
  ],
  invalid: [
    {
      name: "reports three fields, one over the limit",
      code: "function draw(point: { x: number; y: number; z: number }) {}",
      errors: [expectedCountReport("tooManyFields", 3)]
    },
    {
      name: "reports inline object types in type arguments and variables",
      code: `const [state] = useState<{ a: A; b: B; c: C }>()
        let current: { a: A; b: B; c: C; d: D }`,
      errors: [
        expectedCountReport("tooManyFields", 3),
        expectedCountReport("tooManyFields", 4)
      ]
    }
  ]
})
