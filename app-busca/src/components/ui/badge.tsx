import { cva, type VariantProps } from "class-variance-authority"
import type { ComponentProps } from "react"

import { cn } from "@/lib/utils.ts"

const badgeVariants = cva(
  "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors [&_svg]:size-4",
  {
    variants: {
      variant: {
        default: "border-brand/30 bg-brand/10 text-brand-bright",
        verify: "border-verify/30 bg-verify/10 text-verify",
        signal: "border-signal/30 bg-signal/10 text-signal",
        gold: "border-gold/30 bg-gold/10 text-gold",
        outline: "border-hairline text-ink-soft",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
)

function Badge({
  className,
  variant,
  ...props
}: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
