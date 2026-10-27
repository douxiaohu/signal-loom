import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-medium tracking-tight",
  {
    variants: {
      variant: {
        outline: "border-border bg-card text-muted-foreground",
        secondary: "border-transparent bg-secondary text-secondary-foreground"
      }
    },
    defaultVariants: { variant: "outline" }
  }
);

function Badge({ className, variant, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant, className }))} {...props} />;
}

export { Badge, badgeVariants };
