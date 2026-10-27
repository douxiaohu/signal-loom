import type { CSSProperties, ElementType, ReactNode } from "react";

import "./StarBorder.css";

type StarBorderProps = {
  as?: ElementType;
  className?: string;
  children?: ReactNode;
  color?: string;
  speed?: CSSProperties["animationDuration"];
  thickness?: number;
  backgroundColor?: string;
  textColor?: string;
  borderColor?: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
};

export default function StarBorder({
  as,
  className = "",
  color = "white",
  speed = "6s",
  thickness = 1,
  backgroundColor = "transparent",
  textColor = "inherit",
  borderColor = "transparent",
  children,
  ...rest
}: StarBorderProps) {
  const Component = as || "button";
  return (
    <Component className={`star-border-container ${className}`} style={{ padding: `${thickness}px 0` }} {...rest}>
      <span
        className="border-gradient-bottom"
        style={{ background: `radial-gradient(circle, ${color}, transparent 12%)`, animationDuration: speed }}
      />
      <span
        className="border-gradient-top"
        style={{ background: `radial-gradient(circle, ${color}, transparent 12%)`, animationDuration: speed }}
      />
      <span className="inner-content" style={{ background: backgroundColor, color: textColor, borderColor }}>
        {children}
      </span>
    </Component>
  );
}
