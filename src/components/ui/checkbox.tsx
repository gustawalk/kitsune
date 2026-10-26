import { useId, useRef, type ComponentPropsWithoutRef } from "react";
import { Checkbox as Primitive } from "radix-ui";
import { Check, Minus } from "lucide-react";
import { Tooltip } from "./tooltip";
export function Checkbox({
  checked,
  indeterminate = false,
  onCheckedChange,
  title,
  ...props
}: Omit<
  ComponentPropsWithoutRef<typeof Primitive.Root>,
  "checked" | "onCheckedChange" | "title"
> & {
  checked?: boolean;
  indeterminate?: boolean;
  onCheckedChange?: (checked: boolean) => void;
  title?: string;
}) {
  const id = useId();
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <span
      className="checkbox-shell"
      onInvalidCapture={(e) => {
        e.preventDefault();
        ref.current?.focus();
      }}
    >
      <Tooltip content={title} disabledTrigger={props.disabled}>
        <Primitive.Root
          {...props}
          ref={ref}
          id={props.id || id}
          checked={indeterminate ? "indeterminate" : !!checked}
          onCheckedChange={(v) => onCheckedChange?.(v === true)}
          className={`checkbox ${props.className || ""}`}
        >
          <Primitive.Indicator>
            {indeterminate ? (
              <Minus size={11} />
            ) : (
              <Check size={11} strokeWidth={2.5} />
            )}
          </Primitive.Indicator>
        </Primitive.Root>
      </Tooltip>
    </span>
  );
}
