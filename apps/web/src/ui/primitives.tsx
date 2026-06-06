// Paste primitives used across the playground: Button + Badge.
// Class contracts come from the Console UI kit (console.css).
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

type ButtonVariant = "primary" | "secondary" | "destructive" | "link";

interface ButtonProps {
  variant?: ButtonVariant;
  size?: "sm";
  icon?: IconName;
  children?: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit" | "reset";
}

export function Button({
  variant = "primary",
  size,
  icon,
  children,
  onClick,
  disabled,
  type = "button",
}: ButtonProps) {
  const cls = ["btn", `btn-${variant}`, size === "sm" ? "btn-sm" : ""].join(" ").trim();
  return (
    <button className={cls} onClick={onClick} disabled={disabled} type={type}>
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

type BadgeVariant = "success" | "warning" | "error" | "neutral" | "new";

const DOT_COLOR: Record<BadgeVariant, string> = {
  success: "#14b053",
  warning: "#f47c22",
  error: "#db132a",
  neutral: "#0263e0",
  new: "#6d2ed1",
};

interface BadgeProps {
  variant?: BadgeVariant;
  dot?: boolean;
  children?: ReactNode;
}

export function Badge({ variant = "neutral", dot, children }: BadgeProps) {
  return (
    <span className={`badge badge-${variant}`}>
      {dot ? <span className="dot" style={{ background: DOT_COLOR[variant] }} /> : null}
      {children}
    </span>
  );
}

export type { BadgeVariant };
