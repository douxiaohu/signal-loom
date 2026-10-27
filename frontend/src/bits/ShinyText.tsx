import type { CSSProperties } from "react";

import "./ShinyText.css";

type ShinyTextProps = {
  text: string;
  disabled?: boolean;
  speed?: number;
  className?: string;
};

export default function ShinyText({ text, disabled = false, speed = 4.8, className = "" }: ShinyTextProps) {
  const style = { animationDuration: `${speed}s` } as CSSProperties;
  return (
    <span className={`shiny-text${disabled ? " is-disabled" : ""}${className ? ` ${className}` : ""}`} style={style}>
      {text}
    </span>
  );
}
