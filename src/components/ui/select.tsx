import {
  Children,
  createContext,
  isValidElement,
  useContext,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { Select as Primitive } from "radix-ui";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "../../lib/utils";
const RequiredContext = createContext(false);
const encode = (value: string | number) => `option:${value}`;
interface SelectProps extends Omit<
  ComponentPropsWithoutRef<"button">,
  "value" | "onChange" | "children" | "defaultValue"
> {
  value: string | number;
  onValueChange: (value: string) => void;
  children: ReactNode;
  placeholder?: ReactNode;
  required?: boolean;
  name?: string;
}
export function Select({
  value,
  onValueChange,
  children,
  placeholder,
  required = false,
  name,
  disabled,
  className,
  ...props
}: SelectProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [invalid, setInvalid] = useState(false);
  const empty = Children.toArray(children).find(
    (child) =>
      isValidElement<{ value?: string | number }>(child) &&
      child.props.value === "",
  );
  const emptyLabel = isValidElement<{ children?: ReactNode }>(empty)
    ? empty.props.children
    : undefined;
  return (
    <RequiredContext.Provider value={required}>
      <span
        className="select-shell"
        onInvalidCapture={(event) => {
          event.preventDefault();
          setInvalid(true);
          trigger.current?.focus();
        }}
      >
        <Primitive.Root
          value={String(value) === "" ? "" : encode(value)}
          onValueChange={(next) => {
            setInvalid(false);
            onValueChange(next.slice("option:".length));
          }}
          disabled={disabled}
        >
          <Primitive.Trigger
            ref={trigger}
            className={cn("select-trigger", className)}
            aria-invalid={(invalid && String(value) === "") || undefined}
            aria-required={required || undefined}
            {...props}
          >
            <Primitive.Value
              placeholder={placeholder || emptyLabel || "Select…"}
            />
            <Primitive.Icon asChild>
              <ChevronDown size={13} />
            </Primitive.Icon>
          </Primitive.Trigger>
          <Primitive.Portal>
            <Primitive.Content
              className="select-content"
              position="popper"
              sideOffset={5}
              collisionPadding={12}
            >
              <Primitive.ScrollUpButton className="select-scroll">
                <ChevronUp size={14} />
              </Primitive.ScrollUpButton>
              <Primitive.Viewport className="select-viewport">
                {children}
              </Primitive.Viewport>
              <Primitive.ScrollDownButton className="select-scroll">
                <ChevronDown size={14} />
              </Primitive.ScrollDownButton>
            </Primitive.Content>
          </Primitive.Portal>
        </Primitive.Root>
        <input
          className="select-validation"
          aria-hidden="true"
          tabIndex={-1}
          name={name}
          value={String(value)}
          required={required}
          disabled={disabled}
          onChange={() => undefined}
        />
      </span>
    </RequiredContext.Provider>
  );
}
export function SelectItem({
  value,
  children,
  disabled,
  textValue,
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<typeof Primitive.Item>, "value"> & {
  value?: string | number;
}) {
  const required = useContext(RequiredContext);
  const raw =
    value ??
    (typeof children === "string" || typeof children === "number"
      ? children
      : undefined);
  if (raw === undefined)
    throw new Error(
      "SelectItem requires a value when its label contains markup.",
    );
  return (
    <Primitive.Item
      value={encode(raw)}
      disabled={disabled || (required && String(raw) === "")}
      textValue={textValue}
      className={cn("select-item", className)}
      {...props}
    >
      <span className="select-indicator">
        <Primitive.ItemIndicator>
          <Check size={13} />
        </Primitive.ItemIndicator>
      </span>
      <Primitive.ItemText>{children}</Primitive.ItemText>
    </Primitive.Item>
  );
}
