import { useRef, type ComponentPropsWithoutRef, type ElementType, type MouseEvent } from "react";

import "./SpotlightCard.css";

type SpotlightCardProps<T extends ElementType> = {
  as?: T;
  className?: string;
  spotlightColor?: string;
  onMouseMove?: (event: MouseEvent<HTMLElement>) => void;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "className" | "onMouseMove">;

export default function SpotlightCard<T extends ElementType = "div">({
  as,
  className = "",
  spotlightColor,
  onMouseMove,
  ...rest
}: SpotlightCardProps<T>) {
  const Comp = (as ?? "div") as ElementType;
  const ref = useRef<HTMLElement>(null);

  function handleMouseMove(event: MouseEvent<HTMLElement>) {
    const node = ref.current;
    if (node) {
      const rect = node.getBoundingClientRect();
      node.style.setProperty("--mouse-x", `${event.clientX - rect.left}px`);
      node.style.setProperty("--mouse-y", `${event.clientY - rect.top}px`);
      if (spotlightColor) node.style.setProperty("--spotlight-color", spotlightColor);
    }
    onMouseMove?.(event);
  }

  return (
    <Comp
      ref={ref}
      className={className ? `card-spotlight ${className}` : "card-spotlight"}
      onMouseMove={handleMouseMove}
      {...rest}
    />
  );
}
